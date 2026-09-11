import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from flask import Flask

from routes.catalog import catalog_bp
from services.catalog_repository import CatalogRepository
from services.catalog_service import CatalogManager, _deduplicate_layer_records
from services.guided_assistant import is_osm_fallback_approved


class CatalogSplitTests(unittest.TestCase):
    def make_manager(self):
        directory = tempfile.TemporaryDirectory()
        repository = CatalogRepository(Path(directory.name) / "catalog.sqlite3")
        manager = CatalogManager(repository)
        self.addCleanup(directory.cleanup)
        return manager

    def test_region_gate_excludes_other_provinces_and_unknown_coverage(self):
        manager = self.make_manager()
        manager.add_source({"id": "test", "name": "Test", "type": "WFS", "url": "https://example.test/wfs"})
        manager.repository.replace_layers("test", [
            {"id": "yukon", "title": "First Nations reserve boundaries", "description": "Yukon", "protocol": "wfs", "bbox": [60, -141, 69, -123]},
            {"id": "canada", "title": "First Nations reserve boundaries", "description": "Canada-wide", "protocol": "wfs", "bbox": [41, -141, 83, -52]},
            {"id": "unknown", "title": "First Nations reserve boundaries", "description": "No coverage", "protocol": "wfs"},
        ])
        result = manager.search("first nations reserve boundaries", region="Ontario")
        self.assertEqual([item["id"] for item in result["layers"]], ["canada"])
        self.assertEqual(result["rejected_outside_count"], 1)
        self.assertEqual(result["unknown_coverage_count"], 1)

    def test_connected_source_metadata_is_persisted_and_refresh_runs_are_visible(self):
        manager = self.make_manager()
        manager.add_source({"id": "source", "name": "Test", "type": "WFS", "url": "https://example.test/wfs"})
        with patch("services.catalog_service._ingest_server", return_value=("source", [{
            "id": "source:wfs:roads", "catalog_level": "layer", "title": "Ontario roads", "description": "roads", "protocol": "wfs", "bbox": [41, -95, 57, -74],
        }], None)):
            result = manager.refresh_source("source")
        self.assertEqual(result["status"], "completed")
        self.assertEqual(manager.repository.list_layers()[0]["title"], "Ontario roads")
        self.assertEqual(manager.repository.list_runs()[0]["status"], "completed")

    def test_catalog_api_supports_source_registration_and_search(self):
        manager = self.make_manager()
        app = Flask(__name__)
        app.extensions["catalog_manager"] = manager
        app.register_blueprint(catalog_bp)
        client = app.test_client()
        response = client.post("/api/catalog/sources", json={"id": "s", "name": "Source", "type": "WFS", "url": "https://example.test/wfs", "autoRefresh": False})
        self.assertEqual(response.status_code, 201)
        manager.repository.replace_layers("s", [{"id": "s:1", "title": "Ontario flood zones", "description": "flood zones", "protocol": "wfs", "bbox": [41, -95, 57, -74]}])
        response = client.post("/api/catalog/search", json={"query": "flood zones", "region": "Ontario"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["layers"][0]["id"], "s:1")

    def test_osm_fallback_is_restricted_for_authoritative_categories(self):
        self.assertFalse(is_osm_fallback_approved("First Nations reserve boundaries"))
        self.assertFalse(is_osm_fallback_approved("fire evacuation zones"))
        self.assertTrue(is_osm_fallback_approved("ordinary administrative boundaries"))

    def test_duplicate_arcgis_directory_records_do_not_abort_refresh(self):
        records, duplicate_count = _deduplicate_layer_records([
            {"id": "source:arcgis:duplicate", "protocol": "esri", "serviceUrl": "https://example.test/roads/FeatureServer", "layerUrl": "https://example.test/roads/FeatureServer/0", "title": "Roads"},
            {"id": "source:arcgis:duplicate", "protocol": "esri", "serviceUrl": "https://example.test/roads/FeatureServer", "layerUrl": "https://example.test/roads/FeatureServer/0", "title": "Roads"},
            {"id": "source:arcgis:duplicate", "protocol": "esri", "serviceUrl": "https://example.test/other/FeatureServer", "layerUrl": "https://example.test/other/FeatureServer/0", "title": "Other"},
        ])
        self.assertEqual(duplicate_count, 2)
        self.assertEqual(len(records), 2)
        self.assertEqual(len({record["id"] for record in records}), 2)

    def test_refresh_persists_deduplicated_records_instead_of_failing(self):
        manager = self.make_manager()
        manager.add_source({"id": "arcgis", "name": "ArcGIS", "type": "ARCGIS", "url": "https://example.test/rest/services"})
        with patch("services.catalog_service._ingest_server", return_value=("arcgis", [
            {"id": "same", "catalog_level": "layer", "title": "Roads", "protocol": "esri", "serviceUrl": "https://example.test/a/FeatureServer", "layerUrl": "https://example.test/a/FeatureServer/0"},
            {"id": "same", "catalog_level": "layer", "title": "Roads duplicate", "protocol": "esri", "serviceUrl": "https://example.test/b/FeatureServer", "layerUrl": "https://example.test/b/FeatureServer/0"},
        ], None)):
            result = manager.refresh_source("arcgis")
        self.assertEqual(result["status"], "completed")
        self.assertEqual(len(manager.repository.list_layers()), 2)


if __name__ == "__main__":
    unittest.main()
