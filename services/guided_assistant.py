"""Stateful, search-only orchestration for the Map Assistant."""
from __future__ import annotations

import re
import uuid
from typing import Any

from services.region_service import resolve_region_context, resolve_region_from_text


# The Previewer only searches the catalog database or explicitly selected OSM
# features. Public web discovery belongs to the standalone Catalog Admin
# service and must never be a request-time assistant provider here.
READ_ONLY_PROVIDERS = ("catalog", "osm")

# OSM is a useful fallback for broad, ordinary administrative boundaries. It
# is deliberately not a generic substitute for government-published thematic
# data such as reserves, evacuation areas, protected areas, or wildfire data.
OSM_APPROVED_TERMS = (
    "administrative boundary", "administrative boundaries", "admin boundary",
    "municipal boundary", "municipality boundary", "city boundary", "town boundary",
    "provincial boundary", "territorial boundary", "country boundary", "state boundary",
    "fire hydrant", "hydrant", "road", "roads", "street", "streets", "highway",
)
OSM_RESTRICTED_TERMS = (
    "reserve", "first nation", "indigenous", "aboriginal", "evacuation", "wildfire",
    "fire hazard", "protected area", "conservation area", "park boundary", "wetland",
)


def is_osm_fallback_approved(topic: str | None) -> bool:
    text = _text(topic).lower()
    if any(term in text for term in OSM_RESTRICTED_TERMS):
        return False
    return any(term in text for term in OSM_APPROVED_TERMS)


def _verified_osm_candidate_is_approved(candidate: dict[str, Any]) -> bool:
    """Allow a verified ordinary administrative mapping despite loose wording."""
    if not isinstance(candidate, dict) or not candidate.get("verified"):
        return False
    return any(
        str(tag.get("key") or "").lower() == "boundary"
        and str(tag.get("val") or "").lower() == "administrative"
        for tag in candidate.get("tags") or []
        if isinstance(tag, dict)
    )


def _text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip())


def _location_alias(value: str | None) -> str | None:
    value = _text(value).strip(" ,.")
    if not value:
        return None
    # Canonicalize a bare qualifier (ON, Ont., BC, etc.) but preserve a full
    # place-plus-qualifier string for geocoding and for the existing UI/API
    # contract, e.g. ``Vancouver, BC`` remains visible as entered.
    if "," not in value:
        region = resolve_region_from_text(value)
        if region and region.get("name"):
            return str(region["name"])
    return value


def _explicit_tags(value: str) -> list[dict[str, str]]:
    tags = []
    for match in re.finditer(r"\b([A-Za-z0-9_:-]{1,64})\s*=\s*([A-Za-z0-9_:@./ +\-]{0,128})", value or ""):
        tags.append({"key": match.group(1), "val": match.group(2).strip()})
    return tags


def _assistant_sources(value: Any) -> dict[str, bool]:
    if not isinstance(value, dict):
        return {"catalog": True, "osm": False}
    sources = {
        "catalog": bool(value.get("catalog", True)),
        "osm": bool(value.get("osm", False)),
    }
    if sources["catalog"] == sources["osm"]:
        raise ValueError("Select exactly one assistant search provider.")
    return sources


def _parse_request(store, request: str, workspace: dict[str, Any]) -> dict[str, Any]:
    boundary_match = re.match(
        r"^\s*(?:the\s+)?(?:boundary|boundaries|outline|shape)\s+(?:of|for)\s+(.+?)\s*$",
        request,
        re.I,
    )
    boundary_feature_name = None
    boundary_admin_level = None
    boundary_target = None
    region_context = None
    if boundary_match:
        boundary_place = _text(boundary_match.group(1)).strip(" ,.")
        # Keep the province/country suffix for geocoding, but use the named
        # place itself for the exact OSM boundary match.
        boundary_feature_name = re.split(r"\s*,\s*", boundary_place, maxsplit=1)[0].strip()
        boundary_feature_name = re.sub(
            r"^(?:the\s+)?(?:city|town|municipality|district|village)\s+of\s+",
            "",
            boundary_feature_name,
            flags=re.I,
        ).strip()
        explicit_level = re.search(r"\badmin(?:istrative)?[_ ]?level\s*[:=]?\s*(\d{1,2})\b", request, re.I)
        boundary_feature_name = re.sub(
            r"\s+admin(?:istrative)?[_ ]?level\s*[:=]?\s*\d{1,2}\s*$",
            "",
            boundary_feature_name,
            flags=re.I,
        ).strip(" ,")
        if explicit_level:
            boundary_admin_level = explicit_level.group(1)
            boundary_target = "explicit_admin_level"
        else:
            request_text = _text(request).lower()
            named_region = resolve_region_from_text(boundary_place)
            if any(term in request_text for term in ("province", "provincial", "territory", "territorial")) or (
                named_region and named_region.get("name") not in {"Canada"}
                and (
                    resolve_region_from_text(boundary_feature_name or "")
                    or _text(named_region.get("name")).lower() == _text(boundary_feature_name).lower()
                )
            ):
                boundary_admin_level = "4"
                boundary_target = "province_or_territory"
            elif any(term in request_text for term in ("country", "national")) or (named_region and named_region.get("name") == "Canada"):
                boundary_admin_level = "2"
                boundary_target = "country"
            else:
                boundary_admin_level = "8"
                boundary_target = "containing_municipality"
        topic = _text(request)
        location = _location_alias(boundary_place)
        region_context = resolve_region_context(boundary_place)
        relation = None
        reference = None
        distance_km = None
        spec = None
    else:
        spec = store.parse_osm_query(request)
        topic = ""
        location = None
        relation = None
        reference = None
        distance_km = None
    if spec:
        topic = _text(spec.feature_concept)
        location = _location_alias(spec.location)
        region_context = resolve_region_context(spec.location)
        if spec.spatial_constraints:
            constraint = spec.spatial_constraints[0]
            relation = constraint.relation
            reference = _text(constraint.reference)
            distance_km = constraint.distance_km
    if not topic:
        location_match = re.search(r"\s+(?:in|at)\s+(.+?)\s*$", request, re.I)
        if location_match:
            topic = _text(request[:location_match.start()])
            location = _location_alias(location_match.group(1))
            region_context = resolve_region_context(location_match.group(1))
        else:
            topic = _text(request)
    if not location:
        region = resolve_region_from_text(request)
        if region:
            location = region["name"]
            region_context = region
    map_bounds = workspace.get("mapBounds") if isinstance(workspace, dict) else None
    if location:
        location_kind = "proximity" if relation in {"near", "around", "within", "on", "along", "beside"} else "region"
    elif map_bounds:
        location = "Current map view"
        location_kind = "map_view"
    else:
        location_kind = "unknown"
    return {
        "topic": topic,
        "location": location,
        "location_kind": location_kind,
        "relation": relation,
        "reference": reference,
        "distance_km": distance_km,
        "map_bounds": map_bounds,
        "feature_name": boundary_feature_name,
        "admin_level": boundary_admin_level,
        "boundary_target": boundary_target,
        "region_context": region_context,
    }


def _candidate_for_topic(store, topic: str, location: str | None, refinement: str | None = None) -> dict[str, Any]:
    search_text = _text(" ".join(item for item in (topic, refinement) if item))
    explicit = _explicit_tags(refinement or "") or _explicit_tags(topic)
    if explicit:
        return {
            "label": search_text,
            "tags": explicit,
            "searchable": True,
            "verified": False,
            "status": "user-specified",
            "source": "user",
            "warning": "The tag was supplied by the user and will be searched exactly.",
        }
    probe = f"{search_text} in {location}" if location and location != "Current map view" else search_text
    intent = store.classify_intent(probe, allow_remote=False)
    tags = []
    if intent.source == "osm" and intent.tags and intent.confidence >= 0.78:
        for item in intent.tags:
            if not isinstance(item, dict):
                continue
            if item.get("key"):
                tags.append({"key": str(item.get("key")), "val": str(item.get("val") or item.get("value") or "")})
            else:
                tags.extend({"key": str(key), "val": str(value or "")} for key, value in item.items())
    if tags:
        return {
            "label": search_text,
            "tags": tags,
            "searchable": True,
            "verified": True,
            "status": "verified",
            "source": "deterministic-mapping",
            "warning": "",
        }
    hosted_candidate = None
    try:
        store._refresh_llm_settings()
        if store._openai_api_key:
            hosted_actions, _info = store._plan_with_llm_result(probe, workspace={}, conversation=[])
            for action in hosted_actions:
                if action.type != "osm_search":
                    continue
                model_tags = []
                for item in action.input.get("tags") or []:
                    if isinstance(item, dict) and item.get("key"):
                        model_tags.append({"key": str(item.get("key")), "val": str(item.get("val") or "")})
                    elif isinstance(item, dict):
                        model_tags.extend({"key": str(key), "val": str(value or "")} for key, value in item.items())
                if model_tags:
                    hosted_candidate = {
                        "label": search_text,
                        "tags": model_tags,
                        "searchable": False,
                        "verified": False,
                        "status": "unverified-suggestion",
                        "source": "hosted-llm",
                        "warning": "The hosted model suggested this OSM interpretation, but it was not verified and will not be queried automatically.",
                    }
                    break
    except Exception:
        # Hosted interpretation is optional. Catalog search remains useful
        # when the model is unavailable or returns an invalid plan.
        hosted_candidate = None
    if hosted_candidate:
        return hosted_candidate
    return {
        "label": search_text,
        "tags": [],
        "searchable": False,
        "verified": False,
        "status": "unresolved",
        "source": "none",
        "warning": "No exact OSM feature mapping was verified; OSM will not be queried for this interpretation.",
    }


def _clarification(state: dict[str, Any], request_context: dict[str, Any], sources: dict[str, bool]) -> dict[str, Any] | None:
    existing = state.get("clarification")
    if existing and existing.get("answered") is not True:
        return existing
    boundary_candidates = state.get("boundary_candidates") or []
    if boundary_candidates and not state.get("boundary_choice"):
        labels = [
            f"{candidate.get('name') or 'Unnamed boundary'} (admin_level {candidate.get('admin_level') or '?'}, relation {candidate.get('id')})"
            for candidate in boundary_candidates[:5]
        ]
        return {
            "id": str(uuid.uuid4()),
            "field": "boundary_choice",
            "question": "Which containing administrative boundary should I use? " + "; ".join(labels),
            "inputType": "free_text",
            "answered": False,
        }
    if request_context["location_kind"] == "unknown":
        return {
            "id": str(uuid.uuid4()),
            "field": "location",
            "question": "Where should I search? Provide a region, place, or use the current map view.",
            "inputType": "free_text",
            "answered": False,
        }
    if request_context["relation"] in {"near", "around", "within", "on", "along", "beside"} and not request_context["distance_km"]:
        reference = request_context["reference"] or request_context["location"]
        return {
            "id": str(uuid.uuid4()),
            "field": "distance",
            "question": f"How close should I search to {reference}? Please provide a distance, such as 25 m, 100 m, or 1 km.",
            "inputType": "free_text",
            "answered": False,
        }
    candidate = state.get("osm_candidate") or {}
    if sources.get("osm") and not candidate.get("tags") and not state.get("clarification_answer"):
        return {
            "id": str(uuid.uuid4()),
            "field": "feature_definition",
            "question": "If you also want OpenStreetMap results, what feature definition or tag should I use? You can describe it in plain language or provide key=value.",
            "inputType": "free_text",
            "answered": False,
        }
    return None


def _query_text(state: dict[str, Any]) -> str:
    context = state.get("request_context") or {}
    topic = _text(context.get("topic"))
    refinement = _text(state.get("clarification_answer")) if state.get("clarification_field") == "feature_definition" else ""
    if refinement and refinement.lower() not in topic.lower():
        topic = _text(f"{topic} {refinement}")
    location = context.get("location")
    if context.get("feature_name"):
        return topic
    return _text(f"{topic} in {location}" if location and location != "Current map view" else topic)


def _catalog_query(state: dict[str, Any]) -> str:
    context = state.get("request_context") or {}
    topic = _text(context.get("topic"))
    refinement = _text(state.get("clarification_answer")) if state.get("clarification_field") == "feature_definition" else ""
    return _text(" ".join(item for item in (topic, refinement) if item))


def _provider_plan(state: dict[str, Any], sources: dict[str, bool]) -> list[dict[str, Any]]:
    plan = []
    if sources.get("catalog"):
        plan.append({"provider": "catalog", "query": _query_text(state), "action": "search_layers"})
    return plan


def _search_providers(store, state: dict[str, Any], sources: dict[str, bool], plan: list[dict[str, Any]]) -> tuple[dict[str, list[Any]], list[str]]:
    results: dict[str, list[Any]] = {provider: [] for provider in READ_ONLY_PROVIDERS}
    warnings: list[str] = []
    query = _query_text(state)
    workspace = state.get("workspace") or {}
    context = state.get("request_context") or {}
    catalog_match = False

    if context.get("relation") in {"near", "around", "within", "on", "along", "beside"} and not context.get("distance_km"):
        return results, ["Search is paused until the requested distance is provided."]
    if context.get("location_kind") == "unknown":
        return results, ["Search is paused until a location or current map view is provided."]

    if sources.get("catalog"):
        try:
            output = store._run_search_layers({
                "source": "catalog", "query": _catalog_query(state), "limit": 10,
                "workspace": workspace, "mapBounds": workspace.get("mapBounds"),
                "region": context.get("location") if context.get("location_kind") == "region" else None,
            })
            for item in output.get("layers") or []:
                record = dict(item)
                record.update({
                    "provider": "catalog",
                    "resultType": "gis_layer",
                    "provenance": record.get("provenanceUrl") or record.get("url") or record.get("source"),
                    "geometryType": record.get("geometryType") or record.get("geometry_type"),
                })
                results["catalog"].append(record)
            for warning in output.get("catalog_warnings") or []:
                warnings.append(str(warning))
            for warning in output.get("warnings") or []:
                warnings.append(str(warning))
            # The standalone service marks this explicitly. Legacy adapters
            # without the status are not trusted to satisfy the hard region
            # gate, so the assistant reports the catalog miss without using a
            # web-search fallback.
            catalog_match = bool(results["catalog"]) and output.get("catalog_status") == "matched"
            if catalog_match:
                warnings.append("Catalog result found.")
            else:
                warnings.append("Catalog searched but no eligible layer matched the requested geographic scope.")
        except Exception as exc:
            warnings.append(f"Configured GIS catalog search failed: {str(exc)[:240]}")

    candidate = state.get("osm_candidate") or {}
    osm_category_approved = is_osm_fallback_approved(context.get("topic")) or _verified_osm_candidate_is_approved(candidate)
    if sources.get("osm") and osm_category_approved and not catalog_match and candidate.get("tags") and candidate.get("searchable"):
        if not any(item.get("provider") == "osm" for item in plan):
            plan.append({"provider": "osm", "query": query, "action": "osm_search", "tags": candidate["tags"], "reason": "catalog_insufficient"})
        search_tags = list(candidate["tags"])
        if context.get("feature_name") and any(
            str(tag.get("key") or "").lower() == "boundary"
            and str(tag.get("val") or "").lower() == "administrative"
            for tag in search_tags
            if isinstance(tag, dict)
        ):
            search_tags.append({"key": "admin_level", "val": context.get("admin_level") or "8"})
        payload: dict[str, Any] = {
            "tags": search_tags,
            "geomType": "all",
            "mapBounds": context.get("map_bounds"),
            "loc": context.get("location") if context.get("location_kind") != "map_view" else None,
            "requested_region": context.get("region_context"),
        }
        if context.get("feature_name"):
            payload.update({
                "featName": context["feature_name"],
                "exactName": True,
            })
            if context.get("boundary_target"):
                payload.update({
                    "boundary_target": context["boundary_target"],
                    "requested_place": context["feature_name"],
                    "requested_admin_level": context.get("admin_level") or "8",
                    "boundary_choice": state.get("boundary_choice"),
                })
        if context.get("relation") in {"near", "around", "within"}:
            payload["relation"] = "near" if context["relation"] in {"near", "around"} else "within"
            payload["near_place"] = context.get("reference")
            payload["distance_km"] = context.get("distance_km")
        elif context.get("relation") in {"on", "along", "beside"}:
            payload["relation"] = context["relation"]
            payload["street"] = context.get("reference")
            payload["distance_km"] = context.get("distance_km")
        try:
            output = store._run_osm_search(payload)
            if output.get("boundary_ambiguity"):
                state["boundary_candidates"] = output.get("boundary_candidates") or []
                warnings.append(output.get("message") or "Boundary resolution requires a boundary choice.")
            else:
                state.pop("boundary_candidates", None)
                collection = output.get("feature_collection") or {}
                count = int(output.get("feature_count") or len(collection.get("features") or []))
                if count:
                    metadata = output.get("metadata") or collection.get("metadata") or {}
                    results["osm"].append({
                        "provider": "osm",
                        "resultType": "feature_collection",
                        "title": f"OpenStreetMap: {_query_text(state)}",
                        "count": count,
                        "geometryType": ", ".join(sorted({str((feature.get("geometry") or {}).get("type")) for feature in collection.get("features") or [] if feature.get("geometry")})),
                        "provenance": metadata.get("attribution_url") or "https://www.openstreetmap.org/copyright",
                        "attribution": metadata.get("attribution") or "© OpenStreetMap contributors",
                        "geojson": collection,
                        "metadata": metadata,
                    })
                else:
                    warnings.append("OpenStreetMap returned no matching features.")
        except Exception as exc:
            warnings.append(f"OpenStreetMap search failed: {str(exc)[:240]}")
    elif sources.get("osm") and not osm_category_approved:
        warnings.append("OSM not used because this feature category requires authoritative data.")
    elif sources.get("osm") and not catalog_match:
        warnings.append((candidate.get("warning") or "No exact OSM interpretation was verified.") + " OSM was not queried.")
    return results, warnings


def _response(store, state: dict[str, Any], sources: dict[str, bool]) -> dict[str, Any]:
    candidate = _candidate_for_topic(
        store,
        (state.get("request_context") or {}).get("topic") or "",
        (state.get("request_context") or {}).get("location"),
        state.get("clarification_answer") if state.get("clarification_field") == "feature_definition" else None,
    )
    state["osm_candidate"] = candidate
    plan = _provider_plan(state, sources)
    results, warnings = _search_providers(store, state, sources, plan)
    clarification = _clarification(state, state.get("request_context") or {}, sources)
    if candidate.get("warning") and sources.get("osm") and is_osm_fallback_approved((state.get("request_context") or {}).get("topic")) and not candidate.get("tags"):
        warnings.append(candidate["warning"])
    context = state.get("request_context") or {}
    interpretation = {
        "topic": context.get("topic"),
        "refinement": state.get("clarification_answer"),
        "searchQuery": _query_text(state),
        "location": {"text": context.get("location"), "kind": context.get("location_kind")},
        "region": context.get("region_context"),
        "providers": list(dict.fromkeys(item.get("provider") for item in plan if item.get("provider"))),
        "osmCandidates": [candidate],
        "uncertainties": list(dict.fromkeys(warnings)),
    }
    osm_resolution = next(
        (
            item.get("metadata", {}).get("boundary_resolution")
            or item.get("metadata")
            for item in results.get("osm", [])
            if item.get("metadata", {}).get("resolved_boundary_name")
        ),
        None,
    )
    if osm_resolution:
        interpretation["boundaryResolution"] = osm_resolution
    if clarification:
        clarification = dict(clarification)
        state["clarification"] = clarification
    state["last_plan"] = plan
    state["last_results"] = results
    state["last_warnings"] = list(dict.fromkeys(warnings))
    state_name = "clarification_required" if clarification else "results"
    return {
        "sessionId": state.get("session_id"),
        "state": state_name,
        "originalRequest": state.get("original_request"),
        "sources": sources,
        "interpretation": interpretation,
        "clarification": clarification,
        "plan": {"providers": plan},
        "results": results,
        "warnings": list(dict.fromkeys(warnings)),
    }


def guided_assistant_turn(store, data: dict[str, Any]) -> dict[str, Any]:
    """Run one stateful assistant turn and persist its search-only result."""
    if not isinstance(data, dict):
        raise ValueError("assistant request must be an object")
    workspace = data.get("workspace") or data.get("workspaceContext") or {}
    if not isinstance(workspace, dict):
        raise ValueError("workspace must be an object")
    session_id = _text(data.get("sessionId")) or None
    session = store.get(session_id) if session_id else None
    if session_id and not session:
        raise ValueError("assistant session not found")
    # A clarification reply is allowed to omit ``sources``. In that case use
    # the provider choice from the pending session instead of silently
    # widening the search back to every provider.
    if session and "sources" not in data:
        stored_sources = (session.assistant_state or {}).get("sources")
        # Migrate sessions created by the previous two-provider-plus-web UI.
        # Those sessions could have both catalog and OSM selected; preserve
        # the safer catalog choice for the pending turn.
        if isinstance(stored_sources, dict) and stored_sources.get("catalog") and stored_sources.get("osm"):
            sources = {"catalog": True, "osm": False}
        else:
            sources = _assistant_sources(stored_sources)
    else:
        sources = _assistant_sources(data.get("sources"))

    if session:
        state = dict(session.assistant_state or {})
        if not state.get("original_request") or not isinstance(state.get("request_context"), dict):
            raise ValueError("session is not a guided assistant session")
        state["workspace"] = workspace
        reply = data.get("reply") or {}
        if data.get("retry"):
            pass
        elif not isinstance(reply, dict) or not _text(reply.get("text")):
            raise ValueError("reply.text is required for a clarification turn")
        else:
            clarification = state.get("clarification") or {}
            if _text(reply.get("clarificationId")) != _text(clarification.get("id")):
                raise ValueError("clarificationId does not match the pending assistant question")
            answer = _text(reply.get("text"))
            state["clarification_field"] = clarification.get("field")
            if clarification.get("field") == "distance":
                distance_km = store._distance_from_prompt(answer)
                if distance_km is None or distance_km <= 0:
                    clarification["answered"] = False
                    state["clarification"] = clarification
                    state["last_warnings"] = ["Please answer with a positive distance such as 25 m, 100 m, or 1 km."]
                else:
                    state["request_context"]["distance_km"] = distance_km
                    state["clarification_answer"] = answer
                    clarification["answered"] = True
                    state["clarification"] = None
            elif clarification.get("field") == "location":
                state["request_context"]["location"] = _location_alias(answer)
                state["request_context"]["location_kind"] = "region"
                state["clarification_answer"] = answer
                clarification["answered"] = True
                state["clarification"] = None
            elif clarification.get("field") == "boundary_choice":
                state["boundary_choice"] = answer
                state["clarification_answer"] = answer
                clarification["answered"] = True
                state["clarification"] = None
            else:
                state["clarification_answer"] = answer
                clarification["answered"] = True
                state["clarification"] = None
        state["sources"] = sources
    else:
        request = _text(data.get("request"))
        if not request:
            raise ValueError("request is required")
        if len(request) > 2000:
            raise ValueError("request is too long")
        request_context = _parse_request(store, request, workspace)
        state = {
            "session_id": str(uuid.uuid4()),
            "original_request": request,
            "workspace": workspace,
            "sources": sources,
            "request_context": request_context,
            "clarification": None,
            "clarification_answer": None,
        }
        from services.headless_service import HeadlessSession
        session = HeadlessSession(id=state["session_id"], prompt=request, workspace=workspace, assistant_state=state)
        with store._lock:
            store._sessions[session.id] = session

    response = _response(store, state, sources)
    response["sessionId"] = session.id
    state["session_id"] = session.id
    session.assistant_state = state
    session.workspace = workspace
    session.result = response
    session.status = response["state"]
    session.updated_at = store._utc_now_for_assistant()
    store._repository.save(session)
    store._repository.audit(session.id, "assistant_turn", {
        "state": response["state"],
        "originalRequest": state.get("original_request"),
        "clarification": state.get("clarification"),
        "providers": response.get("interpretation", {}).get("providers", []),
        "resultCounts": {key: len(value) for key, value in (response.get("results") or {}).items()},
        "warnings": response.get("warnings", []),
    }, session.updated_at)
    return response
