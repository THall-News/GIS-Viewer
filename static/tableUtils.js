// Pure attribute-table operations. DOM and map behavior stay in app.js.
export function sortFeatures(features, column, ascending = true) {
    return [...features].sort((a, b) => {
        const left = a?.properties?.[column] ?? '';
        const right = b?.properties?.[column] ?? '';
        const result = String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: 'base' });
        return ascending ? result : -result;
    });
}

export function featuresToCsv(features) {
    const fields = new Set();
    features.forEach(feature => Object.keys(feature?.properties || {}).forEach(key => fields.add(key)));
    const headers = [...fields].filter(key => key !== '__row_id');
    const rows = features.map(feature => headers.map(header => {
        const value = feature?.properties?.[header] ?? '';
        return `"${String(value).replace(/"/g, '""')}"`;
    }).join(','));
    return [headers.join(','), ...rows].join('\n') + '\n';
}

export function bakeFeatureCoordinates(features, turfApi) {
    let count = 0;
    features.forEach(feature => {
        if (!feature.properties) feature.properties = {};
        try {
            let coordinates;
            if (feature.geometry?.type === 'Point') coordinates = feature.geometry.coordinates;
            else if (feature.geometry) coordinates = turfApi.centroid(feature).geometry.coordinates;
            if (coordinates?.length >= 2) {
                feature.properties.LATITUDE = Number(coordinates[1].toFixed(6));
                feature.properties.LONGITUDE = Number(coordinates[0].toFixed(6));
                count++;
            }
        } catch (_) { /* malformed geometries are skipped */ }
    });
    return count;
}
