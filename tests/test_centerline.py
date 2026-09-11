import unittest
from pathlib import Path

from shapely.geometry import LineString, Polygon, mapping, shape
from shapely.ops import unary_union

from services.centerline_service import CenterlineError, centerline_feature_collection


def feature(geometry, feature_id=1, properties=None):
    return {
        "type": "Feature",
        "id": feature_id,
        "properties": properties or {},
        "geometry": mapping(geometry),
    }


def collection(features):
    return {"type": "FeatureCollection", "features": features}


class CenterlineServiceTests(unittest.TestCase):
    def test_magnetic_lasso_entry_button_is_hidden_but_panel_markup_remains(self):
        template = Path(__file__).parents[1].joinpath("templates/components/map_panel.html").read_text(encoding="utf-8")

        self.assertNotIn('id="btn-magnetic-lasso"', template)
        self.assertIn('id="magnetic-lasso-panel"', template)

    def test_straight_river_produces_a_centered_line(self):
        river = Polygon([(0, 0), (0.001, 0), (0.001, 0.01), (0, 0.01), (0, 0)])
        result = centerline_feature_collection(collection([feature(river)]))
        output = result["geojson"]["features"]

        self.assertEqual(len(output), 1)
        self.assertEqual(output[0]["geometry"]["type"], "LineString")
        centerline = shape(output[0]["geometry"])
        self.assertAlmostEqual(centerline.centroid.x, 0.0005, delta=0.00005)
        self.assertEqual(output[0]["properties"]["geometry_type"], "centerline")
        self.assertIn("centerline_sample_spacing_m", output[0]["properties"])

    def test_bent_river_preserves_more_than_a_two_point_axis(self):
        river = LineString([
            (0, 0),
            (0.002, 0.002),
            (0.004, 0.001),
            (0.006, 0.004),
            (0.008, 0.003),
            (0.01, 0.007),
        ]).buffer(0.0005, resolution=8, cap_style=2, join_style=2)
        result = centerline_feature_collection(collection([feature(river)]))
        geometry = result["geojson"]["features"][0]["geometry"]

        self.assertEqual(geometry["type"], "LineString")
        self.assertGreater(len(geometry["coordinates"]), 3)

    def test_tile_fragments_dissolve_into_one_connected_component(self):
        first = Polygon([(0, 0), (0.001, 0), (0.001, 0.004), (0, 0.004), (0, 0)])
        second = Polygon([(0.001, 0), (0.002, 0), (0.002, 0.004), (0.001, 0.004), (0.001, 0)])
        result = centerline_feature_collection(collection([feature(first, 1), feature(second, 2)]))

        self.assertEqual(len(result["geojson"]["features"]), 1)
        self.assertEqual(result["geojson"]["features"][0]["properties"]["centerline_source_fragment_count"], 2)

    def test_disconnected_water_bodies_remain_separate_features(self):
        first = Polygon([(0, 0), (0.001, 0), (0.001, 0.004), (0, 0.004), (0, 0)])
        second = Polygon([(0.01, 0), (0.011, 0), (0.011, 0.004), (0.01, 0.004), (0.01, 0)])
        result = centerline_feature_collection(collection([feature(first, 1), feature(second, 2)]))

        self.assertEqual(len(result["geojson"]["features"]), 2)
        self.assertEqual({item["properties"]["centerline_component_id"] for item in result["geojson"]["features"]}, {1, 2})
        self.assertEqual({item["properties"]["centerline_source_fragment_count"] for item in result["geojson"]["features"]}, {1})

    def test_branching_river_preserves_a_centerline_network(self):
        main = LineString([(0, 0), (0, 0.01)]).buffer(0.0005, resolution=8, cap_style=2)
        branch = LineString([(0, 0.005), (0.003, 0.008)]).buffer(0.0004, resolution=8, cap_style=2)
        river = unary_union([main, branch])
        result = centerline_feature_collection(collection([feature(river)]))
        output = result["geojson"]["features"][0]

        self.assertEqual(output["geometry"]["type"], "MultiLineString")
        self.assertGreaterEqual(output["properties"]["centerline_branch_count"], 1)

    def test_line_geometry_passes_through_as_a_centerline(self):
        line = LineString([(0, 0), (0.001, 0.001), (0.002, 0)])
        result = centerline_feature_collection(collection([feature(line)]))

        self.assertEqual(result["geojson"]["features"][0]["geometry"], mapping(line))
        self.assertEqual(result["geojson"]["features"][0]["properties"]["centerline_method"], "existing line geometry")

    def test_invalid_polygon_is_repaired(self):
        invalid = {
            "type": "Polygon",
            "coordinates": [[[0, 0], [0.001, 0.001], [0, 0.001], [0.001, 0], [0, 0]]],
        }
        result = centerline_feature_collection(collection([{
            "type": "Feature",
            "id": 1,
            "properties": {},
            "geometry": invalid,
        }]))

        self.assertTrue(result["warnings"])
        self.assertTrue(result["geojson"]["features"])

    def test_empty_collection_is_rejected(self):
        with self.assertRaises(CenterlineError):
            centerline_feature_collection({"type": "FeatureCollection", "features": []})

    def test_unsupported_geometry_is_rejected(self):
        with self.assertRaises(CenterlineError):
            centerline_feature_collection(collection([{
                "type": "Feature",
                "id": 1,
                "properties": {},
                "geometry": {"type": "Point", "coordinates": [0, 0]},
            }]))


if __name__ == "__main__":
    unittest.main()
