from concurrent.futures import ThreadPoolExecutor, as_completed
from flask import Flask, request, Response, render_template, jsonify
import requests
import json
import os
import uuid
import xml.etree.ElementTree as ET
from urllib.parse import urlparse
import urllib3
import re
import tempfile
import geopandas as gpd
import pandas as pd
import math
import time

# Suppress unverified SSL warnings for government portals
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

app = Flask(__name__)

# --- 1. ABSOLUTE PATH SETUP ---
# This guarantees it ONLY writes/reads from the exact folder your code is in
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SERVERS_FILE = os.path.join(BASE_DIR, 'gis_servers.json')
DEFAULT_SERVERS_FILE = os.path.join(BASE_DIR, 'default_servers.json')

# --- 2. DYNAMIC SEED DATA ---
if not os.path.exists(SERVERS_FILE):
    seed_data = []
    
    # Try to load the rich default data if the file exists
    if os.path.exists(DEFAULT_SERVERS_FILE):
        try:
            with open(DEFAULT_SERVERS_FILE, 'r') as f:
                seed_data = json.load(f)
            print("🌱 Initialized database with rich default servers.")
        except Exception as e:
            print(f"⚠️ Error reading default_servers.json: {e}")
            
    # Create the active database
    with open(SERVERS_FILE, 'w') as f:
        json.dump(seed_data, f, indent=2)

# --- ISO 19115 CROSSWALK DICTIONARY ---
ISO_CROSSWALK = {
    "planningCadastre": ["zoning", "parcel", "property", "landuse", "land use", "development", "permit", "land "],
    "structure": ["building", "footprint", "structure", "facility", "address", "roof", "residential", "commercial", "man_made"],
    "utilitiesCommunication": ["watermain", "sewer", "hydro", "electricity", "pipe", "utility", "waste", "power"],
    "transportation": ["bus", "train", "transit", "subway", "road", "highway", "street", "traffic", "bike", "cycling", "pedestrian", "railway"],
    "environment": ["tree", "park", "water", "river", "lake", "forest", "climate", "weather", "flood", "conservation", "wildlife", "natural", "leisure", "environment"],
    "boundaries": ["boundary", "neighborhood", "ward", "municipality", "provincial", "territorial", "electoral", "admin_level", "government"],
    "society": ["census", "population", "demograph", "income", "household", "employment", "first nation", "indigenous", "community"]
}

def fetch_server_metadata(url, server_type, user_name):
    """
    Scrapes a GIS server endpoint, extracts rich metadata, and auto-categorizes 
    themes using ISO 19115 global GIS standards.
    """
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
        "id": f"srv_{uuid.uuid4().hex[:8]}",
        "display_name": user_name,
        "name": "Unknown GIS Server",
        "provider": "Unknown Provider",
        "type": str(server_type).upper(),
        "url": url,
        "description": "No description available.",
        "themes": [],
        "geographic_extent": {
            "name": "Unknown Area",
            "bbox": None
        },
        "capabilities": {
            "supports_spatial_queries": True,
            "max_record_count": 1000
        }
    }

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json"
    }

    try:
        if metadata['type'] in ['ESRI', 'ARCGIS']:
            base_url = url.split('?')[0]
            resp = requests.get(f"{base_url}?f=json", headers=headers, timeout=10, verify=False)
            resp.raise_for_status()
            data = resp.json()

            doc_info = data.get('documentInfo') or {}
            
            # --- DIRECT MAP/FEATURE SERVER METADATA ---
            if 'layers' in data or 'type' in data:
                metadata['name'] = data.get('mapName') or data.get('name') or doc_info.get('Title') or "ESRI Server"
                raw_desc = data.get('description') or data.get('serviceDescription') or doc_info.get('Comments') or doc_info.get('Subject') or data.get('copyrightText')
                if raw_desc and str(raw_desc).strip():
                    metadata['description'] = str(raw_desc).replace('<br />', '\n').replace('<br>', '\n').strip()
                else:
                    metadata['description'] = "No description provided by the publisher."

                metadata['provider'] = doc_info.get('Author') or "Unknown Provider"
                metadata['capabilities']['max_record_count'] = data.get('maxRecordCount', 1000)

                extent = data.get('fullExtent') or data.get('initialExtent') or data.get('extent')
                if isinstance(extent, dict) and 'xmin' in extent and 'ymin' in extent:
                    metadata['geographic_extent']['bbox'] = [
                        extent['xmin'], extent['ymin'], 
                        extent['xmax'], extent['ymax']
                    ]

            # --- DIRECTORY / CATALOG METADATA (AGOL / REST Root) ---
            elif 'services' in data or 'folders' in data:
                service_count = len(data.get('services', []))
                folder_count = len(data.get('folders', []))
                
                # Derive cleaner title from URL path or user input
                path_parts = [p for p in base_url.split('/') if p and p.lower() not in ['rest', 'services', 'arcgis']]
                catalog_label = path_parts[-1] if path_parts else "ArcGIS Online"
                
                metadata['name'] = f"{catalog_label} Services Directory"
                metadata['description'] = f"ArcGIS REST Services Directory containing {service_count} services across {folder_count} folders."
                metadata['provider'] = catalog_label

        elif metadata['type'] == 'WFS':
            parsed_url = urlparse(url)
            sep = '&' if parsed_url.query else '?'
            req_url = f"{url}{sep}service=WFS&request=GetCapabilities"
            
            resp = requests.get(req_url, headers=headers, timeout=15, verify=False)
            resp.raise_for_status()
            root = ET.fromstring(resp.content)
            
            def find_text(element, tag_name):
                for el in element.iter():
                    if tag_name in el.tag:
                        return el.text
                return None

            metadata['name'] = find_text(root, 'Title') or "WFS Server"
            desc = find_text(root, 'Abstract')
            metadata['description'] = desc if desc and desc.strip() else "No description provided by publisher."
            metadata['provider'] = find_text(root, 'ProviderName') or "Unknown Provider"

            for el in root.iter():
                if 'WGS84BoundingBox' in el.tag:
                    lower = find_text(el, 'LowerCorner')
                    upper = find_text(el, 'UpperCorner')
                    if lower and upper:
                        lc_pts = [float(x) for x in lower.split()]
                        uc_pts = [float(x) for x in upper.split()]
                        if len(lc_pts) == 2 and len(uc_pts) == 2:
                            metadata['geographic_extent']['bbox'] = [
                                min(lc_pts[0], uc_pts[0]), min(lc_pts[1], uc_pts[1]),
                                max(lc_pts[0], uc_pts[0]), max(lc_pts[1], uc_pts[1])
                            ]
                    break

        elif metadata['type'] == 'CKAN':
            clean_url = url.rstrip('/')
            
            if clean_url.endswith('/en') or clean_url.endswith('/fr'):
                clean_url = clean_url[:-3]
            if '/api/3/action' in clean_url:
                clean_url = clean_url.split('/api/3/action')[0]
                
            status_url = f"{clean_url}/api/3/action/status_show"
            resp = requests.get(status_url, headers=headers, timeout=10, verify=False)
            
            if resp.ok:
                data = resp.json()
                if data.get('success'):
                    site_info = data.get('result', {})
                    metadata['name'] = site_info.get('site_title') or "CKAN Data Portal"
                    metadata['description'] = site_info.get('site_description') or "Open data portal powered by CKAN."
                else:
                    metadata['name'] = "CKAN Data Portal"
            else:
                metadata['name'] = "CKAN Data Portal"

        # --- Reverse Geocode the Bounding Box Name (For ESRI/WFS) ---
        bbox = metadata['geographic_extent']['bbox']
        if bbox and len(bbox) == 4:
            if -180 <= bbox[0] <= 180 and -90 <= bbox[1] <= 90:
                center_lon = (bbox[0] + bbox[2]) / 2
                center_lat = (bbox[1] + bbox[3]) / 2
                try:
                    nom_url = f"https://nominatim.openstreetmap.org/reverse?lat={center_lat}&lon={center_lon}&format=json&zoom=10"
                    nom_resp = requests.get(nom_url, headers={"User-Agent": "GIS-AI-Agent-Scraper"}, timeout=5, verify=False)
                    if nom_resp.ok:
                        nom_data = nom_resp.json()
                        if 'display_name' in nom_data:
                            parts = nom_data['display_name'].split(',')
                            metadata['geographic_extent']['name'] = ", ".join(parts[:2]).strip()
                except Exception:
                    pass
            else:
                metadata['geographic_extent']['name'] = "Projected Extent (Non-WGS84)"

        # --- Auto-Categorize Themes (ISO 19115) ---
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


# --- 4. ROUTES ---
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/servers', methods=['GET', 'POST'])
def handle_servers():
    if request.method == 'GET':
        if os.path.exists(SERVERS_FILE):
            with open(SERVERS_FILE, 'r') as f:
                return Response(f.read(), mimetype='application/json')
        return Response('[]', mimetype='application/json')
    
    if request.method == 'POST':
        data = request.json
        url = data.get('url')
        server_type = data.get('type')
        user_name = data.get('name') or "Custom Server"
        
        servers = []
        if os.path.exists(SERVERS_FILE):
            try:
                with open(SERVERS_FILE, 'r') as f:
                    servers = json.load(f)
            except:
                pass
        
        print(f"\n[Scraper] Fetching metadata for: {url} ({server_type})")
        enriched_server_data = fetch_server_metadata(url, server_type, user_name)

        existing_index = None
        for i, s in enumerate(servers):
            if s.get('url') == url:
                existing_index = i
                break

        if existing_index is not None:
            enriched_server_data['id'] = servers[existing_index].get('id', enriched_server_data['id'])
            servers[existing_index] = enriched_server_data
            msg = "Existing server metadata updated successfully"
        else:
            servers.append(enriched_server_data)
            msg = "New server scraped and saved"

        with open(SERVERS_FILE, 'w') as f:
            json.dump(servers, f, indent=2)
        
        return {"message": msg}, 201

@app.route('/api/ckan_search', methods=['POST'])
def ckan_search():
    data = request.json or {}
    raw_url = data.get('url', '').strip()
    if not raw_url:
        return jsonify({"error": "No URL provided"}), 400

    if not raw_url.startswith(('http://', 'https://')):
        raw_url = f"https://{raw_url}"

    clean_url = raw_url.rstrip('/')

    # --- THE FIX: Strip Canadian/Regional Language Routes ---
    if clean_url.endswith('/en') or clean_url.endswith('/fr'):
        clean_url = clean_url[:-3]

    if clean_url.endswith('package_search'):
        api_endpoint = clean_url
    elif clean_url.endswith('/api/3/action'):
        api_endpoint = f"{clean_url}/package_search"
    else:
        api_endpoint = f"{clean_url}/api/3/action/package_search"

    params = {'q': '*:*', 'rows': 1000}
    
    # --- THE FIX: Heavier Headers to Bypass Firewalls ---
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json'
    }

    try:
        res = requests.get(api_endpoint, params=params, headers=headers, verify=False, timeout=20)
        res.raise_for_status()
        
        # --- THE FIX: Safely Catch Non-JSON Responses ---
        try:
            res_json = res.json()
        except ValueError:
            return jsonify({"error": f"Server returned an empty or HTML page. The API endpoint ({api_endpoint}) might be invalid or protected."}), 500

        if not res_json.get('success'):
            return jsonify({"error": "CKAN API returned an unsuccessful response."}), 500

        results = res_json.get('result', {}).get('results', [])
        valid_formats = ['geojson', 'json', 'shp', 'shapefile', 'zip', 'gpkg', 'geopackage', 'kml']
        layers = []

        for pkg in results:
            pkg_title = pkg.get('title', 'Untitled Package')
            # Title can sometimes be a dict in bilingual portals like Canada's {"en": "...", "fr": "..."}
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
                
                if any(vf in fmt or vf in res_url.lower() for vf in valid_formats):
                    res_name = resource.get('name') or ''
                    # Resource name can also be bilingual
                    if isinstance(res_name, dict):
                        res_name = res_name.get('en', res_name.get('fr', ''))
                    res_name = str(res_name).strip()
                    
                    clean_name = res_name.lower()
                    for f in valid_formats + ['csv']:
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
                        resources_by_name[group_key] = {
                            "display_name": res_name,
                            "seen_exts": set(),
                            "resources": []
                        }
                    
                    if ext not in resources_by_name[group_key]["seen_exts"]:
                        resources_by_name[group_key]["resources"].append({
                            "display": disp,
                            "ext": ext,
                            "url": res_url
                        })
                        resources_by_name[group_key]["seen_exts"].add(ext)

            for group_key, r_data in resources_by_name.items():
                package_resources = r_data["resources"]
                res_name = r_data["display_name"]
                
                if not package_resources:
                    continue
                
                def sort_formats(r):
                    if r['display'] == 'GEOJSON': return 1
                    if r['display'] == 'SHP': return 2
                    if r['display'] == 'GPKG': return 3
                    if r['display'] == 'KML': return 4
                    return 5
                package_resources.sort(key=sort_formats)

                clean_display = res_name
                for f_str in ['geojson', 'csv', 'shp', 'shapefile', 'zip', 'gpkg', 'geopackage', 'kml', '.geojson', '.csv', '.zip', '.shp', '.gpkg', '.kml']:
                    clean_display = re.compile(re.escape(f_str), re.IGNORECASE).sub('', clean_display).strip(' -_.()[]')

                if clean_display and clean_display.lower() not in pkg_title.lower() and pkg_title.lower() not in clean_display.lower():
                    display_title = f"{pkg_title} ({clean_display})"
                    final_name = f"{pkg_title} - {clean_display}"
                else:
                    display_title = pkg_title
                    final_name = pkg_title

                layers.append({
                    "id": str(uuid.uuid4()),
                    "title": display_title,
                    "name": final_name,
                    "type": "CKAN",
                    "description": str(pkg_notes),
                    "resources": package_resources
                })

        return jsonify({"success": True, "layers": layers})

    except Exception as e:
        return jsonify({"error": f"Failed to fetch CKAN catalog: {str(e)}"}), 500

@app.route('/api/esri_search', methods=['POST'])
def esri_search():
    data = request.json or {}
    raw_url = data.get('url', '').strip()
    if not raw_url:
        return jsonify({"error": "No URL provided"}), 400

    if not raw_url.startswith(('http://', 'https://')):
        raw_url = f"https://{raw_url}"

    clean_url = raw_url.split('?')[0].rstrip('/')

    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json'
    }

    try:
        resp = requests.get(f"{clean_url}?f=json", headers=headers, verify=False, timeout=15)
        resp.raise_for_status()
        root_json = resp.json()

        layers_output = []

        # Helper to process layers inside a single MapServer / FeatureServer endpoint
        def process_service_layers(s_data, s_url, s_title, s_type, s_name_key):
            out = []
            service_layers = s_data.get('layers', [])
            if not service_layers:
                out.append({
                    "id": f"{s_name_key}_0",
                    "title": s_title,
                    "url": f"{s_url}/0",
                    "serviceUrl": s_url,
                    "layerId": 0,
                    "serverType": s_type,
                    "serviceName": s_title,
                    "parentLayerId": -1,
                    "isGroup": False,
                    "depth": 1
                })
            else:
                layer_map = {l.get('id'): l for l in service_layers}
                
                def calc_depth(l_id):
                    d = 1
                    curr = layer_map.get(l_id)
                    while curr and curr.get('parentLayerId', -1) != -1:
                        d += 1
                        curr = layer_map.get(curr.get('parentLayerId'))
                    return d

                for l in service_layers:
                    l_id = l.get('id')
                    l_name = l.get('name', f'Layer {l_id}')
                    parent_id = l.get('parentLayerId', -1)
                    sub_ids = l.get('subLayerIds')
                    is_group = bool(sub_ids and len(sub_ids) > 0) or (l.get('type') == 'Group Layer')
                    depth = calc_depth(l_id)

                    out.append({
                        "id": f"{s_name_key}_{l_id}",
                        "title": l_name,
                        "url": f"{s_url}/{l_id}",
                        "serviceUrl": s_url,
                        "layerId": l_id,
                        "serverType": s_type,
                        "serviceName": s_title,
                        "parentLayerId": parent_id,
                        "isGroup": is_group,
                        "depth": depth
                    })
            return out

        # Case 1: Direct Service Endpoint (MapServer or FeatureServer)
        if 'layers' in root_json:
            service_title = root_json.get('mapName') or root_json.get('name') or root_json.get('documentInfo', {}).get('Title') or clean_url.split('/')[-2]
            server_type = 'FeatureServer' if 'featureserver' in clean_url.lower() else 'MapServer'
            layers_output = process_service_layers(root_json, clean_url, service_title, server_type, service_title)
            return jsonify({"success": True, "layers": layers_output})

        # Case 2: Direct Single Layer Endpoint (e.g. .../FeatureServer/0)
        elif 'type' in root_json and ('geometryType' in root_json or 'fields' in root_json):
            layer_id = root_json.get('id', 0)
            layer_name = root_json.get('name', 'Layer')
            server_type = 'FeatureServer' if 'featureserver' in clean_url.lower() else 'MapServer'
            service_url = clean_url.rsplit('/', 1)[0]

            layers_output.append({
                "id": str(layer_id),
                "title": layer_name,
                "url": clean_url,
                "serviceUrl": service_url,
                "layerId": layer_id,
                "serverType": server_type,
                "serviceName": layer_name,
                "parentLayerId": -1,
                "isGroup": False,
                "depth": 1
            })
            return jsonify({"success": True, "layers": layers_output})

        # Case 3: Directory / Subfolder Catalog (AGOL / ArcGIS Server)
        # Use a dictionary to deduplicate overlapping MapServers/FeatureServers
        services_dict = {}

        if '/rest/services' in clean_url.lower():
            base_rest_url = re.split(r'/rest/services', clean_url, flags=re.IGNORECASE)[0] + '/rest/services'
        else:
            base_rest_url = clean_url

        def extract_services_from_catalog(catalog_data):
            for s in catalog_data.get('services', []):
                s_name = s.get('name', '')
                s_type = s.get('type', '')
                if s_type in ['FeatureServer', 'MapServer', 'ImageServer']:
                    s_url = f"{base_rest_url}/{s_name}/{s_type}"
                    
                    # Deduplicate: If both MapServer and FeatureServer exist, prefer FeatureServer
                    if s_name in services_dict:
                        if s_type == 'FeatureServer':
                            services_dict[s_name] = {"name": s_name, "type": s_type, "url": s_url}
                    else:
                        services_dict[s_name] = {"name": s_name, "type": s_type, "url": s_url}

        extract_services_from_catalog(root_json)

        folders = root_json.get('folders', [])
        for folder in folders:
            if clean_url.rstrip('/').lower().endswith(f"/{folder.lower()}"):
                continue

            folder_url = f"{base_rest_url}/{folder}?f=json"
            try:
                f_res = requests.get(folder_url, headers=headers, verify=False, timeout=10)
                if f_res.ok:
                    extract_services_from_catalog(f_res.json())
            except Exception:
                pass
        
        # Convert the deduplicated dictionary back into a list
        services_to_fetch = list(services_dict.values())

        if not services_to_fetch:
            return jsonify({"error": "No FeatureServer or MapServer services found in this directory."}), 404

        def fetch_service_layers(s_info):
            s_url = s_info['url']
            s_type = s_info['type']
            s_name_full = s_info['name']  # e.g., "Economy/Petroleum"
            
            try:
                res = requests.get(f"{s_url}?f=json", headers=headers, verify=False, timeout=12)
                if not res.ok:
                    return []
                s_data = res.json()
                
                # Safely grab the raw title
                doc_title = str(s_data.get('documentInfo', {}).get('Title') or '').strip()
                
                # Extract the REST folder and the base service name from the URL path
                path_parts = s_name_full.split('/')
                folder_context = path_parts[0].replace('_', ' ') if len(path_parts) > 1 else ''
                service_basename = path_parts[-1].replace('_', ' ')
                
                # Trap lazy metadata (project files, generic defaults, or overly long descriptions)
                bad_keywords = ['.aprx', '.mxd', 'untitled', 'map', 'layers']
                if not doc_title or any(kw in doc_title.lower() for kw in bad_keywords) or len(doc_title) > 60:
                    map_title = service_basename
                else:
                    map_title = doc_title

                # Combine the REST folder and the Map title for a perfect UI group name
                clean_service_title = f"{folder_context} / {map_title}" if folder_context else map_title

                return process_service_layers(s_data, s_url, clean_service_title, s_type, s_name_full)
            
            except Exception as err:
                print(f"Error fetching service {s_url}: {err}")
                return []

        with ThreadPoolExecutor(max_workers=10) as executor:
            futures = [executor.submit(fetch_service_layers, s) for s in services_to_fetch]
            for future in as_completed(futures):
                layers_output.extend(future.result())

        return jsonify({"success": True, "layers": layers_output})

    except Exception as e:
        return jsonify({"error": f"Failed to crawl ESRI Directory: {str(e)}"}), 500

@app.route('/proxy', methods=['GET'])
def proxy_download():
    """
    Safely streams large files (ZIP, CSV, GeoJSON) from external servers.
    Intercepts and converts GPKG to GeoJSON on the fly.
    """
    target_url = request.args.get('url')
    target_format = request.args.get('format', '').lower()
    
    if not target_url:
        return jsonify({"error": "No URL provided"}), 400

    try:
        req = requests.get(target_url, stream=True, timeout=30, verify=False)
        req.raise_for_status()

        # Intercept GPKGs using the explicitly passed format flag
        if 'gpkg' in target_url.lower() or target_url.endswith('.gpkg') or target_format == 'gpkg':
            with tempfile.NamedTemporaryFile(suffix='.gpkg', delete=False) as tmp:
                for chunk in req.iter_content(chunk_size=8192):
                    tmp.write(chunk)
                tmp_path = tmp.name
                
            # Convert to GeoJSON string
            gdf = gpd.read_file(tmp_path)
            
            # THE FIX: Find any datetime columns and convert them to simple text strings
            for col in gdf.columns:
                if pd.api.types.is_datetime64_any_dtype(gdf[col]):
                    gdf[col] = gdf[col].astype(str)
                elif gdf[col].dtype == 'object':
                    # Catch hidden Timestamps sitting inside generic object columns
                    gdf[col] = gdf[col].apply(lambda x: str(x) if type(x).__name__ == 'Timestamp' else x)

            geojson_data = gdf.to_json()
            os.remove(tmp_path)
            
            return Response(geojson_data, mimetype='application/json', headers={'Access-Control-Allow-Origin': '*'})

        # Standard streaming for all other formats
        def generate():
            for chunk in req.iter_content(chunk_size=8192):
                if chunk:
                    yield chunk

        headers = {
            'Content-Type': req.headers.get('Content-Type', 'application/octet-stream'),
            'Access-Control-Allow-Origin': '*'
        }
        
        return Response(generate(), headers=headers)

    except Exception as e:
        return jsonify({"error": f"Proxy download failed: {str(e)}"}), 502

@app.route('/api/overpass_search', methods=['POST'])
def overpass_search():
    data = request.json or {}
    
    # 1. Parse the tags array
    tags = data.get('tags', [])
    feat_name = data.get('featName')
    loc = data.get('loc')
    geom_type = data.get('geomType', 'all')
    bbox = data.get('bbox')
    
    # 2. Extract advanced settings
    timeout_val = data.get('timeout', 25)
    max_chunks = data.get('maxChunks', 16)
    
    if not tags:
        return jsonify({"error": "Tag key is required"}), 400
        
    # 3. Build the Overpass tag query string
    tag_query = ""
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

    headers = {'User-Agent': 'GIS-Layer-Previewer/1.0 (Python/Requests)'}
    
    area_id = None
    target_bbox = None

    if loc:
        nom_url = f"https://nominatim.openstreetmap.org/search?q={loc}&format=json&limit=1"
        try:
            nom_res = requests.get(nom_url, headers=headers, timeout=10)
            nom_res.raise_for_status()
            nom_data = nom_res.json()
            
            if not nom_data:
                return jsonify({"error": f"Location not found: {loc}"}), 404
            
            place = nom_data[0]
            if place.get('osm_type') in ['relation', 'way']:
                base_id = 3600000000 if place['osm_type'] == 'relation' else 2400000000
                area_id = base_id + int(place['osm_id'])
            else:
                bb = place['boundingbox']
                target_bbox = [float(bb[0]), float(bb[2]), float(bb[1]), float(bb[3])]
        except Exception as e:
            return jsonify({"error": "Failed to geocode location with Nominatim."}), 500
    elif bbox:
        target_bbox = [bbox['south'], bbox['west'], bbox['north'], bbox['east']]
    else:
        return jsonify({"error": "No location or map bounds provided"}), 400

    def build_query(bbox_str=None, area_str=None):
        q = f"[out:json][timeout:{timeout_val}];\n"
        if area_str:
            q += f"area({area_str})->.searchArea;\n(\n"
            if geom_type in ['all', 'points']:
                q += f"  node{tag_query}(area.searchArea);\n"
            if geom_type in ['all', 'lines_polygons']:
                q += f"  way{tag_query}(area.searchArea);\n"
                q += f"  relation{tag_query}(area.searchArea);\n"
            q += ");\n"
        else:
            q += "(\n"
            if geom_type in ['all', 'points']:
                q += f"  node{tag_query}({bbox_str});\n"
            if geom_type in ['all', 'lines_polygons']:
                q += f"  way{tag_query}({bbox_str});\n"
                q += f"  relation{tag_query}({bbox_str});\n"
            q += ");\n"
        q += "out body;\n>;\nout skel qt;"
        return q

    overpass_endpoints = [
        "https://overpass-api.de/api/interpreter",
        "https://lz4.overpass-api.de/api/interpreter",
        "https://z.overpass-api.de/api/interpreter",
        "https://overpass.kumi.systems/api/interpreter",
        "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
        "https://overpass.osm.ch/api/interpreter"
    ]

    def execute_overpass_query(query_string):
        for url in overpass_endpoints:
            try:
                res = requests.post(url, data={"data": query_string}, headers=headers, timeout=45)
                
                if res.status_code == 429:
                    print(f"  -> Rate limited by {url}! Sleeping 3s...")
                    time.sleep(3)
                    res = requests.post(url, data={"data": query_string}, headers=headers, timeout=45)
                
                if res.status_code in [500, 502, 503, 504]:
                    print(f"  -> Server {url} returned HTTP {res.status_code}. Trying backup server...")
                    continue

                if res.status_code == 400:
                    print(f"  -> Bad Request! Overpass says: {res.text}")

                return res

            except requests.exceptions.ConnectionError:
                print(f"  -> Connection refused by {url}. Trying backup server...")
                continue
            except requests.exceptions.ReadTimeout:
                print(f"  -> Server {url} timed out. Trying backup server...")
                continue
                
        raise Exception("All public Overpass servers failed, timed out, or returned errors.")

    try:
        if area_id:
            query = build_query(area_str=area_id)
            res = execute_overpass_query(query)
            
            if res.status_code == 504:
                return jsonify({"error": "Overpass API timed out. Try a more specific tag or a smaller location."}), 504
                
            res.raise_for_status()
            return jsonify(res.json())
        
        else:
            s, w, n, e = target_bbox
            
            H = max(n - s, 0.0001)
            W = max(e - w, 0.0001)

            # Ideal chunk size is ~11km (0.1 degrees)
            ideal_grid_size = 0.1
            ideal_lat_steps = max(1, math.ceil(H / ideal_grid_size))
            ideal_lon_steps = max(1, math.ceil(W / ideal_grid_size))

            # --- DYNAMIC GRID CALCULATION ---
            if ideal_lat_steps * ideal_lon_steps <= max_chunks:
                # If area is small enough, use the standard 0.1 degree chunks
                lat_steps = ideal_lat_steps
                lon_steps = ideal_lon_steps
            else:
                # If area is too massive, calculate new rows/cols to exactly hit max_chunks limit
                ratio = W / H
                lat_steps = max(1, int(round(math.sqrt(max_chunks / ratio))))
                lon_steps = max(1, int(max_chunks // lat_steps))

            total_cells = lat_steps * lon_steps
            lat_step_size = H / lat_steps
            lon_step_size = W / lon_steps
            
            all_elements = []
            seen_ids = set()
            current_cell = 0
            
            print(f"\n[Overpass Grid] Slicing query into {total_cells} dynamic sub-regions...")

            for i in range(lat_steps):
                for j in range(lon_steps):
                    current_cell += 1
                    cell_s = s + i * lat_step_size
                    cell_n = cell_s + lat_step_size
                    cell_w = w + j * lon_step_size
                    cell_e = cell_w + lon_step_size
                    
                    cell_bbox = f"{cell_s},{cell_w},{cell_n},{cell_e}"
                    query = build_query(bbox_str=cell_bbox)

                    print(f"  -> Fetching cell {current_cell}/{total_cells}...")
                    
                    res = execute_overpass_query(query)

                    if res.status_code == 504:
                         print(f"  -> Cell {current_cell} timed out! Data is too dense.")
                         return jsonify({"error": f"Overpass API timed out on grid cell {current_cell}/{total_cells}. The data is too dense for the current chunk size. Try increasing the Max Grid Chunks to slice the area smaller."}), 504

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
            return jsonify({"elements": all_elements})

    except requests.exceptions.HTTPError as err:
        return jsonify({"error": f"Overpass rejected the query (Status {err.response.status_code})."}), 500
    except Exception as err:
        return jsonify({"error": str(err)}), 500

if __name__ == '__main__':
    print(f"🚀 Writing Database to: {SERVERS_FILE}")
    app.run(debug=True, port=5000)