// Utilities for importing axis-aligned local raster imagery.

export const WEB_MERCATOR_RADIUS = 6378137;
export const WEB_MERCATOR_LIMIT = WEB_MERCATOR_RADIUS * Math.PI;

export const parsePgwText = text => {
    const values = String(text ?? '')
        .replace(/^\uFEFF/, '')
        .trim()
        .split(/\s+/)
        .slice(0, 6)
        .map(Number);

    if (values.length !== 6 || values.some(value => !Number.isFinite(value))) {
        throw new Error('The PGW must contain six numeric world-file values.');
    }

    const [pixelSizeX, rotationY, rotationX, pixelSizeY, originX, originY] = values;
    if (Math.abs(pixelSizeX) < Number.EPSILON || Math.abs(pixelSizeY) < Number.EPSILON) {
        throw new Error('The PGW has an invalid zero pixel size.');
    }

    return { pixelSizeX, rotationY, rotationX, pixelSizeY, originX, originY };
};

const mercatorToLongitude = x => (x / WEB_MERCATOR_RADIUS) * (180 / Math.PI);

const mercatorToLatitude = y => {
    const boundedY = Math.max(-WEB_MERCATOR_LIMIT, Math.min(WEB_MERCATOR_LIMIT, y));
    return (Math.atan(Math.sinh(boundedY / WEB_MERCATOR_RADIUS)) * 180) / Math.PI;
};

/**
 * Convert the outer pixel bounds described by a PGW to Leaflet bounds.
 *
 * PGW originX/originY describe the centre of the upper-left pixel. The
 * half-pixel adjustment below converts those centre coordinates to the
 * outside edges of the image. ImageOverlay cannot represent rotation, so a
 * rotated world file is rejected instead of silently misplacing the image.
 */
export const pgwToEpsg3857Bounds = (pgw, width, height) => {
    if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
        throw new Error('The PNG has invalid image dimensions.');
    }

    const { pixelSizeX, rotationY, rotationX, pixelSizeY, originX, originY } = pgw;
    if (Math.abs(rotationX) > 1e-9 || Math.abs(rotationY) > 1e-9) {
        throw new Error('Rotated PGW images are not supported; export an axis-aligned EPSG:3857 image.');
    }

    const xA = originX - (pixelSizeX / 2);
    const xB = originX + (pixelSizeX * (width - 0.5));
    const yA = originY - (pixelSizeY / 2);
    const yB = originY + (pixelSizeY * (height - 0.5));
    const westMercator = Math.min(xA, xB);
    const eastMercator = Math.max(xA, xB);
    const southMercator = Math.min(yA, yB);
    const northMercator = Math.max(yA, yB);

    if (![westMercator, eastMercator, southMercator, northMercator].every(Number.isFinite)) {
        throw new Error('The PGW produced non-finite image bounds.');
    }
    if (westMercator < -WEB_MERCATOR_LIMIT || eastMercator > WEB_MERCATOR_LIMIT
        || southMercator < -WEB_MERCATOR_LIMIT || northMercator > WEB_MERCATOR_LIMIT) {
        throw new Error('The PGW coordinates are outside the valid EPSG:3857 world extent.');
    }

    const west = mercatorToLongitude(westMercator);
    const east = mercatorToLongitude(eastMercator);
    const south = mercatorToLatitude(southMercator);
    const north = mercatorToLatitude(northMercator);
    if (!(west < east) || !(south < north)) {
        throw new Error('The PGW produced an empty image extent.');
    }

    return [[south, west], [north, east]];
};

const boundsFromPoints = points => {
    const longitudes = points.map(point => point[0]);
    const latitudes = points.map(point => point[1]);
    const west = Math.min(...longitudes);
    const east = Math.max(...longitudes);
    const south = Math.min(...latitudes);
    const north = Math.max(...latitudes);

    if (![west, east, south, north].every(Number.isFinite)
        || west < -180 || east > 180 || south < -90 || north > 90
        || !(west < east) || !(south < north)) {
        throw new Error('The GeoTIFF produced an invalid WGS84 image extent.');
    }

    return [[south, west], [north, east]];
};

const projectPointWithProj4 = (projection, point) => {
    if (typeof projection === 'function') return projection(point);
    if (projection && typeof projection.forward === 'function') return projection.forward(point);
    throw new Error('The GeoTIFF projection could not be initialized.');
};

/**
 * Convert a GeoTIFF bounding box from the CRS stored in its GeoKeys to the
 * WGS84 latitude/longitude bounds required by Leaflet. GeoTIFF decoding and
 * projection are intentionally injected so this module remains easy to test
 * without loading browser-only third-party libraries.
 */
export const geoTiffBoundsToWgs84 = (
    bbox,
    geoKeys,
    {
        geokeysToProj4 = globalThis.geokeysToProj4?.default || globalThis.geokeysToProj4,
        proj4 = globalThis.proj4?.default || globalThis.proj4,
    } = {},
) => {
    if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(Number.isFinite)) {
        throw new Error('The GeoTIFF does not contain a valid image extent.');
    }

    const [minX, minY, maxX, maxY] = bbox;
    if (!(minX < maxX) || !(minY < maxY)) {
        throw new Error('The GeoTIFF produced an empty image extent.');
    }

    const corners = [
        [minX, minY],
        [minX, maxY],
        [maxX, minY],
        [maxX, maxY],
    ];
    const geographicCode = Number(geoKeys?.GeographicTypeGeoKey);
    const projectedCode = Number(geoKeys?.ProjectedCSTypeGeoKey);
    const hasProjectedCode = Number.isFinite(projectedCode) && projectedCode > 0;

    // WGS84 needs no third-party projection library. This fallback also keeps
    // a basic geographic GeoTIFF useful if the optional CRS scripts fail to
    // load while offline.
    if (geographicCode === 4326 && !hasProjectedCode) {
        return boundsFromPoints(corners);
    }

    // EPSG:3857 is the CRS used by the existing PNG/PGW importer and can be
    // handled locally for the same offline fallback reason.
    if (projectedCode === 3857) {
        return boundsFromPoints(corners.map(([x, y]) => [
            mercatorToLongitude(x),
            mercatorToLatitude(y),
        ]));
    }

    if (!geoKeys || !geokeysToProj4 || typeof geokeysToProj4.toProj4 !== 'function'
        || typeof proj4 !== 'function') {
        throw new Error('The GeoTIFF CRS is not available. Reload the page and try again.');
    }

    const projectionInfo = geokeysToProj4.toProj4(geoKeys);
    const conversionErrors = projectionInfo?.errors || {};
    if (Object.keys(conversionErrors).length > 0 || !projectionInfo?.proj4) {
        const unsupportedCode = projectedCode || geographicCode || 'unknown';
        throw new Error(`The GeoTIFF CRS (EPSG:${unsupportedCode}) is not supported.`);
    }

    const projection = proj4(projectionInfo.proj4, 'EPSG:4326');
    const projectedCorners = corners.map(([x, y]) => {
        const converted = projectionInfo.shouldConvertCoordinates
            ? geokeysToProj4.convertCoordinates(
                x,
                y,
                0,
                projectionInfo.coordinatesConversionParameters,
            )
            : { x, y };
        const result = projectPointWithProj4(projection, [converted.x, converted.y]);
        return Array.isArray(result) ? result : [result.x, result.y];
    });

    return boundsFromPoints(projectedCorners);
};
