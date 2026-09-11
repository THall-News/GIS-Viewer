# GIS Layer Previewer

Flask web app for discovering GIS services, previewing GeoJSON layers, and operating the workspace manually or through a safe natural-language copilot.

## Run locally

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
# Terminal 1: catalog database, refresh jobs, and administration UI
python3 catalog_app.py

# Terminal 2: map previewer and assistant
python3 app.py
```

Open `http://localhost:5000`. The catalog administration UI is at
`http://localhost:5100/admin`. The first catalog process imports existing
`gis_servers.json` source records and refreshes them in the background. The
catalog database is `catalog.sqlite3`; it is independent of the previewer's
`headless.sqlite3` session database.

## Headless copilot

The copilot is local-first by default. Known OSM concepts, relations, distances, street names, and workspace actions are parsed locally without an API request. The Agent menu also offers `Fast local only` and `Hosted help for unfamiliar requests`. Hosted assistance is used only when the local parser cannot resolve the request, and its structured result is validated and reconciled against the deterministic intent before execution.

To enable hosted assistance, set `OPENAI_API_KEY` before starting the Python server. The default model is `gpt-4.1-mini`; override it with `OPENAI_HEADLESS_MODEL`. Optional controls are `OPENAI_HEADLESS_TIMEOUT` (default 12 seconds), `OPENAI_HEADLESS_CACHE_TTL` (default 300 seconds), `OPENAI_HEADLESS_COOLDOWN` (default 60 seconds after a failure), and `OPENAI_API_BASE` for a compatible Responses endpoint. The model receives compact workspace metadata and candidate hints, not complete feature collections. Remote fetches, mutations, and exports require explicit confirmation.

The hosted planner uses the Responses API structured-output format (`text.format`) and never receives or returns executable Overpass QL. See the [official Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs).

Key endpoints include `POST /api/headless/plan`, `POST /api/headless/sessions`, `POST /api/headless/sessions/<id>/run`, `GET /api/headless/sessions/<id>`, and `POST /api/headless/actions`.

### GIS catalog search

The catalog is a separate process, not a request-time scrape. It stores
individual WFS feature types, ArcGIS layers, and CKAN resources in SQLite and
refreshes them on startup, every 24 hours, or through the administration UI.
`POST /api/catalog/search` on port 5100 accepts a body such as
`{"query":"first nations reserve boundaries","region":"Ontario"}`.
Geographic coverage is a hard eligibility filter: an Ontario request cannot be
satisfied by a Yukon-only layer, and unknown-coverage layers do not count as a
high-confidence match. The previewer's `/api/catalog/search` and
`/api/servers` routes are compatibility proxies to this service.

Optional catalog settings are `GIS_CATALOG_TIMEOUT` (default 12 seconds),
`GIS_CATALOG_MAX_ARCGIS_SERVICES` (default 80 for directory sources),
`CATALOG_DB_FILE`, `CATALOG_SERVICE_URL` (default
`http://127.0.0.1:5100`), `CATALOG_ADMIN_URL`, and
`CATALOG_REFRESH_INTERVAL_SECONDS` (default 86400). Set `CATALOG_PORT` if the
catalog process should listen on a port other than 5100, and point
`CATALOG_SERVICE_URL` at that port in the previewer process.

If the catalog process is stopped, map navigation and existing local layers
continue to work, but catalog searches and source registration show a clear
catalog-unavailable warning. The previewer does not silently rebuild the old
JSON catalog or query providers during an assistant request.

### Local EPSG:3857 imagery

Choose `Upload File` in `Data Sources Config` and select an axis-aligned PNG
together with its matching `.pgw` world file. The importer expects the PGW
coordinates to be EPSG:3857 metres, validates the Web Mercator extent, converts
the resulting bounds to WGS84 for Leaflet, and keeps the image temporary in the
current browser session. Rotated PGW files are rejected because Leaflet's
`ImageOverlay` cannot represent image rotation.

## Safety and deployment

Outbound URLs are restricted to public HTTP(S) destinations, TLS verification is enabled, redirects are disabled for proxy downloads, and remote calls have bounded timeouts. Add authentication and rate limiting before exposing mutation endpoints beyond a trusted local environment.

The proxy download limit defaults to 50 MB and can be changed at startup:

```bash
GIS_MAX_DOWNLOAD_MB=200 python3 app.py
```

Values below 1 MB or invalid values fall back to the 50 MB default.

## Tests

```bash
python3 tests/headless_smoke.py
python3 -m unittest discover -s tests -p 'test*.py'
node --check static/app.js
```
