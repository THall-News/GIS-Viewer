"""Small, dependency-free language layer for approachable OSM searches."""
from __future__ import annotations

import re
from difflib import SequenceMatcher
from typing import Any


# These are deliberately human terms, not an attempt to mirror every OSM tag.
# The list is easy to extend and provides a stable fallback when an LLM is not
# configured or returns an unfamiliar phrase.
FEATURES: list[dict[str, Any]] = [
    {"name": "fire hydrants", "aliases": ["fire hydrant", "hydrants", "hydrant", "fire hidrant", "fire hydrents"], "tags": [{"key": "emergency", "val": "fire_hydrant"}], "geometry": "points"},
    {"name": "parks", "aliases": ["park", "parks", "green space", "green spaces", "public park"], "tags": [{"key": "leisure", "val": "park"}], "tag_alternatives": [[{"key": "leisure", "val": "garden"}], [{"key": "boundary", "val": "protected_area"}]], "geometry": "all"},
    {"name": "playgrounds", "aliases": ["playground", "playgrounds", "play ground"], "tags": [{"key": "leisure", "val": "playground"}], "geometry": "all"},
    {"name": "schools", "aliases": ["school", "schools", "elementary school", "public school"], "tags": [{"key": "amenity", "val": "school"}], "geometry": "all"},
    {"name": "hospitals", "aliases": ["hospital", "hospitals", "medical hospital"], "tags": [{"key": "amenity", "val": "hospital"}], "geometry": "all"},
    {"name": "restaurants", "aliases": ["restaurant", "restaurants", "places to eat", "dining"], "tags": [{"key": "amenity", "val": "restaurant"}], "geometry": "points"},
    {"name": "cafes", "aliases": ["cafe", "cafes", "coffee shop", "coffee shops", "coffeehouse"], "tags": [{"key": "amenity", "val": "cafe"}], "geometry": "points"},
    {"name": "libraries", "aliases": ["library", "libraries"], "tags": [{"key": "amenity", "val": "library"}], "geometry": "all"},
    {"name": "roads", "aliases": ["road", "roads", "street", "streets", "highway", "highways"], "tags": [{"key": "highway", "val": ""}], "geometry": "lines_polygons"},
    {"name": "trails", "aliases": ["trail", "trails", "walking trail", "walking trails", "path", "paths", "hiking trail"], "tags": [{"key": "highway", "val": "path"}], "geometry": "lines_polygons"},
    {"name": "bike routes", "aliases": ["bike route", "bike routes", "bicycle route", "cycling route", "bike paths", "cycling paths"], "tags": [{"key": "highway", "val": "cycleway"}], "tag_alternatives": [[{"key": "route", "val": "bicycle"}], [{"key": "highway", "val": "path"}, {"key": "bicycle", "val": "designated"}]], "geometry": "lines_polygons"},
    {"name": "waterways", "aliases": ["waterway", "waterways", "river", "rivers", "stream", "streams", "creek", "creeks"], "tags": [{"key": "waterway", "val": ""}], "geometry": "lines_polygons"},
    {"name": "lakes", "aliases": ["lake", "lakes", "pond", "ponds"], "tags": [{"key": "natural", "val": "water"}], "geometry": "all"},
    {"name": "wetlands", "aliases": ["wetland", "wetlands", "marsh", "marshes", "swamp"], "tags": [{"key": "natural", "val": "wetland"}], "tag_alternatives": [[{"key": "wetland", "val": ""}], [{"key": "landuse", "val": "wetland"}]], "geometry": "all"},
    {"name": "buildings", "aliases": ["building", "buildings"], "tags": [{"key": "building", "val": ""}], "geometry": "all"},
    {"name": "bus stops", "aliases": ["bus stop", "bus stops", "bus station"], "tags": [{"key": "highway", "val": "bus_stop"}], "geometry": "points"},
    {"name": "parking areas", "aliases": ["parking", "parking area", "parking lot", "car park"], "tags": [{"key": "amenity", "val": "parking"}], "geometry": "all"},
    {"name": "pharmacies", "aliases": ["pharmacy", "pharmacies", "drug store"], "tags": [{"key": "amenity", "val": "pharmacy"}], "geometry": "points"},
]

CORRECTIONS = {
    "hidrant": "hydrant", "hidrants": "hydrants", "hydrents": "hydrants", "hydrands": "hydrants",
    "playgound": "playground", "playgounds": "playgrounds", "restarant": "restaurant", "restraunt": "restaurant",
    "resturants": "restaurants", "pharamacy": "pharmacy", "librarry": "library", "schols": "schools",
}


def normalize_text(value: str) -> str:
    text = re.sub(r"\s+", " ", (value or "").strip().lower())
    for wrong, right in CORRECTIONS.items():
        text = re.sub(rf"\b{re.escape(wrong)}\b", right, text)
    return text


def correct_text(value: str) -> str:
    """Normalize spacing and spelling while preserving place-name casing."""
    text = re.sub(r"\s+", " ", (value or "").strip())
    # Users commonly paste a complete sentence into the prompt. Sentence
    # punctuation should not become part of a street or city name (for
    # example, "Toronto." or the abbreviation "St.").
    text = re.sub(r"[.!?;:]+$", "", text).strip()
    for wrong, right in CORRECTIONS.items():
        text = re.sub(rf"\b{re.escape(wrong)}\b", right, text, flags=re.IGNORECASE)
    return text


def _score_alias(alias: str, text: str) -> float:
    if re.search(rf"\b{re.escape(alias)}\b", text):
        return 1.0
    words = text.split()
    alias_words = alias.split()
    if len(words) < len(alias_words):
        return 0.0
    scores = []
    for i in range(len(words) - len(alias_words) + 1):
        candidate = " ".join(words[i:i + len(alias_words)])
        # Fuzzy matching is for spelling mistakes, not substrings or a
        # different word that happens to share a suffix ("lighthouses" must
        # not become the unrelated "houses" concept). Large length changes
        # are therefore rejected before comparing edit similarity.
        if abs(len(candidate) - len(alias)) > max(2, round(len(alias) * 0.25)):
            continue
        scores.append(SequenceMatcher(None, candidate, alias).ratio())
    return max(scores, default=0.0)


def infer_feature(text: str, *, allow_fuzzy: bool = True) -> dict[str, Any] | None:
    """Map a feature phrase to OSM tags.

    Fuzzy matching is useful for feature phrases, but it must be optional:
    proper names such as ``Welland`` can otherwise be mistaken for ``wetland``.
    Callers that have not separated a feature phrase from a place name should
    use exact alias matching by passing ``allow_fuzzy=False``.
    """
    normalized = normalize_text(text)
    best, best_score, best_alias_length = None, 0.0, 0
    for feature in FEATURES:
        scored_aliases = [( _score_alias(alias, normalized), len(alias.split())) for alias in feature["aliases"]]
        score, alias_length = max(scored_aliases, default=(0.0, 0))
        if score > best_score or (score == best_score and alias_length > best_alias_length):
            best, best_score, best_alias_length = feature, score, alias_length
    if best_score < 0.78 or (not allow_fuzzy and best_score < 1.0):
        return None
    return {**best, "confidence": round(best_score, 3)}


def feature_candidates(text: str) -> list[dict[str, Any]]:
    feature = infer_feature(text)
    return [feature] if feature else []
