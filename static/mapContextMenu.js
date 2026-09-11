const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
}[character]));

export const formatContextCoordinate = value => {
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(6) : '—';
};

export const formatContextCoordinates = point => {
    if (!point) return 'Lat — · Lon —';
    return `Lat ${formatContextCoordinate(point.lat)} · Lon ${formatContextCoordinate(point.lng)}`;
};

const normalizeWgs84Point = point => {
    const latitude = Number(point?.lat);
    const longitude = Number(point?.lng);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90) return null;

    // Leaflet can report a longitude outside one world copy when the map is
    // wrapped horizontally. Overpass requires the canonical WGS84 range.
    let wrappedLongitude = ((longitude + 180) % 360 + 360) % 360 - 180;
    if (wrappedLongitude === -180 && longitude > 0) wrappedLongitude = 180;
    return { lat: latitude, lng: wrappedLongitude };
};

const elementName = element => {
    const tags = element?.tags || {};
    return tags.name || tags.ref || tags.operator || tags.type || `${element?.type || 'element'} ${element?.id ?? ''}`.trim();
};

export const summarizeOsmElement = element => ({
    type: element?.type || 'element',
    id: element?.id ?? 'unknown',
    name: elementName(element),
    tags: element?.tags || {}
});

export const taggedOsmElements = elements => (Array.isArray(elements) ? elements : [])
    .filter(element => element?.tags && Object.keys(element.tags).length > 0);

const OSM_PRIMARY_TYPE_KEYS = [
    'highway', 'waterway', 'railway', 'boundary', 'landuse',
    'natural', 'amenity', 'building', 'leisure', 'place'
];

// Keep point-inspection results useful for a follow-up whole-feature query.
// These are deliberately small identity filters; descriptive tags vary from
// segment to segment and should not accidentally exclude matching geometry.
export const osmIdentityTags = element => {
    const tags = element?.tags && typeof element.tags === 'object' ? element.tags : {};
    const typeKey = OSM_PRIMARY_TYPE_KEYS.find(key => Object.prototype.hasOwnProperty.call(tags, key));
    const identityKey = ['name', 'ref', 'official_name', 'operator']
        .find(key => String(tags[key] ?? '').trim());
    const identityValue = identityKey ? String(tags[identityKey]).trim() : '';
    const selectedTags = [];
    const isAdministrativeBoundary = element?.type === 'relation'
        && String(tags.boundary || '').toLowerCase() === 'administrative';
    if (typeKey) {
        selectedTags.push({
            key: typeKey,
            val: isAdministrativeBoundary ? 'administrative' : ''
        });
    }
    if (isAdministrativeBoundary && String(tags.admin_level ?? '').trim()) {
        selectedTags.push({ key: 'admin_level', val: String(tags.admin_level).trim() });
    }
    if (identityKey && identityValue) selectedTags.push({ key: identityKey, val: identityValue });
    return {
        tags: selectedTags,
        typeKey: typeKey || '',
        identityField: identityKey || '',
        identityValue,
        mode: isAdministrativeBoundary || (identityKey && identityValue) ? 'named' : 'element',
        geometry: element?.type === 'node' ? 'points' : 'lines_polygons'
    };
};

export const administrativeAreaToOsmElement = area => {
    const sourceTags = area?.tags && typeof area.tags === 'object' ? area.tags : {};
    const tags = {
        ...sourceTags,
        boundary: 'administrative',
    };
    if (area?.admin_level != null) tags.admin_level = String(area.admin_level);
    if (area?.name) tags.name = String(area.name);
    return {
        type: area?.osm_type || 'relation',
        id: area?.osm_id,
        tags,
    };
};

const setStatus = (element, text, error = false) => {
    if (!element) return;
    const message = String(text || '');
    element.textContent = message;
    element.classList.toggle('hidden', !message);
    element.classList.toggle('text-red-600', error);
    element.classList.toggle('dark:text-red-400', error);
    element.classList.toggle('italic', !error);
};

const copyText = async text => {
    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
    }
    const input = document.createElement('textarea');
    input.value = text;
    input.setAttribute('readonly', '');
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.appendChild(input);
    input.select();
    const copied = document.execCommand('copy');
    input.remove();
    if (!copied) throw new Error('Clipboard access was not available.');
};

const renderOsmElements = (container, elements, onSelect) => {
    if (!container) return;
    container.replaceChildren();
    elements.forEach(element => {
        const summary = summarizeOsmElement(element);
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'w-full text-left rounded border border-gray-200 dark:border-gray-700 bg-gray-50/70 dark:bg-gray-900/40 hover:bg-blue-50 dark:hover:bg-blue-900/30 p-1.5 transition-colors';
        item.setAttribute('aria-label', `Prepare a whole-feature search for ${summary.name} (${summary.type} ${summary.id})`);
        const tagText = Object.entries(summary.tags).slice(0, 5).map(([key, value]) => `${key}=${value}`).join(' · ');
        item.innerHTML = `
            <div class="flex items-center justify-between gap-2">
                <span class="truncate font-semibold text-gray-700 dark:text-gray-200">${escapeHtml(summary.name)}</span>
                <span class="shrink-0 text-[9px] text-gray-500 dark:text-gray-400">${escapeHtml(summary.type)} ${escapeHtml(summary.id)}</span>
            </div>
            <div class="mt-0.5 break-words text-[9px] text-gray-500 dark:text-gray-400">${escapeHtml(tagText || 'No tags')}</div>
        `;
        item.addEventListener('click', () => onSelect?.(element));
        container.appendChild(item);
    });
};

export const createMapContextMenuController = ({
    map,
    showToast,
    onOsmResults,
    onOsmElementSelected,
    fetchImpl = window.fetch.bind(window)
} = {}) => {
    const menu = document.getElementById('map-context-menu');
    const coordinates = document.getElementById('map-context-coordinates');
    const osmStatus = document.getElementById('map-context-osm-status');
    const osmResults = document.getElementById('map-context-osm-results');
    const adminContext = document.getElementById('map-context-admin-context');
    const adminResults = document.getElementById('map-context-admin-results');
    const copyButton = document.getElementById('btn-map-context-copy');
    const osmButton = document.getElementById('btn-map-context-osm');
    if (!map || !menu) return { open: () => {}, close: () => {}, destroy: () => {} };

    let activePoint = null;
    let activeOriginalEvent = null;
    let requestToken = 0;
    let osmController = null;

    const resetOsmButton = () => {
        if (!osmButton) return;
        osmButton.disabled = false;
        osmButton.classList.remove('opacity-60', 'cursor-wait');
        osmButton.innerHTML = '<i class="fa-solid fa-magnifying-glass-location mr-1"></i>Query OSM here';
    };

    const close = () => {
        requestToken += 1;
        osmController?.abort();
        osmController = null;
        resetOsmButton();
        activePoint = null;
        activeOriginalEvent = null;
        menu.classList.remove('map-context-menu-expanded');
        menu.classList.add('hidden');
    };

    const positionMenu = originalEvent => {
        const parent = menu.parentElement;
        const parentRect = parent?.getBoundingClientRect?.();
        if (!parentRect) return;
        const clientX = Number(originalEvent?.clientX);
        const clientY = Number(originalEvent?.clientY);
        const rawLeft = Number.isFinite(clientX) ? clientX - parentRect.left : 8;
        const rawTop = Number.isFinite(clientY) ? clientY - parentRect.top : 8;
        const statusBarTop = document.getElementById('map-status-bar')?.getBoundingClientRect?.().top;
        const visibleBottom = Math.min(
            parentRect.bottom,
            Number.isFinite(statusBarTop) ? statusBarTop : window.innerHeight,
            window.innerHeight
        );
        const visibleRight = Math.min(parentRect.right, window.innerWidth);
        const minLeft = Math.max(8, 8 - parentRect.left);
        const minTop = Math.max(8, 8 - parentRect.top);
        const maxLeft = Math.max(minLeft, visibleRight - parentRect.left - menu.offsetWidth - 8);
        const maxTop = Math.max(minTop, visibleBottom - parentRect.top - menu.offsetHeight - 8);
        menu.style.left = `${Math.max(minLeft, Math.min(rawLeft, maxLeft))}px`;
        menu.style.top = `${Math.max(minTop, Math.min(rawTop, maxTop))}px`;
    };

    const renderAdministrativeContext = data => {
        const areas = Array.isArray(data?.administrative_context) ? data.administrative_context : [];
        if (!adminContext || !adminResults) return areas;
        adminResults.replaceChildren();
        adminContext.classList.remove('hidden');
        if (!areas.length) {
            const empty = document.createElement('div');
            empty.className = 'text-gray-600 dark:text-gray-300';
            empty.textContent = 'No containing administrative boundaries found.';
            adminResults.appendChild(empty);
            return areas;
        }
        areas.forEach(area => {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'w-full flex items-baseline justify-between gap-2 rounded px-1 text-left hover:bg-blue-100 dark:hover:bg-blue-900/40';
            row.setAttribute('aria-label', `Prepare a whole-feature search for ${area?.name || 'administrative area'} admin level ${area?.admin_level || ''}`);
            const name = document.createElement('span');
            name.className = 'truncate font-medium';
            name.textContent = area?.name || 'Unnamed administrative area';
            name.title = name.textContent;
            const level = document.createElement('span');
            level.className = 'shrink-0 font-mono text-[9px] text-blue-700 dark:text-blue-300';
            level.textContent = `admin_level ${area?.admin_level || '—'}`;
            row.append(name, level);
            row.addEventListener('click', () => {
                onOsmElementSelected?.(administrativeAreaToOsmElement(area), activePoint);
                close();
            });
            adminResults.appendChild(row);
        });
        return areas;
    };

    const renderOsm = data => {
        const administrativeAreas = renderAdministrativeContext(data);
        const elements = taggedOsmElements(data?.elements);
        menu.classList.toggle('map-context-menu-expanded', elements.length > 0 || administrativeAreas.length > 0);
        if (!elements.length) {
            setStatus(osmStatus, 'No OSM elements were found within 25 metres.');
            osmResults.replaceChildren();
            requestAnimationFrame(() => positionMenu(activeOriginalEvent));
            return;
        }
        setStatus(osmStatus, 'Nearby OSM elements:');
        renderOsmElements(osmResults, elements, element => {
            onOsmElementSelected?.(element, activePoint);
            close();
        });
        requestAnimationFrame(() => positionMenu(activeOriginalEvent));
        if (Array.isArray(data?.warnings) && data.warnings.length) {
            const warning = document.createElement('div');
            warning.className = 'mt-1 text-[9px] text-amber-700 dark:text-amber-300';
            warning.textContent = data.warnings.join(' ');
            osmResults.appendChild(warning);
        }
    };

    const open = event => {
        event?.originalEvent?.preventDefault?.();
        event?.originalEvent?.stopPropagation?.();
        const latlng = normalizeWgs84Point(event?.latlng);
        if (!latlng) {
            showToast?.('Could not determine a valid WGS84 coordinate at that map point.', true);
            return;
        }
        close();
        activePoint = latlng;
        activeOriginalEvent = event.originalEvent;
        coordinates.textContent = formatContextCoordinates(activePoint);
        setStatus(osmStatus, '');
        osmResults.replaceChildren();
        adminContext?.classList.add('hidden');
        adminResults?.replaceChildren();
        menu.classList.remove('hidden');
        positionMenu(event.originalEvent);
        requestAnimationFrame(() => positionMenu(event.originalEvent));
    };

    const queryOsm = async () => {
        if (!activePoint || osmButton?.disabled) return;
        const point = { ...activePoint };
        const token = ++requestToken;
        osmController?.abort();
        const controller = new AbortController();
        osmController = controller;
        osmButton.disabled = true;
        osmButton.classList.add('opacity-60', 'cursor-wait');
        osmButton.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-1"></i>Querying OSM…';
        setStatus(osmStatus, 'Querying nearby OpenStreetMap elements…');
        try {
            const response = await fetchImpl('/api/osm/query-point', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    latitude: point.lat,
                    longitude: point.lng,
                    radius_m: 25
                }),
                signal: controller.signal
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || `OSM query failed (${response.status}).`);
            if (token !== requestToken || !activePoint) return;
            renderOsm(data);
            onOsmResults?.(data, point);
        } catch (error) {
            if (error.name === 'AbortError') return;
            if (token !== requestToken) return;
            setStatus(osmStatus, error.message || 'OSM point query failed.', true);
            showToast?.(error.message || 'OSM point query failed.', true);
        } finally {
            if (osmController === controller) {
                osmController = null;
                resetOsmButton();
            }
        }
    };

    const onKeydown = event => {
        if (event.key === 'Escape' && !menu.classList.contains('hidden')) close();
    };
    const stopMenuEvent = event => event.stopPropagation();

    menu.addEventListener('contextmenu', event => {
        event.preventDefault();
        event.stopPropagation();
    });
    menu.addEventListener('click', stopMenuEvent);
    menu.addEventListener('mousedown', stopMenuEvent);
    copyButton?.addEventListener('click', async () => {
        if (!activePoint) return;
        const text = `${formatContextCoordinate(activePoint.lat)}, ${formatContextCoordinate(activePoint.lng)}`;
        try {
            await copyText(text);
            showToast?.('Coordinates copied to clipboard.');
        } catch (error) {
            showToast?.(error.message || 'Could not copy coordinates.', true);
        }
    });
    osmButton?.addEventListener('click', queryOsm);
    document.addEventListener('keydown', onKeydown);
    map.on('contextmenu', open);
    map.on('click', close);
    map.on('movestart zoomstart', close);

    return { open, close, destroy: () => {
        close();
        document.removeEventListener('keydown', onKeydown);
        map.off('contextmenu', open);
        map.off('click', close);
        map.off('movestart zoomstart', close);
    }};
};
