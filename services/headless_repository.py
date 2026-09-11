"""SQLite persistence for headless sessions and audit events."""
from __future__ import annotations

import json
import sqlite3
import threading
from pathlib import Path
from typing import Any


class HeadlessRepository:
    def __init__(self, path: str | Path):
        self.path = str(path)
        self._lock = threading.Lock()
        self._initialize()

    def _connect(self):
        conn = sqlite3.connect(self.path, timeout=10)
        conn.row_factory = sqlite3.Row
        return conn

    def _initialize(self):
        with self._connect() as conn:
            conn.executescript("""
            CREATE TABLE IF NOT EXISTS headless_sessions (
                id TEXT PRIMARY KEY, prompt TEXT NOT NULL, workspace TEXT NOT NULL,
                status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                actions TEXT NOT NULL, result TEXT NOT NULL, error TEXT,
                plan_hash TEXT, approval_token TEXT, approved INTEGER NOT NULL DEFAULT 0,
                assistant_state TEXT NOT NULL DEFAULT '{}'
            );
            CREATE TABLE IF NOT EXISTS headless_audit (
                id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
                event TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_headless_audit_session ON headless_audit(session_id);
            CREATE TABLE IF NOT EXISTS headless_request_audit (
                id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL,
                payload TEXT NOT NULL, created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_headless_request_audit_created ON headless_request_audit(created_at);
            """)
            columns = {row["name"] for row in conn.execute("PRAGMA table_info(headless_sessions)")}
            if "assistant_state" not in columns:
                conn.execute("ALTER TABLE headless_sessions ADD COLUMN assistant_state TEXT NOT NULL DEFAULT '{}'")

    def save(self, session, *, plan_hash: str = "", approval_token: str = "", approved: bool = False):
        with self._lock, self._connect() as conn:
            conn.execute("""INSERT INTO headless_sessions
                (id,prompt,workspace,status,created_at,updated_at,actions,result,error,plan_hash,approval_token,approved,assistant_state)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,
                actions=excluded.actions,result=excluded.result,error=excluded.error,
                plan_hash=excluded.plan_hash,approval_token=excluded.approval_token,approved=excluded.approved,
                assistant_state=excluded.assistant_state""",
                (session.id, session.prompt, json.dumps(session.workspace), session.status,
                 session.created_at, session.updated_at, json.dumps([a.to_dict() for a in session.actions]),
                 json.dumps(session.result), session.error, plan_hash, approval_token, int(approved),
                 json.dumps(getattr(session, "assistant_state", {}) or {})))

    def audit(self, session_id: str, event: str, payload: dict[str, Any], created_at: str):
        with self._lock, self._connect() as conn:
            conn.execute("INSERT INTO headless_audit(session_id,event,payload,created_at) VALUES (?,?,?,?)",
                         (session_id, event, json.dumps(payload), created_at))

    def list_audit(self, session_id: str):
        with self._connect() as conn:
            return [dict(row) | {"payload": json.loads(row["payload"])} for row in conn.execute(
                "SELECT * FROM headless_audit WHERE session_id=? ORDER BY id", (session_id,))]

    def audit_request(self, event: str, payload: dict[str, Any], created_at: str):
        with self._lock, self._connect() as conn:
            conn.execute("INSERT INTO headless_request_audit(event,payload,created_at) VALUES (?,?,?)",
                         (event, json.dumps(payload), created_at))

    def list_request_audit(self, limit: int = 100):
        limit = max(1, min(int(limit), 1000))
        with self._connect() as conn:
            return [dict(row) | {"payload": json.loads(row["payload"])} for row in conn.execute(
                "SELECT * FROM headless_request_audit ORDER BY id DESC LIMIT ?", (limit,))]

    def load_all(self):
        with self._connect() as conn:
            return [dict(row) for row in conn.execute("SELECT * FROM headless_sessions ORDER BY created_at")]
