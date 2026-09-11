"""Hybrid lexical/semantic search over GIS layer metadata.

Embeddings are deliberately optional: the catalog remains useful in a clean
installation and upgrades transparently when sentence-transformers is present.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
from pathlib import Path
from typing import Any

TOKEN_RE = re.compile(r"[\w:-]+", re.UNICODE)

# These words describe the request grammar, not a dataset.  Keeping them in
# the index was the cause of unrelated services matching a query solely on
# the word "in".
STOPWORDS = {
    "a", "an", "and", "around", "at", "data", "find", "for", "from", "get", "in", "into",
    "layer", "layers", "map", "me", "near", "of", "on", "please", "show", "the", "to", "using",
    "within", "with", "zone", "what", "where", "dataset", "datasets", "gis",
}

QUERY_ALIASES = {
    "fire evacuation zones": ("evacuation orders", "evacuation alerts", "wildfire", "emergency", "alert areas"),
    "evacuation zones": ("evacuation orders", "evacuation alerts", "wildfire"),
    "fire evacuation": ("wildfire", "evacuation orders", "evacuation alerts"),
}

SEARCHABLE_FIELDS = (
    "title", "displayName", "display_name", "name", "description", "provider", "protocol", "format", "type",
    "themes", "tags", "fields", "geographic_hints", "keywords", "search_aliases", "source_display_name",
    "serviceName", "layerName", "geometryType", "resourceUrl",
)


def _text(item: dict[str, Any]) -> str:
    values = []

    def flatten(value: Any) -> None:
        if isinstance(value, dict):
            for key, child in value.items():
                if key.lower() in {"bbox", "coordinates", "geometry"}:
                    continue
                flatten(child)
        elif isinstance(value, (list, tuple, set)):
            for child in value:
                flatten(child)
        elif value is not None:
            values.append(str(value))

    for key in SEARCHABLE_FIELDS:
        flatten(item.get(key, ""))
    extent = item.get("geographic_extent") or item.get("geographicExtent") or {}
    if isinstance(extent, dict):
        flatten(extent.get("name"))
    return " ".join(values).lower()


def _tokens(value: str) -> set[str]:
    return {token for token in TOKEN_RE.findall(value.lower()) if token not in STOPWORDS and len(token) > 1}


def _query_tokens(value: str) -> set[str]:
    tokens = _tokens(value)
    lowered = value.lower()
    for phrase, aliases in QUERY_ALIASES.items():
        if phrase in lowered:
            for alias in aliases:
                tokens.update(_tokens(alias))
    return tokens


class LayerSearchIndex:
    def __init__(self, cache_path: str | Path | None = None):
        self.cache_path = str(cache_path) if cache_path else None
        self._model = None
        self._items: list[dict[str, Any]] = []
        self._vectors: dict[str, list[float]] = self._load_vectors()

    def _load_vectors(self) -> dict[str, list[float]]:
        if not self.cache_path:
            return {}
        try:
            value = json.loads(Path(self.cache_path).read_text(encoding="utf-8"))
            vectors = value.get("vectors", value) if isinstance(value, dict) else {}
            return {str(key): [float(item) for item in vector] for key, vector in vectors.items() if isinstance(vector, list)}
        except (OSError, ValueError, TypeError):
            return {}

    def _persist_vectors(self) -> None:
        if not self.cache_path:
            return
        path = Path(self.cache_path)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps({"version": 1, "vectors": self._vectors}, separators=(",", ":")), encoding="utf-8")
        except OSError:
            # A read-only cache must never disable catalog search.
            return

    def build(self, items: list[dict[str, Any]]) -> None:
        self._items = [dict(item) for item in items if isinstance(item, dict)]
        # Metadata hashes are part of each vector key. A changed title,
        # description, field list, or geographic hint therefore gets a new
        # embedding automatically; unchanged catalog entries reuse the cache.

    def _embedding(self, text: str) -> list[float] | None:
        try:
            if self._model is None:
                from sentence_transformers import SentenceTransformer
                self._model = SentenceTransformer("all-MiniLM-L6-v2")
            return list(map(float, self._model.encode(text, normalize_embeddings=True)))
        except Exception:
            return None

    @staticmethod
    def _cosine(a: list[float], b: list[float]) -> float:
        return max(0.0, min(1.0, sum(x * y for x, y in zip(a, b))))

    def search(
        self,
        query: str,
        *,
        limit: int = 10,
        bbox: list[float] | None = None,
        protocol: str | None = None,
        provider: str | None = None,
        theme: str | None = None,
    ) -> list[dict[str, Any]]:
        q = (query or "").strip().lower()
        if not q:
            return []
        qt = _query_tokens(q)
        if not qt:
            return []
        qvec = self._embedding(q)
        results = []
        for item in self._items:
            item_protocol = str(item.get("protocol") or item.get("format") or item.get("type") or "").lower()
            item_provider = str(item.get("provider") or item.get("source") or "").lower()
            if protocol and item_protocol != protocol.lower():
                continue
            if provider and provider.lower() not in item_provider:
                continue
            text = _text(item)
            tokens = _tokens(text)
            overlap = len(qt & tokens) / max(1, len(qt))
            phrase = 1.0 if q in text else 0.0
            title_text = " ".join(str(item.get(key) or "") for key in ("title", "displayName", "display_name", "name")).lower()
            title_overlap = len(_query_tokens(title_text) & qt) / max(1, len(qt))
            semantic = 0.0
            if qvec:
                key = hashlib.sha256(text.encode()).hexdigest()
                if key not in self._vectors:
                    vector = self._embedding(text)
                    if vector:
                        self._vectors[key] = vector
                        self._persist_vectors()
                if self._vectors.get(key):
                    semantic = self._cosine(qvec, self._vectors[key])
            geo = 0.0
            ib = item.get("bbox") or item.get("geographic_bbox")
            if bbox and isinstance(ib, (list, tuple)) and len(ib) == 4 and len(bbox) == 4:
                geo = 1.0 if not (ib[3] < bbox[1] or ib[1] > bbox[3] or ib[2] < bbox[0] or ib[0] > bbox[2]) else 0.0
            theme_match = 0.0
            if theme:
                theme_tokens = _tokens(theme)
                theme_match = len(theme_tokens & tokens) / max(1, len(theme_tokens))
            validation = str(item.get("validation_status") or item.get("validation") or "").lower()
            validation_score = 1.0 if validation in {"valid", "validated", "verified"} else 0.0
            relevance = .38 * overlap + .15 * phrase + .12 * semantic + .10 * geo + .10 * theme_match + .15 * title_overlap
            score = min(1.0, relevance + .10 * validation_score)
            # Validation improves the ordering of a relevant result; it must
            # never make every validated catalog entry match an unrelated
            # query by itself.
            # Geographic coverage is a useful tie-breaker, but it is not
            # evidence that a dataset answers the query.  A semantic model may
            # supply evidence when lexical metadata is sparse, but weak model
            # similarity alone is deliberately ignored.
            has_match = overlap > 0 or phrase > 0 or semantic >= 0.65
            if has_match and relevance >= 0.12:
                reasons = []
                if phrase: reasons.append("exact metadata phrase")
                if overlap: reasons.append("keyword metadata match")
                if title_overlap: reasons.append("dataset title match")
                if semantic: reasons.append("semantic similarity")
                if geo: reasons.append("geographic coverage overlap")
                if validation_score: reasons.append("validated source")
                if theme_match: reasons.append("theme match")
                result = dict(item)
                result.update(score=round(score, 4), match_reasons=reasons, search_confidence=round(score, 4))
                results.append(result)
        self._persist_vectors()
        return sorted(results, key=lambda x: x["score"], reverse=True)[:max(1, min(int(limit), 50))]


def catalog_items(servers: list[dict[str, Any]], workspace: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    items = [dict(item, source="saved_catalog") for item in servers]
    workspace = workspace or {}
    for layer in (workspace.get("activeLayers") or []):
        if not layer.get("isFolder"):
            items.append(dict(layer, source="workspace", title=layer.get("displayName"), name=layer.get("displayName")))
    for item in workspace.get("catalogSearchResults") or workspace.get("catalogResults") or []:
        if isinstance(item, dict):
            items.append(dict(item, source=item.get("source") or "discovered_catalog"))
    return items
