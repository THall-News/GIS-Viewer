"""Small, deterministic geographic coverage resolver for catalog searches.

Catalog eligibility must not depend on a language model or on keyword ranking.
The bboxes here are deliberately conservative regional envelopes, suitable for
screening metadata extents.  They are not intended to replace authoritative
administrative boundary geometry.
"""
from __future__ import annotations

import re
import unicodedata
from typing import Any


# [south, west, north, east].  The envelopes include the province/territory
# and a small amount of offshore/outer-area coverage so published service
# extents are not rejected because of a few decimal places.
CANADIAN_REGIONS: dict[str, dict[str, Any]] = {
    "Alberta": {"aliases": ("ab", "alta", "alberta"), "bbox": [48.99, -120.0, 60.0, -110.0]},
    "British Columbia": {"aliases": ("bc", "b.c.", "british columbia"), "bbox": [48.2, -139.1, 60.1, -114.0]},
    "Manitoba": {"aliases": ("mb", "man", "manitoba"), "bbox": [49.0, -102.1, 60.1, -95.8]},
    "New Brunswick": {"aliases": ("nb", "new brunswick"), "bbox": [44.5, -69.1, 48.1, -63.7]},
    "Newfoundland and Labrador": {
        "aliases": ("nl", "newfoundland", "newfoundland and labrador", "newfoundland & labrador"),
        "bbox": [46.4, -67.9, 60.5, -52.5],
    },
    "Nova Scotia": {"aliases": ("ns", "nova scotia"), "bbox": [43.3, -66.5, 47.1, -59.6]},
    "Ontario": {"aliases": ("on", "ont", "ontario"), "bbox": [41.6, -95.2, 56.9, -74.0]},
    "Prince Edward Island": {"aliases": ("pei", "p.e.i.", "prince edward island"), "bbox": [45.9, -64.5, 47.1, -61.9]},
    "Quebec": {"aliases": ("qc", "québec", "quebec"), "bbox": [44.9, -79.8, 62.6, -57.1]},
    "Saskatchewan": {"aliases": ("sk", "sask", "saskatchewan"), "bbox": [49.0, -110.1, 60.1, -101.9]},
    "Northwest Territories": {"aliases": ("nt", "nwt", "northwest territories"), "bbox": [60.0, -136.5, 78.0, -101.0]},
    "Nunavut": {"aliases": ("nu", "nunavut"), "bbox": [51.7, -120.0, 83.2, -61.0]},
    "Yukon": {"aliases": ("yt", "yukon", "yukon territory"), "bbox": [59.5, -141.1, 69.7, -123.8]},
    "Canada": {"aliases": ("ca", "can", "canada", "nationwide", "national"), "bbox": [41.6, -141.1, 83.2, -52.5]},
}

# The Canadian records above are also used by the catalog coverage filter, so
# keep their existing shape and add stable codes separately.  The codes are
# useful when Nominatim returns ISO3166-2 address fields instead of a full
# province name.
CANADIAN_REGION_CODES = {
    "Alberta": "CA-AB",
    "British Columbia": "CA-BC",
    "Manitoba": "CA-MB",
    "New Brunswick": "CA-NB",
    "Newfoundland and Labrador": "CA-NL",
    "Nova Scotia": "CA-NS",
    "Ontario": "CA-ON",
    "Prince Edward Island": "CA-PE",
    "Quebec": "CA-QC",
    "Saskatchewan": "CA-SK",
    "Northwest Territories": "CA-NT",
    "Nunavut": "CA-NU",
    "Yukon": "CA-YT",
    "Canada": "CA",
}

# Nominatim handles full names well, but a short qualifier such as ``ON``,
# ``Ont.``, ``IN`` or ``USA`` is easy to lose when a place has namesakes.  The
# registry is deliberately data-only so additional jurisdictions can be
# added without changing the matching algorithm.  State bboxes are optional:
# address/ISO evidence is authoritative when a usable bbox is unavailable.
US_REGION_ALIASES: dict[str, tuple[str, ...]] = {
    "Alabama": ("al", "ala", "alabama"),
    "Alaska": ("ak", "alaska"),
    "Arizona": ("az", "ariz", "arizona"),
    "Arkansas": ("ar", "ark", "arkansas"),
    "California": ("ca", "calif", "california"),
    "Colorado": ("co", "colo", "colorado"),
    "Connecticut": ("ct", "conn", "connecticut"),
    "Delaware": ("de", "del", "delaware"),
    "Florida": ("fl", "fla", "florida"),
    "Georgia": ("ga", "georgia"),
    "Hawaii": ("hi", "hawaii"),
    "Idaho": ("id", "idaho"),
    "Illinois": ("il", "ill", "illinois"),
    "Indiana": ("in", "ind", "indiana"),
    "Iowa": ("ia", "iowa"),
    "Kansas": ("ks", "kan", "kansas"),
    "Kentucky": ("ky", "ken", "kentucky"),
    "Louisiana": ("la", "louisiana"),
    "Maine": ("me", "maine"),
    "Maryland": ("md", "maryland"),
    "Massachusetts": ("ma", "mass", "massachusetts"),
    "Michigan": ("mi", "mich", "michigan"),
    "Minnesota": ("mn", "minn", "minnesota"),
    "Mississippi": ("ms", "miss", "mississippi"),
    "Missouri": ("mo", "missouri"),
    "Montana": ("mt", "mont", "montana"),
    "Nebraska": ("ne", "neb", "nebraska"),
    "Nevada": ("nv", "nev", "nevada"),
    "New Hampshire": ("nh", "n.h.", "new hampshire"),
    "New Jersey": ("nj", "n.j.", "new jersey"),
    "New Mexico": ("nm", "n.m.", "new mexico"),
    "New York": ("ny", "n.y.", "new york"),
    "North Carolina": ("nc", "n.c.", "north carolina"),
    "North Dakota": ("nd", "n.d.", "north dakota"),
    "Ohio": ("oh", "ohio"),
    "Oklahoma": ("ok", "okla", "oklahoma"),
    "Oregon": ("or", "ore", "oregon"),
    "Pennsylvania": ("pa", "penn", "pennsylvania"),
    "Rhode Island": ("ri", "r.i.", "rhode island"),
    "South Carolina": ("sc", "s.c.", "south carolina"),
    "South Dakota": ("sd", "s.d.", "south dakota"),
    "Tennessee": ("tn", "tenn", "tennessee"),
    "Texas": ("tx", "tex", "texas"),
    "Utah": ("ut", "utah"),
    "Vermont": ("vt", "vermont"),
    "Virginia": ("va", "virg", "virginia"),
    "Washington": ("wa", "wash", "washington"),
    "West Virginia": ("wv", "w.va.", "west virginia"),
    "Wisconsin": ("wi", "wis", "wisconsin"),
    "Wyoming": ("wy", "wyo", "wyoming"),
    "District of Columbia": ("dc", "d.c.", "district of columbia", "washington dc", "washington, dc"),
}

COUNTRY_ALIASES: dict[str, tuple[str, ...]] = {
    "Canada": ("ca", "can", "canada"),
    "United States": ("us", "usa", "u.s.", "u.s.a.", "united states", "united states of america"),
    "United Kingdom": ("uk", "gb", "gbr", "u.k.", "united kingdom", "great britain"),
    "Australia": ("au", "aus", "australia"),
    "New Zealand": ("nz", "nzl", "new zealand"),
}


def _text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip())


def normalize_region_text(value: Any) -> str:
    """Normalize geographic aliases without treating substrings as regions.

    Punctuation is removed so ``On.``, ``ON`` and ``ont.`` can be compared
    consistently.  Token boundaries are applied later; this is important for
    avoiding accidental matches such as the country code ``ca`` inside a
    place name like ``Cayuga``.
    """
    value = unicodedata.normalize("NFKC", _text(value)).lower()
    value = value.replace("&", " and ")
    value = re.sub(r"[\u2010-\u2015\-]", "-", value)
    value = re.sub(r"[.,;:()\[\]{}]", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def _region_records() -> list[tuple[str, dict[str, Any], str]]:
    records: list[tuple[str, dict[str, Any], str]] = []
    for name, record in CANADIAN_REGIONS.items():
        records.append((name, record, "subdivision" if name != "Canada" else "country"))
    for name, aliases in US_REGION_ALIASES.items():
        records.append((name, {"aliases": aliases, "bbox": None, "country": "United States"}, "subdivision"))
    for name, aliases in COUNTRY_ALIASES.items():
        if name == "Canada":
            continue
        records.append((name, {"aliases": aliases, "bbox": None, "country": name}, "country"))
    return records


def _alias_is_token_sequence(text: str, alias: str) -> bool:
    if not text or not alias:
        return False
    text_tokens = text.split()
    alias_tokens = alias.split()
    width = len(alias_tokens)
    positions = range(len(text_tokens) - width + 1)
    # Two- and three-letter codes are highly ambiguous in prose (``in``,
    # ``or``, ``me``, ``ca``).  Only accept them as a trailing qualifier when
    # they are not the complete input.  Full names remain searchable anywhere
    # in a natural-language location string.
    compact_alias = "".join(alias_tokens)
    if len(compact_alias) <= 3:
        positions = (len(text_tokens) - width,)
    return any(text_tokens[index:index + width] == alias_tokens for index in positions if index >= 0)


def normalize_bbox(value: Any) -> list[float] | None:
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        return None
    try:
        south, west, north, east = [float(item) for item in value]
    except (TypeError, ValueError):
        return None
    if not (-90 <= south <= 90 and -90 <= north <= 90 and -180 <= west <= 180 and -180 <= east <= 180):
        return None
    return [min(south, north), min(west, east), max(south, north), max(west, east)]


def resolve_region(value: Any) -> dict[str, Any] | None:
    text = normalize_region_text(value)
    if not text:
        return None
    matches: list[tuple[int, int, str, dict[str, Any], str]] = []
    for name, record, kind in _region_records():
        for alias in record["aliases"]:
            normalized_alias = normalize_region_text(alias)
            if text == normalized_alias or _alias_is_token_sequence(text, normalized_alias):
                # Prefer a specific subdivision over a country match and a
                # longer alias over a short two-letter code.
                matches.append((1 if kind == "subdivision" else 0, len(normalized_alias.split()), name, record, kind))
    if matches:
        _, _, name, record, kind = max(matches, key=lambda item: (item[0], item[1]))
        result = {
            "name": name,
            "bbox": list(record["bbox"]) if record.get("bbox") else None,
            "kind": "region",
            "region_kind": kind,
            "country": record.get("country") or ("Canada" if name in CANADIAN_REGIONS else name),
            "code": CANADIAN_REGION_CODES.get(name),
            "matched_alias": next(
                alias for alias in record["aliases"]
                if normalize_region_text(alias) == normalize_region_text(text)
                or _alias_is_token_sequence(text, normalize_region_text(alias))
            ),
        }
        return result
    return None


def resolve_region_from_text(value: Any) -> dict[str, Any] | None:
    """Find the most specific known region in a natural-language search.

    The match is whole-token based, so a two-letter country code cannot be
    discovered inside an unrelated place name.  The registry currently covers
    Canadian provinces/territories, US states/DC, and common country aliases;
    unknown full names remain available to the Nominatim address validator.
    """
    raw = _text(value)
    if "," in raw:
        # Comma-separated address qualifiers are the safest place to interpret
        # short codes, including ``Cayuga, ON, Canada``. Prefer a subdivision
        # qualifier over the trailing country qualifier.
        part_matches = [resolve_region(part) for part in raw.split(",")]
        part_matches = [item for item in part_matches if item]
        if part_matches:
            return max(part_matches, key=lambda item: (item.get("region_kind") == "subdivision", len(str(item.get("name") or ""))))
    return resolve_region(raw)


def resolve_region_context(value: Any) -> dict[str, Any] | None:
    """Resolve a known region or preserve an explicit comma-qualified name.

    The registry handles common codes and aliases.  For a full qualifier that
    is not in the registry yet (``Place, Country``), retaining the qualifier
    still lets the boundary resolver require matching Nominatim address
    evidence instead of choosing a same-named place elsewhere.
    """
    known = resolve_region_from_text(value)
    if known:
        return known
    raw = _text(value)
    if "," not in raw:
        return None
    qualifier = _text(raw.rsplit(",", 1)[-1]).strip(" .")
    if not qualifier:
        return None
    return {
        "name": qualifier,
        "bbox": None,
        "kind": "region",
        "region_kind": "unresolved",
        "country": None,
        "code": None,
        "matched_alias": qualifier,
    }


def bbox_intersects(first: Any, second: Any) -> bool:
    a = normalize_bbox(first)
    b = normalize_bbox(second)
    if not a or not b:
        return False
    return not (a[3] < b[1] or a[1] > b[3] or a[2] < b[0] or a[0] > b[2])


def coverage_status(layer_bbox: Any, request_bbox: Any) -> str:
    layer = normalize_bbox(layer_bbox)
    request = normalize_bbox(request_bbox)
    if not layer or not request:
        return "unknown"
    if not bbox_intersects(layer, request):
        return "outside"
    if layer[0] <= request[0] and layer[1] <= request[1] and layer[2] >= request[2] and layer[3] >= request[3]:
        return "contains"
    return "intersects"
