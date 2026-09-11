import math
import copy
import os
import re
import threading
import time

import requests

from config import GLOBAL_OVERPASS_ENDPOINTS


MAX_PROXIMITY_METERS = 25000.0
MAX_POINT_QUERY_RADIUS_METERS = 100.0
MAX_POINT_QUERY_ELEMENTS = 250
_NOMINATIM_LOCK = threading.Lock()
_NOMINATIM_CACHE = {}
_LAST_NOMINATIM_REQUEST = 0.0
_OVERPASS_RATE_LOCK = threading.Lock()
_LAST_OVERPASS_REQUEST = {}
_OVERPASS_ENDPOINTS_LOCK = threading.Lock()
_OVERPASS_CACHE_LOCK = threading.Lock()
_OVERPASS_CACHE = {}


def _escape_query_value(value):
    return str(value).replace('\\', '\\\\').replace('"', '\\"').replace('\n', ' ')


def _escape_name_pattern(value):
    """Treat user-entered names as literal text inside an Overpass regex."""
    value = re.sub(r'([\\.^$*+?{}\[\]|()])', r'\\\1', str(value).replace('\n', ' '))
    return _escape_query_value(value)


def _tag_query(tags):
    """Build a safely escaped Overpass tag selector."""
    tag_query = ''
    for tag in tags or []:
        if not isinstance(tag, dict):
            continue
        k = tag.get('key')
        v = tag.get('val')
        if k:
            if v:
                tag_query += f'["{_escape_query_value(k)}"="{_escape_query_value(v)}"]'
            else:
                tag_query += f'["{_escape_query_value(k)}"]'
    return tag_query


def _nominatim_search(query, limit=5):
    """Shared, cached, policy-compliant Nominatim lookup for generic search."""
    global _LAST_NOMINATIM_REQUEST
    key = (str(query).strip().lower(), int(limit))
    if key in _NOMINATIM_CACHE:
        return _NOMINATIM_CACHE[key]
    with _NOMINATIM_LOCK:
        wait = 1.0 - (time.monotonic() - _LAST_NOMINATIM_REQUEST)
        if wait > 0:
            time.sleep(wait)
        response = requests.get(
            'https://nominatim.openstreetmap.org/search',
            params={'q': query, 'format': 'jsonv2', 'limit': limit, 'addressdetails': 1},
            headers={
                'User-Agent': 'GIS-Layer-Previewer/1.0 (GIS Layer Previewer; contact project maintainer)',
                'Referer': 'http://localhost:5000/',
            },
            timeout=10,
        )
        _LAST_NOMINATIM_REQUEST = time.monotonic()
        response.raise_for_status()
        result = response.json() or []
        _NOMINATIM_CACHE[key] = result
        return result


def _cache_ttl(name, default='60'):
    try:
        return max(0.0, min(float(os.environ.get(name, default)), 3600.0))
    except (TypeError, ValueError):
        return float(default)


def _bbox_area_km2(bbox):
    if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
        return None
    south, west, north, east = [float(value) for value in bbox]
    width_km = abs(east - west) * 111.0 * max(math.cos(math.radians((south + north) / 2.0)), 0.01)
    height_km = abs(north - south) * 111.0
    return width_km * height_km


def build_query(tags, feat_name=None, geom_type='all', area_id=None, bbox=None, timeout_val=25, include_geometry=False, exact_name=False, way_only=False):
    tag_query = _tag_query(tags)

    if feat_name:
        name = _escape_name_pattern(feat_name)
        tag_query += f'["name"~"^{name}$",i]' if exact_name else f'["name"~"{name}",i]'

    if area_id:
        q = f"[out:json][timeout:{timeout_val}];\n"
        q += f"area({area_id})->.searchArea;\n(\n"
        if geom_type in ['all', 'points']:
            q += f"  node{tag_query}(area.searchArea);\n"
        if geom_type in ['all', 'lines_polygons']:
            q += f"  way{tag_query}(area.searchArea);\n"
            if not way_only:
                q += f"  relation{tag_query}(area.searchArea);\n"
        q += ");\n"
        q += 'out body geom;' if include_geometry else 'out body;\n>;\nout skel qt;'
        return q

    if bbox is None:
        raise ValueError('bbox is required when no area_id is supplied')

    if isinstance(bbox, (list, tuple)) and len(bbox) == 4:
        s, w, n, e = bbox
        bbox_str = f"{s},{w},{n},{e}"
        q = f"[out:json][timeout:{timeout_val}];\n(\n"
        if geom_type in ['all', 'points']:
            q += f"  node{tag_query}({bbox_str});\n"
        if geom_type in ['all', 'lines_polygons']:
            q += f"  way{tag_query}({bbox_str});\n"
            if not way_only:
                q += f"  relation{tag_query}({bbox_str});\n"
        q += ");\n"
        q += 'out body geom;' if include_geometry else 'out body;\n>;\nout skel qt;'
        return q

    raise ValueError('bbox must be a four-value [south, west, north, east] list')


def build_point_query(latitude, longitude, radius_m=25.0, timeout_val=15):
    """Build a bounded all-element query around one WGS84 coordinate."""
    try:
        latitude = float(latitude)
        longitude = float(longitude)
        radius_m = float(radius_m)
        timeout_val = int(timeout_val)
    except (TypeError, ValueError):
        raise ValueError('latitude, longitude, radius_m, and timeout must be numeric')

    if not math.isfinite(latitude) or not -90 <= latitude <= 90:
        raise ValueError('latitude must be between -90 and 90')
    if not math.isfinite(longitude) or not -180 <= longitude <= 180:
        raise ValueError('longitude must be between -180 and 180')
    if not math.isfinite(radius_m) or radius_m <= 0 or radius_m > MAX_POINT_QUERY_RADIUS_METERS:
        raise ValueError(f'radius_m must be greater than zero and no more than {int(MAX_POINT_QUERY_RADIUS_METERS)} metres')
    if timeout_val < 1 or timeout_val > 60:
        raise ValueError('timeout must be between 1 and 60 seconds')

    lat_text = f'{latitude:.7f}'
    lon_text = f'{longitude:.7f}'
    radius_text = f'{radius_m:g}'
    return (
        f'[out:json][timeout:{timeout_val}];\n'
        '(\n'
        f'  node(around:{radius_text},{lat_text},{lon_text});\n'
        f'  way(around:{radius_text},{lat_text},{lon_text});\n'
        f'  relation(around:{radius_text},{lat_text},{lon_text});\n'
        ');\n'
        'out body geom;'
    )


def search_overpass_point(latitude, longitude, radius_m=25.0, timeout_val=15, include_admin_context=False):
    """Fetch nearby OSM elements for the map context-menu inspector."""
    query = build_point_query(latitude, longitude, radius_m, timeout_val)
    res = execute_overpass_query(query, log_context='right-click OSM point query')
    if res.status_code == 504:
        raise TimeoutError('Overpass API timed out while querying the clicked point.')
    res.raise_for_status()
    payload = res.json() or {}
    elements = payload.get('elements')
    if not isinstance(elements, list):
        raise ValueError('Overpass returned an invalid elements collection')

    truncated = len(elements) > MAX_POINT_QUERY_ELEMENTS
    result = {
        'elements': elements[:MAX_POINT_QUERY_ELEMENTS],
        'metadata': {
            'source': 'OpenStreetMap',
            'attribution': '© OpenStreetMap contributors',
            'attribution_url': 'https://www.openstreetmap.org/copyright',
            'latitude': float(latitude),
            'longitude': float(longitude),
            'radius_m': float(radius_m),
            'query_timeout_s': int(timeout_val),
            'query_element_count': len(elements),
        },
        'warnings': [],
    }
    if truncated:
        result['warnings'].append(
            f'Overpass returned {len(elements)} elements; only the first {MAX_POINT_QUERY_ELEMENTS} are shown.'
        )
    if include_admin_context:
        try:
            context = search_overpass_containing_boundaries(
                latitude,
                longitude,
                admin_level=None,
                timeout_val=timeout_val,
            )
            areas = []
            for element in context.get('elements') or []:
                if not isinstance(element, dict) or element.get('type') != 'relation':
                    continue
                tags = element.get('tags') or {}
                if not isinstance(tags, dict) or tags.get('boundary') != 'administrative':
                    continue
                admin_level = str(tags.get('admin_level') or '').strip()
                if not admin_level:
                    continue
                areas.append({
                    'name': tags.get('name') or f"Relation {element.get('id')}",
                    'admin_level': admin_level,
                    'osm_type': element.get('type'),
                    'osm_id': element.get('id'),
                })

            def sort_key(area):
                try:
                    level = (0, int(area['admin_level']))
                except (TypeError, ValueError):
                    level = (1, str(area['admin_level']))
                return level + (str(area.get('name') or '').lower(),)

            result['administrative_context'] = sorted(areas, key=sort_key)
        except Exception as exc:
            result['administrative_context'] = []
            result['warnings'].append(f'Administrative context was unavailable: {exc}')
    return result


def build_element_query(element_type, element_id, timeout_val=25):
    """Build a bounded exact OSM element lookup for unnamed point results."""
    element_type = str(element_type or '').strip().lower()
    if element_type not in {'node', 'way', 'relation'}:
        raise ValueError('element_type must be node, way, or relation')
    try:
        numeric_id = int(element_id)
        timeout_val = int(timeout_val)
    except (TypeError, ValueError):
        raise ValueError('element_id and timeout must be numeric')
    if numeric_id <= 0:
        raise ValueError('element_id must be a positive integer')
    if timeout_val < 1 or timeout_val > 60:
        raise ValueError('timeout must be between 1 and 60 seconds')
    return (
        f'[out:json][timeout:{timeout_val}];\n'
        f'{element_type}({numeric_id});\n'
        'out body geom;'
    )


def search_overpass_element(element_type, element_id, timeout_val=25):
    """Fetch one exact OSM element when tags cannot identify it safely."""
    query = build_element_query(element_type, element_id, timeout_val)
    res = execute_overpass_query(query, log_context=f'exact {element_type} {element_id}')
    if res.status_code == 504:
        raise TimeoutError('Overpass API timed out while retrieving the selected OSM element.')
    res.raise_for_status()
    payload = res.json() or {}
    elements = payload.get('elements')
    if not isinstance(elements, list):
        raise ValueError('Overpass returned an invalid elements collection')
    return {
        'elements': elements,
        'metadata': {
            'source': 'OpenStreetMap',
            'attribution': '© OpenStreetMap contributors',
            'attribution_url': 'https://www.openstreetmap.org/copyright',
            'element_type': str(element_type).lower(),
            'element_id': int(element_id),
            'query_timeout_s': int(timeout_val),
            'query_mode': 'exact_element'
        },
        'warnings': []
    }


def build_containing_boundary_query(latitude, longitude, admin_level=None, timeout_val=25):
    """Build a bounded query for administrative relations containing a point."""
    try:
        latitude = float(latitude)
        longitude = float(longitude)
        timeout_val = int(timeout_val)
    except (TypeError, ValueError):
        raise ValueError('latitude, longitude, and timeout must be numeric')
    if not math.isfinite(latitude) or not -90 <= latitude <= 90:
        raise ValueError('latitude must be between -90 and 90')
    if not math.isfinite(longitude) or not -180 <= longitude <= 180:
        raise ValueError('longitude must be between -180 and 180')
    if timeout_val < 1 or timeout_val > 60:
        raise ValueError('timeout must be between 1 and 60 seconds')

    level_selector = ''
    if admin_level is not None and str(admin_level).strip():
        level = str(admin_level).strip()
        if not re.fullmatch(r'\d{1,2}', level):
            raise ValueError('admin_level must be numeric')
        level_selector = f'["admin_level"="{_escape_query_value(level)}"]'
    lat_text = f'{latitude:.7f}'
    lon_text = f'{longitude:.7f}'
    return (
        f'[out:json][timeout:{timeout_val}];\n'
        f'is_in({lat_text},{lon_text})->.containingAreas;\n'
        f'rel(pivot.containingAreas)["boundary"="administrative"]{level_selector};\n'
        'out body center;'
    )


def search_overpass_containing_boundaries(latitude, longitude, admin_level=None, timeout_val=25):
    """Return administrative relations containing the supplied WGS84 point."""
    query = build_containing_boundary_query(latitude, longitude, admin_level, timeout_val)
    res = execute_overpass_query(query, log_context='containing administrative boundary lookup')
    if res.status_code == 504:
        raise TimeoutError('Overpass API timed out while resolving the containing boundary.')
    res.raise_for_status()
    payload = res.json() or {}
    elements = payload.get('elements')
    if not isinstance(elements, list):
        raise ValueError('Overpass returned an invalid containing-boundary collection')
    return {
        'elements': elements,
        'metadata': {
            'source': 'OpenStreetMap',
            'query_mode': 'containing_boundary',
            'latitude': float(latitude),
            'longitude': float(longitude),
            'admin_level': str(admin_level) if admin_level is not None else None,
            'query_timeout_s': int(timeout_val),
        },
        'warnings': [],
    }


def build_named_way_proximity_query(
    tags,
    street_name,
    distance_m,
    *,
    geom_type='all',
    area_id=None,
    bbox=None,
    timeout_val=25,
):
    """Build a road-relative query without relying on geocoder road boxes.

    The reference road is selected inside the requested administrative area,
    then the requested OSM features are selected around the complete set of
    matching ways. This preserves the user's relation all the way to
    Overpass instead of approximating it with a city search plus a local
    projection.
    """
    if not str(street_name or '').strip():
        raise ValueError('street_name is required for a road-relative search')
    try:
        distance_m = float(distance_m)
    except (TypeError, ValueError):
        raise ValueError('distance_m must be numeric')
    if not math.isfinite(distance_m) or distance_m <= 0:
        raise ValueError('distance_m must be greater than zero')
    if distance_m > MAX_PROXIMITY_METERS:
        raise ValueError(f'distance_m cannot exceed {int(MAX_PROXIMITY_METERS)} metres')
    if not area_id and not (isinstance(bbox, (list, tuple)) and len(bbox) == 4):
        raise ValueError('area_id or bbox is required for a road-relative search')
    if geom_type not in {'all', 'points', 'lines_polygons', 'polygons'}:
        raise ValueError(f'unsupported geometry type: {geom_type}')
    if not tags:
        raise ValueError('at least one feature tag is required')

    road_name = _escape_name_pattern(street_name.strip())
    feature_selector = _tag_query(tags)
    q = f'[out:json][timeout:{int(timeout_val)}];\n'
    if area_id:
        q += f'area({int(area_id)})->.searchArea;\n'
        road_scope = '(area.searchArea)'
    else:
        south, west, north, east = [float(value) for value in bbox]
        if not (-90 <= south <= 90 and -90 <= north <= 90 and -180 <= west <= 180 and -180 <= east <= 180 and south <= north):
            raise ValueError('bbox must be [south, west, north, east] within valid coordinate ranges')
        road_scope = f'({south},{west},{north},{east})'
    q += f'way["highway"]["name"~"^{road_name}$",i]{road_scope}->.referenceRoad;\n'
    q += '(\n'
    if geom_type in {'all', 'points'}:
        q += f'  node(around.referenceRoad:{distance_m:g}){feature_selector};\n'
    if geom_type in {'all', 'lines_polygons', 'polygons'}:
        q += f'  way(around.referenceRoad:{distance_m:g}){feature_selector};\n'
        q += f'  relation(around.referenceRoad:{distance_m:g}){feature_selector};\n'
    q += ');\n'
    q += 'out body geom;'
    return q


def execute_overpass_query(query_string, log_context='query'):
    """Execute an Overpass query while emitting browser-visible diagnostics."""
    headers = {'User-Agent': 'GIS-Layer-Previewer/1.0 (Python/Requests)'}
    # Work on a per-request copy so one search cannot corrupt the shared
    # endpoint order for later searches.
    with _OVERPASS_ENDPOINTS_LOCK:
        endpoints = list(GLOBAL_OVERPASS_ENDPOINTS)

    query_bytes = len(str(query_string).encode('utf-8'))
    context = str(log_context or 'query')

    for attempt, url in enumerate(endpoints, start=1):
        started_at = time.monotonic()
        print(f'[Overpass] {context}: trying server {attempt}/{len(endpoints)} {url} ({query_bytes} query bytes)')
        try:
            # Keep public endpoint traffic bounded when several grid cells or
            # browser requests arrive concurrently. The timestamp is updated
            # before releasing the lock so parallel callers cannot burst.
            with _OVERPASS_RATE_LOCK:
                wait = 1.0 - (time.monotonic() - _LAST_OVERPASS_REQUEST.get(url, 0.0))
                if wait > 0:
                    time.sleep(wait)
                _LAST_OVERPASS_REQUEST[url] = time.monotonic()
            res = requests.post(url, data={'data': query_string}, headers=headers, timeout=45)
            elapsed = time.monotonic() - started_at
            try:
                response_bytes = len(res.content or b'')
            except (TypeError, AttributeError):
                response_bytes = '?'
            print(f'[Overpass] {context}: server response HTTP {res.status_code} from {url} after {elapsed:.1f}s ({response_bytes} response bytes)')

            if res.status_code == 429:
                print(f'[Overpass] {context}: rate limited by {url}; retrying once after 3s')
                time.sleep(3)
                res = requests.post(url, data={'data': query_string}, headers=headers, timeout=45)
                print(f'[Overpass] {context}: retry response HTTP {res.status_code} from {url}')
                if res.status_code == 429:
                    print(f'[Overpass] {context}: {url} is still rate limiting; moving to backup server')
                    continue

            if res.status_code in [500, 502, 503, 504]:
                print(f'[Overpass] {context}: server {url} returned HTTP {res.status_code}; trying backup server')
                continue

            if res.status_code == 400:
                print(f'[Overpass] {context}: bad request from {url}: {res.text}')
                return res

            with _OVERPASS_ENDPOINTS_LOCK:
                if GLOBAL_OVERPASS_ENDPOINTS and GLOBAL_OVERPASS_ENDPOINTS[0] != url:
                    GLOBAL_OVERPASS_ENDPOINTS[:] = [url] + [ep for ep in GLOBAL_OVERPASS_ENDPOINTS if ep != url]
                    print(f'[Overpass] {context}: selected {url} as the preferred server for later requests')

            print(f'[Overpass] {context}: completed successfully on {url}')

            return res
        except requests.exceptions.ConnectionError:
            elapsed = time.monotonic() - started_at
            print(f'[Overpass] {context}: connection failed for {url} after {elapsed:.1f}s; trying backup server')
            continue
        except requests.exceptions.ReadTimeout:
            elapsed = time.monotonic() - started_at
            print(f'[Overpass] {context}: server {url} timed out after {elapsed:.1f}s; trying backup server')
            continue

    raise Exception('All public Overpass servers failed, timed out, or returned errors.')


def search_overpass_near_named_way(
    tags,
    street_name,
    distance_m,
    *,
    area_id=None,
    bbox=None,
    geom_type='all',
    timeout_val=25,
):
    """Search OSM features within ``distance_m`` of every named road way."""
    query = build_named_way_proximity_query(
        tags,
        street_name,
        distance_m,
        geom_type=geom_type,
        area_id=area_id,
        bbox=bbox,
        timeout_val=timeout_val,
    )
    cache_ttl = _cache_ttl('OVERPASS_QUERY_CACHE_TTL')
    cache_key = query
    now = time.monotonic()
    if cache_ttl:
        with _OVERPASS_CACHE_LOCK:
            cached = _OVERPASS_CACHE.get(cache_key)
            if cached and now - cached[0] <= cache_ttl:
                return copy.deepcopy(cached[1])
            if cached:
                _OVERPASS_CACHE.pop(cache_key, None)
    res = execute_overpass_query(query, log_context='named road proximity query')
    if res.status_code == 504:
        raise TimeoutError('Overpass API timed out during the road-relative search.')
    res.raise_for_status()
    data = res.json()
    data['_query'] = query
    if cache_ttl:
        with _OVERPASS_CACHE_LOCK:
            _OVERPASS_CACHE[cache_key] = (time.monotonic(), copy.deepcopy(data))
    return data


def search_overpass(tags, feat_name=None, loc=None, geom_type='all', bbox=None, timeout_val=25, max_chunks=16, area_id=None, include_geometry=False, exact_name=False, way_only=False, max_area_km2=None):

    if max_area_km2 is not None:
        try:
            max_area_km2 = float(max_area_km2)
        except (TypeError, ValueError):
            raise ValueError('max_area_km2 must be numeric')
        if not math.isfinite(max_area_km2) or max_area_km2 <= 0:
            raise ValueError('max_area_km2 must be greater than zero')

    if bbox is not None:
        if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
            raise ValueError('bbox must be a four-value [south, west, north, east] list')
        try:
            bbox = [float(value) for value in bbox]
        except (TypeError, ValueError):
            raise ValueError('bbox coordinates must be numeric')
        s, w, n, e = bbox
        if not (-90 <= s <= n <= 90 and -180 <= w <= e <= 180):
            raise ValueError('bbox must be [south, west, north, east] within valid coordinate ranges')
        if max_area_km2 is not None and _bbox_area_km2(bbox) > max_area_km2:
            raise ValueError(f'Search area is {_bbox_area_km2(bbox):.2f} km², above the configured {max_area_km2:g} km² limit')

    if loc:
        try:
            nom_data = _nominatim_search(loc, limit=5)
            if not nom_data:
                raise ValueError(f'Location not found: {loc}')
            # Prefer an administrative relation/way so Overpass can use an
            # area query; point results are a bounded fallback only.
            place = next((candidate for candidate in nom_data if candidate.get('osm_type') in ['relation', 'way'] and candidate.get('class') in ['boundary', 'place']), nom_data[0])
            if place.get('osm_type') in ['relation', 'way']:
                base_id = 3600000000 if place['osm_type'] == 'relation' else 2400000000
                area_id = base_id + int(place['osm_id'])
            else:
                bb = place['boundingbox']
                bbox = [float(bb[0]), float(bb[2]), float(bb[1]), float(bb[3])]
            if max_area_km2 is not None:
                area = _bbox_area_km2(bbox or [float(place['boundingbox'][0]), float(place['boundingbox'][2]), float(place['boundingbox'][1]), float(place['boundingbox'][3])])
                if area is not None and area > max_area_km2:
                    raise ValueError(f'Search area is {area:.2f} km², above the configured {max_area_km2:g} km² limit')
        except Exception as exc:
            raise ValueError(f'Failed to geocode location with Nominatim: {str(exc)}')

    if not tags and not feat_name:
        raise ValueError('Tag key or feature name is required')

    if area_id:
        query = build_query(tags=tags, feat_name=feat_name, geom_type=geom_type, area_id=area_id, timeout_val=timeout_val, include_geometry=include_geometry, exact_name=exact_name, way_only=way_only)
        res = execute_overpass_query(query, log_context='area query')
        if res.status_code == 504:
            raise TimeoutError('Overpass API timed out. Try a more specific tag or a smaller location.')
        res.raise_for_status()
        return res.json()

    if bbox is None:
        raise ValueError('No location or map bounds provided')

    s, w, n, e = bbox
    H = max(n - s, 0.0001)
    W = max(e - w, 0.0001)
    ideal_grid_size = 0.1
    ideal_lat_steps = max(1, math.ceil(H / ideal_grid_size))
    ideal_lon_steps = max(1, math.ceil(W / ideal_grid_size))
    max_chunks = max(1, int(max_chunks))

    if ideal_lat_steps * ideal_lon_steps <= max_chunks:
        lat_steps = ideal_lat_steps
        lon_steps = ideal_lon_steps
    else:
        lat_steps = max(1, min(ideal_lat_steps, int(round(math.sqrt(max_chunks * (H / W))))))
        lon_steps = max(1, int(math.ceil(max_chunks / lat_steps)))
        while lat_steps * lon_steps > max_chunks:
            if lon_steps > 1:
                lon_steps -= 1
            elif lat_steps > 1:
                lat_steps -= 1
                lon_steps = max(1, int(math.ceil(max_chunks / lat_steps)))
            else:
                break

    total_cells = lat_steps * lon_steps
    lat_step_size = H / lat_steps
    lon_step_size = W / lon_steps
    all_elements = []
    seen_ids = set()

    print(f"\n[Overpass Grid] Slicing query into {total_cells} dynamic sub-regions (max chunks {max_chunks})...")

    for i in range(lat_steps):
        for j in range(lon_steps):
            cell_s = s + i * lat_step_size
            cell_n = cell_s + lat_step_size
            cell_w = w + j * lon_step_size
            cell_e = cell_w + lon_step_size
            cell_bbox = [cell_s, cell_w, cell_n, cell_e]
            query = build_query(tags=tags, feat_name=feat_name, geom_type=geom_type, bbox=cell_bbox, timeout_val=timeout_val, include_geometry=include_geometry, exact_name=exact_name, way_only=way_only)
            current_cell = (i * lon_steps) + j + 1
            print(f"[Overpass Grid] Fetching cell {current_cell}/{total_cells} bbox=[{cell_s:.6f}, {cell_w:.6f}, {cell_n:.6f}, {cell_e:.6f}]...")
            res = execute_overpass_query(query, log_context=f'grid cell {current_cell}/{total_cells}')
            if res.status_code == 504:
                print(f"[Overpass Grid] Cell {current_cell}/{total_cells} timed out; data may be too dense for the current chunk size.")
                raise TimeoutError(f'Overpass API timed out on grid cell {current_cell}/{total_cells}. The data is too dense for the current chunk size.')
            res.raise_for_status()
            data = res.json()
            elements_found = len(data.get('elements', []))
            print(f"[Overpass Grid] Cell {current_cell}/{total_cells} complete. Found {elements_found} elements; {len(all_elements)} unique elements accumulated before merge.")
            for el in data.get('elements', []):
                uid = f"{el['type']}_{el['id']}"
                if uid not in seen_ids:
                    seen_ids.add(uid)
                    all_elements.append(el)
            time.sleep(0.5)

    print(f"[Overpass Grid] Successfully stitched {len(all_elements)} unique elements.")
    return {'elements': all_elements}
