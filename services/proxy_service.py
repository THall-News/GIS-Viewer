import os
import tempfile

import geopandas as gpd
import pandas as pd
import requests

from config import MAX_DOWNLOAD_BYTES, DOWNLOAD_LIMIT_MB, is_public_url


def fetch_url_bytes(target_url, timeout=30):
    if not is_public_url(target_url):
        raise ValueError('URL is not allowed for proxy access.')
    current_url = target_url
    for _ in range(3):
        req = requests.get(current_url, stream=True, timeout=timeout, verify=True, allow_redirects=False)
        if 300 <= req.status_code < 400:
            next_url = req.headers.get('Location')
            req.close()
            if not next_url or not is_public_url(next_url):
                raise ValueError('Redirect destination is not allowed.')
            current_url = next_url
            continue
        req.raise_for_status()
        length = req.headers.get('Content-Length')
        if length and int(length) > MAX_DOWNLOAD_BYTES:
            req.close()
            raise ValueError(f'Remote download exceeds the {DOWNLOAD_LIMIT_MB} MB limit.')
        return req
    raise ValueError('Too many redirects while fetching remote data.')


def convert_gpkg_to_geojson(target_url):
    req = fetch_url_bytes(target_url)
    with tempfile.NamedTemporaryFile(suffix='.gpkg', delete=False) as tmp:
        total = 0
        for chunk in req.iter_content(chunk_size=8192):
            if chunk:
                total += len(chunk)
                if total > MAX_DOWNLOAD_BYTES:
                    raise ValueError(f'Remote download exceeds the {DOWNLOAD_LIMIT_MB} MB limit.')
                tmp.write(chunk)
        tmp_path = tmp.name

    try:
        gdf = gpd.read_file(tmp_path)
        for col in gdf.columns:
            if pd.api.types.is_datetime64_any_dtype(gdf[col]):
                gdf[col] = gdf[col].astype(str)
            elif gdf[col].dtype == 'object':
                gdf[col] = gdf[col].apply(lambda x: str(x) if type(x).__name__ == 'Timestamp' else x)
        return gdf.to_json()
    finally:
        os.remove(tmp_path)


def proxy_response_payload(target_url, target_format=''):
    if 'gpkg' in target_url.lower() or target_url.endswith('.gpkg') or target_format == 'gpkg':
        return {'type': 'geojson', 'data': convert_gpkg_to_geojson(target_url)}

    req = fetch_url_bytes(target_url)
    return {'type': 'stream', 'response': req}
