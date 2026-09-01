import json

from flask import Blueprint, Response, request, jsonify

from config import SERVERS_FILE
from services.gis_scraper import fetch_server_metadata

servers_bp = Blueprint('servers_bp', __name__)


@servers_bp.route('/api/servers', methods=['GET', 'POST'])
def handle_servers():
    if request.method == 'GET':
        if SERVERS_FILE.exists():
            with open(SERVERS_FILE, 'r', encoding='utf-8') as f:
                return Response(f.read(), mimetype='application/json')
        return Response('[]', mimetype='application/json')

    data = request.json or {}
    url = data.get('url')
    server_type = data.get('type')
    user_name = data.get('name') or 'Custom Server'
    if not url:
        return jsonify({'error': 'No URL provided'}), 400

    servers = []
    if SERVERS_FILE.exists():
        try:
            with open(SERVERS_FILE, 'r', encoding='utf-8') as f:
                servers = json.load(f)
        except Exception:
            servers = []

    print(f"\n[Scraper] Fetching metadata for: {url} ({server_type})")
    enriched_server_data = fetch_server_metadata(url, server_type, user_name)

    existing_index = None
    for idx, server in enumerate(servers):
        if server.get('url') == url:
            existing_index = idx
            break

    if existing_index is not None:
        enriched_server_data['id'] = servers[existing_index].get('id', enriched_server_data['id'])
        servers[existing_index] = enriched_server_data
        msg = 'Existing server metadata updated successfully'
    else:
        servers.append(enriched_server_data)
        msg = 'New server scraped and saved'

    with open(SERVERS_FILE, 'w', encoding='utf-8') as f:
        json.dump(servers, f, indent=2)

    return {'message': msg}, 201
