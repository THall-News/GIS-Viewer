import assert from 'node:assert/strict';
import test from 'node:test';
import { simplifyFeature, countGeometryVertices, featureGeoJsonByteSize } from '../static/geometrySimplify.js';

const feature = (geometry, properties = { name: 'test' }) => ({
    type: 'Feature',
    properties,
    geometry
});

test('LineString simplification retains both endpoints', () => {
    const source = feature({
        type: 'LineString',
        coordinates: Array.from({ length: 10 }, (_, index) => [index, Math.sin(index)])
    });
    const result = simplifyFeature(source, { mode: 'points', target: 5, seed: 4 });

    assert.equal(result.finalPoints, 5);
    assert.deepEqual(result.geometry.coordinates[0], source.geometry.coordinates[0]);
    assert.deepEqual(result.geometry.coordinates.at(-1), source.geometry.coordinates.at(-1));
    assert.deepEqual(source.geometry.coordinates.length, 10);
    assert.deepEqual(result.feature.properties, source.properties);
});

test('Polygon simplification preserves closed outer rings and holes', () => {
    const source = feature({
        type: 'Polygon',
        coordinates: [
            [[0, 0], [4, 0], [5, 2], [4, 4], [2, 5], [0, 4], [-1, 2], [0, 0]],
            [[1, 1], [2, 1], [3, 2], [2, 3], [1, 1]]
        ]
    });
    const result = simplifyFeature(source, { mode: 'points', target: 8, seed: 9 });

    assert.equal(result.geometry.coordinates.length, 2);
    for (const ring of result.geometry.coordinates) {
        assert.deepEqual(ring[0], ring.at(-1));
        assert.ok(ring.length >= 4);
    }
    assert.equal(result.finalPoints, countGeometryVertices(result.geometry));
});

test('MultiPolygon simplification preserves every island', () => {
    const source = feature({
        type: 'MultiPolygon',
        coordinates: [
            [[[0, 0], [3, 0], [3, 3], [2, 4], [0, 3], [0, 0]]],
            [[[10, 10], [13, 10], [14, 12], [13, 14], [10, 13], [10, 10]]]
        ]
    });
    const result = simplifyFeature(source, { mode: 'percentage', target: 60, seed: 2 });

    assert.equal(result.geometry.coordinates.length, 2);
    assert.ok(result.geometry.coordinates.every(polygon => polygon[0].length >= 4));
    assert.ok(result.geometry.coordinates.every(polygon => polygon[0][0].toString() === polygon[0].at(-1).toString()));
});

test('percentage mode retains the requested point count where feasible', () => {
    const source = feature({
        type: 'LineString',
        coordinates: Array.from({ length: 20 }, (_, index) => [index, index % 3])
    });
    const result = simplifyFeature(source, { mode: 'percentage', target: 50, seed: 3 });

    assert.equal(result.finalPoints, 10);
    assert.equal(result.warning, '');
});

test('size mode reaches a minified FeatureCollection byte target when feasible', () => {
    const source = feature({
        type: 'LineString',
        coordinates: Array.from({ length: 30 }, (_, index) => [index, Math.cos(index)])
    }, { name: 'a', description: 'size test' });
    const originalBytes = featureGeoJsonByteSize(source);
    const result = simplifyFeature(source, { mode: 'size', target: originalBytes - 100, unitMultiplier: 1, seed: 8 });

    assert.ok(result.finalBytes <= originalBytes);
    assert.ok(result.finalBytes <= originalBytes - 100 || result.warning);
    assert.equal(result.originalBytes, originalBytes);
});

test('same seed is deterministic and impossible targets report a warning', () => {
    const source = feature({
        type: 'Polygon',
        coordinates: [[[0, 0], [4, 0], [5, 2], [4, 4], [2, 5], [0, 4], [-1, 2], [0, 0]]]
    });
    const first = simplifyFeature(source, { mode: 'points', target: 1, seed: 22 });
    const second = simplifyFeature(source, { mode: 'points', target: 1, seed: 22 });

    assert.deepEqual(first.geometry, second.geometry);
    assert.equal(first.finalPoints, 3);
    assert.match(first.warning, /minimum|Could not reach/i);
    assert.equal(countGeometryVertices(source.geometry), 7);
});

test('changing the seed can choose a different equivalent retained vertex', () => {
    const source = feature({
        type: 'LineString',
        coordinates: [[0, 0], [1, 1], [2, 0], [3, 1], [4, 0], [5, 1], [6, 0], [7, 1], [8, 0]]
    });
    const first = simplifyFeature(source, { mode: 'points', target: 5, seed: 1 });
    const second = simplifyFeature(source, { mode: 'points', target: 5, seed: 2 });

    assert.notDeepEqual(first.geometry, second.geometry);
    assert.equal(first.finalPoints, second.finalPoints);
});
