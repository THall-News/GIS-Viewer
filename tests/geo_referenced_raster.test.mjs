import test from 'node:test';
import assert from 'node:assert/strict';

import {
    parsePgwText,
    pgwToEpsg3857Bounds,
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

