"""Layer-level indexing for the application's configured GIS catalogs.

The saved server list is a registry of services, not a dataset catalog.  This
module turns the registry into searchable records by reading bounded service
metadata (WFS feature types and ArcGIS layers) and caching the result.  The
catalog search remains read-only: it never downloads feature data.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import requests

from config import REQUEST_HEADERS


DEFAULT_TTL = 24 * 60 * 60
DEFAULT_TIMEOUT = 12.0
MAX_SOURCES = 50
MAX_WFS_FEATURE_TYPES = 1000
MAX_ARCGIS_LAYERS = 500
MAX_CKAN_RESULTS = 100


def _local_name(tag: str) -> str:
    return str(tag or "").rsplit("}", 1)[-1].lower()


def _clean(value: Any) -> str:
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value).strip())


def _first_text(element: ET.Element, names: set[str]) -> str:
    for child in element.iter():
        if _local_name(child.tag) in names and child.text:
            value = _clean(child.text)
            if value:
                return value
    return ""


def _all_text(element: ET.Element, names: set[str]) -> list[str]:
    values = []
    for child in element.iter():
        if _local_name(child.tag) in names and child.text:
            value = _clean(child.text)
            if value and value not in values:
                values.append(value)
    return values


def _numbers(value: Any) -> list[float]:
    if isinstance(value, (list, tuple)):
        raw = value
    else:
        raw = re.findall(r"[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?", _clean(value))
    try:
        return [float(item) for item in raw]
    except (TypeError, ValueError):
        return []


def _wgs84_bbox_from_xml(element: ET.Element) -> list[float] | None:
    """Return [south, west, north, east] from common WFS bbox forms."""
    for node in element.iter():
        name = _local_name(node.tag)
        if name == "latlongboundingbox":
            values = [node.attrib.get(key) for key in ("minx", "miny", "maxx", "maxy")]
            numbers = _numbers(values)
            if len(numbers) == 4:
                west, south, east, north = numbers
                return [min(south, north), min(west, east), max(south, north), max(west, east)]
        if name == "wgs84boundingbox":
            lower = _first_text(node, {"lowercorner"})
            upper = _first_text(node, {"uppercorner"})
            lower_numbers, upper_numbers = _numbers(lower), _numbers(upper)
            if len(lower_numbers) >= 2 and len(upper_numbers) >= 2:
                west, south = lower_numbers[:2]
                east, north = upper_numbers[:2]
                return [min(south, north), min(west, east), max(south, north), max(west, east)]
    return None


def _bbox_from_arcgis(value: Any) -> list[float] | None:
    if not isinstance(value, dict):
        return None
    try:
        west, south = float(value["xmin"]), float(value["ymin"])
        east, north = float(value["xmax"]), float(value["ymax"])
    except (KeyError, TypeError, ValueError):
        return None
    reference = value.get("spatialReference") or {}
    wkid = reference.get("latestWkid") or reference.get("wkid")
    # ArcGIS often reports projected extents.  Do not compare metres to a
    # WGS84 search bbox; retain the native extent separately instead.
    try:
        if wkid and int(wkid) not in {4326, 4269, 4267}:
            return None
    except (TypeError, ValueError):
        return None
    if not (-180 <= west <= 180 and -180 <= east <= 180 and -90 <= south <= 90 and -90 <= north <= 90):
        return None
    return [min(south, north), min(west, east), max(south, north), max(west, east)]


def _bbox_from_saved_server(server: dict[str, Any]) -> list[float] | None:
    extent = server.get("geographic_extent") or server.get("geographicExtent") or {}
    value = extent.get("bbox") if isinstance(extent, dict) else None
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        value = server.get("bbox") or server.get("geographic_bbox")
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        return None
    try:
        west, south, east, north = [float(item) for item in value]
    except (TypeError, ValueError):
        return None
    # Saved scraper records use the ArcGIS/WFS conventional [west,south,
    # east,north] order.  The search index uses [south,west,north,east].
    if -180 <= west <= 180 and -90 <= south <= 90 and -180 <= east <= 180 and -90 <= north <= 90:
        return [min(south, north), min(west, east), max(south, north), max(west, east)]
    return None


def _bbox_from_ckan_spatial(value: Any) -> list[float] | None:
    """Read common CKAN ``spatial`` JSON forms into internal bbox order."""
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (TypeError, ValueError):
            return None
    if not isinstance(value, dict):
        return None
    bbox = value.get("bbox")
    if isinstance(bbox, (list, tuple)) and len(bbox) == 4:
        try:
            west, south, east, north = [float(item) for item in bbox]
            return [min(south, north), min(west, east), max(south, north), max(west, east)]
        except (TypeError, ValueError):
            return None
    geometry = value.get("geometry") if isinstance(value.get("geometry"), dict) else value
    coordinates = geometry.get("coordinates") if isinstance(geometry, dict) else None
    if not coordinates:
        return None
    points: list[list[float]] = []

    def collect(item: Any) -> None:
        if isinstance(item, (list, tuple)) and len(item) >= 2 and all(isinstance(part, (int, float)) for part in item[:2]):
            points.append([float(item[0]), float(item[1])])
        elif isinstance(item, (list, tuple)):
            for child in item:
                collect(child)

    collect(coordinates)
    if not points:
        return None
    return [min(point[1] for point in points), min(point[0] for point in points), max(point[1] for point in points), max(point[0] for point in points)]


def _source_key(server: dict[str, Any]) -> str:
    value = "|".join(str(server.get(key) or "") for key in ("id", "url", "type", "name"))
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _base_record(server: dict[str, Any]) -> dict[str, Any]:
    source_id = _clean(server.get("id") or server.get("url") or "configured-source")
    display_name = _clean(server.get("display_name") or server.get("displayName") or server.get("name") or "Configured GIS source")
    server_type = _clean(server.get("type") or server.get("protocol") or "").upper()
    extent = server.get("geographic_extent") or server.get("geographicExtent") or {}
    extent_name = extent.get("name") if isinstance(extent, dict) else ""
    return {
        "id": f"{source_id}:service",
        "source_id": source_id,
        "server_id": source_id,
        "source": "saved_catalog",
        "catalog_level": "service",
        "source_display_name": display_name,
        "displayName": display_name,
        "title": _clean(server.get("name") or display_name),
        "name": _clean(server.get("name") or display_name),
        "description": _clean(server.get("description") or ""),
        "provider": _clean(server.get("provider") or display_name),
        "protocol": server_type.lower(),
        "format": server_type.lower(),
        "type": server_type,
        "themes": list(server.get("themes") or []),
        "keywords": list(server.get("keywords") or []),
        "geographic_hints": [extent_name] if extent_name else [],
        "bbox": _bbox_from_saved_server(server),
        "url": _clean(server.get("url") or ""),
        "serviceUrl": _clean(server.get("url") or ""),
        "provenanceUrl": _clean(server.get("url") or ""),
        "validation_status": "configured",
    }


def _wfs_capabilities_url(url: str) -> str:
    parts = urlsplit(url)
    params = [(key, value) for key, value in parse_qsl(parts.query, keep_blank_values=True)
              if key.lower() not in {"service", "request", "version"}]
    params.extend([("service", "WFS"), ("request", "GetCapabilities")])
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(params), parts.fragment))


def _request_json(url: str, timeout: float) -> dict[str, Any]:
    response = requests.get(url, headers=REQUEST_HEADERS, timeout=timeout, verify=True)
    response.raise_for_status()
    value = response.json()
    if not isinstance(value, dict):
        raise ValueError("service metadata response was not an object")
    return value


def _request_xml(url: str, timeout: float) -> ET.Element:
    response = requests.get(url, headers=REQUEST_HEADERS, timeout=timeout, verify=True)
    response.raise_for_status()
    return ET.fromstring(response.content)


def _wfs_records(server: dict[str, Any], timeout: float) -> tuple[list[dict[str, Any]], str | None]:
    base = _base_record(server)
    try:
        root = _request_xml(_wfs_capabilities_url(str(server.get("url") or "")), timeout)
        records = []
        for feature_type in root.iter():
            if _local_name(feature_type.tag) != "featuretype":
                continue
            name = _first_text(feature_type, {"name"})
            title = _first_text(feature_type, {"title"}) or name
            if not name and not title:
                continue
            abstract = _first_text(feature_type, {"abstract"})
            keywords = _all_text(feature_type, {"keyword"})
            bbox = _wgs84_bbox_from_xml(feature_type)
            layer_id = name or title
            record = dict(base)
            record.update({
                "id": f"{base['source_id']}:wfs:{layer_id}",
                "catalog_level": "layer",
                "title": title,
                "name": name or title,
                "layerName": name or title,
                "description": abstract or base["description"],
                "keywords": keywords,
                "search_aliases": [title, name, *keywords],
                "bbox": bbox or base.get("bbox"),
                "geometryType": "",
            })
            records.append(record)
            if len(records) >= MAX_WFS_FEATURE_TYPES:
                break
        if records:
            return records, None
        return [base], "WFS capabilities contained no feature types."
    except Exception as exc:
        return [base], f"WFS catalog ingestion failed for {base['source_display_name']}: {str(exc)[:180]}"


def _arcgis_layer_record(base: dict[str, Any], service_url: str, layer: dict[str, Any], detail: dict[str, Any] | None = None) -> dict[str, Any]:
    detail = detail or {}
    layer_id = layer.get("id", detail.get("id", 0))
    title = _clean(detail.get("name") or layer.get("name") or f"Layer {layer_id}")
    description = _clean(detail.get("description") or detail.get("serviceDescription") or "")
    if not description:
        description = base["description"]
    layer_url = f"{service_url.rstrip('/')}/{layer_id}"
    fields = [field.get("alias") or field.get("name") for field in (detail.get("fields") or []) if isinstance(field, dict)]
    fields = [str(field) for field in fields if field]
    extent = detail.get("extent") or {}
    bbox = _bbox_from_arcgis(extent) or base.get("bbox")
    is_group = bool(layer.get("subLayerIds")) or detail.get("type") == "Group Layer"
    keywords = [str(item) for item in (detail.get("typeKeywords") or []) if item]
    service_key = hashlib.sha1(service_url.encode("utf-8")).hexdigest()[:10]
    return dict(base, **{
        "id": f"{base['source_id']}:arcgis:{service_key}:{layer_id}:{title}",
        "catalog_level": "layer",
        "title": title,
        "name": title,
        "layerName": title,
        "description": description,
        "url": layer_url,
        "layerUrl": layer_url,
        "serviceUrl": service_url,
        "provenanceUrl": layer_url,
        "layerId": layer_id,
        "geometryType": detail.get("geometryType") or "",
        "fields": fields,
        "keywords": keywords,
        "search_aliases": [title, *keywords, *fields],
        "bbox": bbox,
        "isGroup": is_group,
        "parentLayerId": layer.get("parentLayerId", -1),
        "serverType": "FeatureServer" if "featureserver" in service_url.lower() else "MapServer",
    })


def _arcgis_service_records(server: dict[str, Any], service_url: str, service_data: dict[str, Any], timeout: float) -> tuple[list[dict[str, Any]], list[str]]:
    base = _base_record(server)
    warnings: list[str] = []
    layers = [item for item in (service_data.get("layers") or []) if isinstance(item, dict)]
    tables = [item for item in (service_data.get("tables") or []) if isinstance(item, dict)]
    if not layers and not tables and ("geometryType" in service_data or "fields" in service_data):
        layers = [{"id": service_data.get("id", 0), "name": service_data.get("name", "Layer")}]
    records = []
    # Layer detail is useful for searchable descriptions and geometry type. A
    # failed detail request does not hide the layer from the catalog.
    for layer in (layers + tables)[:MAX_ARCGIS_LAYERS]:
        layer_id = layer.get("id", 0)
        detail = {}
        try:
            detail = _request_json(f"{service_url.rstrip('/')}/{layer_id}?f=json", timeout)
        except Exception as exc:
            warnings.append(f"Layer metadata unavailable for {layer.get('name') or layer_id}: {str(exc)[:120]}")
        records.append(_arcgis_layer_record(base, service_url, layer, detail))
    return records or [base], warnings


def _arcgis_records(server: dict[str, Any], timeout: float) -> tuple[list[dict[str, Any]], str | None]:
    base = _base_record(server)
    url = str(server.get("url") or "").split("?", 1)[0].rstrip("/")
    try:
        root = _request_json(f"{url}?f=json", timeout)
        if root.get("layers") or root.get("tables") or "geometryType" in root or "fields" in root:
            records, warnings = _arcgis_service_records(server, url, root, timeout)
            return records, "; ".join(warnings[:3]) if warnings else None
        # A REST directory needs a bounded crawl before it can be a useful
        # catalog.  The saved source list contains several directory roots;
        # index their vector services and layers, but cap the work so a large
        # enterprise directory cannot monopolize an assistant turn.
        if root.get("services") or root.get("folders"):
            directory_records, directory_warnings = _arcgis_directory_records(server, url, root, timeout)
            if directory_records:
                return directory_records, "; ".join(directory_warnings[:3]) if directory_warnings else None
            return [dict(base, description=f"{base['description']} ArcGIS REST directory with {len(root.get('services') or [])} services.", catalog_level="directory")], "; ".join(directory_warnings[:3]) if directory_warnings else None
        return [base], "ArcGIS metadata did not expose layers or services."
    except Exception as exc:
        return [base], f"ArcGIS catalog ingestion failed for {base['source_display_name']}: {str(exc)[:180]}"


def _arcgis_directory_records(server: dict[str, Any], directory_url: str, root: dict[str, Any], timeout: float) -> tuple[list[dict[str, Any]], list[str]]:
    """Crawl a directory's vector services with explicit bounds."""
    max_services = max(1, min(int(os.environ.get("GIS_CATALOG_MAX_ARCGIS_SERVICES", 80)), 200))
    service_entries: list[tuple[str, str]] = []

    def add_services(catalog: dict[str, Any], prefix: str = "") -> None:
        for item in catalog.get("services") or []:
            if not isinstance(item, dict) or item.get("type") not in {"FeatureServer", "MapServer"}:
                continue
            name = _clean(item.get("name") or "")
            if name:
                service_entries.append((f"{prefix}/{name}".strip("/"), str(item.get("type"))))

    add_services(root)
    # Fetch one level of folders. ArcGIS service names may already include a
    # folder path, so the prefix is retained only for explicit folder entries.
    for folder in [str(item) for item in (root.get("folders") or [])[:30] if item]:
        try:
            folder_data = _request_json(f"{directory_url.rstrip('/')}/{folder}?f=json", timeout)
            add_services(folder_data, folder)
        except Exception:
            continue

    entries = service_entries[:max_services]
    warnings: list[str] = []
    records: list[dict[str, Any]] = []
    base = _base_record(server)

    def fetch_entry(entry: tuple[str, str]):
        name, service_type = entry
        service_url = f"{directory_url.rstrip('/')}/{name}/{service_type}"
        try:
            service_data = _request_json(f"{service_url}?f=json", timeout)
            return _arcgis_service_records(server, service_url, service_data, timeout)
        except Exception as exc:
            return [], [f"ArcGIS service unavailable ({name}): {str(exc)[:120]}"]

    if entries:
        with ThreadPoolExecutor(max_workers=min(5, len(entries))) as executor:
            futures = [executor.submit(fetch_entry, entry) for entry in entries]
            for future in as_completed(futures):
                try:
                    service_records, service_warnings = future.result()
                    records.extend(service_records)
                    warnings.extend(service_warnings)
                except Exception as exc:
                    warnings.append(f"ArcGIS directory service failed: {str(exc)[:120]}")
    if len(service_entries) > max_services:
        warnings.append(f"ArcGIS directory search limited to {max_services} services.")
    return records or [dict(base, catalog_level="directory")], list(dict.fromkeys(warnings))


def _load_cache(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) and isinstance(value.get("sources"), dict) else {"version": 1, "sources": {}}
    except (OSError, ValueError, TypeError):
        return {"version": 1, "sources": {}}


def _save_cache(path: Path, cache: dict[str, Any]) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(cache, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    except OSError:
        # A read-only installation should still be able to search live data.
        pass


def _ingest_server(server: dict[str, Any]) -> tuple[str, list[dict[str, Any]], str | None]:
    source_type = _clean(server.get("type") or server.get("protocol") or "").upper()
    timeout = max(2.0, min(float(os.environ.get("GIS_CATALOG_TIMEOUT", DEFAULT_TIMEOUT)), 30.0))
    if source_type == "WFS" or "service=wfs" in str(server.get("url") or "").lower() or "getcapabilities" in str(server.get("url") or "").lower():
        records, warning = _wfs_records(server, timeout)
    elif source_type in {"ESRI", "ARCGIS", "FEATURESERVER", "MAPSERVER"} or any(token in str(server.get("url") or "").lower() for token in ("featureserver", "mapserver", "/rest/services")):
        records, warning = _arcgis_records(server, timeout)
    elif source_type == "CKAN" or "ckan" in str(server.get("url") or "").lower() or "open.canada.ca" in str(server.get("url") or "").lower():
        try:
            records = _ckan_records(server, "*:*", MAX_CKAN_RESULTS)
            warning = None if records else "CKAN package search returned no indexable resources."
        except Exception as exc:
            records, warning = [_base_record(server)], f"CKAN catalog ingestion failed for {_base_record(server)['source_display_name']}: {str(exc)[:180]}"
    else:
        records, warning = [_base_record(server)], f"Unsupported catalog protocol for {source.get('source_display_name') or source.get('name') or source.get('url')}: {source_type or 'unknown'}"
    return _source_key(server), records, warning


def build_catalog_records(servers: list[dict[str, Any]], cache_path: str | Path | None = None, *, refresh: bool = False) -> tuple[list[dict[str, Any]], list[str], dict[str, Any]]:
    """Expand configured services into searchable layer records.

    Deprecated compatibility helper. The standalone ``CatalogManager`` and
    ``CatalogRepository`` are authoritative; the previewer never calls this
    request-time cache builder.

    Returns ``(records, warnings, stats)``.  Cached entries are keyed by the
    source identity and have a bounded TTL, so normal assistant searches do
    not repeatedly fetch capabilities from every configured provider.
    """
    path = Path(cache_path) if cache_path else None
    cache = _load_cache(path) if path else {"version": 1, "sources": {}}
    ttl = max(60.0, float(os.environ.get("GIS_CATALOG_CACHE_TTL", DEFAULT_TTL)))
    selected = [server for server in (servers or []) if isinstance(server, dict)][:MAX_SOURCES]
    records: list[dict[str, Any]] = []
    warnings: list[str] = []
    pending: list[dict[str, Any]] = []
    now = time.time()
    for server in selected:
        key = _source_key(server)
        cached = cache.get("sources", {}).get(key) or {}
        cache_expiry = float(cached.get("expires_at", 0) or 0) or (float(cached.get("fetched_at", 0) or 0) + ttl)
        if not refresh and isinstance(cached, dict) and now < cache_expiry and isinstance(cached.get("records"), list):
            records.extend(cached["records"])
        else:
            pending.append(server)

    if pending:
        workers = max(1, min(5, len(pending)))
        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = [executor.submit(_ingest_server, server) for server in pending]
            for future in as_completed(futures):
                try:
                    key, source_records, warning = future.result()
                    records.extend(source_records)
                    cache.setdefault("sources", {})[key] = {
                        "fetched_at": now,
                        # A failed capability request is retried soon rather
                        # than freezing a transient outage into the daily
                        # catalog cache.
                        "expires_at": now + (300 if warning and source_records and source_records[0].get("catalog_level") == "service" else ttl),
                        "records": source_records,
                        "warning": warning,
                    }
                    if warning:
                        warnings.append(warning)
                except Exception as exc:
                    warnings.append(f"Catalog source ingestion failed: {str(exc)[:180]}")
        if path:
            _save_cache(path, cache)

    stats = {
        "configured_source_count": len(selected),
        "indexed_record_count": len(records),
        "fresh_source_count": len(selected) - len(pending),
        "refreshed_source_count": len(pending),
        "cached": bool(path),
    }
    return records, list(dict.fromkeys(warnings)), stats


def _ckan_endpoint(url: str) -> str:
    clean = str(url or "").strip().rstrip("/")
    if clean.endswith("package_search"):
        return clean
    if clean.endswith("/api/3/action"):
        return f"{clean}/package_search"
    return f"{clean}/api/3/action/package_search"


def _ckan_records(server: dict[str, Any], query: str, limit: int) -> list[dict[str, Any]]:
    endpoint = _ckan_endpoint(server.get("url") or "")
    response = requests.get(endpoint, params={"q": query, "rows": min(MAX_CKAN_RESULTS, max(1, limit * 5))}, headers=REQUEST_HEADERS, timeout=15, verify=True)
    response.raise_for_status()
    payload = response.json()
    packages = (payload.get("result") or {}).get("results") or []
    base = _base_record(server)
    output = []
    for package in packages:
        if not isinstance(package, dict):
            continue
        title = _clean(package.get("title") or package.get("name") or "Untitled dataset")
        notes = _clean(package.get("notes") or package.get("description") or "")
        tags = [str((tag or {}).get("display_name") or (tag or {}).get("name")) for tag in package.get("tags") or [] if isinstance(tag, dict)]
        spatial = package.get("spatial")
        if not spatial:
            for extra in package.get("extras") or []:
                if isinstance(extra, dict) and str(extra.get("key") or "").lower() in {"spatial", "bbox", "geographic_extent"}:
                    spatial = extra.get("value")
                    break
        package_bbox = _bbox_from_ckan_spatial(spatial)
        resources = [item for item in package.get("resources") or [] if isinstance(item, dict) and item.get("url")]
        vector_resources = [item for item in resources if any(token in _clean(item.get("format") or item.get("url")).lower() for token in ("geojson", "shp", "shapefile", "gpkg", "kml", "wfs", "arcgis", "feature"))]
        if not vector_resources:
            vector_resources = resources[:1]
        for resource in vector_resources[:5]:
            resource_title = _clean(resource.get("name") or resource.get("format") or "Resource")
            record = dict(base)
            record.update({
                "id": f"{base['source_id']}:ckan:{package.get('name') or title}:{resource.get('id') or resource_title}",
                "catalog_level": "dataset",
                "title": f"{title} ({resource_title})" if resource_title.lower() not in title.lower() else title,
                "name": _clean(package.get("name") or title),
                "description": notes,
                "keywords": tags,
                "search_aliases": [title, resource_title, *tags],
                "url": str(resource.get("url")),
                "resourceUrl": str(resource.get("url")),
                "format": _clean(resource.get("format") or "").lower(),
                "protocol": "ckan",
                "provenanceUrl": str(package.get("url") or endpoint),
                "bbox": package_bbox or base.get("bbox"),
            })
            output.append(record)
    return output


def search_ckan_sources(servers: list[dict[str, Any]], query: str, *, limit: int = 10) -> tuple[list[dict[str, Any]], list[str]]:
    """Search configured CKAN portals without indexing their entire databases."""
    ckan_servers = [server for server in (servers or []) if str(server.get("type") or "").upper() == "CKAN" or "ckan" in str(server.get("url") or "").lower()]
    if not ckan_servers:
        return [], []
    output: list[dict[str, Any]] = []
    warnings: list[str] = []
    with ThreadPoolExecutor(max_workers=min(3, len(ckan_servers))) as executor:
        futures = [executor.submit(_ckan_records, server, query, limit) for server in ckan_servers]
        for future in as_completed(futures):
            try:
                output.extend(future.result())
            except Exception as exc:
                warnings.append(f"CKAN catalog unavailable: {str(exc)[:180]}")
    return output, list(dict.fromkeys(warnings))


def _deduplicate_layer_records(records: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
    """Make provider output safe for the catalog's global layer-id key.

    ArcGIS directories occasionally list the same service more than once. A
    service URL plus layer URL is the logical identity in that case. If a
    provider emits the same nominal ID for different URLs, retain both layers
    with a deterministic suffix instead of allowing one refresh to abort.
    """
    output: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    seen_logical: set[tuple[str, str, str]] = set()
    duplicates = 0
    for index, raw in enumerate(records or []):
        record = dict(raw)
        service_url = str(record.get("serviceUrl") or record.get("service_url") or "").rstrip("/").lower()
        layer_url = str(record.get("layerUrl") or record.get("layer_url") or record.get("url") or "").rstrip("/").lower()
        protocol = str(record.get("protocol") or record.get("type") or "").lower()
        logical = (protocol, service_url, layer_url)
        if service_url and layer_url and logical in seen_logical:
            duplicates += 1
            continue
        if service_url and layer_url:
            seen_logical.add(logical)
        base_id = str(record.get("id") or f"layer:{index}")
        layer_id = base_id
        if layer_id in seen_ids:
            signature = "|".join((service_url, layer_url, str(record.get("layerId") or ""), str(record.get("title") or ""), str(index)))
            layer_id = f"{base_id}:variant:{hashlib.sha1(signature.encode('utf-8')).hexdigest()[:12]}"
            suffix = 2
            while layer_id in seen_ids:
                layer_id = f"{base_id}:variant:{hashlib.sha1(signature.encode('utf-8')).hexdigest()[:10]}:{suffix}"
                suffix += 1
            duplicates += 1
        record["id"] = layer_id
        seen_ids.add(layer_id)
        output.append(record)
    return output, duplicates


class CatalogManager:
    """Persistent catalog orchestration used by the standalone service."""

    def __init__(self, repository, *, legacy_sources: list[dict[str, Any]] | None = None):
        self.repository = repository
        self._lock = __import__("threading").RLock()
        if not self.repository.list_sources() and legacy_sources:
            self.repository.import_legacy_sources(legacy_sources)

    def sources(self) -> list[dict[str, Any]]:
        return self.repository.list_sources()

    def add_source(self, source: dict[str, Any]) -> dict[str, Any]:
        return self.repository.upsert_source(source)

    def remove_source(self, source_id: str) -> bool:
        return self.repository.delete_source(source_id)

    def refresh_source(self, source_id: str) -> dict[str, Any]:
        source = self.repository.get_source(source_id)
        if not source:
            raise KeyError("catalog source not found")
        run_id = self.repository.start_run(source_id)
        self.repository.mark_source_attempt(source_id, status="refreshing", stale=True)
        try:
            _key, records, warning = _ingest_server(source)
            # A service-level fallback record is not a successful layer index.
            # Keep the previous successful layers when a provider is down.
            useful = [record for record in records if record.get("catalog_level") in {"layer", "dataset"}]
            if warning and not useful:
                self.repository.mark_source_attempt(source_id, status="error", error=warning, stale=True)
                self.repository.mark_layers_stale(source_id)
                self.repository.add_refresh_error(run_id, source_id, warning)
                self.repository.finish_run(run_id, status="error", warning=warning, error=warning)
                return {"source_id": source_id, "status": "error", "indexed_count": 0, "warning": warning, "run_id": run_id}
            records, duplicate_count = _deduplicate_layer_records(records)
            count = self.repository.replace_layers(source_id, records)
            if duplicate_count:
                duplicate_warning = f"{duplicate_count} duplicate provider layer record(s) were removed or assigned unique IDs."
                warning = "; ".join(item for item in (warning, duplicate_warning) if item)
            if warning:
                self.repository.mark_source_attempt(source_id, status="healthy_with_warnings", error=warning, stale=False)
                self.repository.add_refresh_error(run_id, source_id, warning)
            self.repository.finish_run(run_id, status="completed", indexed_count=count, warning=warning)
            return {"source_id": source_id, "status": "completed", "indexed_count": count, "warning": warning, "run_id": run_id}
        except Exception as exc:
            message = f"Catalog refresh failed: {str(exc)[:240]}"
            self.repository.mark_source_attempt(source_id, status="error", error=message, stale=True)
            self.repository.mark_layers_stale(source_id)
            self.repository.add_refresh_error(run_id, source_id, message)
            self.repository.finish_run(run_id, status="error", error=message)
            return {"source_id": source_id, "status": "error", "indexed_count": 0, "warning": message, "run_id": run_id}

    def refresh_all(self) -> dict[str, Any]:
        source_list = self.sources()
        results = []
        with ThreadPoolExecutor(max_workers=max(1, min(5, len(source_list)))) if source_list else _NullExecutor() as executor:
            futures = [executor.submit(self.refresh_source, source["id"]) for source in source_list]
            for future in as_completed(futures):
                results.append(future.result())
        return {"status": "completed", "results": results, "count": len(results)}

    def search(self, query: str, *, region: str | None = None, bbox: list[float] | None = None, limit: int = 10, protocol: str | None = None, provider: str | None = None, theme: str | None = None) -> dict[str, Any]:
        from services.region_service import coverage_status, resolve_region
        from services.semantic_search import LayerSearchIndex

        region_record = resolve_region(region) if region else resolve_region(query)
        if isinstance(bbox, dict):
            bbox = [bbox.get("south"), bbox.get("west"), bbox.get("north"), bbox.get("east")]
        requested_bbox = region_record["bbox"] if region_record else bbox
        candidates = self.repository.search_rows(query, limit=500)
        eligible = []
        outside_count = 0
        unknown_count = 0
        for record in candidates:
            if protocol and str(record.get("protocol") or "").lower() != str(protocol).lower():
                continue
            if provider and str(provider).lower() not in str(record.get("provider") or "").lower():
                continue
            status = coverage_status(record.get("bbox"), requested_bbox) if requested_bbox else ("known" if record.get("bbox") else "unknown")
            record["coverage_status"] = status
            if requested_bbox and status == "outside":
                outside_count += 1
                continue
            if requested_bbox and status == "unknown":
                unknown_count += 1
                continue
            eligible.append(record)

        index = LayerSearchIndex()
        index.build(eligible)
        results = index.search(query, limit=limit, bbox=requested_bbox, protocol=protocol, provider=provider, theme=theme)
        stale_count = 0
        for result in results:
            result["source"] = "catalog"
            result["catalog_level"] = result.get("catalog_level") or "layer"
            result["coverage_status"] = result.get("coverage_status") or "known"
            result["catalog_status"] = "stale" if result.get("stale") else "current"
            stale_count += int(bool(result.get("stale")))
        warnings = ([f"{outside_count} catalog result(s) excluded because they do not cover the requested region."] if outside_count else [])
        warnings += ([f"{unknown_count} catalog result(s) excluded because geographic coverage is unknown."] if unknown_count else [])
        if stale_count:
            warnings.append(f"{stale_count} matching catalog result(s) come from a stale provider index.")
        status = "matched" if results else "no_eligible_match"
        return {
            "query": query,
            "region": region_record,
            "layers": results,
            "count": len(results),
            "eligible_count": len(results),
            "candidate_count": len(candidates),
            "rejected_outside_count": outside_count,
            "unknown_coverage_count": unknown_count,
            "catalog_status": status,
            "search_mode": "persistent_catalog",
            "warnings": warnings,
            "workspace_updates": [{"op": "search_layers", "layers": results}],
        }


class _NullExecutor:
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def submit(self, function, *args, **kwargs):
        class Immediate:
            def result(self_inner):
                return function(*args, **kwargs)
        return Immediate()
