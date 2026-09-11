import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const moduleSource = readFileSync(join(testDirectory, '..', 'static', 'roadSelection.js'), 'utf8');
const roadSelection = await import(`data:text/javascript,${encodeURIComponent(moduleSource)}`);

const road = (id, name, coordinates, properties = {}) => ({
    type: 'Feature',
    id,
    properties: {
        source_id: 'openmaptiles',
        source_layer: 'transportation',
        road_name: name,
        ...properties
    },
    geometry: { type: 'LineString', coordinates }
});

test('disconnected roads with the same tile id remain separate features', () => {
    const result = roadSelection.combineRoadFeatureFragments([
        road(42, 'HWY 3', [[-79.8, 43.4], [-79.79, 43.4]]),
        road(42, 'HWY 55', [[-79.8, 43.5], [-79.79, 43.5]])
    ]);

    assert.equal(result.length, 2);
    assert.deepEqual(result.map(feature => feature.properties.road_name), ['HWY 3', 'HWY 55']);
});

test('connected tile fragments with the same id are stitched into one line', () => {
    const result = roadSelection.combineRoadFeatureFragments([
        road(7, 'Main Street', [[-79.8, 43.4], [-79.79, 43.4]]),
        road(7, 'Main Street', [[-79.789995, 43.4], [-79.78, 43.4]])
    ]);

    assert.equal(result.length, 1);
    assert.equal(result[0].geometry.type, 'LineString');
    assert.equal(result[0].properties.selected_fragment_count, 2);
    assert.equal(result[0].properties.road_name, 'Main Street');
});

test('same-name roads with different ids are never grouped', () => {
    const result = roadSelection.combineRoadFeatureFragments([
        road(11, 'King Street', [[-79.8, 43.4], [-79.79, 43.4]]),
        road(12, 'King Street', [[-79.8, 43.5], [-79.79, 43.5]])
    ]);

    assert.equal(result.length, 2);
    assert.deepEqual(result.map(feature => feature.properties.road_feature_id), ['11', '12']);
});

test('missing ids keep disconnected rendered fragments separate', () => {
    const result = roadSelection.combineRoadFeatureFragments([
        road(undefined, '', [[-79.8, 43.4], [-79.79, 43.4]]),
        road(undefined, '', [[-79.8, 43.5], [-79.79, 43.5]])
    ]);

    assert.equal(result.length, 2);
    assert.equal(result.every(feature => feature.properties.road_identity_source === 'none'), true);
});

test('disconnected parts of one selected MultiLineString remain separate', () => {
    const result = roadSelection.combineRoadFeatureFragments([{
        ...road(19, 'Split Road', [[-79.8, 43.4], [-79.79, 43.4]]),
        geometry: {
            type: 'MultiLineString',
            coordinates: [
                [[-79.8, 43.4], [-79.79, 43.4]],
                [[-79.8, 43.5], [-79.79, 43.5]]
            ]
        }
    }]);

    assert.equal(result.length, 2);
    assert.deepEqual(result.map(feature => feature.properties.road_name), ['Split Road', 'Split Road']);
});

test('rendered selection narrows a multipart line to the highlighted part', () => {
    const feature = {
        type: 'Feature',
        id: 23,
        properties: { source_layer: 'transportation' },
        geometry: {
            type: 'MultiLineString',
            coordinates: [
                [[0, 0], [1, 0]],
                [[10, 10], [11, 10]]
            ]
        }
    };
    const selected = roadSelection.featureForRenderedSelection({
        feature,
        lineCoordinates: [[10, 10], [11, 10]]
    });

    assert.equal(selected.geometry.type, 'LineString');
    assert.deepEqual(selected.geometry.coordinates, [[10, 10], [11, 10]]);
    assert.equal(feature.geometry.type, 'MultiLineString');
});

test('rendered selection preserves polygon geometry', () => {
    const feature = {
        type: 'Feature',
        id: 24,
        properties: { source_layer: 'water' },
        geometry: {
            type: 'Polygon',
            coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]]
        }
    };
    const selected = roadSelection.featureForRenderedSelection({
        feature,
        lineCoordinates: [[0, 0], [1, 0], [1, 1], [0, 0]]
    });

    assert.equal(selected.geometry.type, 'Polygon');
});

test('rendered selection narrows a MultiPolygon to the hovered polygon component', () => {
    const feature = {
        type: 'Feature',
        id: 25,
        properties: { source_layer: 'landcover' },
        geometry: {
            type: 'MultiPolygon',
            coordinates: [
                [[[0, 0], [1, 0], [1, 1], [0, 0]]],
                [[[10, 10], [11, 10], [11, 11], [10, 10]]]
            ]
        }
    };
    const selected = roadSelection.featureForRenderedSelection({
        feature,
        polygonIndex: 1,
        ringIndex: 0,
        lineCoordinates: [[10, 10], [11, 10], [11, 11], [10, 10]]
    });

    assert.equal(selected.geometry.type, 'Polygon');
    assert.deepEqual(selected.geometry.coordinates, feature.geometry.coordinates[1]);
    assert.equal(feature.geometry.type, 'MultiPolygon');
});

test('stable identifier values include explicit OSM identifiers before tile ids', () => {
    const values = [...roadSelection.stableIdentifierValues({
        id: 999,
        properties: { osm_id: 123 }
    })];

    assert.deepEqual(values, ['123', '999']);
});
