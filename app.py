from flask import Flask, request, Response, render_template
import requests
import json
import os

app = Flask(__name__)

SERVERS_FILE = 'gis_servers.json'

if not os.path.exists(SERVERS_FILE):
    with open(SERVERS_FILE, 'w') as f:
        json.dump([
            {"name": "Environment Canada GeoMet (WFS)", "url": "https://geo.weather.gc.ca/geomet", "type": "WFS"},
            {"name": "City of Toronto Geospatial (ESRI FeatureServer)", "url": "https://gis.toronto.ca/arcgis/rest/services/cot_geospatial2/FeatureServer", "type": "ESRI"},
            {"name": "Statistics Canada 2021 Census Boundaries (ESRI)", "url": "https://services.arcgis.com/lGOekm0RsNxYnT3j/arcgis/rest/services/Generalized_2021_Statistics_Canada_census_boundaries/FeatureServer", "type": "ESRI"},
            {"name": "Canada Provinces and Territories (ESRI)", "url": "https://services5.arcgis.com/Mze3GM5YlDfcAPOn/ArcGIS/rest/services/Provinces_and_Territories_of_Canada/FeatureServer", "type": "ESRI"}
        ], f, indent=2)

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/sw.js')
def service_worker():
    # Serves the sw.js file from the static folder, but makes the browser think it's at the root
    return app.send_static_file('sw.js')

@app.route('/api/servers', methods=['GET', 'POST'])
def handle_servers():
    if request.method == 'GET':
        if os.path.exists(SERVERS_FILE):
            with open(SERVERS_FILE, 'r') as f:
                return Response(f.read(), mimetype='application/json')
        return Response('[]', mimetype='application/json')
    
    if request.method == 'POST':
        data = request.json
        servers = []
        if os.path.exists(SERVERS_FILE):
            try:
                with open(SERVERS_FILE, 'r') as f:
                    servers = json.load(f)
            except:
                pass
        
        for s in servers:
            if s.get('url') == data.get('url'):
                s['name'] = data.get('name')
                s['type'] = data.get('type')
                with open(SERVERS_FILE, 'w') as f:
                    json.dump(servers, f, indent=2)
                return {"message": "Server updated"}, 200

        servers.append(data)
        with open(SERVERS_FILE, 'w') as f:
            json.dump(servers, f, indent=2)
        
        return {"message": "Server saved"}, 201

@app.route('/proxy')
def proxy():
    target_url = request.args.get('url')
    if not target_url: return {"error": "No URL provided"}, 400
    try:
        response = requests.get(target_url, timeout=30) 
        return Response(response.content, status=response.status_code, content_type=response.headers.get('Content-Type', 'application/json'))
    except Exception as e:
        return {"error": str(e)}, 500

if __name__ == '__main__':
    print("🚀 GIS App running at: http://127.0.0.1:5000")
    app.run(debug=True, port=5000)
