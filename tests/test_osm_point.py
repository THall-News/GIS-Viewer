import unittest
from unittest.mock import MagicMock, patch

from flask import Flask

from routes.search import search_bp
from services.overpass_service import build_element_query, build_point_query, execute_overpass_query, search_overpass_point


class OSMPointQueryTests(unittest.TestCase):
    def test_build_element_query_is_exact_and_bounded(self):
        query = build_element_query('way', 123, timeout_val=20)
        self.assertIn('[out:json][timeout:20];', query)
        self.assertIn('way(123);', query)
        self.assertTrue(query.endswith('out body geom;'))

    def test_build_element_query_rejects_unknown_type_or_id(self):
        with self.assertRaises(ValueError):
            build_element_query('area', 123)
        with self.assertRaises(ValueError):
            build_element_query('way', 0)

    def test_build_point_query_is_bounded_and_contains_all_element_types(self):
        query = build_point_query(43.4405031, -79.7931299, radius_m=25)

        self.assertIn('[out:json][timeout:15];', query)
        self.assertIn('node(around:25,43.4405031,-79.7931299);', query)
        self.assertIn('way(around:25,43.4405031,-79.7931299);', query)
        self.assertIn('relation(around:25,43.4405031,-79.7931299);', query)
        self.assertIn('is_in(43.4405031,-79.7931299)->.containingAreas;', query)
        self.assertIn('way(pivot.containingAreas);', query)
        self.assertIn('relation(pivot.containingAreas);', query)
        self.assertTrue(query.endswith('out body center;'))

    def test_build_point_query_rejects_invalid_coordinates_and_radius(self):
        with self.assertRaises(ValueError):
            build_point_query(91, 0)
        with self.assertRaises(ValueError):
            build_point_query(0, 181)
        with self.assertRaises(ValueError):
            build_point_query(0, 0, radius_m=101)

    @patch('services.overpass_service.execute_overpass_query')
    def test_search_preserves_elements_and_reports_metadata(self, execute):
        response = MagicMock(status_code=200)
        response.json.return_value = {
            'elements': [
                {'type': 'node', 'id': 1, 'lat': 43.4, 'lon': -79.8, 'tags': {'amenity': 'bench'}},
                {'type': 'way', 'id': 2, 'tags': {'highway': 'residential'}, 'geometry': []},
                {'type': 'relation', 'id': 3, 'tags': {'boundary': 'administrative'}, 'members': []},
            ]
        }
        execute.return_value = response

        result = search_overpass_point(43.4, -79.8, radius_m=25)

        self.assertEqual([element['type'] for element in result['elements']], ['relation', 'way', 'node'])
        self.assertEqual(result['metadata']['radius_m'], 25.0)
        self.assertEqual(result['metadata']['source'], 'OpenStreetMap')
        execute.assert_called_once()

    def test_endpoint_rejects_invalid_request(self):
        app = Flask(__name__)
        app.register_blueprint(search_bp)

        response = app.test_client().post('/api/osm/query-point', json={
            'latitude': 0,
            'longitude': 0,
            'radius_m': 101,
        })

        self.assertEqual(response.status_code, 400)
        self.assertIn('radius_m', response.get_json()['error'])

    @patch('services.overpass_service._LAST_OVERPASS_REQUEST', {})
    @patch('services.overpass_service._OVERPASS_ENDPOINT_FAILURE_UNTIL', {})
    @patch('services.overpass_service.GLOBAL_OVERPASS_ENDPOINTS', ['primary', 'backup'])
    @patch('services.overpass_service.requests.post')
    def test_execute_overpass_query_immediately_fails_over_rate_limited_server(self, post):
        rate_limited = MagicMock(status_code=429)
        successful = MagicMock(status_code=200)
        post.side_effect = [rate_limited, successful]

        result = execute_overpass_query('out body;', request_timeout=8)

        self.assertIs(result, successful)
        self.assertEqual([call.args[0] for call in post.call_args_list], ['primary', 'backup'])
        self.assertEqual(post.call_args_list[0].kwargs['timeout'], 8)

    @patch('services.overpass_service._LAST_OVERPASS_REQUEST', {})
    @patch('services.overpass_service.GLOBAL_OVERPASS_ENDPOINTS', ['primary', 'backup'])
    @patch('services.overpass_service.requests.post')
    def test_execute_overpass_query_tries_cooled_backup_after_available_server_fails(self, post):
        rate_limited = MagicMock(status_code=429)
        successful = MagicMock(status_code=200)
        post.side_effect = [rate_limited, successful]

        with patch('services.overpass_service._OVERPASS_ENDPOINT_FAILURE_UNTIL', {'primary': 10**12}):
            result = execute_overpass_query('out body;', request_timeout=8)

        self.assertIs(result, successful)
        self.assertEqual([call.args[0] for call in post.call_args_list], ['backup', 'primary'])

    @patch('services.overpass_service._LAST_OVERPASS_REQUEST', {})
    @patch('services.overpass_service._OVERPASS_ENDPOINT_FAILURE_UNTIL', {})
    @patch('services.overpass_service.GLOBAL_OVERPASS_ENDPOINTS', ['primary', 'backup'])
    @patch('services.overpass_service.requests.post')
    def test_execute_overpass_query_skips_false_empty_point_response(self, post):
        empty = MagicMock(status_code=200)
        empty.json.return_value = {'elements': []}
        successful = MagicMock(status_code=200)
        successful.json.return_value = {'elements': [{'type': 'way', 'id': 7}]}
        post.side_effect = [empty, successful]

        result = execute_overpass_query('point query', request_timeout=8, reject_empty=True)

        self.assertIs(result, successful)
        self.assertEqual([call.args[0] for call in post.call_args_list], ['primary', 'backup'])

    @patch('routes.search.search_overpass_point')
    def test_endpoint_returns_point_results(self, search_point):
        search_point.return_value = {
            'elements': [{'type': 'node', 'id': 9, 'tags': {'name': 'Test'}}],
            'metadata': {'source': 'OpenStreetMap', 'radius_m': 25},
            'warnings': [],
        }
        app = Flask(__name__)
        app.register_blueprint(search_bp)

        response = app.test_client().post('/api/osm/query-point', json={
            'latitude': 43.4,
            'longitude': -79.8,
        })

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()['elements'][0]['id'], 9)
        search_point.assert_called_once_with(
            43.4,
            -79.8,
            radius_m=25,
            timeout_val=15,
            include_admin_context=True,
        )

    @patch('routes.search.search_overpass_element')
    def test_endpoint_supports_exact_element_followup(self, search_element):
        search_element.return_value = {
            'elements': [{'type': 'way', 'id': 18, 'tags': {'highway': 'secondary'}}],
            'metadata': {'source': 'OpenStreetMap'},
            'warnings': [],
        }
        app = Flask(__name__)
        app.register_blueprint(search_bp)

        response = app.test_client().post('/api/overpass_search', json={
            'tags': [],
            'geomType': 'lines_polygons',
            'osmElement': {'type': 'way', 'id': 18},
            'followup': {'mode': 'element'},
        })

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()['elements'][0]['id'], 18)
        search_element.assert_called_once_with('way', 18, timeout_val=25)

    @patch('services.overpass_service.search_overpass_containing_boundaries')
    @patch('services.overpass_service.execute_overpass_query')
    def test_point_query_includes_containing_admin_levels_when_requested(self, execute, search_context):
        response = MagicMock(status_code=200)
        response.json.return_value = {'elements': [{'type': 'node', 'id': 1, 'tags': {'amenity': 'bench'}}]}
        execute.return_value = response
        search_context.return_value = {
            'elements': [
                {'type': 'relation', 'id': 8, 'tags': {'boundary': 'administrative', 'admin_level': '8', 'name': 'Welland'}},
                {'type': 'relation', 'id': 4, 'tags': {'boundary': 'administrative', 'admin_level': '4', 'name': 'Ontario'}},
                {'type': 'relation', 'id': 100, 'tags': {'boundary': 'administrative', 'name': 'Missing level'}},
            ],
            'warnings': [],
        }
        result = search_overpass_point(43.0, -79.0, include_admin_context=True)
        self.assertEqual(
            [(area['admin_level'], area['name']) for area in result['administrative_context']],
            [('4', 'Ontario'), ('8', 'Welland')],
        )
        search_context.assert_called_once_with(43.0, -79.0, admin_level=None, timeout_val=15)


if __name__ == '__main__':
    unittest.main()
