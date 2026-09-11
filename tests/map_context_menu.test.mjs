import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDirectory = fileURLToPath(new URL('.', import.meta.url));
const source = readFileSync(join(testDirectory, '..', 'static', 'mapContextMenu.js'), 'utf8');
const module = await import(`data:text/javascript,${encodeURIComponent(source)}`);

assert.equal(module.formatContextCoordinate(43.4405031), '43.440503');
assert.equal(module.formatContextCoordinates({ lat: 43.4405031, lng: -79.7931299 }), 'Lat 43.440503 · Lon -79.793130');

const osm = module.summarizeOsmElement({ type: 'way', id: 12, tags: { name: 'River Road', highway: 'residential' } });
assert.deepEqual(osm, {
    type: 'way',
    id: 12,
    name: 'River Road',
    tags: { name: 'River Road', highway: 'residential' }
});
assert.deepEqual(module.taggedOsmElements([
    { type: 'node', id: 1 },
    { type: 'node', id: 2, tags: {} },
    { type: 'node', id: 3, tags: { amenity: 'bench' } }
]), [{ type: 'node', id: 3, tags: { amenity: 'bench' } }]);

assert.deepEqual(module.osmIdentityTags({
    type: 'way',
    id: 18,
    tags: {
        highway: 'secondary',
        name: 'Haldimand County Road 18',
        surface: 'asphalt',
        lanes: '2'
    }
}), {
    tags: [
        { key: 'highway', val: '' },
        { key: 'name', val: 'Haldimand County Road 18' }
    ],
    typeKey: 'highway',
    identityField: 'name',
    identityValue: 'Haldimand County Road 18',
    mode: 'named',
    geometry: 'lines_polygons'
});

assert.deepEqual(module.osmIdentityTags({
    type: 'node',
    id: 44,
    tags: { amenity: 'bench', surface: 'wood' }
}), {
    tags: [{ key: 'amenity', val: '' }],
    typeKey: 'amenity',
    identityField: '',
    identityValue: '',
    mode: 'element',
    geometry: 'points'
});

assert.deepEqual(module.osmIdentityTags({
    type: 'relation',
    id: 99,
    tags: { boundary: 'administrative', admin_level: '8', name: 'Welland' }
}), {
    tags: [
        { key: 'boundary', val: 'administrative' },
        { key: 'admin_level', val: '8' },
        { key: 'name', val: 'Welland' }
    ],
    typeKey: 'boundary',
    identityField: 'name',
    identityValue: 'Welland',
    mode: 'named',
    geometry: 'lines_polygons'
});

assert.deepEqual(module.administrativeAreaToOsmElement({
    osm_type: 'relation',
    osm_id: 99,
    name: 'Welland',
    admin_level: '8'
}), {
    type: 'relation',
    id: 99,
    tags: { boundary: 'administrative', admin_level: '8', name: 'Welland' }
});

console.log('map context menu tests passed');
