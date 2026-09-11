import logging

from flask import Blueprint, jsonify, request

from services.centerline_service import CenterlineError, centerline_feature_collection


geometry_bp = Blueprint('geometry_bp', __name__)
logger = logging.getLogger(__name__)


@geometry_bp.route('/api/geometry/centerline', methods=['POST'])
def centerline():
    data = request.get_json(silent=True) or {}
    collection = data.get('geojson') or data.get('feature_collection')
    options = data.get('options') or {}
    try:
        result = centerline_feature_collection(collection, options)
        return jsonify(result)
    except CenterlineError as exc:
        return jsonify({'error': str(exc)}), 400
    except (TypeError, ValueError) as exc:
        return jsonify({'error': str(exc)}), 400
    except Exception:
        logger.exception('Centerline geometry processing failed')
        return jsonify({'error': 'Centerline geometry processing failed.'}), 500
