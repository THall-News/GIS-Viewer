"""SQLite persistence for the standalone GIS catalog service."""
from __future__ import annotations

import json
import hashlib
import sqlite3
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

from services.region_service import normalize_bbox


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _json(value: Any, default: Any = None) -> str:
    try:
        return json.dumps(value if value is not None else default, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError):
        return json.dumps(default, ensure_ascii=False, separators=(",", ":"))


def _loads(value: Any, default: Any = None) -> Any:
    try:
        return json.loads(value) if value else default
    except (TypeError, ValueError):
        return default


class CatalogRepository:
    def __init__(self, path: str | Path):
        self.path = str(path)
        self._lock = threading.RLock()
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self.migrate()

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=30, check_same_thread=False)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA journal_mode = WAL")
        return connection

    def migrate(self) -> None:
        with self._lock, self.connect() as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS catalog_sources (
                    id TEXT PRIMARY KEY,
                    display_name TEXT NOT NULL,
                    name TEXT,
                    provider TEXT,
                    protocol TEXT NOT NULL,
                    url TEXT NOT NULL UNIQUE,
                    description TEXT,
                    themes_json TEXT NOT NULL DEFAULT '[]',
                    geographic_name TEXT,
                    bbox_json TEXT,
                    status TEXT NOT NULL DEFAULT 'pending',
                    stale INTEGER NOT NULL DEFAULT 0,
                    error TEXT,
                    last_attempt_at TEXT,
                    last_success_at TEXT,
                    next_refresh_at TEXT,
                    indexed_layer_count INTEGER NOT NULL DEFAULT 0,
                    legacy_json TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS catalog_layers (
                    id TEXT PRIMARY KEY,
                    source_id TEXT NOT NULL REFERENCES catalog_sources(id) ON DELETE CASCADE,
                    title TEXT NOT NULL,
                    name TEXT,
                    description TEXT,
                    provider TEXT,
                    protocol TEXT,
                    format TEXT,
                    layer_name TEXT,
                    layer_url TEXT,
                    service_url TEXT,
                    geometry_type TEXT,
                    fields_json TEXT NOT NULL DEFAULT '[]',
                    keywords_json TEXT NOT NULL DEFAULT '[]',
                    themes_json TEXT NOT NULL DEFAULT '[]',
                    aliases_json TEXT NOT NULL DEFAULT '[]',
                    bbox_json TEXT,
                    geographic_name TEXT,
                    coverage_status TEXT NOT NULL DEFAULT 'unknown',
                    validation_status TEXT,
                    stale INTEGER NOT NULL DEFAULT 0,
                    metadata_json TEXT NOT NULL DEFAULT '{}',
                    updated_at TEXT NOT NULL,
                    last_seen_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_catalog_layers_source ON catalog_layers(source_id);
                CREATE INDEX IF NOT EXISTS idx_catalog_layers_bbox ON catalog_layers(coverage_status);
                CREATE TABLE IF NOT EXISTS catalog_refresh_runs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    source_id TEXT,
                    status TEXT NOT NULL,
                    started_at TEXT NOT NULL,
                    finished_at TEXT,
                    indexed_count INTEGER NOT NULL DEFAULT 0,
                    warning TEXT,
                    error TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_catalog_runs_started ON catalog_refresh_runs(started_at DESC);
                CREATE TABLE IF NOT EXISTS catalog_refresh_errors (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id INTEGER REFERENCES catalog_refresh_runs(id) ON DELETE CASCADE,
                    source_id TEXT,
                    message TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                """
            )
            # FTS5 is available in the Python SQLite builds used by the app,
            # but the catalog remains functional on builds without the module.
            try:
                db.execute(
                    """CREATE VIRTUAL TABLE IF NOT EXISTS catalog_layers_fts USING fts5(
                        layer_id UNINDEXED, title, name, description, provider,
                        keywords, aliases, geographic_name
                    )"""
                )
            except sqlite3.OperationalError:
                pass
            # Keep upgrades from an early catalog prototype or a manually
            # copied SQLite file non-destructive.
            source_columns = {row["name"] for row in db.execute("PRAGMA table_info(catalog_sources)").fetchall()}
            if "next_refresh_at" not in source_columns:
                db.execute("ALTER TABLE catalog_sources ADD COLUMN next_refresh_at TEXT")
            db.commit()

    @staticmethod
    def _source_values(source: dict[str, Any]) -> dict[str, Any]:
        source_id = str(source.get("id") or source.get("source_id") or source.get("url") or "").strip()
        if not source_id:
            raise ValueError("catalog source id or url is required")
        protocol = str(source.get("type") or source.get("protocol") or "").strip().upper() or "UNKNOWN"
        extent = source.get("geographic_extent") or source.get("geographicExtent") or {}
        raw_extent_bbox = extent.get("bbox") if isinstance(extent, dict) else None
        if isinstance(raw_extent_bbox, (list, tuple)) and len(raw_extent_bbox) == 4:
            try:
                west, south, east, north = [float(item) for item in raw_extent_bbox]
                source_bbox = normalize_bbox([south, west, north, east])
            except (TypeError, ValueError):
                source_bbox = None
        else:
            source_bbox = normalize_bbox(source.get("bbox") or source.get("geographic_bbox"))
        return {
            "id": source_id,
            "display_name": str(source.get("display_name") or source.get("displayName") or source.get("name") or source_id).strip(),
            "name": str(source.get("name") or "").strip(),
            "provider": str(source.get("provider") or "").strip(),
            "protocol": protocol,
            "url": str(source.get("url") or "").strip(),
            "description": str(source.get("description") or "").strip(),
            "themes_json": _json(source.get("themes") or []),
            "geographic_name": str((source.get("geographic_extent") or {}).get("name") or source.get("geographic_name") or "").strip(),
            "bbox_json": _json(source_bbox),
            "legacy_json": _json(source),
        }

    def upsert_source(self, source: dict[str, Any]) -> dict[str, Any]:
        values = self._source_values(source)
        now = utc_now()
        with self._lock, self.connect() as db:
            by_url = db.execute("SELECT id FROM catalog_sources WHERE url = ?", (values["url"],)).fetchone() if values["url"] else None
            if by_url and by_url["id"] != values["id"]:
                values["id"] = by_url["id"]
            existing = db.execute("SELECT created_at FROM catalog_sources WHERE id = ?", (values["id"],)).fetchone()
            created = existing["created_at"] if existing else now
            db.execute(
                """INSERT INTO catalog_sources
                (id, display_name, name, provider, protocol, url, description,
                 themes_json, geographic_name, bbox_json, status, legacy_json,
                 created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                 display_name=excluded.display_name, name=excluded.name,
                 provider=excluded.provider, protocol=excluded.protocol,
                 url=excluded.url, description=excluded.description,
                 themes_json=excluded.themes_json, geographic_name=excluded.geographic_name,
                 bbox_json=excluded.bbox_json, legacy_json=excluded.legacy_json,
                 updated_at=excluded.updated_at""",
                tuple(values[key] for key in (
                    "id", "display_name", "name", "provider", "protocol", "url", "description",
                    "themes_json", "geographic_name", "bbox_json", "legacy_json",
                )) + (created, now),
            )
            db.commit()
        return self.get_source(values["id"]) or {}

    def import_legacy_sources(self, sources: Iterable[dict[str, Any]]) -> int:
        count = 0
        for source in sources or []:
            if isinstance(source, dict) and source.get("url"):
                self.upsert_source(source)
                count += 1
        return count

    @staticmethod
    def _source_from_row(row: sqlite3.Row) -> dict[str, Any]:
        result = dict(row)
        result["themes"] = _loads(result.pop("themes_json", "[]"), [])
        result["bbox"] = _loads(result.pop("bbox_json", "null"))
        if result.get("bbox"):
            south, west, north, east = result["bbox"]
            result["geographic_extent"] = {"name": result.get("geographic_name") or "", "bbox": [west, south, east, north]}
        result["stale"] = bool(result.get("stale"))
        result.pop("legacy_json", None)
        return result

    def get_source(self, source_id: str) -> dict[str, Any] | None:
        with self.connect() as db:
            row = db.execute("SELECT * FROM catalog_sources WHERE id = ?", (source_id,)).fetchone()
        return self._source_from_row(row) if row else None

    def get_source_by_url(self, url: str) -> dict[str, Any] | None:
        with self.connect() as db:
            row = db.execute("SELECT * FROM catalog_sources WHERE url = ?", (url,)).fetchone()
        return self._source_from_row(row) if row else None

    def list_sources(self) -> list[dict[str, Any]]:
        with self.connect() as db:
            rows = db.execute("SELECT * FROM catalog_sources ORDER BY display_name COLLATE NOCASE, id").fetchall()
        return [self._source_from_row(row) for row in rows]

    def list_due_sources(self) -> list[dict[str, Any]]:
        with self.connect() as db:
            rows = db.execute(
                "SELECT * FROM catalog_sources WHERE next_refresh_at IS NOT NULL AND next_refresh_at <= ? ORDER BY next_refresh_at",
                (utc_now(),),
            ).fetchall()
        return [self._source_from_row(row) for row in rows]

    def delete_source(self, source_id: str) -> bool:
        with self._lock, self.connect() as db:
            cursor = db.execute("DELETE FROM catalog_sources WHERE id = ?", (source_id,))
            db.commit()
            return cursor.rowcount > 0

    def mark_source_attempt(self, source_id: str, *, status: str, error: str | None = None, stale: bool = True) -> None:
        if status == "error":
            retry_at = (datetime.now(timezone.utc) + timedelta(seconds=300)).isoformat()
        elif status.startswith("healthy"):
            retry_at = (datetime.now(timezone.utc) + timedelta(seconds=86400)).isoformat()
        else:
            retry_at = None
        with self._lock, self.connect() as db:
            db.execute(
                "UPDATE catalog_sources SET status=?, stale=?, error=?, last_attempt_at=?, next_refresh_at=?, updated_at=? WHERE id=?",
                (status, int(stale), error, utc_now(), retry_at, utc_now(), source_id),
            )
            db.commit()

    def replace_layers(self, source_id: str, records: Iterable[dict[str, Any]]) -> int:
        now = utc_now()
        materialized = [dict(record) for record in records if isinstance(record, dict)]
        with self._lock, self.connect() as db:
            try:
                db.execute("DELETE FROM catalog_layers_fts WHERE layer_id IN (SELECT id FROM catalog_layers WHERE source_id = ?)", (source_id,))
            except sqlite3.OperationalError:
                pass
            db.execute("DELETE FROM catalog_layers WHERE source_id = ?", (source_id,))
            used_ids: set[str] = set()
            for index, record in enumerate(materialized):
                layer_id = str(record.get("id") or f"{source_id}:layer:{index}")
                if layer_id in used_ids:
                    signature = json.dumps(record, ensure_ascii=False, sort_keys=True, default=str)
                    layer_id = f"{layer_id}:duplicate:{hashlib.sha1(signature.encode('utf-8')).hexdigest()[:12]}"
                    suffix = 2
                    while layer_id in used_ids:
                        layer_id = f"{layer_id}:{suffix}"
                        suffix += 1
                bbox = normalize_bbox(record.get("bbox") or record.get("geographic_bbox"))
                record["id"] = layer_id
                used_ids.add(layer_id)
                record["source_id"] = source_id
                record["bbox"] = bbox
                record["coverage_status"] = "known" if bbox else "unknown"
                fields = record.get("fields") or []
                keywords = record.get("keywords") or record.get("tags") or []
                themes = record.get("themes") or []
                aliases = record.get("search_aliases") or []
                columns = (
                    layer_id, source_id, str(record.get("title") or record.get("name") or layer_id),
                    str(record.get("name") or ""), str(record.get("description") or ""),
                    str(record.get("provider") or ""), str(record.get("protocol") or ""),
                    str(record.get("format") or ""), str(record.get("layerName") or record.get("layer_name") or ""),
                    str(record.get("layerUrl") or record.get("layer_url") or ""),
                    str(record.get("serviceUrl") or record.get("service_url") or record.get("url") or ""),
                    str(record.get("geometryType") or record.get("geometry_type") or ""),
                    _json(fields, []), _json(keywords, []), _json(themes, []), _json(aliases, []),
                    _json(bbox), str(record.get("geographic_name") or ""), "known" if bbox else "unknown",
                    str(record.get("validation_status") or record.get("validation") or ""), 0,
                    _json(record, {}), now, now,
                )
                db.execute(
                    """INSERT INTO catalog_layers
                    (id, source_id, title, name, description, provider, protocol,
                     format, layer_name, layer_url, service_url, geometry_type,
                     fields_json, keywords_json, themes_json, aliases_json,
                     bbox_json, geographic_name, coverage_status, validation_status,
                     stale, metadata_json, updated_at, last_seen_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    columns,
                )
                try:
                    db.execute(
                        "INSERT INTO catalog_layers_fts(layer_id,title,name,description,provider,keywords,aliases,geographic_name) VALUES (?,?,?,?,?,?,?,?)",
                        (layer_id, columns[2], columns[3], columns[4], columns[5], " ".join(map(str, keywords)), " ".join(map(str, aliases)), columns[17]),
                    )
                except sqlite3.OperationalError:
                    pass
            db.execute(
                "UPDATE catalog_sources SET status='healthy', stale=0, error=NULL, last_success_at=?, last_attempt_at=?, next_refresh_at=?, indexed_layer_count=?, updated_at=? WHERE id=?",
                (now, now, (datetime.now(timezone.utc) + timedelta(seconds=86400)).isoformat(), len(materialized), now, source_id),
            )
            db.commit()
        return len(materialized)

    def mark_layers_stale(self, source_id: str) -> None:
        with self._lock, self.connect() as db:
            db.execute("UPDATE catalog_layers SET stale=1 WHERE source_id=?", (source_id,))
            db.commit()

    @staticmethod
    def _layer_from_row(row: sqlite3.Row) -> dict[str, Any]:
        result = _loads(row["metadata_json"], {})
        if not isinstance(result, dict):
            result = {}
        result.update({
            "id": row["id"], "source_id": row["source_id"], "title": row["title"], "name": row["name"],
            "description": row["description"], "provider": row["provider"], "protocol": row["protocol"],
            "format": row["format"], "layerName": row["layer_name"], "layerUrl": row["layer_url"],
            "serviceUrl": row["service_url"], "geometryType": row["geometry_type"],
            "fields": _loads(row["fields_json"], []), "keywords": _loads(row["keywords_json"], []),
            "themes": _loads(row["themes_json"], []), "search_aliases": _loads(row["aliases_json"], []),
            "bbox": _loads(row["bbox_json"], None), "geographic_name": row["geographic_name"],
            "coverage_status": row["coverage_status"], "validation_status": row["validation_status"],
            "stale": bool(row["stale"]), "updated_at": row["updated_at"], "last_seen_at": row["last_seen_at"],
        })
        return result

    def list_layers(self, *, limit: int = 100, source_id: str | None = None) -> list[dict[str, Any]]:
        limit = max(1, min(int(limit), 1000))
        with self.connect() as db:
            if source_id:
                rows = db.execute("SELECT * FROM catalog_layers WHERE source_id=? ORDER BY title COLLATE NOCASE LIMIT ?", (source_id, limit)).fetchall()
            else:
                rows = db.execute("SELECT * FROM catalog_layers ORDER BY title COLLATE NOCASE LIMIT ?", (limit,)).fetchall()
        return [self._layer_from_row(row) for row in rows]

    def search_rows(self, query: str, *, limit: int = 100, source_id: str | None = None) -> list[dict[str, Any]]:
        limit = max(1, min(int(limit), 1000))
        query_tokens = [token for token in str(query or "").replace('"', " ").split() if token]
        with self.connect() as db:
            rows = []
            if query_tokens:
                match = " OR ".join(f'"{token}"' for token in query_tokens)
                try:
                    sql = "SELECT l.* FROM catalog_layers_fts f JOIN catalog_layers l ON l.id=f.layer_id WHERE catalog_layers_fts MATCH ?"
                    params: list[Any] = [match]
                    if source_id:
                        sql += " AND l.source_id=?"
                        params.append(source_id)
                    sql += " LIMIT ?"
                    params.append(limit)
                    rows = db.execute(sql, params).fetchall()
                except sqlite3.OperationalError:
                    rows = []
            if not rows:
                like = f"%{str(query or '').strip()}%"
                sql = "SELECT * FROM catalog_layers WHERE (title LIKE ? OR name LIKE ? OR description LIKE ? OR provider LIKE ? OR keywords_json LIKE ? OR aliases_json LIKE ?)"
                params = [like] * 6
                if source_id:
                    sql += " AND source_id=?"
                    params.append(source_id)
                sql += " ORDER BY title COLLATE NOCASE LIMIT ?"
                params.append(limit)
                rows = db.execute(sql, params).fetchall()
        return [self._layer_from_row(row) for row in rows]

    def start_run(self, source_id: str | None) -> int:
        with self._lock, self.connect() as db:
            cursor = db.execute("INSERT INTO catalog_refresh_runs(source_id,status,started_at) VALUES (?, 'running', ?)", (source_id, utc_now()))
            db.commit()
            return int(cursor.lastrowid)

    def finish_run(self, run_id: int, *, status: str, indexed_count: int = 0, warning: str | None = None, error: str | None = None) -> None:
        with self._lock, self.connect() as db:
            db.execute("UPDATE catalog_refresh_runs SET status=?, finished_at=?, indexed_count=?, warning=?, error=? WHERE id=?", (status, utc_now(), indexed_count, warning, error, run_id))
            db.commit()

    def add_refresh_error(self, run_id: int, source_id: str | None, message: str) -> None:
        with self._lock, self.connect() as db:
            db.execute("INSERT INTO catalog_refresh_errors(run_id,source_id,message,created_at) VALUES (?,?,?,?)", (run_id, source_id, message, utc_now()))
            db.commit()

    def list_runs(self, *, limit: int = 100) -> list[dict[str, Any]]:
        with self.connect() as db:
            rows = db.execute("SELECT * FROM catalog_refresh_runs ORDER BY started_at DESC LIMIT ?", (max(1, min(int(limit), 500)),)).fetchall()
        return [dict(row) for row in rows]

    def list_errors(self, *, limit: int = 100) -> list[dict[str, Any]]:
        with self.connect() as db:
            rows = db.execute("SELECT * FROM catalog_refresh_errors ORDER BY created_at DESC LIMIT ?", (max(1, min(int(limit), 500)),)).fetchall()
        return [dict(row) for row in rows]
