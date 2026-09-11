from flask import Blueprint, jsonify, request

from services.headless_service import headless_sessions
from services.discovery_service import discover_sources, validate_candidate, load_candidate
from services.source_models import SourceCandidate
from services.gis_scraper import fetch_server_metadata
from services.geometry_repair import repair_feature_collection
from services.catalog_client import CatalogUnavailableError

headless_bp = Blueprint('headless_bp', __name__)


@headless_bp.route('/api/geometry/repair', methods=['POST'])
def repair_geometry_route():
    """Explicitly repair a user-selected working copy of a GeoJSON layer."""
    data = request.json or {}
    collection = data.get('geojson') or data.get('feature_collection')
    if not isinstance(collection, dict):
        return jsonify({'error': 'geojson FeatureCollection is required'}), 400
    try:
        return jsonify(repair_feature_collection(collection))
    except (TypeError, ValueError) as exc:
        return jsonify({'error': str(exc)}), 400


@headless_bp.route('/api/headless/assistant/turn', methods=['POST'])
def guided_assistant_turn():
    """Stateful, search-only Map Assistant turn."""
    try:
        return jsonify(headless_sessions.assistant_turn(request.json or {}))
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    except TimeoutError as exc:
        return jsonify({'error': str(exc)}), 504
    except Exception as exc:
        # Provider failures are normally returned as warnings by the service;
        # this guard keeps malformed assistant requests from breaking Flask.
        return jsonify({'error': str(exc)}), 500


@headless_bp.route('/api/catalog/search', methods=['POST'])
def catalog_search():
    """Search the configured GIS catalog without invoking the assistant."""
    data = request.json or {}
    query = str(data.get('query') or '').strip()
    if not query:
        return jsonify({'error': 'query is required'}), 400
    try:
        return jsonify(headless_sessions._run_search_layers({
            'source': 'catalog',
            'query': query,
            'limit': data.get('limit', 10),
            'bbox': data.get('bbox') or data.get('mapBounds'),
            'protocol': data.get('protocol'),
            'provider': data.get('provider'),
            'theme': data.get('theme'),
            'workspace': data.get('workspace') or {},
            'region': data.get('region'),
        }))
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    except TimeoutError as exc:
        return jsonify({'error': str(exc)}), 504
    except CatalogUnavailableError as exc:
        return jsonify({'error': str(exc), 'code': 'catalog_unavailable'}), 503
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


@headless_bp.route('/api/headless/sessions', methods=['GET', 'POST'])
def sessions():
    if request.method == 'GET':
        return jsonify({'sessions': headless_sessions.list()})

    data = request.json or {}
    prompt = (data.get('prompt') or '').strip()
    if not prompt:
        return jsonify({'error': 'prompt is required'}), 400
    workspace = data.get('workspace') or data.get('workspaceContext') or {}
    conversation = data.get('conversation') or []
    if not isinstance(conversation, list):
        return jsonify({'error': 'conversation must be an array'}), 400

    session = headless_sessions.create(
        prompt,
        auto_run=bool(data.get('runImmediately', False)),
        workspace=workspace,
        mode=data.get('mode') or 'auto',
        conversation=conversation,
    )

    return jsonify(session.to_dict())


@headless_bp.route('/api/headless/sessions/<session_id>', methods=['GET'])
def session_detail(session_id):
    session = headless_sessions.get(session_id)
    if not session:
        return jsonify({'error': 'session not found'}), 404
    return jsonify(session.to_dict())


@headless_bp.route('/api/headless/sessions/<session_id>/audit', methods=['GET'])
def session_audit(session_id):
    if not headless_sessions.get(session_id):
        return jsonify({'error': 'session not found'}), 404
    return jsonify({'events': headless_sessions.audit(session_id)})


@headless_bp.route('/api/headless/audit', methods=['GET'])
def request_audit():
    try:
        limit = int(request.args.get('limit', 100))
    except (TypeError, ValueError):
        limit = 100
    return jsonify({'events': headless_sessions._repository.list_request_audit(limit)})


@headless_bp.route('/api/headless/discover', methods=['POST'])
def discover():
    data = request.json or {}
    try:
        return jsonify(discover_sources(data.get('query', ''), limit=data.get('limit', 10)))
    except (TypeError, ValueError) as exc:
        return jsonify({'error': str(exc)}), 400


@headless_bp.route('/api/headless/sources/validate', methods=['POST'])
def validate_source():
    data = request.json or {}
    try:
        candidate = SourceCandidate(**(data.get('candidate') or {}))
        result = validate_candidate(candidate)
        return jsonify(result.__dict__ | {'candidate': candidate.to_dict()})
    except (TypeError, ValueError) as exc:
        return jsonify({'error': str(exc)}), 400


@headless_bp.route('/api/headless/sources/load', methods=['POST'])
def load_source():
    data = request.json or {}
    if not data.get('confirmed'):
        return jsonify({'error': 'Loading a discovered source requires explicit confirmation', 'code': 'confirmation_required'}), 409
    try:
        return jsonify(load_candidate(SourceCandidate(**(data.get('candidate') or {}))))
    except (TypeError, ValueError) as exc:
        return jsonify({'error': str(exc)}), 400


@headless_bp.route('/api/headless/sources/save', methods=['POST'])
def save_source():
    data = request.json or {}
    if not data.get('confirmed'):
        return jsonify({'error': 'Saving a discovered source requires explicit confirmation', 'code': 'confirmation_required'}), 409
    try:
        candidate = SourceCandidate(**(data.get('candidate') or {}))
        metadata = fetch_server_metadata(candidate.url, candidate.protocol.upper(), candidate.title or 'Discovered source')
        metadata.update({'discoveredProtocol': candidate.protocol, 'provenanceUrl': candidate.provenance_url,
                         'confidence': candidate.confidence})
        saved = headless_sessions._catalog_client.add_source(metadata)
        return jsonify({'saved': True, 'server': saved})
    except CatalogUnavailableError as exc:
        return jsonify({'error': str(exc), 'code': 'catalog_unavailable'}), 503
    except (TypeError, ValueError) as exc:
        return jsonify({'error': str(exc)}), 400


@headless_bp.route('/api/headless/sessions/<session_id>/run', methods=['POST'])
def run_session(session_id):
    session = headless_sessions.get(session_id)
    if not session:
        return jsonify({'error': 'session not found'}), 404
    data = request.json or {}
    try:
        return jsonify(headless_sessions.run(
            session_id,
            confirmed=bool(data.get('confirmed', False)),
            plan_hash=data.get('planHash'),
            approval_token=data.get('approvalToken'),
        ).to_dict())
    except PermissionError as exc:
        return jsonify({'error': str(exc), 'code': 'confirmation_required'}), 409
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400


@headless_bp.route('/api/headless/plan', methods=['POST'])
def plan_prompt():
    data = request.json or {}
    prompt = (data.get('prompt') or '').strip()
    if not prompt:
        return jsonify({'error': 'prompt is required'}), 400
    workspace = data.get('workspace') or data.get('workspaceContext') or {}
    conversation = data.get('conversation') or []
    if not isinstance(conversation, list):
        return jsonify({'error': 'conversation must be an array'}), 400
    return jsonify(headless_sessions.summarize_plan(
        prompt,
        workspace=workspace,
        mode=data.get('mode') or 'auto',
        conversation=conversation,
    ))


@headless_bp.route('/api/headless/actions', methods=['POST'])
def execute_action():
    data = request.json or {}
    action_type = (data.get('type') or '').strip()
    if not action_type:
        return jsonify({'error': 'type is required'}), 400
    payload = data.get('payload') or {}
    try:
        return jsonify(headless_sessions.execute_action(action_type, payload, confirmed=bool(data.get('confirmed', False)), plan_hash=data.get('planHash')))
    except PermissionError as exc:
        return jsonify({'error': str(exc), 'code': 'confirmation_required'}), 409
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400


@headless_bp.route('/api/headless/layers/filter', methods=['POST'])
def filter_layers():
    data = request.json or {}
    payload = {
        'source': data.get('source') or {},
        'criteria': data.get('criteria') or {},
    }
    try:
        return jsonify(headless_sessions.execute_action('filter_layers', payload, confirmed=bool(data.get('confirmed', False))))
    except PermissionError as exc:
        return jsonify({'error': str(exc), 'code': 'confirmation_required'}), 409
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400


@headless_bp.route('/api/headless/overpass/search', methods=['POST'])
def overpass_search():
    data = request.json or {}
    payload = {
        'tags': data.get('tags') or [],
        'featName': data.get('featName'),
        'loc': data.get('loc'),
        'geomType': data.get('geomType', 'all'),
        'bbox': data.get('bbox'),
        'timeout': data.get('timeout', 25),
        'maxChunks': data.get('maxChunks', 16),
        'mapBounds': data.get('mapBounds'),
        'relation': data.get('relation'),
        'street': data.get('street'),
        'near_place': data.get('near_place'),
        'proximity_reference': data.get('proximity_reference'),
        'distance_km': data.get('distance_km'),
        'tagAlternatives': data.get('tagAlternatives'),
        'exactName': data.get('exactName'),
        'wayOnly': data.get('wayOnly'),
    }
    try:
        return jsonify(headless_sessions.execute_action('osm_search', payload, confirmed=bool(data.get('confirmed', False)), plan_hash=data.get('planHash')))
    except PermissionError as exc:
        return jsonify({'error': str(exc), 'code': 'confirmation_required'}), 409
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    except TimeoutError as exc:
        return jsonify({'error': str(exc)}), 504


@headless_bp.route('/api/headless/import', methods=['POST'])
def import_assets():
    data = request.json or {}
    payload = {
        'geojson': data.get('geojson'),
        'name': data.get('name'),
    }
    try:
        return jsonify(headless_sessions.execute_action('import_assets', payload))
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400


@headless_bp.route('/api/headless/execute', methods=['POST'])
def execute_prompt():
    data = request.json or {}
    prompt = (data.get('prompt') or '').strip()
    if not prompt:
        return jsonify({'error': 'prompt is required'}), 400
    workspace = data.get('workspace') or data.get('workspaceContext') or {}
    try:
        return jsonify(headless_sessions.plan_and_execute(prompt, workspace=workspace, confirmed=bool(data.get('confirmed', False))))
    except PermissionError as exc:
        return jsonify({'error': str(exc), 'code': 'confirmation_required'}), 409
    except TimeoutError as exc:
        return jsonify({'error': str(exc)}), 504
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
