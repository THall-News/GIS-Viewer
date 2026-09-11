import os
import unittest
from unittest.mock import patch

from services.discovery_service import discover_sources


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self.payload


class DiscoveryServiceTests(unittest.TestCase):
    def test_openai_web_response_json_is_converted_to_source_candidates(self):
        payload = {
            "output_text": '{"results":[{"url":"https://www.canada.ca/data/fire","title":"Fire evacuation data","snippet":"Official GIS dataset"}]}'
        }
        with patch.dict(os.environ, {"OPENAI_API_KEY": "test-key"}, clear=True), \
             patch("services.discovery_service.requests.post", return_value=FakeResponse(payload)) as post, \
             patch("services.discovery_service.is_public_url", return_value=True):
            result = discover_sources("fire evacuation zones in BC")
        self.assertEqual(result["message"], "Discovery completed.")
        self.assertEqual(result["candidates"][0]["title"], "Fire evacuation data")
        body = post.call_args.kwargs["json"]
        self.assertEqual(body["text"]["format"]["type"], "json_schema")
        self.assertEqual(body["text"]["format"]["schema"]["required"], ["results"])

    def test_configured_provider_with_no_results_is_not_reported_as_unconfigured(self):
        with patch.dict(os.environ, {"OPENAI_API_KEY": "test-key"}, clear=True), \
             patch("services.discovery_service.requests.post", return_value=FakeResponse({"output_text": '{"results":[]}'})):
            result = discover_sources("something with no results")
        self.assertEqual(result["message"], "No public GIS sources matched the query.")

    def test_missing_provider_is_reported_distinctly(self):
        with patch.dict(os.environ, {}, clear=True):
            result = discover_sources("fire evacuation zones in BC")
        self.assertEqual(result["message"], "No web search provider configured.")


if __name__ == "__main__":
    unittest.main()
