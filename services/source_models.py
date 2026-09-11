"""Normalized models used by internet-assisted GIS source discovery."""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlparse

PROTOCOLS = {"arcgis_rest", "wfs", "wms", "wmts", "ogc_api_features", "ckan", "socrata", "geojson", "geopackage", "shapefile", "kml", "csv", "unknown"}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class SourceLocator:
    url: str
    provenance_url: str | None = None
    title: str | None = None
    snippet: str | None = None


@dataclass
class ValidationResult:
    valid: bool
    protocol: str = "unknown"
    status: str = "unvalidated"
    message: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class SourceCandidate:
    title: str
    url: str
    protocol: str = "unknown"
    format: str | None = None
    description: str = ""
    provider: str = ""
    confidence: float = 0.0
    validation_status: str = "unvalidated"
    validation_message: str = ""
    recommended_loader: str = ""
    provenance_url: str = ""
    geographic_hints: list[str] = field(default_factory=list)
    themes: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    discovered_at: str = field(default_factory=now_iso)

    def __post_init__(self):
        if self.protocol not in PROTOCOLS:
            self.protocol = "unknown"
        self.url = self.url.strip()
        self.provenance_url = self.provenance_url or self.url
        if not self.provider:
            self.provider = urlparse(self.url).netloc
        self.confidence = max(0.0, min(1.0, float(self.confidence)))

    def to_dict(self):
        return asdict(self)
