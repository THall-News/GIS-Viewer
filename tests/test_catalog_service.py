import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from services.catalog_service import build_catalog_records
from services.semantic_search import LayerSearchIndex


class FakeResponse:
    def __init__(self, *, content=b"", payload=None):
        self.content = content
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


WFS_XML = b"""
<wfs:WFS_Capabilities xmlns:wfs="http://www.opengis.net/wfs" xmlns:ows="http://www.opengis.net/ows">
  <ows:ServiceIdentification><ows:Title>DataBC Public Web Feature Service</ows:Title></ows:ServiceIdentification>
  <wfs:FeatureTypeList>
    <wfs:FeatureType>
      <wfs:Name>pub:EMRG_ORDER_AND_ALERT_AREAS_SPKML</wfs:Name>
      <wfs:Title>Evacuation Orders and Alerts Areas</wfs:Title>
      <wfs:Abstract>Active wildfire evacuation orders and alerts in British Columbia.</wfs:Abstract>
      <wfs:Keywords><wfs:Keyword>wildfire</wfs:Keyword><wfs:Keyword>emergency</wfs:Keyword></wfs:Keywords>
      <ows:WGS84BoundingBox><ows:LowerCorner>-139 48</ows:LowerCorner><ows:UpperCorner>-114 60</ows:UpperCorner></ows:WGS84BoundingBox>
    </wfs:FeatureType>
  </wfs:FeatureTypeList>
</wfs:WFS_Capabilities>
"""


class CatalogServiceTests(unittest.TestCase):
    def test_wfs_capabilities_are_indexed_as_individual_layers(self):
        source = {
            "id": "bc",
            "display_name": "BC Open maps",
            "name": "DataBC Public Web Feature Service",
            "provider": "DataBC",
            "type": "WFS",
            "url": "https://openmaps.gov.bc.ca/geo/ows?service=WFS&request=GetCapabilities",
            "description": "WFS service",
        }
        with tempfile.TemporaryDirectory() as directory, patch("services.catalog_service.requests.get", return_value=FakeResponse(content=WFS_XML)):
            records, warnings, stats = build_catalog_records([source], Path(directory) / "catalog.json")
        self.assertFalse(warnings)
        self.assertEqual(stats["indexed_record_count"], 1)
        self.assertEqual(records[0]["title"], "Evacuation Orders and Alerts Areas")
        self.assertEqual(records[0]["layerName"], "pub:EMRG_ORDER_AND_ALERT_AREAS_SPKML")
        self.assertEqual(records[0]["provider"], "DataBC")
        self.assertEqual(records[0]["bbox"], [48.0, -139.0, 60.0, -114.0])

    def test_cache_prevents_repeated_capabilities_requests(self):
        source = {"id": "bc", "display_name": "BC", "type": "WFS", "url": "https://example.gov/wfs"}
        with tempfile.TemporaryDirectory() as directory, patch("services.catalog_service.requests.get", return_value=FakeResponse(content=WFS_XML)) as get:
            path = Path(directory) / "catalog.json"
            build_catalog_records([source], path)
            build_catalog_records([source], path)
        self.assertEqual(get.call_count, 1)

    def test_arcgis_layers_are_indexed_with_layer_metadata(self):
        source = {
            "id": "bc-esri",
            "display_name": "BC ArcGIS",
            "provider": "DataBC",
            "type": "ARCGIS",
            "url": "https://example.gov/arcgis/rest/services/Wildfire/FeatureServer",
        }
        root = {"name": "Wildfire", "layers": [{"id": 0, "name": "Evacuation Areas", "parentLayerId": -1}]}
        detail = {
            "id": 0,
            "name": "Evacuation Areas",
            "description": "Wildfire evacuation orders and alerts",
            "geometryType": "esriGeometryPolygon",
            "fields": [{"name": "ORDER_ID", "alias": "Order ID"}],
            "extent": {"xmin": -139, "ymin": 48, "xmax": -114, "ymax": 60, "spatialReference": {"wkid": 4326}},
        }

        def get(url, **kwargs):
            return FakeResponse(payload=detail if url.endswith("/0?f=json") else root)

        with tempfile.TemporaryDirectory() as directory, patch("services.catalog_service.requests.get", side_effect=get):
            records, warnings, _stats = build_catalog_records([source], Path(directory) / "catalog.json")
        self.assertFalse(warnings)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["title"], "Evacuation Areas")
        self.assertEqual(records[0]["geometryType"], "esriGeometryPolygon")
        self.assertEqual(records[0]["bbox"], [48.0, -139.0, 60.0, -114.0])

    def test_stopwords_and_low_confidence_do_not_return_unrelated_source(self):
        index = LayerSearchIndex()
        index.build([{
            "title": "GY_FirstNations",
            "description": "Yukon First Nations description",
            "provider": "Unknown Provider",
            "type": "ARCGIS",
        }])
        self.assertEqual(index.search("Fire evacuation zones in British Columbia"), [])

    def test_bc_evacuation_layer_ranks_as_a_catalog_match(self):
        index = LayerSearchIndex()
        index.build([{
            "title": "Evacuation Orders and Alerts Areas",
            "name": "pub:EMRG_ORDER_AND_ALERT_AREAS_SPKML",
            "description": "Active wildfire evacuation orders and alerts in British Columbia",
            "provider": "DataBC",
            "source_display_name": "BC Open maps",
            "protocol": "wfs",
            "keywords": ["wildfire", "emergency"],
        }])
        results = index.search("Fire evacuation zones in British Columbia")
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["provider"], "DataBC")
        self.assertIn("dataset title match", results[0]["match_reasons"])


if __name__ == "__main__":
    unittest.main()
