import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const moduleSource = readFileSync(join(testDirectory, '..', 'static', 'featureSelection.js'), 'utf8');
const featureSelection = await import(`data:text/javascript,${encodeURIComponent(moduleSource)}`);

const polygon = (id, coordinates, properties = {}) => ({
    type: 'Feature',
    id,
    properties: {
        source_id: 'openmaptiles',
        source_layer: 'landcover',
        selection_category: 'parks',
        class: 'wood',
        ...properties
    },
    geometry: { type: 'Polygon', coordinates: [coordinates] }
});

test('connected fragments with different tile IDs group across a tile boundary', () => {
    const groups = featureSelection.groupFeatureFragments([
        polygon(101, [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]),
        polygon(202, [[1, 0], [2, 0], [2, 1], [1, 1], [1, 0]])
    ]);

    assert.equal(groups.length, 1);
    assert.equal(groups[0].length, 2);
});

test('disconnected features with different IDs remain separate', () => {
    const groups = featureSelection.groupFeatureFragments([
        polygon(101, [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]),
        polygon(202, [[10, 10], [11, 10], [11, 11], [10, 11], [10, 10]])
    ]);

    assert.equal(groups.length, 2);
});

test('different explicit source IDs remain separate even when polygons touch', () => {
    const groups = featureSelection.groupFeatureFragments([
        polygon(101, [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]], { osm_id: 10 }),
        polygon(202, [[1, 0], [2, 0], [2, 1], [1, 1], [1, 0]], { osm_id: 11 })
    ]);

    assert.equal(groups.length, 2);
});

test('the same explicit source ID groups disconnected fragments', () => {
    const groups = featureSelection.groupFeatureFragments([
        polygon(101, [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]], { osm_id: 10 }),
        polygon(202, [[10, 10], [11, 10], [11, 11], [10, 11], [10, 10]], { osm_id: 10 })
    ]);

    assert.equal(groups.length, 1);
    assert.equal(groups[0].length, 2);
});
