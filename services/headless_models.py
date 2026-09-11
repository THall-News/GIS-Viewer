"""Validated public models for the headless GIS command protocol."""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field, asdict
from typing import Any

@dataclass
class IntentClassification:
    source: str
    operation: str
    theme: str = ""
    location: str | None = None
    tags: list[dict[str, str]] = field(default_factory=list)
    confidence: float = 0.0
    alternatives: list[str] = field(default_factory=list)
    clarification: str | None = None
    geometry: str = "all"
    tag_alternatives: list[list[dict[str, str]]] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.source not in {"osm", "gis_server", "both", "unknown"}:
            self.source = "unknown"
        self.confidence = max(0.0, min(1.0, float(self.confidence)))

READ_ACTIONS = {"load_servers", "search_layers", "select_layer", "zoom_to_layer", "open_table"}
EXTERNAL_ACTIONS = {"osm_search", "filter_layers", "discover_sources", "zoom_to_location"}
MUTATION_ACTIONS = {"delete_layer", "duplicate_layer", "create_folder", "move_to_folder", "rename_layer", "toggle_edit", "toggle_crop", "toggle_split", "set_visibility", "apply_style"}
EXPORT_ACTIONS = {"export_layer", "export_workspace"}
SUPPORTED_ACTIONS = READ_ACTIONS | EXTERNAL_ACTIONS | MUTATION_ACTIONS | EXPORT_ACTIONS | {"import_assets"}


def action_risk(action_type: str) -> str:
    if action_type in READ_ACTIONS:
        return "read"
    if action_type in EXTERNAL_ACTIONS:
        return "external_fetch"
    if action_type in MUTATION_ACTIONS:
        return "mutation"
    if action_type in EXPORT_ACTIONS:
        return "export"
    if action_type == "import_assets":
        return "mutation"
    return "unknown"


def action_requires_confirmation(action_type: str) -> bool:
    return action_risk(action_type) in {"external_fetch", "mutation", "export"}


@dataclass
class PlannedAction:
    type: str
    input: dict[str, Any] = field(default_factory=dict)
    risk: str = "unknown"
    requires_confirmation: bool = False
    explanation: str = ""
    status: str = "pending"
    output: dict[str, Any] = field(default_factory=dict)
    error: str | None = None

    def __post_init__(self) -> None:
        self.type = (self.type or "").strip()
        if self.type not in SUPPORTED_ACTIONS:
            raise ValueError(f"Unsupported headless action: {self.type or 'empty'}")
        if not isinstance(self.input, dict):
            raise ValueError(f"Action {self.type} payload must be an object")
        self.risk = action_risk(self.type)
        self.requires_confirmation = action_requires_confirmation(self.type)
        if not self.explanation:
            self.explanation = f"Execute {self.type.replace('_', ' ')}"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class PlanResponse:
    actions: list[PlannedAction]
    summary: list[str] = field(default_factory=list)
    targets: list[dict[str, Any]] = field(default_factory=list)
    selected_target: dict[str, Any] | None = None
    clarification: str | None = None
    why: list[str] = field(default_factory=list)
    plan_hash: str = ""
    approval_token: str = ""

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["actions"] = [action.to_dict() for action in self.actions]
        value["selectedTarget"] = value.pop("selected_target")
        value["planHash"] = value.pop("plan_hash")
        value["approvalToken"] = value.pop("approval_token")
        return value


def calculate_plan_hash(actions: list[dict[str, Any]]) -> str:
    canonical = json.dumps(actions, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
