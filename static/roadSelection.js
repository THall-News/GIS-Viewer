// Pure road-selection identity and geometry helpers. Keeping these functions
// separate from the map/UI code makes the tile-fragment rules testable without
// loading Leaflet or MapLibre.

const EXPLICIT_ID_FIELDS = [
    ['osm_id', 'osm_id'],
    ['osm_way_id', 'osm_way_id'],
    ['osm_way', 'osm_way'],
    ['way_id', 'way_id'],
    ['@id', '@id'],
    ['road_osm_id', 'road_osm_id'],
    ['road_feature_id', 'road_feature_id']
];

const normalizeIdentifier = value => (
    value === undefined || value === null || String(value).trim() === ''
        ? ''
        : String(value).trim()
);

const sourceForFeature = feature => feature?.source
    || feature?.layer?.source
    || feature?.properties?.source_id
    || 'openfreemap';

const sourceLayerForFeature = feature => String(
    feature?.sourceLayer
    || feature?.layer?.['source-layer']
    || feature?.properties?.source_layer
    || 'unknown'
).toLowerCase();

export const roadStableIdentifiers = feature => {
    const properties = feature?.properties || {};
    const candidates = [
        ...EXPLICIT_ID_FIELDS.map(([field, source]) => ({ value: properties[field], source })),
        { value: feature?.id, source: 'feature.id' },
        { value: properties.id, source: 'properties.id' }
    ];
    return candidates
        .map(candidate => ({ ...candidate, value: normalizeIdentifier(candidate.value) }))
        .filter(candidate => candidate.value);
};

export const roadFeatureIdentity = feature => {
    const identifiers = roadStableIdentifiers(feature);
    const source = sourceForFeature(feature);
    const sourceLayer = sourceLayerForFeature(feature);
    const primary = identifiers[0] || null;
    if (!primary) {
        return {
            key: null,
            identifier: '',
            source,
            sourceLayer,
            identitySource: 'none',
            hasStableIdentity: false
        };
    }
    return {
        key: `${source}:${sourceLayer}:${primary.value}`,
        identifier: primary.value,
        source,
        sourceLayer,
        identitySource: primary.source,
        hasStableIdentity: true
    };
};

export const roadStableIdentifier = feature => roadFeatureIdentity(feature).identifier;

export const stableIdentifierValues = feature => new Set(
    roadStableIdentifiers(feature).map(identifier => identifier.value)
);

export const featureForRenderedSelection = nearestCandidate => {
    const feature = nearestCandidate?.feature;
    if (!feature) return null;
    const geometry = feature.geometry;
    const polygonIndex = nearestCandidate.polygonIndex;
    if (
        geometry?.type === 'MultiPolygon'
        && Number.isInteger(polygonIndex)
        && Array.isArray(geometry.coordinates?.[polygonIndex])
    ) {
        return {
            ...feature,
            geometry: {
                type: 'Polygon',
                coordinates: JSON.parse(JSON.stringify(geometry.coordinates[polygonIndex]))
            }
        };
    }
    const lineCoordinates = nearestCandidate.lineCoordinates;
    if (!Array.isArray(lineCoordinates) || lineCoordinates.length < 2) return feature;
    if (!['LineString', 'MultiLineString'].includes(geometry?.type)) return feature;
    return {
        ...feature,
        geometry: {
            type: 'LineString',
            coordinates: JSON.parse(JSON.stringify(lineCoordinates))
        }
    };
};

const lineParts = geometry => {
    if (!geometry) return [];
    if (geometry.type === 'LineString') return [geometry.coordinates];
    if (geometry.type === 'MultiLineString') return geometry.coordinates;
    return [];
};

const cloneLine = coordinates => coordinates
    .filter(coordinate => Array.isArray(coordinate) && coordinate.length >= 2)
    .map(coordinate => [Number(coordinate[0]), Number(coordinate[1])]);

const metersPerDegree = latitude => ({
    x: 111320 * Math.max(0.01, Math.cos(Number(latitude) * Math.PI / 180)),
    y: 110574
});

const toLocalMeters = (coordinate, latitude) => {
    const scale = metersPerDegree(latitude);
    return { x: Number(coordinate[0]) * scale.x, y: Number(coordinate[1]) * scale.y };
};

const pointToSegmentDistance = (point, first, second) => {
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

const pointToLineDistance = (point, line) => {
    let closest = Infinity;
    for (let index = 0; index + 1 < line.length; index += 1) {
        closest = Math.min(closest, pointToSegmentDistance(point, line[index], line[index + 1]));
    }
    return closest;
};

const linePartsConnect = (first, second, toleranceMeters) => {
    if (first.length < 2 || second.length < 2) return false;
    const firstEndpoints = [first[0], first[first.length - 1]];
    const secondEndpoints = [second[0], second[second.length - 1]];
    return firstEndpoints.some(point => pointToLineDistance(point, second) <= toleranceMeters)
        || secondEndpoints.some(point => pointToLineDistance(point, first) <= toleranceMeters);
};

const endpointDistance = (first, second) => {
    const latitude = (Number(first[1]) + Number(second[1])) / 2;
    const a = toLocalMeters(first, latitude);
    const b = toLocalMeters(second, latitude);
    return Math.hypot(a.x - b.x, a.y - b.y);
};

const reverseLine = line => [...line].reverse();

const appendLine = (chain, line, reverse = false, toleranceMeters = 2) => {
    const candidate = reverse ? reverseLine(line) : [...line];
    if (!candidate.length) return chain;
    const last = chain[chain.length - 1];
    const first = candidate[0];
    if (last && endpointDistance(last, first) <= toleranceMeters) {
        candidate[0] = [...last];
        chain.push(...candidate.slice(1));
    } else {
        chain.push(...candidate);
    }
    return chain;
};

const stitchLines = (lines, toleranceMeters) => {
    const remaining = lines.map(line => [...line]);
    const chains = [];
    while (remaining.length) {
        const chain = remaining.shift();
        let extended = true;
        while (extended && remaining.length) {
            extended = false;
            let best = null;
            remaining.forEach((candidate, index) => {
                const options = [
                    { distance: endpointDistance(chain[chain.length - 1], candidate[0]), prepend: false, reverse: false },
                    { distance: endpointDistance(chain[chain.length - 1], candidate[candidate.length - 1]), prepend: false, reverse: true },
                    { distance: endpointDistance(chain[0], candidate[candidate.length - 1]), prepend: true, reverse: false },
                    { distance: endpointDistance(chain[0], candidate[0]), prepend: true, reverse: true }
                ];
                options.forEach(option => {
                    if (option.distance <= toleranceMeters && (!best || option.distance < best.distance)) {
                        best = { ...option, index, candidate };
                    }
                });
            });
            if (!best) continue;
            remaining.splice(best.index, 1);
            const oriented = best.reverse ? reverseLine(best.candidate) : [...best.candidate];
            if (best.prepend) {
                // For prepend candidates, the oriented line ends at the
                // current chain start. Drop that shared endpoint and add the
                // remaining coordinates in their existing order.
                const prefix = oriented.slice(0, -1);
                chain.unshift(...prefix);
            } else {
                appendLine(chain, oriented, false, toleranceMeters);
            }
            extended = true;
        }
        chains.push(chain);
    }
    if (chains.length === 1) return { type: 'LineString', coordinates: chains[0] };
    return { type: 'MultiLineString', coordinates: chains };
};

const mergeProperties = parts => parts.reduce((properties, part) => {
    Object.entries(part.feature?.properties || {}).forEach(([key, value]) => {
        if (properties[key] === undefined || properties[key] === null || properties[key] === '') properties[key] = value;
    });
    return properties;
}, {});

const componentFeature = (parts, componentIndex, toleranceMeters) => {
    const first = parts[0];
    const identity = roadFeatureIdentity(first.feature);
    const geometry = stitchLines(parts.map(part => part.coordinates), toleranceMeters);
    const properties = mergeProperties(parts);
    const sourceFeatureIndexes = new Set(parts.map(part => part.sourceFeatureIndex));
    const connected = parts.length > 1;
    Object.assign(properties, {
        selected_fragment_count: parts.length,
        selected_source_feature_count: sourceFeatureIndexes.size,
        geometry_merge_method: connected
            ? geometry.type === 'LineString' ? 'connected fragment endpoint stitching' : 'connected fragment MultiLineString'
            : 'single rendered fragment',
        road_identity_key: identity.key || '',
        road_identity_source: identity.identitySource
    });
    if (identity.identifier && !properties.road_feature_id) properties.road_feature_id = identity.identifier;
    if (!properties.road_osm_id) properties.road_osm_id = properties.osm_id || properties.osm_way_id || '';
    return {
        type: 'Feature',
        id: `road:${identity.key || 'fragment'}:${componentIndex}`,
        properties,
        geometry
    };
};

export const combineRoadFeatureFragments = (features, { toleranceMeters = 2 } = {}) => {
    const parts = [];
    (features || []).forEach((feature, sourceFeatureIndex) => {
        lineParts(feature.geometry).forEach((coordinates, partIndex) => {
            const line = cloneLine(coordinates);
            if (line.length >= 2) parts.push({ feature, sourceFeatureIndex, partIndex, coordinates: line });
        });
    });

    const buckets = new Map();
    parts.forEach(part => {
        const identity = roadFeatureIdentity(part.feature);
        const key = identity.key || `fragment:${parts.indexOf(part)}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(part);
    });

    const output = [];
    buckets.forEach(bucket => {
        const parent = bucket.map(() => -1);
        let componentCount = 0;
        bucket.forEach((part, index) => {
            if (parent[index] !== -1) return;
            parent[index] = componentCount;
            const queue = [index];
            while (queue.length) {
                const current = queue.shift();
                bucket.forEach((candidate, candidateIndex) => {
                    if (parent[candidateIndex] !== -1) return;
                    if (!linePartsConnect(bucket[current].coordinates, candidate.coordinates, toleranceMeters)) return;
                    parent[candidateIndex] = componentCount;
                    queue.push(candidateIndex);
                });
            }
            componentCount += 1;
        });
        for (let componentIndex = 0; componentIndex < componentCount; componentIndex += 1) {
            output.push(componentFeature(
                bucket.filter((part, index) => parent[index] === componentIndex),
                output.length,
                toleranceMeters
            ));
        }
    });
    return output;
};
