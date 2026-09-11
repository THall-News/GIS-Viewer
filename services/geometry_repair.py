"""Repair common invalid GeoJSON polygon geometries before rendering."""
from __future__ import annotations

from typing import Any

from shapely.geometry import GeometryCollection, MultiPolygon, Polygon, mapping, shape
from shapely.geometry.polygon import orient


def _make_valid(geometry):
    try:
        from shapely import make_valid
        return make_valid(geometry)
    except (ImportError, AttributeError):
        # buffer(0) is the established fallback for older Shapely versions.
        return geometry.buffer(0)


def _polygonal(geometry):
    if isinstance(geometry, Polygon):
        return orient(geometry, sign=1.0)
    if isinstance(geometry, MultiPolygon):
        return MultiPolygon([orient(poly, sign=1.0) for poly in geometry.geoms if not poly.is_empty])
    if isinstance(geometry, GeometryCollection):
        polygons = [item for item in geometry.geoms if isinstance(item, Polygon) and not item.is_empty]
        if len(polygons) == 1:
            return orient(polygons[0], sign=1.0)
        if polygons:
            return MultiPolygon([orient(poly, sign=1.0) for poly in polygons])
    return geometry


def repair_geometry(geojson_geometry: dict[str, Any]) -> tuple[dict[str, Any], bool, str | None]:
    """Return repaired geometry, whether it changed, and a human warning."""
    if not isinstance(geojson_geometry, dict) or geojson_geometry.get("type") not in {"Polygon", "MultiPolygon"}:
        return geojson_geometry, False, None
    try:
        original = shape(geojson_geometry)
        if original.is_empty:
            raise ValueError("geometry is empty")
        fixed = _polygonal(_make_valid(original)) if not original.is_valid else _polygonal(original)
        if fixed.is_empty or fixed.geom_type not in {"Polygon", "MultiPolygon"}:
            raise ValueError("repair did not produce a polygon")
        # GEOS may refuse equality checks against an invalid source geometry;
        # invalidity itself is sufficient evidence that a repair occurred.
        changed = (not original.is_valid) or not original.equals(fixed)
        return mapping(fixed), changed, "Invalid polygon geometry was repaired before rendering." if changed else None
    except Exception as exc:
        raise ValueError(f"Invalid polygon geometry could not be repaired: {exc}") from exc


def repair_feature_collection(collection: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(collection, dict):
        raise ValueError("GeoJSON collection must be an object")
    repaired = 0
    warnings: list[str] = []
    features = []
    for feature in collection.get("features") or []:
        feature = dict(feature)
        geometry = feature.get("geometry")
        if geometry and geometry.get("type") in {"Polygon", "MultiPolygon"}:
            fixed, changed, warning = repair_geometry(geometry)
            feature["geometry"] = fixed
            if changed:
                properties = dict(feature.get("properties") or {})
                properties.pop("_geometry_invalid", None)
                properties.pop("_geometry_warning", None)
                feature["properties"] = properties
                repaired += 1
                if warning and warning not in warnings:
                    warnings.append(warning)
        features.append(feature)
    result = dict(collection, features=features)
    metadata = dict(result.get("metadata") or {})
    if repaired:
        metadata["repaired_geometry_count"] = repaired
        metadata["geometry_warnings"] = warnings
    result["metadata"] = metadata
    return result
