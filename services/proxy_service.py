import os
import tempfile

import geopandas as gpd
import pandas as pd
import requests

from config import is_public_url


def fetch_url_bytes(target_url, timeout=30):
    if not is_public_url(target_url):
        raise ValueError('URL is not allowed for proxy access.')
    req = requests.get(target_url, stream=True, timeout=timeout, verify=False)
    req.raise_for_status()
    return req


def convert_gpkg_to_geojson(target_url):
    req = fetch_url_bytes(target_url)
    with tempfile.NamedTemporaryFile(suffix='.gpkg', delete=False) as tmp:
        for chunk in req.iter_content(chunk_size=8192):
            if chunk:
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
