import json
import re
import uuid
from urllib.parse import urlparse

import requests
import xml.etree.ElementTree as ET

from config import REQUEST_HEADERS

ISO_CROSSWALK = {
    'planningCadastre': ['zoning', 'parcel', 'property', 'landuse', 'land use', 'development', 'permit', 'land '],
    'structure': ['building', 'footprint', 'structure', 'facility', 'address', 'roof', 'residential', 'commercial', 'man_made'],
    'utilitiesCommunication': ['watermain', 'sewer', 'hydro', 'electricity', 'pipe', 'utility', 'waste', 'power'],
    'transportation': ['bus', 'train', 'transit', 'subway', 'road', 'highway', 'street', 'traffic', 'bike', 'cycling', 'pedestrian', 'railway'],
    'environment': ['tree', 'park', 'water', 'river', 'lake', 'forest', 'climate', 'weather', 'flood', 'conservation', 'wildlife', 'natural', 'leisure', 'environment'],
    'boundaries': ['boundary', 'neighborhood', 'ward', 'municipality', 'provincial', 'territorial', 'electoral', 'admin_level', 'government'],
    'society': ['census', 'population', 'demograph', 'income', 'household', 'employment', 'first nation', 'indigenous', 'community']
}


def _find_text(element, tag_name):
    for el in element.iter():
        if tag_name in el.tag:
            return el.text
    return None


def fetch_server_metadata(url, server_type, user_name):
    if not server_type:
        if any(keyword in url.lower() for keyword in ['arcgis', 'mapserver', 'featureserver']):
            server_type = 'ESRI'
        elif 'wfs' in url.lower():
            server_type = 'WFS'
        elif 'ckan' in url.lower() or 'open.canada' in url.lower():
            server_type = 'CKAN'
        else:
            server_type = 'ESRI'

    metadata = {
        'id': f"srv_{uuid.uuid4().hex[:8]}",
        'display_name': user_name,
        'name': 'Unknown GIS Server',
        'provider': 'Unknown Provider',
        'type': str(server_type).upper(),
        'url': url,
        'description': 'No description available.',
        'themes': [],
        'geographic_extent': {
            'name': 'Unknown Area',
            'bbox': None,
        },
        'capabilities': {
            'supports_spatial_queries': True,
            'max_record_count': 1000,
        },
    }

    try:
        if metadata['type'] in ['ESRI', 'ARCGIS']:
            base_url = url.split('?')[0]
            resp = requests.get(f"{base_url}?f=json", headers=REQUEST_HEADERS, timeout=10, verify=False)
            resp.raise_for_status()
            data = resp.json()

            doc_info = data.get('documentInfo') or {}

            if 'layers' in data or 'type' in data:
                metadata['name'] = data.get('mapName') or data.get('name') or doc_info.get('Title') or 'ESRI Server'
                raw_desc = data.get('description') or data.get('serviceDescription') or doc_info.get('Comments') or doc_info.get('Subject') or data.get('copyrightText')
                if raw_desc and str(raw_desc).strip():
                    metadata['description'] = str(raw_desc).replace('<br />', '\n').replace('<br>', '\n').strip()
                else:
                    metadata['description'] = 'No description provided by the publisher.'
                metadata['provider'] = doc_info.get('Author') or 'Unknown Provider'
                metadata['capabilities']['max_record_count'] = data.get('maxRecordCount', 1000)

                extent = data.get('fullExtent') or data.get('initialExtent') or data.get('extent')
                if isinstance(extent, dict) and 'xmin' in extent and 'ymin' in extent:
                    metadata['geographic_extent']['bbox'] = [extent['xmin'], extent['ymin'], extent['xmax'], extent['ymax']]
            elif 'services' in data or 'folders' in data:
                service_count = len(data.get('services', []))
                folder_count = len(data.get('folders', []))
                path_parts = [p for p in base_url.split('/') if p and p.lower() not in ['rest', 'services', 'arcgis']]
                catalog_label = path_parts[-1] if path_parts else 'ArcGIS Online'
                metadata['name'] = f"{catalog_label} Services Directory"
                metadata['description'] = f"ArcGIS REST Services Directory containing {service_count} services across {folder_count} folders."
                metadata['provider'] = catalog_label

        elif metadata['type'] == 'WFS':
            parsed_url = urlparse(url)
            sep = '&' if parsed_url.query else '?'
            req_url = f"{url}{sep}service=WFS&request=GetCapabilities"
            resp = requests.get(req_url, headers=REQUEST_HEADERS, timeout=15, verify=False)
            resp.raise_for_status()
            root = ET.fromstring(resp.content)

            metadata['name'] = _find_text(root, 'Title') or 'WFS Server'
            desc = _find_text(root, 'Abstract')
            metadata['description'] = desc if desc and desc.strip() else 'No description provided by publisher.'
            metadata['provider'] = _find_text(root, 'ProviderName') or 'Unknown Provider'

            for el in root.iter():
                if 'WGS84BoundingBox' in el.tag:
                    lower = _find_text(el, 'LowerCorner')
                    upper = _find_text(el, 'UpperCorner')
                    if lower and upper:
                        lc_pts = [float(x) for x in lower.split()]
                        uc_pts = [float(x) for x in upper.split()]
                        if len(lc_pts) == 2 and len(uc_pts) == 2:
                            metadata['geographic_extent']['bbox'] = [
                                min(lc_pts[0], uc_pts[0]), min(lc_pts[1], uc_pts[1]),
                                max(lc_pts[0], uc_pts[0]), max(lc_pts[1], uc_pts[1]),
                            ]
                    break

        elif metadata['type'] == 'CKAN':
            clean_url = url.rstrip('/')
            if clean_url.endswith('/en') or clean_url.endswith('/fr'):
                clean_url = clean_url[:-3]
            if '/api/3/action' in clean_url:
                clean_url = clean_url.split('/api/3/action')[0]

            status_url = f"{clean_url}/api/3/action/status_show"
            resp = requests.get(status_url, headers=REQUEST_HEADERS, timeout=10, verify=False)
            if resp.ok:
                data = resp.json()
                if data.get('success'):
                    site_info = data.get('result', {})
                    metadata['name'] = site_info.get('site_title') or 'CKAN Data Portal'
                    metadata['description'] = site_info.get('site_description') or 'Open data portal powered by CKAN.'
                else:
                    metadata['name'] = 'CKAN Data Portal'
            else:
                metadata['name'] = 'CKAN Data Portal'

        bbox = metadata['geographic_extent']['bbox']
        if bbox and len(bbox) == 4:
            if -180 <= bbox[0] <= 180 and -90 <= bbox[1] <= 90:
                center_lon = (bbox[0] + bbox[2]) / 2
                center_lat = (bbox[1] + bbox[3]) / 2
                try:
                    nom_url = f"https://nominatim.openstreetmap.org/reverse?lat={center_lat}&lon={center_lon}&format=json&zoom=10"
                    nom_resp = requests.get(nom_url, headers={'User-Agent': 'GIS-AI-Agent-Scraper'}, timeout=5, verify=False)
                    if nom_resp.ok:
                        nom_data = nom_resp.json()
                        if 'display_name' in nom_data:
                            parts = nom_data['display_name'].split(',')
                            metadata['geographic_extent']['name'] = ', '.join(parts[:2]).strip()
                except Exception:
                    pass
            else:
                metadata['geographic_extent']['name'] = 'Projected Extent (Non-WGS84)'

        text_to_scan = f"{metadata.get('name', '')} {metadata.get('description', '')}".lower()
        matched_themes = set()
        for theme, keywords in ISO_CROSSWALK.items():
            for kw in keywords:
                if kw in text_to_scan:
                    matched_themes.add(theme)
                    break
        metadata['themes'] = list(matched_themes)
        print(f"[Theme Scanner] Scanned {len(text_to_scan)} characters.")
        print(f"[Theme Scanner] Assigned Themes: {metadata['themes']}")
    except Exception as e:
        print(f"\n[Scraper Critical Error] Failed to parse {url}: {str(e)}\n")

    return metadata
