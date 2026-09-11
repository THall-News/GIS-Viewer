"""Standalone catalog management service.

Run this process separately from the map previewer:

    python3 catalog_app.py

The previewer consumes it through CATALOG_SERVICE_URL.
"""
from __future__ import annotations

import json
import os
import threading
import time

from flask import Flask

from config import CATALOG_DB_FILE, CATALOG_REFRESH_INTERVAL_SECONDS, SERVERS_FILE, ensure_storage_files
from routes.catalog import catalog_bp
from services.catalog_repository import CatalogRepository
from services.catalog_service import CatalogManager


def _legacy_sources() -> list[dict]:
    try:
        value = json.loads(SERVERS_FILE.read_text(encoding="utf-8")) if SERVERS_FILE.exists() else []
        return value if isinstance(value, list) else []
    except (OSError, ValueError, TypeError):
        return []


def create_catalog_app() -> Flask:
    app = Flask(__name__)
    ensure_storage_files()
    repository = CatalogRepository(CATALOG_DB_FILE)
    manager = CatalogManager(repository, legacy_sources=_legacy_sources())
    app.extensions["catalog_repository"] = repository
    app.extensions["catalog_manager"] = manager
    app.register_blueprint(catalog_bp)
    return app


def _scheduler(manager: CatalogManager) -> None:
    # Indexing starts in the background so the catalog becomes useful after a
    # fresh migration without delaying service startup. Map requests never
    # wait for this crawl.
    try:
        manager.refresh_all()
    except Exception as exc:
        print(f"[Catalog scheduler] initial refresh failed: {exc}")
    next_full_refresh = time.time() + CATALOG_REFRESH_INTERVAL_SECONDS
    while True:
        time.sleep(min(60, CATALOG_REFRESH_INTERVAL_SECONDS))
        try:
            for source in manager.repository.list_due_sources():
                manager.refresh_source(source["id"])
            if time.time() >= next_full_refresh:
                manager.refresh_all()
                next_full_refresh = time.time() + CATALOG_REFRESH_INTERVAL_SECONDS
        except Exception as exc:
            print(f"[Catalog scheduler] refresh failed: {exc}")


app = create_catalog_app()


if __name__ == "__main__":
    manager = app.extensions["catalog_manager"]
    threading.Thread(target=_scheduler, args=(manager,), daemon=True, name="catalog-scheduler").start()
    app.run(debug=False, port=int(os.environ.get("CATALOG_PORT", "5100")))
