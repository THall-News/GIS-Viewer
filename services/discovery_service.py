"""Bounded web discovery and protocol detection for GIS sources."""
from __future__ import annotations

import json
import os
import re
import time
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse

import requests

from config import is_public_url
from services.source_models import SourceCandidate, SourceLocator, ValidationResult

MAX_PAGE_BYTES = int(os.environ.get("GIS_DISCOVERY_MAX_PAGE_BYTES", 2 * 1024 * 1024))
MAX_PAGES = int(os.environ.get("GIS_DISCOVERY_MAX_PAGES", 8))
TIMEOUT = float(os.environ.get("GIS_DISCOVERY_TIMEOUT", 12))


class _LinkParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links, self.text = [], []
        self._anchor = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag.lower() == "a" and attrs.get("href"):
            self.links.append((attrs["href"], attrs.get("title", "")))
        self._anchor = tag.lower() in {"title", "p", "h1", "h2", "h3", "meta"}

    def handle_data(self, data):
        if self._anchor:
            self.text.append(data)


def _protocols_for_url(url: str, content_type: str = "") -> list[str]:
    parsed = urlparse(url)
    path = parsed.path.lower()
    query = parsed.query.lower()
    ct = content_type.lower()
    result = []
    if "featureserver" in path or "mapserver" in path or "imageserver" in path or "f=json" in query:
        result.append("arcgis_rest")
    if "service=wfs" in query or "request=getcapabilities" in query:
        result.append("wfs")
    if "service=wms" in query:
        result.append("wms")
    if "service=wmts" in query:
        result.append("wmts")
    if "/collections" in path or "ogcapi" in path or "conformsTo" in query:
        result.append("ogc_api_features")
    if "/api/3/action" in path or "ckan" in parsed.netloc.lower():
        result.append("ckan")
    if "socrata" in parsed.netloc.lower() or "/resource/" in path:
        result.append("socrata")
    extensions = [(".geojson", "geojson"), (".json", "geojson"), (".gpkg", "geopackage"), (".shp", "shapefile"), (".zip", "shapefile"), (".kml", "kml"), (".csv", "csv")]
    for suffix, protocol in extensions:
        if path.endswith(suffix) or suffix[1:] in ct:
            result.append(protocol)
    return list(dict.fromkeys(result)) or ["unknown"]


def detect_source(locator: SourceLocator, *, content: bytes = b"", content_type: str = "") -> list[SourceCandidate]:
    protocols = _protocols_for_url(locator.url, content_type)
    text = content[:MAX_PAGE_BYTES].decode("utf-8", errors="ignore") if content else ""
    if text.lstrip().startswith("{"):
        try:
            value = json.loads(text)
            if value.get("type") in {"FeatureCollection", "Feature"}:
                protocols.insert(0, "geojson")
            if "conformsTo" in value or "collections" in value:
                protocols.insert(0, "ogc_api_features")
            if "result" in value and "success" in value:
                protocols.insert(0, "ckan")
        except (ValueError, AttributeError):
            pass
    if "<wfs:WFS_Capabilities" in text or "<WFS_Capabilities" in text:
        protocols.insert(0, "wfs")
    if "<WMS_Capabilities" in text:
        protocols.insert(0, "wms")
    protocol = next(iter(dict.fromkeys(protocols)), "unknown")
    return [SourceCandidate(title=locator.title or urlparse(locator.url).path.rsplit("/", 1)[-1] or urlparse(locator.url).netloc,
                            url=locator.url, protocol=protocol, format=protocol,
                            description=locator.snippet or "", confidence=0.75 if protocol != "unknown" else 0.25,
                            recommended_loader=protocol, provenance_url=locator.provenance_url or locator.url)]


def _fetch(url: str) -> tuple[bytes, str]:
    if not is_public_url(url):
        raise ValueError("Source URL is not allowed")
    response = requests.get(url, timeout=TIMEOUT, stream=True, allow_redirects=False, verify=True,
                            headers={"User-Agent": "GIS-Layer-Previewer/1.0", "Accept": "text/html,application/json,application/xml,*/*"})
    if 300 <= response.status_code < 400:
        response.close()
        raise ValueError("Redirected source must be validated explicitly")
    response.raise_for_status()
    if int(response.headers.get("Content-Length", 0) or 0) > MAX_PAGE_BYTES:
        response.close()
        raise ValueError("Source metadata exceeds the discovery size limit")
    chunks, total = [], 0
    for chunk in response.iter_content(8192):
        total += len(chunk)
        if total > MAX_PAGE_BYTES:
            response.close()
            raise ValueError("Source metadata exceeds the discovery size limit")
        chunks.append(chunk)
    return b"".join(chunks), response.headers.get("Content-Type", "")


def validate_candidate(candidate: SourceCandidate) -> ValidationResult:
    try:
        content, content_type = _fetch(candidate.url)
        detected = detect_source(SourceLocator(candidate.url, candidate.provenance_url, candidate.title, candidate.description), content=content, content_type=content_type)[0]
        candidate.protocol = detected.protocol
        candidate.format = detected.format
        candidate.validation_status = "valid"
        candidate.validation_message = "Endpoint responded and protocol was detected."
        candidate.metadata = {"content_type": content_type, "bytes": len(content)}
        return ValidationResult(True, detected.protocol, "valid", candidate.validation_message, candidate.metadata)
    except Exception as exc:
        candidate.validation_status = "invalid"
        candidate.validation_message = str(exc)
        return ValidationResult(False, candidate.protocol, "invalid", str(exc))


def _search_web(query: str, limit: int) -> list[SourceLocator]:
    endpoint = os.environ.get("GIS_SEARCH_ENDPOINT", "").strip()
    if endpoint:
        if not is_public_url(endpoint):
            raise ValueError("Configured search endpoint is not allowed")
        response = requests.get(endpoint, params={"q": query, "limit": limit}, timeout=TIMEOUT, verify=True)
        response.raise_for_status()
        payload = response.json()
        values = payload.get("results", []) if isinstance(payload, dict) else []
        return [SourceLocator(str(item.get("url", "")), title=item.get("title"), snippet=item.get("snippet"))
                for item in values if isinstance(item, dict) and item.get("url")]
    key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not key:
        return []
    body = {
        "model": os.environ.get("OPENAI_HEADLESS_MODEL", "gpt-4.1-mini"),
        "tools": [{"type": "web_search_preview"}],
        "input": (
            f"Find up to {limit} authoritative public GIS data sources for: {query}. "
            "Prefer government open-data catalogs, ArcGIS REST services, WFS/WMS services, "
            "and official downloadable GIS datasets. Return only JSON with a results array; "
            "each result must contain url, title, and snippet."
        ),
        "text": {
            "format": {
                "type": "json_schema",
                "name": "gis_source_results",
                "strict": True,
                "schema": {
                    "type": "object",
                    "properties": {
                        "results": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "url": {"type": "string"},
                                    "title": {"type": "string"},
                                    "snippet": {"type": "string"},
                                },
                                "required": ["url", "title", "snippet"],
                                "additionalProperties": False,
                            },
                        }
                    },
                    "required": ["results"],
                    "additionalProperties": False,
                },
            }
        },
    }
    response = requests.post(os.environ.get("OPENAI_API_BASE", "https://api.openai.com/v1").rstrip("/") + "/responses",
                             headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"}, json=body, timeout=TIMEOUT)
    response.raise_for_status()
    payload = response.json()
    text = payload.get("output_text", "") if isinstance(payload, dict) else ""
    if not text and isinstance(payload, dict):
        chunks = []
        for output in payload.get("output") or []:
            for content in output.get("content") or []:
                if isinstance(content, dict) and content.get("text"):
                    chunks.append(str(content["text"]))
        text = "\n".join(chunks)

    # Models sometimes wrap otherwise valid JSON in a markdown fence despite
    # the schema instruction.  Accept that harmless presentation variation,
    # but never try to infer URLs from arbitrary prose.
    text = str(text or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.I | re.S).strip()
    try:
        values = json.loads(text)
    except (TypeError, ValueError):
        values = []
    if isinstance(values, dict):
        values = values.get("results", [])
    if not isinstance(values, list):
        values = []
    return [SourceLocator(str(item.get("url", "")), title=item.get("title"), snippet=item.get("snippet"))
            for item in values if isinstance(item, dict) and item.get("url")]


def discover_sources(query: str, *, limit: int = 10) -> dict:
    query = (query or "").strip()
    if not query:
        raise ValueError("Discovery query is required")
    limit = max(1, min(int(limit), 25))
    endpoint_configured = bool(os.environ.get("GIS_SEARCH_ENDPOINT", "").strip())
    api_configured = bool(os.environ.get("OPENAI_API_KEY", "").strip())
    locators = _search_web(query, limit)
    candidates, seen = [], set()
    for locator in locators[:MAX_PAGES]:
        if not is_public_url(locator.url):
            continue
        key = locator.url.split("#", 1)[0].rstrip("/").lower()
        if key in seen:
            continue
        seen.add(key)
        candidates.extend(detect_source(locator))
    candidates.sort(key=lambda item: item.confidence, reverse=True)
    return {"query": query, "searched": len(locators), "candidates": [candidate.to_dict() for candidate in candidates[:limit]],
            "message": (
                "Discovery completed." if locators
                else "No public GIS sources matched the query." if (endpoint_configured or api_configured)
                else "No web search provider configured."
            )}


def load_candidate(candidate: SourceCandidate) -> dict:
    """Load only simple direct vector resources; service-specific loaders remain authoritative."""
    if candidate.protocol not in {"geojson", "csv", "kml"}:
        raise ValueError(f"Preview/load for {candidate.protocol} must use its provider-specific loader")
    content, content_type = _fetch(candidate.url)
    if candidate.protocol == "geojson":
        try:
            geojson = json.loads(content.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            raise ValueError(f"Invalid GeoJSON: {exc}")
        if not isinstance(geojson, dict) or geojson.get("type") not in {"FeatureCollection", "Feature"}:
            raise ValueError("Response is not a GeoJSON FeatureCollection")
        return {"feature_collection": geojson, "feature_count": len(geojson.get("features", [])),
                "workspace_updates": [{"op": "create_layer", "layerType": "discovered", "name": candidate.title, "geojson": geojson}]}
    return {"content_type": content_type, "bytes": len(content), "message": "Resource validated; use the browser loader for this format."}
