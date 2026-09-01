from flask import Blueprint, Response, jsonify, request

from services.proxy_service import proxy_response_payload

proxy_bp = Blueprint('proxy_bp', __name__)


@proxy_bp.route('/proxy', methods=['GET'])
def proxy_download():
    target_url = request.args.get('url')
    target_format = request.args.get('format', '').lower()

    if not target_url:
        return jsonify({'error': 'No URL provided'}), 400

    try:
        payload = proxy_response_payload(target_url, target_format)
        if payload['type'] == 'geojson':
            return Response(payload['data'], mimetype='application/json', headers={'Access-Control-Allow-Origin': '*'})

        req = payload['response']
        headers = {
            'Content-Type': req.headers.get('Content-Type', 'application/octet-stream'),
            'Access-Control-Allow-Origin': '*',
        }

        def generate():
            for chunk in req.iter_content(chunk_size=8192):
                if chunk:
                    yield chunk

        return Response(generate(), headers=headers)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    except Exception as exc:
        return jsonify({'error': f'Proxy download failed: {str(exc)}'}), 502
