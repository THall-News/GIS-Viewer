import math
import time

import requests

from config import GLOBAL_OVERPASS_ENDPOINTS


def build_query(tags, feat_name=None, geom_type='all', area_id=None, bbox=None, timeout_val=25):
    tag_query = ''
    for tag in tags:
        k = tag.get('key')
        v = tag.get('val')
        if k:
            if v:
                tag_query += f'["{k}"="{v}"]'
            else:
                tag_query += f'["{k}"]'

    if feat_name:
        tag_query += f'["name"~"{feat_name}",i]'

    if area_id:
        q = f"[out:json][timeout:{timeout_val}];\n"
        q += f"area({area_id})->.searchArea;\n(\n"
        if geom_type in ['all', 'points']:
            q += f"  node{tag_query}(area.searchArea);\n"
        if geom_type in ['all', 'lines_polygons']:
            q += f"  way{tag_query}(area.searchArea);\n"
            q += f"  relation{tag_query}(area.searchArea);\n"
        q += ");\n"
        q += 'out body;\n>;\nout skel qt;'
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
            q += f"  relation{tag_query}({bbox_str});\n"
        q += ");\n"
        q += 'out body;\n>;\nout skel qt;'
        return q

    raise ValueError('bbox must be a four-value [south, west, north, east] list')


def execute_overpass_query(query_string):
    headers = {'User-Agent': 'GIS-Layer-Previewer/1.0 (Python/Requests)'}
    # Work on a per-request copy so one search cannot corrupt the shared
    # endpoint order for later searches.
    endpoints = list(GLOBAL_OVERPASS_ENDPOINTS)

    for url in endpoints:
        try:
            res = requests.post(url, data={'data': query_string}, headers=headers, timeout=45)

            if res.status_code == 429:
                print(f'  -> Rate limited by {url}! Sleeping 3s...')
                time.sleep(3)
                res = requests.post(url, data={'data': query_string}, headers=headers, timeout=45)
                if res.status_code == 429:
                    print(f'  -> {url} is still rate limiting. Skipping to backup server...')
                    continue

            if res.status_code in [500, 502, 503, 504]:
                print(f'  -> Server {url} returned HTTP {res.status_code}. Trying backup server...')
                continue

            if res.status_code == 400:
                print(f'  -> Bad Request! Overpass says: {res.text}')
                return res

            if GLOBAL_OVERPASS_ENDPOINTS and GLOBAL_OVERPASS_ENDPOINTS[0] != url:
                GLOBAL_OVERPASS_ENDPOINTS[:] = [url] + [ep for ep in GLOBAL_OVERPASS_ENDPOINTS if ep != url]
                print(f'  -> ⭐ Bumping known-good server to top: {url}')

            return res
        except requests.exceptions.ConnectionError:
            print(f'  -> Connection refused by {url}. Trying backup server...')
            continue
        except requests.exceptions.ReadTimeout:
            print(f'  -> Server {url} timed out. Trying backup server...')
            continue

    raise Exception('All public Overpass servers failed, timed out, or returned errors.')


def search_overpass(tags, feat_name=None, loc=None, geom_type='all', bbox=None, timeout_val=25, max_chunks=16, area_id=None):
    headers = {'User-Agent': 'GIS-Layer-Previewer/1.0 (Python/Requests)'}

    if loc:
        nom_url = f"https://nominatim.openstreetmap.org/search?q={loc}&format=json&limit=1"
        try:
            nom_res = requests.get(nom_url, headers=headers, timeout=10)
            nom_res.raise_for_status()
            nom_data = nom_res.json()
            if not nom_data:
                raise ValueError(f'Location not found: {loc}')
            place = nom_data[0]
            if place.get('osm_type') in ['relation', 'way']:
                base_id = 3600000000 if place['osm_type'] == 'relation' else 2400000000
                area_id = base_id + int(place['osm_id'])
            else:
                bb = place['boundingbox']
                bbox = [float(bb[0]), float(bb[2]), float(bb[1]), float(bb[3])]
        except Exception as exc:
            raise ValueError(f'Failed to geocode location with Nominatim: {str(exc)}')

    if not tags:
        raise ValueError('Tag key is required')

    if area_id:
        query = build_query(tags=tags, feat_name=feat_name, geom_type=geom_type, area_id=area_id, timeout_val=timeout_val)
        res = execute_overpass_query(query)
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

    print(f"\n[Overpass Grid] Slicing query into {total_cells} dynamic sub-regions...")

    for i in range(lat_steps):
        for j in range(lon_steps):
            cell_s = s + i * lat_step_size
            cell_n = cell_s + lat_step_size
            cell_w = w + j * lon_step_size
            cell_e = cell_w + lon_step_size
            cell_bbox = [cell_s, cell_w, cell_n, cell_e]
            query = build_query(tags=tags, feat_name=feat_name, geom_type=geom_type, bbox=cell_bbox, timeout_val=timeout_val)
            current_cell = (i * lon_steps) + j + 1
            print(f"  -> Fetching cell {current_cell}/{total_cells}...")
            res = execute_overpass_query(query)
            if res.status_code == 504:
                print(f"  -> Cell {current_cell} timed out! Data is too dense.")
                raise TimeoutError(f'Overpass API timed out on grid cell {current_cell}/{total_cells}. The data is too dense for the current chunk size.')
            res.raise_for_status()
            data = res.json()
            elements_found = len(data.get('elements', []))
            print(f"  -> Cell {current_cell} complete. Found {elements_found} elements.")
            for el in data.get('elements', []):
                uid = f"{el['type']}_{el['id']}"
                if uid not in seen_ids:
                    seen_ids.add(uid)
                    all_elements.append(el)
            time.sleep(0.5)

    print(f"[Overpass Grid] Successfully stitched {len(all_elements)} unique elements.")
    return {'elements': all_elements}
