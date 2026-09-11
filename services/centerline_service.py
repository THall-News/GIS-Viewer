"""Derive river-style centerline networks from selected polygon geometry."""
from __future__ import annotations

from collections import defaultdict
from math import cos, pi, sqrt
from typing import Any

from shapely import voronoi_polygons
from shapely.geometry import GeometryCollection, LineString, MultiLineString, MultiPolygon, Point, Polygon, mapping, shape
from shapely.ops import linemerge, snap, transform, unary_union

from services.geometry_repair import repair_geometry


MAX_FEATURES = 100
MAX_COORDINATES = 250_000
MIN_BOUNDARY_SPACING_M = 1.0
MAX_BOUNDARY_SPACING_M = 12.0
MAX_BOUNDARY_POINTS = 5000
SEAM_SNAP_TOLERANCE_M = 0.75


class CenterlineError(ValueError):
    """A selected geometry cannot produce a reliable centerline."""


def _coordinate_count(value: Any) -> int:
    if not isinstance(value, list):
        return 0
    if value and isinstance(value[0], (int, float)):
        return 1
    return sum(_coordinate_count(item) for item in value)


def _validate_collection(collection: dict[str, Any]) -> list[dict[str, Any]]:
    if not isinstance(collection, dict) or collection.get("type") != "FeatureCollection":
        raise CenterlineError("geojson must be a GeoJSON FeatureCollection")
    features = collection.get("features")
    if not isinstance(features, list) or not features:
        raise CenterlineError("geojson.features must contain at least one feature")
    if len(features) > MAX_FEATURES:
        raise CenterlineError(f"centerline requests are limited to {MAX_FEATURES} features")
    if _coordinate_count(collection) > MAX_COORDINATES:
        raise CenterlineError(f"centerline geometry is limited to {MAX_COORDINATES} coordinates")
    return features


def _local_transform(origin: tuple[float, float]):
    origin_lon, origin_lat = origin
    longitude_scale = 111_320 * max(0.01, cos(origin_lat * pi / 180))
    latitude_scale = 110_574

    def forward(x, y, z=None):
        return ((x - origin_lon) * longitude_scale, (y - origin_lat) * latitude_scale)

    def inverse(x, y, z=None):
        return (origin_lon + x / longitude_scale, origin_lat + y / latitude_scale)

    return forward, inverse


def _polygonal_parts(geometry):
    if isinstance(geometry, Polygon):
        return [geometry]
    if isinstance(geometry, MultiPolygon):
        return [polygon for polygon in geometry.geoms if not polygon.is_empty]
    if isinstance(geometry, GeometryCollection):
        return [part for item in geometry.geoms for part in _polygonal_parts(item)]
    return []


def _line_parts(geometry):
    if isinstance(geometry, LineString):
        return [geometry]
    if isinstance(geometry, MultiLineString):
        return [line for line in geometry.geoms if not line.is_empty]
    if isinstance(geometry, GeometryCollection):
        return [line for item in geometry.geoms for line in _line_parts(item)]
    return []


def _boundary_points(polygon: Polygon, spacing: float) -> list[tuple[float, float]]:
    points: list[tuple[float, float]] = []
    rings = [polygon.exterior, *polygon.interiors]
    for ring in rings:
        length = ring.length
        count = max(4, int(length / spacing))
        for index in range(count):
            point = ring.interpolate(length * index / count)
            points.append((point.x, point.y))
    return points


def _node_key(coordinate: tuple[float, float], tolerance: float) -> tuple[int, int]:
    return (round(coordinate[0] / tolerance), round(coordinate[1] / tolerance))


def _extract_linework(geometry) -> list[LineString]:
    return [line for line in _line_parts(geometry) if line.length > 1e-6]


def _edge_graph(lines: list[LineString], tolerance: float):
    nodes: dict[tuple[int, int], tuple[float, float]] = {}
    edges: list[dict[str, Any]] = []
    for line in lines:
        coordinates = list(line.coords)
        for first, second in zip(coordinates, coordinates[1:]):
            first_key = _node_key(first, tolerance)
            second_key = _node_key(second, tolerance)
            if first_key == second_key:
                continue
            nodes.setdefault(first_key, (float(first[0]), float(first[1])))
            nodes.setdefault(second_key, (float(second[0]), float(second[1])))
            first_coordinate = nodes[first_key]
            second_coordinate = nodes[second_key]
            edges.append({
                "a": first_key,
                "b": second_key,
                "coords": (first_coordinate, second_coordinate),
                "length": LineString([first_coordinate, second_coordinate]).length,
            })
    return nodes, edges


def _edge_components(edges: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """Return connected edge components using the quantized graph endpoints."""
    incident: dict[tuple[int, int], list[int]] = defaultdict(list)
    for index, edge in enumerate(edges):
        incident[edge["a"]].append(index)
        incident[edge["b"]].append(index)
    seen: set[int] = set()
    components: list[list[dict[str, Any]]] = []
    for start in range(len(edges)):
        if start in seen:
            continue
        stack = [start]
        seen.add(start)
        component_indexes: list[int] = []
        while stack:
            current = stack.pop()
            component_indexes.append(current)
            edge = edges[current]
            for node in (edge["a"], edge["b"]):
                for neighbor in incident[node]:
                    if neighbor not in seen:
                        seen.add(neighbor)
                        stack.append(neighbor)
        components.append([edges[index] for index in component_indexes])
    return components


def _prune_short_terminal_branches(edges: list[dict[str, Any]], threshold: float) -> list[dict[str, Any]]:
    """Remove short leaf-to-junction branches while retaining the main network."""
    active = list(edges)
    while True:
        incident: dict[tuple[int, int], list[int]] = defaultdict(list)
        for index, edge in enumerate(active):
            incident[edge["a"]].append(index)
            incident[edge["b"]].append(index)
        junctions = {node for node, indexes in incident.items() if len(indexes) >= 3}
        if not junctions:
            return active
        removals: set[int] = set()
        for leaf, indexes in incident.items():
            if len(indexes) != 1:
                continue
            path: list[int] = []
            current = leaf
            previous_edge = None
            length = 0.0
            reached_junction = False
            while True:
                candidates = [index for index in incident.get(current, []) if index != previous_edge]
                if not candidates:
                    break
                edge_index = candidates[0]
                edge = active[edge_index]
                path.append(edge_index)
                length += edge["length"]
                next_node = edge["b"] if edge["a"] == current else edge["a"]
                if next_node in junctions:
                    reached_junction = True
                    break
                previous_edge = edge_index
                current = next_node
                if len(path) > len(active):
                    break
            if reached_junction and length < threshold:
                removals.update(path)
        if not removals:
            return active
        active = [edge for index, edge in enumerate(active) if index not in removals]


def _graph_lines(edges: list[dict[str, Any]]):
    if not edges:
        return []
    raw = [LineString(edge["coords"]) for edge in edges]
    merged = linemerge(unary_union(raw))
    return _extract_linework(merged)


def _smooth_line(line: LineString, polygon: Polygon, tolerance: float) -> LineString:
    coordinates = list(line.coords)
    if len(coordinates) < 3:
        return line
    smoothed = [coordinates[0]]
    for index in range(1, len(coordinates) - 1):
        previous = coordinates[index - 1]
        current = coordinates[index]
        following = coordinates[index + 1]
        candidate = (
            previous[0] * 0.25 + current[0] * 0.5 + following[0] * 0.25,
            previous[1] * 0.25 + current[1] * 0.5 + following[1] * 0.25,
        )
        smoothed.append(candidate if polygon.covers(Point(candidate)) else current)
    smoothed.append(coordinates[-1])
    result = LineString(smoothed)
    simplified = result.simplify(tolerance, preserve_topology=False)
    return simplified if simplified.geom_type == "LineString" and simplified.length > 1e-6 else result


def _component_centerline(polygon: Polygon):
    if polygon.is_empty or polygon.area <= 1e-8:
        raise CenterlineError("a selected polygon component is empty or too small")

    short_extent = min(polygon.minimum_rotated_rectangle.length / 4, sqrt(polygon.area))
    spacing = max(MIN_BOUNDARY_SPACING_M, min(MAX_BOUNDARY_SPACING_M, short_extent / 30))
    perimeter = polygon.length
    if perimeter / spacing > MAX_BOUNDARY_POINTS:
        spacing = perimeter / MAX_BOUNDARY_POINTS

    points = _boundary_points(polygon, spacing)
    if len(points) < 8:
        raise CenterlineError("the selected polygon does not contain enough boundary detail")

    diagram = voronoi_polygons(
        shape({"type": "MultiPoint", "coordinates": points}),
        extend_to=polygon.envelope,
        only_edges=True,
    )
    clipped = diagram.intersection(polygon)
    lines = _extract_linework(clipped)
    if not lines:
        raise CenterlineError("no interior centerline could be derived from the selected polygon")

    # Voronoi diagrams contain many short spokes that run from a boundary
    # sample to an interior junction. Prefer edges whose endpoints are
    # interior, but relax that preference if it would break the centerline
    # into disconnected pieces. The graph cleanup below removes the restored
    # terminal spokes after the main connected backbone has been recovered.
    maximum_endpoint_clearance = max(
        min(
            polygon.boundary.distance(Point(line.coords[0])),
            polygon.boundary.distance(Point(line.coords[-1])),
        )
        for line in lines
    )
    graph_tolerance = max(0.05, spacing * 0.2)
    clearance_candidates = [
        max(0.25, spacing * 0.85, maximum_endpoint_clearance * 0.55),
        max(0.25, spacing * 0.65, maximum_endpoint_clearance * 0.4),
        max(0.25, spacing * 0.35, maximum_endpoint_clearance * 0.2),
        0.0,
    ]
    edges = []
    for endpoint_clearance in clearance_candidates:
        candidate_lines = [
            line for line in lines
            if min(
                polygon.boundary.distance(Point(line.coords[0])),
                polygon.boundary.distance(Point(line.coords[-1])),
            ) >= endpoint_clearance
        ]
        _, candidate_edges = _edge_graph(candidate_lines, graph_tolerance)
        if not candidate_edges:
            continue
        components = _edge_components(candidate_edges)
        largest_length = max(sum(edge["length"] for edge in component) for component in components)
        total_length = sum(edge["length"] for edge in candidate_edges)
        edges = candidate_edges
        if len(components) == 1 or largest_length / max(total_length, 1e-9) >= 0.8:
            break
    if not edges:
        raise CenterlineError("the selected polygon produced no usable centerline edges")

    # A fragmented Voronoi result is usually boundary noise, not a second
    # river. Keep the largest connected skeleton before branch pruning.
    edge_components = _edge_components(edges)
    edges = max(edge_components, key=lambda component: sum(edge["length"] for edge in component))

    initial_network_lines = _graph_lines(edges)
    longest_network_line = max((line.length for line in initial_network_lines), default=0.0)
    prune_threshold = max(spacing * 2.5, min(100.0, longest_network_line * 0.1))
    pruned_edges = _prune_short_terminal_branches(edges, prune_threshold)
    if not pruned_edges:
        pruned_edges = edges

    network_lines = _graph_lines(pruned_edges)
    if not network_lines:
        raise CenterlineError("centerline network collapsed during cleanup")

    smoothing_tolerance = max(0.1, min(spacing * 0.45, short_extent * 0.04))
    smoothed_lines = [_smooth_line(line, polygon, smoothing_tolerance) for line in network_lines]
    smoothed_lines = [line for line in smoothed_lines if line.length > max(0.1, spacing * 0.5)]
    if not smoothed_lines:
        raise CenterlineError("centerline network collapsed during smoothing")

    geometry = smoothed_lines[0] if len(smoothed_lines) == 1 else MultiLineString(smoothed_lines)
    return geometry, {
        "centerline_method": "Voronoi medial-axis network with adaptive sampling and mild smoothing",
        "centerline_branch_count": max(0, len(smoothed_lines) - 1),
        "centerline_sample_spacing_m": round(spacing, 3),
        "centerline_smoothing_tolerance_m": round(smoothing_tolerance, 3),
    }


def _feature_properties(features: list[dict[str, Any]], component_index: int, fragment_count: int, details: dict[str, Any]):
    properties: dict[str, Any] = {}
    source_ids: list[str] = []
    for feature in features:
        properties.update({key: value for key, value in (feature.get("properties") or {}).items() if key not in properties})
        if feature.get("id") is not None:
            source_ids.append(str(feature["id"]))
    properties.update({
        "geometry_type": "centerline",
        "centerline_component_id": component_index,
        "centerline_source_fragment_count": fragment_count,
        **details,
    })
    if source_ids:
        properties["centerline_source_feature_ids"] = sorted(set(source_ids))
    return properties


def centerline_feature_collection(collection: dict[str, Any], options: dict[str, Any] | None = None) -> dict[str, Any]:
    features = _validate_collection(collection)
    options = options or {}
    if options.get("fidelity", "adaptive") != "adaptive":
        raise CenterlineError("only adaptive centerline fidelity is supported")
    if options.get("preserve_branches", True) is not True:
        raise CenterlineError("centerline branch preservation is required")

    polygon_features: list[dict[str, Any]] = []
    projected_polygons = []
    output_features: list[dict[str, Any]] = []
    warnings: list[str] = []

    for feature in features:
        if not isinstance(feature, dict) or feature.get("type") != "Feature":
            raise CenterlineError("each item must be a GeoJSON Feature")
        geometry_data = feature.get("geometry")
        if not isinstance(geometry_data, dict):
            raise CenterlineError("each feature must contain a geometry")
        geometry_type = geometry_data.get("type")
        if geometry_type in {"LineString", "MultiLineString"}:
            geometry = shape(geometry_data)
            if geometry.is_empty or geometry.length <= 1e-8:
                raise CenterlineError("a selected line geometry is empty")
            properties = dict(feature.get("properties") or {})
            properties.update({
                "geometry_type": "centerline",
                "centerline_method": "existing line geometry",
                "centerline_branch_count": 0,
            })
            output_features.append({"type": "Feature", "id": feature.get("id"), "properties": properties, "geometry": mapping(geometry)})
            continue
        if geometry_type not in {"Polygon", "MultiPolygon"}:
            raise CenterlineError(f"unsupported centerline geometry type: {geometry_type or 'missing'}")
        repaired, changed, warning = repair_geometry(geometry_data)
        if changed and warning and warning not in warnings:
            warnings.append(warning)
        polygon = shape(repaired)
        polygon_features.append(feature)
        projected_polygons.append(polygon)

    if projected_polygons:
        merged = unary_union(projected_polygons)
        merged_parts = _polygonal_parts(merged)
        if not merged_parts:
            raise CenterlineError("selected polygons did not produce a polygonal area")
        origin_point = merged.centroid
        forward, inverse = _local_transform((origin_point.x, origin_point.y))
        local_parts = [transform(forward, part) for part in merged_parts]
        local_source_parts = [transform(forward, part) for part in projected_polygons]

        # Round projected coordinates before dissolving to eliminate tiny
        # vector-tile seam differences without materially changing the shape.
        local_reference = unary_union(local_parts)
        local_parts = [snap(part, local_reference, SEAM_SNAP_TOLERANCE_M) for part in local_parts]
        try:
            from shapely import set_precision
            local_union = unary_union([set_precision(part, 0.01) for part in local_parts], grid_size=0.01)
        except (ImportError, TypeError):
            local_union = unary_union(local_parts)

        local_components = _polygonal_parts(local_union)
        if not local_components:
            raise CenterlineError("selected polygons did not produce usable connected components")
        for index, component in enumerate(local_components, start=1):
            centerline, details = _component_centerline(component)
            geojson_geometry = mapping(transform(inverse, centerline))
            component_features = [
                feature for feature, source_part in zip(polygon_features, local_source_parts)
                if component.intersects(source_part) or component.distance(source_part) <= SEAM_SNAP_TOLERANCE_M
            ] or polygon_features
            fragment_count = sum(
                max(1, int((feature.get("properties") or {}).get("selected_fragment_count", 1)))
                for feature in component_features
            )
            output_features.append({
                "type": "Feature",
                "id": f"centerline-{index}",
                "properties": _feature_properties(component_features, index, fragment_count, details),
                "geometry": geojson_geometry,
            })

    if not output_features:
        raise CenterlineError("no centerline geometry could be derived")

    metadata = dict(collection.get("metadata") or {})
    metadata.update({
        "centerline_method": "Voronoi medial-axis network with adaptive sampling and mild smoothing",
        "centerline_component_count": len(output_features),
        "centerline_source_feature_count": len(features),
        "centerline_polygon_component_count": len([feature for feature in output_features if feature.get("properties", {}).get("geometry_type") == "centerline"]),
    })
    if warnings:
        metadata["geometry_warnings"] = warnings
    return {
        "geojson": {"type": "FeatureCollection", "metadata": metadata, "features": output_features},
        "warnings": warnings,
    }
