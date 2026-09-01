from flask import Blueprint, jsonify, request

from services.ckan_service import search_ckan_portal
from services.esri_service import search_esri_portal
from services.overpass_service import search_overpass

search_bp = Blueprint('search_bp', __name__)


@search_bp.route('/api/ckan_search', methods=['POST'])
def ckan_search():
    data = request.json or {}
    raw_url = data.get('url', '').strip()
    try:
        result = search_ckan_portal(raw_url)
        return jsonify(result)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    except Exception as exc:
        return jsonify({'error': f'Failed to fetch CKAN catalog: {str(exc)}'}), 500


@search_bp.route('/api/esri_search', methods=['POST'])
def esri_search():
    data = request.json or {}
    raw_url = data.get('url', '').strip()
    try:
        result = search_esri_portal(raw_url)
        return jsonify(result)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    except Exception as exc:
        return jsonify({'error': f'Failed to crawl ESRI Directory: {str(exc)}'}), 500


@search_bp.route('/api/overpass_search', methods=['POST'])
def overpass_search():
    data = request.json or {}
    tags = data.get('tags', [])
    feat_name = data.get('featName')
    loc = data.get('loc')
    geom_type = data.get('geomType', 'all')
    bbox = data.get('bbox')
    timeout_val = data.get('timeout', 25)
    max_chunks = data.get('maxChunks', 16)

    try:
        if bbox:
            target_bbox = [bbox['south'], bbox['west'], bbox['north'], bbox['east']]
        else:
            target_bbox = None
        result = search_overpass(tags=tags, feat_name=feat_name, loc=loc, geom_type=geom_type, bbox=target_bbox, timeout_val=timeout_val, max_chunks=max_chunks)
        return jsonify(result)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    except TimeoutError as exc:
        return jsonify({'error': str(exc)}), 504
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500
