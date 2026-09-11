from __future__ import annotations

import threading
import uuid

from flask import Blueprint, current_app, jsonify, render_template, request

from services.catalog_service import CatalogManager


catalog_bp = Blueprint("catalog_bp", __name__)


def _manager() -> CatalogManager:
    manager = current_app.extensions.get("catalog_manager")
    if not manager:
        raise RuntimeError("catalog manager is not configured")
    return manager


def _start_refresh(source_id: str | None = None):
    manager = _manager()
    target = (lambda: manager.refresh_source(source_id)) if source_id else manager.refresh_all
    thread = threading.Thread(target=target, daemon=True, name="catalog-refresh")
    thread.start()


@catalog_bp.route("/", methods=["GET"])
@catalog_bp.route("/admin", methods=["GET"])
def admin():
    return render_template("catalog_admin.html")


@catalog_bp.route("/api/catalog/health", methods=["GET"])
def health():
    manager = _manager()
    return jsonify({"ok": True, "source_count": len(manager.sources())})


@catalog_bp.route("/api/catalog/sources", methods=["GET", "POST"])
def sources():
    manager = _manager()
    if request.method == "GET":
        source_list = manager.sources()
        return jsonify({"sources": source_list, "count": len(source_list)})
    data = request.json or {}
    url = str(data.get("url") or "").strip()
    if not url or not url.startswith(("http://", "https://")):
        return jsonify({"error": "A public HTTP(S) source URL is required"}), 400
    source = dict(data)
    source.setdefault("id", f"srv_{uuid.uuid4().hex[:10]}")
    source.setdefault("display_name", source.get("name") or "Configured GIS source")
    source.setdefault("type", source.get("protocol") or "ESRI")
    saved = manager.add_source(source)
    if data.get("autoRefresh", True):
        _start_refresh(saved["id"])
    return jsonify({"source": saved, "message": "Source registered. Refresh it to index its layers."}), 201


@catalog_bp.route("/api/catalog/sources/<source_id>", methods=["PUT", "DELETE"])
def source_detail(source_id: str):
    manager = _manager()
    if request.method == "DELETE":
        if not manager.remove_source(source_id):
            return jsonify({"error": "source not found"}), 404
        return jsonify({"deleted": True, "id": source_id})
    existing = next((item for item in manager.sources() if item["id"] == source_id), None)
    if not existing:
        return jsonify({"error": "source not found"}), 404
    updated = dict(existing)
    updated.update(request.json or {})
    updated["id"] = source_id
    return jsonify({"source": manager.add_source(updated)})


@catalog_bp.route("/api/catalog/sources/<source_id>/refresh", methods=["POST"])
def refresh_source(source_id: str):
    manager = _manager()
    if not manager.repository.get_source(source_id):
        return jsonify({"error": "source not found"}), 404
    if bool((request.json or {}).get("wait")):
        return jsonify(manager.refresh_source(source_id))
    _start_refresh(source_id)
    return jsonify({"started": True, "source_id": source_id}), 202


@catalog_bp.route("/api/catalog/refresh", methods=["POST"])
def refresh_all():
    if bool((request.json or {}).get("wait")):
        return jsonify(_manager().refresh_all())
    _start_refresh()
    return jsonify({"started": True}), 202


@catalog_bp.route("/api/catalog/refresh-runs", methods=["GET"])
def refresh_runs():
    manager = _manager()
    return jsonify({"runs": manager.repository.list_runs(), "errors": manager.repository.list_errors()})


@catalog_bp.route("/api/catalog/layers", methods=["GET"])
def layers():
    manager = _manager()
    query = str(request.args.get("q") or "").strip()
    if query:
        return jsonify(manager.search(query, region=request.args.get("region"), limit=request.args.get("limit", 100)))
    values = manager.repository.list_layers(limit=request.args.get("limit", 100), source_id=request.args.get("source_id"))
    return jsonify({"layers": values, "count": len(values)})


@catalog_bp.route("/api/catalog/search", methods=["POST"])
def search():
    data = request.json or {}
    query = str(data.get("query") or "").strip()
    if not query:
        return jsonify({"error": "query is required"}), 400
    return jsonify(_manager().search(
        query,
        region=data.get("region"),
        bbox=data.get("bbox") or data.get("mapBounds"),
        limit=data.get("limit", 10),
        protocol=data.get("protocol"),
        provider=data.get("provider"),
        theme=data.get("theme"),
    ))
