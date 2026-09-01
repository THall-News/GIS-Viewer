import re
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

from config import REQUEST_HEADERS


def _process_service_layers(s_data, s_url, s_title, s_type, s_name_key):
    out = []
    service_layers = s_data.get('layers', [])
    if not service_layers:
        out.append({
            'id': f'{s_name_key}_0',
            'title': s_title,
            'url': f'{s_url}/0',
            'serviceUrl': s_url,
            'layerId': 0,
            'serverType': s_type,
            'serviceName': s_title,
            'parentLayerId': -1,
            'isGroup': False,
            'depth': 1,
        })
        return out

    layer_map = {layer.get('id'): layer for layer in service_layers}

    def calc_depth(layer_id):
        depth = 1
        curr = layer_map.get(layer_id)
        while curr and curr.get('parentLayerId', -1) != -1:
            depth += 1
            curr = layer_map.get(curr.get('parentLayerId'))
        return depth

    for layer in service_layers:
        layer_id = layer.get('id')
        layer_name = layer.get('name', f'Layer {layer_id}')
        parent_id = layer.get('parentLayerId', -1)
        sub_ids = layer.get('subLayerIds')
        is_group = bool(sub_ids and len(sub_ids) > 0) or (layer.get('type') == 'Group Layer')
        depth = calc_depth(layer_id)
        out.append({
            'id': f'{s_name_key}_{layer_id}',
            'title': layer_name,
            'url': f'{s_url}/{layer_id}',
            'serviceUrl': s_url,
            'layerId': layer_id,
            'serverType': s_type,
            'serviceName': s_title,
            'parentLayerId': parent_id,
            'isGroup': is_group,
            'depth': depth,
        })
    return out


def search_esri_portal(raw_url):
    clean_url = raw_url.strip()
    if not clean_url:
        raise ValueError('No URL provided')
    if not clean_url.startswith(('http://', 'https://')):
        clean_url = f'https://{clean_url}'
    clean_url = clean_url.split('?')[0].rstrip('/')

    try:
        resp = requests.get(f'{clean_url}?f=json', headers=REQUEST_HEADERS, verify=False, timeout=15)
        resp.raise_for_status()
        root_json = resp.json()

        layers_output = []

        if 'layers' in root_json:
            service_title = root_json.get('mapName') or root_json.get('name') or root_json.get('documentInfo', {}).get('Title') or clean_url.split('/')[-2]
            server_type = 'FeatureServer' if 'featureserver' in clean_url.lower() else 'MapServer'
            layers_output = _process_service_layers(root_json, clean_url, service_title, server_type, service_title)
            return {'success': True, 'layers': layers_output}

        if 'type' in root_json and ('geometryType' in root_json or 'fields' in root_json):
            layer_id = root_json.get('id', 0)
            layer_name = root_json.get('name', 'Layer')
            server_type = 'FeatureServer' if 'featureserver' in clean_url.lower() else 'MapServer'
            service_url = clean_url.rsplit('/', 1)[0]
            layers_output.append({
                'id': str(layer_id),
                'title': layer_name,
                'url': clean_url,
                'serviceUrl': service_url,
                'layerId': layer_id,
                'serverType': server_type,
                'serviceName': layer_name,
                'parentLayerId': -1,
                'isGroup': False,
                'depth': 1,
            })
            return {'success': True, 'layers': layers_output}

        services_dict = {}
        if '/rest/services' in clean_url.lower():
            base_rest_url = re.split(r'/rest/services', clean_url, flags=re.IGNORECASE)[0] + '/rest/services'
        else:
            base_rest_url = clean_url

        def extract_services_from_catalog(catalog_data):
            for service in catalog_data.get('services', []):
                s_name = service.get('name', '')
                s_type = service.get('type', '')
                if s_type in ['FeatureServer', 'MapServer', 'ImageServer']:
                    s_url = f"{base_rest_url}/{s_name}/{s_type}"
                    if s_name in services_dict:
                        if s_type == 'FeatureServer':
                            services_dict[s_name] = {'name': s_name, 'type': s_type, 'url': s_url}
                    else:
                        services_dict[s_name] = {'name': s_name, 'type': s_type, 'url': s_url}

        extract_services_from_catalog(root_json)

        for folder in root_json.get('folders', []):
            if clean_url.rstrip('/').lower().endswith(f"/{folder.lower()}"):
                continue
            folder_url = f'{base_rest_url}/{folder}?f=json'
            try:
                f_res = requests.get(folder_url, headers=REQUEST_HEADERS, verify=False, timeout=10)
                if f_res.ok:
                    extract_services_from_catalog(f_res.json())
            except Exception:
                pass

        services_to_fetch = list(services_dict.values())
        if not services_to_fetch:
            raise ValueError('No FeatureServer or MapServer services found in this directory.')

        def fetch_service_layers(s_info):
            s_url = s_info['url']
            s_type = s_info['type']
            s_name_full = s_info['name']
            try:
                res = requests.get(f'{s_url}?f=json', headers=REQUEST_HEADERS, verify=False, timeout=12)
                if not res.ok:
                    return []
                s_data = res.json()
                doc_title = str(s_data.get('documentInfo', {}).get('Title') or '').strip()
                path_parts = s_name_full.split('/')
                folder_context = path_parts[0].replace('_', ' ') if len(path_parts) > 1 else ''
                service_basename = path_parts[-1].replace('_', ' ')
                bad_keywords = ['.aprx', '.mxd', 'untitled', 'map', 'layers']
                if not doc_title or any(kw in doc_title.lower() for kw in bad_keywords) or len(doc_title) > 60:
                    map_title = service_basename
                else:
                    map_title = doc_title
                clean_service_title = f'{folder_context} / {map_title}' if folder_context else map_title
                return _process_service_layers(s_data, s_url, clean_service_title, s_type, s_name_full)
            except Exception as err:
                print(f'Error fetching service {s_url}: {err}')
                return []

        with ThreadPoolExecutor(max_workers=10) as executor:
            futures = [executor.submit(fetch_service_layers, s) for s in services_to_fetch]
            for future in as_completed(futures):
                layers_output.extend(future.result())

        return {'success': True, 'layers': layers_output}
    except Exception as exc:
        raise ValueError(f'Failed to crawl ESRI Directory: {str(exc)}')
