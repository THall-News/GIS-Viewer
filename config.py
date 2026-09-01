import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
SERVERS_FILE = BASE_DIR / 'gis_servers.json'
DEFAULT_SERVERS_FILE = BASE_DIR / 'default_servers.json'

GLOBAL_OVERPASS_ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://lz4.overpass-api.de/api/interpreter',
    'https://z.overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    'https://overpass.osm.ch/api/interpreter',
]

REQUEST_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
}

ALLOWED_PUBLIC_HOST_SUFFIXES = (
    'arcgis.com',
    'arcgisserver.com',
    'opendata.swiss',
    'opendata.arcgis.com',
    'open.canada.ca',
    'geo.ca',
    'githubusercontent.com',
    'openstreetmap.org',
    'overpass-api.de',
    'osm.ch',
    'gov',
    'ca',
)


def ensure_storage_files():
    if not SERVERS_FILE.exists():
        seed_data = []
        if DEFAULT_SERVERS_FILE.exists():
            try:
                with open(DEFAULT_SERVERS_FILE, 'r', encoding='utf-8') as f:
                    seed_data = __import__('json').load(f)
            except Exception:
                seed_data = []
        with open(SERVERS_FILE, 'w', encoding='utf-8') as f:
            __import__('json').dump(seed_data, f, indent=2)


def is_public_url(url):
    try:
        from urllib.parse import urlparse
        parsed = urlparse(url)
        if parsed.scheme not in {'http', 'https'}:
            return False
        hostname = (parsed.hostname or '').lower()
        if not hostname:
            return False
        if hostname in {'localhost', '127.0.0.1', '0.0.0.0'}:
            return False
        if hostname.startswith('localhost.'):
            return False
        if hostname.startswith('10.') or hostname.startswith('192.168.') or hostname.startswith('172.'):
            return False
        if hostname.startswith('::'):
            return False
        if hostname.endswith('.local'):
            return False
        if any(hostname.startswith(prefix) for prefix in ('127.', '10.', '192.168.', '172.16.', '172.17.', '172.18.', '172.19.', '172.20.', '172.21.', '172.22.', '172.23.', '172.24.', '172.25.', '172.26.', '172.27.', '172.28.', '172.29.', '172.30.', '172.31.', '169.254.')):
            return False
        return True
    except Exception:
        return False
