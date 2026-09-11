"""Safe GeoJSON spatial operations with explicit CRS handling."""
from __future__ import annotations

from typing import Any

from pyproj import CRS, Transformer
from shapely.geometry import box, shape, mapping
from shapely.ops import transform


SUPPORTED_PREDICATES = {"intersects", "within", "contains", "touches", "overlaps"}


def _source_crs(geojson: dict[str, Any]) -> tuple[CRS, list[str]]:
    crs_name = geojson.get("crs_name")
    if not crs_name and isinstance(geojson.get("crs"), dict):
        crs_properties = geojson["crs"].get("properties") or {}
        crs_name = crs_properties.get("name")
    warnings: list[str] = []
    if not crs_name:
        # Standard RFC 7946 GeoJSON uses WGS84 when no legacy CRS member is
        # supplied. Keep this compatibility assumption visible to callers.
        crs_name = "EPSG:4326"
        warnings.append("Input CRS was not declared; standard GeoJSON WGS84 (EPSG:4326) was assumed.")
    try:
        return CRS.from_user_input(crs_name), warnings
    except Exception as exc:
        raise ValueError(f"Invalid CRS '{crs_name}': {exc}") from exc


def _gdf(geojson: dict[str, Any]):
    import geopandas as gpd

    if not isinstance(geojson, dict) or geojson.get("type") != "FeatureCollection":
        raise ValueError("Spatial operations require a GeoJSON FeatureCollection")
    features = geojson.get("features") or []
    if not isinstance(features, list):
        raise ValueError("GeoJSON features must be a list")
    crs, warnings = _source_crs(geojson)
    properties: list[dict[str, Any]] = []
    geometries = []
    for index, feature in enumerate(features):
        if not isinstance(feature, dict) or not isinstance(feature.get("geometry"), dict):
            raise ValueError(f"Feature {index} has no valid geometry")
        try:
            geometry = shape(feature["geometry"])
        except Exception as exc:
            raise ValueError(f"Feature {index} has malformed geometry: {exc}") from exc
        if geometry.is_empty:
            raise ValueError(f"Feature {index} has an empty geometry")
        if not geometry.is_valid:
            raise ValueError(f"Feature {index} has invalid geometry: {geometry.is_valid_reason}")
        properties.append(dict(feature.get("properties") or {}))
        geometries.append(geometry)
    gdf = gpd.GeoDataFrame(properties, geometry=geometries, crs=crs)
    gdf.attrs["warnings"] = warnings
    gdf.attrs["source_metadata"] = dict(geojson.get("metadata") or {})
    return gdf


def _metric_crs(gdf):
    """Choose a local projected CRS suitable for metre calculations."""
    if gdf.crs is None:
        raise ValueError("A valid source CRS is required for metric calculations")
    try:
        geographic = bool(gdf.crs.is_geographic)
    except Exception:
        geographic = False
    if geographic:
        estimated = gdf.estimate_utm_crs()
        if estimated is not None:
            return estimated
        raise ValueError("Could not estimate a local projected CRS for metric calculations")
    units = {str(axis.unit_name or "").lower() for axis in gdf.crs.axis_info}
    if units & {"metre", "meter", "metres", "meters"}:
        return gdf.crs
    geographic_gdf = gdf.to_crs("EPSG:4326")
    estimated = geographic_gdf.estimate_utm_crs()
    if estimated is None:
        raise ValueError("Could not estimate a local projected CRS for metric calculations")
    return estimated


def _metric_distance(gdf, center: dict[str, Any], radius_m: float):
    import geopandas as gpd

    try:
        longitude = float(center.get("lng", center.get("lon")))
        latitude = float(center["lat"])
        radius_m = float(radius_m)
    except (KeyError, TypeError, ValueError):
        raise ValueError("distance filtering requires numeric center.lat, center.lng, and distance")
    if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
        raise ValueError("distance center coordinates are outside valid ranges")
    if radius_m <= 0:
        raise ValueError("distance must be greater than zero")
    metric_crs = _metric_crs(gdf)
    metric = gdf.to_crs(metric_crs)
    point = gpd.GeoSeries.from_xy([longitude], [latitude], crs="EPSG:4326").to_crs(metric_crs).iloc[0]
    return metric, point, metric_crs


def _target_geometry(criteria: dict[str, Any], source_crs: CRS):
    geometry_data = criteria.get("geometry")
    if geometry_data:
        try:
            target = shape(geometry_data)
        except Exception as exc:
            raise ValueError(f"Invalid target geometry: {exc}") from exc
        try:
            target_crs = CRS.from_user_input(criteria.get("geometry_crs") or "EPSG:4326")
        except Exception as exc:
            raise ValueError(f"Invalid target geometry CRS: {exc}") from exc
    else:
        values = criteria.get("bbox")
        if not isinstance(values, (list, tuple)) or len(values) != 4:
            raise ValueError("spatial relation requires geometry or bbox [south, west, north, east]")
        try:
            south, west, north, east = [float(value) for value in values]
        except (TypeError, ValueError):
            raise ValueError("bbox coordinates must be numeric")
        try:
            target_crs = CRS.from_user_input(criteria.get("bbox_crs") or "EPSG:4326")
        except Exception as exc:
            raise ValueError(f"Invalid bbox CRS: {exc}") from exc
        if target_crs.is_geographic and not (-90 <= south <= north <= 90 and -180 <= west <= east <= 180):
            raise ValueError("geographic bbox must be [south, west, north, east] within valid coordinate ranges")
        if south > north or west > east:
            raise ValueError("bbox must be ordered [south, west, north, east]")
        target = box(west, south, east, north)
    if target.is_empty or not target.is_valid:
        raise ValueError("target geometry is empty or invalid")
    if target_crs != source_crs:
        target = transform(Transformer.from_crs(target_crs, source_crs, always_xy=True).transform, target)
    return target


def _empty_metric_result(gdf, operation: str, warnings: list[str]) -> dict[str, Any]:
    warnings = [*warnings, "The source layer is empty; no metric CRS was needed."]
    metadata = {"operation": operation, "source_crs": str(gdf.crs) if gdf.crs else None, "metric_crs": None}
    return {
        "feature_collection": _geojson(gdf.copy(), metadata=metadata),
        "feature_count": 0,
        "operation": operation,
        "crs_used": str(gdf.crs) if gdf.crs else None,
        "metric_crs": None,
        "warnings": warnings,
    }


def _geojson(gdf, *, metadata: dict[str, Any] | None = None) -> dict[str, Any]:
    features = []
    for _, row in gdf.iterrows():
        geometry = row.geometry
        features.append({
            "type": "Feature",
            "geometry": mapping(geometry) if geometry is not None and not geometry.is_empty else None,
            "properties": {key: value for key, value in row.items() if key != "geometry"},
        })
    return {
        "type": "FeatureCollection",
        "features": features,
        "crs_name": str(gdf.crs) if gdf.crs else None,
        "metadata": {**(gdf.attrs.get("source_metadata") or {}), **(metadata or {})},
    }


def _spatial_join(source_gdf, target_geojson: dict[str, Any], predicate: str):
    import geopandas as gpd

    if predicate not in SUPPORTED_PREDICATES:
        raise ValueError(f"unsupported spatial join predicate: {predicate}")
    target_gdf = _gdf(target_geojson)
    if target_gdf.crs != source_gdf.crs:
        target_gdf = target_gdf.to_crs(source_gdf.crs)
    try:
        joined = gpd.sjoin(source_gdf, target_gdf, how="inner", predicate=predicate)
        target_columns = [column for column in target_gdf.columns if column != "geometry"]
        for column in target_columns:
            if f"{column}_right" in joined:
                joined[f"join_{column}"] = joined[f"{column}_right"]
            elif column in joined:
                joined[f"join_{column}"] = joined[column]
        joined = joined.drop(columns=[column for column in joined.columns if column.endswith("_right") or column == "index_right"], errors="ignore")
        return joined
    except (ImportError, ValueError):
        # A spatial-index package is optional. A deterministic pairwise
        # fallback is safe for the small in-browser layer use case.
        rows = []
        for _, source_row in source_gdf.iterrows():
            for _, target_row in target_gdf.iterrows():
                source_geometry = source_row.geometry
                target_geometry = target_row.geometry
                matches = {
                    "intersects": source_geometry.intersects(target_geometry),
                    "within": source_geometry.within(target_geometry),
                    "contains": source_geometry.contains(target_geometry),
                    "touches": source_geometry.touches(target_geometry),
                    "overlaps": source_geometry.overlaps(target_geometry),
                }
                if not matches[predicate]:
                    continue
                values = {key: value for key, value in source_row.items() if key != "geometry"}
                values.update({f"join_{key}": value for key, value in target_row.items() if key != "geometry"})
                values["geometry"] = source_geometry
                rows.append(values)
        if not rows:
            return source_gdf.iloc[0:0].copy()
        return gpd.GeoDataFrame(rows, geometry="geometry", crs=source_gdf.crs)


def operate(source: dict[str, Any], criteria: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(criteria, dict):
        raise ValueError("spatial criteria must be an object")
    gdf = _gdf(source)
    operation = str(criteria.get("operation") or criteria.get("mode") or "data").lower()
    metric_crs = None
    warnings = list(gdf.attrs.get("warnings") or [])

    if operation in {"data", "attribute"}:
        column = criteria.get("column")
        if not column or column not in gdf.columns:
            raise ValueError("attribute filtering requires an existing column")
        operator = criteria.get("operator", "in")
        value = criteria.get("value")
        values = {str(item) for item in criteria.get("values", [])}
        if operator == "in":
            mask = gdf[column].astype(str).isin(values or {str(value)})
        elif operator in {"=", "=="}:
            mask = gdf[column].astype(str) == str(value)
        elif operator == "!=":
            mask = gdf[column].astype(str) != str(value)
        elif operator in {">", ">=", "<", "<="}:
            try:
                numeric = gdf[column].astype(float)
                threshold = float(value)
            except (TypeError, ValueError):
                raise ValueError(f"attribute comparison requires numeric values for operator {operator}")
            mask = {">": numeric > threshold, ">=": numeric >= threshold, "<": numeric < threshold, "<=": numeric <= threshold}[operator]
        else:
            raise ValueError(f"unsupported attribute operator: {operator}")
        result = gdf[mask]
    elif operation in {"bbox", "intersects", "within", "contains", "touches", "overlaps"}:
        target = _target_geometry(criteria, gdf.crs)
        predicate = "intersects" if operation == "bbox" else operation
        result = gdf[gdf.geometry.apply(lambda geometry: getattr(geometry, predicate)(target))]
    elif operation in {"radius", "dwithin"}:
        if operation == "dwithin" and (criteria.get("geometry") or criteria.get("bbox")):
            try:
                distance_m = float(criteria.get("distance_m") or 0)
            except (TypeError, ValueError):
                distance_m = 0
            if distance_m <= 0:
                raise ValueError("distance_m must be greater than zero")
            if gdf.empty:
                return _empty_metric_result(gdf, operation, warnings)
            target = _target_geometry(criteria, gdf.crs)
            metric_crs = _metric_crs(gdf)
            metric = gdf.to_crs(metric_crs)
            target_metric = transform(Transformer.from_crs(gdf.crs, metric_crs, always_xy=True).transform, target)
            result = gdf[metric.geometry.distance(target_metric) <= distance_m]
        else:
            try:
                radius_km = float(criteria.get("radius_km") or 0)
            except (TypeError, ValueError):
                radius_km = 0
            if radius_km <= 0:
                raise ValueError("radius_km must be greater than zero")
            if gdf.empty:
                return _empty_metric_result(gdf, operation, warnings)
            metric, point, metric_crs = _metric_distance(gdf, criteria.get("center") or {}, radius_km * 1000.0)
            result = gdf[metric.geometry.distance(point) <= radius_km * 1000.0]
    elif operation in {"area", "length"}:
        if gdf.empty:
            return _empty_metric_result(gdf, operation, warnings)
        metric_crs = _metric_crs(gdf)
        metric = gdf.to_crs(metric_crs)
        result = gdf.copy()
        result["_area_m2" if operation == "area" else "_length_m"] = metric.area if operation == "area" else metric.length
    elif operation == "buffer":
        try:
            distance_m = float(criteria.get("distance_m") or 0)
        except (TypeError, ValueError):
            distance_m = 0
        if distance_m <= 0:
            raise ValueError("distance_m must be greater than zero")
        if gdf.empty:
            return _empty_metric_result(gdf, operation, warnings)
        metric_crs = _metric_crs(gdf)
        buffered = gdf.to_crs(metric_crs).copy()
        buffered.geometry = buffered.buffer(distance_m)
        result = buffered.to_crs(gdf.crs)
    elif operation in {"join", "sjoin", "spatial_join"}:
        target = criteria.get("target") or criteria.get("join_layer")
        if not isinstance(target, dict):
            raise ValueError("spatial join requires target or join_layer GeoJSON")
        result = _spatial_join(gdf, target, str(criteria.get("predicate") or "intersects").lower())
    else:
        raise ValueError(f"unsupported spatial operation: {operation}")

    metadata = {
        "operation": operation,
        "source_crs": str(gdf.crs) if gdf.crs else None,
        "metric_crs": str(metric_crs) if metric_crs else None,
    }
    return {
        "feature_collection": _geojson(result, metadata=metadata),
        "feature_count": len(result),
        "operation": operation,
        "crs_used": str(gdf.crs) if gdf.crs else None,
        "metric_crs": str(metric_crs) if metric_crs else None,
        "warnings": warnings,
    }
