import test from 'node:test';
import assert from 'node:assert/strict';

import {
    parsePgwText,
    pgwToEpsg3857Bounds,
    geoTiffBoundsToWgs84,
    WEB_MERCATOR_RADIUS,
} from '../static/geoReferencedRaster.js';

test('parses PGW values in world-file order', () => {
    assert.deepEqual(parsePgwText('10\n0\n0\n-10\n100\n200\n'), {
        pixelSizeX: 10,
        rotationY: 0,
        rotationX: 0,
        pixelSizeY: -10,
        originX: 100,
        originY: 200,
    });
});

test('converts axis-aligned EPSG:3857 pixel edges to WGS84 bounds', () => {
    const bounds = pgwToEpsg3857Bounds(parsePgwText('10\n0\n0\n-10\n100\n200'), 2, 2);
    const expectedWest = 95 / WEB_MERCATOR_RADIUS * 180 / Math.PI;
    const expectedEast = 115 / WEB_MERCATOR_RADIUS * 180 / Math.PI;
    assert.ok(Math.abs(bounds[0][1] - expectedWest) < 1e-12);
    assert.ok(Math.abs(bounds[1][1] - expectedEast) < 1e-12);
    assert.ok(bounds[0][0] < bounds[1][0]);
});

test('rejects rotated or out-of-range PGW files', () => {
    assert.throws(
        () => pgwToEpsg3857Bounds(parsePgwText('10\n1\n0\n-10\n100\n200'), 2, 2),
        /Rotated PGW/,
    );
    assert.throws(
        () => pgwToEpsg3857Bounds(parsePgwText('10\n0\n0\n-10\n30000000\n200'), 2, 2),
        /outside the valid EPSG:3857/,
    );
});

test('converts a WGS84 GeoTIFF extent without projection dependencies', () => {
    assert.deepEqual(
        geoTiffBoundsToWgs84([10, 20, 12, 22], { GeographicTypeGeoKey: 4326 }),
        [[20, 10], [22, 12]],
    );
});

test('converts a Web Mercator GeoTIFF extent without projection dependencies', () => {
    const bounds = geoTiffBoundsToWgs84(
        [0, 0, 1000, 1000],
        { ProjectedCSTypeGeoKey: 3857 },
    );
    assert.ok(Math.abs(bounds[0][1]) < 1e-12);
    assert.ok(Math.abs(bounds[1][1] - (1000 / WEB_MERCATOR_RADIUS * 180 / Math.PI)) < 1e-12);
    assert.ok(bounds[0][0] < bounds[1][0]);
});

test('uses injected projection dependencies for projected GeoTIFF extents', () => {
    const bounds = geoTiffBoundsToWgs84(
        [100, 200, 300, 400],
        { ProjectedCSTypeGeoKey: 26917 },
        {
            geokeysToProj4: {
                toProj4: () => ({
                    proj4: 'source',
                    shouldConvertCoordinates: true,
                    coordinatesConversionParameters: { x: 2, y: 0.2, z: 1 },
                    errors: {},
                }),
                convertCoordinates: (x, y, z, parameters) => ({
                    x: x * parameters.x,
                    y: y * parameters.y,
                    z,
                }),
            },
            proj4: (_source, _target) => ({
                forward: ([x, y]) => [x / 10, y / 10],
            }),
        },
    );
    assert.deepEqual(bounds, [[4, 20], [8, 60]]);
});
