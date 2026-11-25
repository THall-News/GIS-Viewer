const EPSILON = 1e-12;

const cloneJson = value => JSON.parse(JSON.stringify(value));

const sameCoordinate = (a, b) => (
    Array.isArray(a) && Array.isArray(b)
    && Number(a[0]) === Number(b[0])
    && Number(a[1]) === Number(b[1])
);

const finiteCoordinate = coordinate => (
    Array.isArray(coordinate)
    && coordinate.length >= 2
    && Number.isFinite(Number(coordinate[0]))
    && Number.isFinite(Number(coordinate[1]))
);

const openRing = coordinates => {
    const points = (Array.isArray(coordinates) ? coordinates : [])
        .filter(finiteCoordinate)
        .map(coordinate => [Number(coordinate[0]), Number(coordinate[1])]);
    if (points.length > 1 && sameCoordinate(points[0], points[points.length - 1])) points.pop();
    return points;
};

const closeRing = coordinates => {
    const points = coordinates.map(coordinate => [coordinate[0], coordinate[1]]);
    return points.length ? [...points, [...points[0]]] : points;
};

const normalizeModel = geometry => {
    if (!geometry || typeof geometry !== 'object') return null;
    if (geometry.type === 'LineString') {
        const line = (Array.isArray(geometry.coordinates) ? geometry.coordinates : [])
            .filter(finiteCoordinate)
            .map(coordinate => [Number(coordinate[0]), Number(coordinate[1])]);
        return line.length >= 2 ? { type: 'LineString', lines: [line] } : null;
    }
    if (geometry.type === 'Polygon') {
        const rings = (Array.isArray(geometry.coordinates) ? geometry.coordinates : []).map(openRing);
        return rings.length && rings.every(ring => ring.length >= 3)
            ? { type: 'Polygon', polygons: [{ rings }] }
            : null;
    }
    if (geometry.type === 'MultiPolygon') {
        const polygons = (Array.isArray(geometry.coordinates) ? geometry.coordinates : [])
            .map(coordinates => ({ rings: (Array.isArray(coordinates) ? coordinates : []).map(openRing) }))
            .filter(polygon => polygon.rings.length && polygon.rings.every(ring => ring.length >= 3));
        return polygons.length ? { type: 'MultiPolygon', polygons } : null;
    }
    return null;
};

const cloneModel = model => {
    if (model.type === 'LineString') return { type: model.type, lines: model.lines.map(line => line.map(point => [...point])) };
    return {
        type: model.type,
        polygons: model.polygons.map(polygon => ({
            rings: polygon.rings.map(ring => ring.map(point => [...point]))
        }))
    };
};

const geometryFromModel = model => {
    if (model.type === 'LineString') return { type: model.type, coordinates: model.lines[0].map(point => [...point]) };
    const coordinates = model.polygons.map(polygon => polygon.rings.map(closeRing));
    return { type: model.type, coordinates: model.type === 'Polygon' ? coordinates[0] : coordinates };
};

const countModelPoints = model => model.type === 'LineString'
    ? model.lines.reduce((total, line) => total + line.length, 0)
    : model.polygons.reduce((total, polygon) => total + polygon.rings.reduce((ringTotal, ring) => ringTotal + ring.length, 0), 0);

const minimumModelPoints = model => model.type === 'LineString'
    ? 2
    : model.polygons.reduce((total, polygon) => total + polygon.rings.length * 3, 0);

const cross = (a, b, c) => ((b[0] - a[0]) * (c[1] - a[1])) - ((b[1] - a[1]) * (c[0] - a[0]));
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const ringArea = ring => ring.reduce((total, point, index) => {
    const next = ring[(index + 1) % ring.length];
    return total + point[0] * next[1] - next[0] * point[1];
}, 0) / 2;

const orientation = (a, b, c) => {
    const value = cross(a, b, c);
    if (Math.abs(value) <= EPSILON) return 0;
    return value > 0 ? 1 : -1;
};

const onSegment = (a, b, point) => (
    Math.min(a[0], b[0]) - EPSILON <= point[0]
    && point[0] <= Math.max(a[0], b[0]) + EPSILON
    && Math.min(a[1], b[1]) - EPSILON <= point[1]
    && point[1] <= Math.max(a[1], b[1]) + EPSILON
);

const segmentsIntersect = (a, b, c, d) => {
    const abC = orientation(a, b, c);
    const abD = orientation(a, b, d);
    const cdA = orientation(c, d, a);
    const cdB = orientation(c, d, b);
    if (abC !== abD && cdA !== cdB) return true;
    return (abC === 0 && onSegment(a, b, c))
        || (abD === 0 && onSegment(a, b, d))
        || (cdA === 0 && onSegment(c, d, a))
        || (cdB === 0 && onSegment(c, d, b));
};

const ringSelfIntersects = ring => {
    if (ring.length < 3 || Math.abs(ringArea(ring)) <= EPSILON) return true;
    const segmentCount = ring.length;
    for (let first = 0; first < segmentCount; first += 1) {
        const firstEnd = ring[(first + 1) % segmentCount];
        for (let second = first + 1; second < segmentCount; second += 1) {
            const secondEnd = ring[(second + 1) % segmentCount];
            const adjacent = second === first + 1 || (first === 0 && second === segmentCount - 1);
            if (!adjacent && segmentsIntersect(ring[first], firstEnd, ring[second], secondEnd)) return true;
        }
    }
    return false;
};

const pointInRing = (point, ring) => {
    let inside = false;
    for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
        const currentPoint = ring[index];
        const previousPoint = ring[previous];
        const crosses = (currentPoint[1] > point[1]) !== (previousPoint[1] > point[1]);
        if (crosses) {
            const atX = ((previousPoint[0] - currentPoint[0]) * (point[1] - currentPoint[1]))
                / ((previousPoint[1] - currentPoint[1]) || Number.EPSILON) + currentPoint[0];
            if (point[0] < atX) inside = !inside;
        }
    }
    return inside;
};

const ringsIntersect = (first, second) => {
    for (let firstIndex = 0; firstIndex < first.length; firstIndex += 1) {
        const firstEnd = first[(firstIndex + 1) % first.length];
        for (let secondIndex = 0; secondIndex < second.length; secondIndex += 1) {
            const secondEnd = second[(secondIndex + 1) % second.length];
            if (segmentsIntersect(first[firstIndex], firstEnd, second[secondIndex], secondEnd)) return true;
        }
    }
    return false;
};

const validPolygon = polygon => {
    const [outer, ...holes] = polygon.rings;
    if (!outer || ringSelfIntersects(outer)) return false;
    for (const hole of holes) {
        if (ringSelfIntersects(hole) || !pointInRing(hole[0], outer) || ringsIntersect(hole, outer)) return false;
    }
    for (let first = 0; first < holes.length; first += 1) {
        for (let second = first + 1; second < holes.length; second += 1) {
            if (ringsIntersect(holes[first], holes[second]) || pointInRing(holes[first][0], holes[second]) || pointInRing(holes[second][0], holes[first])) return false;
        }
    }
    return true;
};

const validModel = model => {
    if (model.type === 'LineString') {
        const line = model.lines[0];
        return line.length >= 2 && line.every((point, index) => index === 0 || !sameCoordinate(point, line[index - 1]));
    }
    if (!model.polygons.every(validPolygon)) return false;
    for (let first = 0; first < model.polygons.length; first += 1) {
        const firstOuter = model.polygons[first].rings[0];
        for (let second = first + 1; second < model.polygons.length; second += 1) {
            const secondOuter = model.polygons[second].rings[0];
            if (ringsIntersect(firstOuter, secondOuter)) return false;
        }
    }
    return true;
};

const hashSeed = (seed, path, index) => {
    let hash = 2166136261;
    const text = `${seed}|${path}|${index}`;
    for (let character = 0; character < text.length; character += 1) {
        hash ^= text.charCodeAt(character);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) / 4294967296;
};

const candidateScore = (previous, current, next) => {
    const baseline = distance(previous, next);
    return Math.abs(cross(previous, current, next)) / (baseline || 1);
};

const candidatesForModel = (model, seed) => {
    const candidates = [];
    const addCandidates = (coordinates, path, closed, minimum) => {
        if (coordinates.length <= minimum) return;
        const start = closed ? 0 : 1;
        const end = closed ? coordinates.length : coordinates.length - 1;
        for (let index = start; index < end; index += 1) {
            const previous = coordinates[closed ? (index - 1 + coordinates.length) % coordinates.length : index - 1];
            const next = coordinates[closed ? (index + 1) % coordinates.length : index + 1];
            const score = candidateScore(previous, coordinates[index], next);
            const tie = hashSeed(seed, path, index);
            candidates.push({ path, index, score, tie });
        }
    };

    if (model.type === 'LineString') {
        addCandidates(model.lines[0], 'line', false, 2);
        return candidates;
    }
    model.polygons.forEach((polygon, polygonIndex) => {
        polygon.rings.forEach((ring, ringIndex) => {
            addCandidates(ring, `${polygonIndex}:${ringIndex}`, true, 3);
        });
    });
    return candidates;
};

const removeCandidate = (model, candidate) => {
    const nextModel = cloneModel(model);
    if (nextModel.type === 'LineString') {
        nextModel.lines[0].splice(candidate.index, 1);
        return nextModel;
    }
    const [polygonIndex, ringIndex] = candidate.path.split(':').map(Number);
    nextModel.polygons[polygonIndex].rings[ringIndex].splice(candidate.index, 1);
    return nextModel;
};

const byteSize = value => {
    const serialized = JSON.stringify(value);
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(serialized).length;
    return new Blob([serialized]).size;
};

export const featureGeoJsonByteSize = feature => byteSize({ type: 'FeatureCollection', features: [feature] });

export const countGeometryVertices = geometry => {
    const model = normalizeModel(geometry);
    return model ? countModelPoints(model) : 0;
};

const targetDescription = (mode, target, unit) => {
    if (mode === 'percentage') return `${target}% retained`;
    if (mode === 'points') return `${target} points`;
    return `${target} ${unit || 'bytes'}`;
};

export const simplifyFeature = (feature, options = {}) => {
    const mode = options.mode || 'percentage';
    const numericTarget = Number(options.target);
    const seed = Number.isInteger(Number(options.seed)) ? Number(options.seed) : 0;
    const model = normalizeModel(feature?.geometry);
    if (!feature || !model || !Number.isFinite(numericTarget)) {
        return { feature: feature ? cloneJson(feature) : feature, changed: false, warning: 'A valid Polygon, MultiPolygon, or LineString and numeric target are required.' };
    }

    const originalModel = cloneModel(model);
    const originalCount = countModelPoints(model);
    const minimumCount = minimumModelPoints(model);
    const originalFeature = { ...cloneJson(feature), geometry: geometryFromModel(originalModel) };
    const originalBytes = featureGeoJsonByteSize(originalFeature);
    let targetCount = null;
    let targetBytes = null;
    let targetWarning = '';

    if (mode === 'percentage') {
        const percentage = Math.max(0, Math.min(100, numericTarget));
        targetCount = Math.round(originalCount * percentage / 100);
    } else if (mode === 'points') {
        targetCount = Math.round(numericTarget);
    } else if (mode === 'size') {
        const multiplier = Number(options.unitMultiplier) > 0 ? Number(options.unitMultiplier) : 1;
        targetBytes = Math.max(0, numericTarget * multiplier);
    } else {
        return { feature: originalFeature, changed: false, warning: 'Unknown simplification mode.' };
    }

    if (targetCount !== null && targetCount < minimumCount) {
        targetWarning = `Target requires fewer points than valid geometry allows; minimum is ${minimumCount}.`;
        targetCount = minimumCount;
    }
    if (targetCount !== null && targetCount > originalCount) {
        targetWarning = 'Target is greater than the current point count; geometry was not changed.';
        targetCount = originalCount;
    }
    if (targetBytes !== null && targetBytes >= originalBytes) {
        targetWarning = 'Target is greater than the current GeoJSON size; geometry was not changed.';
    }

    let working = cloneModel(model);
    const shouldContinue = () => targetCount !== null
        ? countModelPoints(working) > targetCount
        : byteSize({ type: 'FeatureCollection', features: [{ ...originalFeature, geometry: geometryFromModel(working) }] }) > targetBytes;

    while (shouldContinue()) {
        const candidates = candidatesForModel(working, seed)
            .sort((first, second) => first.score - second.score || first.tie - second.tie);
        let removed = false;
        for (const candidate of candidates) {
            const trial = removeCandidate(working, candidate);
            if (!validModel(trial)) continue;
            working = trial;
            removed = true;
            break;
        }
        if (!removed) break;
    }

    const resultFeature = { ...originalFeature, geometry: geometryFromModel(working) };
    const finalCount = countModelPoints(working);
    const finalBytes = featureGeoJsonByteSize(resultFeature);
    const targetReached = targetCount !== null ? finalCount === targetCount : finalBytes <= targetBytes;
    if (!targetReached && !targetWarning) {
        targetWarning = `Could not reach ${targetDescription(mode, numericTarget, options.unitLabel)} without compromising geometry; kept the best valid result.`;
    }

    return {
        feature: resultFeature,
        geometry: resultFeature.geometry,
        originalPoints: originalCount,
        finalPoints: finalCount,
        originalBytes,
        finalBytes,
        targetPoints: targetCount,
        targetBytes,
        changed: JSON.stringify(originalFeature.geometry) !== JSON.stringify(resultFeature.geometry),
        warning: targetWarning,
        seed
    };
};
