import tempfile
import unittest
from unittest.mock import patch

import services.headless_service as headless_module
from services.headless_service import HeadlessSessionStore
from services.guided_assistant import _assistant_sources


class GuidedAssistantTests(unittest.TestCase):
    def make_store(self, directory):
        return HeadlessSessionStore()

    def test_assistant_requires_at_least_one_selected_provider(self):
        with self.assertRaisesRegex(ValueError, "exactly one"):
            _assistant_sources({"catalog": False, "osm": False, "web": False})

    def test_assistant_rejects_multiple_selected_providers(self):
        with self.assertRaisesRegex(ValueError, "exactly one"):
            _assistant_sources({"catalog": True, "osm": True})

    def test_explicit_osm_boundary_request_uses_verified_mapping(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(headless_module, "HEADLESS_DB_FILE", f"{directory}/assistant.sqlite3"):
            store = self.make_store(directory)
            with patch.object(store, "_run_osm_search", return_value={
                "feature_count": 1,
                "feature_collection": {"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": {"type": "Polygon", "coordinates": []}, "properties": {}}]},
            }) as osm_search:
                response = store.assistant_turn({
                    "request": "boundary of Vancouver, BC",
                    "workspace": {},
                    "sources": {"catalog": False, "osm": True, "web": False},
                })
                self.assertEqual(response["state"], "results")
                self.assertEqual(len(response["results"]["osm"]), 1)
                osm_search.assert_called_once()
                payload = osm_search.call_args.args[0]
                self.assertEqual(payload["loc"], "Vancouver, BC")
                self.assertEqual(payload["featName"], "Vancouver")
                self.assertEqual(payload["boundary_target"], "containing_municipality")
                self.assertEqual(payload["requested_place"], "Vancouver")
                self.assertEqual(payload["requested_admin_level"], "8")
                self.assertIn({"key": "boundary", "val": "administrative"}, payload["tags"])
                self.assertIn({"key": "admin_level", "val": "8"}, payload["tags"])

    def test_province_boundary_uses_provincial_admin_level(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(headless_module, "HEADLESS_DB_FILE", f"{directory}/assistant.sqlite3"):
            store = self.make_store(directory)
            with patch.object(store, "_run_osm_search", return_value={
                "feature_count": 1,
                "feature_collection": {"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": {"type": "Polygon", "coordinates": []}, "properties": {}}]},
            }) as osm_search:
                store.assistant_turn({
                    "request": "outline of Ontario",
                    "workspace": {},
                    "sources": {"catalog": False, "osm": True},
                })
                payload = osm_search.call_args.args[0]
                self.assertEqual(payload["requested_admin_level"], "4")
                self.assertEqual(payload["boundary_target"], "province_or_territory")

    def test_clarification_preserves_original_request_and_region(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(headless_module, "HEADLESS_DB_FILE", f"{directory}/assistant.sqlite3"):
            store = self.make_store(directory)
            with patch.object(store, "_run_osm_search") as osm_search:
                first = store.assistant_turn({
                    "request": "Fire evacuation zones in BC",
                    "workspace": {},
                    "sources": {"catalog": False, "osm": True},
                })
                self.assertEqual(first["state"], "clarification_required")
                self.assertEqual(first["originalRequest"], "Fire evacuation zones in BC")
                self.assertEqual(first["clarification"]["field"], "feature_definition")
                self.assertEqual(first["interpretation"]["location"], {"text": "British Columbia", "kind": "region"})
                self.assertEqual(first["sources"], {"catalog": False, "osm": True})
                self.assertNotIn("web", first["results"])
                osm_search.assert_not_called()

                second = store.assistant_turn({
                    "sessionId": first["sessionId"],
                    "reply": {"clarificationId": first["clarification"]["id"], "text": "fire hazard area"},
                    "workspace": {},
                })
                self.assertEqual(second["state"], "results")
                self.assertEqual(second["originalRequest"], "Fire evacuation zones in BC")
                self.assertIn("fire hazard area", second["interpretation"]["searchQuery"].lower())
                self.assertEqual(second["interpretation"]["location"]["text"], "British Columbia")
                self.assertEqual(second["sources"], {"catalog": False, "osm": True})
                osm_search.assert_not_called()

    def test_regional_scope_does_not_request_distance(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(headless_module, "HEADLESS_DB_FILE", f"{directory}/assistant.sqlite3"):
            store = self.make_store(directory)
            with patch.object(store, "_run_search_layers", return_value={"layers": []}), \
                 patch.object(store, "_guided_discover_sources") as web_discovery:
                response = store.assistant_turn({"request": "Fire evacuation zones in BC", "workspace": {}, "sources": {"catalog": True, "osm": False}})
                self.assertIsNone(response["clarification"])
                self.assertNotIn("How close", " ".join(response["warnings"]))
                web_discovery.assert_not_called()

    def test_distance_clarification_is_applied_to_pending_request(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(headless_module, "HEADLESS_DB_FILE", f"{directory}/assistant.sqlite3"):
            store = self.make_store(directory)
            with patch.object(store, "_run_search_layers", return_value={"layers": []}), \
                 patch.object(store, "_run_osm_search", return_value={"feature_count": 0, "feature_collection": {"type": "FeatureCollection", "features": []}}) as osm_search:
                first = store.assistant_turn({"request": "fire hydrants near Main Street in Burlington", "workspace": {}, "sources": {"catalog": False, "osm": True}})
                self.assertEqual(first["clarification"]["field"], "distance")
                second = store.assistant_turn({
                    "sessionId": first["sessionId"],
                    "reply": {"clarificationId": first["clarification"]["id"], "text": "100 m"},
                    "workspace": {},
                })
                self.assertEqual(second["state"], "results")
                self.assertIsNone(second["clarification"])
                payload = osm_search.call_args.args[0]
                self.assertEqual(payload["distance_km"], 0.1)
                self.assertEqual(payload["near_place"], "Main Street")

    def test_pending_assistant_state_survives_store_reload(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(headless_module, "HEADLESS_DB_FILE", f"{directory}/assistant.sqlite3"):
            first_store = self.make_store(directory)
            with patch.object(first_store, "_run_search_layers", return_value={"layers": []}):
                first = first_store.assistant_turn({"request": "fire evacuation zones in BC", "workspace": {}, "sources": {"catalog": False, "osm": True}})

            second_store = self.make_store(directory)
            with patch.object(second_store, "_run_search_layers", return_value={"layers": []}):
                second = second_store.assistant_turn({
                    "sessionId": first["sessionId"],
                    "reply": {"clarificationId": first["clarification"]["id"], "text": "fire hazard area"},
                    "workspace": {},
                })
                self.assertEqual(second["originalRequest"], "fire evacuation zones in BC")
                self.assertEqual(second["interpretation"]["location"]["text"], "British Columbia")


if __name__ == "__main__":
    unittest.main()
