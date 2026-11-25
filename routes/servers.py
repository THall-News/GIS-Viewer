"""Compatibility endpoints for the standalone catalog service."""

from flask import Blueprint, jsonify, request

from services.catalog_client import CatalogClient, CatalogUnavailableError


servers_bp = Blueprint('servers_bp', __name__)


@servers_bp.route('/api/servers', methods=['GET', 'POST'])
def handle_servers():
    """Keep the previewer's existing UI API backed by the catalog database."""
    client = CatalogClient()

    if request.method == 'GET':
        try:
            payload = client.sources()
        except CatalogUnavailableError as exc:
            return jsonify({'error': str(exc), 'code': 'catalog_unavailable'}), 503
        # The current dropdown expects an array. Catalog source rows expose
        # their server kind as `protocol`, which the UI also understands.
        return jsonify(payload.get('sources') or [])

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({'error': 'A source object is required'}), 400
    url = str(data.get('url') or '').strip()
    if not url.startswith(('http://', 'https://')):
        return jsonify({'error': 'A source HTTP(S) URL is required'}), 400

    name = str(data.get('name') or data.get('display_name') or 'Custom Server').strip()
    source = {
        'display_name': name,
        'name': name,
        'type': data.get('type') or data.get('protocol') or 'ESRI',
        'url': url,
        'autoRefresh': True,
    }
    try:
        payload = client.add_source(source)
    except CatalogUnavailableError as exc:
        return jsonify({'error': str(exc), 'code': 'catalog_unavailable'}), 503
    return jsonify(payload), 201
