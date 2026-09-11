// Utilities for importing axis-aligned PNG + PGW imagery whose coordinates
// are expressed in Web Mercator (EPSG:3857).

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

