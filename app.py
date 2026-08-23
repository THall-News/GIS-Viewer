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

        # --- Reverse Geocode the Bounding Box Name ---
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

    if clean_url.endswith('package_search'):
        api_endpoint = clean_url
    elif clean_url.endswith('/api/3/action'):
        api_endpoint = f"{clean_url}/package_search"
    else:
        api_endpoint = f"{clean_url}/api/3/action/package_search"

    params = {'q': '*:*', 'rows': 1000}
    headers = {'User-Agent': 'Mozilla/5.0'}

    try:
        res = requests.get(api_endpoint, params=params, headers=headers, verify=False, timeout=20)
        res.raise_for_status()
        res_json = res.json()

        if not res_json.get('success'):
            return jsonify({"error": "CKAN API returned an unsuccessful response."}), 500

        results = res_json.get('result', {}).get('results', [])
        valid_formats = ['geojson', 'json', 'shp', 'shapefile', 'zip', 'gpkg', 'geopackage', 'kml']
        layers = []

        for pkg in results:
            pkg_title = pkg.get('title', 'Untitled Package').strip()
            pkg_notes = pkg.get('notes', '')
            
            resources_by_name = {}

            for resource in pkg.get('resources', []):
                fmt = str(resource.get('format', '')).lower().strip()
                res_url = str(resource.get('url', '')).strip()
                
                if any(vf in fmt or vf in res_url.lower() for vf in valid_formats):
                    res_name = str(resource.get('name') or '').strip()
                    
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

                # STRIP format extensions out of the raw resource name for BOTH title and filename
                clean_display = res_name
                for f_str in ['geojson', 'csv', 'shp', 'shapefile', 'zip', 'gpkg', 'geopackage', 'kml', '.geojson', '.csv', '.zip', '.shp', '.gpkg', '.kml']:
                    clean_display = re.compile(re.escape(f_str), re.IGNORECASE).sub('', clean_display).strip(' -_.()[]')

                if clean_display and clean_display.lower() not in pkg_title.lower() and pkg_title.lower() not in clean_display.lower():
                    display_title = f"{pkg_title} ({clean_display})"
                    # Use the clean_display as the final backend name
                    final_name = f"{pkg_title} - {clean_display}"
                else:
                    display_title = pkg_title
                    final_name = pkg_title

                layers.append({
                    "id": str(uuid.uuid4()),
                    "title": display_title,
                    "name": final_name,  # <--- Cleaned name passed to the frontend
                    "type": "CKAN",
                    "description": pkg_notes,
                    "resources": package_resources
                })

        return jsonify({"success": True, "layers": layers})

    except Exception as e:
        return jsonify({"error": f"Failed to fetch CKAN catalog: {str(e)}"}), 500

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

if __name__ == '__main__':
    print(f"🚀 Writing Database to: {SERVERS_FILE}")
    app.run(debug=True, port=5000)