import json
import os
import tempfile
import unittest
from unittest.mock import MagicMock, patch

import services.headless_service as headless_module
from config import is_public_url
from services.headless_models import action_risk, calculate_plan_hash
from services.headless_service import HeadlessSessionStore
from services.overpass_service import build_containing_boundary_query, build_named_way_proximity_query, build_query
from services.osm_normalizer import normalize_overpass
from services.semantic_search import LayerSearchIndex
from services.spatial_service import operate
from services.geometry_repair import repair_feature_collection
from services.region_service import resolve_region_context, resolve_region_from_text
from shapely.geometry import shape


class HeadlessSafetyTests(unittest.TestCase):
    def setUp(self):
        # Never load the developer's persisted assistant history for unit
        # tests. That database contains large real search results and made
        # every HeadlessSessionStore construction needlessly expensive.
        self._test_database = tempfile.TemporaryDirectory()
        self._database_patch = patch.object(
            headless_module,
            "HEADLESS_DB_FILE",
            os.path.join(self._test_database.name, "headless.sqlite3"),
        )
        self._database_patch.start()
        self.addCleanup(self._database_patch.stop)
        self.addCleanup(self._test_database.cleanup)

    def test_region_aliases_are_normalized_without_substring_matches(self):
        for alias in ("on", "ON", "On.", "Ont.", "Ontario"):
            region = resolve_region_from_text(f"Cayuga, {alias}")
            self.assertIsNotNone(region)
            self.assertEqual(region["name"], "Ontario")
            self.assertEqual(region["code"], "CA-ON")
        self.assertEqual(resolve_region_from_text("Cayuga, ON, Canada")["name"], "Ontario")
        self.assertEqual(resolve_region_context("Cayuga, France")["name"], "France")
        self.assertIsNone(resolve_region_from_text("fire hydrants in Burlington"))
        self.assertIsNone(resolve_region_from_text("Cayuga"))

    def test_boundary_anchor_rejects_cayuga_indiana_for_ontario_request(self):
        store = HeadlessSessionStore()
        indiana = {
            "name": "Cayuga",
            "display_name": "Cayuga, LaGrange County, Indiana, United States",
            "lat": "41.45",
            "lon": "-85.99",
            "address": {"state": "Indiana", "country": "United States", "country_code": "us"},
            "class": "place",
            "type": "village",
            "importance": 0.9,
        }
        ontario = {
            "name": "Cayuga",
            "display_name": "Cayuga, Haldimand County, Ontario, Canada",
            "lat": "43.07",
            "lon": "-79.85",
            "address": {
                "state": "Ontario",
                "country": "Canada",
                "country_code": "ca",
                "ISO3166-2-lvl4": "CA-ON",
            },
            "class": "place",
            "type": "village",
            "importance": 0.4,
        }
        relation = {
            "type": "relation",
            "id": 8123,
            "tags": {"boundary": "administrative", "admin_level": "8", "name": "Haldimand County"},
        }
        exact_relation = {
            **relation,
            "members": [{"type": "way", "role": "outer", "geometry": [
                {"lat": 43.0, "lon": -80.0}, {"lat": 43.0, "lon": -79.7},
                {"lat": 43.2, "lon": -79.7}, {"lat": 43.0, "lon": -80.0},
            ]}],
        }
        with patch.object(store, "_nominatim_search", return_value=[indiana, ontario]) as nominatim, \
             patch("services.headless_service.search_overpass_containing_boundaries", return_value={"elements": [relation]}) as containing, \
             patch("services.headless_service.search_overpass_element", return_value={"elements": [exact_relation]}):
            result = store._resolve_boundary_result("Cayuga", "Cayuga, ON", admin_level="8")

        self.assertEqual(result["metadata"]["resolved_boundary_name"], "Haldimand County")
        self.assertEqual(result["metadata"]["requested_region"], "Ontario")
        nominatim.assert_called_once_with("Cayuga, Ontario, Canada", limit=10, polygon_geojson=True)
        containing.assert_called_once_with(43.07, -79.85, admin_level="8")

    def test_boundary_anchor_does_not_use_out_of_region_place(self):
        store = HeadlessSessionStore()
        indiana = {
            "name": "Cayuga",
            "display_name": "Cayuga, Indiana, United States",
            "lat": "41.45",
            "lon": "-85.99",
            "address": {"state": "Indiana", "country": "United States"},
            "class": "place",
            "type": "village",
        }
        with patch.object(store, "_nominatim_search", return_value=[indiana]), \
             patch("services.headless_service.search_overpass_containing_boundaries") as containing:
            result = store._resolve_boundary_result("Cayuga", "Cayuga, ON", admin_level="8")

        self.assertIsNone(result)
        containing.assert_not_called()

    def test_risky_actions_are_classified(self):
        self.assertEqual(action_risk("delete_layer"), "mutation")
        self.assertEqual(action_risk("export_workspace"), "export")
        self.assertNotEqual(calculate_plan_hash([]), "")

    def test_mutation_requires_confirmation(self):
        store = HeadlessSessionStore()
        with self.assertRaises(PermissionError):
            store.execute_action("delete_layer", {"layerKey": "layer-1"})

    def test_overpass_values_are_escaped(self):
        query = build_query([{"key": 'name"', "val": 'x\\y'}], feat_name='a"\n[bbox]', bbox=[0, 0, 1, 1])
        self.assertNotIn('name""', query)
        self.assertNotIn("\n[bbox]", query)

    @patch("config.socket.getaddrinfo", return_value=[(None, None, None, None, ("127.0.0.1", 443))])
    def test_private_dns_destination_is_rejected(self, _getaddrinfo):
        self.assertFalse(is_public_url("https://example.test"))

    def test_overpass_geometry_is_normalized_to_geojson(self):
        result = normalize_overpass({"elements": [{"type": "way", "id": 7, "tags": {"name": "Test"}, "geometry": [{"lat": 0, "lon": 0}, {"lat": 0, "lon": 1}, {"lat": 1, "lon": 1}, {"lat": 0, "lon": 0}]}]})
        self.assertEqual(result["type"], "FeatureCollection")
        self.assertEqual(result["features"][0]["geometry"]["type"], "Polygon")
        self.assertEqual(result["metadata"]["feature_count"], 1)

    def test_relation_member_geometry_is_preserved(self):
        result = normalize_overpass({"elements": [{"type": "relation", "id": 8, "tags": {"boundary": "administrative"}, "members": [{"type": "way", "geometry": [{"lat": 0, "lon": 0}, {"lat": 0, "lon": 1}, {"lat": 1, "lon": 1}, {"lat": 0, "lon": 0}]}]}]})
        self.assertEqual(result["features"][0]["geometry"]["type"], "MultiPolygon")

    def test_split_boundary_relation_members_are_stitched_into_a_polygon(self):
        relation = {
            "type": "relation",
            "id": 9,
            "tags": {"boundary": "administrative", "name": "Split boundary"},
            "members": [
                {"type": "way", "role": "outer", "geometry": [{"lat": 0, "lon": 0}, {"lat": 0, "lon": 1}]},
                {"type": "way", "role": "outer", "geometry": [{"lat": 0, "lon": 1}, {"lat": 1, "lon": 1}]},
                {"type": "way", "role": "outer", "geometry": [{"lat": 1, "lon": 1}, {"lat": 1, "lon": 0}]},
                {"type": "way", "role": "outer", "geometry": [{"lat": 1, "lon": 0}, {"lat": 0, "lon": 0}]},
            ],
        }
        result = normalize_overpass({"elements": [relation]})
        geometry = result["features"][0]["geometry"]
        self.assertEqual(geometry["type"], "MultiPolygon")
        self.assertEqual(geometry["coordinates"][0][0], [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]])

    def test_split_boundary_relation_preserves_inner_ring_as_hole(self):
        relation = {
            "type": "relation",
            "id": 10,
            "tags": {"boundary": "administrative"},
            "members": [
                {"type": "way", "role": "outer", "geometry": [{"lat": 0, "lon": 0}, {"lat": 0, "lon": 2}]},
                {"type": "way", "role": "outer", "geometry": [{"lat": 0, "lon": 2}, {"lat": 2, "lon": 2}]},
                {"type": "way", "role": "outer", "geometry": [{"lat": 2, "lon": 2}, {"lat": 2, "lon": 0}]},
                {"type": "way", "role": "outer", "geometry": [{"lat": 2, "lon": 0}, {"lat": 0, "lon": 0}]},
                {"type": "way", "role": "inner", "geometry": [{"lat": 0.5, "lon": 0.5}, {"lat": 0.5, "lon": 1.5}, {"lat": 1.5, "lon": 1.5}, {"lat": 0.5, "lon": 0.5}]},
            ],
        }
        result = normalize_overpass({"elements": [relation]})
        geometry = result["features"][0]["geometry"]
        self.assertEqual(geometry["type"], "MultiPolygon")
        self.assertEqual(len(geometry["coordinates"][0]), 2)

    def test_containing_boundary_query_is_point_bounded_and_level_filtered(self):
        query = build_containing_boundary_query(43.1001, -79.6002, admin_level="8")
        self.assertIn("is_in(43.1001000,-79.6002000)->.containingAreas;", query)
        self.assertIn('rel(pivot.containingAreas)["boundary"="administrative"]["admin_level"="8"]', query)
        self.assertIn("out body center;", query)

    def test_named_place_resolves_to_containing_municipality_relation(self):
        store = HeadlessSessionStore()
        place = {
            "name": "Smithville",
            "display_name": "Smithville, Ontario, Canada",
            "lat": "43.1001",
            "lon": "-79.6002",
            "class": "place",
            "type": "village",
        }
        containing = {
            "type": "relation",
            "id": 900,
            "tags": {"boundary": "administrative", "admin_level": "8", "name": "West Lincoln Township"},
        }
        ward = {
            "type": "relation",
            "id": 901,
            "tags": {"boundary": "administrative", "admin_level": "9", "name": "Smithville Ward"},
        }
        exact_relation = {
            "type": "relation",
            "id": 900,
            "tags": {"boundary": "administrative", "admin_level": "8", "name": "West Lincoln Township"},
            "members": [{"type": "way", "role": "outer", "geometry": [
                {"lat": 43.0, "lon": -79.7}, {"lat": 43.0, "lon": -79.5},
                {"lat": 43.2, "lon": -79.5}, {"lat": 43.0, "lon": -79.7},
            ]}],
        }
        with patch.object(store, "_nominatim_search", return_value=[place]), \
             patch("services.headless_service.search_overpass_containing_boundaries", return_value={"elements": [ward, containing]}), \
             patch("services.headless_service.search_overpass_element", return_value={"elements": [exact_relation]}) as exact_lookup, \
             patch("services.headless_service.search_overpass") as broad_search:
            result = store._run_osm_search({
                "loc": "Smithville, ON",
                "requested_place": "Smithville",
                "boundary_target": "containing_municipality",
                "requested_admin_level": "8",
                "tags": [{"key": "boundary", "val": "administrative"}, {"key": "admin_level", "val": "8"}],
                "featName": "Smithville",
                "geomType": "all",
            })

        self.assertEqual(result["feature_count"], 1)
        self.assertEqual(result["metadata"]["resolved_boundary_name"], "West Lincoln Township")
        self.assertEqual(result["metadata"]["resolved_boundary_osm_id"], 900)
        self.assertEqual(result["feature_collection"]["features"][0]["properties"]["requested_place"], "Smithville")
        exact_lookup.assert_called_once_with("relation", 900)
        broad_search.assert_not_called()

    def test_ambiguous_containing_boundaries_are_not_selected_silently(self):
        store = HeadlessSessionStore()
        place = {"name": "Smithville", "lat": "43.1", "lon": "-79.6", "class": "place", "type": "village"}
        relations = [
            {"type": "relation", "id": 900, "tags": {"boundary": "administrative", "admin_level": "8", "name": "West Lincoln Township"}},
            {"type": "relation", "id": 901, "tags": {"boundary": "administrative", "admin_level": "8", "name": "Alternate Township"}},
        ]
        with patch.object(store, "_nominatim_search", return_value=[place]), \
             patch("services.headless_service.search_overpass_containing_boundaries", return_value={"elements": relations}):
            result = store._run_osm_search({
                "loc": "Smithville, ON",
                "requested_place": "Smithville",
                "boundary_target": "containing_municipality",
                "requested_admin_level": "8",
                "tags": [{"key": "boundary", "val": "administrative"}, {"key": "admin_level", "val": "8"}],
                "featName": "Smithville",
                "geomType": "all",
            })
        self.assertTrue(result["boundary_ambiguity"])
        self.assertEqual({item["id"] for item in result["boundary_candidates"]}, {900, 901})

    def test_compound_osm_query_keeps_feature_and_spatial_reference_separate(self):
        spec = HeadlessSessionStore().parse_osm_query("fire hydrants on Fairview Street in Burlington, Ontario")
        self.assertEqual(spec.feature_concept, "fire hydrants")
        self.assertEqual(spec.location, "Burlington, Ontario")
        self.assertEqual(spec.spatial_constraints[0].reference, "Fairview Street")

    def test_named_street_request_is_an_exact_line_search(self):
        store = HeadlessSessionStore()
        prompt = "give me a vector line for Fairview Street in Burlington, Ontario"
        spec = store.parse_osm_query(prompt)
        self.assertEqual(spec.feature_concept, "street")
        self.assertEqual(spec.feature_name, "Fairview Street")
        self.assertEqual(spec.location, "Burlington, Ontario")
        self.assertEqual(spec.geometry, "lines_polygons")

        intent = store.classify_intent(prompt)
        self.assertEqual(intent.theme, "roads")
        self.assertEqual(intent.tags, [{"key": "highway", "val": ""}])
        plan = store.summarize_plan(prompt)
        osm = next(action for action in plan["actions"] if action["type"] == "osm_search")
        self.assertEqual(osm["input"]["featName"], "Fairview Street")
        self.assertTrue(osm["input"]["exactName"])
        self.assertTrue(osm["input"]["wayOnly"])
        self.assertEqual(osm["input"]["geomType"], "lines_polygons")

    def test_named_boundary_request_is_scoped_to_the_named_city(self):
        store = HeadlessSessionStore()
        place = {
            "name": "Vancouver",
            "display_name": "Vancouver, Metro Vancouver, British Columbia, Canada",
            "osm_type": "relation",
            "osm_id": 123,
            "class": "boundary",
            "type": "administrative",
            "geojson": {
                "type": "Polygon",
                "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 0]]],
            },
        }
        with patch.object(store, "_nominatim_search", return_value=[place]) as nominatim, \
             patch("services.headless_service.search_overpass") as overpass:
            result = store._run_osm_search({
                "loc": "Vancouver, BC",
                "tags": [
                    {"key": "boundary", "val": "administrative"},
                    {"key": "admin_level", "val": "8"},
                ],
                "featName": "Vancouver",
                "exactName": True,
                "geomType": "all",
            })
        self.assertEqual(result["feature_count"], 1)
        self.assertEqual(result["feature_collection"]["features"][0]["properties"]["name"], place["display_name"])
        nominatim.assert_called_once()
        overpass.assert_not_called()

    def test_boundary_intent_precedes_fuzzy_place_name_feature_matching(self):
        store = HeadlessSessionStore()
        intent = store.classify_intent("outline of Welland, ON", allow_remote=False)
        self.assertEqual(intent.theme, "administrative boundary")
        self.assertEqual(intent.tags, [{"key": "boundary", "val": "administrative"}])
        self.assertNotEqual(intent.theme, "wetlands")

        standalone = store.classify_intent("Welland", allow_remote=False)
        self.assertNotEqual(standalone.theme, "wetlands")

    def test_explicit_feature_phrase_keeps_fuzzy_matching_separate_from_location(self):
        store = HeadlessSessionStore()
        intent = store.classify_intent("fire hydrents near Welland", allow_remote=False)
        self.assertEqual(intent.theme, "fire hydrants")
        self.assertEqual(intent.tags, [{"key": "emergency", "val": "fire_hydrant"}])

    def test_named_boundary_prefers_requested_admin_level(self):
        store = HeadlessSessionStore()
        ward = {
            "name": "Vancouver",
            "display_name": "Vancouver Ward",
            "osm_type": "relation",
            "osm_id": 124,
            "class": "boundary",
            "type": "administrative",
            "importance": 0.99,
            "extratags": {"admin_level": "9"},
            "geojson": {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 0]]]},
        }
        city = {
            "name": "Vancouver",
            "display_name": "Vancouver City",
            "osm_type": "relation",
            "osm_id": 123,
            "class": "boundary",
            "type": "administrative",
            "importance": 0.5,
            "extratags": {"admin_level": "8"},
            "geojson": {"type": "Polygon", "coordinates": [[[0, 0], [2, 0], [2, 2], [0, 0]]]},
        }
        with patch.object(store, "_nominatim_search", return_value=[ward, city]):
            result = store._resolve_boundary_geometry("Vancouver", "Vancouver, BC", admin_level="8")
        self.assertEqual(result["features"][0]["properties"]["name"], "Vancouver City")

    def test_named_street_query_uses_exact_name_and_way_geometry(self):
        query = build_query(
            [{"key": "highway", "val": ""}],
            feat_name="Fairview Street",
            geom_type="lines_polygons",
            bbox=[43.3, -79.9, 43.4, -79.7],
            include_geometry=True,
            exact_name=True,
            way_only=True,
        )
        self.assertIn('way["highway"]["name"~"^Fairview Street$",i]', query)
        self.assertNotIn('relation["highway"]', query)
        self.assertIn("out body geom;", query)

    def test_named_way_proximity_query_keeps_road_relation_in_overpass(self):
        query = build_named_way_proximity_query(
            [{"key": "emergency", "val": "fire_hydrant"}],
            "Jarvis Street",
            10,
            area_id=3600000000 + 123,
            geom_type="points",
        )
        self.assertIn("area(3600000123)->.searchArea;", query)
        self.assertIn('way["highway"]["name"~"^Jarvis Street$",i](area.searchArea)->.referenceRoad;', query)
        self.assertIn('node(around.referenceRoad:10)["emergency"="fire_hydrant"];', query)
        self.assertNotIn("(43.", query)

    def test_named_way_proximity_query_escapes_street_name(self):
        query = build_named_way_proximity_query(
            [{"key": "amenity", "val": "cafe"}],
            'Queen (West) Street',
            25,
            bbox=[43.6, -79.5, 43.7, -79.3],
            geom_type="points",
        )
        self.assertIn(r"Queen \\(West\\) Street", query)

    def test_named_street_search_passes_exact_line_constraints_to_overpass(self):
        store = HeadlessSessionStore()
        raw = {"elements": [{"type": "way", "id": 17, "tags": {"highway": "tertiary", "name": "Fairview Street"}, "geometry": [{"lat": 43.35, "lon": -79.8}, {"lat": 43.351, "lon": -79.799}]}]}
        with patch("services.headless_service.search_overpass", return_value=raw) as overpass:
            result = store._run_osm_search({
                "loc": "Burlington, Ontario",
                "tags": [{"key": "highway", "val": ""}],
                "featName": "Fairview Street",
                "exactName": True,
                "wayOnly": True,
                "geomType": "lines_polygons",
            })
        self.assertEqual(result["feature_count"], 1)
        call = overpass.call_args.kwargs
        self.assertEqual(call["feat_name"], "Fairview Street")
        self.assertTrue(call["exact_name"])
        self.assertTrue(call["way_only"])
        self.assertEqual(call["geom_type"], "lines_polygons")

    def test_named_street_retries_without_highway_tag_when_needed(self):
        store = HeadlessSessionStore()
        raw = {"elements": [{"type": "way", "id": 18, "tags": {"name": "Fairview Street"}, "geometry": [{"lat": 43.35, "lon": -79.8}, {"lat": 43.351, "lon": -79.799}]}]}
        with patch("services.headless_service.search_overpass", side_effect=[{"elements": []}, raw]) as overpass:
            result = store._run_osm_search({
                "loc": "Burlington, Ontario",
                "tags": [{"key": "highway", "val": ""}],
                "featName": "Fairview Street",
                "exactName": True,
                "wayOnly": True,
                "geomType": "lines_polygons",
            })
        self.assertEqual(result["feature_count"], 1)
        self.assertEqual(overpass.call_args_list[1].kwargs["tags"], [])
        self.assertTrue(any("exact name" in message for message in result["search_diagnostics"]))

    def test_named_street_is_not_confused_with_a_street_reference(self):
        store = HeadlessSessionStore()
        spec = store.parse_osm_query("fire hydrants on Fairview Street in Burlington, Ontario")
        self.assertIsNone(spec.feature_name)
        self.assertEqual(spec.spatial_constraints[0].relation, "on")
        plan = store.summarize_plan("fire hydrants on Fairview Street in Burlington, Ontario")
        osm = next(action for action in plan["actions"] if action["type"] == "osm_search")
        self.assertNotIn("featName", osm["input"])
        self.assertEqual(osm["input"]["street"], "Fairview Street")

    def test_hosted_planner_uses_responses_api_schema_shape(self):
        store = HeadlessSessionStore()
        store._openai_api_key = "test-key"
        store._openai_model = "gpt-4.1-mini"
        response = MagicMock(status_code=200)
        response.json.return_value = {"output_text": '{"actions": []}'}
        with patch("services.headless_service.requests.post", return_value=response) as post:
            actions = store._plan_with_llm("show parks")
        self.assertEqual(actions, [])
        body = post.call_args.kwargs["json"]
        output_format = body["text"]["format"]
        self.assertEqual(output_format["type"], "json_schema")
        self.assertEqual(output_format["name"], "headless_plan")
        self.assertIn("schema", output_format)
        self.assertTrue(output_format["strict"])
        self.assertNotIn("json_schema", output_format)

        def assert_strict_objects(value):
            if isinstance(value, dict):
                if value.get("type") == "object":
                    self.assertFalse(value.get("additionalProperties", True))
                    self.assertEqual(set(value.get("required", [])), set((value.get("properties") or {}).keys()))
                for child in value.values():
                    assert_strict_objects(child)
            elif isinstance(value, list):
                for child in value:
                    assert_strict_objects(child)

        assert_strict_objects(output_format["schema"])

    def test_known_osm_request_bypasses_hosted_planner(self):
        store = HeadlessSessionStore()
        with patch.dict(os.environ, {"OPENAI_API_KEY": "test-key"}, clear=False), patch.object(store, "_plan_with_llm_result") as hosted:
            plan = store.summarize_plan("fire hydrants on Fairview Street in Burlington, Ontario")
        hosted.assert_not_called()
        self.assertEqual(plan["planner"]["mode"], "local")
        osm = next(action for action in plan["actions"] if action["type"] == "osm_search")
        self.assertEqual(osm["input"]["tags"], [{"key": "emergency", "val": "fire_hydrant"}])
        self.assertEqual(osm["input"]["relation"], "on")
        self.assertEqual(osm["input"]["street"], "Fairview Street")

    def test_local_mode_never_calls_hosted_planner(self):
        store = HeadlessSessionStore()
        with patch.dict(os.environ, {"OPENAI_API_KEY": "test-key"}, clear=False), patch.object(store, "_plan_with_llm_result") as hosted:
            plan = store.summarize_plan("wildlife observation towers in Halifax", mode="local")
        hosted.assert_not_called()
        self.assertEqual(plan["planner"]["mode"], "local")
        self.assertEqual(plan["actions"][0]["type"], "unsupported")

    def test_unresolved_request_uses_hosted_assistance_and_is_cached(self):
        store = HeadlessSessionStore()
        response = MagicMock(status_code=200)
        response.json.return_value = {"output_text": json.dumps({
            "actions": [{"type": "osm_search", "payload": {"tags": [{"key": "man_made", "val": "lighthouse"}], "loc": "Halifax", "geomType": "points"}}],
            "clarification": "",
        })}
        with patch.dict(os.environ, {"OPENAI_API_KEY": "test-key"}, clear=False), patch("services.headless_service.requests.post", return_value=response) as post:
            plan = store.summarize_plan("wildlife observation towers in Halifax")
            cached = store.summarize_plan("wildlife observation towers in Halifax")
        self.assertEqual(plan["planner"]["mode"], "hosted")
        self.assertEqual(cached["planner"]["mode"], "hosted-cache")
        self.assertEqual(post.call_count, 1)
        self.assertLessEqual(post.call_args.kwargs["timeout"], 12)
        self.assertEqual(plan["actions"][0]["input"]["tags"], [{"key": "man_made", "val": "lighthouse"}])

    def test_hosted_failure_falls_back_and_opens_circuit(self):
        store = HeadlessSessionStore()
        with patch.dict(os.environ, {"OPENAI_API_KEY": "test-key"}, clear=False), patch("services.headless_service.requests.post", side_effect=ValueError("malformed response")) as post:
            first = store.summarize_plan("wildlife observation towers in Halifax")
            second = store.summarize_plan("wildlife observation towers in Halifax")
        self.assertEqual(post.call_count, 1)
        self.assertEqual(first["planner"]["mode"], "hosted-fallback-local")
        self.assertEqual(second["planner"]["mode"], "hosted-fallback-local")
        self.assertEqual(second["actions"][0]["type"], "unsupported")

    def test_proximity_query_requires_distance_before_search(self):
        store = HeadlessSessionStore()
        spec = store.parse_osm_query("fire hydrants near Fairview Street in Burlington, Ontario")
        self.assertEqual(spec.spatial_constraints[0].relation, "near")
        plan = store.summarize_plan("fire hydrants on Fairview Street in Burlington, Ontario")
        self.assertIn("How close", plan["clarification"])
        refined = store.summarize_plan(
            "25 metres",
            conversation=[
                {"role": "user", "content": "fire hydrants on Fairview Street in Burlington, Ontario"},
                {"role": "assistant", "content": "Please provide a distance."},
                {"role": "user", "content": "25 metres"},
            ],
        )
        refined_osm = next(action for action in refined["actions"] if action["type"] == "osm_search")
        self.assertEqual(refined_osm["input"]["street"], "Fairview Street")
        self.assertEqual(refined_osm["input"]["relation"], "on")
        self.assertEqual(refined_osm["input"]["distance_km"], 0.025)
        self.assertIsNone(refined["clarification"])
        with self.assertRaisesRegex(ValueError, "How close"):
            store.execute_action(
                "osm_search",
                {"tags": [{"key": "emergency", "val": "fire_hydrant"}], "street": "Fairview Street", "loc": "Burlington, Ontario"},
                confirmed=True,
            )

    def test_spatial_radius_uses_metric_projection(self):
        source = {"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [-79.8, 43.35]}, "properties": {"name": "near"}}, {"type": "Feature", "geometry": {"type": "Point", "coordinates": [-80.0, 43.35]}, "properties": {"name": "far"}}]}
        result = operate(source, {"operation": "radius", "center": {"lat": 43.35, "lng": -79.8}, "radius_km": 2})
        self.assertEqual(result["feature_count"], 1)
        self.assertEqual(result["feature_collection"]["features"][0]["properties"]["name"], "near")

    def test_spatial_attribute_comparison(self):
        source = {"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [0, 0]}, "properties": {"population": 10}}, {"type": "Feature", "geometry": {"type": "Point", "coordinates": [1, 1]}, "properties": {"population": 2}}]}
        result = operate(source, {"operation": "attribute", "column": "population", "operator": ">", "value": 5})
        self.assertEqual(result["feature_count"], 1)

    def test_typo_corrected_osm_street_search_expands_geocoder_bbox(self):
        store = HeadlessSessionStore()
        place = {"display_name": "Fairview Street, Burlington, Ontario", "type": "road", "boundingbox": ["43.350", "43.351", "-79.800", "-79.799"], "geojson": {"type": "LineString", "coordinates": [[-79.800, 43.350], [-79.799, 43.350]]}, "address": {"city": "Burlington", "province": "Ontario"}}
        with patch.object(store, "_nominatim_search", return_value=[place]), patch("services.headless_service.search_overpass_near_named_way", return_value={"elements": [{"type": "node", "id": 42, "lat": 43.3501, "lon": -79.7995, "tags": {"emergency": "fire_hydrant"}}], "_query": "named-way"}) as overpass:
            result = store._run_osm_search({"street": "Fairview Street", "loc": "Burlington, ON", "distance_km": 0.025, "tags": [{"key": "emergency", "val": "fire_hydrant"}], "geomType": "points"})
        self.assertEqual(result["feature_count"], 1)
        self.assertTrue(result["searched_bboxes"])
        self.assertGreater(result["searched_bboxes"][0][2] - result["searched_bboxes"][0][0], 0.0009)
        overpass.assert_called_once()

    def test_street_search_filters_features_to_requested_distance(self):
        store = HeadlessSessionStore()
        street = {"display_name": "Fairview Street, Burlington, Ontario", "type": "road", "boundingbox": ["43.350", "43.351", "-79.800", "-79.799"], "geojson": {"type": "LineString", "coordinates": [[-79.800, 43.350], [-79.799, 43.350]]}, "address": {"city": "Burlington"}}
        raw = {"elements": [
            {"type": "node", "id": 1, "lat": 43.3501, "lon": -79.7995, "tags": {"emergency": "fire_hydrant", "name": "near"}},
            {"type": "node", "id": 2, "lat": 43.3515, "lon": -79.7995, "tags": {"emergency": "fire_hydrant", "name": "far"}},
        ]}
        with patch.object(store, "_nominatim_search", return_value=[street]), patch("services.headless_service.search_overpass_near_named_way", return_value={"elements": [raw["elements"][0]], "_query": "named-way"}):
            result = store._run_osm_search({"street": "Fairview Street", "loc": "Burlington, ON", "distance_km": 0.025, "tags": [{"key": "emergency", "val": "fire_hydrant"}], "geomType": "points"})
        self.assertEqual(result["feature_count"], 1)
        self.assertEqual(result["feature_collection"]["features"][0]["properties"]["name"], "near")

    def test_street_search_does_not_fall_back_to_the_entire_city(self):
        store = HeadlessSessionStore()
        with patch.object(store, "_nominatim_search", return_value=[]), patch("services.headless_service.search_overpass_near_named_way", return_value={"elements": []}) as overpass:
            result = store._run_osm_search({
                "street": "Jarvis Street",
                "loc": "Toronto",
                "distance_km": 0.01,
                "tags": [{"key": "emergency", "val": "fire_hydrant"}],
                "geomType": "points",
            })
        self.assertEqual(result["feature_count"], 0)
        overpass.assert_not_called()
        self.assertTrue(any("city-wide fallback was blocked" in message for message in result["search_diagnostics"]))

    def test_street_search_uses_area_id_and_does_not_stop_after_one_segment(self):
        store = HeadlessSessionStore()
        place = {
            "display_name": "Toronto, Ontario, Canada",
            "name": "Toronto",
            "osm_type": "relation",
            "osm_id": 123,
            "class": "boundary",
            "type": "administrative",
            "boundingbox": ["43.5", "43.9", "-79.7", "-79.0"],
        }
        raw = {"elements": [
            {"type": "node", "id": 1, "lat": 43.65, "lon": -79.37, "tags": {"emergency": "fire_hydrant"}},
        ], "_query": "named-way"}
        with patch.object(store, "_nominatim_search", return_value=[place]), patch("services.headless_service.search_overpass_near_named_way", return_value=raw) as overpass:
            result = store._run_osm_search({
                "street": "Jarvis Street",
                "relation": "on",
                "loc": "Toronto",
                "distance_km": 0.01,
                "tags": [{"key": "emergency", "val": "fire_hydrant"}],
                "geomType": "points",
            })
        self.assertEqual(result["feature_count"], 1)
        self.assertEqual(overpass.call_args.kwargs["area_id"], 3600000123)
        self.assertEqual(overpass.call_args.kwargs["distance_m"], 10)
        self.assertEqual(result["metadata"]["strategy"], "named_way_around")

    def test_street_distance_filter_rejects_features_when_road_geometry_is_missing(self):
        elements = [{"type": "node", "id": 1, "lat": 43.35, "lon": -79.8, "tags": {"emergency": "fire_hydrant"}}]
        street_without_geometry = {"display_name": "Jarvis Street, Toronto", "type": "road", "boundingbox": ["43.35", "43.351", "-79.8", "-79.799"]}
        self.assertEqual(HeadlessSessionStore._filter_elements_near_street(elements, [street_without_geometry], 0.01), [])

    def test_typo_and_everyday_osm_language_are_understood(self):
        store = HeadlessSessionStore()
        intent = store.classify_intent("fire hidrant on Fairview Street in Burlington, ON")
        self.assertEqual(intent.theme, "fire hydrants")
        self.assertEqual(intent.tags, [{"key": "emergency", "val": "fire_hydrant"}])
        spec = store.parse_osm_query("parks within 500 m of downtown in Burlington, ON")
        self.assertEqual(spec.location, "Burlington, ON")
        self.assertEqual(spec.spatial_constraints[0].reference, "downtown")
        self.assertEqual(spec.spatial_constraints[0].distance_km, 0.5)

    def test_sentence_punctuation_and_common_distance_units_are_normalized(self):
        store = HeadlessSessionStore()
        spec = store.parse_osm_query("fire hydrants on Jarvis St. in Toronto.")
        self.assertEqual(spec.location, "Toronto")
        self.assertEqual(spec.spatial_constraints[0].reference, "Jarvis St")
        self.assertAlmostEqual(store._distance_from_prompt("33 feet"), 0.0100584)
        self.assertEqual(store._distance_from_prompt("1 mile"), 1.609344)

    def test_appended_distance_is_removed_from_location_and_applied_to_relation(self):
        store = HeadlessSessionStore()
        for prompt in (
            "fire hydrants on Jarvis Street in Toronto 10m",
            "fire hydrants on Jarvis Street in Toronto\n10m",
            "fire hydrants on Jarvis Street in Toronto. 10m",
        ):
            spec = store.parse_osm_query(prompt)
            self.assertEqual(spec.location, "Toronto")
            self.assertEqual(spec.spatial_constraints[0].reference, "Jarvis Street")
            self.assertEqual(spec.spatial_constraints[0].distance_km, 0.01)
            plan = store.summarize_plan(prompt)
            self.assertIsNone(plan["clarification"])
            osm = next(action for action in plan["actions"] if action["type"] == "osm_search")
            self.assertEqual(osm["input"]["distance_km"], 0.01)

    def test_feature_matching_does_not_use_unrelated_substrings(self):
        store = HeadlessSessionStore()
        intent = store.classify_intent("lighthouses in Halifax", allow_remote=False)
        self.assertEqual(intent.source, "unknown")
        self.assertEqual(intent.tags, [])

    def test_feature_only_plan_uses_current_map_and_correct_tag_shape(self):
        store = HeadlessSessionStore()
        plan = store.summarize_plan("show parks", workspace={"mapBounds": {"south": 43, "west": -80, "north": 44, "east": -79}})
        osm = next(action for action in plan["actions"] if action["type"] == "osm_search")
        self.assertEqual(osm["input"]["tags"], [{"key": "leisure", "val": "park"}])
        self.assertNotIn("featName", osm["input"])
        self.assertEqual(store.classify_intent("bike paths").theme, "bike routes")

    def test_invalid_polygon_is_repaired_and_winding_normalized(self):
        collection = {"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [2, 2], [0, 2], [2, 0], [0, 0]]]}, "properties": {"name": "broken boundary"}}]}
        repaired = repair_feature_collection(collection)
        geometry = repaired["features"][0]["geometry"]
        self.assertIn(geometry["type"], {"Polygon", "MultiPolygon"})
        self.assertEqual(repaired["metadata"]["repaired_geometry_count"], 1)

    def test_overpass_normalization_does_not_modify_invalid_geometry(self):
        raw = {"elements": [{"type": "way", "id": 99, "tags": {"boundary": "administrative"}, "geometry": [{"lat": 0, "lon": 0}, {"lat": 2, "lon": 2}, {"lat": 0, "lon": 2}, {"lat": 2, "lon": 0}, {"lat": 0, "lon": 0}]}]}
        normalized = normalize_overpass(raw)
        self.assertFalse(shape(normalized["features"][0]["geometry"]).is_valid)

    def test_spatial_buffer_uses_local_metric_crs(self):
        source = {"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [-79.8, 43.35]}, "properties": {"name": "near"}}]}
        result = operate(source, {"operation": "buffer", "distance_m": 100})
        self.assertEqual(result["metric_crs"], "EPSG:32617")
        self.assertNotIn("3857", result["feature_collection"]["metadata"]["metric_crs"])

    def test_spatial_join_preserves_source_and_prefixed_target_properties(self):
        source = {"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [0.5, 0.5]}, "properties": {"source_name": "point"}}]}
        target = {"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]}, "properties": {"zone": "A"}}]}
        result = operate(source, {"operation": "spatial_join", "predicate": "within", "target": target})
        self.assertEqual(result["feature_count"], 1)
        self.assertEqual(result["feature_collection"]["features"][0]["properties"]["join_zone"], "A")

    def test_spatial_dwithin_uses_a_metric_projection_for_target_geometry(self):
        source = {"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [-79.8, 43.35]}, "properties": {"name": "near"}}]}
        result = operate(source, {"operation": "dwithin", "geometry": {"type": "Point", "coordinates": [-79.8, 43.35]}, "distance_m": 5})
        self.assertEqual(result["feature_count"], 1)
        self.assertEqual(result["metric_crs"], "EPSG:32617")

    def test_spatial_missing_crs_is_explicitly_reported(self):
        source = {"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [0, 0]}, "properties": {}}]}
        result = operate(source, {"operation": "buffer", "distance_m": 10})
        self.assertTrue(any("EPSG:4326" in warning for warning in result["warnings"]))

    def test_semantic_embedding_cache_reuses_unchanged_metadata_and_invalidates_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            cache_path = os.path.join(directory, "embeddings.json")
            first = LayerSearchIndex(cache_path)
            first._model = MagicMock()
            first._model.encode.return_value = [1.0, 0.0]
            first.build([{"title": "Flood risk", "description": "floodplain data"}])
            self.assertTrue(first.search("flood risk"))
            calls_after_first = first._model.encode.call_count

            second = LayerSearchIndex(cache_path)
            second._model = MagicMock()
            second._model.encode.return_value = [1.0, 0.0]
            second.build([{"title": "Flood risk", "description": "floodplain data"}])
            self.assertTrue(second.search("flood risk"))
            self.assertEqual(second._model.encode.call_count, 1, "the unchanged layer vector should come from disk")

            second.build([{"title": "Flood risk", "description": "coastal erosion data"}])
            second.search("flood risk")
            self.assertGreater(second._model.encode.call_count, 1, "metadata changes should create a new vector key")

    def test_explicit_osm_word_does_not_duplicate_a_known_search_action(self):
        plan = HeadlessSessionStore().summarize_plan("find OSM fire hydrants in Toronto")
        self.assertEqual([action["type"] for action in plan["actions"]].count("osm_search"), 1)

    def test_proximity_reference_alias_cannot_bypass_distance_filter(self):
        store = HeadlessSessionStore()
        with self.assertRaisesRegex(ValueError, "How close"):
            store.execute_action("osm_search", {"proximity_reference": "Jarvis Street", "relation": "near", "loc": "Toronto", "tags": [{"key": "emergency", "val": "fire_hydrant"}]}, confirmed=True)

if __name__ == "__main__":
    unittest.main()
