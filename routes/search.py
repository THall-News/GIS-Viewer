import math
import os

import requests
from flask import Blueprint, jsonify, request

from services.ckan_service import search_ckan_portal
from services.esri_service import search_esri_portal
from services.overpass_service import (
    search_overpass,
    search_overpass_point,
    search_overpass_element,
)
from services.headless_service import headless_sessions

search_bp = Blueprint('search_bp', __name__)


def _validated_bbox(raw_bbox):
    if not isinstance(raw_bbox, dict):
        raise ValueError('bbox must contain south, west, north, and east coordinates')
    try:
        bbox = [
            float(raw_bbox['south']), float(raw_bbox['west']),
            float(raw_bbox['north']), float(raw_bbox['east'])
        ]
    except (KeyError, TypeError, ValueError):
        raise ValueError('bbox coordinates must be numeric')
    south, west, north, east = bbox
    if not all(math.isfinite(value) for value in bbox) or not (-90 <= south <= north <= 90 and -180 <= west <= east <= 180):
        raise ValueError('bbox must be [south, west, north, east] within valid coordinate ranges')
    return bbox


def _bbox_area_km2(bbox):
    south, west, north, east = bbox
    mid_lat = (south + north) / 2
    width_km = abs(east - west) * 111 * max(math.cos(math.radians(mid_lat)), 0.01)
    height_km = abs(north - south) * 111
    return width_km * height_km


@search_bp.route('/api/osrm_route', methods=['POST'])
def osrm_route():
    """Proxy an ordered driving route request to a configurable OSRM server."""
    data = request.json or {}
    raw_coordinates = data.get('coordinates') or []
    if not isinstance(raw_coordinates, list) or len(raw_coordinates) < 2 or len(raw_coordinates) > 50:
        return jsonify({'error': 'A route requires between 2 and 50 coordinates.'}), 400

    coordinates = []
    try:
        for item in raw_coordinates:
            if not isinstance(item, (list, tuple)) or len(item) != 2:
                raise ValueError('Each coordinate must be [longitude, latitude].')
            lon, lat = float(item[0]), float(item[1])
            if not (-180 <= lon <= 180 and -90 <= lat <= 90):
                raise ValueError('Route coordinates are outside valid longitude/latitude ranges.')
            coordinates.append((lon, lat))
    except (TypeError, ValueError) as exc:
        return jsonify({'error': str(exc)}), 400

    base_url = os.environ.get('OSRM_ROUTING_URL', 'https://router.project-osrm.org').rstrip('/')
    coordinate_path = ';'.join(f'{lon:.7f},{lat:.7f}' for lon, lat in coordinates)
    url = f'{base_url}/route/v1/driving/{coordinate_path}'
    try:
        response = requests.get(url, params={
            'overview': 'full',
            'geometries': 'geojson',
            'steps': 'false',
        }, headers={'Accept': 'application/json', 'User-Agent': 'GIS-Layer-Previewer/1.0'}, timeout=20)
        response.raise_for_status()
        payload = response.json()
        routes = payload.get('routes') or []
        if not routes or not routes[0].get('geometry'):
            return jsonify({'error': payload.get('message') or 'OSRM could not find a route between the selected roads.'}), 422
        route = routes[0]
        return jsonify({
            'geometry': route['geometry'],
            'distance_m': route.get('distance'),
            'duration_s': route.get('duration'),
            'source': 'OSRM',
            'profile': 'driving',
        })
    except requests.RequestException as exc:
        return jsonify({'error': f'OSRM route request failed: {exc}'}), 502
    except (TypeError, ValueError) as exc:
        return jsonify({'error': f'Invalid OSRM response: {exc}'}), 502


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
            target_bbox = _validated_bbox(bbox)
        else:
            target_bbox = None
        exact_element = data.get('osmElement') or data.get('element')
        if exact_element is not None:
            max_area = data.get('maxArea')
            if target_bbox is not None and max_area is not None:
                try:
                    max_area = float(max_area)
                except (TypeError, ValueError):
                    raise ValueError('maxArea must be numeric')
                if not math.isfinite(max_area) or max_area <= 0:
                    raise ValueError('maxArea must be greater than zero')
                if _bbox_area_km2(target_bbox) > max_area:
                    raise ValueError(f'Search area is {_bbox_area_km2(target_bbox):.2f} km², above the configured {max_area:g} km² limit')
            if not isinstance(exact_element, dict):
                raise ValueError('osmElement must be an object with type and id')
            result = search_overpass_element(
                exact_element.get('type'),
                exact_element.get('id'),
                timeout_val=timeout_val
            )
            result.setdefault('metadata', {})['followup'] = data.get('followup') or {'mode': 'element'}
            return jsonify(result)
        # Keep the manual endpoint compatible with the same road-relative
        # compiler used by the natural-language search. The older generic
        # function cannot represent a street/distance relation.
        if data.get('street'):
            result = headless_sessions._run_osm_search({
                'tags': tags,
                'featName': feat_name,
                'loc': loc,
                'geomType': geom_type,
                'bbox': target_bbox,
                'timeout': timeout_val,
                'maxChunks': max_chunks,
                'relation': data.get('relation') or 'on',
                'street': data.get('street'),
                'distance_km': data.get('distance_km'),
                'tagAlternatives': data.get('tagAlternatives'),
                'exactName': data.get('exactName'),
                'wayOnly': data.get('wayOnly'),
            })
            update = next((item for item in result.get('workspace_updates', []) if item.get('op') == 'create_layer'), {})
            return jsonify({'elements': update.get('osm_elements', []), 'metadata': result.get('metadata'), 'feature_count': result.get('feature_count', 0)})
        result = search_overpass(tags=tags, feat_name=feat_name, loc=loc, geom_type=geom_type, bbox=target_bbox, timeout_val=timeout_val, max_chunks=max_chunks, max_area_km2=data.get('maxArea'))
        result.setdefault('metadata', {
            'source': 'OpenStreetMap',
            'attribution': '© OpenStreetMap contributors',
            'attribution_url': 'https://www.openstreetmap.org/copyright',
            'location': loc,
        })
        return jsonify(result)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    except TimeoutError as exc:
        return jsonify({'error': str(exc)}), 504
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


@search_bp.route('/api/osm/query-point', methods=['POST'])
def osm_query_point():
    """Return bounded OSM elements near one map coordinate."""
    data = request.get_json(silent=True)
    if data is None:
        data = {}
    if not isinstance(data, dict):
        return jsonify({'error': 'Request body must be a JSON object.'}), 400

    latitude = data.get('latitude')
    longitude = data.get('longitude')
    radius_m = data.get('radius_m', 25)
    try:
        result = search_overpass_point(
            latitude,
            longitude,
            radius_m=radius_m,
            timeout_val=15,
            include_admin_context=True,
        )
        return jsonify(result)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    except TimeoutError as exc:
        return jsonify({'error': str(exc)}), 504
    except requests.RequestException as exc:
        return jsonify({'error': f'Overpass point query failed: {exc}'}), 502
    except Exception as exc:
        return jsonify({'error': f'Overpass point query failed: {exc}'}), 502

