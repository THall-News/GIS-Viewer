// Geometry-independent selection grouping helpers. Rendered vector-tile
// features may be clipped into different tiles and can therefore expose
// different tile-local IDs even when they are pieces of one map feature.

const EXPLICIT_ID_FIELDS = [
    'osm_id',
    'osm_way_id',
    'osm_way',
    'way_id',
    '@id',
    'feature_id'
];

const SEMANTIC_FIELDS = [
    'selection_category',
    'class',
    'subclass',
    'kind',
    'type',
    'landcover',
    'natural',
    'water',
    'waterway',
    'boundary',
    'name',
    'name_en',
    'name:en',
    'ref'
];

const normalize = value => {
    if (value === undefined || value === null) return '';
    if (Array.isArray(value)) return value.map(item => String(item)).join('|').trim().toLowerCase();
    return String(value).trim().toLowerCase();
};

const propertiesFor = feature => feature?.properties || {};

const sourceFor = feature => normalize(
    feature?.source
    || feature?.layer?.source
    || propertiesFor(feature).source_id
    || 'openfreemap'
);

const sourceLayerFor = feature => normalize(
    feature?.sourceLayer
    || feature?.layer?.['source-layer']
    || propertiesFor(feature).source_layer
    || 'unknown'
);

const categoryFor = feature => normalize(propertiesFor(feature).selection_category || 'other');

const explicitIdentityFor = feature => {
    const properties = propertiesFor(feature);
    for (const field of EXPLICIT_ID_FIELDS) {
        const value = normalize(properties[field]);
        if (value) return `${field}:${value}`;
    }
    return '';
};

const featureIdFor = feature => {
    const value = feature?.id;
    return value === undefined || value === null || normalize(value) === '' ? '' : normalize(value);
};

const semanticSignatureFor = feature => JSON.stringify(SEMANTIC_FIELDS.map(field => [
    field,
    normalize(propertiesFor(feature)[field])
]));

const ringsFor = geometry => {
    if (!geometry) return [];
    if (geometry.type === 'Polygon') return geometry.coordinates || [];
    if (geometry.type === 'MultiPolygon') return (geometry.coordinates || []).flatMap(polygon => polygon || []);
    if (geometry.type === 'LineString') return [geometry.coordinates || []];
    if (geometry.type === 'MultiLineString') return geometry.coordinates || [];
    return [];
};

const validCoordinate = coordinate => Array.isArray(coordinate)
    && coordinate.length >= 2
    && Number.isFinite(Number(coordinate[0]))
    && Number.isFinite(Number(coordinate[1]));

const metersPerDegree = latitude => ({
    x: 111320 * Math.max(0.01, Math.cos(Number(latitude) * Math.PI / 180)),
    y: 110574
});

const toLocalMeters = (coordinate, latitude) => {
    const scale = metersPerDegree(latitude);
    return {
        x: Number(coordinate[0]) * scale.x,
        y: Number(coordinate[1]) * scale.y
    };
};

const pointToSegmentDistance = (point, first, second) => {
    if (!validCoordinate(point) || !validCoordinate(first) || !validCoordinate(second)) return Infinity;
    const latitude = (Number(point[1]) + Number(first[1]) + Number(second[1])) / 3;
    const p = toLocalMeters(point, latitude);
    const a = toLocalMeters(first, latitude);
    const b = toLocalMeters(second, latitude);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    if (!lengthSquared) return Math.hypot(p.x - a.x, p.y - a.y);
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
};

const ringDistance = (first, second) => {
    let closest = Infinity;
    for (const point of first) {
        for (let index = 0; index + 1 < second.length; index += 1) {
            closest = Math.min(closest, pointToSegmentDistance(point, second[index], second[index + 1]));
        }
    }
    return closest;
};

const bboxFor = rings => {
    const bbox = [Infinity, Infinity, -Infinity, -Infinity];
    rings.flat().forEach(coordinate => {
        if (!validCoordinate(coordinate)) return;
        bbox[0] = Math.min(bbox[0], Number(coordinate[0]));
        bbox[1] = Math.min(bbox[1], Number(coordinate[1]));
        bbox[2] = Math.max(bbox[2], Number(coordinate[0]));
        bbox[3] = Math.max(bbox[3], Number(coordinate[1]));
    });
    return Number.isFinite(bbox[0]) ? bbox : null;
};

const bboxesCouldTouch = (first, second, toleranceMeters) => {
    const firstLatitude = (first[1] + first[3]) / 2;
    const secondLatitude = (second[1] + second[3]) / 2;
    const latitudeTolerance = toleranceMeters / 110574;
    const longitudeTolerance = toleranceMeters / (111320 * Math.max(
        0.01,
        Math.cos(((firstLatitude + secondLatitude) / 2) * Math.PI / 180)
    ));
    return first[0] <= second[2] + longitudeTolerance
        && first[2] + longitudeTolerance >= second[0]
        && first[1] <= second[3] + latitudeTolerance
        && first[3] + latitudeTolerance >= second[1];
};

export const featureFragmentsTouch = (first, second, toleranceMeters = 3) => {
    const firstRings = ringsFor(first?.geometry).filter(ring => Array.isArray(ring) && ring.length >= 2);
    const secondRings = ringsFor(second?.geometry).filter(ring => Array.isArray(ring) && ring.length >= 2);
    if (!firstRings.length || !secondRings.length) return false;
    const firstBbox = bboxFor(firstRings);
    const secondBbox = bboxFor(secondRings);
    if (!firstBbox || !secondBbox || !bboxesCouldTouch(firstBbox, secondBbox, toleranceMeters)) return false;
    return firstRings.some(firstRing => secondRings.some(secondRing => (
        ringDistance(firstRing, secondRing) <= toleranceMeters
        || ringDistance(secondRing, firstRing) <= toleranceMeters
    )));
};

const sameSourceFamily = (first, second) => sourceFor(first) === sourceFor(second)
    && sourceLayerFor(first) === sourceLayerFor(second)
    && categoryFor(first) === categoryFor(second);

const sameSemanticFamily = (first, second) => {
    const firstSignature = semanticSignatureFor(first);
    const secondSignature = semanticSignatureFor(second);
    return firstSignature === secondSignature;
};

export const featureFragmentsCanMerge = (first, second, toleranceMeters = 3) => {
    if (!sameSourceFamily(first, second)) return false;

    const firstExplicitIdentity = explicitIdentityFor(first);
    const secondExplicitIdentity = explicitIdentityFor(second);
    if (firstExplicitIdentity && secondExplicitIdentity) {
        if (firstExplicitIdentity !== secondExplicitIdentity) return false;
        // An explicit OSM/source identifier is authoritative. A feature may
        // legitimately be disconnected while still being one source feature.
        return true;
    }

    const firstFeatureId = featureIdFor(first);
    const secondFeatureId = featureIdFor(second);
    if (firstFeatureId && secondFeatureId && firstFeatureId === secondFeatureId
        && sameSemanticFamily(first, second)) {
        // Preserve the existing same-rendered-feature behavior, including
        // disconnected parts of a single MultiPolygon.
        return true;
    }

    // Tile-local IDs are not reliable across tile boundaries. When there is
    // no shared source identity, only join geometries that have compatible
    // metadata and actually touch (within a small vector-tile seam tolerance).
    if (!sameSemanticFamily(first, second)) return false;
    return featureFragmentsTouch(first, second, toleranceMeters);
};

export const groupFeatureFragments = (features, toleranceMeters = 3) => {
    const items = (features || []).filter(Boolean);
    const parent = items.map((_, index) => index);
    const find = index => {
        let root = index;
        while (parent[root] !== root) root = parent[root];
        while (parent[index] !== index) {
            const next = parent[index];
            parent[index] = root;
            index = next;
        }
        return root;
    };
    const join = (first, second) => {
        const firstRoot = find(first);
        const secondRoot = find(second);
        if (firstRoot !== secondRoot) parent[secondRoot] = firstRoot;
    };

    for (let first = 0; first < items.length; first += 1) {
        for (let second = first + 1; second < items.length; second += 1) {
            if (featureFragmentsCanMerge(items[first], items[second], toleranceMeters)) join(first, second);
        }
    }

    const groups = new Map();
    items.forEach((feature, index) => {
        const root = find(index);
        if (!groups.has(root)) groups.set(root, []);
        groups.get(root).push(feature);
    });
    return [...groups.values()];
};
