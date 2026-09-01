import re
import uuid

import requests

from config import REQUEST_HEADERS


VALID_FORMATS = ['geojson', 'json', 'shp', 'shapefile', 'zip', 'gpkg', 'geopackage', 'kml']


def _normalize_ckan_url(raw_url):
    url = raw_url.strip()
    if not url:
        raise ValueError('No URL provided')
    if not url.startswith(('http://', 'https://')):
        url = f'https://{url}'
    url = url.rstrip('/')
    if url.endswith('/en') or url.endswith('/fr'):
        url = url[:-3]
    return url


def _build_api_endpoint(raw_url):
    clean_url = _normalize_ckan_url(raw_url)
    if clean_url.endswith('package_search'):
        return clean_url
    if clean_url.endswith('/api/3/action'):
        return f'{clean_url}/package_search'
    return f'{clean_url}/api/3/action/package_search'


def search_ckan_portal(raw_url):
    api_endpoint = _build_api_endpoint(raw_url)
    res = requests.get(api_endpoint, params={'q': '*:*', 'rows': 1000}, headers=REQUEST_HEADERS, verify=False, timeout=20)
    res.raise_for_status()
    try:
        res_json = res.json()
    except ValueError:
        raise ValueError(f'Server returned an empty or HTML page. The API endpoint ({api_endpoint}) might be invalid or protected.')

    if not res_json.get('success'):
        raise ValueError('CKAN API returned an unsuccessful response.')

    results = res_json.get('result', {}).get('results', [])
    layers = []

    for pkg in results:
        pkg_title = pkg.get('title', 'Untitled Package')
        if isinstance(pkg_title, dict):
            pkg_title = pkg_title.get('en', pkg_title.get('fr', 'Untitled Package'))
        pkg_title = str(pkg_title).strip()

        pkg_notes = pkg.get('notes', '')
        if isinstance(pkg_notes, dict):
            pkg_notes = pkg_notes.get('en', '')

        resources_by_name = {}

        for resource in pkg.get('resources', []):
            fmt = str(resource.get('format', '')).lower().strip()
            res_url = str(resource.get('url', '')).strip()

            if any(vf in fmt or vf in res_url.lower() for vf in VALID_FORMATS):
                res_name = resource.get('name') or ''
                if isinstance(res_name, dict):
                    res_name = res_name.get('en', res_name.get('fr', ''))
                res_name = str(res_name).strip()

                clean_name = res_name.lower()
                for f in VALID_FORMATS + ['csv']:
                    clean_name = clean_name.replace(f, '').strip(' -_.()[]')

                group_key = clean_name if clean_name else pkg_title.lower()

                if 'geojson' in fmt or 'json' in fmt or '.geojson' in res_url.lower():
                    ext, disp = 'geojson', 'GEOJSON'
                elif any(x in fmt or x in res_url.lower() for x in ['gpkg', 'geopackage']):
                    ext, disp = 'gpkg', 'GPKG'
                elif any(x in fmt or x in res_url.lower() for x in ['shp', 'shapefile', 'zip']):
                    ext, disp = 'zip', 'SHP'
                elif 'kml' in fmt or '.kml' in res_url.lower():
                    ext, disp = 'kml', 'KML'
                else:
                    continue

                if group_key not in resources_by_name:
                    resources_by_name[group_key] = {'display_name': res_name, 'seen_exts': set(), 'resources': []}

                if ext not in resources_by_name[group_key]['seen_exts']:
                    resources_by_name[group_key]['resources'].append({'display': disp, 'ext': ext, 'url': res_url})
                    resources_by_name[group_key]['seen_exts'].add(ext)

        for group_key, r_data in resources_by_name.items():
            package_resources = r_data['resources']
            res_name = r_data['display_name']
            if not package_resources:
                continue

            def sort_formats(item):
                if item['display'] == 'GEOJSON':
                    return 1
                if item['display'] == 'SHP':
                    return 2
                if item['display'] == 'GPKG':
                    return 3
                if item['display'] == 'KML':
                    return 4
                return 5

            package_resources.sort(key=sort_formats)
            clean_display = res_name
            for f_str in ['geojson', 'csv', 'shp', 'shapefile', 'zip', 'gpkg', 'geopackage', 'kml', '.geojson', '.csv', '.zip', '.shp', '.gpkg', '.kml']:
                clean_display = re.compile(re.escape(f_str), re.IGNORECASE).sub('', clean_display).strip(' -_.()[]')

            if clean_display and clean_display.lower() not in pkg_title.lower() and pkg_title.lower() not in clean_display.lower():
                display_title = f'{pkg_title} ({clean_display})'
                final_name = f'{pkg_title} - {clean_display}'
            else:
                display_title = pkg_title
                final_name = pkg_title

            layers.append({
                'id': str(uuid.uuid4()),
                'title': display_title,
                'name': final_name,
                'type': 'CKAN',
                'description': str(pkg_notes),
                'resources': package_resources,
            })

    return {'success': True, 'layers': layers}
