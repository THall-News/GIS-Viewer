"""HTTP client used by GIS Layer Previewer to consume the catalog service."""
from __future__ import annotations

from typing import Any

import requests

from config import CATALOG_SERVICE_URL


class CatalogUnavailableError(RuntimeError):
    pass


class CatalogClient:
    def __init__(self, base_url: str | None = None, *, timeout: float = 12.0):
        self.base_url = (base_url or CATALOG_SERVICE_URL).rstrip("/")
        self.timeout = timeout

    def _request(self, method: str, path: str, **kwargs) -> dict[str, Any]:
        kwargs.setdefault("timeout", self.timeout)
        try:
            response = requests.request(method, f"{self.base_url}{path}", **kwargs)
            payload = response.json() if getattr(response, "content", b"") else {}
        except (requests.RequestException, ValueError) as exc:
            raise CatalogUnavailableError(f"Catalog service unavailable at {self.base_url}: {str(exc)[:200]}") from exc
        if response.status_code >= 400:
            message = payload.get("error") if isinstance(payload, dict) else None
            raise CatalogUnavailableError(message or f"Catalog service returned HTTP {response.status_code}")
        return payload if isinstance(payload, dict) else {}

    def search(self, query: str, *, region: str | None = None, bbox: Any = None, limit: int = 10, protocol: str | None = None, provider: str | None = None, theme: str | None = None) -> dict[str, Any]:
        return self._request("POST", "/api/catalog/search", json={
            "query": query, "region": region, "bbox": bbox, "limit": limit,
            "protocol": protocol, "provider": provider, "theme": theme,
        })

    def sources(self) -> dict[str, Any]:
        return self._request("GET", "/api/catalog/sources")

    def add_source(self, source: dict[str, Any]) -> dict[str, Any]:
        return self._request("POST", "/api/catalog/sources", json=source)
