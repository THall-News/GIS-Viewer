import os
import ipaddress
import socket
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
SERVERS_FILE = BASE_DIR / 'gis_servers.json'
HEADLESS_DB_FILE = BASE_DIR / 'headless.sqlite3'
DEFAULT_SERVERS_FILE = BASE_DIR / 'default_servers.json'
CATALOG_DB_FILE = Path(os.environ.get('CATALOG_DB_FILE', str(BASE_DIR / 'catalog.sqlite3')))
CATALOG_SERVICE_URL = os.environ.get('CATALOG_SERVICE_URL', 'http://127.0.0.1:5100').rstrip('/')
CATALOG_ADMIN_URL = os.environ.get('CATALOG_ADMIN_URL', CATALOG_SERVICE_URL).rstrip('/')
try:
    CATALOG_REFRESH_INTERVAL_SECONDS = max(300, int(os.environ.get('CATALOG_REFRESH_INTERVAL_SECONDS', '86400')))
except ValueError:
    CATALOG_REFRESH_INTERVAL_SECONDS = 86400

try:
    DOWNLOAD_LIMIT_MB = max(1, int(os.environ.get('GIS_MAX_DOWNLOAD_MB', '50')))
except ValueError:
    DOWNLOAD_LIMIT_MB = 50
MAX_DOWNLOAD_BYTES = DOWNLOAD_LIMIT_MB * 1024 * 1024

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
        addresses = socket.getaddrinfo(hostname, parsed.port or (443 if parsed.scheme == 'https' else 80), type=socket.SOCK_STREAM)
        for _, _, _, _, sockaddr in addresses:
            address = ipaddress.ip_address(sockaddr[0])
            if address.is_private or address.is_loopback or address.is_link_local or address.is_reserved or address.is_multicast:
                return False
        return True
    except Exception:
        return False
