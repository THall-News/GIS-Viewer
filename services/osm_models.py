"""Typed contracts for natural-language OpenStreetMap searches."""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any


@dataclass
class PlaceReference:
    query: str
    display_name: str = ""
    osm_type: str = ""
    osm_id: int | None = None
    place_type: str = ""
    bbox: list[float] | None = None
    area_id: int | None = None
    confidence: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class FeatureConcept:
    concept: str
    tags: list[dict[str, str]] = field(default_factory=list)
    confidence: float = 0.0
    source: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class OsmSearchIntent:
    operation: str
    source: str
    feature_concept: str
    feature_name: str | None = None
    location: str | None = None
    admin_level: str | None = None
    geometry: str = "all"
    distance_km: float | None = None
    confidence: float = 0.0
    clarification: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class OsmQueryPlan:
    strategy: str
    intent: OsmSearchIntent
    place: PlaceReference | None
    concept: FeatureConcept
    tags: list[dict[str, str]] = field(default_factory=list)
    name_fields: list[str] = field(default_factory=lambda: ["name"])
    attempts: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "strategy": self.strategy,
            "intent": self.intent.to_dict(),
            "place": self.place.to_dict() if self.place else None,
            "concept": self.concept.to_dict(),
            "tags": self.tags,
            "name_fields": self.name_fields,
            "attempts": self.attempts,
        }


@dataclass
class OsmQueryResult:
    geojson: dict[str, Any]
    metadata: dict[str, Any] = field(default_factory=dict)
    raw_element_count: int = 0
    feature_count: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "geojson": self.geojson,
            "metadata": self.metadata,
            "raw_element_count": self.raw_element_count,
            "feature_count": self.feature_count,
        }


@dataclass
class SpatialConstraint:
    relation: str
    reference: str
    location: str | None = None
    distance_km: float | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class OsmQuerySpec:
    feature_concept: str
    feature_name: str | None = None
    location: str | None = None
    spatial_constraints: list[SpatialConstraint] = field(default_factory=list)
    attributes: dict[str, Any] = field(default_factory=dict)
    geometry: str = "all"
    confidence: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["spatial_constraints"] = [item.to_dict() for item in self.spatial_constraints]
        return value
