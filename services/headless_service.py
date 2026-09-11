from __future__ import annotations

import json
import hashlib
import os
import re
import threading
import uuid
import copy
import secrets
import time
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests

from config import HEADLESS_DB_FILE
from services.ckan_service import search_ckan_portal
from services.esri_service import search_esri_portal
from services.overpass_service import (
    search_overpass,
    search_overpass_containing_boundaries,
    search_overpass_element,
    search_overpass_near_named_way,
)
from services.headless_models import action_requires_confirmation, action_risk, IntentClassification, SUPPORTED_ACTIONS
from services.headless_models import calculate_plan_hash
from services.headless_repository import HeadlessRepository
from services.discovery_service import discover_sources
from services.catalog_client import CatalogClient
from services.osm_normalizer import normalize_overpass
from services.osm_models import OsmQuerySpec, SpatialConstraint
from services.spatial_service import operate as spatial_operate
from services.osm_intelligence import correct_text, infer_feature, normalize_text as normalize_osm_text
from services.region_service import bbox_intersects, normalize_region_text, resolve_region_context, resolve_region_from_text


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", (value or "").strip().lower())


def _layer_name(prefix: str, suffix: str) -> str:
    suffix = (suffix or "").strip()
    return f"{prefix}: {suffix}" if suffix else prefix


def _payload_tags(tags: list[dict[str, Any]]) -> list[dict[str, str]]:
    """Accept both the legacy {osm_key: value} and UI {key, val} forms."""
    output: list[dict[str, str]] = []
    for tag in tags or []:
        if not isinstance(tag, dict):
            continue
        if tag.get("key"):
            output.append({"key": str(tag["key"]), "val": str(tag.get("val") or "")})
        else:
            output.extend({"key": str(key), "val": str(value or "")} for key, value in tag.items())
    return output


def _bbox_from_features(features: list[dict[str, Any]]) -> list[float] | None:
    lons: list[float] = []
    lats: list[float] = []
    for feat in features:
        geom = feat.get("geometry") or {}
        coords = geom.get("coordinates")
        if not coords:
            continue
        geom_type = geom.get("type")
        points: list[list[float]] = []
        if geom_type == "Point":
            points = [coords]
        elif geom_type == "MultiPoint":
            points = coords
        elif geom_type == "LineString":
            points = coords
        elif geom_type == "MultiLineString":
            points = [pt for line in coords for pt in line]
        elif geom_type == "Polygon":
            points = [pt for ring in coords for pt in ring]
        elif geom_type == "MultiPolygon":
            points = [pt for poly in coords for ring in poly for pt in ring]
        for pt in points:
            if isinstance(pt, (list, tuple)) and len(pt) >= 2:
                lons.append(float(pt[0]))
                lats.append(float(pt[1]))
    if not lons or not lats:
        return None
    return [min(lats), min(lons), max(lats), max(lons)]


def _geojson_bbox(geojson: dict[str, Any]) -> list[float] | None:
    return _bbox_from_features(geojson.get("features", []))


def _filter_features(features: list[dict[str, Any]], criteria: dict[str, Any]) -> list[dict[str, Any]]:
    mode = criteria.get("mode", "data")
    if mode == "data":
        column = criteria.get("column")
        selected = {str(v) for v in criteria.get("values", [])}
        if not column or not selected:
            return []
        return [f for f in features if str((f.get("properties") or {}).get(column)) in selected]

    if mode == "bbox":
        bbox = criteria.get("bbox")
        if not bbox or len(bbox) != 4:
            return []
        south, west, north, east = bbox
        return [f for f in features if _feature_intersects_bbox(f, south, west, north, east)]

    if mode == "radius":
        center = criteria.get("center") or {}
        try:
            radius_km = float(criteria.get("radius_km") or 0)
            lat = float(center.get("lat"))
            lng = float(center.get("lng"))
        except (TypeError, ValueError):
            raise ValueError("radius filtering requires numeric center.lat, center.lng, and radius_km")
        if radius_km <= 0:
            raise ValueError("radius_km must be greater than zero")
        return [
            f for f in features
            if _feature_within_radius(f, lat, lng, radius_km)
        ]

    return []


def _feature_intersects_bbox(feature: dict[str, Any], south: float, west: float, north: float, east: float) -> bool:
    geom = feature.get("geometry") or {}
    coords = geom.get("coordinates")
    if not coords:
        return False
    bbox = _geojson_bbox({"features": [feature]})
    if not bbox:
        return False
    f_s, f_w, f_n, f_e = bbox
    return not (f_e < west or f_w > east or f_n < south or f_s > north)


def _feature_within_radius(feature: dict[str, Any], lat: float, lng: float, radius_km: float) -> bool:
    bbox = _geojson_bbox({"features": [feature]})
    if not bbox:
        return False
    f_s, f_w, f_n, f_e = bbox
    center_lat = (f_s + f_n) / 2
    center_lng = (f_w + f_e) / 2
    # Cheap distance approximation is enough for headless filtering orchestration.
    km_per_deg = 111.0
    dlat = (center_lat - lat) * km_per_deg
    dlng = (center_lng - lng) * km_per_deg
    return (dlat * dlat + dlng * dlng) ** 0.5 <= radius_km


@dataclass
class HeadlessAction:
    type: str
    status: str = "pending"
    input: dict[str, Any] = field(default_factory=dict)
    output: dict[str, Any] = field(default_factory=dict)
    error: str | None = None
    risk: str = "unknown"
    requires_confirmation: bool = False
    explanation: str = ""
    created_at: str = field(default_factory=_utc_now)
    updated_at: str = field(default_factory=_utc_now)

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["risk"] = self.risk if self.risk != "unknown" else action_risk(self.type)
        value["requires_confirmation"] = self.requires_confirmation or action_requires_confirmation(self.type)
        value["explanation"] = self.explanation or f"Execute {self.type.replace('_', ' ')}"
        return value


@dataclass
class HeadlessSession:
    id: str
    prompt: str
    workspace: dict[str, Any] = field(default_factory=dict)
    status: str = "queued"
    created_at: str = field(default_factory=_utc_now)
    updated_at: str = field(default_factory=_utc_now)
    actions: list[HeadlessAction] = field(default_factory=list)
    result: dict[str, Any] = field(default_factory=dict)
    error: str | None = None
    plan_hash: str = ""
    approval_token: str = ""
    assistant_state: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "prompt": self.prompt,
            "workspace": self.workspace,
            "status": self.status,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "actions": [action.to_dict() for action in self.actions],
            "result": self.result,
            "error": self.error,
            "planHash": self.plan_hash,
            "approvalToken": self.approval_token,
            "assistantState": self.assistant_state,
        }


class HeadlessSessionStore:
    def __init__(self):
        self._sessions: dict[str, HeadlessSession] = {}
        self._lock = threading.Lock()
        self._openai_api_key = None
        self._openai_model = None
        self._planner_base_url = None
        self._recent_prompts: list[str] = []
        self._repository = HeadlessRepository(HEADLESS_DB_FILE)
        self._catalog_client = CatalogClient()
        self._geocode_cache: dict[tuple[str, bool], list[dict[str, Any]]] = {}
        self._nominatim_lock = threading.Lock()
        self._last_nominatim_request = 0.0
        self._plan_tokens: dict[str, tuple[str, str]] = {}
        self._llm_plan_cache: dict[str, tuple[float, list[HeadlessAction]]] = {}
        self._llm_cache_lock = threading.Lock()
        self._llm_request_lock = threading.Lock()
        self._llm_timeout = 12.0
        self._llm_cache_ttl = 300.0
        self._llm_cooldown = 60.0
        self._llm_failure_until = 0.0
        self._llm_failure_count = 0
        self._last_planner_info: dict[str, Any] = {
            "mode": "local",
            "hosted_attempted": False,
            "model": None,
            "reason": "local planner is the default",
        }
        for row in self._repository.load_all():
            session = HeadlessSession(id=row["id"], prompt=row["prompt"], workspace=json.loads(row["workspace"]),
                                      status=row["status"], created_at=row["created_at"], updated_at=row["updated_at"],
                                      result=json.loads(row["result"]), error=row["error"],
                                      plan_hash=row["plan_hash"] or "", approval_token=row["approval_token"] or "",
                                      assistant_state=json.loads(row["assistant_state"] or "{}") if "assistant_state" in row.keys() and row["assistant_state"] else {})
            session.actions = [HeadlessAction(type=a["type"], input=a.get("input") or {}, status=a.get("status", "pending"),
                                               output=a.get("output") or {}, error=a.get("error"), risk=a.get("risk", "unknown"),
                                               requires_confirmation=a.get("requires_confirmation", False), explanation=a.get("explanation", ""))
                               for a in json.loads(row["actions"])]
            self._sessions[session.id] = session
            self._plan_tokens[session.id] = (row["plan_hash"] or "", row["approval_token"] or "")

    def create(
        self,
        prompt: str,
        *,
        auto_run: bool = False,
        workspace: dict[str, Any] | None = None,
        mode: str = "auto",
        conversation: list[dict[str, Any]] | None = None,
    ) -> HeadlessSession:
        session = HeadlessSession(id=str(uuid.uuid4()), prompt=prompt, workspace=workspace or {})
        self._remember_prompt(prompt)
        session.actions = [HeadlessAction(type=item["type"], input=item.get("input") or {})
                           for item in self.plan_prompt(prompt, workspace=workspace, mode=mode, conversation=conversation)]
        with self._lock:
            self._sessions[session.id] = session
        plan_hash = calculate_plan_hash([a.to_dict() for a in session.actions])
        approval_token = secrets.token_urlsafe(24)
        self._plan_tokens[session.id] = (plan_hash, approval_token)
        session.plan_hash = plan_hash
        session.approval_token = approval_token
        self._repository.save(session, plan_hash=plan_hash, approval_token=approval_token)
        intent = self.classify_intent(prompt, allow_remote=False)
        selected_tags = [tag for action in session.actions if action.type == "osm_search" for tag in action.input.get("tags") or []]
        providers = sorted({"osm" if action.type == "osm_search" else "catalog" if action.type == "search_layers" else action.type for action in session.actions})
        self._repository.audit(session.id, "planned", {
            "prompt": prompt,
            "planHash": plan_hash,
            "intent": asdict(intent),
            "selectedTags": selected_tags,
            "providers": providers,
            "planner": dict(self._last_planner_info),
        }, session.created_at)
        if auto_run:
            if any(action_requires_confirmation(action.type) for action in session.actions):
                session.status = "awaiting_confirmation"
                self._repository.save(session, plan_hash=plan_hash, approval_token=approval_token)
            else:
                self.run_async(session.id)
        return session

    def get(self, session_id: str) -> HeadlessSession | None:
        with self._lock:
            return self._sessions.get(session_id)

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            return [session.to_dict() for session in self._sessions.values()]

    def run_async(self, session_id: str) -> None:
        thread = threading.Thread(target=self.run, args=(session_id,), daemon=True)
        thread.start()

    def run(self, session_id: str, *, confirmed: bool = False, plan_hash: str | None = None, approval_token: str | None = None) -> HeadlessSession:
        expected_hash, expected_token = self._plan_tokens.get(session_id, ("", ""))
        if plan_hash and plan_hash != expected_hash:
            raise ValueError("plan hash does not match the stored plan")
        if any(action_requires_confirmation(a.type) for a in self._sessions[session_id].actions):
            if not confirmed or approval_token != expected_token:
                raise PermissionError("session contains actions requiring explicit confirmation")
        with self._lock:
            session = self._sessions[session_id]
            session.status = "running"
            session.updated_at = _utc_now()
        self._repository.save(session, plan_hash=self._plan_tokens.get(session_id, ("", ""))[0], approval_token=self._plan_tokens.get(session_id, ("", ""))[1])
        self._repository.audit(session_id, "run_requested", {"confirmed": confirmed}, _utc_now())

        try:
            workspace = session.workspace
            result: dict[str, Any] = {"actions": []}
            for action in session.actions:
                try:
                    self._run_action(action)
                except Exception as exc:
                    action.status = "failed"
                    action.error = str(exc)
                    action.updated_at = _utc_now()
                    result["actions"].append(action.to_dict())
                    self._repository.audit(session.id, "action_failed", self._action_audit_payload(action), _utc_now())
                    raise
                self._repository.audit(session.id, "action_completed", self._action_audit_payload(action), _utc_now())
                result["actions"].append(action.to_dict())
            session.result = result
            session.status = "completed"
        except Exception as exc:
            session.status = "failed"
            session.error = str(exc)
        finally:
            session.updated_at = _utc_now()
            self._repository.save(session, plan_hash=self._plan_tokens.get(session_id, ("", ""))[0], approval_token=self._plan_tokens.get(session_id, ("", ""))[1])
        return session

    def execute_action(self, action_type: str, payload: dict[str, Any], *, confirmed: bool = False, plan_hash: str | None = None) -> dict[str, Any]:
        if action_type == "osm_search":
            self._validate_osm_payload(payload or {})
        action = HeadlessAction(type=action_type, input=payload or {})
        if action_requires_confirmation(action_type) and not confirmed:
            raise PermissionError(f"Action {action_type} requires explicit confirmation")
        self._repository.audit_request("action_requested", {
            "type": action_type,
            "provider": "osm" if action_type == "osm_search" else "catalog" if action_type == "search_layers" else action_type,
            "planHash": plan_hash,
            "selectedTags": _payload_tags((payload or {}).get("tags")),
            "payload": self._action_audit_payload(action).get("input", {}),
        }, _utc_now())
        try:
            self._run_action(action)
        except Exception:
            self._repository.audit_request("action_failed", self._action_audit_payload(action), _utc_now())
            raise
        self._repository.audit_request("action_completed", self._action_audit_payload(action), _utc_now())
        return action.to_dict()

    def audit(self, session_id: str):
        return self._repository.list_audit(session_id)

    @staticmethod
    def _action_audit_payload(action: HeadlessAction) -> dict[str, Any]:
        output = action.output or {}
        metadata = output.get("metadata") or (output.get("feature_collection") or {}).get("metadata") or {}
        return {
            "type": action.type,
            "status": action.status,
            "input": {key: value for key, value in action.input.items() if key not in {"workspace", "source", "geojson", "target", "join_layer"}},
            "featureCount": output.get("feature_count"),
            "rawElementCount": output.get("raw_element_count"),
            "metadata": metadata,
            "error": action.error,
        }

    def plan_and_execute(self, prompt: str, workspace: dict[str, Any] | None = None, *, confirmed: bool = False) -> dict[str, Any]:
        session = self.create(prompt, auto_run=False, workspace=workspace)
        if any(action_requires_confirmation(action.type) for action in session.actions) and not confirmed:
            raise PermissionError("This plan requires explicit confirmation before it can fetch or modify data")
        session = self.run(session.id, confirmed=confirmed, plan_hash=self._plan_tokens[session.id][0], approval_token=self._plan_tokens[session.id][1])
        return session.to_dict()

    def _refresh_llm_settings(self) -> None:
        self._openai_api_key = os.environ.get("OPENAI_API_KEY", "").strip() or None
        self._openai_model = os.environ.get("OPENAI_HEADLESS_MODEL", "gpt-4.1-mini").strip()
        self._planner_base_url = os.environ.get("OPENAI_API_BASE", "https://api.openai.com/v1").strip().rstrip("/")
        try:
            self._llm_timeout = max(3.0, min(float(os.environ.get("OPENAI_HEADLESS_TIMEOUT", "12")), 30.0))
        except (TypeError, ValueError):
            self._llm_timeout = 12.0
        try:
            self._llm_cache_ttl = max(0.0, min(float(os.environ.get("OPENAI_HEADLESS_CACHE_TTL", "300")), 3600.0))
        except (TypeError, ValueError):
            self._llm_cache_ttl = 300.0
        try:
            self._llm_cooldown = max(5.0, min(float(os.environ.get("OPENAI_HEADLESS_COOLDOWN", "60")), 3600.0))
        except (TypeError, ValueError):
            self._llm_cooldown = 60.0

    def _workspace_summary(self, workspace: dict[str, Any] | None) -> str:
        if not workspace:
            return "No workspace snapshot supplied."
        layers = workspace.get("activeLayers") or []
        parts = []
        for layer in layers:
            geojson = layer.get("geoJsonData") if isinstance(layer, dict) else None
            features = geojson.get("features") if isinstance(geojson, dict) else []
            features = features if isinstance(features, list) else []
            derived_fields = sorted({key for feature in features[:100] for key in (feature.get("properties") or {}).keys()})[:50]
            derived_geometry = sorted({(feature.get("geometry") or {}).get("type") for feature in features[:100] if isinstance(feature, dict) and (feature.get("geometry") or {}).get("type")})
            derived_samples = [{key: (feature.get("properties") or {}).get(key) for key in derived_fields[:10]} for feature in features[:3] if isinstance(feature, dict)]
            parts.append({
                "name": layer.get("displayName"),
                "key": layer.get("uniqueKey"),
                "type": "folder" if layer.get("isFolder") else "layer",
                "visible": layer.get("isVisible", True),
                "parentId": layer.get("parentId"),
                "geometryType": layer.get("geometryType") or layer.get("geometry_type") or derived_geometry,
                "crs": layer.get("crs") or layer.get("crs_name") or (geojson or {}).get("crs_name"),
                "bbox": layer.get("bbox") or _geojson_bbox(geojson or {}),
                "fields": layer.get("fields") or layer.get("fieldNames") or derived_fields,
                "sampleValues": layer.get("sampleValues") or layer.get("representativeValues") or derived_samples,
                "themes": layer.get("themes") or layer.get("theme"),
                "tags": layer.get("tags"),
                "geographicHints": layer.get("geographicHints") or layer.get("geographic_hints"),
                "provider": layer.get("provider") or layer.get("source"),
                "protocol": layer.get("protocol"),
                "validation": layer.get("validation") or layer.get("validationStatus"),
                "provenanceUrl": layer.get("provenanceUrl") or layer.get("sourceUrl") or layer.get("url"),
            })
        return json.dumps({
            "layers": parts,
            "mapBounds": (workspace or {}).get("mapBounds"),
            "selectedLayerKey": (workspace or {}).get("preferredTargetKey"),
            "activeEditLayerKey": (workspace or {}).get("activeEditLayerKey"),
            "activeCropLayerKey": (workspace or {}).get("activeCropLayerKey"),
        }, ensure_ascii=False)

    def _planner_reference_context(self, prompt: str, workspace: dict[str, Any] | None) -> str:
        """Return compact candidate context; never include feature collections."""
        intent = self.classify_intent(prompt, allow_remote=False)
        osm_candidates = []
        if intent.tags:
            osm_candidates.append({
                "concept": intent.theme,
                "tags": _payload_tags(intent.tags),
                "geometry": intent.geometry,
                "confidence": intent.confidence,
                "source": "local-deterministic",
            })
        catalog_candidates = []
        for item in ((workspace or {}).get("catalogSearchResults") or (workspace or {}).get("catalogResults") or [])[:5]:
            if not isinstance(item, dict):
                continue
            catalog_candidates.append({key: item.get(key) for key in ("title", "name", "description", "provider", "protocol", "format", "bbox", "provenanceUrl", "validation") if item.get(key) is not None})
        return json.dumps({"osmConceptCandidates": osm_candidates, "catalogCandidates": catalog_candidates}, ensure_ascii=False)

    def _remember_prompt(self, prompt: str) -> None:
        prompt = (prompt or "").strip()
        if not prompt:
            return
        self._recent_prompts = [p for p in self._recent_prompts if p != prompt][:9]
        self._recent_prompts.insert(0, prompt)

    def _resolve_layer_reference(self, prompt: str, workspace: dict[str, Any] | None) -> dict[str, Any] | None:
        if not workspace:
            return None
        layers = workspace.get("activeLayers") or []
        active_crop_key = workspace.get("activeCropLayerKey")
        if active_crop_key:
            for layer in layers:
                if layer.get("uniqueKey") == active_crop_key:
                    return layer
        text = _normalize_text(prompt)
        if any(tok in text for tok in ("the other layer", "other layer", "first one", "first layer")):
            visible_layers = [layer for layer in layers if layer.get("isVisible", True)]
            if len(visible_layers) == 1:
                return visible_layers[0]
            if len(layers) == 1:
                return layers[0]
        if any(tok in text for tok in ("visible one", "shown layer", "active layer")):
            visible_layers = [layer for layer in layers if layer.get("isVisible", True)]
            if len(visible_layers) == 1:
                return visible_layers[0]
        if any(tok in text for tok in ("second one", "second layer", "next layer")) and len(layers) >= 2:
            ordered_layers = [layer for layer in layers if not layer.get("isFolder") and layer.get("isVisible", True)]
            if len(ordered_layers) >= 2:
                return ordered_layers[1]
            ordered_layers = [layer for layer in layers if not layer.get("isFolder")]
            if len(ordered_layers) >= 2:
                return ordered_layers[1]
            return layers[1]
        candidates: list[tuple[int, dict[str, Any]]] = []
        for layer in layers:
            name = _normalize_text(layer.get("displayName") or "")
            ident = _normalize_text(layer.get("id") or "")
            uniq = _normalize_text(layer.get("uniqueKey") or "")
            if not name:
                continue
            score = 0
            if name in text:
                score += 100
            if ident and ident in text:
                score += 80
            if uniq and uniq in text:
                score += 60
            for token in [tok for tok in name.split() if tok]:
                if token in text:
                    score += len(token)
            if score > 0:
                candidates.append((score, layer))
        if candidates:
            candidates.sort(key=lambda item: (-item[0], len(_normalize_text(item[1].get("displayName") or ""))))
            return candidates[0][1]
        visible_layers = [layer for layer in layers if layer.get("isVisible", True)]
        if len(visible_layers) == 1:
            return visible_layers[0]
        return layers[0] if len(layers) == 1 else None

    def _resolve_folder_reference(self, prompt: str, workspace: dict[str, Any] | None) -> dict[str, Any] | None:
        if not workspace:
            return None
        layers = workspace.get("activeLayers") or []
        text = _normalize_text(prompt)
        candidates: list[tuple[int, dict[str, Any]]] = []
        for layer in layers:
            if not layer.get("isFolder"):
                continue
            name = _normalize_text(layer.get("displayName") or "")
            score = 0
            if name in text:
                score += 100
            for token in [tok for tok in name.split() if tok]:
                if token in text:
                    score += len(token)
            if score > 0:
                candidates.append((score, layer))
        if candidates:
            candidates.sort(key=lambda item: (-item[0], len(_normalize_text(item[1].get("displayName") or ""))))
            return candidates[0][1]
        folders = [layer for layer in layers if layer.get("isFolder")]
        return folders[0] if len(folders) == 1 else None

    def _resolve_workspace_search_target(self, prompt: str, workspace: dict[str, Any] | None) -> dict[str, Any] | None:
        target = self._resolve_layer_reference(prompt, workspace)
        if target:
            return target
        if workspace and self._recent_prompts:
            return self._resolve_layer_reference(self._recent_prompts[0], workspace)
        return None

    @staticmethod
    def _conversation_summary(conversation: list[dict[str, Any]] | None) -> str:
        if not conversation:
            return "No earlier conversation in this chat."
        messages = []
        for item in conversation[-8:]:
            if not isinstance(item, dict):
                continue
            role = item.get("role") if item.get("role") in {"user", "assistant"} else "user"
            content = str(item.get("content") or "").strip()
            if content:
                messages.append({"role": role, "content": content[:2000]})
        return json.dumps(messages, ensure_ascii=False)

    @staticmethod
    def _distance_from_prompt(prompt: str) -> float | None:
        match = re.search(r"\b([0-9]+(?:\.[0-9]+)?)\s*(km|kilometers?|kilometres?|m|meters?|metres?|ft|feet|foot|mi|mile|miles)\b", prompt or "", re.I)
        if not match:
            return None
        value = float(match.group(1))
        unit = match.group(2).lower()
        if unit in {"m", "meter", "meters", "metre", "metres", "km", "kilometer", "kilometers", "kilometre", "kilometres"}:
            if unit.startswith("m"):
                return value / 1000.0
            return value
        if unit in {"ft", "feet", "foot"}:
            return value * 0.0003048
        if unit in {"mi", "mile", "miles"}:
            return value * 1.609344
        return value

    @staticmethod
    def _extract_named_street(prompt: str) -> str | None:
        """Extract a road name when the user wants the road itself."""
        text = correct_text(prompt)
        body = re.split(r"\s+(?:in|near|around|at)\s+", text, maxsplit=1, flags=re.I)[0]
        road_suffix = r"street|st|road|rd|avenue|ave|boulevard|blvd|drive|dr|lane|ln|way|court|ct|place|pl|highway|hwy|parkway|pkwy|crescent|cr|terrace|ter|circle|cir|route"
        marked = re.search(r"\b(?:for|of|named|called)\s+(.+)$", body, re.I)
        candidate = marked.group(1) if marked else body
        candidate = re.sub(r"^(?:(?:show|find|get|map|display|locate|extract|return|provide|give)\s+)+", "", candidate, flags=re.I)
        candidate = re.sub(r"^(?:(?:me|a|an|the|single|one|vector|line|way|geometry|shape)\s+)+", "", candidate, flags=re.I)
        match = re.search(rf"([A-Za-z0-9][A-Za-z0-9 .'-]*\b(?:{road_suffix})\b)\s*$", candidate, re.I)
        if match and re.search(r"\b(?:on|along|beside|near|around|by|close to|in proximity to)\b", candidate[:match.start()], re.I):
            # This is a reference road (for example, "hydrants on Main
            # Street"), not a request for the road geometry itself.
            return None
        return re.sub(r"\s+", " ", match.group(1)).strip(" ,") if match else None

    def _followup_osm_spec(self, prompt: str, conversation: list[dict[str, Any]] | None) -> OsmQuerySpec | None:
        """Apply a short distance-only reply to the previous OSM request."""
        distance_km = self._distance_from_prompt(prompt)
        if distance_km is None or not conversation:
            return None
        for message in reversed(conversation):
            if not isinstance(message, dict) or message.get("role") != "user":
                continue
            previous = self.parse_osm_query(str(message.get("content") or ""))
            if not previous or not previous.spatial_constraints:
                continue
            constraint = previous.spatial_constraints[0]
            if constraint.relation not in {"on", "along", "beside", "near"}:
                continue
            return OsmQuerySpec(
                feature_concept=previous.feature_concept,
                feature_name=previous.feature_name,
                location=previous.location,
                spatial_constraints=[SpatialConstraint(constraint.relation, constraint.reference, constraint.location, distance_km)],
                attributes=previous.attributes,
                geometry=previous.geometry,
                confidence=previous.confidence,
            )
        return None

    def _planner_cache_key(self, prompt: str, workspace: dict[str, Any] | None, conversation: list[dict[str, Any]] | None) -> str:
        intent = self.classify_intent(prompt, allow_remote=False)
        spec = self.parse_osm_query(prompt)
        value = json.dumps({
            "version": "local-first-v2",
            "intent": asdict(intent),
            "querySpec": spec.to_dict() if spec else None,
            "prompt": _normalize_text(prompt),
            "workspace": self._workspace_summary(workspace),
            "spatialExtent": (workspace or {}).get("mapBounds"),
            "conversation": self._conversation_summary(conversation),
            "model": self._openai_model or "gpt-4.1-mini",
            "base_url": self._planner_base_url or "https://api.openai.com/v1",
        }, sort_keys=True, ensure_ascii=False)
        return hashlib.sha256(value.encode("utf-8")).hexdigest()

    @staticmethod
    def _valid_planner_tag(tag: Any) -> dict[str, str] | None:
        if not isinstance(tag, dict):
            return None
        key = str(tag.get("key") or "").strip()
        value = str(tag.get("val") if tag.get("val") is not None else tag.get("value") or "").strip()
        if not re.fullmatch(r"[A-Za-z0-9_:-]{1,64}", key) or not re.fullmatch(r"[A-Za-z0-9_:@./ +-]{0,128}", value):
            return None
        return {"key": key, "val": value}

    @classmethod
    def _valid_planner_tags(cls, tags: Any) -> list[dict[str, str]]:
        return [tag for tag in (cls._valid_planner_tag(item) for item in (tags or [])) if tag]

    def _reconcile_hosted_actions(
        self,
        parsed: dict[str, Any],
        prompt: str,
        workspace: dict[str, Any] | None,
        conversation: list[dict[str, Any]] | None,
    ) -> tuple[list[HeadlessAction], str | None]:
        if not isinstance(parsed, dict) or not isinstance(parsed.get("actions", []), list):
            raise ValueError("planner response must contain an actions array")
        direct_spec = self.parse_osm_query(prompt)
        spec = direct_spec or self._followup_osm_spec(prompt, conversation)
        deterministic_prompt = prompt
        if direct_spec is None and conversation:
            deterministic_prompt = next((str(item.get("content") or "") for item in reversed(conversation) if isinstance(item, dict) and item.get("role") == "user" and str(item.get("content") or "").strip()), prompt)
        intent = self.classify_intent(deterministic_prompt, allow_remote=False)
        actions: list[HeadlessAction] = []
        for item in parsed.get("actions", []):
            if not isinstance(item, dict):
                continue
            action_type = str(item.get("type") or "").strip()
            if action_type not in SUPPORTED_ACTIONS:
                continue
            payload = dict(item.get("payload") or {}) if isinstance(item.get("payload") or {}, dict) else {}
            if action_type == "search_layers":
                payload.setdefault("query", prompt)
                payload.setdefault("limit", 10)
            if action_type == "osm_search":
                model_tags = self._valid_planner_tags(payload.get("tags"))
                # Deterministic concepts are authoritative. The hosted model
                # may explain an unfamiliar phrase, but cannot replace a
                # known-safe mapping such as emergency=fire_hydrant.
                if intent.source == "osm" and intent.tags:
                    payload["tags"] = _payload_tags(intent.tags)
                    payload["geomType"] = intent.geometry or payload.get("geomType") or "all"
                    if intent.location:
                        payload["loc"] = intent.location
                    if intent.tag_alternatives:
                        payload["tagAlternatives"] = [_payload_tags(items) for items in intent.tag_alternatives]
                else:
                    payload["tags"] = model_tags
                alternatives = []
                for alternative in payload.get("tagAlternatives") or []:
                    clean = self._valid_planner_tags(alternative)
                    if clean and clean not in alternatives:
                        alternatives.append(clean)
                payload["tagAlternatives"] = alternatives
                if spec and spec.spatial_constraints:
                    constraint = spec.spatial_constraints[0]
                    payload["loc"] = spec.location
                    payload["relation"] = constraint.relation
                    payload.pop("proximity_reference", None)
                    payload.pop("street", None)
                    payload.pop("near_place", None)
                    if constraint.relation in {"on", "along", "beside"}:
                        payload["street"] = constraint.reference
                    elif constraint.relation in {"near", "within"}:
                        payload["near_place"] = constraint.reference
                    if constraint.distance_km is not None:
                        payload["distance_km"] = constraint.distance_km
                    else:
                        # Never let the hosted model invent a distance when
                        # the user has not supplied one; the UI must ask.
                        payload.pop("distance_km", None)
                if spec and spec.feature_name:
                    payload["featName"] = spec.feature_name
                    payload["exactName"] = True
                    if spec.feature_concept == "street":
                        payload["tags"] = [{"key": "highway", "val": ""}]
                        payload["geomType"] = "lines_polygons"
                        payload["wayOnly"] = True
                payload["geomType"] = payload.get("geomType") if payload.get("geomType") in {"all", "points", "lines_polygons", "polygons"} else "all"
                if not payload.get("tags") and not payload.get("featName"):
                    continue
                payload.setdefault("mapBounds", (workspace or {}).get("mapBounds"))
            if action_type == "filter_layers":
                target = self._resolve_layer_reference(prompt, workspace)
                if target and target.get("geoJsonData"):
                    payload["source"] = target["geoJsonData"]
                    payload.setdefault("layerKey", target.get("uniqueKey"))
                    payload.setdefault("layer", target)
            payload.setdefault("workspace", workspace or {})
            target = self._resolve_layer_reference(prompt, workspace)
            if target and action_type in {"delete_layer", "duplicate_layer", "move_to_folder", "rename_layer", "select_layer", "zoom_to_layer", "open_table", "toggle_edit", "toggle_crop", "toggle_split", "set_visibility", "apply_style", "export_layer"}:
                payload.setdefault("layerKey", target.get("uniqueKey"))
                payload.setdefault("layer", target)
            actions.append(HeadlessAction(type=action_type, input=payload))
        clarification = str(parsed.get("clarification") or "").strip() or None
        return actions, clarification

    def _plan_with_llm_result(self, prompt: str, workspace: dict[str, Any] | None = None, conversation: list[dict[str, Any]] | None = None) -> tuple[list[HeadlessAction], dict[str, Any]]:
        info = {"mode": "hosted-unavailable", "hosted_attempted": False, "model": self._openai_model or "gpt-4.1-mini"}
        if not self._openai_api_key:
            info["reason"] = "no OPENAI_API_KEY configured"
            return [], info
        cache_key = self._planner_cache_key(prompt, workspace, conversation)
        now = time.monotonic()
        with self._llm_cache_lock:
            cached = self._llm_plan_cache.get(cache_key)
            if cached and now - cached[0] <= self._llm_cache_ttl:
                info.update({"mode": "hosted-cache", "reason": "reused a recent hosted plan"})
                return copy.deepcopy(cached[1]), info
            if cached:
                self._llm_plan_cache.pop(cache_key, None)
        if now < self._llm_failure_until:
            info.update({"mode": "hosted-circuit-open", "reason": "hosted planner temporarily paused after a recent failure"})
            return [], info

        nullable_string = {"type": ["string", "null"]}
        nullable_number = {"type": ["number", "null"]}
        nullable_boolean = {"type": ["boolean", "null"]}
        nullable_tags = {
            "type": ["array", "null"],
            "items": {
                "type": "object",
                "properties": {"key": {"type": "string"}, "val": {"type": "string"}},
                "required": ["key", "val"],
                "additionalProperties": False,
            },
        }
        nullable_bounds = {
            "type": ["object", "null"],
            "properties": {
                "south": nullable_number,
                "west": nullable_number,
                "north": nullable_number,
                "east": nullable_number,
            },
            "required": ["south", "west", "north", "east"],
            "additionalProperties": False,
        }
        nullable_style = {
            "type": ["object", "null"],
            "properties": {
                "type": nullable_string, "color": nullable_string, "fillColor": nullable_string,
                "fillOpacity": nullable_number, "opacity": nullable_number, "weight": nullable_number,
                "pointShape": nullable_string, "pointSize": nullable_number, "dashArray": nullable_string,
                "outlineColor": nullable_string, "outlineWidth": nullable_number, "outlineOpacity": nullable_number,
                "radius": nullable_number,
            },
            "required": ["type", "color", "fillColor", "fillOpacity", "opacity", "weight", "pointShape", "pointSize", "dashArray", "outlineColor", "outlineWidth", "outlineOpacity", "radius"],
            "additionalProperties": False,
        }
        nullable_center = {
            "type": ["object", "null"],
            "properties": {"lat": nullable_number, "lng": nullable_number, "lon": nullable_number},
            "required": ["lat", "lng", "lon"],
            "additionalProperties": False,
        }
        nullable_criteria = {
            "type": ["object", "null"],
            "properties": {
                "operation": nullable_string, "mode": nullable_string, "column": nullable_string,
                "operator": nullable_string, "value": {"type": ["string", "number", "boolean", "null"]},
                "values": {"type": ["array", "null"], "items": {"type": ["string", "number", "boolean", "null"]}},
                "radius_km": nullable_number, "distance_m": nullable_number, "center": nullable_center,
                "bbox": nullable_bounds, "predicate": nullable_string,
            },
            "required": ["operation", "mode", "column", "operator", "value", "values", "radius_km", "distance_m", "center", "bbox", "predicate"],
            "additionalProperties": False,
        }
        payload_properties = {
            "mode": nullable_string, "source": nullable_string, "query": nullable_string, "limit": {"type": ["integer", "null"]},
            "tags": nullable_tags, "tagAlternatives": {"type": ["array", "null"], "items": {"type": "array", "items": nullable_tags["items"]}},
            "loc": nullable_string, "mapBounds": nullable_bounds, "geomType": {"type": ["string", "null"]},
            "relation": {"type": ["string", "null"]}, "street": nullable_string, "near_place": nullable_string,
            "proximity_reference": nullable_string, "distance_km": nullable_number, "featName": nullable_string,
            "exactName": nullable_boolean, "wayOnly": nullable_boolean, "layerKey": nullable_string,
            "name": nullable_string, "parentId": nullable_string, "visible": nullable_boolean, "focus": nullable_string,
            "operation": nullable_string, "column": nullable_string, "operator": nullable_string, "value": {"type": ["string", "number", "boolean", "null"]},
            "radius_km": nullable_number, "distance_m": nullable_number, "maxArea": nullable_number,
            "provider": nullable_string, "protocol": nullable_string, "theme": nullable_string,
            "style": nullable_style, "criteria": nullable_criteria,
        }
        payload_schema = {"type": "object", "properties": payload_properties, "required": list(payload_properties), "additionalProperties": False}
        schema = {
            "type": "object",
            "properties": {
                "actions": {"type": "array", "items": {"type": "object", "properties": {"type": {"type": "string", "enum": sorted(SUPPORTED_ACTIONS)}, "payload": payload_schema}, "required": ["type", "payload"], "additionalProperties": False}},
                "clarification": {"type": ["string", "null"]},
            },
            "required": ["actions", "clarification"],
            "additionalProperties": False,
        }
        body = {
            "model": self._openai_model or "gpt-4.1-mini",
            "temperature": 0.0,
            "input": [
                {"role": "system", "content": [{"type": "input_text", "text": (
                    "Convert the current GIS request into a compact plan. Use only supported action types and return JSON. "
                    "For OSM use osm_search with structured tags [{key,val}], loc, mapBounds, geomType, relation, street or near_place, "
                    "distance_km, featName, exactName, wayOnly, and tagAlternatives. Relations mean on/along/beside (road corridor), "
                    "near (a named place or feature), or within (a distance of a reference). Ask for clarification instead of guessing "
                    "an ambiguous concept, place, relation, or distance. Never return executable Overpass QL."
                )}]},
                {"role": "user", "content": [{"type": "input_text", "text": f"Workspace summary:\n{self._workspace_summary(workspace)}\n\nCatalog and OSM candidates (hints only; validate before execution):\n{self._planner_reference_context(prompt, workspace)}\n\nConversation in this chat (only for follow-ups; current request wins):\n{self._conversation_summary(conversation)}\n\nCurrent request:\n{prompt}"}]},
            ],
            "text": {"format": {"type": "json_schema", "name": "headless_plan", "schema": schema, "strict": True}},
        }
        try:
            # Serialize hosted calls and check the cache again after waiting.
            # Two identical browser requests arriving together therefore share
            # one request instead of multiplying latency and API usage.
            with self._llm_request_lock:
                with self._llm_cache_lock:
                    cached = self._llm_plan_cache.get(cache_key)
                    if cached and time.monotonic() - cached[0] <= self._llm_cache_ttl:
                        info.update({"mode": "hosted-cache", "reason": "reused a concurrent hosted plan"})
                        return copy.deepcopy(cached[1]), info
                info["hosted_attempted"] = True
                response = requests.post(
                    f"{self._planner_base_url or 'https://api.openai.com/v1'}/responses",
                    headers={"Authorization": f"Bearer {self._openai_api_key}", "Content-Type": "application/json"},
                    json=body,
                    timeout=self._llm_timeout,
                )
                if response.status_code >= 400:
                    try:
                        detail = ((response.json().get("error") or {}).get("message") or response.text)
                    except (ValueError, TypeError):
                        detail = response.text
                    raise requests.HTTPError(f"OpenAI planner request failed ({response.status_code}): {str(detail)[:500]}", response=response)
                data = response.json()
                text = data.get("output_text")
                if not text:
                    for item in data.get("output") or []:
                        for block in item.get("content") or []:
                            if block.get("type") in {"output_text", "text"} and block.get("text"):
                                text = block["text"]
                                break
                        if text:
                            break
                if not text:
                    raise ValueError("hosted planner returned no structured output")
                actions, clarification = self._reconcile_hosted_actions(json.loads(text), prompt, workspace, conversation)
                self._llm_failure_until = 0.0
                self._llm_failure_count = 0
                if self._llm_cache_ttl > 0 and actions:
                    with self._llm_cache_lock:
                        self._llm_plan_cache[cache_key] = (time.monotonic(), copy.deepcopy(actions))
                info.update({"mode": "hosted", "reason": "hosted planner used", "clarification": clarification})
                return actions, info
        except Exception as exc:
            self._llm_failure_count += 1
            self._llm_failure_until = time.monotonic() + self._llm_cooldown
            info.update({"mode": "hosted-failed", "reason": str(exc)[:240]})
            print(f"[Headless Planner] Hosted planning failed; using local planner: {exc}")
            return [], info

    def _plan_with_llm(self, prompt: str, workspace: dict[str, Any] | None = None, conversation: list[dict[str, Any]] | None = None) -> list[HeadlessAction]:
        actions, _info = self._plan_with_llm_result(prompt, workspace=workspace, conversation=conversation)
        return actions

    def classify_intent(self, prompt: str, *, allow_remote: bool = True) -> IntentClassification:
        """Classify data-source intent before provider-specific planning."""
        text = normalize_osm_text(prompt)
        location_match = re.search(r"\b(?:near|around|in|at)\s+(.+?)\s*$", prompt, re.I)
        shape_match = re.search(r"\b(?:outline|boundary|boundaries|shape)\s+(?:of|for)\s+(.+?)\s*$", prompt, re.I)
        city_match = re.search(r"\bcity\s+of\s+(.+?)\s*$", prompt, re.I)
        if shape_match or city_match:
            location_match = shape_match or city_match
        relation_match = re.match(r"(.+?)\s+(on|along|beside|near|around|by|close to|in proximity to)\s+(.+?)(?:\s+(?:near|around|in|at)\s+|,\s+)(.+?)\s*$", text, re.I)
        within_match = re.match(r"(.+?)\s+within\s+([0-9]+(?:\.[0-9]+)?)\s*(km|kilometers?|kilometres?|m|meters?|metres?)\s+of\s+(.+?)(?:\s+(?:in|near|around|at)\s+(.+?))?$", text, re.I)
        if within_match:
            location = (within_match.group(5) or within_match.group(4)).strip()
        else:
            location = location_match.group(1).strip() if location_match else None
        feature_text = relation_match.group(1) if relation_match else within_match.group(1) if within_match else text
        feature_text = _normalize_text(feature_text)
        parsed_spec = self.parse_osm_query(prompt)
        if parsed_spec:
            location = parsed_spec.location or location
            feature_text = _normalize_text(parsed_spec.feature_concept)
        # Boundary intent is structural, not a feature-category guess. It
        # must be resolved before fuzzy aliases are considered, otherwise a
        # place such as "Welland" can be scored as the unrelated "wetland"
        # feature and prevent the administrative-boundary path from running.
        if shape_match or city_match:
            return IntentClassification(
                "osm",
                "search",
                theme="administrative boundary",
                location=location,
                tags=[{"key": "boundary", "val": "administrative"}],
                confidence=.95,
            )
        named_street = self._extract_named_street(prompt)
        if named_street and not (parsed_spec and parsed_spec.spatial_constraints):
            return IntentClassification(
                "osm", "search", theme="roads", location=(parsed_spec.location if parsed_spec else location),
                tags=[{"key": "highway", "val": ""}], confidence=.95,
                geometry="lines_polygons",
            )
        # When the parser has not identified a feature phrase separately from
        # the location, only exact aliases are safe. This preserves ordinary
        # typo tolerance for explicit searches such as "fire hydrents near
        # Welland" while preventing a standalone geographic name from being
        # interpreted as a nearby feature category.
        intelligent_feature = infer_feature(
            feature_text,
            allow_fuzzy=bool(parsed_spec or relation_match or within_match),
        )
        if intelligent_feature:
            return IntentClassification(
                "osm", "search", theme=intelligent_feature["name"], location=location,
                tags=intelligent_feature["tags"], confidence=intelligent_feature["confidence"],
                geometry=intelligent_feature.get("geometry", "all"),
                tag_alternatives=intelligent_feature.get("tag_alternatives", []),
            )
        osm_terms = {
            "park": ({"leisure": "park"}, "parks"), "school": ({"amenity": "school"}, "schools"),
            "hospital": ({"amenity": "hospital"}, "hospitals"), "restaurant": ({"amenity": "restaurant"}, "restaurants"),
            "cafe": ({"amenity": "cafe"}, "cafes"), "library": ({"amenity": "library"}, "libraries"),
            "road": ({"highway": ""}, "roads"), "street": ({"highway": ""}, "roads"),
            "trail": ({"highway": "path"}, "trails"), "building": ({"building": ""}, "buildings"),
            "house": ({"building": "house"}, "houses"), "waterway": ({"waterway": ""}, "waterways"),
            "river": ({"waterway": "river"}, "rivers"), "lake": ({"natural": "water"}, "lakes"),
            "shop": ({"shop": ""}, "shops"), "store": ({"shop": ""}, "shops"),
            "bus": ({"highway": "bus_stop"}, "bus stops"), "transit": ({"public_transport": "platform"}, "transit"),
            "fire station": ({"amenity": "fire_station"}, "fire stations"), "police": ({"amenity": "police"}, "police stations"),
            "fire hydrant": ({"emergency": "fire_hydrant"}, "fire hydrants"), "fire hydrants": ({"emergency": "fire_hydrant"}, "fire hydrants"),
            "playground": ({"leisure": "playground"}, "playgrounds"), "campground": ({"tourism": "camp_site"}, "campgrounds"),
            "airport": ({"aeroway": "aerodrome"}, "airports"), "airports": ({"aeroway": "aerodrome"}, "airports"),
            "railway": ({"railway": ""}, "railways"), "train station": ({"railway": "station"}, "train stations"),
            "fuel": ({"amenity": "fuel"}, "fuel stations"), "gas station": ({"amenity": "fuel"}, "fuel stations"),
            "post office": ({"amenity": "post_office"}, "post offices"), "pharmacy": ({"amenity": "pharmacy"}, "pharmacies"),
            "bank": ({"amenity": "bank"}, "banks"), "parking": ({"amenity": "parking"}, "parking areas"),
            "cemetery": ({"amenity": "grave_yard"}, "cemeteries"), "church": ({"amenity": "place_of_worship"}, "churches"),
            "beach": ({"natural": "beach"}, "beaches"), "forest": ({"landuse": "forest"}, "forests"),
            "farm": ({"landuse": "farmland"}, "farms"), "hotel": ({"tourism": "hotel"}, "hotels"),
        }
        matches = [(tags, theme) for term, (tags, theme) in osm_terms.items() if re.search(rf"\b{re.escape(term)}\b", feature_text)]
        if location and matches:
            tags, theme = matches[0]
            return IntentClassification("osm", "search", theme=theme, location=location, tags=[tags], confidence=.92)
        # Resolve unfamiliar concepts dynamically only after precise local
        # mappings have been considered.
        if allow_remote and location:
            theme_text = "administrative boundary" if shape_match else re.sub(r"\b(?:near|around|in|at)\s+.+?$", "", text).strip()
            if theme_text:
                dynamic_tags = self._lookup_osm_tags(theme_text)
                if dynamic_tags:
                    # The current Overpass builder combines tag selectors
                    # with AND semantics. Use the ranked primary mapping;
                    # alternatives are retained for future retry strategies.
                    return IntentClassification("osm", "search", theme=theme_text, location=location, tags=dynamic_tags[:1], confidence=.78)
        gis_terms = ("flood", "census", "zoning", "parcel", "cadastral", "property", "tax", "election", "planning", "regulation", "demographic", "boundary", "wetland", "conservation")
        has_gis = any(term in feature_text for term in gis_terms)
        if matches and has_gis:
            return IntentClassification("both", "search", theme=matches[0][1], location=location, tags=[matches[0][0]], confidence=.55, alternatives=["osm", "gis_server"], clarification="This request could use OpenStreetMap or an authoritative GIS dataset.")
        if matches:
            return IntentClassification("osm", "search", theme=matches[0][1], location=location, tags=[matches[0][0]], confidence=.9)
        if has_gis:
            return IntentClassification("gis_server", "search", theme=text, location=location, confidence=.85)
        # Resolve unfamiliar nearby feature concepts dynamically instead of
        # requiring a source-code keyword for every OSM category.
        return IntentClassification("unknown", "unknown", confidence=.2, alternatives=["osm", "gis_server"])

    def parse_osm_query(self, prompt: str) -> OsmQuerySpec | None:
        """Extract a composable OSM query without binding to a place list."""
        text = correct_text(prompt)
        # Users often answer a distance clarification by keeping the original
        # request and appending the distance (including on a new line), e.g.
        # "fire hydrants on Main Street in Toronto 10m". Strip that suffix
        # before parsing the place name so it cannot become "Toronto 10m".
        trailing_distance_km = None
        trailing_distance = re.search(
            r"(?:\bwithin\s+)?([0-9]+(?:\.[0-9]+)?)\s*"
            r"(km|kilometers?|kilometres?|m|meters?|metres?|ft|feet|foot|mi|mile|miles)"
            r"\s*\)?\s*$",
            text,
            re.I,
        )
        if trailing_distance and text[:trailing_distance.start()].strip():
            trailing_distance_km = self._distance_from_prompt(trailing_distance.group(0))
            text = text[:trailing_distance.start()].rstrip(" ,.;:-(")
        relation_distance = re.match(
            r"(.+?)\s+(on|along|beside|near|around|by|close to|in proximity to)\s+(.+?)\s+within\s+([0-9]+(?:\.[0-9]+)?)\s*(km|kilometers?|kilometres?|m|meters?|metres?|ft|feet|foot|mi|mile|miles)\s*(?:of\s+)?(?:in|near|around|at)\s+(.+)$",
            text,
            re.I,
        )
        if relation_distance:
            feature, operator, reference, distance, unit, location = relation_distance.groups()
            normalized_operator = "near" if operator.lower() in {"around", "by", "close to", "in proximity to"} else operator.lower()
            distance_km = self._distance_from_prompt(f"{distance} {unit}")
            return OsmQuerySpec(
                feature_concept=feature.strip(),
                location=location.strip(" ,"),
                spatial_constraints=[SpatialConstraint(normalized_operator, reference.strip(" ,."), location.strip(" ,."), distance_km)],
                confidence=.95,
            )
        relation = re.match(r"(.+?)\s+(on|along|beside|near|around|by|close to|in proximity to)\s+(.+?)(?:\s+(?:in|near|around|at)\s+|,\s+)(.+)$", text, re.I)
        if relation:
            feature, operator, reference, location = relation.groups()
            normalized_operator = "near" if operator.lower() in {"around", "by", "close to", "in proximity to"} else operator.lower()
            return OsmQuerySpec(feature_concept=feature.strip(), location=location.strip(" ,."), spatial_constraints=[SpatialConstraint(normalized_operator, reference.strip(" ,."), location.strip(" ,."), trailing_distance_km)], confidence=.9)
        within = re.match(r"(.+?)\s+within\s+([0-9]+(?:\.[0-9]+)?)\s*(km|kilometers?|kilometres?|m|meters?|metres?|ft|feet|foot|mi|mile|miles)\s+of\s+(.+?)(?:\s+(?:in|near|around|at)\s+(.+?))?$", text, re.I)
        if within:
            feature, distance, unit, reference, location = within.groups()
            distance_km = self._distance_from_prompt(f"{distance} {unit}")
            location = (location or reference).strip(" ,")
            return OsmQuerySpec(feature_concept=feature.strip(), location=location, spatial_constraints=[SpatialConstraint("within", reference.strip(), location, distance_km)], confidence=.9)
        named_street = self._extract_named_street(text)
        if named_street:
            location_match = re.search(r"\s+(?:in|near|around|at)\s+(.+)$", text, re.I)
            return OsmQuerySpec(
                feature_concept="street",
                feature_name=named_street,
                location=location_match.group(1).strip() if location_match else None,
                geometry="lines_polygons",
                confidence=.9,
            )
        proximity = re.match(r"(.+?)\s+(near|around|by|close to|in proximity to|on|along|beside)\s+(.+)$", text, re.I)
        if proximity:
            feature, operator, reference = proximity.groups()
            normalized_operator = "near" if operator.lower() in {"around", "by", "close to", "in proximity to"} else operator.lower()
            return OsmQuerySpec(feature_concept=feature.strip(), location=reference.strip(), spatial_constraints=[SpatialConstraint(normalized_operator, reference.strip(), reference.strip(), trailing_distance_km)], confidence=.75)
        match = re.match(r"(.+?)\s+(?:near|around|in|at)\s+(.+)$", text, re.I)
        if match:
            return OsmQuerySpec(feature_concept=match.group(1).strip(), location=match.group(2).strip(), confidence=.65)
        return None

    def _lookup_osm_tags(self, theme: str) -> list[dict[str, str]]:
        """Resolve an unfamiliar concept through Taginfo's public metadata API."""
        if not theme or len(theme) > 80:
            return []
        try:
            query = theme.lower().strip()
            queries = [query]
            if query.endswith("ies"):
                queries.append(query[:-3] + "y")
            elif query.endswith("s"):
                queries.append(query[:-1])
            response = requests.get(
                "https://taginfo.openstreetmap.org/api/4/tags/popular",
                params={"query": queries[0], "sortname": "count_all", "order": "desc", "rp": 20},
                headers={"User-Agent": "GIS-Layer-Previewer/1.0"}, timeout=4,
            )
            response.raise_for_status()
            rows = response.json().get("data") or []
            # Plural English concepts often rank poorly in Taginfo. Retry the
            # singular form before accepting a weak or unrelated mapping.
            if len(rows) < 1 and len(queries) > 1:
                response = requests.get("https://taginfo.openstreetmap.org/api/4/tags/popular", params={"query": queries[1], "sortname": "count_all", "order": "desc", "rp": 20}, headers={"User-Agent": "GIS-Layer-Previewer/1.0"}, timeout=4)
                response.raise_for_status()
                rows = response.json().get("data") or []
            tags = []
            for row in rows:
                key, value = str(row.get("key") or ""), str(row.get("value") or "")
                if re.fullmatch(r"[A-Za-z0-9_:-]{1,64}", key) and re.fullmatch(r"[A-Za-z0-9_:-]{0,64}", value):
                    tags.append({key: value})
                if len(tags) >= 3:
                    break
            return tags
        except (requests.RequestException, ValueError, TypeError):
            return []

    def _plan(self, prompt: str, workspace: dict[str, Any] | None = None, mode: str = 'auto', conversation: list[dict[str, Any]] | None = None) -> list[HeadlessAction]:
        text = _normalize_text(prompt)
        actions: list[HeadlessAction] = []
        target = self._resolve_layer_reference(prompt, workspace)
        if not target and conversation:
            for message in reversed(conversation):
                if isinstance(message, dict) and message.get("role") == "user":
                    target = self._resolve_layer_reference(str(message.get("content") or ""), workspace)
                    if target:
                        break
        intent = self.classify_intent(prompt, allow_remote=False)
        query_spec = self.parse_osm_query(prompt)
        followup_spec = self._followup_osm_spec(prompt, conversation)
        if followup_spec and (not query_spec or not intent.location):
            query_spec = followup_spec
            previous_request = next((str(message.get("content") or "") for message in reversed(conversation or []) if isinstance(message, dict) and message.get("role") == "user" and str(message.get("content") or "").strip() != prompt.strip()), "")
            if previous_request:
                intent = self.classify_intent(previous_request, allow_remote=False)
        if mode == 'location':
            intent = IntentClassification('unknown', 'location', location=prompt, confidence=1.0)
        elif mode == 'osm' and intent.source == 'unknown':
            intent = IntentClassification('osm', 'search', theme=text, confidence=0.7)
        elif mode == 'gis_server':
            intent = IntentClassification('gis_server', 'search', theme=text, confidence=1.0)

        location_match = re.search(r"\b(?:zoom|move|fly|go)\s+(?:in\s+)?(?:to|on)\s+(.+?)\s*$", prompt, re.I)
        shape_match = re.search(r"\b(?:outline|boundary|boundaries|shape)\s+(?:of|for)\s+(.+?)\s*$", prompt, re.I)
        city_match = re.search(r"\bcity\s+of\s+(.+?)\s*$", prompt, re.I)
        explicit_layer = any(_normalize_text(layer.get("displayName") or "") in text for layer in (workspace or {}).get("activeLayers", []) if layer.get("displayName"))
        if location_match and not explicit_layer:
            target = None
            actions.append(HeadlessAction(type="zoom_to_location", input={"location": location_match.group(1).strip()}))
        if (shape_match or city_match) and not explicit_layer:
            target = None

        if any(token in text for token in ("load server", "load servers", "saved server", "saved servers", "catalog", "server list")):
            actions.append(HeadlessAction(type="load_servers", input={}))

        if any(token in text for token in ("search catalog", "catalog search", "search portal", "find dataset", "search server")):
            actions.append(HeadlessAction(type="search_layers", input={"source": "catalog", "query": prompt, "limit": 10, "workspace": workspace or {}}))

        if any(token in text for token in ("search the web", "find online", "internet", "discover sources", "find data online")):
            actions.append(HeadlessAction(type="discover_sources", input={"query": prompt, "limit": 10}))

        nearby_search = intent.source == "osm" and intent.operation == "search" and bool(intent.location)
        if nearby_search:
            relation_match = query_spec.spatial_constraints[0] if query_spec and query_spec.spatial_constraints else None
            subject = query_spec.feature_concept if query_spec else re.split(r"\b(?:near|around|in|at)\b", prompt, maxsplit=1, flags=re.I)[0].strip()
            subject = re.sub(r"^(?:show|find|locate|display|get|map|search\s+for)\s+", "", subject, flags=re.I).strip()
            search_input = {
                "mode": "auto", "loc": intent.location,
                "tags": _payload_tags(intent.tags),
                "geomType": intent.geometry or "all",
                "tagAlternatives": intent.tag_alternatives,
            }
            if relation_match:
                search_input["relation"] = relation_match.relation
                if relation_match.relation in {"on", "along", "beside"}:
                    search_input["street"] = relation_match.reference
                elif relation_match.relation == "near":
                    search_input["near_place"] = relation_match.reference
                if relation_match.distance_km is not None:
                    search_input["distance_km"] = relation_match.distance_km
                if relation_match.relation == "within":
                    search_input["near_place"] = relation_match.reference
            # Multi-word feature names are name filters; a simple category
            # such as “parks” remains an unfiltered category search.
            if shape_match or city_match:
                boundary_name = self._clean_place_text(intent.location).split(",", 1)[0].strip()
                search_input.update({
                    "featName": boundary_name,
                    "requested_place": boundary_name,
                    "boundary_target": "containing_municipality",
                    "requested_admin_level": "8",
                })
            elif query_spec and query_spec.feature_name:
                search_input["featName"] = query_spec.feature_name
                search_input["exactName"] = True
                if query_spec.feature_concept == "street":
                    search_input["wayOnly"] = True
            elif len(subject.split()) > len((intent.theme or "").split()) and not relation_match:
                search_input["featName"] = subject
            actions.append(HeadlessAction(type="osm_search", input=search_input))
        elif mode == "osm" or (intent.source == "osm" and not any(action.type == "osm_search" for action in actions)):
            # A feature-only request means “search the current map”, which is
            # the least surprising default for people using the OSM mode.
            feature_only_input = {
                "mode": "auto",
                "tags": _payload_tags(intent.tags),
                "geomType": intent.geometry or "all",
                "mapBounds": (workspace or {}).get("mapBounds"),
                "tagAlternatives": intent.tag_alternatives,
            }
            if query_spec and query_spec.feature_name:
                feature_only_input["featName"] = query_spec.feature_name
                feature_only_input["exactName"] = True
                if query_spec.feature_concept == "street":
                    feature_only_input["wayOnly"] = True
            actions.append(HeadlessAction(type="osm_search", input=feature_only_input))

        if any(token in text for token in ("spatial join", "spatially join", "join the layers", "join layers")):
            join_layers = [layer for layer in (workspace or {}).get("activeLayers", []) if not layer.get("isFolder") and layer.get("geoJsonData")]
            if len(join_layers) >= 2:
                actions.append(HeadlessAction(type="filter_layers", input={
                    "source": join_layers[0].get("geoJsonData"),
                    "criteria": {"operation": "spatial_join", "predicate": "intersects", "target": join_layers[1].get("geoJsonData")},
                    "name": f"{join_layers[0].get('displayName', 'Layer')} joined with {join_layers[1].get('displayName', 'Layer')}",
                }))
            else:
                actions.append(HeadlessAction(type="unsupported", input={"prompt": prompt, "reason": "A spatial join needs two active vector layers."}))
        elif any(token in text for token in ("filter", "crop", "clip")):
            filter_mode = "bbox" if any(token in text for token in ("box", "bbox", "bounds", "extent", "area")) else "radius" if any(token in text for token in ("radius", "circle", "buffer")) else "data"
            payload: dict[str, Any] = {"mode": filter_mode}
            if target and target.get("geoJsonData"):
                payload["source"] = target.get("geoJsonData")
                if not payload.get("criteria"):
                    payload["criteria"] = {"mode": filter_mode}
            if filter_mode == "data":
                payload["criteria"] = {"mode": "data"}
            actions.append(HeadlessAction(type="filter_layers", input=payload))

        if any(token in text for token in ("delete", "remove", "trash")):
            payload: dict[str, Any] = {}
            if target:
                payload["layerKey"] = target.get("uniqueKey")
                payload["layer"] = target
            actions.append(HeadlessAction(type="delete_layer", input=payload))

        if any(token in text for token in ("duplicate", "copy", "clone")):
            payload = {}
            if target:
                payload["layerKey"] = target.get("uniqueKey")
                payload["layer"] = target
            actions.append(HeadlessAction(type="duplicate_layer", input=payload))

        if any(token in text for token in ("folder", "group", "organize")):
            folder_name = prompt.strip()
            actions.append(HeadlessAction(type="create_folder", input={"name": folder_name[:48]}))

        if any(token in text for token in ("move", "nest", "organize into", "put in folder")):
            payload = {}
            if target:
                payload["layerKey"] = target.get("uniqueKey")
                payload["layer"] = target
            parent_id = None
            folder_match = self._resolve_folder_reference(prompt, workspace)
            if folder_match:
                parent_id = folder_match.get("uniqueKey")
            payload["parentId"] = parent_id
            actions.append(HeadlessAction(type="move_to_folder", input=payload))

        if any(token in text for token in ("rename", "retitle", "label")):
            payload = {"name": prompt.strip()}
            if target:
                payload["layerKey"] = target.get("uniqueKey")
                payload["layer"] = target
            actions.append(HeadlessAction(type="rename_layer", input=payload))

        if any(token in text for token in ("open table", "attribute table", "table")):
            payload = {"focus": "table"}
            if target:
                payload["layerKey"] = target.get("uniqueKey")
                payload["layer"] = target
            actions.append(HeadlessAction(type="open_table", input=payload))

        if any(token in text for token in ("edit style", "style editor", "paint", "symbolize")):
            payload = {}
            if target:
                payload["layerKey"] = target.get("uniqueKey")
                payload["layer"] = target
            actions.append(HeadlessAction(type="toggle_edit", input=payload))

        if any(token in text for token in ("crop", "clip", "filter layer")):
            payload = {}
            if target:
                payload["layerKey"] = target.get("uniqueKey")
                payload["layer"] = target
            actions.append(HeadlessAction(type="toggle_crop", input=payload))

        if any(token in text for token in ("split", "unpack", "divide")):
            payload = {}
            if target:
                payload["layerKey"] = target.get("uniqueKey")
                payload["layer"] = target
            actions.append(HeadlessAction(type="toggle_split", input=payload))

        if (not location_match or target) and any(token in text for token in ("zoom", "fit to view", "fly to", "center on")):
            payload = {}
            if target:
                payload["layerKey"] = target.get("uniqueKey")
                payload["layer"] = target
            actions.append(HeadlessAction(type="zoom_to_layer", input=payload))

        if not any(action.type in {"open_table", "toggle_edit", "toggle_crop", "toggle_split", "zoom_to_layer"} for action in actions):
            if any(token in text for token in ("select", "open", "activate")):
                payload = {"focus": "table" if "table" in text else "edit" if "edit" in text else "crop" if "crop" in text else "split" if "split" in text else "table"}
                if target:
                    payload["layerKey"] = target.get("uniqueKey")
                    payload["layer"] = target
                actions.append(HeadlessAction(type="select_layer", input=payload))

        if not nearby_search and any(token in text for token in ("show", "hide", "toggle visibility", "visibility")):
            visible = not any(token in text for token in ("hide", "off", "disable"))
            payload = {"visible": visible}
            if target:
                payload["layerKey"] = target.get("uniqueKey")
                payload["layer"] = target
            actions.append(HeadlessAction(type="set_visibility", input=payload))

        if not shape_match and any(token in text for token in ("style", "color", "opacity", "symbol", "fill", "outline")) and target:
            actions.append(HeadlessAction(type="apply_style", input={"layerKey": target.get("uniqueKey"), "layer": target, "style": {"type": "single"}}))

        if any(token in text for token in ("export workspace", "download workspace", "save workspace")):
            actions.append(HeadlessAction(type="export_workspace", input={}))
        elif any(token in text for token in ("export layer", "download layer", "save layer")) and target:
            actions.append(HeadlessAction(type="export_layer", input={"layerKey": target.get("uniqueKey"), "layer": target}))

        if not actions:
            actions.append(HeadlessAction(type="unsupported", input={"prompt": prompt}))

        return actions

    def _run_action(self, action: HeadlessAction) -> None:
        action.status = "running"
        action.updated_at = _utc_now()

        if action.type == "load_servers":
            action.output = self._load_servers()
        elif action.type == "unsupported":
            message = action.input.get("reason") or "I need a little more information before I can do that."
            action.output = {
                "message": message,
                "clarification": message,
            }
        elif action.type == "osm_search":
            action.output = self._run_osm_search(action.input)
        elif action.type == "discover_sources":
            action.output = discover_sources(action.input.get("query") or "", limit=action.input.get("limit", 10))
        elif action.type == "filter_layers":
            action.output = self._run_filter(action.input)
        elif action.type == "import_assets":
            action.output = self._run_import(action.input)
        elif action.type == "delete_layer":
            action.output = self._run_delete(action.input)
        elif action.type == "duplicate_layer":
            action.output = self._run_duplicate(action.input)
        elif action.type == "create_folder":
            action.output = self._run_create_folder(action.input)
        elif action.type == "move_to_folder":
            action.output = self._run_move_to_folder(action.input)
        elif action.type == "rename_layer":
            action.output = self._run_rename_layer(action.input)
        elif action.type == "select_layer":
            action.output = self._run_select_layer(action.input)
        elif action.type == "zoom_to_layer":
            action.output = self._run_zoom_to_layer(action.input)
        elif action.type == "zoom_to_location":
            action.output = self._run_zoom_to_location(action.input)
        elif action.type == "open_table":
            action.output = self._run_open_table(action.input)
        elif action.type == "toggle_edit":
            action.output = self._run_toggle_edit(action.input)
        elif action.type == "toggle_crop":
            action.output = self._run_toggle_crop(action.input)
        elif action.type == "toggle_split":
            action.output = self._run_toggle_split(action.input)
        elif action.type == "set_visibility":
            action.output = self._run_set_visibility(action.input)
        elif action.type == "search_layers":
            action.output = self._run_search_layers(action.input)
        elif action.type == "apply_style":
            action.output = self._run_apply_style(action.input)
        elif action.type == "export_layer":
            action.output = self._run_export_layer(action.input)
        elif action.type == "export_workspace":
            action.output = self._run_export_workspace(action.input)
        else:
            raise ValueError(f"Unsupported headless action: {action.type}")

        action.status = "completed"
        action.updated_at = _utc_now()

    def _load_servers(self) -> dict[str, Any]:
        try:
            servers = self._catalog_client.sources().get("sources") or []
        except Exception as exc:
            raise ValueError(f"Catalog service unavailable while loading saved sources: {exc}") from exc
        return {
            "servers": servers,
            "count": len(servers),
            "workspace_updates": [
                {
                    "op": "set_saved_servers",
                    "servers": servers,
                }
            ],
        }

    @staticmethod
    def _clean_place_text(value: str | None) -> str:
        """Remove sentence punctuation without altering a real place name."""
        return re.sub(r"[\s.!?;:]+$", "", str(value or "")).strip(" ,")

    @staticmethod
    def _area_id_from_nominatim(place: dict[str, Any] | None) -> int | None:
        if not isinstance(place, dict) or place.get("osm_type") not in {"relation", "way"}:
            return None
        try:
            base_id = 3600000000 if place.get("osm_type") == "relation" else 2400000000
            return base_id + int(place["osm_id"])
        except (KeyError, TypeError, ValueError):
            return None

    def _resolve_osm_area_context(self, location: str | None) -> dict[str, Any] | None:
        """Resolve a human location to one bounded OSM area or bbox.

        Nominatim is used only for place disambiguation. The returned area or
        bbox is subsequently used to constrain a direct Overpass query.
        """
        location = self._clean_place_text(location)
        if not location:
            return None
        try:
            candidates = self._nominatim_search(location, limit=10)
        except (requests.RequestException, ValueError, TypeError):
            return None
        wanted = _normalize_text(location.split(",", 1)[0])
        ranked: list[tuple[int, dict[str, Any]]] = []
        preferred_types = {"administrative", "city", "town", "municipality", "county", "state", "province", "suburb"}
        for candidate in candidates:
            if not isinstance(candidate, dict) or not self._nominatim_bbox(candidate):
                continue
            address = candidate.get("address") or {}
            haystack = _normalize_text(" ".join([
                str(candidate.get("name") or ""),
                str(candidate.get("display_name") or ""),
                *[str(value) for value in address.values()],
            ]))
            score = 0
            if wanted and _normalize_text(candidate.get("name") or "") == wanted:
                score += 20
            if wanted and wanted in haystack:
                score += 8
            if candidate.get("osm_type") == "relation":
                score += 5
            if candidate.get("class") == "boundary":
                score += 5
            if candidate.get("type") in preferred_types:
                score += 4
            score += int(float(candidate.get("importance") or 0) * 10)
            ranked.append((score, candidate))
        if not ranked:
            return None
        _, place = max(ranked, key=lambda item: item[0])
        return {
            "area_id": self._area_id_from_nominatim(place),
            "bbox": self._nominatim_bbox(place),
            "display_name": place.get("display_name") or location,
            "osm_type": place.get("osm_type"),
            "osm_id": place.get("osm_id"),
        }

    @staticmethod
    def _validate_osm_payload(payload: dict[str, Any]) -> None:
        if not isinstance(payload, dict):
            raise ValueError("OSM search payload must be an object")
        for tag in _payload_tags(payload.get("tags") or [{"key": "building", "val": ""}]):
            if not re.fullmatch(r"[A-Za-z0-9_:-]{1,64}", tag["key"]):
                raise ValueError("OSM tag keys may contain only letters, numbers, underscore, colon, and hyphen")
            if len(tag["val"]) > 128:
                raise ValueError("OSM tag values are limited to 128 characters")
        relation = str(payload.get("relation") or "").strip().lower()
        street = str(payload.get("street") or "").strip()
        near_place = str(payload.get("near_place") or payload.get("proximity_reference") or "").strip()
        if relation not in {"", "on", "along", "beside", "near", "within"}:
            raise ValueError(f"Unsupported spatial relation: {relation}")
        if street and relation not in {"", "on", "along", "beside"}:
            raise ValueError("A street reference must use the on, along, or beside relation")
        if relation in {"on", "along", "beside"} and not street:
            raise ValueError("A road-relative search requires a street name")
        if relation in {"near", "within"} and not near_place:
            raise ValueError("A proximity search requires a named reference")
        if street or near_place:
            try:
                distance_km = float(payload.get("distance_km"))
            except (TypeError, ValueError):
                distance_km = 0.0
            if not distance_km > 0:
                reference = street or near_place
                raise ValueError(f"How close should I search to {reference}? Please provide a distance, such as 25 m, 100 m, or 1 km.")
            if distance_km * 1000 > 25000:
                raise ValueError("Distance searches are limited to 25 km")
        geometry = payload.get("geomType") or "all"
        if geometry not in {"all", "points", "lines_polygons", "polygons"}:
            raise ValueError(f"Unsupported OSM geometry type: {geometry}")

    def _run_osm_search(self, payload: dict[str, Any]) -> dict[str, Any]:
        payload = dict(payload or {})
        # Accept the public contract's generic proximity_reference alias, but
        # normalize it before choosing the search strategy. Otherwise a direct
        # caller could accidentally turn a bounded proximity request into a
        # broad city query.
        if payload.get("proximity_reference") and not payload.get("street") and not payload.get("near_place"):
            if str(payload.get("relation") or "near").lower() in {"near", "within"}:
                payload["near_place"] = payload["proximity_reference"]
        if payload.get("loc"):
            payload["loc"] = self._clean_place_text(payload.get("loc"))
        if payload.get("street"):
            payload["street"] = self._clean_place_text(payload.get("street"))
        self._validate_osm_payload(payload)
        tags = _payload_tags(payload.get("tags") or [{"key": "building", "val": ""}])
        if not tags:
            raise ValueError("I couldn't identify what to search for. Try a phrase like 'parks near Burlington'.")
        proximity_reference = payload.get("street") or payload.get("near_place") or payload.get("proximity_reference")
        if proximity_reference:
            try:
                distance_km = float(payload.get("distance_km"))
            except (TypeError, ValueError):
                distance_km = 0.0
            if distance_km <= 0:
                raise ValueError(f"How close should I search to {proximity_reference}? Please provide a distance, such as 25 m, 100 m, or 1 km.")
        tag_sets = [tags]
        for alternative in payload.get("tagAlternatives") or []:
            candidate = _payload_tags(alternative)
            if candidate and candidate not in tag_sets:
                tag_sets.append(candidate)
        # A named-road request starts with the normal highway constraint, but
        # some OSM imports contain a named way without a highway tag. Retry by
        # exact name only before reporting an empty result. This is still
        # narrowly bounded to the requested way name.
        if payload.get("wayOnly") and payload.get("featName") and payload.get("exactName"):
            tag_sets.append([])
        bbox = payload.get("bbox")
        if not bbox:
            bbox = payload.get("mapBounds")
        if isinstance(bbox, dict):
            bbox = [bbox.get("south"), bbox.get("west"), bbox.get("north"), bbox.get("east")]
        if bbox:
            try:
                bbox = [float(value) for value in bbox]
            except (TypeError, ValueError):
                raise ValueError("bbox must contain numeric south, west, north, and east values")
            if len(bbox) != 4 or not (-90 <= bbox[0] <= bbox[2] <= 90 and -180 <= bbox[1] <= bbox[3] <= 180):
                raise ValueError("bbox must be [south, west, north, east] within valid coordinate ranges")
        # A named location is resolved by search_overpass through Nominatim.
        # Only generic OSM searches need an explicit map bounding box.
        if (not bbox or len(bbox) != 4) and not payload.get("loc"):
            raise ValueError("OSM headless search requires bbox or mapBounds")

        diagnostics: list[str] = []
        street_context: dict[str, Any] | None = None
        near_place_point: tuple[float, float] | None = None
        if payload.get("near_place") and not bbox and not payload.get("street"):
            place_query = f"{payload['near_place']}, {payload.get('loc') or ''}".strip(" ,")
            try:
                places = self._nominatim_search(place_query, limit=5)
            except (requests.RequestException, ValueError, TypeError):
                places = []
            place = next((candidate for candidate in places if candidate.get("lat") and candidate.get("lon")), None)
            if place:
                near_place_point = (float(place["lat"]), float(place["lon"]))
                margin = max(float(payload.get("distance_km") or 1.0), 0.05)
                center = [float(place["lat"]) - margin / 111.0, float(place["lon"]) - margin / 111.0, float(place["lat"]) + margin / 111.0, float(place["lon"]) + margin / 111.0]
                bbox = self._expand_bbox(center, 0)
                payload = {**payload, "loc": None, "bbox": bbox}
                diagnostics.append(f"Using a {margin:g} km search area around {place.get('display_name') or payload['near_place']}.")
            else:
                diagnostics.append(f"I couldn't locate {payload['near_place']} precisely; I will not search the entire location without a proximity anchor.")
        if payload.get("street"):
            street_context = self._resolve_osm_area_context(payload.get("loc"))
            if street_context:
                bounded_by = "the resolved administrative area" if street_context.get("area_id") else "the resolved location bounding box"
                diagnostics.append(f"Resolved {payload['street']} within {bounded_by}.")
            elif not bbox:
                diagnostics.append(f"I couldn't precisely locate {payload['street']}; I will not search the entire city without a bounded location.")
            else:
                diagnostics.append(f"I couldn't resolve {payload.get('loc') or 'the named location'}; I will use the supplied map bounds only.")

        # Place-outline requests must resolve the named place first and then
        # identify the containing administrative relation. A boundary name
        # frequently differs from the place name (for example, Smithville is
        # contained by West Lincoln Township), so do not fall through to a
        # broad name/tag search when resolution fails.
        boundary_request = bool(
            (payload.get("featName") or payload.get("requested_place") or payload.get("boundary_target"))
            and any(str(tag.get("key") or "").lower() == "boundary" for tag in tags)
        )
        if boundary_request:
            requested_place = str(payload.get("requested_place") or payload.get("featName") or payload.get("loc") or "").strip()
            requested_admin_level = str(payload.get("requested_admin_level") or next(
                (str(tag.get("val") or "") for tag in tags if str(tag.get("key") or "").lower() == "admin_level" and tag.get("val")),
                "8",
            )).strip()
            requested_region = payload.get("requested_region")
            if not isinstance(requested_region, dict):
                requested_region = resolve_region_context(payload.get("loc"))
            boundary_result = self._resolve_boundary_result(
                requested_place,
                payload.get("loc"),
                admin_level=requested_admin_level or None,
                boundary_choice=payload.get("boundary_choice"),
                requested_region=payload.get("requested_region"),
            )
            if boundary_result and boundary_result.get("ambiguous"):
                boundary_metadata = {
                    **(boundary_result.get("metadata") or {}),
                    "source": "OpenStreetMap",
                    "attribution": "© OpenStreetMap contributors",
                    "attribution_url": "https://www.openstreetmap.org/copyright",
                    "location": payload.get("loc"),
                    "feature_name": requested_place,
                    "admin_level": requested_admin_level,
                }
                return {
                    "feature_collection": {"type": "FeatureCollection", "features": [], "metadata": boundary_metadata},
                    "feature_count": 0,
                    "raw_element_count": 0,
                    "message": "Several containing administrative boundaries are equally plausible. Please choose one.",
                    "boundary_ambiguity": True,
                    "boundary_candidates": boundary_result.get("boundary_candidates") or [],
                    "search_diagnostics": ["Boundary resolution requires a boundary choice before geometry can be loaded."],
                    "metadata": boundary_metadata,
                    "workspace_updates": [],
                }
            boundary = boundary_result.get("feature_collection") if boundary_result else None
            if boundary:
                boundary_metadata = {
                    **(boundary_result.get("metadata") or {}),
                    "source": "OpenStreetMap",
                    "attribution": "© OpenStreetMap contributors",
                    "attribution_url": "https://www.openstreetmap.org/copyright",
                    "location": payload.get("loc"),
                    "feature_name": requested_place,
                    "admin_level": requested_admin_level,
                }
                boundary["metadata"] = boundary_metadata
                resolved_name = boundary_metadata.get("resolved_boundary_name") or requested_place
                return {
                    "feature_collection": boundary,
                    "feature_count": len(boundary.get("features") or []),
                    "raw_element_count": boundary_metadata.get("raw_element_count", 1),
                    "message": f"Resolved {requested_place} to {resolved_name}.",
                    "search_diagnostics": [f"Resolved {requested_place} to containing boundary {resolved_name}."],
                    "metadata": boundary_metadata,
                    "boundary_resolution": boundary_metadata,
                    "workspace_updates": [{
                        "op": "create_layer", "layerType": "osm",
                        "name": _layer_name("OSM Boundary", resolved_name),
                        "geojson": boundary, "metadata": boundary_metadata,
                    }],
                }
            boundary_metadata = {
                "source": "OpenStreetMap",
                "attribution": "© OpenStreetMap contributors",
                "attribution_url": "https://www.openstreetmap.org/copyright",
                "location": payload.get("loc"),
                "feature_name": requested_place,
                "admin_level": requested_admin_level,
                "requested_region": requested_region.get("name") if requested_region else None,
                "requested_region_code": requested_region.get("code") if requested_region else None,
                "strategy": "boundary_resolution_failed",
            }
            return {
                "feature_collection": {"type": "FeatureCollection", "features": [], "metadata": boundary_metadata},
                "feature_count": 0,
                "raw_element_count": 0,
                "message": f"I couldn't resolve a containing administrative boundary for {requested_place}.",
                "search_diagnostics": ["The bounded place and containing-boundary lookup failed; no broad fallback search was run."],
                "metadata": boundary_metadata,
                "workspace_updates": [],
            }

        raw_elements: list[dict[str, Any]] = []
        seen: set[str] = set()
        searched_bboxes: list[list[float]] = []
        search_tags = tags
        search_queries: list[str] = []
        if payload.get("street"):
            # Keep the road relation inside Overpass. The reference road is
            # the complete set of matching ways in the bounded location, not
            # a small sample of geocoder segments.
            context = street_context or ({"bbox": bbox} if bbox else None)
            if context and (context.get("area_id") or context.get("bbox")):
                if context.get("bbox"):
                    searched_bboxes.append(context["bbox"])
                distance_m = float(payload.get("distance_km") or 0) * 1000.0
                for candidate_tags in tag_sets:
                    if not candidate_tags:
                        continue
                    try:
                        raw = search_overpass_near_named_way(
                            tags=candidate_tags,
                            street_name=payload["street"],
                            distance_m=distance_m,
                            area_id=context.get("area_id"),
                            bbox=None if context.get("area_id") else context.get("bbox"),
                            geom_type=payload.get("geomType", "all"),
                            timeout_val=payload.get("timeout", 25),
                        )
                        query_text = raw.get("_query") if isinstance(raw, dict) else None
                        if isinstance(query_text, str) and query_text:
                            search_queries.append(query_text)
                        elements = raw.get("elements", []) if isinstance(raw, dict) and isinstance(raw.get("elements", []), list) else []
                    except Exception as exc:
                        diagnostics.append(f"The road-relative OSM search could not be completed: {exc}")
                        continue
                    for element in elements:
                        key = f"{element.get('type')}_{element.get('id')}"
                        if key not in seen:
                            seen.add(key)
                            raw_elements.append(element)
                    if elements:
                        search_tags = candidate_tags
                diagnostics.append(f"Matched {len(raw_elements)} feature(s) against the complete {payload['street']} road geometry within {float(payload.get('distance_km') or 0) * 1000:g} m.")
            else:
                diagnostics.append("No bounded location was available for the street-relative search; the city-wide fallback was blocked.")
        elif payload.get("near_place") and not near_place_point:
            diagnostics.append("The named proximity reference could not be resolved, so the broader location search was blocked.")
        else:
            for candidate_tags in tag_sets:
                try:
                    raw = search_overpass(tags=candidate_tags, feat_name=payload.get("featName"), loc=payload.get("loc"), geom_type=payload.get("geomType", "all"), bbox=bbox, timeout_val=payload.get("timeout", 25), max_chunks=payload.get("maxChunks", 16), include_geometry=True, exact_name=bool(payload.get("exactName")), way_only=bool(payload.get("wayOnly")), max_area_km2=payload.get("maxArea"))
                    raw_elements = raw.get("elements", []) if isinstance(raw, dict) and isinstance(raw.get("elements", []), list) else []
                    if near_place_point:
                        before_count = len(raw_elements)
                        raw_elements = self._filter_elements_within_distance(raw_elements, near_place_point[0], near_place_point[1], float(payload.get("distance_km") or 0))
                        diagnostics.append(f"Kept {len(raw_elements)} feature(s) within {float(payload.get('distance_km') or 0) * 1000:g} m of {payload.get('near_place')}.")
                        if before_count and not raw_elements:
                            diagnostics.append("The nearby search returned candidates, but all were outside the requested distance.")
                    if raw_elements:
                        search_tags = candidate_tags or tags
                        if not candidate_tags and tags:
                            diagnostics.append("The road was not returned with a highway tag, so I matched its exact name directly.")
                        break
                except Exception as exc:
                    diagnostics.append(f"The OSM service was unavailable: {exc}")

        query_hash = hashlib.sha256("\n".join(search_queries).encode("utf-8")).hexdigest() if search_queries else None
        osm_metadata = {
            "source": "OpenStreetMap",
            "attribution": "© OpenStreetMap contributors",
            "attribution_url": "https://www.openstreetmap.org/copyright",
            "location": payload.get("loc"),
            "feature_name": payload.get("featName"),
            "tags": search_tags,
            "relation": payload.get("relation"),
            "reference": payload.get("street") or payload.get("near_place"),
            "distance_m": float(payload.get("distance_km") or 0) * 1000.0 if proximity_reference else None,
            "strategy": "named_way_around" if payload.get("street") else "point_distance" if near_place_point else "bounded_area",
            "query_count": len(search_queries),
            "query_hash": query_hash,
            "search_diagnostics": diagnostics,
            "searched_bboxes": searched_bboxes,
        }
        if not raw_elements:
            diagnostics.append("No matching OSM features were found in the areas searched. Try a nearby city, a larger distance, or a different feature name.")
            return {
                "feature_collection": {"type": "FeatureCollection", "features": [], "metadata": osm_metadata},
                "feature_count": 0,
                "raw_element_count": 0,
                "message": "I couldn't find any matching features.",
                "search_diagnostics": diagnostics,
                "searched_bboxes": searched_bboxes,
                "metadata": osm_metadata,
                "workspace_updates": [],
            }
        osm_metadata["raw_element_count"] = len(raw_elements)
        geojson = normalize_overpass({"elements": raw_elements}, metadata=osm_metadata)
        return {
            "feature_collection": geojson,
            "feature_count": len(geojson.get("features", [])),
            "raw_element_count": len(raw_elements),
            "bbox": searched_bboxes[0] if searched_bboxes else bbox,
            "searched_bboxes": searched_bboxes,
            "message": f"Found {len(geojson.get('features', []))} matching feature(s).",
            "search_diagnostics": diagnostics,
            "metadata": osm_metadata,
            "workspace_updates": [
                {
                    "op": "create_layer",
                    "layerType": "osm",
                    "name": _layer_name("OSM Search", payload.get("featName") or payload.get("loc") or "Query"),
                    "geojson": geojson,
                    "metadata": osm_metadata,
                    "bbox": searched_bboxes[0] if searched_bboxes else bbox,
                    # Keep the original Overpass elements available to the
                    # browser's established osmtogeojson conversion path.
                    # The Python normalizer remains an API representation but
                    # must not be the geometry used for an imported layer.
                    "osm_elements": raw_elements,
                }
            ],
        }

    @staticmethod
    def _nominatim_bbox(place: dict[str, Any]) -> list[float] | None:
        bb = place.get("boundingbox") if isinstance(place, dict) else None
        try:
            if isinstance(bb, (list, tuple)) and len(bb) == 4:
                return [float(bb[0]), float(bb[2]), float(bb[1]), float(bb[3])]
        except (TypeError, ValueError):
            return None
        return None

    @staticmethod
    def _expand_bbox(bbox: list[float] | None, margin_km: float) -> list[float] | None:
        if not bbox or len(bbox) != 4:
            return None
        south, west, north, east = bbox
        margin_km = max(0.05, min(float(margin_km), 25.0))
        import math
        mid_lat = max(-89.0, min(89.0, (south + north) / 2))
        lat_delta = margin_km / 111.0
        lon_delta = margin_km / max(1.0, 111.0 * math.cos(math.radians(mid_lat)))
        return [max(-90.0, south - lat_delta), max(-180.0, west - lon_delta), min(90.0, north + lat_delta), min(180.0, east + lon_delta)]

    def _nominatim_search(self, query: str, *, limit: int = 5, polygon_geojson: bool = False) -> list[dict[str, Any]]:
        key = (query.strip().lower(), bool(polygon_geojson))
        if key in self._geocode_cache:
            return self._geocode_cache[key]
        with self._nominatim_lock:
            wait = 1.0 - (time.monotonic() - self._last_nominatim_request)
            if wait > 0:
                time.sleep(wait)
            params = {"q": query, "format": "jsonv2", "limit": limit, "addressdetails": 1}
            if polygon_geojson:
                params["polygon_geojson"] = 1
            response = requests.get("https://nominatim.openstreetmap.org/search", params=params, headers={"User-Agent": "GIS-Layer-Previewer/1.0 (GIS Layer Previewer; contact project maintainer)", "Referer": "http://localhost:5000/"}, timeout=10)
            self._last_nominatim_request = time.monotonic()
            response.raise_for_status()
            results = response.json() or []
            self._geocode_cache[key] = results
            return results

    def _rank_street_candidates(self, query: str, street_name: str, location: str | None) -> list[dict[str, Any]]:
        wanted_street = _normalize_text(street_name)
        wanted_location = _normalize_text(location or "")
        road_types = {"road", "residential", "tertiary", "secondary", "primary", "pedestrian", "living_street", "unclassified", "service", "trunk", "motorway", "footway", "path", "cycleway", "track"}
        queries = [query]
        if location and _normalize_text(query) != wanted_street:
            # A street-only retry can recover from a city/province spelling
            # issue, but candidates are still required to contain the exact
            # requested road name before they are accepted.
            queries.append(street_name)
        for candidate_query in queries:
            try:
                # Request the road line when available so an "on this street"
                # search can measure distance to the road, rather than using
                # the geocoder's rectangular bounding box as a substitute.
                try:
                    candidates = self._nominatim_search(candidate_query, limit=5, polygon_geojson=True)
                except TypeError:
                    # Preserve compatibility with test doubles and older adapters.
                    candidates = self._nominatim_search(candidate_query, limit=5)
            except (requests.RequestException, ValueError, TypeError):
                continue
            ranked = []
            for candidate in candidates:
                bbox = self._nominatim_bbox(candidate)
                if not bbox:
                    continue
                address = candidate.get("address") or {}
                haystack = _normalize_text(" ".join([str(candidate.get("display_name") or ""), *[str(v) for v in address.values()]]))
                # Nominatim may return the containing city or a broad place
                # when it cannot resolve the road. Do not accept that bbox as
                # the street geometry: it would make the later feature search
                # look like a successful city-wide query.
                if not wanted_street or wanted_street not in haystack:
                    continue
                if candidate.get("class") != "highway" and candidate.get("type") not in road_types:
                    continue
                score = 0
                score += 4
                score += 3
                if wanted_location and any(token in haystack for token in wanted_location.split() if len(token) > 2): score += 1
                ranked.append((score, candidate))
            if ranked:
                return [candidate for _, candidate in sorted(ranked, key=lambda item: item[0], reverse=True)]
        return []

    @staticmethod
    def _osm_element_geometry(element: dict[str, Any]):
        from shapely.geometry import GeometryCollection, LineString, Point

        if element.get("type") == "node" and element.get("lat") is not None and element.get("lon") is not None:
            return Point(float(element["lon"]), float(element["lat"]))
        center = element.get("center") or {}
        if center.get("lat") is not None and center.get("lon") is not None:
            return Point(float(center["lon"]), float(center["lat"]))
        geometry = element.get("geometry") or []
        points = [(float(point["lon"]), float(point["lat"])) for point in geometry if point.get("lat") is not None and point.get("lon") is not None]
        if len(points) >= 2:
            return LineString(points)
        member_geometries = []
        for member in element.get("members") or []:
            member_points = [(float(point["lon"]), float(point["lat"])) for point in (member.get("geometry") or []) if point.get("lat") is not None and point.get("lon") is not None]
            if len(member_points) >= 2:
                member_geometries.append(LineString(member_points))
        return GeometryCollection(member_geometries) if member_geometries else None

    @classmethod
    def _filter_elements_near_street(cls, elements: list[dict[str, Any]], street_candidates: list[dict[str, Any]], distance_km: float) -> list[dict[str, Any]]:
        """Keep OSM elements within the requested metric distance of a road."""
        from pyproj import Transformer
        from shapely.geometry import shape
        from shapely.ops import transform, unary_union

        road_geometries = []
        for candidate in street_candidates:
            geojson = candidate.get("geojson") if isinstance(candidate, dict) else None
            if not isinstance(geojson, dict):
                continue
            try:
                road_geometries.append(shape(geojson))
            except Exception:
                continue
        if not road_geometries:
            return []
        reference = unary_union([geometry for geometry in road_geometries if not geometry.is_empty])
        if reference.is_empty:
            return []
        centroid = reference.centroid
        # Web Mercator is for display, not metre-accurate local analysis. Use
        # the UTM zone containing the reference geometry so the requested
        # distance is evaluated in a locally appropriate metric CRS.
        zone = int((float(centroid.x) + 180.0) // 6.0) + 1
        zone = max(1, min(60, zone))
        metric_crs = f"EPSG:{32600 + zone if float(centroid.y) >= 0 else 32700 + zone}"
        to_metric = Transformer.from_crs("EPSG:4326", metric_crs, always_xy=True).transform
        metric_roads = [transform(to_metric, geometry) for geometry in road_geometries if not geometry.is_empty]
        if not metric_roads:
            return []
        threshold = float(distance_km) * 1000.0
        filtered = []
        for element in elements:
            try:
                geometry = cls._osm_element_geometry(element)
                if geometry is None:
                    continue
                metric_geometry = transform(to_metric, geometry)
                if min(metric_geometry.distance(road) for road in metric_roads) <= threshold:
                    filtered.append(element)
            except (TypeError, ValueError, KeyError):
                # Do not return an element whose distance cannot be measured;
                # an unmeasurable feature must not bypass the user's boundary.
                continue
        return filtered

    @classmethod
    def _filter_elements_within_distance(cls, elements: list[dict[str, Any]], latitude: float, longitude: float, distance_km: float) -> list[dict[str, Any]]:
        """Apply an exact local metric distance filter to raw OSM elements."""
        from pyproj import Transformer
        from shapely.geometry import Point
        from shapely.ops import transform

        if not elements or distance_km <= 0:
            return []
        zone = int((float(longitude) + 180.0) // 6.0) + 1
        zone = max(1, min(60, zone))
        metric_crs = f"EPSG:{32600 + zone if float(latitude) >= 0 else 32700 + zone}"
        to_metric = Transformer.from_crs("EPSG:4326", metric_crs, always_xy=True).transform
        target = transform(to_metric, Point(float(longitude), float(latitude)))
        threshold = float(distance_km) * 1000.0
        filtered = []
        for element in elements:
            try:
                geometry = cls._osm_element_geometry(element)
                if geometry is not None and transform(to_metric, geometry).distance(target) <= threshold:
                    filtered.append(element)
            except (TypeError, ValueError, KeyError):
                continue
        return filtered

    @staticmethod
    def _boundary_level(value: Any) -> str | None:
        if not isinstance(value, dict):
            return None
        tags = value.get("tags") or value.get("extratags") or {}
        level = tags.get("admin_level") if isinstance(tags, dict) else None
        return str(level).strip() if level is not None and str(level).strip() else None

    @staticmethod
    def _boundary_name(value: dict[str, Any]) -> str:
        tags = value.get("tags") or value.get("extratags") or {}
        if isinstance(tags, dict) and tags.get("name"):
            return str(tags["name"])
        return str(value.get("name") or value.get("display_name") or "").strip()

    @staticmethod
    def _boundary_coordinates(place: dict[str, Any]) -> tuple[float, float] | None:
        try:
            if place.get("lat") is not None and place.get("lon") is not None:
                return float(place["lat"]), float(place["lon"])
        except (TypeError, ValueError):
            return None
        return None

    @staticmethod
    def _boundary_region_evidence(candidate: dict[str, Any], requested_region: dict[str, Any]) -> str:
        """Return regional evidence for a Nominatim place candidate.

        ``match`` is required before a place can anchor ``is_in``.  ``unknown``
        is retained only for compatibility with older callers/test doubles that
        omit Nominatim address details.  ``conflict`` is always rejected: a
        named place in Indiana must never win a request explicitly scoped to
        Ontario merely because its name is an exact match.
        """
        address = candidate.get("address") if isinstance(candidate.get("address"), dict) else {}
        region_name = normalize_region_text(requested_region.get("name"))
        country_name = normalize_region_text(requested_region.get("country"))
        requested_code = normalize_region_text(requested_region.get("code"))
        address_values = [normalize_region_text(value) for value in address.values() if value]
        display = normalize_region_text(candidate.get("display_name") or "")
        address_text = " ".join(address_values)
        iso_values = {
            normalize_region_text(key): normalize_region_text(value)
            for key, value in address.items()
            if value
        }

        # ISO3166-2 fields are the most stable signal when Nominatim provides
        # them.  A different subdivision or country is a hard conflict.
        iso_region = next((value for key, value in iso_values.items() if "iso3166-2" in key and "lvl4" in key), "")
        if requested_code and iso_region:
            if iso_region == requested_code.lower():
                return "match"
            return "conflict"

        if requested_region.get("region_kind") == "unresolved":
            if region_name in address_values or region_name in display or region_name in address_text:
                return "match"
            if country_value := normalize_region_text(address.get("country") or address.get("country_name") or ""):
                return "conflict" if country_value != region_name else "match"
            return "unknown"

        country_value = normalize_region_text(address.get("country") or address.get("country_name") or "")
        if country_name and country_value and country_value != country_name:
            return "conflict"
        if region_name:
            subdivision_value = normalize_region_text(
                address.get("state")
                or address.get("province")
                or address.get("region")
                or address.get("state_district")
                or ""
            )
            if subdivision_value and subdivision_value != region_name:
                return "conflict"
            if region_name in address_values or region_name in display or region_name in address_text:
                return "match"

        # A geocoder bbox is a useful secondary signal for full-name region
        # requests.  Do not use it to override an explicit address conflict.
        region_bbox = requested_region.get("bbox")
        candidate_bbox = HeadlessSessionStore._nominatim_bbox(candidate)
        if region_bbox and candidate_bbox:
            if bbox_intersects(region_bbox, candidate_bbox):
                return "match"
            return "conflict"
        return "unknown"

    def _boundary_place_anchor(
        self,
        candidates: list[dict[str, Any]],
        feature_name: str,
        requested_region: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        """Choose the named place used as the point for ``is_in``."""
        wanted = _normalize_text(feature_name)
        place_types = {"city", "town", "village", "hamlet", "suburb", "neighbourhood", "quarter", "locality"}
        ranked: list[tuple[int, float, dict[str, Any]]] = []
        regional: list[dict[str, Any]] = []
        unknown: list[dict[str, Any]] = []
        conflict_seen = False
        for candidate in candidates:
            if not isinstance(candidate, dict) or not self._boundary_coordinates(candidate):
                continue
            if requested_region:
                evidence = self._boundary_region_evidence(candidate, requested_region)
                if evidence == "conflict":
                    conflict_seen = True
                    continue
                if evidence == "match":
                    regional.append(candidate)
                else:
                    unknown.append(candidate)
            name = _normalize_text(candidate.get("name") or "")
            display = _normalize_text(candidate.get("display_name") or "")
            score = 0
            if name == wanted:
                score += 100
            elif wanted and wanted in display:
                score += 25
            if candidate.get("class") == "place":
                score += 30
            if candidate.get("type") in place_types:
                score += 25
            if candidate.get("class") == "boundary":
                score -= 15
            try:
                importance = float(candidate.get("importance") or 0)
            except (TypeError, ValueError):
                importance = 0.0
            ranked.append((score, importance, candidate))
        if requested_region:
            # Prefer candidates proven to be inside the requested region. Only
            # use address-less legacy/test candidates when the geocoder gave us
            # no positive regional candidate at all; a candidate explicitly
            # identified as another region was already removed above.
            allowed_candidates = regional if regional else ([] if conflict_seen else unknown)
            allowed = set(id(item) for item in allowed_candidates)
            ranked = [item for item in ranked if id(item[2]) in allowed]
        if not ranked:
            return None
        return max(ranked, key=lambda item: (item[0], item[1]))[2]

    @staticmethod
    def _boundary_candidate_score(
        candidate: dict[str, Any],
        *,
        requested_level: str | None,
        choice: str | None = None,
        context_names: list[str] | None = None,
    ) -> tuple[int, float]:
        tags = candidate.get("tags") or {}
        if not isinstance(tags, dict):
            tags = {}
        name = _normalize_text(tags.get("name") or candidate.get("name") or "")
        candidate_id = str(candidate.get("id") or "")
        score = 0
        if tags.get("boundary") == "administrative":
            score += 20
        level = str(tags.get("admin_level") or "")
        if requested_level and level == str(requested_level):
            score += 100
        normalized_context = {_normalize_text(str(value)) for value in (context_names or []) if _normalize_text(str(value))}
        if name and name in normalized_context:
            score += 25
        if choice:
            normalized_choice = _normalize_text(choice)
            choice_id = re.sub(r"^relation\s+", "", normalized_choice)
            if choice_id == candidate_id or normalized_choice == name:
                score += 1000
            elif normalized_choice and normalized_choice in name:
                score += 250
        try:
            importance = float(candidate.get("importance") or 0)
        except (TypeError, ValueError):
            importance = 0.0
        return score, importance

    @staticmethod
    def _boundary_feature_properties(
        properties: dict[str, Any],
        *,
        requested_place: str,
        resolved_name: str,
        resolved_type: str | None,
        resolved_id: Any,
        admin_level: str | None,
    ) -> dict[str, Any]:
        return {
            **properties,
            "name": properties.get("name") or resolved_name,
            "requested_place": requested_place,
            "resolved_boundary_name": resolved_name,
            "resolved_boundary_osm_type": resolved_type,
            "resolved_boundary_osm_id": resolved_id,
            "resolved_admin_level": admin_level,
        }

    def _resolve_boundary_result(
        self,
        feature_name: str,
        location: str | None,
        *,
        admin_level: str | None = None,
        boundary_choice: str | None = None,
        requested_region: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        """Resolve a requested place to a containing administrative boundary."""
        requested_place = feature_name.strip() or location or "requested place"
        if not isinstance(requested_region, dict):
            requested_region = resolve_region_context(location)
        geocoder_query = location or feature_name
        if requested_region and feature_name.strip() and normalize_region_text(requested_region.get("name")) not in normalize_region_text(feature_name):
            geocoder_query = f"{feature_name}, {requested_region['name']}, {requested_region.get('country') or ''}".strip(" ,")
        candidates: list[dict[str, Any]] = []
        try:
            # Querying with the canonical qualifier gives Nominatim a better
            # chance to return the intended namesake. The candidate gate below
            # remains authoritative because geocoders can still return loose
            # matches.
            try:
                candidates = self._nominatim_search(geocoder_query, limit=10, polygon_geojson=True)
            except TypeError:
                candidates = self._nominatim_search(geocoder_query, limit=10)
        except (requests.RequestException, ValueError, TypeError):
            candidates = []
        if not isinstance(candidates, list):
            candidates = []
        anchor = self._boundary_place_anchor(candidates, requested_place, requested_region)
        target_level = str(admin_level).strip() if admin_level else "8"

        def nominatim_fallback(confidence: float) -> dict[str, Any] | None:
            fallback_candidates = []
            wanted = _normalize_text(requested_place)
            regional_fallbacks = []
            fallback_conflict_seen = False
            for place in candidates:
                geometry = place.get("geojson") if isinstance(place, dict) else None
                if not isinstance(geometry, dict) or geometry.get("type") not in {"Polygon", "MultiPolygon"}:
                    continue
                if requested_region:
                    evidence = self._boundary_region_evidence(place, requested_region)
                    if evidence == "conflict":
                        fallback_conflict_seen = True
                        continue
                name = _normalize_text(place.get("name") or "")
                tags = place.get("extratags") or {}
                score = 0
                if name == wanted:
                    score += 100
                if str(tags.get("admin_level") or "") == target_level:
                    score += 50
                if place.get("class") == "boundary":
                    score += 20
                item = (score, place)
                fallback_candidates.append(item)
                if requested_region and self._boundary_region_evidence(place, requested_region) == "match":
                    regional_fallbacks.append(item)
            if regional_fallbacks:
                fallback_candidates = regional_fallbacks
            elif requested_region and fallback_conflict_seen:
                fallback_candidates = []
            if not fallback_candidates:
                return None
            _, place = max(fallback_candidates, key=lambda item: item[0])
            geometry = place.get("geojson")
            resolved_name = place.get("display_name") or requested_place
            metadata = {
                "source": "OpenStreetMap",
                "strategy": "nominatim_place_geometry",
                "requested_place": requested_place,
                "resolved_boundary_name": resolved_name,
                "resolved_boundary_osm_type": place.get("osm_type"),
                "resolved_boundary_osm_id": place.get("osm_id"),
                "resolved_admin_level": str((place.get("extratags") or {}).get("admin_level") or target_level),
                "requested_region": requested_region.get("name") if requested_region else None,
                "requested_region_code": requested_region.get("code") if requested_region else None,
                "boundary_resolution_confidence": confidence,
                "feature_count": 1,
                "geometry_types": [geometry.get("type")],
            }
            feature = {
                "type": "Feature",
                "geometry": geometry,
                "properties": self._boundary_feature_properties(
                    dict(place.get("extratags") or {}),
                    requested_place=requested_place,
                    resolved_name=resolved_name,
                    resolved_type=place.get("osm_type"),
                    resolved_id=place.get("osm_id"),
                    admin_level=metadata["resolved_admin_level"],
                ),
            }
            collection = {"type": "FeatureCollection", "features": [feature], "metadata": metadata}
            return {"feature_collection": collection, "metadata": metadata}

        # A precise named boundary with no usable point is still a valid
        # compatibility fallback, and avoids a network call for legacy callers
        # that already supplied a complete Nominatim polygon.
        if not anchor:
            return nominatim_fallback(0.75)

        coordinates = self._boundary_coordinates(anchor)
        if not coordinates:
            return None
        try:
            response = search_overpass_containing_boundaries(coordinates[0], coordinates[1], admin_level=target_level)
            relation_candidates = [item for item in response.get("elements") or [] if isinstance(item, dict) and item.get("type") == "relation"]
        except Exception:
            relation_candidates = []

        # If the default municipal level is absent, consider other containing
        # administrative levels but never silently choose a province or country
        # in place of a requested municipality.
        if not relation_candidates and not admin_level:
            try:
                response = search_overpass_containing_boundaries(coordinates[0], coordinates[1], admin_level=None)
                relation_candidates = [item for item in response.get("elements") or [] if isinstance(item, dict) and item.get("type") == "relation"]
            except Exception:
                relation_candidates = []

        if not relation_candidates:
            # The exact Nominatim polygon is the documented fallback when
            # Overpass cannot provide a containing relation.
            return nominatim_fallback(0.7)

        ranked = sorted(
            relation_candidates,
            key=lambda item: self._boundary_candidate_score(
                item,
                requested_level=target_level,
                choice=boundary_choice,
                context_names=list((anchor.get("address") or {}).values()),
            ),
            reverse=True,
        )
        context_names = list((anchor.get("address") or {}).values())
        top_score = self._boundary_candidate_score(
            ranked[0], requested_level=target_level, choice=boundary_choice, context_names=context_names
        )
        tied = [
            item for item in ranked
            if self._boundary_candidate_score(
                item, requested_level=target_level, choice=boundary_choice, context_names=context_names
            ) == top_score
        ]
        normalized_choice = _normalize_text(boundary_choice or "")
        choice_id = re.sub(r"^relation\s+", "", normalized_choice)
        choice_matches = not normalized_choice or any(
            choice_id == str(item.get("id") or "")
            or normalized_choice == _normalize_text(self._boundary_name(item))
            or normalized_choice in _normalize_text(self._boundary_name(item))
            for item in relation_candidates
        )
        if (len(tied) > 1 and not boundary_choice) or (boundary_choice and not choice_matches):
            options = [
                {
                    "id": item.get("id"),
                    "name": self._boundary_name(item) or f"relation {item.get('id')}",
                    "admin_level": self._boundary_level(item),
                }
                for item in tied[:10]
            ]
            return {
                "ambiguous": True,
                "boundary_candidates": options,
                "metadata": {
                    "source": "OpenStreetMap",
                    "strategy": "containing_boundary_ambiguous",
                    "requested_place": requested_place,
                    "resolved_admin_level": target_level,
                    "requested_region": requested_region.get("name") if requested_region else None,
                    "requested_region_code": requested_region.get("code") if requested_region else None,
                    "boundary_candidates": options,
                },
            }

        selected = ranked[0]
        relation_id = selected.get("id")
        if not relation_id:
            return None
        try:
            exact = search_overpass_element("relation", relation_id)
            relation = next((item for item in exact.get("elements") or [] if item.get("type") == "relation"), None)
            if not relation:
                return None
            resolved_name = self._boundary_name(relation) or self._boundary_name(selected) or requested_place
            resolved_level = self._boundary_level(relation) or self._boundary_level(selected) or target_level
            metadata = {
                "source": "OpenStreetMap",
                "attribution": "© OpenStreetMap contributors",
                "attribution_url": "https://www.openstreetmap.org/copyright",
                "strategy": "containing_boundary_exact_relation",
                "requested_place": requested_place,
                "resolved_boundary_name": resolved_name,
                "resolved_boundary_osm_type": "relation",
                "resolved_boundary_osm_id": relation_id,
                "resolved_admin_level": resolved_level,
                "requested_region": requested_region.get("name") if requested_region else None,
                "requested_region_code": requested_region.get("code") if requested_region else None,
                "boundary_resolution_confidence": 0.95 if resolved_level == target_level else 0.8,
                "anchor_display_name": anchor.get("display_name") or requested_place,
                "anchor_latitude": coordinates[0],
                "anchor_longitude": coordinates[1],
            }
            geojson = normalize_overpass({"elements": [relation]}, metadata=metadata)
            for feature in geojson.get("features") or []:
                feature["properties"] = self._boundary_feature_properties(
                    feature.get("properties") or {},
                    requested_place=requested_place,
                    resolved_name=resolved_name,
                    resolved_type="relation",
                    resolved_id=relation_id,
                    admin_level=resolved_level,
                )
            metadata.update(geojson.get("metadata") or {})
            geojson["metadata"] = metadata
            return {"feature_collection": geojson, "metadata": metadata}
        except Exception:
            # An exact relation lookup can fail independently of the point
            # lookup. Preserve the bounded Nominatim polygon fallback rather
            # than turning the request into a broad name search.
            return nominatim_fallback(0.65)

    def _resolve_boundary_geometry(
        self,
        feature_name: str,
        location: str | None,
        *,
        admin_level: str | None = None,
    ) -> dict[str, Any] | None:
        """Compatibility wrapper returning only the resolved GeoJSON."""
        result = self._resolve_boundary_result(feature_name, location, admin_level=admin_level)
        return result.get("feature_collection") if result and result.get("feature_collection") else None

    def _run_filter(self, payload: dict[str, Any]) -> dict[str, Any]:
        source = payload.get("source") or {}
        features = source.get("features") or []
        if not isinstance(features, list):
            raise ValueError("filter_layers requires source.features")
        criteria = payload.get("criteria") or {}
        if criteria.get("operation") or criteria.get("mode") in {"attribute", "bbox", "radius", "dwithin", "intersects", "within", "contains", "touches", "overlaps", "area", "length", "buffer", "join", "sjoin", "spatial_join"}:
            spatial_result = spatial_operate(source, criteria)
            output_geojson = spatial_result["feature_collection"]
            return spatial_result | {"workspace_updates": [{"op": "create_layer", "layerType": "filtered", "name": _layer_name("Filtered Layer", payload.get("name") or ""), "geojson": output_geojson}]}
        filtered = _filter_features(features, criteria)
        return {
            "feature_collection": {"type": "FeatureCollection", "features": filtered},
            "feature_count": len(filtered),
            "workspace_updates": [
                {
                    "op": "create_layer",
                    "layerType": "filtered",
                    "name": _layer_name("Filtered Layer", payload.get("name") or ""),
                    "geojson": {"type": "FeatureCollection", "features": filtered},
                }
            ],
        }

    def _run_import(self, payload: dict[str, Any]) -> dict[str, Any]:
        geojson = payload.get("geojson")
        if isinstance(geojson, str):
            geojson = json.loads(geojson)
        if not isinstance(geojson, dict):
            raise ValueError("import_assets requires a geojson payload")

        features = geojson.get("features") or []
        if not isinstance(features, list):
            raise ValueError("import_assets requires geojson.features to be a list")

        return {
            "feature_collection": geojson,
            "feature_count": len(features),
            "bbox": _geojson_bbox(geojson),
            "name": payload.get("name") or "Imported Layer",
            "workspace_updates": [
                {
                    "op": "create_layer",
                    "layerType": "imported",
                    "name": payload.get("name") or "Imported Layer",
                    "geojson": geojson,
                }
            ],
        }

    def _run_delete(self, payload: dict[str, Any]) -> dict[str, Any]:
        target = payload.get("layer") or {}
        key = target.get("uniqueKey") or payload.get("layerKey")
        if not key:
            raise ValueError("delete_layer requires layerKey or layer.uniqueKey")
        return {
            "deleted": True,
            "workspace_updates": [
                {
                    "op": "delete_layer",
                    "layerKey": key,
                }
            ],
        }

    def _run_duplicate(self, payload: dict[str, Any]) -> dict[str, Any]:
        layer = payload.get("layer") or {}
        if not isinstance(layer, dict):
            raise ValueError("duplicate_layer requires layer payload")
        key = layer.get("uniqueKey") or payload.get("layerKey")
        if not key:
            raise ValueError("duplicate_layer requires layerKey or layer.uniqueKey")

        copied = copy.deepcopy(layer)
        copied["uniqueKey"] = str(uuid.uuid4())
        copied["displayName"] = f"{copied.get('displayName', 'Layer')} (Copy)"
        copied["parentId"] = payload.get("parentId", copied.get("parentId"))
        copied["isVisible"] = layer.get("isVisible", True)
        return {
            "duplicated": True,
            "workspace_updates": [
                {
                    "op": "create_layer_copy",
                    "layer": copied,
                }
            ],
        }

    def _run_create_folder(self, payload: dict[str, Any]) -> dict[str, Any]:
        name = (payload.get("name") or payload.get("label") or "New Folder").strip()
        return {
            "created": True,
            "workspace_updates": [
                {
                    "op": "create_folder",
                    "name": name,
                }
            ],
        }

    def _run_move_to_folder(self, payload: dict[str, Any]) -> dict[str, Any]:
        layer_key = payload.get("layerKey") or (payload.get("layer") or {}).get("uniqueKey")
        parent_id = payload.get("parentId")
        if not layer_key:
            raise ValueError("move_to_folder requires layerKey or layer.uniqueKey")
        return {
            "moved": True,
            "workspace_updates": [
                {
                    "op": "move_to_folder",
                    "layerKey": layer_key,
                    "parentId": parent_id,
                }
            ],
        }

    def _run_rename_layer(self, payload: dict[str, Any]) -> dict[str, Any]:
        layer_key = payload.get("layerKey") or (payload.get("layer") or {}).get("uniqueKey")
        name = (payload.get("name") or payload.get("label") or "").strip()
        if not layer_key:
            raise ValueError("rename_layer requires layerKey or layer.uniqueKey")
        if not name:
            raise ValueError("rename_layer requires a name")
        return {
            "renamed": True,
            "workspace_updates": [
                {
                    "op": "rename_layer",
                    "layerKey": layer_key,
                    "name": name,
                }
            ],
        }

    def _run_select_layer(self, payload: dict[str, Any]) -> dict[str, Any]:
        layer_key = payload.get("layerKey") or (payload.get("layer") or {}).get("uniqueKey")
        focus = (payload.get("focus") or payload.get("mode") or "table").strip()
        if not layer_key:
            raise ValueError("select_layer requires layerKey or layer.uniqueKey")
        return {
            "selected": True,
            "workspace_updates": [
                {
                    "op": "select_layer",
                    "layerKey": layer_key,
                    "focus": focus,
                }
            ],
        }

    def _run_zoom_to_layer(self, payload: dict[str, Any]) -> dict[str, Any]:
        layer_key = payload.get("layerKey") or (payload.get("layer") or {}).get("uniqueKey")
        if not layer_key:
            raise ValueError("zoom_to_layer requires layerKey or layer.uniqueKey")
        return {
            "zoomed": True,
            "workspace_updates": [
                {
                    "op": "zoom_to_layer",
                    "layerKey": layer_key,
                }
            ],
        }

    def _run_zoom_to_location(self, payload: dict[str, Any]) -> dict[str, Any]:
        location = str(payload.get("location") or "").strip()
        if not location:
            raise ValueError("zoom_to_location requires a location")
        places = self._nominatim_search(location, limit=1)
        if not places:
            raise ValueError(f"Could not find {location}")
        place = places[0]
        output = {"location": location, "display_name": place.get("display_name"), "lat": float(place["lat"]), "lon": float(place["lon"])}
        if place.get("boundingbox"):
            output["boundingbox"] = [float(value) for value in place["boundingbox"]]
        return {"located": True, "location": output}

    def _run_open_table(self, payload: dict[str, Any]) -> dict[str, Any]:
        layer_key = payload.get("layerKey") or (payload.get("layer") or {}).get("uniqueKey")
        if not layer_key:
            raise ValueError("open_table requires layerKey or layer.uniqueKey")
        return {
            "opened": True,
            "workspace_updates": [
                {
                    "op": "open_table",
                    "layerKey": layer_key,
                }
            ],
        }

    def _run_toggle_edit(self, payload: dict[str, Any]) -> dict[str, Any]:
        layer_key = payload.get("layerKey") or (payload.get("layer") or {}).get("uniqueKey")
        if not layer_key:
            raise ValueError("toggle_edit requires layerKey or layer.uniqueKey")
        return {"workspace_updates": [{"op": "toggle_edit", "layerKey": layer_key}]}

    def _run_toggle_crop(self, payload: dict[str, Any]) -> dict[str, Any]:
        layer_key = payload.get("layerKey") or (payload.get("layer") or {}).get("uniqueKey")
        if not layer_key:
            raise ValueError("toggle_crop requires layerKey or layer.uniqueKey")
        return {"workspace_updates": [{"op": "toggle_crop", "layerKey": layer_key}]}

    def _run_toggle_split(self, payload: dict[str, Any]) -> dict[str, Any]:
        layer_key = payload.get("layerKey") or (payload.get("layer") or {}).get("uniqueKey")
        if not layer_key:
            raise ValueError("toggle_split requires layerKey or layer.uniqueKey")
        return {"workspace_updates": [{"op": "toggle_split", "layerKey": layer_key}]}

    def _run_set_visibility(self, payload: dict[str, Any]) -> dict[str, Any]:
        layer_key = payload.get("layerKey") or (payload.get("layer") or {}).get("uniqueKey")
        if not layer_key:
            raise ValueError("set_visibility requires layerKey or layer.uniqueKey")
        visible = payload.get("visible")
        if visible is None:
            visible = True
        return {
            "visibility_changed": True,
            "workspace_updates": [
                {
                    "op": "set_visibility",
                    "layerKey": layer_key,
                    "visible": bool(visible),
                }
            ],
        }

    def _guided_discover_sources(self, query: str, *, limit: int = 8) -> dict[str, Any]:
        """Bounded web discovery adapter used by the search-only assistant."""
        return discover_sources(query, limit=limit)

    @staticmethod
    def _utc_now_for_assistant() -> str:
        return _utc_now()

    def assistant_turn(self, data: dict[str, Any]) -> dict[str, Any]:
        """Run the stateful guided assistant without changing legacy actions."""
        from services.guided_assistant import guided_assistant_turn
        return guided_assistant_turn(self, data)

    def _run_search_layers(self, payload: dict[str, Any]) -> dict[str, Any]:
        source = (payload.get("source") or "catalog").lower()
        url = (payload.get("url") or "").strip()
        if source != "catalog":
            raise ValueError("search_layers supports catalog search only")
        query = str(payload.get("query") or "").strip()
        if not url and query:
            try:
                limit = max(1, min(int(payload.get("limit", 10)), 50))
            except (TypeError, ValueError):
                limit = 10
            bbox = payload.get("bbox") or payload.get("mapBounds")
            if isinstance(bbox, dict):
                bbox = [bbox.get("south"), bbox.get("west"), bbox.get("north"), bbox.get("east")]
            result = self._catalog_client.search(
                query,
                region=payload.get("region"),
                bbox=bbox,
                limit=limit,
                protocol=payload.get("protocol"),
                provider=payload.get("provider"),
                theme=payload.get("theme"),
            )
            result.setdefault("catalog_warnings", result.get("warnings") or [])
            result.setdefault("catalog_stats", {
                "candidate_count": result.get("candidate_count", 0),
                "eligible_count": result.get("eligible_count", result.get("count", 0)),
                "rejected_outside_count": result.get("rejected_outside_count", 0),
                "unknown_coverage_count": result.get("unknown_coverage_count", 0),
            })
            return result
        if not url:
            return {"sources": [], "layers": [], "workspace_updates": []}
        if "ckan" in url.lower():
            return search_ckan_portal(url)
        return search_esri_portal(url)

    def _run_apply_style(self, payload: dict[str, Any]) -> dict[str, Any]:
        layer_key = payload.get("layerKey") or (payload.get("layer") or {}).get("uniqueKey")
        style = payload.get("style") or {}
        if not layer_key:
            raise ValueError("apply_style requires layerKey or layer.uniqueKey")
        if not isinstance(style, dict):
            raise ValueError("apply_style requires a style object")
        return {"styled": True, "workspace_updates": [{"op": "apply_style", "layerKey": layer_key, "style": style}]}

    def _run_export_layer(self, payload: dict[str, Any]) -> dict[str, Any]:
        layer_key = payload.get("layerKey") or (payload.get("layer") or {}).get("uniqueKey")
        if not layer_key:
            raise ValueError("export_layer requires layerKey or layer.uniqueKey")
        return {"exported": True, "workspace_updates": [{"op": "export_layer", "layerKey": layer_key}]}

    def _run_export_workspace(self, payload: dict[str, Any]) -> dict[str, Any]:
        return {"exported": True, "workspace_updates": [{"op": "export_workspace", "workspace": payload.get("workspace") or {}}]}

    def _local_plan_is_sufficient(self, prompt: str, actions: list[HeadlessAction], mode: str) -> bool:
        if not actions or any(action.type == "unsupported" for action in actions):
            return False
        # Explicit modes are user choices. They should never unexpectedly
        # send the request to a hosted service.
        if mode in {"local", "fast", "location", "osm", "gis_server", "online"}:
            return True
        osm_actions = [action for action in actions if action.type == "osm_search"]
        if not osm_actions:
            return True
        intent = self.classify_intent(prompt, allow_remote=False)
        return intent.source == "osm" and intent.confidence >= 0.78 and all(
            action.input.get("tags") or action.input.get("featName") for action in osm_actions
        )

    def _plan_for_prompt(
        self,
        prompt: str,
        workspace: dict[str, Any] | None = None,
        mode: str = "auto",
        conversation: list[dict[str, Any]] | None = None,
    ) -> tuple[list[HeadlessAction], dict[str, Any]]:
        self._refresh_llm_settings()
        local = self._plan(prompt, workspace=workspace, mode=mode, conversation=conversation)
        if self._local_plan_is_sufficient(prompt, local, mode):
            info = {"mode": "local", "hosted_attempted": False, "model": None, "reason": "recognized by the local deterministic planner"}
            self._last_planner_info = info
            return local, info
        if mode in {"local", "fast", "location", "osm", "gis_server", "online"} or not self._openai_api_key:
            clarification = "Please tell me what kind of map feature you want and where to look." if any(action.type == "unsupported" for action in local) else None
            info = {
                "mode": "local-no-key" if not self._openai_api_key else "local",
                "hosted_attempted": False,
                "model": None,
                "reason": "local planner could not resolve the request" if self._openai_api_key else "no OPENAI_API_KEY configured",
                "clarification": clarification,
            }
            self._last_planner_info = info
            return local, info
        hosted, info = self._plan_with_llm_result(prompt, workspace=workspace, conversation=conversation)
        if hosted or info.get("clarification"):
            self._last_planner_info = info
            return hosted, info
        fallback = dict(info)
        fallback["mode"] = "hosted-fallback-local"
        fallback["reason"] = f"{info.get('reason', 'hosted planner unavailable')}; local plan retained"
        if any(action.type == "unsupported" for action in local):
            fallback["clarification"] = "Please tell me what kind of map feature you want and where to look."
        self._last_planner_info = fallback
        return local, fallback

    def plan_prompt(self, prompt: str, workspace: dict[str, Any] | None = None, mode: str = 'auto', conversation: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
        planned, _info = self._plan_for_prompt(prompt, workspace=workspace, mode=mode, conversation=conversation)
        # Location navigation and layer navigation are different intents. Keep
        # an LLM suggestion from reintroducing a target-less layer action.
        location_match = re.search(r"\b(?:zoom|move|fly|go)\s+(?:in\s+)?(?:to|on)\s+(.+?)\s*$", prompt, re.I)
        explicit_layer = any(_normalize_text(layer.get("displayName") or "") in _normalize_text(prompt) for layer in (workspace or {}).get("activeLayers", []) if layer.get("displayName"))
        if location_match and not explicit_layer:
            location = location_match.group(1).strip()
            planned = [action for action in planned if action.type != "zoom_to_layer"]
            if not any(action.type == "zoom_to_location" for action in planned):
                planned.insert(0, HeadlessAction(type="zoom_to_location", input={"location": location}))
        return [action.to_dict() for action in planned]

    def plan_prompt_and_maybe_llm(self, prompt: str) -> list[dict[str, Any]]:
        return self.plan_prompt(prompt)

    @staticmethod
    def _proximity_clarification(actions: list[dict[str, Any]]) -> str | None:
        for action in actions:
            if action.get("type") != "osm_search":
                continue
            payload = action.get("input") or {}
            reference = payload.get("street") or payload.get("near_place") or payload.get("proximity_reference")
            if not reference:
                continue
            try:
                distance_km = float(payload.get("distance_km"))
            except (TypeError, ValueError):
                distance_km = 0.0
            if distance_km <= 0:
                return f"How close should I search to {reference}? Please provide a distance, such as 25 m, 100 m, or 1 km."
        return None

    def summarize_plan(self, prompt: str, workspace: dict[str, Any] | None = None, mode: str = 'auto', conversation: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        actions = self.plan_prompt(prompt, workspace=workspace, mode=mode, conversation=conversation)
        planner_info = dict(self._last_planner_info)
        summary: list[str] = []
        target_hints: list[dict[str, Any]] = []
        for action in actions:
            action_type = action.get("type")
            payload = action.get("input") or {}
            target_layer = payload.get("layer") or {}
            target_name = target_layer.get("displayName") or payload.get("layerKey") or "layer"
            if target_layer:
                target_hints.append({
                    "type": action_type,
                    "name": target_layer.get("displayName") or payload.get("layerKey"),
                    "key": target_layer.get("uniqueKey") or payload.get("layerKey"),
                    "folder": bool(target_layer.get("isFolder")),
                    "reason": "resolved from workspace snapshot",
                })
            if action_type == "move_to_folder":
                folder_label = payload.get("parentId") or "closest folder"
                summary.append(f"move {target_name} to {folder_label}")
            elif action_type == "rename_layer":
                summary.append(f"rename {target_name} to {payload.get('name', 'new name')}")
            elif action_type == "select_layer":
                summary.append(f"open {payload.get('focus', 'table')} for {target_name}")
            elif action_type == "zoom_to_layer":
                summary.append(f"zoom to {target_name}")
            elif action_type == "zoom_to_location":
                summary.append(f"find and zoom to {payload.get('location', 'the requested location')}")
            elif action_type == "open_table":
                summary.append(f"open table for {target_name}")
            elif action_type == "toggle_edit":
                summary.append(f"open edit panel for {target_name}")
            elif action_type == "toggle_crop":
                summary.append(f"open crop panel for {target_name}")
            elif action_type == "toggle_split":
                summary.append(f"open split panel for {target_name}")
            elif action_type == "set_visibility":
                summary.append(f"{'show' if payload.get('visible', True) else 'hide'} {target_name}")
            elif action_type == "apply_style":
                summary.append(f"apply style to {target_name}")
            elif action_type == "export_layer":
                summary.append(f"export {target_name}")
            elif action_type == "export_workspace":
                summary.append("export workspace")
            elif action_type == "search_layers":
                summary.append("search catalogs")
            else:
                summary.append(action_type or "unsupported")
        why = []
        if workspace and workspace.get("activeCropLayerKey"):
            why.append("active crop layer takes priority")
        if any(tok in _normalize_text(prompt) for tok in ("duplicate", "copy", "clone", "delete", "remove", "move", "rename", "select", "show", "hide")):
            why.append("prompt contains explicit workspace action keywords")
        selected_target = target_hints[0] if target_hints else None
        confirmations = [a.get("type") for a in actions if a.get("requires_confirmation") or a.get("type") in {"delete_layer", "move_to_folder", "apply_style", "export_workspace"}]
        clarification = planner_info.get("clarification") or self._proximity_clarification(actions)
        if not selected_target and any(a.get("type") in {"delete_layer", "duplicate_layer", "move_to_folder", "rename_layer", "select_layer", "zoom_to_layer", "open_table", "toggle_edit", "toggle_crop", "toggle_split", "set_visibility", "apply_style", "export_layer"} for a in actions):
            clarification = clarification or "ambiguous target"
        plan_hash = calculate_plan_hash(actions)
        return {"actions": actions, "summary": summary, "why": why, "targets": target_hints,
                "selectedTarget": selected_target, "confirmations": confirmations,
                "clarification": clarification, "recentPrompts": self._recent_prompts[:5],
                "planHash": plan_hash, "planner": planner_info}


headless_sessions = HeadlessSessionStore()
