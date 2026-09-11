"""Convert geometry-complete Overpass JSON into validated GeoJSON."""
from __future__ import annotations

from typing import Any


def _valid_point(value: Any) -> bool:
    return isinstance(value, (list, tuple)) and len(value) >= 2 and all(isinstance(n, (int, float)) for n in value[:2])


def _same_point(first: list[Any], second: list[Any], tolerance: float = 1e-9) -> bool:
    try:
        return abs(float(first[0]) - float(second[0])) <= tolerance and abs(float(first[1]) - float(second[1])) <= tolerance
    except (TypeError, ValueError, IndexError):
        return False


def _reverse_line(line: list[list[Any]]) -> list[list[Any]]:
    return list(reversed(line))


def _stitch_lines(lines: list[list[list[Any]]]) -> tuple[list[list[list[Any]]], list[list[list[Any]]]]:
    """Join relation way members without changing any coordinate values.

    Overpass returns relation members as separate ways.  A boundary ring is
    often split across many of them, so treating each member as a standalone
    line loses the polygon fill.  Endpoint joins are intentionally exact (with
    a tiny comparison tolerance); no interpolation, simplification, or
    resampling is performed.
    """
    remaining = [list(line) for line in lines if len(line) >= 2]
    rings: list[list[list[Any]]] = []
    open_lines: list[list[list[Any]]] = []
    while remaining:
        chain = remaining.pop(0)
        while not _same_point(chain[0], chain[-1]):
            match_index = None
            extension: list[list[Any]] | None = None
            prepend = False
            for index, candidate in enumerate(remaining):
                if _same_point(chain[-1], candidate[0]):
                    match_index = index
                    extension = candidate[1:]
                    break
                if _same_point(chain[-1], candidate[-1]):
                    match_index = index
                    extension = _reverse_line(candidate)[1:]
                    break
                if _same_point(chain[0], candidate[-1]):
                    match_index = index
                    extension = candidate[:-1]
                    prepend = True
                    break
                if _same_point(chain[0], candidate[0]):
                    match_index = index
                    extension = _reverse_line(candidate)[:-1]
                    prepend = True
                    break
            if match_index is None or extension is None:
                break
            remaining.pop(match_index)
            chain = extension + chain if prepend else chain + extension
        if _same_point(chain[0], chain[-1]) and len(chain) >= 4:
            rings.append(chain)
        else:
            open_lines.append(chain)
    return rings, open_lines


def _point_in_ring(point: list[Any], ring: list[list[Any]]) -> bool:
    """Small dependency-free point-in-ring test for assigning relation holes."""
    try:
        x, y = float(point[0]), float(point[1])
    except (TypeError, ValueError, IndexError):
        return False
    inside = False
    previous = ring[-1]
    for current in ring:
        try:
            x1, y1 = float(previous[0]), float(previous[1])
            x2, y2 = float(current[0]), float(current[1])
        except (TypeError, ValueError, IndexError):
            previous = current
            continue
        crosses = (y1 > y) != (y2 > y)
        if crosses:
            at_x = (x2 - x1) * (y - y1) / ((y2 - y1) or 1e-30) + x1
            if x < at_x:
                inside = not inside
        previous = current
    return inside


def _relation_polygon_geometry(element: dict[str, Any]) -> dict[str, Any] | None:
    """Build polygon geometry from complete outer/inner relation rings."""
    groups: dict[str, list[list[list[Any]]]] = {"outer": [], "inner": [], "": []}
    for member in element.get("members") or []:
        points = [
            [point.get("lon"), point.get("lat")]
            for point in (member.get("geometry") or [])
            if point.get("lat") is not None and point.get("lon") is not None
        ]
        if len(points) >= 2:
            role = str(member.get("role") or "").lower()
            groups.setdefault(role, []).append(points)

    outer_lines = groups.get("outer") or groups.get("") or []
    inner_lines = groups.get("inner") or []
    outer_rings, outer_open = _stitch_lines(outer_lines)
    inner_rings, inner_open = _stitch_lines(inner_lines)
    # If any member cannot be closed, preserve the relation as lines rather
    # than silently dropping part of its original geometry.
    if not outer_rings or outer_open or inner_open:
        return None

    polygons: list[list[list[list[Any]]]] = [[outer] for outer in outer_rings]
    for inner in inner_rings:
        containing = [
            (index, len(outer), outer)
            for index, polygon in enumerate(polygons)
            for outer in [polygon[0]]
            if _point_in_ring(inner[0], outer)
        ]
        if not containing:
            return None
        index = min(containing, key=lambda item: item[1])[0]
        polygons[index].append(inner)
    # Keep relation outputs as MultiPolygon for compatibility with the
    # established OSM import contract, including a relation with one outer
    # ring.  It still renders with a fill and accurately preserves holes.
    return {"type": "MultiPolygon", "coordinates": polygons}


def _feature(element: dict[str, Any]) -> dict[str, Any] | None:
    tags = dict(element.get("tags") or {})
    props = {**tags, "osm_type": element.get("type"), "osm_id": element.get("id")}
    if element.get("type") == "node" and element.get("lat") is not None and element.get("lon") is not None:
        geometry = {"type": "Point", "coordinates": [element["lon"], element["lat"]]}
    elif element.get("type") == "relation" and element.get("members"):
        lines = []
        for member in element["members"]:
            points = [[p.get("lon"), p.get("lat")] for p in (member.get("geometry") or []) if p.get("lat") is not None and p.get("lon") is not None]
            if len(points) >= 2:
                lines.append(points)
        if not lines:
            return None
        polygon_geometry = _relation_polygon_geometry(element)
        if polygon_geometry:
            geometry = polygon_geometry
        else:
            rings = [line for line in lines if _same_point(line[0], line[-1]) and len(line) >= 4]
            geometry = (
                {"type": "MultiPolygon", "coordinates": [[ring] for ring in rings]}
                if rings and len(rings) == len(lines)
                else {"type": "MultiLineString", "coordinates": lines}
            )
    elif element.get("center") and _valid_point([element["center"].get("lon"), element["center"].get("lat")]):
        geometry = {"type": "Point", "coordinates": [element["center"]["lon"], element["center"]["lat"]]}
    elif element.get("geometry"):
        points = [[p.get("lon"), p.get("lat")] for p in element["geometry"] if p.get("lat") is not None and p.get("lon") is not None]
        if len(points) < 2:
            return None
        geometry = {"type": "LineString", "coordinates": points}
        if element.get("type") == "way" and points[0] == points[-1] and len(points) >= 4:
            geometry = {"type": "Polygon", "coordinates": [points]}
    else:
        return None
    return {"type": "Feature", "geometry": geometry, "properties": props}


def normalize_overpass(data: dict[str, Any], *, metadata: dict[str, Any] | None = None) -> dict[str, Any]:
    if not isinstance(data, dict) or not isinstance(data.get("elements"), list):
        raise ValueError("Overpass response must contain an elements array")
    features = [feature for element in data["elements"] if isinstance(element, dict) for feature in [_feature(element)] if feature]
    if not features:
        raise ValueError("The OSM search returned no mappable features")
    geometry_types = sorted({feature["geometry"]["type"] for feature in features})
    return {
        "type": "FeatureCollection",
        "features": features,
        "metadata": {**(metadata or {}), "feature_count": len(features), "geometry_types": geometry_types},
    }
