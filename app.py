from flask import Flask, request, Response, render_template
import requests
import json
import os
import uuid
import xml.etree.ElementTree as ET
from urllib.parse import urlparse

app = Flask(__name__)

SERVERS_FILE = 'gis_servers.json'

# --- 1. DEFAULT SEED DATA ---
if not os.path.exists(SERVERS_FILE):
    with open(SERVERS_FILE, 'w') as f:
        json.dump([
            {"name": "Environment Canada GeoMet (WFS)", "url": "https://geo.weather.gc.ca/geomet", "type": "WFS"},
            {"name": "City of Toronto Geospatial (ESRI FeatureServer)", "url": "https://gis.toronto.ca/arcgis/rest/services/cot_geospatial2/FeatureServer", "type": "ESRI"},
            {"name": "Statistics Canada 2021 Census Boundaries (ESRI)", "url": "https://services.arcgis.com/lGOekm0RsNxYnT3j/arcgis/rest/services/Generalized_2021_Statistics_Canada_census_boundaries/FeatureServer", "type": "ESRI"},
            {"name": "Canada Provinces and Territories (ESRI)", "url": "https://services5.arcgis.com/Mze3GM5YlDfcAPOn/ArcGIS/rest/services/Provinces_and_Territories_of_Canada/FeatureServer", "type": "ESRI"}
        ], f, indent=2)

# --- 2. SMART SCRAPER FUNCTION ---
def fetch_server_metadata(url, server_type):
    """
    Scrapes a GIS server endpoint. Bypasses strict SSL checks common with 
    government servers, and aggressively searches for ESRI metadata.
    """
    metadata = {
        "id": f"srv_{uuid.uuid4().hex[:8]}",
        "name": "Unknown GIS Server",
        "provider": "Unknown Provider",
        "type": server_type.upper(),
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
        if server_type.upper() == 'ESRI':
            base_url = url.split('?')[0]
            resp = requests.get(f"{base_url}?f=json", headers=headers, timeout=10, verify=False)
            resp.raise_for_status()
            data = resp.json()

            # FIX: If documentInfo is explicitly null, force it to be an empty dictionary
            doc_info = data.get('documentInfo') or {}
            
            metadata['name'] = data.get('mapName') or data.get('name') or doc_info.get('Title') or "ESRI Server"
            
            raw_desc = data.get('description') or data.get('serviceDescription') or doc_info.get('Comments') or doc_info.get('Subject') or data.get('copyrightText')
            if raw_desc and str(raw_desc).strip():
                clean_desc = str(raw_desc).replace('<br />', '\n').replace('<br>', '\n')
                metadata['description'] = clean_desc.strip()
            else:
                metadata['description'] = "No description provided by the publisher."

            metadata['provider'] = doc_info.get('Author') or "Unknown Provider"
            metadata['capabilities']['max_record_count'] = data.get('maxRecordCount', 1000)

            extent = data.get('fullExtent') or data.get('initialExtent') or data.get('extent')
            if extent and 'xmin' in extent and 'ymin' in extent:
                metadata['geographic_extent']['bbox'] = [
                    extent['xmin'], extent['ymin'], 
                    extent['xmax'], extent['ymax']
                ]

        elif server_type.upper() == 'WFS':
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

    except Exception as e:
        print(f"\n[Scraper Critical Error] Failed to parse {url}: {str(e)}\n")

    return metadata

# --- 3. ROUTES ---
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
        
        servers = []
        if os.path.exists(SERVERS_FILE):
            try:
                with open(SERVERS_FILE, 'r') as f:
                    servers = json.load(f)
            except:
                pass
        
        # Scrape rich metadata from the endpoint
        print(f"\n[Scraper] Fetching metadata for: {url} ({server_type})")
        enriched_server_data = fetch_server_metadata(url, server_type)

        # Check if URL already exists
        existing_index = None
        for i, s in enumerate(servers):
            if s.get('url') == url:
                existing_index = i
                break

        if existing_index is not None:
            # OVERWRITE existing entry with newly scraped data
            servers[existing_index] = enriched_server_data
            msg = "Existing server metadata updated successfully"
        else:
            # APPEND new entry
            servers.append(enriched_server_data)
            msg = "New server scraped and saved"

        with open(SERVERS_FILE, 'w') as f:
            json.dump(servers, f, indent=2)
        
        return {"message": msg}, 201

@app.route('/proxy')
def proxy():
    target_url = request.args.get('url')
    if not target_url: return {"error": "No URL provided"}, 400
    try:
        response = requests.get(target_url, timeout=30, verify=False) 
        return Response(response.content, status=response.status_code, content_type=response.headers.get('Content-Type', 'application/json'))
    except Exception as e:
        return {"error": str(e)}, 500

# --- THE MISSING PIECE ---
if __name__ == '__main__':
    print("🚀 GIS App running at: http://127.0.0.1:5000")
    app.run(debug=True, port=5000)