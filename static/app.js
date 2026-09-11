// ==========================================
// 1. INITIALIZATION & IMPORTS
// ==========================================

import { AppState } from './state.js';
import { renderAddedLayers } from './uiRenderer.js';
import { 
    map, drawLayerGroup, previewRenderer, createCustomGeoJSONLayer, 
    removePane, clearAllPreviews, darkenHex, hexAlpha, interpolateColor,
    createGeoJsonStyleFunction, createGeoJsonPointToLayer, attachPopupsToFeatures,
    getMapLibreMap, getRoadLayerIds, ensureRouteRoadQueryReady,
    getInteractiveFeatureLayerIds
} from './mapEngine.js';
import { saveLayerToCache, deleteCachedLayer, getCachedLayers } from './db.js';
import { executeActionPlan } from './headlessExecutor.js';
import * as headlessApi from './headlessApi.js';
import { sortFeatures, featuresToCsv, bakeFeatureCoordinates } from './tableUtils.js';
import { createTablePanelController } from './tablePanel.js';
import { createAttributeTableController } from './attributeTable.js';
import { createStyleEditorController } from './styleEditor.js';
import {
    combineRoadFeatureFragments,
    featureForRenderedSelection,
    roadStableIdentifiers,
    roadStableIdentifier,
    stableIdentifierValues
} from './roadSelection.js';
import { groupFeatureFragments } from './featureSelection.js';
import {
    createMapContextMenuController,
    taggedOsmElements,
    osmIdentityTags,
    administrativeAreaToOsmElement
} from './mapContextMenu.js';
import { parsePgwText, pgwToEpsg3857Bounds } from './geoReferencedRaster.js';


// uiRenderer emits semantic actions and does not import this module. This
// removes the renderer/application circular dependency while keeping map
// behavior centralized here.
const workspaceActionHandlers = {
    handleToggleTable: e => handleToggleTable(e),
    handleToggleEdit: e => handleToggleEdit(e),
    handleToggleSplit: e => handleToggleSplit(e),
    handleToggleCrop: e => handleToggleCrop(e),
    handleDuplicate: e => handleDuplicate(e),
    handleExport: e => handleExport(e),
    handleExportFolder: e => handleExportFolder(e),
    handleRemove: e => handleRemove(e),
    handleToggleVisibility: e => handleToggleVisibility(e),
    handleSetRasterOpacity: e => handleSetRasterOpacity(e),
    handleToggleSolo: e => handleToggleSolo(e),
    handleZoomToLayer: e => handleZoomToLayer(e),
    autoSaveWorkspace: () => autoSaveWorkspace(),
    rebuildActiveLayersFromDOM: e => rebuildActiveLayersFromDOM(e),
    triggerAddedSearch: () => triggerAddedSearch(),
};

document.addEventListener('workspaceAction', event => {
    const detail = event.detail || {};
    const handler = workspaceActionHandlers[detail.name];
    if (handler) handler(detail.event);
});

export const syncLayerCache = async (layerKey) => {
    const layerObj = AppState.activeLayers.find(l => (l.uniqueKey || l.key) === layerKey);
    if (!layerObj) return;

    await saveLayerToCache({
        layerKey: layerObj.uniqueKey || layerObj.key,
        name: layerObj.displayName || layerObj.name,
        type: layerObj.layerType || layerObj.type,
        geoJsonData: layerObj.geoJsonData,
        style: layerObj.customStyle || layerObj.style,
        visible: layerObj.isVisible ?? layerObj.visible,
        lastUpdated: Date.now()
    });
};

export const removeLayerFromCache = async (layerKey) => {
    await deleteCachedLayer(layerKey);
};

const getEl = (id) => document.getElementById(id);

const tabBtnAvailable = getEl('tab-btn-available');
const tabBtnAdded = getEl('tab-btn-added');
const tabAvailable = getEl('tab-available');
const tabAdded = getEl('tab-added');
const btnAddBulk = getEl('btn-add');

const savedServersSelect = getEl('saved-servers-select');
const btnSaveServer = getEl('btn-save-server');

const searchContainer = getEl('search-container');
const layerSearch = getEl('layer-search');
const btnClearSearch = getEl('btn-clear-search');
const availableLayerList = getEl('available-layer-list');

const addedSearchContainer = getEl('added-search-container');
const addedLayerSearch = getEl('added-layer-search');
const btnClearAddedSearch = getEl('btn-clear-added-search');
const addedLayerList = getEl('added-layer-list');

const attributeTableContainer = getEl('attribute-table-container');
const mapStatusBar = getEl('map-status-bar');
const mapHoverContext = getEl('map-hover-context');
const mapCoordinateReadout = getEl('map-coordinate-readout');
const btnMapConsole = getEl('btn-map-console');
const btnMapWorkspace = getEl('btn-map-workspace');
const mapWorkspaceMenu = getEl('map-workspace-menu');

const defaultMapHoverContext = 'Move over the map or a control for context';
let activeUiHoverContext = '';
let lastMapHoverContext = defaultMapHoverContext;
let activeUiHoverElement = null;
let lastMapPointerEvent = null;

const formatMapCoordinate = value => {
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(6) : '—';
};

const updateMapCoordinateReadout = event => {
    if (event?.latlng) lastMapPointerEvent = event;
    const latlng = lastMapPointerEvent?.latlng;
    const zoom = Number(map?.getZoom?.());
    if (!mapCoordinateReadout) return;
    mapCoordinateReadout.textContent = `Lat ${latlng ? formatMapCoordinate(latlng.lat) : '—'} · Lon ${latlng ? formatMapCoordinate(latlng.lng) : '—'} · Zoom ${Number.isFinite(zoom) ? zoom.toFixed(2) : '—'}`;
};

const setMapHoverContext = text => {
    lastMapHoverContext = String(text || defaultMapHoverContext);
    if (!mapHoverContext || activeUiHoverContext) return;
    mapHoverContext.textContent = lastMapHoverContext;
};

const restoreMapHoverContext = () => {
    activeUiHoverContext = '';
    activeUiHoverElement = null;
    if (mapHoverContext) mapHoverContext.textContent = lastMapHoverContext;
};

const hoverContextSelector = '[data-hover-context]';
const hoverContextForElement = element => {
    if (!element) return '';
    return String(element.dataset?.hoverContext || '').trim();
};

const setUiHoverContext = element => {
    const text = hoverContextForElement(element);
    if (!text) return;
    activeUiHoverElement = element;
    activeUiHoverContext = text;
    if (mapHoverContext) mapHoverContext.textContent = text;
};

// This is intentionally delegated from document so it also covers layer
// controls rendered later by the Available and Added panels.
const handleUiHoverOver = event => {
    const target = event.target?.closest?.(hoverContextSelector);
    if (target) setUiHoverContext(target);
};

const handleUiHoverOut = event => {
    const target = event.target?.closest?.(hoverContextSelector);
    const relatedTarget = event.relatedTarget;
    if (!target || (relatedTarget && target.contains(relatedTarget))) return;
    const nextInteractive = relatedTarget?.closest?.(hoverContextSelector);
    if (nextInteractive) setUiHoverContext(nextInteractive);
    else restoreMapHoverContext();
};

document.addEventListener('mouseover', handleUiHoverOver);
document.addEventListener('mouseout', handleUiHoverOut);

const syncInteractiveHoverTitles = () => {
    document.querySelectorAll('button[data-hover-context], a[data-hover-context], select[data-hover-context], input[data-hover-context]')
        .forEach(element => {
            if (!element.getAttribute('title') && element.dataset.hoverContext) {
                element.setAttribute('title', element.dataset.hoverContext);
            }
        });
};

syncInteractiveHoverTitles();
new MutationObserver(syncInteractiveHoverTitles).observe(document.body, { childList: true, subtree: true });

map.on('mousemove', updateMapCoordinateReadout);
map.on('zoomend moveend', () => updateMapCoordinateReadout(lastMapPointerEvent));
updateMapCoordinateReadout();

const tablePanel = createTablePanelController({
    container: attributeTableContainer,
    updateStacking: () => updateStacking(),
    clearHighlight: () => {
        if (AppState.highlightLayer) {
            map.removeLayer(AppState.highlightLayer);
            AppState.highlightLayer = null;
        }
    },
    renderLayers: () => AppState.activeLayers.length > 0 && renderAddedLayers()
});
const editPanelContainer = getEl('edit-panel-container');
const splitPanelContainer = getEl('split-panel-container');
const cropPanelContainer = getEl('crop-panel-container');

const filterType = getEl('filter-type');
const filterRadius = getEl('filter-radius');
const btnDraw = getEl('btn-draw');
const btnApplyFilter = getEl('btn-apply-filter');
const drawStatus = getEl('draw-status');
const filterDataContainer = getEl('filter-data-container');
const filterDataCol = getEl('filter-data-col');
const filterDataValues = getEl('filter-data-values');
const filterDataSearch = getEl('filter-data-search');
const btnClearFilterSearch = getEl('btn-clear-filter-search');

const osmInspectContainer = getEl('osm-inspect-container');
const osmInspectResults = getEl('osm-inspect-results');
const btnCloseInspect = getEl('btn-close-inspect');
const osmInspectStatus = getEl('osm-inspect-status');
const headlessPrompt = getEl('headless-prompt');
const headlessMode = getEl('headless-mode');
const headlessSourceCatalog = getEl('headless-source-catalog');
const headlessSourceOsm = getEl('headless-source-osm');
const headlessPromptLabel = getEl('headless-prompt-label');
const headlessOriginalRequest = getEl('headless-original-request');
const headlessClarification = getEl('headless-clarification');
const headlessResults = getEl('headless-results');
const headlessStatus = getEl('headless-status');
const headlessProgress = getEl('headless-progress');
const headlessSessionList = getEl('headless-session-list');
const btnHeadlessPlan = getEl('btn-headless-plan');
const btnHeadlessRun = getEl('btn-headless-run');
const btnHeadlessNewChat = getEl('btn-headless-new-chat');
const btnHeadlessRefresh = getEl('btn-headless-refresh');
const headlessChatLog = getEl('headless-chat-log');
const btnCommandPalette = getEl('btn-command-palette');
const commandPalette = getEl('command-palette');
const btnCommandPaletteClose = getEl('btn-command-palette-close');
const commandPaletteSearch = getEl('command-palette-search');
const commandPaletteResults = getEl('command-palette-results');

// Headless responses can contain names and text supplied by remote catalogs or
// by the user. Escape values before placing them in the small HTML templates
// below; GIS metadata must remain data, not executable markup.
function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
}

const commonOsmTags = {
  'boundary': ['administrative', 'aboriginal_lands', 'postal_code', 'protected_area', 'national_park', 'census', 'maritime'],
  'admin_level': ['2', '4', '6', '8', '9', '10'],
  'amenity': ['restaurant', 'cafe', 'fast_food', 'pub', 'bar', 'bank', 'pharmacy', 'hospital', 'school', 'parking', 'fuel', 'place_of_worship', 'post_office', 'library', 'cinema', 'police', 'fire_station'],
  'highway': ['residential', 'service', 'track', 'unclassified', 'footway', 'path', 'cycleway', 'bus_stop', 'traffic_signals', 'street_lamp', 'motorway', 'primary', 'secondary', 'tertiary'],
  'building': ['yes', 'residential', 'house', 'apartments', 'commercial', 'industrial', 'retail', 'detached', 'garage', 'roof', 'warehouse'],
  'landuse': ['residential', 'commercial', 'industrial', 'grass', 'forest', 'farmland', 'meadow', 'basin', 'military', 'recreation_ground', 'quarry'],
  'leisure': ['park', 'pitch', 'playground', 'sports_centre', 'fitness_centre', 'garden', 'swimming_pool', 'golf_course', 'stadium', 'nature_reserve'],
  'place': ['country', 'state', 'county', 'city', 'town', 'suburb', 'neighbourhood', 'district', 'village', 'hamlet', 'island', 'locality'],
  'natural': ['tree', 'water', 'wood', 'wetland', 'peak', 'beach', 'scrub', 'grassland', 'cliff', 'coastline', 'glacier'],
  'waterway': ['river', 'stream', 'canal', 'drain', 'ditch', 'waterfall', 'weir', 'riverbank'],
  'aeroway': ['aerodrome', 'runway', 'taxiway', 'helipad', 'apron', 'terminal', 'gate'],
  'power': ['line', 'substation', 'tower', 'pole', 'generator', 'transformer', 'minor_line'],
  'man_made': ['pier', 'tower', 'pipeline', 'storage_tank', 'water_tower', 'silo', 'bridge', 'surveillance', 'works'],
  'route': ['bus', 'railway', 'hiking', 'bicycle', 'subway', 'tram', 'ferry', 'detour'],
  'barrier': ['fence', 'wall', 'gate', 'hedge', 'retaining_wall', 'bollard', 'handrail'],
  'shop': ['supermarket', 'convenience', 'clothes', 'hairdresser', 'bakery', 'car', 'beauty', 'pharmacy', 'florist', 'electronics', 'hardware'],
  'tourism': ['hotel', 'information', 'artwork', 'attraction', 'viewpoint', 'museum', 'guest_house', 'camp_site', 'motel', 'alpine_hut'],
  'historic': ['memorial', 'monument', 'archaeological_site', 'castle', 'ruins', 'heritage', 'wayside_cross', 'fort'],
  'railway': ['station', 'subway', 'tram', 'level_crossing', 'buffer_stop', 'rail', 'switch', 'platform'],
  'office': ['company', 'government', 'estate_agent', 'lawyer', 'tech', 'insurance', 'educational_institution'],
  'emergency': ['fire_hydrant', 'defibrillator', 'ambulance_station', 'phone', 'fire_station']
};

const headlessState = {
    activeSessionId: sessionStorage.getItem('guidedAssistantSessionId') || null,
    pollTimer: null,
    lastTargetHints: [],
    pendingPlan: null,
    approvedTargetKey: null,
    conversation: [],
    chatGeneration: 0,
    assistantPhase: 'ready',
    assistantOriginalRequest: null,
    assistantClarification: null,
    assistantResultCards: [],
};

function recordHeadlessMessage(role, content) {
    const text = String(content || '').trim();
    if (!text) return;
    headlessState.conversation.push({ role, content: text });
    // Keep the hosted planner context compact while retaining recent
    // refinements and the current request.
    if (headlessState.conversation.length > 12) {
        headlessState.conversation = headlessState.conversation.slice(-12);
    }
}

function startNewHeadlessChat() {
    const keepOsmSource = Boolean(headlessSourceOsm?.checked);
    headlessState.chatGeneration += 1;
    headlessState.activeSessionId = null;
    sessionStorage.removeItem('guidedAssistantSessionId');
    headlessState.pendingPlan = null;
    headlessState.approvedTargetKey = null;
    headlessState.lastTargetHints = [];
    headlessState.conversation = [];
    headlessState.assistantPhase = 'ready';
    headlessState.assistantOriginalRequest = null;
    headlessState.assistantClarification = null;
    headlessState.assistantResultCards = [];
    clearHeadlessConfirmControls();
    if (headlessPrompt) headlessPrompt.value = '';
    if (headlessSourceCatalog) headlessSourceCatalog.checked = !keepOsmSource;
    if (headlessSourceOsm) headlessSourceOsm.checked = keepOsmSource;
    if (headlessChatLog) headlessChatLog.innerHTML = '';
    if (headlessProgress) {
        headlessProgress.innerHTML = '';
        headlessProgress.classList.add('hidden');
    }
    const badges = document.getElementById('headless-target-badges');
    if (badges) badges.innerHTML = '';
    headlessOriginalRequest?.classList.add('hidden');
    headlessOriginalRequest && (headlessOriginalRequest.innerHTML = '');
    headlessClarification?.classList.add('hidden');
    headlessClarification && (headlessClarification.innerHTML = '');
    headlessResults?.classList.add('hidden');
    headlessResults && (headlessResults.innerHTML = '');
    if (headlessPromptLabel) headlessPromptLabel.textContent = 'What data are you looking for?';
    if (btnHeadlessRun) btnHeadlessRun.textContent = 'Find data';
    if (headlessStatus) headlessStatus.textContent = 'New chat started. Describe what you want to do.';
    headlessPrompt?.focus();
}

function selectedAssistantSources() {
    const catalog = headlessSourceCatalog ? headlessSourceCatalog.checked : true;
    const osm = headlessSourceOsm ? headlessSourceOsm.checked : false;
    return { catalog, osm };
}

function enforceAssistantProviderChoice(changed) {
    if (!headlessSourceCatalog || !headlessSourceOsm) return;
    if (changed === headlessSourceCatalog && headlessSourceCatalog.checked) headlessSourceOsm.checked = false;
    if (changed === headlessSourceOsm && headlessSourceOsm.checked) headlessSourceCatalog.checked = false;
    // Keep exactly one provider active so the request cannot become
    // ambiguous between catalog search and an OSM interpretation.
    if (!headlessSourceCatalog.checked && !headlessSourceOsm.checked) {
        changed.checked = true;
    }
}

function appendHeadlessChat(role, text) {
    if (!headlessChatLog) return;
    const row = document.createElement('div');
    const isUser = role === 'user';
    row.className = `rounded px-2 py-1 border ${isUser ? 'bg-blue-50 dark:bg-blue-900/30 border-blue-200 dark:border-blue-800 text-blue-950 dark:text-blue-100' : 'bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200'}`;
    row.innerHTML = `<div class="font-bold uppercase tracking-wide text-[9px] mb-0.5 ${isUser ? 'text-blue-700 dark:text-blue-300' : 'text-gray-500 dark:text-gray-400'}">${isUser ? 'You' : 'Agent'}</div><div class="whitespace-pre-wrap break-words">${escapeHtml(text || '')}</div>`;
    headlessChatLog.appendChild(row);
    headlessChatLog.scrollTop = headlessChatLog.scrollHeight;
}

function focusWorkspaceLayerByKey(key) {
    const target = AppState.activeLayers.find(l => l.uniqueKey === key);
    if (!target) return showToast('Layer is no longer available.', true);
    switchTab('added');
    requestAnimationFrame(() => {
        const el = document.querySelector(`[data-key="${key}"]`);
        if (el) {
            el.scrollIntoView({ block: 'center', behavior: 'smooth' });
            el.classList.add('ring-2', 'ring-blue-500', 'ring-offset-1', 'dark:ring-offset-gray-800');
            setTimeout(() => el.classList.remove('ring-2', 'ring-blue-500', 'ring-offset-1', 'dark:ring-offset-gray-800'), 1200);
        }
    });
}

function openLayerContext(target, action = 'zoom') {
    if (!target) return;
    focusWorkspaceLayerByKey(target.uniqueKey);
    if (action === 'zoom') handleZoomToLayer(target.uniqueKey);
    else if (action === 'table') handleToggleTable(target.uniqueKey);
    else if (action === 'edit') handleToggleEdit(target.uniqueKey);
    else if (action === 'crop') handleToggleCrop(target.uniqueKey);
    else if (action === 'split') handleToggleSplit(target.uniqueKey);
}

function renameLayerByKey(key) {
    const layer = AppState.activeLayers.find(l => l.uniqueKey === key);
    if (!layer) return showToast('Layer is no longer available.', true);
    const nextName = prompt('Rename layer to:', layer.displayName || '');
    if (!nextName || !nextName.trim()) return;
    layer.displayName = nextName.trim();
    renderAddedLayers();
    autoSaveWorkspace();
    appendHeadlessChat('assistant', `Renamed to ${layer.displayName}.`);
}

function moveLayerToFolderByKey(key) {
    const layer = AppState.activeLayers.find(l => l.uniqueKey === key);
    if (!layer) return showToast('Layer is no longer available.', true);
    const folders = AppState.activeLayers.filter(l => l.isFolder);
    if (folders.length === 0) return showToast('Create a folder first.', true);
    const choice = prompt(`Move "${layer.displayName}" to folder key:`, folders[0].uniqueKey);
    if (!choice) return;
    const folder = folders.find(f => f.uniqueKey === choice.trim());
    if (!folder) return showToast('Folder not found.', true);
    layer.parentId = folder.uniqueKey;
    renderAddedLayers();
    autoSaveWorkspace();
    appendHeadlessChat('assistant', `Moved ${layer.displayName} to ${folder.displayName}.`);
}

function renderTargetRefButton(target) {
    if (!target?.key) return '';
    const label = target.name || target.key;
    const action = target.action || 'zoom';
    return `<button type="button" data-headless-target-key="${escapeHtml(target.key)}" data-headless-target-action="${escapeHtml(action)}" class="inline-flex items-center gap-1 rounded-full border border-blue-200 dark:border-blue-800 bg-white/80 dark:bg-gray-800/80 px-2 py-0.5 text-[10px] text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-gray-700">${target.folder ? '<i class="fa-solid fa-folder"></i>' : '<i class="fa-solid fa-layer-group"></i>'}<span class="max-w-40 truncate">${escapeHtml(label)}</span></button>`;
}

function appendHeadlessCard(title, bodyLines, tone = 'neutral', options = {}) {
    if (!headlessChatLog) return;
    const palette = tone === 'error'
        ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-950 dark:text-red-100'
        : tone === 'warn'
            ? 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800 text-amber-950 dark:text-amber-100'
            : tone === 'success'
                ? 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800 text-emerald-950 dark:text-emerald-100'
                : 'bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200';
    const row = document.createElement('details');
    row.open = options.open ?? true;
    row.className = `rounded px-2 py-1 border ${palette}`;
    const targetHtml = Array.isArray(options.targets) && options.targets.length
        ? `<div class="flex flex-wrap gap-1 mt-1">${options.targets.map(t => renderTargetRefButton({ ...t, action: t.action || options.targetAction || 'zoom' })).join('')}</div>`
        : '';
    row.innerHTML = `
        <summary class="cursor-pointer list-none font-bold uppercase tracking-wide text-[9px] mb-1 ${tone === 'error' ? 'text-red-700 dark:text-red-300' : tone === 'warn' ? 'text-amber-700 dark:text-amber-300' : tone === 'success' ? 'text-emerald-700 dark:text-emerald-300' : 'text-gray-500 dark:text-gray-400'}">${title}</summary>
        <div class="space-y-0.5 text-[10px] leading-snug">
            ${(bodyLines || []).map(line => `<div class="whitespace-pre-wrap break-words">${escapeHtml(line)}</div>`).join('')}
            ${targetHtml}
        </div>
    `;
    row.querySelectorAll('[data-headless-target-key]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const key = e.currentTarget.getAttribute('data-headless-target-key');
            const action = e.currentTarget.getAttribute('data-headless-target-action') || 'zoom';
            const target = AppState.activeLayers.find(l => l.uniqueKey === key);
            if (!target) return;
            openLayerContext(target, action);
        });
    });
    headlessChatLog.appendChild(row);
    headlessChatLog.scrollTop = headlessChatLog.scrollHeight;
}

function buildCommandPaletteItems(query = '') {
    const q = query.trim().toLowerCase();
    const items = [];
    const push = (label, description, run, key) => items.push({ label, description, run, key });
    const pushLayerAction = (layer, label, description, run) => {
        if (!layer || !layer.uniqueKey) return;
        const labelText = `${label}: ${layer.displayName || layer.uniqueKey}`;
        const haystack = `${labelText} ${description} ${layer.uniqueKey}`.toLowerCase();
        if (q && !haystack.includes(q)) return;
        push(labelText, description, run, `${labelText}-${layer.uniqueKey}`);
    };

    const searchCommands = [
        {
            label: 'Search: ArcGIS / ESRI',
            description: 'Switch to ArcGIS/REST and fetch portal layers from the URL field',
            run: () => {
                const type = getEl('server-type');
                const url = getEl('server-url');
                if (type) type.value = 'ARCGIS';
                type?.dispatchEvent(new Event('change'));
                url?.focus();
            },
            key: 'search-esri',
        },
        {
            label: 'Search: CKAN',
            description: 'Switch to CKAN and fetch datasets from the URL field',
            run: () => {
                const type = getEl('server-type');
                const url = getEl('server-url');
                if (type) type.value = 'CKAN';
                type?.dispatchEvent(new Event('change'));
                url?.focus();
            },
            key: 'search-ckan',
        },
        {
            label: 'Search: OSM / Overpass',
            description: 'Switch to Overpass and build a tag-based search',
            run: () => {
                const type = getEl('server-type');
                const builder = getEl('overpass-builder');
                if (type) type.value = 'OVERPASS';
                type?.dispatchEvent(new Event('change'));
                builder?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                getEl('osm-location')?.focus();
            },
            key: 'search-osm',
        },
    ];

    const sections = [];
    const addSection = (title, commandItems) => {
        const filtered = q
            ? commandItems.filter(item => `${item.label} ${item.description}`.toLowerCase().includes(q))
            : commandItems;
        if (filtered.length) sections.push({ title, items: filtered });
    };

    push('Command: Find data', 'Run the guided data-discovery assistant', () => {
        runGuidedAssistantTurn().catch(err => showToast(err.message || 'Failed to search for data.', true));
    }, 'run-prompt');
    push('Command: Refresh sessions', 'Reload recent headless sessions', () => {
        refreshHeadlessSessions().catch(err => showToast(err.message || 'Failed to load sessions.', true));
    }, 'refresh-sessions');
    push('Command: Open palette', 'Open this command palette', () => openCommandPalette(), 'open-palette');

    push('Workspace: Export JSON', 'Download the current workspace state', () => getEl('btn-export-workspace')?.click(), 'export-workspace');
    push('Workspace: Import JSON', 'Import a workspace file', () => getEl('file-import-workspace')?.click(), 'import-workspace');
    push('Workspace: Clear', 'Reset the workspace', () => getEl('btn-clear-workspace')?.click(), 'clear-workspace');
    push('Workspace: Create folder', 'Make a new folder in Added layers', () => getEl('btn-create-folder')?.click(), 'create-folder');
    push('Workspace: Sessions', 'Refresh recent headless sessions', () => refreshHeadlessSessions().catch(err => showToast(err.message || 'Failed to load sessions.', true)), 'sessions');

    addSection('Search', searchCommands);

    push('Target: Zoom active', 'Jump to the last selected layer or prompt target', () => {
        const key = headlessState.approvedTargetKey || headlessState.lastTargetHints?.[0]?.key;
        const target = AppState.activeLayers.find(l => l.uniqueKey === key);
        if (target) openLayerContext(target, 'zoom');
    }, 'zoom-target');
    push('Target: Open table', 'Show attributes for the current target', () => {
        const key = headlessState.approvedTargetKey || headlessState.lastTargetHints?.[0]?.key;
        const target = AppState.activeLayers.find(l => l.uniqueKey === key);
        if (target) openLayerContext(target, 'table');
    }, 'table-target');
    push('Target: Edit style', 'Open style editor for current target', () => {
        const key = headlessState.approvedTargetKey || headlessState.lastTargetHints?.[0]?.key;
        const target = AppState.activeLayers.find(l => l.uniqueKey === key);
        if (target) openLayerContext(target, 'edit');
    }, 'edit-target');
    AppState.activeLayers.slice(0, 40).forEach(layer => {
        if (!layer || !layer.uniqueKey) return;
        pushLayerAction(layer, 'Layer', layer.isFolder ? 'Open folder and focus it' : 'Jump to this layer', () => openLayerContext(layer, 'zoom'));
        if (!layer.isFolder) {
            pushLayerAction(layer, 'Layer action', 'Open attribute table', () => openLayerContext(layer, 'table'));
            pushLayerAction(layer, 'Layer action', 'Open style editor', () => openLayerContext(layer, 'edit'));
            pushLayerAction(layer, 'Layer action', 'Open crop/filter panel', () => openLayerContext(layer, 'crop'));
            pushLayerAction(layer, 'Layer action', 'Open split panel', () => openLayerContext(layer, 'split'));
            pushLayerAction(layer, 'Layer action', layer.isVisible ? 'Hide layer' : 'Show layer', () => {
                handleToggleVisibility({ currentTarget: { getAttribute: () => layer.uniqueKey } });
            });
            pushLayerAction(layer, 'Layer action', 'Duplicate layer', () => {
                handleDuplicate({ currentTarget: { getAttribute: () => layer.uniqueKey } });
            });
            pushLayerAction(layer, 'Layer action', 'Export layer', () => {
                handleExport({ currentTarget: { getAttribute: () => layer.uniqueKey } });
            });
            pushLayerAction(layer, 'Layer action', 'Rename layer', () => renameLayerByKey(layer.uniqueKey));
            pushLayerAction(layer, 'Layer action', 'Move to folder', () => moveLayerToFolderByKey(layer.uniqueKey));
        } else {
            pushLayerAction(layer, 'Folder action', 'Export folder as ZIP', () => {
                handleExportFolder({ currentTarget: { getAttribute: () => layer.uniqueKey } });
            });
            pushLayerAction(layer, 'Folder action', 'Duplicate folder', () => {
                handleDuplicate({ currentTarget: { getAttribute: () => layer.uniqueKey } });
            });
            pushLayerAction(layer, 'Folder action', 'Delete folder', () => {
                handleRemove({ currentTarget: { getAttribute: () => layer.uniqueKey } });
            });
        }
    });

    if (!sections.length && !q) {
        sections.push({ title: 'General', items });
    }
    if (!q) {
        return sections.flatMap(section => [
            { section: true, label: section.title, key: `section-${section.title}` },
            ...section.items,
        ]);
    }
    return [...searchCommands.filter(item => `${item.label} ${item.description}`.toLowerCase().includes(q)), ...items.filter(item => `${item.label} ${item.description}`.toLowerCase().includes(q))];
}

function renderCommandPalette(query = '') {
    if (!commandPaletteResults) return;
    const items = buildCommandPaletteItems(query);
    commandPaletteResults.innerHTML = items.length
        ? items.map(item => item.section
            ? `<div class="px-1 pt-2 pb-1 text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400">${item.label}</div>`
            : `
            <button type="button" data-command-key="${item.key}" class="w-full text-left px-3 py-2 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 hover:bg-blue-50 dark:hover:bg-gray-700 transition-colors">
                <div class="text-sm font-semibold text-gray-800 dark:text-gray-100">${item.label}</div>
                <div class="text-[10px] text-gray-500 dark:text-gray-400">${item.description}</div>
            </button>
        `).join('')
        : '<div class="text-sm text-gray-500 dark:text-gray-400 px-3 py-2">No matching commands.</div>';
    commandPaletteResults.querySelectorAll('[data-command-key]').forEach(btn => {
        btn.addEventListener('click', () => {
            const item = items.find(i => i.key === btn.getAttribute('data-command-key'));
            if (!item) return;
            item.run();
            closeCommandPalette();
        });
    });
}

function openCommandPalette() {
    if (!commandPalette) return;
    commandPalette.classList.remove('hidden');
    renderCommandPalette(commandPaletteSearch?.value || '');
    setTimeout(() => commandPaletteSearch?.focus(), 0);
}

function closeCommandPalette() {
    commandPalette?.classList.add('hidden');
}

function clearHeadlessConfirmControls() {
    document.querySelectorAll('[data-headless-confirm-bar="1"]').forEach(el => el.remove());
}

function renderConfirmationBar(plan) {
    clearHeadlessConfirmControls();
    if (!plan?.confirmations?.length && !plan?.clarification) return;
    const confirmationGeneration = headlessState.chatGeneration;
    const isCurrentChat = () => confirmationGeneration === headlessState.chatGeneration;
    const bar = document.createElement('div');
    bar.dataset.headlessConfirmBar = '1';
    bar.className = 'mt-2 rounded border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-2 space-y-2';
    const confirmText = plan.confirmations?.length ? `Needs confirmation: ${plan.confirmations.join(', ')}` : '';
    const clarifyText = plan.clarification ? `Needs clarification: ${plan.clarification}` : '';
    bar.innerHTML = `
        <div class="text-[10px] text-amber-900 dark:text-amber-200 font-semibold">${[confirmText, clarifyText].filter(Boolean).join(' | ')}</div>
        <div class="flex gap-1.5">
            <button type="button" id="btn-headless-approve" class="flex-1 bg-amber-600 hover:bg-amber-700 text-white text-xs py-1 rounded font-semibold">Approve</button>
            <button type="button" id="btn-headless-reject" class="flex-1 bg-white hover:bg-amber-50 dark:bg-gray-800 dark:hover:bg-gray-700 text-amber-800 dark:text-amber-200 border border-amber-300 dark:border-amber-700 text-xs py-1 rounded font-semibold">Reject</button>
        </div>
    `;
    headlessChatLog?.prepend(bar);
    getEl('btn-headless-approve')?.addEventListener('click', async () => {
        if (!isCurrentChat() || !headlessState.pendingPlan) return;
        headlessState.approvedTargetKey = headlessState.pendingPlan.selectedTarget?.key || null;
        appendHeadlessCard('Approval', ['Approved. Executing the planned actions.'], 'success', { targets: headlessState.pendingPlan?.targets || [], targetAction: 'zoom' });
        clearHeadlessConfirmControls();
        const plan = headlessState.pendingPlan;
        headlessState.pendingPlan = null;
        await executeActionPlan(plan, { confirmed: true }, {
            applyUpdates: data => { if (isCurrentChat()) applyHeadlessWorkspaceUpdates(data); },
            card: (...args) => { if (isCurrentChat()) appendHeadlessCard(...args); },
            onResult: data => { if (isCurrentChat()) updateHeadlessResult(data); }
        });
    });
    getEl('btn-headless-reject')?.addEventListener('click', () => {
        appendHeadlessCard('Rejected', ['No actions were executed.'], 'warn', { targets: headlessState.pendingPlan?.targets || [], targetAction: 'zoom' });
        headlessState.pendingPlan = null;
        clearHeadlessConfirmControls();
    });
}

function syncHeadlessChatPlan(plan) {
    if (!plan) return;
    headlessState.pendingPlan = plan;
    if (plan.selectedTarget?.key) headlessState.approvedTargetKey = plan.selectedTarget.key;
    const lines = [];
    if (plan.planner) lines.push(`Planner: ${describeHeadlessPlanner(plan.planner)}`);
    if (plan.selectedTarget?.name) lines.push(`Target: ${plan.selectedTarget.name}`);
    if (plan.summary?.length) lines.push(...plan.summary.map(s => `• ${s}`));
    if (plan.confirmations?.length) lines.push(`Confirmation needed for: ${plan.confirmations.join(', ')}`);
    if (plan.clarification) lines.push(`Clarification needed: ${plan.clarification}`);
    if (plan.why?.length) lines.push(`Why: ${plan.why.join(' | ')}`);
    appendHeadlessCard('Plan', lines.length ? lines : ['No actions planned.'], plan.clarification ? 'warn' : (plan.confirmations?.length ? 'warn' : 'neutral'), { targets: plan.targets || [], targetAction: 'zoom' });
}

function describeHeadlessPlanner(planner) {
    const mode = planner?.mode || 'local';
    if (mode === 'hosted' || mode === 'hosted-cache') {
        return mode === 'hosted-cache'
            ? `Hosted LLM (${planner.model || 'configured model'}, cached plan)`
            : `Hosted LLM (${planner.model || 'configured model'})`;
    }
    if (mode === 'hosted-fallback-local') return 'Local parser (hosted assistance unavailable)';
    if (mode === 'hosted-circuit-open') return 'Local parser (hosted assistance temporarily paused)';
    if (mode === 'local-no-key') return 'Local parser (no hosted key configured)';
    return 'Local parser';
}

function buildHeadlessWorkspaceContext() {
    const workspace = serializeWorkspace ? serializeWorkspace() : null;
    if (!workspace) return null;
    const bounds = map?.getBounds?.();
    const catalogSearchResults = (AppState.fetchedLayers || []).slice(0, 5).map(layer => ({
        title: layer.title || layer.displayName || layer.name,
        name: layer.title || layer.displayName || layer.name,
        provider: layer.provider || layer.source,
        protocol: layer.protocol,
        format: layer.format,
        bbox: layer.bbox,
        fields: layer.fields || layer.fieldNames,
        validation: layer.validation || layer.validationStatus,
        provenanceUrl: layer.provenanceUrl || layer.sourceUrl || layer.url,
    }));
    return {
        ...workspace,
        mapBounds: bounds?.isValid?.() ? {
            south: bounds.getSouth(), west: bounds.getWest(),
            north: bounds.getNorth(), east: bounds.getEast()
        } : null,
        preferredTargetKey: headlessState.approvedTargetKey || headlessState.lastTargetHints?.[0]?.key || null,
        activeCropLayerKey: AppState.activeCropLayerKey || null,
        activeEditLayerKey: AppState.activeEditLayerKey || null,
        activeSplitLayerKey: AppState.activeSplitLayerKey || null,
        activeTableLayerKey: AppState.activeTableLayerKey || null,
        catalogSearchResults,
    };
}

function describeHeadlessAction(action) {
    const type = action?.type || 'action';
    const input = action?.input || {};
    if (type === 'osm_search') {
        const tag = (input.tags || []).find(item => item?.key);
        const feature = tag ? `${tag.key}${tag.val ? ` = ${tag.val.replaceAll('_', ' ')}` : ''}` : 'the requested map features';
        const distanceKm = Number(input.distance_km);
        const distance = Number.isFinite(distanceKm) && distanceKm > 0
            ? distanceKm < 1 ? `${Math.round(distanceKm * 1000)} m` : `${distanceKm.toFixed(2).replace(/\.?0+$/, '')} km`
            : '';
        const relation = input.relation || (input.street ? 'on' : input.near_place ? 'near' : '');
        const reference = input.street || input.near_place;
        if (input.featName && input.geomType === 'lines_polygons' && !reference) {
            const location = input.loc || (input.mapBounds ? 'the current map view' : 'the requested area');
            return `Search OpenStreetMap for the road named ${input.featName}${location ? ` in ${location}` : ''}`;
        }
        if (reference) {
            const place = `${reference}${input.loc ? `, ${input.loc}` : ''}`;
            if (relation === 'within' && distance) {
                return `Search OpenStreetMap for ${feature} within ${distance} of ${place}`;
            }
            const relationText = relation === 'along' || relation === 'beside' ? relation : relation === 'on' ? 'on' : 'near';
            return `Search OpenStreetMap for ${feature} ${relationText} ${place}${distance ? ` (within ${distance})` : ''}`;
        }
        const place = input.loc || (input.mapBounds ? 'the current map view' : 'the requested area');
        return `Search OpenStreetMap for ${feature} in ${place}`;
    }
    if (type === 'search_layers') return `Search available GIS layers for “${input.query || 'the requested topic'}”`;
    if (type === 'zoom_to_location') return `Find and zoom to ${input.location || 'the requested location'}`;
    if (type === 'filter_layers') return 'Filter the selected layer';
    return type.replaceAll('_', ' ');
}

function serializeActiveWorkspace() {
    return {
        activeLayers: JSON.parse(JSON.stringify(AppState.activeLayers || [])),
        currentServerUrl: AppState.currentServerUrl || '',
        currentServerType: AppState.currentServerType || '',
        activeTableLayerKey: AppState.activeTableLayerKey || null,
        activeEditLayerKey: AppState.activeEditLayerKey || null,
        activeSplitLayerKey: AppState.activeSplitLayerKey || null,
        activeCropLayerKey: AppState.activeCropLayerKey || null,
    };
}

function focusHeadlessTarget(layerKey, isFolder = false) {
    if (!layerKey) return;
    const layer = AppState.activeLayers.find(l => l.uniqueKey === layerKey);
    if (!layer) return showToast("Resolved target is no longer in the workspace.", true);

    switchTab('added');
    if (isFolder) {
        layer.isExpanded = true;
        renderAddedLayers();
    } else {
        handleZoomToLayer({ currentTarget: { getAttribute: () => layerKey } });
        handleToggleTable(layerKey);
    }

    requestAnimationFrame(() => {
        const item = document.querySelector(`[data-key="${layerKey}"]`);
        if (!item) return;
        item.scrollIntoView({ block: 'center', behavior: 'smooth' });
        item.classList.add('ring-2', 'ring-blue-500', 'ring-offset-1', 'dark:ring-offset-gray-800');
        setTimeout(() => item.classList.remove('ring-2', 'ring-blue-500', 'ring-offset-1', 'dark:ring-offset-gray-800'), 1200);
    });
}

async function pollHeadlessSession(sessionId, onUpdate) {
    if (!sessionId) return;
    try {
        const data = await headlessApi.getSession(sessionId);
        if (onUpdate) onUpdate(data);
        return data;
    } catch (err) {
        console.warn('Headless polling failed:', err);
        return null;
    }
}

async function createHeadlessSession(prompt, runImmediately = true) {
    const workspace = buildHeadlessWorkspaceContext();
    const data = await headlessApi.createSession(prompt, workspace, runImmediately, headlessMode?.value || 'auto', headlessState.conversation);
    headlessState.activeSessionId = data.id;
    return data;
}

async function planHeadlessPrompt(prompt) {
    const workspace = buildHeadlessWorkspaceContext();
    return headlessApi.planPrompt(prompt, workspace, headlessMode?.value || 'auto', headlessState.conversation);
}

function guidedExternalUrl(value) {
    const url = String(value || '').trim();
    return /^https?:\/\//i.test(url) ? url : '';
}

function renderGuidedAssistantResults(response) {
    const results = response?.results || {};
    const groups = [
        ['catalog', 'Configured GIS catalog'],
        ['osm', 'OpenStreetMap'],
        ['web', 'Public GIS sources'],
    ];
    const availableLayers = [];
    groups.forEach(([provider, label]) => {
        (results[provider] || []).forEach(result => {
            const layer = assistantResultLayer(result, provider);
            if (layer) availableLayers.push({ provider, result, layer, label });
        });
    });
    const currentLayers = AppState.fetchedLayers || [];
    const existingKeys = new Set(currentLayers.map(layer => layer.catalogId).filter(Boolean));
    const newLayers = [];
    availableLayers.forEach(({ provider, result, layer }) => {
        const key = result?.id || result?.resourceUrl || result?.url || `${provider}:${layer.title}`;
        if (existingKeys.has(key)) return;
        existingKeys.add(key);
        layer.catalogId = key;
        newLayers.push(layer);
    });
    if (newLayers.length) {
        AppState.fetchedLayers = [...newLayers, ...currentLayers];
        if (layerSearch) layerSearch.value = '';
        renderAvailableLayers();
        switchTab('available');
        showToast(`${newLayers.length} search result${newLayers.length === 1 ? '' : 's'} added to Available layers.`);
    }
    if (headlessResults) {
        headlessResults.classList.add('hidden');
        headlessResults.innerHTML = '';
    }
}

function assistantResultLayer(result, provider) {
    const title = String(result?.title || result?.name || result?.displayName || 'Catalog result').trim();
    if (provider === 'osm' && (result.geojson || result.geoJsonData)) {
        const geoJsonData = result.geojson || result.geoJsonData;
        return {
            id: `assistant_osm_${Date.now()}`,
            title,
            geoJsonData,
            source: 'OpenStreetMap',
            provider: 'OpenStreetMap',
            protocol: 'Overpass API',
            provenanceUrl: result.provenance || result.provenance_url || 'https://www.openstreetmap.org/copyright',
            metadata: result.metadata || geoJsonData.metadata || {},
            validation: 'validated by provider response checks',
            featureCount: result.count ?? geoJsonData.features?.length ?? 0,
        };
    }

    const protocol = String(result?.protocol || result?.format || result?.type || '').toLowerCase();
    const isWfs = protocol === 'wfs';
    const isCkan = protocol === 'ckan' || String(result?.type || '').toLowerCase() === 'ckan';
    const isArcgis = ['arcgis', 'esri', 'featureserver', 'mapserver', 'arcgis_rest'].includes(protocol)
        || Boolean(result?.serverType || result?.layerId !== undefined);
    if (isCkan) {
        const resourceUrl = result.resourceUrl || result.url;
        if (!resourceUrl) return null;
        const format = String(result.format || 'geojson').toLowerCase();
        const ext = format.includes('shp') ? 'zip' : format.includes('geopackage') ? 'gpkg' : format.includes('kml') ? 'kml' : format.includes('csv') ? 'csv' : 'geojson';
        return {
            ...result,
            id: result.id || `assistant_ckan_${Date.now()}`,
            title,
            name: result.name || title,
            type: 'CKAN',
            catalogResult: true,
            resources: result.resources || [{ display: ext.toUpperCase(), ext, url: resourceUrl }],
            format: ext,
            url: resourceUrl,
        };
    }
    if (isWfs) {
        if (result.catalog_level && result.catalog_level !== 'layer') return null;
        const serviceUrl = result.serviceUrl || result.url;
        const layerName = result.layerName || result.name || result.id;
        if (!serviceUrl || !layerName) return null;
        return {
            ...result,
            id: result.id || `assistant_wfs_${Date.now()}`,
            title,
            type: 'WFS',
            serverType: 'WFS',
            catalogResult: true,
            layerName,
            serviceUrl,
            url: serviceUrl,
        };
    }
    if (isArcgis) {
        if (result.catalog_level && !['layer', 'dataset'].includes(result.catalog_level) && result.layerId === undefined) return null;
        const serviceUrl = result.serviceUrl || result.url;
        const layerUrl = result.layerUrl || result.url || serviceUrl;
        if (!layerUrl) return null;
        const serverType = result.serverType || (String(layerUrl).toLowerCase().includes('featureserver') ? 'FeatureServer' : 'MapServer');
        return {
            ...result,
            id: result.id || `assistant_arcgis_${Date.now()}`,
            title,
            type: 'ARCGIS',
            serverType,
            catalogResult: true,
            serviceUrl,
            url: layerUrl,
        };
    }
    return null;
}

function renderGuidedAssistantState(response) {
    const original = response?.originalRequest || headlessState.assistantOriginalRequest || '';
    headlessState.assistantOriginalRequest = original;
    headlessState.assistantClarification = response?.clarification || null;
    headlessState.activeSessionId = response?.sessionId || headlessState.activeSessionId;
    headlessState.assistantPhase = response?.state === 'clarification_required' ? 'clarifying' : response?.state === 'results' ? 'results' : 'error';

    if (response?.sources) {
        const catalogSelected = response.sources.catalog === true;
        const osmSelected = response.sources.osm === true && !catalogSelected;
        if (headlessSourceCatalog) headlessSourceCatalog.checked = catalogSelected || !osmSelected;
        if (headlessSourceOsm) headlessSourceOsm.checked = osmSelected;
    }

    if (headlessOriginalRequest) {
        headlessOriginalRequest.innerHTML = `<span class="font-semibold">Your Request:</span><div class="mt-0.5 whitespace-pre-wrap">${escapeHtml(original)}</div>`;
        headlessOriginalRequest.classList.toggle('hidden', !original);
    }
    if (headlessClarification) {
        const question = response?.clarification?.question;
        headlessClarification.innerHTML = question
            ? `<div class="font-semibold">Clarification needed</div><div class="mt-0.5">${escapeHtml(question)}</div><div class="mt-1 italic opacity-80">Answer in the box below. You do not need to repeat your original request.</div>`
            : '';
        headlessClarification.classList.toggle('hidden', !question);
    }
    if (headlessPromptLabel) {
        headlessPromptLabel.textContent = response?.state === 'clarification_required' ? 'Answer clarification' : 'What data are you looking for?';
    }
    if (btnHeadlessRun) {
        btnHeadlessRun.textContent = response?.state === 'clarification_required' ? 'Answer clarification' : 'Find data';
    }
    if (headlessStatus) {
        if (response?.state === 'clarification_required') {
            const count = Object.values(response.results || {}).reduce((total, items) => total + (items?.length || 0), 0);
            headlessStatus.textContent = count ? `Found ${count} preliminary result${count === 1 ? '' : 's'}; one clarification is needed for the remaining search.` : 'One clarification is needed before the search can continue.';
        } else if (response?.state === 'results') {
            const count = Object.values(response.results || {}).reduce((total, items) => total + (items?.length || 0), 0);
            const resolution = response?.interpretation?.boundaryResolution;
            const resolutionText = resolution?.resolved_boundary_name
                ? ` Resolved ${resolution.requested_place || 'the requested place'} to ${resolution.resolved_boundary_name}.`
                : '';
            headlessStatus.textContent = `Search complete. ${count} result${count === 1 ? '' : 's'} found; loadable results are in Available layers.${resolutionText}`;
        } else {
            headlessStatus.textContent = 'The assistant could not complete the search.';
        }
    }
    if (headlessProgress) {
        const providers = response?.plan?.providers || [];
        headlessProgress.innerHTML = providers.map(item => `<div class="text-[10px] bg-white/80 dark:bg-gray-800/60 border border-blue-100 dark:border-blue-800 rounded px-2 py-1"><span class="font-semibold text-blue-700 dark:text-blue-300">${escapeHtml(item.provider)}</span><span class="text-gray-600 dark:text-gray-400 ml-1">${escapeHtml(item.action || 'search')}</span></div>`).join('');
        headlessProgress.classList.toggle('hidden', !providers.length);
    }
    renderGuidedAssistantResults(response);
}

async function runGuidedAssistantTurn() {
    const answer = headlessPrompt?.value.trim() || '';
    const isClarification = headlessState.assistantPhase === 'clarifying' && headlessState.activeSessionId;
    const isRetry = headlessState.assistantPhase === 'error' && headlessState.activeSessionId && !answer;
    if (!answer && !isRetry) return showToast(isClarification ? 'Answer the clarification first.' : 'Describe the data you want to find.', true);
    const sources = selectedAssistantSources();
    if (!sources.catalog && !sources.osm) return showToast('Select GIS catalog or OpenStreetMap before searching.', true);
    const chatGeneration = headlessState.chatGeneration;
    const workspace = buildHeadlessWorkspaceContext();
    headlessState.assistantPhase = 'planning';
    if (headlessStatus) headlessStatus.textContent = isClarification ? 'Applying your clarification and searching...' : 'Interpreting the request and searching available sources...';
    const clarificationId = headlessState.assistantClarification?.id || null;
    const userMessage = answer || 'Retry search';
    appendHeadlessChat('user', userMessage);
    recordHeadlessMessage('user', userMessage);
    try {
        const payload = {
            workspace,
            sources,
        };
        if (isClarification) {
            payload.sessionId = headlessState.activeSessionId;
            payload.reply = { clarificationId, text: answer };
        } else if (isRetry) {
            payload.sessionId = headlessState.activeSessionId;
            payload.retry = true;
        } else {
            payload.request = answer;
            headlessState.assistantOriginalRequest = answer;
        }
        const response = await headlessApi.assistantTurn(payload);
        if (chatGeneration !== headlessState.chatGeneration) return;
        if (response?.sessionId) {
            headlessState.activeSessionId = response.sessionId;
            sessionStorage.setItem('guidedAssistantSessionId', response.sessionId);
        }
        renderGuidedAssistantState(response);
        if (headlessPrompt && !isRetry) headlessPrompt.value = '';
        const interpretation = response?.interpretation?.searchQuery || response?.originalRequest || 'the request';
        recordHeadlessMessage('assistant', response?.state === 'clarification_required'
            ? `${response.clarification?.question || 'Clarification needed'} Search context: ${interpretation}`
            : `Search complete for ${interpretation}.`);
    } catch (error) {
        if (chatGeneration !== headlessState.chatGeneration) return;
        headlessState.assistantPhase = 'error';
        if (headlessStatus) headlessStatus.textContent = `Search failed: ${error.message || error}`;
        appendHeadlessCard('Assistant error', [error.message || 'The guided search failed.', 'Your request is still available; you can retry.'], 'warn');
        showToast(error.message || 'Assistant search failed.', true);
    }
}

async function restoreGuidedAssistantSession() {
    if (!headlessState.activeSessionId) return;
    try {
        const session = await headlessApi.getSession(headlessState.activeSessionId);
        const response = session?.result;
        if (!response?.originalRequest) {
            sessionStorage.removeItem('guidedAssistantSessionId');
            headlessState.activeSessionId = null;
            return;
        }
        renderGuidedAssistantState(response);
        if (headlessStatus) headlessStatus.textContent = `${headlessStatus.textContent} Restored from the previous browser session.`;
    } catch (error) {
        console.warn('Guided assistant session could not be restored:', error);
        sessionStorage.removeItem('guidedAssistantSessionId');
        headlessState.activeSessionId = null;
    }
}

function applyHeadlessWorkspaceUpdates(sessionData) {
    const actions = sessionData?.result?.actions || sessionData?.actions || [];
    actions.forEach(action => {
        const output = action?.output || {};
        if (action?.type === 'zoom_to_location' && output.location) {
            const location = output.location;
            if (Array.isArray(location.boundingbox) && location.boundingbox.length === 4) {
                map.fitBounds([[location.boundingbox[0], location.boundingbox[2]], [location.boundingbox[1], location.boundingbox[3]]]);
            } else if (Number.isFinite(location.lat) && Number.isFinite(location.lon)) {
                map.setView([location.lat, location.lon], 13);
            }
            if (headlessStatus) headlessStatus.textContent = `Showing ${(location.display_name || location.location || 'that location').split(',')[0]}.`;
            return;
        }
        if (Array.isArray(output.layers)) {
            AppState.fetchedLayers = output.layers;
            if (typeof renderAvailableLayers === 'function') renderAvailableLayers();
            return;
        }
        const updates = action?.output?.workspace_updates || [];
        updates.forEach(update => {
            if (update.op === 'set_saved_servers') {
                console.info('Headless session loaded saved servers:', update.servers?.length || 0);
                return;
            }
            if (update.op === 'create_layer' && (update.geojson || update.feature_collection || Array.isArray(update.osm_elements))) {
                const layerName = update.name || 'Headless Layer';
                // Register the fetched result before attempting to preview it.
                // A preview is optional UI work; it must never hide a valid
                // result from the Available list.
                let geojson = update.geojson || update.feature_collection;
                if (Array.isArray(update.osm_elements) && typeof osmtogeojson === 'function') {
                    try {
                        // OSM imports use the same conversion path as the
                        // original manual OSM importer. Do not use the
                        // server-side convenience normalizer here: it can
                        // reinterpret closed ways/relations.
                        const converted = osmtogeojson({ version: 0.6, elements: update.osm_elements }, { flatProperties: true });
                        // Prefer the established OSM conversion, but keep the
                        // server's valid collection as a compatibility fallback
                        // for an older osmtogeojson build or unusual element.
                        if (converted?.features?.length) {
                            geojson = converted;
                            geojson.metadata = (update.geojson || update.feature_collection)?.metadata || {};
                        }
                    } catch (error) {
                        console.warn('OSM display conversion failed; using server GeoJSON:', error);
                    }
                }
                if (!geojson || geojson.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) {
                    throw new Error('The server returned a non-normalized GIS result.');
                }
                if (geojson.features.length === 0) {
                    throw new Error('The OSM search returned no mappable features.');
                }

                const availableId = `headless_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
                const fetchedLayer = {
                    id: availableId,
                    title: layerName,
                    geoJsonData: geojson,
                    source: 'OpenStreetMap',
                    provider: 'OpenStreetMap',
                    protocol: 'Overpass API',
                    provenanceUrl: update.metadata?.attribution_url || update.geojson?.metadata?.attribution_url || 'https://www.openstreetmap.org/copyright',
                    bbox: output.bbox || update.bbox,
                    metadata: update.metadata || update.geojson?.metadata || {},
                    validation: 'validated by Overpass and local schema checks',
                    featureCount: geojson.features.length,
                };
                AppState.fetchedLayers = [fetchedLayer, ...AppState.fetchedLayers];
                AppState.lastFetchedOsmGeoJson = geojson;
                AppState.lastFetchedOsmLayerName = layerName;
                // A previous catalog filter should not make a newly completed
                // OSM result appear to have vanished.
                if (layerSearch) layerSearch.value = '';
                try {
                    renderAvailableLayers?.();
                } catch (error) {
                    console.error('Available layer list could not be rendered:', error);
                    if (availableLayerList) availableLayerList.innerHTML = `<p class="text-xs text-gray-500 italic p-2">OSM result found (${geojson.features.length} features), but the list could not be refreshed.</p>`;
                }
                switchTab('available');

                // Keep the existing convenient map preview, but isolate it
                // from Available-list registration. This also preserves the
                // original OSM geometry because addLocalGeoJsonToMap receives
                // the converted result without repairing or rewriting it.
                try {
                    addLocalGeoJsonToMap(geojson, layerName);
                } catch (error) {
                    console.error('OSM preview could not be created:', error);
                    showToast(`Found ${geojson.features.length} OSM features; preview unavailable.`, true);
                } finally {
                    // addLocalGeoJsonToMap normally switches to Added. The
                    // fetched result belongs in Available until the user
                    // explicitly adds it, matching the manual OSM workflow.
                    switchTab('available');
                }
                return;
            }
            if (update.op === 'create_layer_copy' && update.layer) {
                const layer = update.layer;
                if (layer.isFolder) {
                    AppState.activeLayers = [layer, ...AppState.activeLayers];
                    renderAddedLayers();
                    autoSaveWorkspace();
                    return;
                }
                const paneName = 'pane-' + layer.uniqueKey;
                const newMapLayer = createCustomGeoJSONLayer(layer.geoJsonData, layer.customStyle || { type: 'single', fillColor: '#2563eb', fillOpacity: 0.5, color: '#2563eb', opacity: 1.0, pointShape: 'circle', pointSize: 8 }, paneName).addTo(map);
                if (!layer.isVisible) map.removeLayer(newMapLayer);
                AppState.activeLayers = [{ ...layer, mapLayer: newMapLayer }, ...AppState.activeLayers];
                renderAddedLayers();
                autoSaveWorkspace();
                return;
            }
            if (update.op === 'apply_style') {
                const target = AppState.activeLayers.find(l => l.uniqueKey === update.layerKey);
                if (target && update.style) {
                    target.customStyle = JSON.parse(JSON.stringify(update.style));
                    if (!target.isFolder && target.geoJsonData) {
                        const paneName = 'pane-' + target.uniqueKey;
                        if (target.mapLayer) map.removeLayer(target.mapLayer);
                        const newLayer = createCustomGeoJSONLayer(target.geoJsonData, target.customStyle, paneName);
                        if (target.isVisible) newLayer.addTo(map);
                        target.mapLayer = newLayer;
                    }
                    renderAddedLayers();
                    autoSaveWorkspace();
                }
                return;
            }
            if (update.op === 'create_folder') {
                const folderKey = 'folder_' + Math.random().toString(36).substr(2, 9);
                AppState.activeLayers = [{
                    isFolder: true,
                    uniqueKey: folderKey,
                    displayName: update.name || 'Headless Folder',
                    isVisible: true,
                    isExpanded: true,
                    parentId: null
                }, ...AppState.activeLayers];
                renderAddedLayers();
                return;
            }
            if (update.op === 'move_to_folder') {
                const target = AppState.activeLayers.find(l => l.uniqueKey === update.layerKey);
                if (target) {
                    target.parentId = update.parentId || null;
                    renderAddedLayers();
                    autoSaveWorkspace();
                }
                return;
            }
            if (update.op === 'rename_layer') {
                const target = AppState.activeLayers.find(l => l.uniqueKey === update.layerKey);
                if (target && update.name) {
                    target.displayName = update.name;
                    renderAddedLayers();
                    autoSaveWorkspace();
                }
                return;
            }
            if (update.op === 'select_layer') {
                const target = AppState.activeLayers.find(l => l.uniqueKey === update.layerKey);
                if (target) {
                    if (update.focus === 'table') handleToggleTable(target.uniqueKey);
                    else if (update.focus === 'crop') handleToggleCrop(target.uniqueKey);
                    else if (update.focus === 'split') handleToggleSplit(target.uniqueKey);
                    else if (update.focus === 'edit') handleToggleEdit(target.uniqueKey);
                }
                return;
            }
            if (update.op === 'zoom_to_layer') {
                const target = AppState.activeLayers.find(l => l.uniqueKey === update.layerKey);
                if (target) handleZoomToLayer(target.uniqueKey);
                return;
            }
            if (update.op === 'open_table') {
                const target = AppState.activeLayers.find(l => l.uniqueKey === update.layerKey);
                if (target) handleToggleTable(target.uniqueKey);
                return;
            }
            if (update.op === 'toggle_edit') {
                const target = AppState.activeLayers.find(l => l.uniqueKey === update.layerKey);
                if (target) handleToggleEdit(target.uniqueKey);
                return;
            }
            if (update.op === 'toggle_crop') {
                const target = AppState.activeLayers.find(l => l.uniqueKey === update.layerKey);
                if (target) handleToggleCrop(target.uniqueKey);
                return;
            }
            if (update.op === 'toggle_split') {
                const target = AppState.activeLayers.find(l => l.uniqueKey === update.layerKey);
                if (target) handleToggleSplit(target.uniqueKey);
                return;
            }
            if (update.op === 'set_visibility') {
                const target = AppState.activeLayers.find(l => l.uniqueKey === update.layerKey);
                if (target) {
                    target.isVisible = Boolean(update.visible);
                    if (!target.isFolder && target.mapLayer) {
                        if (target.isVisible) target.mapLayer.addTo(map);
                        else map.removeLayer(target.mapLayer);
                    }
                    renderAddedLayers();
                }
                return;
            }
            if (update.op === 'delete_layer') {
                const target = AppState.activeLayers.find(l => l.uniqueKey === update.layerKey);
                if (!target) return;
                if (!target.isFolder && target.mapLayer) map.removeLayer(target.mapLayer);
                removePane(target.uniqueKey);
                AppState.activeLayers = AppState.activeLayers.filter(l => l.uniqueKey !== update.layerKey);
                renderAddedLayers();
                autoSaveWorkspace();
                return;
            }
            if (update.op === 'export_workspace') {
                const workspace = update.workspace || serializeActiveWorkspace();
                const blob = new Blob([JSON.stringify(workspace, null, 2)], { type: 'application/json' });
                downloadBlob(blob, 'workspace.json');
                return;
            }
            if (update.op === 'export_layer') {
                const target = AppState.activeLayers.find(l => l.uniqueKey === update.layerKey);
                if (target) {
                    if (target.geoJsonData) {
                        const blob = new Blob([JSON.stringify(target.geoJsonData, null, 2)], { type: 'application/json' });
                        downloadBlob(blob, `${target.displayName || 'layer'}.geojson`);
                    } else if (target.exportUrl) {
                        window.open(`/proxy?url=${encodeURIComponent(target.exportUrl)}`, '_blank');
                    }
                }
                return;
            }
            if (update.op === 'search_layers' && Array.isArray(update.layers)) {
                AppState.fetchedLayers = update.layers;
                renderAvailableLayers?.();
                return;
            }
        });
    });
}

async function refreshHeadlessSessions() {
    const sessions = await headlessApi.listSessions();
    if (!headlessSessionList) return sessions;
    headlessSessionList.innerHTML = sessions.length
        ? sessions.slice().reverse().map(session => {
            const shortId = session.id.slice(0, 8);
            const status = session.status || 'unknown';
            return `<button type="button" class="w-full text-left text-[10px] bg-white/80 dark:bg-gray-800/80 border border-blue-100 dark:border-blue-800 rounded px-2 py-1 hover:bg-blue-50 dark:hover:bg-gray-700" data-session-id="${escapeHtml(session.id)}">
                <div class="flex justify-between gap-2">
                    <span class="font-semibold text-blue-800 dark:text-blue-300 truncate">${escapeHtml(session.prompt)}</span>
                    <span class="text-gray-500 dark:text-gray-400 shrink-0">${escapeHtml(status)}</span>
                </div>
                <div class="text-gray-500 dark:text-gray-400">${shortId}</div>
            </button>`;
        }).join('')
        : '<div class="text-[10px] italic text-blue-800 dark:text-blue-300">No sessions yet.</div>';

    document.querySelectorAll('[data-session-id]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const sessionId = e.currentTarget.getAttribute('data-session-id');
            if (!sessionId) return;
            const session = await pollHeadlessSession(sessionId);
            if (session) {
                headlessState.activeSessionId = sessionId;
                if (headlessStatus) headlessStatus.textContent = `Loaded session ${sessionId.slice(0, 8)} (${session.status}).`;
                if (headlessProgress) {
                    headlessProgress.innerHTML = (session.actions || []).map(action => `<div class="text-[10px] bg-white/80 dark:bg-gray-800/80 border border-blue-100 dark:border-blue-800 rounded px-2 py-1"><span class="font-bold text-blue-700 dark:text-blue-300">${action.type}</span><span class="text-gray-600 dark:text-gray-400 ml-1">${action.status}</span></div>`).join('');
                }
            }
        });
    });
    return sessions;
}

function updateHeadlessResult(data) {
    if (Array.isArray(data?.output?.layers)) {
        AppState.fetchedLayers = data.output.layers;
        if (typeof renderAvailableLayers === 'function') renderAvailableLayers();
    }
}

window.headlessAgent = {
    createHeadlessSession,
    planHeadlessPrompt,
    pollHeadlessSession,
    applyHeadlessWorkspaceUpdates,
    refreshHeadlessSessions,
};

async function renderHeadlessPlan() {
    const prompt = headlessPrompt?.value.trim();
    if (!prompt) return showToast("Enter a headless prompt first.", true);
    const chatGeneration = headlessState.chatGeneration;
    appendHeadlessChat('user', prompt);
    recordHeadlessMessage('user', prompt);
    if (headlessStatus) headlessStatus.textContent = 'Planning...';
    const plan = await planHeadlessPrompt(prompt);
    if (chatGeneration !== headlessState.chatGeneration) return;
    syncHeadlessChatPlan(plan);
    recordHeadlessMessage('assistant', `Plan: ${(plan.summary || []).join(' | ') || 'No actions planned.'}`);
    if (headlessProgress) {
        const items = plan.actions || [];
        headlessProgress.innerHTML = items.length
            ? items.map(a => `<div class="text-[10px] bg-white/80 dark:bg-gray-800/80 border border-blue-100 dark:border-blue-800 rounded px-2 py-1"><span class="text-gray-700 dark:text-gray-300">${escapeHtml(describeHeadlessAction(a))}</span></div>`).join('')
            : '<div class="text-[10px] italic text-blue-800 dark:text-blue-300">No actions planned.</div>';
    }
    headlessState.lastTargetHints = plan.targets || [];
    if (headlessStatus) {
        const summary = plan.summary && plan.summary.length ? ` ${plan.summary.join(' | ')}` : '';
        const planner = plan.planner ? ` Planner: ${describeHeadlessPlanner(plan.planner)}.` : '';
        const why = plan.why && plan.why.length ? ` Why: ${plan.why.join(' | ')}` : '';
        const selected = plan.selectedTarget?.name ? ` Selected: ${plan.selectedTarget.name}.` : '';
        const confirmText = plan.confirmations?.length ? ` Confirm: ${plan.confirmations.join(', ')}.` : '';
        const clarifyText = plan.clarification ? ` Needs clarification: ${plan.clarification}.` : '';
        headlessStatus.textContent = `Planned ${plan.actions?.length || 0} action(s).${planner}${selected}${summary}${why}${confirmText}${clarifyText}`;
    }
    headlessState.approvedTargetKey = plan.selectedTarget?.key || headlessState.approvedTargetKey;
}

btnHeadlessPlan?.addEventListener('click', () => {
    renderHeadlessPlan().catch(err => {
        appendHeadlessChat('assistant', `Plan failed: ${err.message || err}`);
        showToast(err.message || 'Planning failed.', true);
    });
});

btnHeadlessRun?.addEventListener('click', () => {
    runGuidedAssistantTurn().catch(err => {
        appendHeadlessChat('assistant', `Run failed: ${err.message || err}`);
        showToast(err.message || 'Execution failed.', true);
    });
});

btnHeadlessNewChat?.addEventListener('click', startNewHeadlessChat);

headlessSourceCatalog?.addEventListener('change', event => enforceAssistantProviderChoice(event.target));
headlessSourceOsm?.addEventListener('change', event => enforceAssistantProviderChoice(event.target));

btnHeadlessRefresh?.addEventListener('click', () => {
    refreshHeadlessSessions().catch(err => showToast(err.message || 'Refresh failed.', true));
});

restoreGuidedAssistantSession();

async function runHeadlessPrompt() {
    const prompt = headlessPrompt?.value.trim();
    if (!prompt) return showToast("Enter a headless prompt first.", true);
    const chatGeneration = headlessState.chatGeneration;
    appendHeadlessChat('user', prompt);
    recordHeadlessMessage('user', prompt);
    if (headlessStatus) headlessStatus.textContent = 'Launching headless session...';
    const plan = await planHeadlessPrompt(prompt);
    if (chatGeneration !== headlessState.chatGeneration) return;
    syncHeadlessChatPlan(plan);
    recordHeadlessMessage('assistant', `Plan: ${(plan.summary || []).join(' | ') || 'No actions planned.'}`);
    if (headlessProgress) {
        headlessProgress.innerHTML = plan.actions?.length
            ? plan.actions.map(a => `<div class="text-[10px] bg-white/80 dark:bg-gray-800/80 border border-blue-100 dark:border-blue-800 rounded px-2 py-1"><span class="text-gray-700 dark:text-gray-300">${escapeHtml(describeHeadlessAction(a))}</span></div>`).join('')
            : '<div class="text-[10px] italic text-blue-800 dark:text-blue-300">No actions planned.</div>';
    }
    if (plan.clarification) {
        if (headlessStatus) headlessStatus.textContent = `Needs clarification: ${plan.clarification}. Planner: ${describeHeadlessPlanner(plan.planner)}.`;
        appendHeadlessCard('Clarification needed', [
            `I need clarification before executing.`,
            `Reason: ${plan.clarification}`,
            plan.selectedTarget?.name ? `Target: ${plan.selectedTarget.name}` : ''
        ].filter(Boolean), 'warn', { targets: plan.selectedTarget ? [plan.selectedTarget] : [] });
        return;
    }
    if (plan.confirmations?.length) {
        const targetText = plan.selectedTarget?.name ? `\nTarget: ${plan.selectedTarget.name}` : '';
        const approved = window.confirm(`The map needs permission to: ${plan.confirmations.join(', ')}.${targetText}\n\nDo you want to continue?`);
        if (!approved) {
            if (headlessStatus) headlessStatus.textContent = 'Cancelled. Nothing was changed.';
            return;
        }
    }
    const isCurrentChat = () => chatGeneration === headlessState.chatGeneration;
    const executed = await executeActionPlan(plan, { confirmed: true }, {
        applyUpdates: data => { if (isCurrentChat()) applyHeadlessWorkspaceUpdates(data); },
        card: (...args) => { if (isCurrentChat()) appendHeadlessCard(...args); },
        onResult: data => { if (isCurrentChat()) updateHeadlessResult(data); }
    });
    if (!isCurrentChat()) return;
    const resultSummaries = executed
        .map(item => item?.output?.message || '')
        .filter(Boolean);
    const completionText = `Executed ${executed.length} action(s).${resultSummaries.length ? ` ${resultSummaries.join(' ')}` : ''}`;
    recordHeadlessMessage('assistant', `Completed: ${completionText}`);
    if (headlessStatus) headlessStatus.textContent = completionText;
    appendHeadlessCard('Completed', [completionText], 'success', { targets: plan.selectedTarget ? [plan.selectedTarget] : [] });
}

// ==========================================
// 2. CORE UTILITIES & HISTORY MANAGER
// ==========================================
let historyStack = [];
let historyIndex = -1;
let isRestoringHistory = false;
const MAX_HISTORY = 10;

const updateUndoRedoButtons = () => {
    const btnUndo = getEl('btn-undo');
    const btnRedo = getEl('btn-redo');
    if (btnUndo) btnUndo.disabled = historyIndex <= 0;
    if (btnRedo) btnRedo.disabled = historyIndex >= historyStack.length - 1;
};

const handleUndo = () => {
    if (historyIndex > 0) {
        historyIndex--;
        isRestoringHistory = true;
        try {
            restoreWorkspaceState(JSON.parse(JSON.stringify(historyStack[historyIndex])), { restoreMapView: false });
        } finally {
            isRestoringHistory = false;
            updateUndoRedoButtons();
        }
        showToast("Action undone.");
    }
};

const handleRedo = () => {
    if (historyIndex < historyStack.length - 1) {
        historyIndex++;
        isRestoringHistory = true;
        try {
            restoreWorkspaceState(JSON.parse(JSON.stringify(historyStack[historyIndex])), { restoreMapView: false });
        } finally {
            isRestoringHistory = false;
            updateUndoRedoButtons();
        }
        showToast("Action redone.");
    }
};

getEl('btn-undo')?.addEventListener('click', handleUndo);
getEl('btn-redo')?.addEventListener('click', handleRedo);


// --- NEW: DYNAMIC STACKING MANAGER ---
export const updateStacking = () => {
    const appConsole = getEl('app-console');
    const attrTable = getEl('attribute-table-container');
    const statusBar = getEl('map-status-bar');
    const statusBarHeight = statusBar?.offsetHeight || 0;

    if (!appConsole) return;
    
    // The console is either a real open panel or display:none. It must never
    // occupy a hidden transformed layer beneath another control surface.
    const isConsoleOpen = !appConsole.hidden;
    
    if (attrTable) {
        attrTable.style.transition = 'bottom 0.3s ease-in-out';
        if (isConsoleOpen) {
            attrTable.style.bottom = `${appConsole.offsetHeight + statusBarHeight}px`;
            attrTable.style.borderBottom = '2px solid #1f2937'; 
        } else {
            attrTable.style.bottom = `${statusBarHeight}px`;
            attrTable.style.borderBottom = 'none';
        }
    }
};

// --- NEW: LOGGING SYSTEM ---
let unreadErrors = 0;

export const showToast = (msg, isError=false, isServer=false) => {
    const output = getEl('console-output');
    if (!output) return;
    
    const now = new Date();
    const time = now.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    
    let colorClass = 'text-gray-300 hover:bg-gray-800/50';
    let icon = '<i class="fa-solid fa-angle-right text-blue-500 mr-2 opacity-50"></i>';
    
    if (isError) {
        colorClass = 'text-red-400 font-bold bg-red-900/10';
        icon = '<i class="fa-solid fa-circle-exclamation text-red-500 mr-2"></i>';
    } else if (isServer || String(msg).includes('[WARN]')) {
        colorClass = 'text-yellow-400 hover:bg-yellow-900/10';
        icon = '<i class="fa-solid fa-triangle-exclamation text-yellow-500 mr-2 opacity-70"></i>';
    }
    
    const logEntry = document.createElement('div');
    logEntry.className = `border-b border-gray-800/50 py-1 px-1 transition-colors ${colorClass}`;
    logEntry.innerHTML = `<span class="text-gray-600 mr-3 select-none">[${time}]</span>${icon} <span>${msg}</span>`;
    
    output.appendChild(logEntry);
    output.scrollTop = output.scrollHeight; 

    const appConsole = getEl('app-console');
    const isConsoleOpen = appConsole ? !appConsole.hidden : false;
    
    if ((isError || isServer || String(msg).includes('[WARN]')) && !isConsoleOpen) {
        unreadErrors++;
        const badge = getEl('console-badge');
        if (badge) {
            badge.textContent = unreadErrors > 9 ? '9+' : unreadErrors;
            badge.classList.remove('hidden');
        }
    }
};

// --- NEW: BROWSER TERMINAL UNIFICATION ---
// Intercepts all standard console prints so they render directly in the UI panel
const safeStringify = (obj) => {
    try {
        if (obj instanceof Error) return obj.toString();
        return typeof obj === 'object' ? JSON.stringify(obj) : String(obj);
    } catch(e) { return Object.prototype.toString.call(obj); }
};

const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

console.log = (...args) => {
    originalLog(...args);
    showToast(args.map(safeStringify).join(' '));
};

console.warn = (...args) => {
    originalWarn(...args);
    showToast(`[WARN] ${args.map(safeStringify).join(' ')}`, false, true);
};

console.error = (...args) => {
    originalError(...args);
    showToast(args.map(safeStringify).join(' '), true);
};

// Start Polling server logs quietly in the background
setInterval(async () => {
    try {
        const res = await fetch('/api/logs');
        if (res.ok) {
            const data = await res.json();
            if (data.logs && data.logs.length > 0) {
                data.logs.forEach(logMsg => showToast(logMsg, false, true));
            }
        }
    } catch(e) {}
}, 1000);


const updateSoloView = () => {
    if (!AppState.currentSoloLayerKey) {
        AppState.activeLayers.forEach(l => {
            if (l.isFolder) return;
            const pane = map.getPane('pane-' + l.uniqueKey);
            if (pane) {
                pane.style.transition = 'opacity 0.3s ease';
                pane.style.opacity = '1';
                pane.style.pointerEvents = 'auto'; 
            }
        });
        return;
    }

    const allowedKeys = new Set();
    const collectKeys = (key) => {
        allowedKeys.add(key);
        AppState.activeLayers.filter(l => l.parentId === key).forEach(child => collectKeys(child.uniqueKey));
    };
    collectKeys(AppState.currentSoloLayerKey);

    AppState.activeLayers.forEach(l => {
        if (l.isFolder) return;
        const pane = map.getPane('pane-' + l.uniqueKey);
        if (pane) {
            pane.style.transition = 'opacity 0.3s ease';
            if (allowedKeys.has(l.uniqueKey)) {
                pane.style.opacity = '1';
                pane.style.pointerEvents = 'auto'; 
            } else {
                pane.style.opacity = '0'; 
                pane.style.pointerEvents = 'none'; 
            }
        }
    });
};

export const updateMapLayerOrder = () => {
    let zIndex = 1000;
    for (let i = 0; i < AppState.activeLayers.length; i++) {
        const layer = AppState.activeLayers[i];
        if (layer.isFolder || !layer.isVisible) continue;
        const pane = map.getPane('pane-' + layer.uniqueKey);
        if (pane) pane.style.zIndex = zIndex--;
    }
    updateSoloView(); 
    autoSaveWorkspace(); 
};

const releaseRasterObjectUrl = layer => {
    if (layer?.rasterObjectUrl) {
        URL.revokeObjectURL(layer.rasterObjectUrl);
        layer.rasterObjectUrl = null;
    }
};

const downloadBlob = (blob, name) => {
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name.includes('.') ? name : `${name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.geojson`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.URL.revokeObjectURL(url);
};

const openContextSubmenu = () => {
    const wrapper = getEl('context-panel-wrapper');
    if (wrapper) {
        wrapper.classList.remove('hidden');
        wrapper.classList.add('flex');
        wrapper.style.height = 'auto';
        wrapper.style.maxHeight = '';
    }
    getEl('context-resizer')?.classList.remove('hidden');
};

const closeTablePanel = () => {
    AppState.activeTableLayerKey = null;
    tablePanel.close();
};
window.closeTablePanel = closeTablePanel;

let attributeTableController;
export const handleToggleTable = event => attributeTableController?.handleToggleTable(event);
export const highlightTableRow = rowId => attributeTableController?.highlightTableRow(rowId);

const closeSidebarPanels = () => {
    AppState.activeEditLayerKey = null;
    AppState.activeSplitLayerKey = null;
    AppState.activeCropLayerKey = null;
    
    getEl('context-panel-wrapper')?.classList.add('hidden');
    getEl('context-panel-wrapper')?.classList.remove('flex');
    getEl('context-resizer')?.classList.add('hidden');

    editPanelContainer?.classList.add('hidden'); editPanelContainer?.classList.remove('flex');
    splitPanelContainer?.classList.add('hidden'); splitPanelContainer?.classList.remove('flex');
    cropPanelContainer?.classList.add('hidden'); cropPanelContainer?.classList.remove('flex');
    
    if (filterType) filterType.value = 'box';
    filterRadius?.classList.add('hidden');
    filterDataContainer?.classList.add('hidden');
    btnDraw?.classList.remove('hidden');

    drawLayerGroup.clearLayers();
    AppState.filterGeometryData = null;
    AppState.drawingMode = null;
    if (btnApplyFilter) btnApplyFilter.disabled = true;
    drawStatus?.classList.add('hidden');
    map.getContainer().style.cursor = '';
    
    if (AppState.activeLayers.length > 0) renderAddedLayers();
};
window.closeSidebarPanels = closeSidebarPanels;

let styleEditorController;
export const handleToggleEdit = (event, forceStyle = null) => styleEditorController?.handleToggleEdit(event, forceStyle);

const closeAllPanels = () => {
    closeTablePanel();
    closeSidebarPanels();
};
window.closeAllPanels = closeAllPanels;

const switchTab = (tabName) => {
  const isAvailable = (tabName === 'available');

  const baseClasses = "flex-1 py-2 text-xs uppercase tracking-wider transition-all duration-200";
  const activeClasses = `${baseClasses} font-bold bg-white dark:bg-gray-800 text-blue-600 dark:text-blue-400 border-t-[3px] border-t-blue-600 dark:border-t-blue-400 border-b border-b-transparent opacity-100 z-10`;
  const inactiveClasses = `${baseClasses} font-medium bg-transparent text-gray-400 dark:text-gray-500 border-t-[3px] border-t-transparent border-b border-b-gray-200 dark:border-b-gray-700 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800/80 opacity-60 hover:opacity-100 shadow-inner cursor-pointer`;

  if (tabBtnAvailable) tabBtnAvailable.className = isAvailable ? activeClasses : inactiveClasses;
  if (tabBtnAdded) tabBtnAdded.className = !isAvailable ? activeClasses : inactiveClasses;
  
  if (isAvailable) {
    tabAvailable?.classList.replace('hidden', 'flex');
    tabAdded?.classList.replace('flex', 'hidden');
    btnAddBulk?.classList.remove('hidden');
    
    getEl('context-panel-wrapper')?.classList.add('hidden');
    getEl('context-panel-wrapper')?.classList.remove('flex');
    getEl('context-resizer')?.classList.add('hidden');
  } else {
    tabAdded?.classList.replace('hidden', 'flex');
    tabAvailable?.classList.replace('flex', 'hidden');
    btnAddBulk?.classList.add('hidden');
    
    if (AppState.activeEditLayerKey || AppState.activeSplitLayerKey || AppState.activeCropLayerKey) {
        getEl('context-panel-wrapper')?.classList.remove('hidden');
        getEl('context-panel-wrapper')?.classList.add('flex');
        getEl('context-resizer')?.classList.remove('hidden');
    }
  }
};


// ==========================================
// 3. MAP UTILITIES & PERSISTENCE
// ==========================================
export const ensureGeoJSON = async (layer) => {
    if (layer.isLocalGeoJSON) return true;
    if (!layer.exportUrl) {
        showToast("Cannot extract vector data for this specific layer.", true);
        return false;
    }
    try {
        let queryUrl = layer.exportUrl;
        if (queryUrl.includes('WFS')) queryUrl += '&maxFeatures=5000'; 
        
        const res = await fetch(`/proxy?url=${encodeURIComponent(queryUrl)}`);
        if (!res.ok) throw new Error("Server error");
        const geoJson = await res.json();
        if (!geoJson.features || geoJson.features.length === 0) throw new Error("Empty or Invalid GeoJSON");

        map.removeLayer(layer.mapLayer);
        
        const paneName = 'pane-' + layer.uniqueKey;
        const defaultStyle = { type: 'single', fillColor: '#2563eb', fillOpacity: 0.5, color: '#2563eb', opacity: 1.0, pointShape: 'circle', pointSize: 8 };
        
        const newMapLayer = createCustomGeoJSONLayer(geoJson, defaultStyle, paneName);
        if (layer.isVisible) newMapLayer.addTo(map);

        layer.mapLayer = newMapLayer;
        layer.geoJsonData = geoJson;
        layer.isLocalGeoJSON = true;
        layer.exportUrl = null; 
        layer.customStyle = defaultStyle; 
        
        autoSaveWorkspace();
        return true;
    } catch (err) {
        console.error(err);
        showToast("Failed to fetch vector data. Layer may be too large.", true);
        return false;
    }
};

export const togglePreviewLayer = (layerId, isVisible) => {
    if (!isVisible) {
        if (AppState.previewLayers[layerId]) { map.removeLayer(AppState.previewLayers[layerId]); delete AppState.previewLayers[layerId]; }
        return;
    }

    const meta = AppState.fetchedLayers.find(l => l.id === layerId);
    if(!meta) return;

    let mapLayer;
    const previewPaneName = 'previewPane';

    if (meta.geoJsonData) {
        const customStyle = { type: 'single', fillColor: '#10b981', fillOpacity: 0.5, color: '#059669', opacity: 1.0, pointShape: 'circle', pointSize: 8 };
        mapLayer = L.geoJSON(meta.geoJsonData, {
            pane: previewPaneName,
            renderer: previewRenderer,
            style: createGeoJsonStyleFunction(customStyle),
            pointToLayer: createGeoJsonPointToLayer(customStyle, previewPaneName, previewRenderer),
            onEachFeature: attachPopupsToFeatures 
        });
    } else {
        const baseUrl = meta.serviceUrl || meta.url || AppState.currentServerUrl.split('?')[0];
        const isFeatureServer = meta.serverType === 'FeatureServer' || baseUrl.toLowerCase().includes('featureserver') || (meta.url && meta.url.toLowerCase().includes('featureserver'));
        
        if (AppState.currentServerType === 'WFS') {
            mapLayer = L.tileLayer.wms(baseUrl, { pane: previewPaneName, layers: meta.id, format: 'image/png', transparent: true });
        } else {
            if (!isFeatureServer) {
                const layerId = meta.layerId !== undefined ? meta.layerId : meta.id;
                mapLayer = L.esri.dynamicMapLayer({ pane: previewPaneName, url: baseUrl, layers: [layerId], opacity: 0.8 });
            } else {
                const targetUrl = meta.url || (baseUrl.endsWith(`/${meta.id}`) ? baseUrl : `${baseUrl}/${meta.id}`);
                mapLayer = L.esri.featureLayer({ pane: previewPaneName, url: targetUrl });
            }
        }
    }
    mapLayer.addTo(map);
    AppState.previewLayers[layerId] = mapLayer;
};

const sanitizeGeoJSON = (geoJson) => {
    if (!geoJson) return null;
    try {
        return JSON.parse(JSON.stringify(geoJson, (key, value) => {
            if (key.startsWith('_') || key === 'mapLayer') return undefined;
            return value;
        }));
    } catch (e) {
        console.warn("Failed to sanitize GeoJSON for storage:", e);
        return null;
    }
};

const serializeWorkspace = () => {
    const center = map.getCenter();
    const zoom = map.getZoom();
    const layersData = AppState.activeLayers.map(l => {
        let cleanGeoJSON = null;
        if (l.geoJsonData) {
            try {
                cleanGeoJSON = JSON.parse(JSON.stringify(l.geoJsonData, (key, value) => {
                    if (key.startsWith('_') || key === 'mapLayer') return undefined;
                    return value;
                }));
            } catch (err) {
                cleanGeoJSON = l.geoJsonData;
            }
        }

        return {
            uniqueKey: l.uniqueKey,
            id: l.id,
            displayName: l.displayName,
            exportUrl: l.exportUrl,
            isLocalGeoJSON: l.isLocalGeoJSON ?? true,
            geoJsonData: cleanGeoJSON,
            originalGeoJsonData: l.originalGeoJsonData ? sanitizeGeoJSON(l.originalGeoJsonData) : null,
            customStyle: l.customStyle,
            isRasterImage: l.isRasterImage === true,
            rasterDataUrl: l.rasterDataUrl || null,
            rasterCrs: l.rasterCrs || null,
            rasterBounds: l.rasterBounds || null,
            rasterOpacity: l.rasterOpacity ?? null,
            isVisible: l.isVisible,
            isFolder: l.isFolder,
            parentId: l.parentId || null,
            isExpanded: l.isExpanded
        };
    });
    return { version: "1.3", savedAt: new Date().toISOString(), mapState: { lat: center.lat, lng: center.lng, zoom }, activeLayers: layersData };
};

export const autoSaveWorkspace = () => {
    try {
        const state = serializeWorkspace();
        persistStateToDB(state);
        const stateStr = JSON.stringify(state);
        
        if (!isRestoringHistory) {
            const deepState = JSON.parse(stateStr);
            if (historyStack.length > 0 && historyIndex >= 0) {
                const prevLayers = JSON.stringify(historyStack[historyIndex].activeLayers);
                const newLayers = JSON.stringify(deepState.activeLayers);
                if (prevLayers === newLayers) return; 
            }
            
            historyStack = historyStack.slice(0, historyIndex + 1);
            historyStack.push(deepState);
            if (historyStack.length > MAX_HISTORY) historyStack.shift();
            else historyIndex++;
            updateUndoRedoButtons();
        }
    } catch (e) { console.error("Critical failure during workspace serialization:", e); }
};

attributeTableController = createAttributeTableController({
    container: attributeTableContainer, renderAddedLayers, ensureGeoJSON, showToast,
    downloadBlob, updateStacking: () => updateStacking(), closeTablePanel,
    createCustomGeoJSONLayer, autoSaveWorkspace
});
styleEditorController = createStyleEditorController({
    editPanelContainer, renderAddedLayers, ensureGeoJSON, closeSidebarPanels,
    openContextSubmenu, showToast, updateMapLayerOrder, createCustomGeoJSONLayer,
    handleToggleTable, autoSaveWorkspace, hexAlpha, darkenHex, interpolateColor, getEl
});

const normalizePersistedMapView = mapState => {
    if (!mapState || mapState.lat === undefined || mapState.lng === undefined) return null;

    const latitude = Number(mapState.lat);
    const longitude = Number(mapState.lng);
    const zoom = Number(mapState.zoom);
    const defaultView = { lat: 0, lng: 0, zoom: 2 };

    // A PGW may contain projected coordinates, while Leaflet expects WGS84
    // latitude/longitude. Treat obviously projected/corrupt persisted views
    // as invalid instead of restoring a blank MapLibre viewport.
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
        || Math.abs(latitude) > 90 || Math.abs(longitude) > 360) {
        return { ...defaultView, repaired: true };
    }

    const boundedLatitude = Math.max(-85.05112878, Math.min(85.05112878, latitude));
    let wrappedLongitude = ((longitude + 180) % 360 + 360) % 360 - 180;
    if (wrappedLongitude === -180 && longitude > 0) wrappedLongitude = 180;
    const boundedZoom = Number.isFinite(zoom) ? Math.max(1, Math.min(22, zoom)) : 2;
    const repaired = boundedLatitude !== latitude || wrappedLongitude !== longitude || boundedZoom !== zoom;
    return { lat: boundedLatitude, lng: wrappedLongitude, zoom: boundedZoom, repaired };
};

const normalizePersistedRasterBounds = bounds => {
    if (!Array.isArray(bounds) || bounds.length !== 2
        || !Array.isArray(bounds[0]) || !Array.isArray(bounds[1])
        || bounds[0].length !== 2 || bounds[1].length !== 2) return null;
    const south = Number(bounds[0][0]);
    const west = Number(bounds[0][1]);
    const north = Number(bounds[1][0]);
    const east = Number(bounds[1][1]);
    if (![south, west, north, east].every(Number.isFinite)
        || south < -90 || north > 90 || west < -180 || east > 180
        || south >= north || west >= east) return null;
    return [[south, west], [north, east]];
};

const restoreWorkspaceState = (data, { restoreMapView = true } = {}) => {
    closeAllPanels(); clearAllPreviews();
    AppState.currentSoloLayerKey = null; 
    let repairedMapView = false;

    AppState.activeLayers.forEach(l => {
        if (!l.isFolder && l.mapLayer) map.removeLayer(l.mapLayer);
        releaseRasterObjectUrl(l);
        removePane(l.uniqueKey);
    });
    AppState.activeLayers = [];

    if (restoreMapView) {
        const mapView = normalizePersistedMapView(data.mapState);
        if (mapView) {
            repairedMapView = mapView.repaired;
            map.setView([mapView.lat, mapView.lng], mapView.zoom);
        }
    }

    if (data.activeLayers && Array.isArray(data.activeLayers)) {
        data.activeLayers.forEach(lData => {
          try {
            const uniqueKey = lData.uniqueKey;
           if (lData.isFolder) {
                AppState.activeLayers = [...AppState.activeLayers, {
                    isFolder: true, uniqueKey: uniqueKey, displayName: lData.displayName,
                    isVisible: lData.isVisible ?? true, isExpanded: lData.isExpanded ?? true, parentId: lData.parentId || null
                }];
                return;
            }

            let mapLayer;
            const paneName = 'pane-' + uniqueKey;
            if (!map.getPane(paneName)) map.createPane(paneName);
            
            if (lData.isRasterImage) {
                const rasterDataUrl = typeof lData.rasterDataUrl === 'string'
                    && (lData.rasterDataUrl.startsWith('data:image/png') || lData.rasterDataUrl.startsWith('data:application/octet-stream'))
                    ? lData.rasterDataUrl : null;
                const rasterBounds = normalizePersistedRasterBounds(lData.rasterBounds);
                if (!rasterDataUrl || !rasterBounds) throw new Error('Invalid persisted raster image data.');
                const rasterOpacity = Number.isFinite(Number(lData.rasterOpacity))
                    ? Math.max(0, Math.min(1, Number(lData.rasterOpacity))) : 0.8;
                mapLayer = L.imageOverlay(rasterDataUrl, rasterBounds, {
                    pane: paneName,
                    opacity: rasterOpacity,
                    interactive: false,
                });
            } else if (lData.geoJsonData) {
                mapLayer = createCustomGeoJSONLayer(lData.geoJsonData, lData.customStyle, paneName);
            } else if (lData.exportUrl) {
                const baseUrl = lData.exportUrl.split('?')[0];
                if (lData.exportUrl.includes('WFS')) mapLayer = L.tileLayer.wms(baseUrl, { pane: paneName, layers: lData.id, format: 'image/png', transparent: true });
                else if (lData.exportUrl.includes('featureserver')) mapLayer = L.esri.featureLayer({ pane: paneName, url: baseUrl });
                else mapLayer = L.esri.dynamicMapLayer({ pane: paneName, url: baseUrl, layers: [lData.id], opacity: 0.8 });
            }

            if (mapLayer) {
                if (lData.isVisible) mapLayer.addTo(map);
                AppState.activeLayers = [...AppState.activeLayers, {
                    uniqueKey: uniqueKey, id: lData.id, displayName: lData.displayName, mapLayer: mapLayer, exportUrl: lData.exportUrl,
                    isLocalGeoJSON: lData.isLocalGeoJSON, geoJsonData: lData.geoJsonData, originalGeoJsonData: lData.originalGeoJsonData || null, customStyle: lData.customStyle,
                    isRasterImage: lData.isRasterImage === true,
                    rasterDataUrl: lData.rasterDataUrl || null,
                    rasterCrs: lData.rasterCrs || null,
                    rasterBounds: normalizePersistedRasterBounds(lData.rasterBounds),
                    rasterOpacity: Number.isFinite(Number(lData.rasterOpacity)) ? Math.max(0, Math.min(1, Number(lData.rasterOpacity))) : null,
                    isVisible: lData.isVisible ?? true, parentId: lData.parentId || null, isFolder: false
                }];
            }
          } catch (error) {
            // A single malformed/unsupported cached layer must not prevent the
            // rest of the workspace from being restored.
            console.warn(`Skipped cached layer ${lData?.displayName || lData?.uniqueKey || 'unknown'} during restore`, error);
          }
        });
    }

    if (AppState.activeLayers.length > 0) {
        renderAddedLayers(); updateMapLayerOrder(); 
    } else {
        renderAddedLayers();
    }
    return repairedMapView;
};

const loadSavedServers = async () => {
    if (!savedServersSelect) return;
    try {
        const res = await fetch('/api/servers');
        if (!res.ok) {
            const detail = await res.json().catch(() => ({}));
            savedServersSelect.innerHTML = '<option value="" disabled selected>-- Catalog unavailable --</option>';
            console.warn('Catalog service unavailable:', detail.error || res.statusText);
            return;
        }
        const servers = await res.json();
        savedServersSelect.innerHTML = '<option value="" disabled selected>-- Load saved server --</option>';
        servers.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s.url; 
            opt.textContent = s.display_name || s.name; 
            // The standalone catalog stores the source kind as `protocol`,
            // while legacy server records used `type`. Keep both formats
            // available to the dropdown handler.
            opt.dataset.type = s.type || s.protocol || s.serverType || '';
            savedServersSelect.appendChild(opt);
        });
        filterSavedServerOptions(getEl('server-type')?.value);
    } catch (err) { console.error("Failed to load servers", err); }
};

function normalizeSavedServerType(value) {
    const rawType = String(value || '').trim().toUpperCase();
    if (!rawType) return '';
    if (rawType.includes('ARCGIS') || rawType.includes('ESRI') || rawType.includes('REST') || rawType.includes('FEATURESERVER') || rawType.includes('MAPSERVER')) return 'ARCGIS';
    if (rawType.includes('WFS') || rawType.includes('OGC')) return 'WFS';
    if (rawType.includes('CKAN')) return 'CKAN';
    if (rawType.includes('OVERPASS') || rawType.includes('OSM')) return 'OVERPASS';
    if (['ARCGIS', 'WFS', 'CKAN', 'OVERPASS', 'LOCAL'].includes(rawType)) return rawType;
    return '';
}

const filterSavedServerOptions = serverType => {
    if (!savedServersSelect) return;
    const normalizedType = normalizeSavedServerType(serverType);
    let selectedOptionNeedsReset = false;
    Array.from(savedServersSelect.options).forEach(option => {
        if (!option.value) {
            option.hidden = false;
            option.disabled = true;
            return;
        }
        const optionType = normalizeSavedServerType(option.dataset.type);
        const visible = Boolean(normalizedType && optionType === normalizedType);
        option.hidden = !visible;
        option.disabled = !visible;
        if (option.selected && !visible) selectedOptionNeedsReset = true;
    });
    if (selectedOptionNeedsReset) savedServersSelect.selectedIndex = 0;
    const placeholder = savedServersSelect.options[0];
    if (placeholder) {
        placeholder.textContent = normalizedType
            ? `-- Load saved ${normalizedType === 'ARCGIS' ? 'ESRI' : normalizedType} server --`
            : '-- Load saved server --';
    }
};


// ==========================================
// 4. OSM INSPECT AREA TOOL
// ==========================================
const executeOsmInspect = async (bounds) => {
    const container = getEl('osm-inspect-container');
    const status = getEl('osm-inspect-status');
    const results = getEl('osm-inspect-results');

    if (!status || !results) return;
    container?.classList.remove('hidden'); container?.classList.add('flex');
    status.textContent = 'Scanning area...'; status.classList.remove('hidden');
    results.innerHTML = '';
    
    try {
        const bbox = `${bounds.getSouth()},${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()}`;
        const query = `[out:json][timeout:25];\n(\n  node(${bbox});\n  way(${bbox});\n  relation(${bbox});\n);\nout tags;`;
        
        const endpoints = [
            "https://overpass-api.de/api/interpreter",
            "https://lz4.overpass-api.de/api/interpreter",
            "https://z.overpass-api.de/api/interpreter",
            "https://overpass.kumi.systems/api/interpreter",
            "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
            "https://overpass.osm.ch/api/interpreter"
        ];

        let data = null;
        let fetchSuccess = false;

        for (const url of endpoints) {
            try {
                const res = await fetch(url, { 
                    method: 'POST', 
                    body: "data=" + encodeURIComponent(query), 
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' } 
                });
                
                if (res.ok) {
                    data = await res.json();
                    fetchSuccess = true;
                    break;
                }
            } catch (e) {
                console.warn(`Inspect tool skipped failing server: ${url}`);
            }
        }

        if (!fetchSuccess || !data) throw new Error("All Overpass servers failed or area too large.");
        
        const tagCounts = {};
        const ignoreList = ['source', 'created_by', 'name', 'note', 'wikipedia', 'wikidata', 'tiger:', 'ele', 'gnis:', 'import_', 'addr:', 'phone', 'website', 'email', 'fax', 'ref'];
        
        if (data.elements) {
            data.elements.forEach(el => {
                if (!el.tags) return;
                for (let k in el.tags) {
                    if (ignoreList.some(ig => k.startsWith(ig))) continue;
                    const pair = `${k}=${el.tags[k]}`;
                    tagCounts[pair] = (tagCounts[pair] || 0) + 1;
                }
            });
        }
        
        const sortedTags = Object.entries(tagCounts).sort((a,b) => b[1] - a[1]).slice(0, 40); 
        
        if (sortedTags.length === 0) { status.textContent = 'No generic tags found in this area.'; return; }
        
        status.classList.add('hidden');
        let html = '';
        sortedTags.forEach(([pair, count]) => {
            const [k, v] = pair.split('=');
            html += `<div class="inspect-tag-item flex justify-between items-center p-1 hover:bg-blue-200 dark:hover:bg-blue-900 cursor-pointer rounded transition-colors" data-k="${k}" data-v="${v}">
                 <span class="text-blue-900 dark:text-blue-200 font-mono text-[10px] truncate pr-2">${k}=${v}</span>
                 <span class="text-gray-600 dark:text-gray-300 text-[9px] bg-white dark:bg-gray-800 px-1.5 py-0.5 rounded-full font-bold shadow-xs">${count}</span>
            </div>`;
        });
        results.innerHTML = html;
        
        document.querySelectorAll('.inspect-tag-item').forEach(item => {
            item.addEventListener('click', (e) => {
                const el = e.currentTarget;
                const targetKey = el.getAttribute('data-k');
                const targetVal = el.getAttribute('data-v');
                
                const firstRow = document.querySelector('.osm-tag-row');
                if (firstRow) {
                    const keyInp = firstRow.querySelector('.osm-key');
                    const valInp = firstRow.querySelector('.osm-val');
                    if (keyInp) keyInp.value = targetKey;
                    if (valInp) valInp.value = targetVal;
                }
                showToast(`Copied ${targetKey}=${targetVal} to Query Builder!`);
            });
        });
    } catch (err) { status.textContent = 'Scan failed. Area might be too large or servers are currently down.'; }
};

function createOsmTagRow() {
    const row = document.createElement('div');
    row.className = 'osm-tag-row mt-1';
    row.innerHTML = `
        <input type="text" class="osm-key px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-1 focus:ring-blue-500 focus:outline-none" placeholder="Key (e.g. amenity)" list="osm-keys">
        <input type="text" class="osm-val px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-1 focus:ring-blue-500 focus:outline-none" placeholder="Value (e.g. cafe)" list="osm-values">
        <button type="button" class="btn-add-tag bg-emerald-100 hover:bg-emerald-200 text-emerald-700 dark:bg-emerald-900/50 dark:hover:bg-emerald-800 dark:text-emerald-400 w-6 h-6 rounded flex items-center justify-center transition-colors"><i class="fa-solid fa-plus text-[10px]"></i></button>
        <button type="button" class="btn-remove-tag bg-red-100 hover:bg-red-200 text-red-700 dark:bg-red-900/50 dark:hover:bg-red-800 dark:text-red-400 w-6 h-6 rounded flex items-center justify-center transition-colors"><i class="fa-solid fa-minus text-[10px]"></i></button>
    `;
    return row;
}

const FOLLOWUP_MAX_AREA_KM2 = 5000;

const bboxAreaKm2 = bbox => {
    if (!bbox) return 0;
    const midLat = (Number(bbox.south) + Number(bbox.north)) / 2;
    const width = Math.abs(Number(bbox.east) - Number(bbox.west)) * 111 * Math.max(Math.cos(midLat * Math.PI / 180), 0.01);
    const height = Math.abs(Number(bbox.north) - Number(bbox.south)) * 111;
    return width * height;
};

const expandedOsmSearchBbox = point => {
    const bounds = map.getBounds();
    const south = Number(bounds.getSouth());
    const west = Number(bounds.getWest());
    const north = Number(bounds.getNorth());
    const east = Number(bounds.getEast());
    const latitude = Number(point?.lat);
    const longitude = Number(point?.lng);
    const latSpan = Math.max(north - south, 0.0001);
    const lonSpan = Math.max(east - west, 0.0001);
    let bbox = {
        south: Math.max(-90, Math.min(south - latSpan, latitude)),
        west: Math.max(-180, Math.min(west - lonSpan, longitude)),
        north: Math.min(90, Math.max(north + latSpan, latitude)),
        east: Math.min(180, Math.max(east + lonSpan, longitude))
    };
    if (bboxAreaKm2(bbox) > FOLLOWUP_MAX_AREA_KM2) {
        const fullSideKm = Math.sqrt(FOLLOWUP_MAX_AREA_KM2);
        const halfLat = (fullSideKm / 111) / 2;
        const halfLon = halfLat / Math.max(Math.cos(latitude * Math.PI / 180), 0.01);
        bbox = {
            south: Math.max(-90, latitude - halfLat),
            west: Math.max(-180, longitude - halfLon),
            north: Math.min(90, latitude + halfLat),
            east: Math.min(180, longitude + halfLon)
        };
    }
    return bbox;
};

const expandDataSourcesForOsm = () => {
    getEl('content-database')?.classList.remove('hidden');
    getEl('icon-database')?.classList.remove('-rotate-90');
    const serverType = getEl('server-type');
    if (serverType) {
        serverType.value = 'OVERPASS';
        serverType.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const builder = getEl('overpass-builder');
    builder?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
};

const populateOsmBuilderFromElement = (element, point) => {
    const identity = osmIdentityTags(element);
    const scopeBbox = expandedOsmSearchBbox(point);
    const tagsContainer = getEl('osm-tags-container');
    if (tagsContainer) {
        tagsContainer.querySelectorAll('.osm-tag-row').forEach(row => row.remove());
        identity.tags.forEach(tag => {
            const row = createOsmTagRow();
            row.querySelector('.osm-key').value = tag.key;
            row.querySelector('.osm-val').value = tag.val;
            tagsContainer.appendChild(row);
        });
        if (!identity.tags.length) tagsContainer.appendChild(createOsmTagRow());
        if (typeof updateRemoveButtons === 'function') updateRemoveButtons();
    }

    const geometry = getEl('osm-geom');
    if (geometry) geometry.value = identity.geometry;
    const maxChunks = getEl('osm-max-chunks');
    if (maxChunks) maxChunks.value = '1';
    const location = getEl('osm-location');
    if (location) location.value = '';

    AppState.osmFeatureFollowup = {
        elementType: String(element?.type || ''),
        elementId: element?.id ?? null,
        clickedCoordinate: { lat: Number(point?.lat), lng: Number(point?.lng) },
        tags: identity.tags,
        identityField: identity.identityField,
        identityValue: identity.identityValue,
        mode: identity.mode,
        scopeBbox,
        maxAreaKm2: FOLLOWUP_MAX_AREA_KM2
    };
    expandDataSourcesForOsm();
    const label = element?.tags?.name || element?.tags?.ref || `${element?.type || 'OSM element'} ${element?.id ?? ''}`;
    showToast?.(identity.mode === 'named'
        ? `Prepared OSM search for ${label}. Click Fetch OSM Data to retrieve the nearby feature.`
        : `Prepared an exact OSM search for ${label}. Click Fetch OSM Data to retrieve it.`);
};

const renderOsmPointInspectResults = (data, point) => {
    const elements = taggedOsmElements(data?.elements);
    if (!osmInspectContainer || !osmInspectStatus || !osmInspectResults) return;
    osmInspectContainer.classList.remove('hidden');
    osmInspectContainer.classList.add('flex');
    osmInspectStatus.classList.remove('hidden');
    osmInspectStatus.textContent = elements.length
        ? `${elements.length} OSM element${elements.length === 1 ? '' : 's'} within ${data?.metadata?.radius_m || 25} m of ${Number(point?.lat).toFixed(6)}, ${Number(point?.lng).toFixed(6)}`
        : 'No OSM elements were found near this point.';
    osmInspectResults.innerHTML = '';
    const adminAreas = Array.isArray(data?.administrative_context) ? data.administrative_context : [];
    const adminSummary = document.createElement('div');
    adminSummary.className = 'mb-1 rounded border border-blue-200 dark:border-blue-800 bg-blue-50/60 dark:bg-blue-950/40 p-1 text-[10px] text-blue-900 dark:text-blue-200';
    adminSummary.innerHTML = '<div class="font-semibold">Containing administrative areas</div>';
    const adminList = document.createElement('div');
    adminList.className = 'mt-0.5 space-y-0.5';
    if (adminAreas.length) {
        adminAreas.forEach(area => {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'w-full rounded px-0.5 text-left hover:bg-blue-100 dark:hover:bg-blue-900/40';
            row.setAttribute('aria-label', `Prepare a whole-feature search for ${area?.name || 'administrative area'} admin level ${area?.admin_level || ''}`);
            row.textContent = `${area?.name || 'Unnamed administrative area'} — admin_level ${area?.admin_level || '—'}`;
            row.addEventListener('click', () => populateOsmBuilderFromElement(administrativeAreaToOsmElement(area), point));
            adminList.appendChild(row);
        });
    } else {
        adminList.textContent = 'No containing administrative boundaries found.';
    }
    adminSummary.appendChild(adminList);
    osmInspectResults.appendChild(adminSummary);
    elements.forEach(element => {
        const tags = element.tags || {};
        const tagText = Object.entries(tags).slice(0, 8)
            .map(([key, value]) => `${escapeHtml(key)}=${escapeHtml(value)}`)
            .join(' · ');
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'w-full text-left rounded border border-blue-200 dark:border-blue-800 bg-white/60 dark:bg-gray-900/40 hover:bg-blue-50 dark:hover:bg-blue-900/30 p-1 text-[10px] transition-colors';
        item.setAttribute('aria-label', `Prepare a whole-feature search for ${tags.name || tags.ref || `${element.type} ${element.id}`}`);
        item.innerHTML = `
            <div class="flex justify-between gap-2">
                <span class="font-semibold text-blue-900 dark:text-blue-200 truncate">${escapeHtml(tags.name || tags.ref || `${element.type} ${element.id}`)}</span>
                <span class="shrink-0 text-gray-500 dark:text-gray-400">${escapeHtml(element.type)} ${escapeHtml(element.id)}</span>
            </div>
            <div class="mt-0.5 break-words text-gray-600 dark:text-gray-300">${tagText || 'No tags'}</div>
        `;
        item.addEventListener('click', () => populateOsmBuilderFromElement(element, point));
        osmInspectResults.appendChild(item);
    });
    if (Array.isArray(data?.warnings) && data.warnings.length) {
        const warning = document.createElement('div');
        warning.className = 'text-[10px] text-amber-700 dark:text-amber-300';
        warning.textContent = data.warnings.join(' ');
        osmInspectResults.appendChild(warning);
    }
};

createMapContextMenuController({
    map,
    showToast,
    onOsmResults: renderOsmPointInspectResults,
    onOsmElementSelected: populateOsmBuilderFromElement,
    shouldSuppressContextMenu: () => AppState.drawShape.active || AppState.roadRoute.active,
    onSuppressedContextMenu: () => {
        if (!AppState.drawShape.active) return;
        const state = AppState.drawShape;
        if (state.points.length < 3) {
            showToast('A shape needs at least 3 points.', false, true);
            return;
        }
        AppState.drawShape = { ...state, completed: true };
        map.getContainer().style.cursor = '';
        renderShapePreview();
    }
});


// ==========================================
// 5. LAYER ACTION HANDLERS
// ==========================================

export const handleToggleSolo = (e) => {
    const key = e.currentTarget.getAttribute('data-key');
    if (AppState.currentSoloLayerKey === key) AppState.currentSoloLayerKey = null; 
    else AppState.currentSoloLayerKey = key;
    
    updateSoloView();
    renderAddedLayers(); 
};

export const rebuildActiveLayersFromDOM = () => {
    const newActiveLayers = [];
    const traverse = (listEl, currentParentId) => {
        const items = listEl.children;
        for(let item of items) {
            if(item.id === 'added-search-empty-msg' || item.tagName === 'P') continue;
            const key = item.getAttribute('data-key');
            const layerObj = AppState.activeLayers.find(l => l.uniqueKey === key);
            if (layerObj) {
                layerObj.parentId = currentParentId;
                newActiveLayers.push(layerObj);
                if (layerObj.isFolder) {
                    const childList = item.querySelector('.folder-children');
                    if (childList) traverse(childList, key);
                }
            }
        }
    };
    
    traverse(getEl('added-layer-list'), null);
    AppState.activeLayers = newActiveLayers;
    updateMapLayerOrder();
};

export const handleToggleVisibility = (e) => {
  const key = e.currentTarget.getAttribute('data-key');
  const layer = AppState.activeLayers.find(l => l.uniqueKey === key);
  if (!layer) return;
  
  const isVis = !layer.isVisible;
  layer.isVisible = isVis;

  if (layer.isFolder) {
      const setChildrenVis = (parentId, vis) => {
          AppState.activeLayers.filter(l => l.parentId === parentId).forEach(child => {
              child.isVisible = vis;
              if (!child.isFolder) {
                  if (vis) map.addLayer(child.mapLayer);
                  else map.removeLayer(child.mapLayer);
              } else {
                  setChildrenVis(child.uniqueKey, vis);
              }
          });
      };
      setChildrenVis(key, isVis);
  } else {
      if (isVis) map.addLayer(layer.mapLayer);
      else map.removeLayer(layer.mapLayer);
  }

  renderAddedLayers();
  updateMapLayerOrder();
};

export const handleSetRasterOpacity = (e) => {
  const key = e.currentTarget.getAttribute('data-key');
  const layer = AppState.activeLayers.find(l => l.uniqueKey === key);
  if (!layer?.isRasterImage || !layer.mapLayer) return;

  const opacity = Math.max(0, Math.min(1, Number(e.currentTarget.value)));
  if (!Number.isFinite(opacity)) return;
  layer.rasterOpacity = opacity;
  layer.mapLayer.setOpacity(opacity);

  const valueLabel = e.currentTarget.parentElement?.querySelector('[data-raster-opacity-value]');
  if (valueLabel) valueLabel.textContent = `${Math.round(opacity * 100)}%`;
};

export const handleRemove = (e) => {
  const key = e.currentTarget.getAttribute('data-key');
  const idx = AppState.activeLayers.findIndex(l => l.uniqueKey === key);
  if (idx === -1) return;
  const layer = AppState.activeLayers[idx];

  if (AppState.currentSoloLayerKey === key) AppState.currentSoloLayerKey = null;

  if (layer.isFolder) {
      if(confirm("Remove this folder and ALL items inside it?")) {
          const keysToRemove = [key];
          const collectChildren = (parentId) => {
              AppState.activeLayers.filter(l => l.parentId === parentId).forEach(child => {
                  keysToRemove.push(child.uniqueKey);
                  if(child.isFolder) collectChildren(child.uniqueKey);
              });
          };
          collectChildren(key);

          keysToRemove.forEach(k => {
              const i = AppState.activeLayers.findIndex(l => l.uniqueKey === k);
              if(i !== -1) {
                  const l = AppState.activeLayers[i];
                  if(!l.isFolder && l.mapLayer) map.removeLayer(l.mapLayer);
                  releaseRasterObjectUrl(l);
                  removePane(k);
                  if (AppState.activeTableLayerKey === k) closeTablePanel();
                  if (AppState.activeEditLayerKey === k || AppState.activeSplitLayerKey === k || AppState.activeCropLayerKey === k) closeSidebarPanels();
                  AppState.activeLayers = AppState.activeLayers.filter((_, index) => index !== i);
              }
          });
      } else { return; }
  } else {
      map.removeLayer(layer.mapLayer);
      releaseRasterObjectUrl(layer);
      removePane(key);
      AppState.activeLayers = AppState.activeLayers.filter((_, index) => index !== idx);
      if (AppState.activeTableLayerKey === key) closeTablePanel();
      if (AppState.activeEditLayerKey === key || AppState.activeSplitLayerKey === key || AppState.activeCropLayerKey === key) closeSidebarPanels();
  }

  renderAddedLayers();
  autoSaveWorkspace();
};

export const handleExport = async (e) => {
  const layer = AppState.activeLayers.find(l => l.uniqueKey === e.currentTarget.getAttribute('data-key'));
  if (layer.isFolder) return showToast("Cannot directly export folders.");
  if (layer.isLocalGeoJSON) {
    downloadBlob(new Blob([JSON.stringify(layer.geoJsonData)], {type: "application/json"}), layer.displayName);
    return;
  }
  if (!layer.exportUrl) return showToast("Export not available.", true);
  showToast(`Fetching export for ${layer.displayName}...`);
  try {
    const res = await fetch(`/proxy?url=${encodeURIComponent(layer.exportUrl)}`);
    if (!res.ok) throw new Error("Server error");
    downloadBlob(await res.blob(), layer.displayName);
  } catch(err) { showToast("Export failed.", true); }
};

export const handleExportFolder = async (e) => {
    const folderKey = e.currentTarget.getAttribute('data-key');
    const folder = AppState.activeLayers.find(l => l.uniqueKey === folderKey);
    if (!folder) return;

    showToast(`Preparing ZIP for ${folder.displayName}...`);

    const zip = new JSZip();
    let processedCount = 0;

    const addLayersToZip = async (parentId, currentZipFolder) => {
        const children = AppState.activeLayers.filter(l => l.parentId === parentId);
        for (const child of children) {
            if (child.isFolder) {
                const safeName = child.displayName.replace(/[^a-z0-9 \-_]/gi, '').trim() || 'folder';
                const subZip = currentZipFolder.folder(safeName);
                await addLayersToZip(child.uniqueKey, subZip);
            } else {
                try {
                    let geojsonDataToZip = null;
                    if (child.isLocalGeoJSON) {
                        geojsonDataToZip = child.geoJsonData;
                    } else if (child.exportUrl) {
                        const res = await fetch(`/proxy?url=${encodeURIComponent(child.exportUrl)}`);
                        if (res.ok) geojsonDataToZip = await res.json();
                    }

                    if (geojsonDataToZip) {
                        const safeName = child.displayName.replace(/[^a-z0-9 \-_]/gi, '').trim() || 'layer';
                        currentZipFolder.file(safeName + '.geojson', JSON.stringify(geojsonDataToZip));
                        processedCount++;
                    }
                } catch(err) { console.warn("Failed to process layer for zip: ", child.displayName); }
            }
        }
    };

    await addLayersToZip(folderKey, zip);
    if (processedCount === 0) return showToast("Folder is empty or failed to fetch layers.", true);

    const content = await zip.generateAsync({ type: "blob" });
    const zipName = (folder.displayName.replace(/[^a-z0-9 \-_]/gi, '').trim() || 'folder_export') + '.zip';
    downloadBlob(content, zipName);
    showToast(`Successfully exported ${processedCount} layers as ZIP!`);
};

export const handleDuplicate = async (e) => {
    const key = e.currentTarget.getAttribute('data-key');
    const rootLayerToCopy = AppState.activeLayers.find(l => l.uniqueKey === key);
    if (!rootLayerToCopy) return;

    showToast(`Duplicating ${rootLayerToCopy.displayName}...`);

    const copyNode = async (nodeToCopy, newParentId = null, isRootCopy = false) => {
        const newUniqueKey = Math.random().toString(36).substr(2, 9);
        const displayNameSuffix = isRootCopy ? ' (Copy)' : '';

        if (nodeToCopy.isFolder) {
            AppState.activeLayers = [{
                uniqueKey: newUniqueKey, id: `${nodeToCopy.id}_copy`, displayName: `${nodeToCopy.displayName}${displayNameSuffix}`,
                isFolder: true, isExpanded: nodeToCopy.isExpanded, isVisible: nodeToCopy.isVisible, parentId: newParentId
            }, ...AppState.activeLayers];

            const children = AppState.activeLayers.filter(l => l.parentId === nodeToCopy.uniqueKey);
            for (const child of children) await copyNode(child, newUniqueKey, false);
        } else {
            const success = await ensureGeoJSON(nodeToCopy);
            if (!success) return;

            const newGeoJson = nodeToCopy.geoJsonData ? JSON.parse(JSON.stringify(nodeToCopy.geoJsonData)) : null;
            const defaultStyle = { type: 'single', fillColor: '#2563eb', fillOpacity: 0.5, color: '#2563eb', opacity: 1.0, pointShape: 'circle', pointSize: 8 };
            const newStyleState = nodeToCopy.customStyle ? JSON.parse(JSON.stringify(nodeToCopy.customStyle)) : defaultStyle;

            const paneName = 'pane-' + newUniqueKey;
            const newMapLayer = createCustomGeoJSONLayer(newGeoJson, newStyleState, paneName).addTo(map);

            if (!nodeToCopy.isVisible) map.removeLayer(newMapLayer);

            AppState.activeLayers = [{
                uniqueKey: newUniqueKey, id: `${nodeToCopy.id}_copy`, displayName: `${nodeToCopy.displayName}${displayNameSuffix}`,
                mapLayer: newMapLayer, exportUrl: null, isLocalGeoJSON: true, geoJsonData: newGeoJson, customStyle: newStyleState,
                isVisible: nodeToCopy.isVisible, parentId: newParentId, isFolder: false
            }, ...AppState.activeLayers];
        }
    };

    await copyNode(rootLayerToCopy, rootLayerToCopy.parentId, true);
    renderAddedLayers(); updateMapLayerOrder(); showToast(`${rootLayerToCopy.isFolder ? 'Folder' : 'Layer'} duplicated successfully!`);
};

export const handleZoomToLayer = (e) => {
    const key = e?.currentTarget?.getAttribute ? e.currentTarget.getAttribute('data-key') : e;
    const layer = AppState.activeLayers.find(l => l.uniqueKey === key);
    if (!layer) return;

    let bounds = null;

    const extendBoundsFromLayer = (l) => {
        if (!l.isFolder && l.mapLayer && typeof l.mapLayer.getBounds === 'function') {
            try {
                const b = l.mapLayer.getBounds();
                if (b && b.isValid()) {
                    if (!bounds) bounds = L.latLngBounds(b);
                    else bounds.extend(b);
                }
            } catch (err) {}
        }
    };

    if (layer.isFolder) {
        const collectChildren = (parentId) => {
            AppState.activeLayers.filter(l => l.parentId === parentId).forEach(child => {
                extendBoundsFromLayer(child);
                if (child.isFolder) collectChildren(child.uniqueKey);
            });
        };
        collectChildren(layer.uniqueKey);
    } else {
        extendBoundsFromLayer(layer);
    }

    if (bounds && bounds.isValid()) map.flyToBounds(bounds, { padding: [30, 30], duration: 0.5 });
    else showToast("Cannot determine bounds for this layer.", true);
};

// ==========================================
const splitGeoJSONByColumn = (geoJson, splitCol, layerName = 'Layer') => {
    if (!geoJson?.features || !splitCol) return [];
    const values = [...new Set(geoJson.features.map(feature => feature.properties?.[splitCol]))];
    return values.map(value => {
        const features = geoJson.features.filter(feature => feature.properties?.[splitCol] === value);
        if (!features.length) return null;
        const displayValue = value === null || value === undefined || value === '' ? 'null' : String(value);
        const extraName = features.length === 1 && features[0].properties?.name && splitCol !== 'name'
            ? ` - ${features[0].properties.name}` : '';
        return {
            id: `split_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            title: `${layerName} [${splitCol}: ${displayValue}]${extraName}`,
            geoJsonData: { type: 'FeatureCollection', features }
        };
    }).filter(Boolean);
};

const applySplitToAvailableLayer = (geoJson, splitCol, layerName) => {
    const splitLayers = splitGeoJSONByColumn(geoJson, splitCol, layerName);
    if (!splitLayers.length) {
        showToast('No features contain values for that column.', true);
        return false;
    }
    clearAllPreviews();
    AppState.fetchedLayers = splitLayers;
    renderAvailableLayers();
    showToast(`Successfully unpacked into ${splitLayers.length} sub-layers!`);
    return true;
};

const applySplitToActiveLayer = (layer, splitCol) => {
    const splitLayers = splitGeoJSONByColumn(layer.geoJsonData, splitCol, layer.displayName || 'Layer');
    if (!splitLayers.length) {
        showToast('No features contain values for that column.', true);
        return false;
    }
    if (splitLayers.length > 50 && !confirm(`This will unpack ${splitLayers.length} layers into the map. Proceed?`)) return false;

    if (!AppState.activeLayers.includes(layer)) return false;
    const splitVisibility = layer.isVisible !== false;
    // Keep the source layer in the workspace for reversibility. Hide it from
    // the map while the derived split layers are displayed above it.
    if (layer.mapLayer && map.hasLayer(layer.mapLayer)) map.removeLayer(layer.mapLayer);
    layer.isVisible = false;

    const folderKey = `folder_split_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const folder = {
        isFolder: true, uniqueKey: folderKey,
        displayName: `${layer.displayName || 'Layer'} (split by ${splitCol})`,
        isVisible: true, isExpanded: true, parentId: null
    };
    const children = splitLayers.map((splitLayer, childIndex) => {
        const uniqueKey = `layer_split_${Date.now()}_${childIndex}_${Math.random().toString(36).slice(2, 7)}`;
        const paneName = `pane-${uniqueKey}`;
        if (!map.getPane(paneName)) map.createPane(paneName);
        const customStyle = layer.customStyle || { type: 'single', fillColor: '#10b981', fillOpacity: 0.5, color: '#059669', opacity: 1, pointShape: 'circle', pointSize: 8 };
        const mapLayer = createCustomGeoJSONLayer(splitLayer.geoJsonData, customStyle, paneName);
        mapLayer.addTo(map);
        return {
            uniqueKey, id: splitLayer.id, displayName: splitLayer.title,
            mapLayer, exportUrl: null, isLocalGeoJSON: true,
            geoJsonData: splitLayer.geoJsonData, customStyle,
            isVisible: splitVisibility, parentId: folderKey, isFolder: false
        };
    });
    AppState.activeLayers = [folder, ...children, ...AppState.activeLayers];
    AppState.activeSplitLayerKey = null;
    closeSidebarPanels();
    updateMapLayerOrder();
    renderAddedLayers();
    autoSaveWorkspace();
    showToast(`Successfully split into ${children.length} layers.`);
    return true;
};

export const handleToggleSplit = async (e) => {
    const key = e?.currentTarget ? e.currentTarget.getAttribute('data-key') : e;
    const layer = AppState.activeLayers.find(l => l.uniqueKey === key);
    if (!layer || layer.isFolder) return;

    if (AppState.activeSplitLayerKey === key && e.currentTarget) { closeSidebarPanels(); return; }

    closeSidebarPanels();
    AppState.activeSplitLayerKey = key;
    renderAddedLayers();
    if (!splitPanelContainer) return;
    
    openContextSubmenu();
    splitPanelContainer.classList.remove('hidden');
    splitPanelContainer.classList.add('flex');
    splitPanelContainer.innerHTML = '<div class="flex justify-center p-3"><p class="text-xs italic animate-pulse text-gray-500 dark:text-gray-400">Preparing vector data for split...</p></div>';

    const success = await ensureGeoJSON(layer);
    if (!success) { closeSidebarPanels(); return; }

    const features = layer.geoJsonData.features || [];
    const colsSet = new Set();
    features.forEach(f => { if (f.properties) Object.keys(f.properties).forEach(k => colsSet.add(k)); });
    const cols = Array.from(colsSet).sort();

    splitPanelContainer.innerHTML = `
        <div class="p-2 text-xs flex flex-col h-full min-h-0 bg-blue-50/50 dark:bg-transparent">
            <div class="flex justify-between items-center mb-2 pb-1 border-b border-blue-200 dark:border-blue-800 shrink-0">
                <h4 class="font-bold text-gray-700 dark:text-gray-200 uppercase text-[11px] tracking-wider">Split Layer</h4>
                <button onclick="window.closeSidebarPanels()" class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"><i class="fa-solid fa-times text-xs"></i></button>
            </div>
            <div class="flex-1 space-y-2 min-h-0">
                <p class="text-[10px] text-gray-500 dark:text-gray-400 leading-tight">Select an attribute to duplicate this layer into multiple sub-layers based on unique data entries.</p>
                <div class="flex space-x-1.5">
                    <select id="split-col-select" class="flex-1 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white rounded px-1.5 py-0.5 text-xs">
                        <option value="" disabled selected>Select attribute column...</option>
                        ${cols.map(c => `<option value="${c}">${c}</option>`).join('')}
                    </select>
                    <button id="btn-apply-split" class="bg-blue-600 hover:bg-blue-700 text-white text-xs px-2.5 py-0.5 rounded transition-colors font-medium shrink-0">Split Data</button>
                </div>
            </div>
        </div>
    `;

    getEl('btn-apply-split')?.addEventListener('click', () => {
        try {
        const splitCol = getEl('split-col-select')?.value;
        if (!splitCol) return showToast("Select an attribute column first.", true);
        
        applySplitToActiveLayer(layer, splitCol);
        } catch (error) {
            console.error('Split layer failed:', error);
            showToast(`Split failed: ${error.message || 'unexpected error'}`, true);
        }
    });
};

export const handleToggleCrop = (e) => {
    const key = e.currentTarget ? e.currentTarget.getAttribute('data-key') : e;
    const layer = AppState.activeLayers.find(l => l.uniqueKey === key);
    if (!layer || layer.isFolder) return;

    if (AppState.activeCropLayerKey === key && e.currentTarget) { closeSidebarPanels(); return; }

    closeSidebarPanels();
    AppState.activeCropLayerKey = key;
    if (cropPanelContainer) {
        openContextSubmenu();
        cropPanelContainer.classList.remove('hidden');
        cropPanelContainer.classList.add('flex');
    }
    renderAddedLayers();
    
    if (filterType?.value === 'data') triggerDataFilterSetup(layer);
};

const triggerDataFilterSetup = async (layer) => {
    const drawStatusEl = getEl('draw-status');
    if (drawStatusEl) { drawStatusEl.classList.remove('hidden'); drawStatusEl.textContent = 'Ensuring local data for filtering...'; }

    const searchInput = getEl('filter-data-search');
    if (searchInput) searchInput.value = '';
    getEl('btn-clear-filter-search')?.classList.add('hidden');

    const success = await ensureGeoJSON(layer);
    if (!success) { if (drawStatusEl) drawStatusEl.textContent = 'Failed to load vector data.'; return; }
    
    if (drawStatusEl) drawStatusEl.textContent = 'Select an attribute column.';

    const cols = new Set();
    (layer.geoJsonData?.features || []).forEach(f => { if (f.properties) Object.keys(f.properties).forEach(k => cols.add(k)); });
    const sortedCols = Array.from(cols).sort();

    const selectEl = getEl('filter-data-col');
    if (selectEl) {
        selectEl.innerHTML = `<option value="" disabled selected>Select attribute column...</option>` + 
            sortedCols.map(c => `<option value="${c}">${c}</option>`).join('');
    }

    const valContainer = getEl('filter-data-values');
    if (valContainer) {
        valContainer.innerHTML = '<p class="text-xs text-gray-400 dark:text-gray-500 italic text-center">Select a column first.</p>';
    }
    checkApplyButton();
};

const checkApplyButton = () => {
  if (!filterType) return;
  const type = filterType.value;
  if (type === 'data') {
     const checked = document.querySelectorAll('.filter-data-val-cb:checked');
     if (checked.length > 0) {
         if (btnApplyFilter) btnApplyFilter.disabled = false;
         if (drawStatus) {
            drawStatus.textContent = 'Ready to apply filter.';
            drawStatus.classList.replace('text-blue-700', 'text-emerald-700');
            drawStatus.classList.replace('dark:text-blue-400', 'dark:text-emerald-400');
         }
     } else {
         if (btnApplyFilter) btnApplyFilter.disabled = true;
         if (drawStatus) {
            drawStatus.textContent = 'Select at least one value.';
            drawStatus.classList.replace('text-emerald-700', 'text-blue-700');
            drawStatus.classList.replace('dark:text-emerald-400', 'dark:text-blue-400');
         }
     }
  } else {
     if (AppState.filterGeometryData && AppState.activeCropLayerKey) {
         if (btnApplyFilter) btnApplyFilter.disabled = false;
         if (drawStatus) {
            drawStatus.textContent = 'Ready to apply filter.';
            drawStatus.classList.replace('text-blue-700', 'text-emerald-700');
            drawStatus.classList.replace('dark:text-blue-400', 'dark:text-emerald-400');
         }
     } else {
         if (btnApplyFilter) btnApplyFilter.disabled = true;
     }
  }
};

const triggerSearch = () => {
  if (!layerSearch) return;
  const term = layerSearch.value.toLowerCase();
  if (term === '') btnClearSearch?.classList.add('hidden');
  else btnClearSearch?.classList.remove('hidden');
  
  if (term === '') {
      document.querySelectorAll('.folder-item, .available-layer-item').forEach(item => {
          item.classList.remove('hidden');
      });
      document.querySelectorAll('.folder-children').forEach(c => {
          c.classList.add('hidden');
      });
      document.querySelectorAll('.collapse-icon').forEach(i => {
          i.classList.remove('fa-folder-open');
          i.classList.add('fa-folder');
      });
  } else {
      document.querySelectorAll('.folder-item, .available-layer-item').forEach(item => {
          item.classList.add('hidden');
      });

      document.querySelectorAll('.folder-item, .available-layer-item').forEach(item => {
        if (item.getAttribute('data-search') && item.getAttribute('data-search').includes(term)) { 
            item.classList.remove('hidden'); 
            
            let parentBlock = item.parentElement.closest('.folder-item');
            while (parentBlock) {
                parentBlock.classList.remove('hidden');
                const childrenContainer = parentBlock.querySelector('.folder-children');
                if (childrenContainer) childrenContainer.classList.remove('hidden');
                
                const icon = parentBlock.querySelector('.collapse-icon');
                if (icon) {
                    icon.classList.remove('fa-folder');
                    icon.classList.add('fa-folder-open');
                }
                
                parentBlock = parentBlock.parentElement.closest('.folder-item');
            }
            
            if (item.classList.contains('folder-item')) {
                 item.querySelectorAll('.available-layer-item, .folder-item').forEach(child => {
                     child.classList.remove('hidden');
                 });
                 item.querySelectorAll('.folder-children').forEach(child => {
                     child.classList.remove('hidden');
                 });
                 item.querySelectorAll('.collapse-icon').forEach(i => {
                     i.classList.remove('fa-folder');
                     i.classList.add('fa-folder-open');
                 });
            }
        } 
      });
  }
  
  const visibleCount = document.querySelectorAll('.available-layer-item:not(.hidden)').length;
  let emptyMsg = getEl('search-empty-msg');
  if (visibleCount === 0 && AppState.fetchedLayers.length > 0) {
    if (!emptyMsg && availableLayerList) {
      emptyMsg = document.createElement('p'); emptyMsg.id = 'search-empty-msg'; emptyMsg.className = 'text-xs text-gray-400 italic text-center mt-3'; emptyMsg.textContent = 'No matching layers found.';
      availableLayerList.appendChild(emptyMsg);
    }
    emptyMsg?.classList.remove('hidden');
  } else if (emptyMsg) { emptyMsg.classList.add('hidden'); }
};

export const triggerAddedSearch = () => {
  if (!addedLayerSearch) return;
  const term = addedLayerSearch.value.toLowerCase();
  
  if (term === '') {
      btnClearAddedSearch?.classList.add('hidden');
      document.querySelectorAll('.added-layer-item, .folder-item').forEach(item => item.classList.remove('hidden'));
      AppState.activeLayers.forEach(l => {
          if (l.isFolder) {
              const childContainer = document.querySelector(`.folder-children[data-parent="${l.uniqueKey}"]`);
              if (childContainer) {
                  if (l.isExpanded) childContainer.classList.remove('hidden');
                  else childContainer.classList.add('hidden');
              }
          }
      });
  } else {
      btnClearAddedSearch?.classList.remove('hidden');
      document.querySelectorAll('.added-layer-item, .folder-item').forEach(item => item.classList.add('hidden'));

      document.querySelectorAll('.added-layer-item, .folder-item').forEach(item => {
        if (item.getAttribute('data-search').includes(term)) { 
            item.classList.remove('hidden'); 
            let parentFolderBlock = item.parentElement.closest('.folder-item');
            while (parentFolderBlock) {
                parentFolderBlock.classList.remove('hidden');
                const childrenContainer = parentFolderBlock.querySelector('.folder-children');
                if (childrenContainer) childrenContainer.classList.remove('hidden');
                parentFolderBlock = parentFolderBlock.parentElement.closest('.folder-item');
            }
        } 
      });

      document.querySelectorAll('.folder-item:not(.hidden)').forEach(folder => {
          if (folder.getAttribute('data-search').includes(term)) {
              folder.querySelectorAll('.added-layer-item, .folder-item, .folder-children').forEach(el => {
                  el.classList.remove('hidden');
              });
          }
      });
  }
  
  const visibleCount = document.querySelectorAll('.added-layer-item:not(.hidden), .folder-item:not(.hidden)').length;
  let emptyMsg = getEl('added-search-empty-msg');
  if (visibleCount === 0 && AppState.activeLayers.length > 0) {
    if (!emptyMsg && addedLayerList) {
      emptyMsg = document.createElement('p'); emptyMsg.id = 'added-search-empty-msg'; emptyMsg.className = 'text-xs text-gray-400 italic text-center mt-3'; emptyMsg.textContent = 'No matching layers found.';
      addedLayerList.appendChild(emptyMsg);
    }
    emptyMsg?.classList.remove('hidden');
  } else if (emptyMsg) { 
    emptyMsg.classList.add('hidden'); 
  }
};

const triggerFilterDataSearch = () => {
    if (!filterDataSearch) return;
    const term = filterDataSearch.value.toLowerCase();
    if (term === '') btnClearFilterSearch?.classList.add('hidden');
    else btnClearFilterSearch?.classList.remove('hidden');
    
    document.querySelectorAll('#filter-data-values label').forEach(label => {
        const input = label.querySelector('input');
        if (!input) return;
        const val = input.value.toLowerCase();
        if (val.includes(term)) { label.classList.remove('hidden'); label.classList.add('flex'); } 
        else { label.classList.add('hidden'); label.classList.remove('flex'); }
    });
};

const renderAvailableLayers = () => {
  if (!availableLayerList) return;
  availableLayerList.innerHTML = '';
  if (AppState.fetchedLayers.length === 0) {
    availableLayerList.innerHTML = `<p class="text-xs text-gray-400 dark:text-gray-500 italic text-center mt-3">No layers fetched yet.</p>`;
    searchContainer?.classList.add('hidden');
    if (btnAddBulk) btnAddBulk.disabled = true;
    return;
  }
  
  searchContainer?.classList.remove('hidden');
  if (btnAddBulk) btnAddBulk.disabled = false;

  const standaloneLayers = [];
  const servicesMap = {};

  AppState.fetchedLayers.forEach(layer => {
      if (!layer.serviceName) {
          standaloneLayers.push(layer);
      } else {
          const sUrl = layer.serviceName || layer.serviceUrl;
          if (!servicesMap[sUrl]) {
              servicesMap[sUrl] = { serviceName: layer.serviceName, layers: [] };
          }
          servicesMap[sUrl].layers.push(layer);
      }
  });

  Object.keys(servicesMap).forEach(sUrl => {
      const srv = servicesMap[sUrl];
      if (srv.layers.length === 1 && !srv.layers[0].isGroup) {
          standaloneLayers.push(srv.layers[0]);
          delete servicesMap[sUrl];
      }
  });

  standaloneLayers.sort((a, b) => a.title.localeCompare(b.title));

  const createFormatDropdown = (layer) => {
      if (layer.type === 'CKAN' && layer.resources && layer.resources.length > 1) {
          const options = layer.resources.map(r => `<option value="${r.url}" data-ext="${r.ext}">${r.display}</option>`).join('');
          return `<select id="sel-${layer.id}" class="ml-2 border border-gray-300 dark:border-gray-600 bg-blue-50 dark:bg-gray-700 text-blue-700 dark:text-gray-200 text-[10px] font-bold rounded px-1 py-0.5 cursor-pointer focus:outline-none shrink-0 transition-colors hover:bg-blue-100 dark:hover:bg-gray-600 shadow-xs" aria-label="Select format to download" data-hover-context="Select format to download">${options}</select>`;
      }
      return '';
  };

  const buildLayerItem = (layer, parentContainer) => {
      const div = document.createElement('div');
      div.className = 'available-layer-item flex mb-1 rounded border transition-colors bg-white border-gray-100 shadow-xs dark:bg-gray-800 dark:border-gray-700 overflow-hidden';
      div.setAttribute('data-search', `${layer.title} ${layer.id} ${layer.serviceName || ''}`.toLowerCase());
      div.setAttribute('data-hover-context', `Layer: ${layer.title}`);
      
      div.innerHTML = `
          <div class="flex-1 flex items-center p-1.5 min-w-0">
              <div class="flex items-center justify-center mr-2 shrink-0">
                  <label class="group cursor-pointer relative flex items-center justify-center" aria-label="Visibility" data-hover-context="Visibility" title="Visibility">
                      <input id="cb-${layer.id}" type="checkbox" value="${layer.id}" class="peer layer-checkbox sr-only">
                      <i class="fa-solid fa-eye-slash text-gray-400 dark:text-gray-500 group-hover:text-[#71A4F4] peer-checked:hidden text-[11px] w-3 text-center transition-colors"></i>
                      <i class="fa-solid fa-eye hidden peer-checked:inline-block text-[#E6E7EB] group-hover:text-[#71A4F4] text-[11px] w-3 text-center transition-colors"></i>
                  </label>
              </div>
              <div class="flex-1 min-w-0 overflow-hidden pr-2 flex flex-col justify-center">
                  <label for="cb-${layer.id}" class="text-xs font-semibold text-gray-800 dark:text-gray-200 block truncate cursor-pointer" aria-label="${escapeHtml(layer.title)}" data-hover-context="Layer: ${escapeHtml(layer.title)}">${layer.title}</label>
                  <p class="text-[9px] text-gray-400 dark:text-gray-500 block truncate" aria-label="Layer ID ${escapeHtml(layer.layerId !== undefined ? layer.layerId : layer.id)}" data-hover-context="Layer ID: ${escapeHtml(layer.layerId !== undefined ? layer.layerId : layer.id)}">ID: ${layer.layerId !== undefined ? layer.layerId : layer.id}</p>
              </div>
              ${createFormatDropdown(layer)}
              <button class="btn-add-single shrink-0 bg-blue-100 dark:bg-blue-900/40 hover:bg-blue-200 dark:hover:bg-blue-800 text-blue-700 dark:text-blue-300 w-7 h-7 rounded-full flex items-center justify-center transition-colors shadow-xs ml-1" data-id="${layer.id}" aria-label="Add layer ${escapeHtml(layer.title)}" data-hover-context="Add layer: ${escapeHtml(layer.title)}"><i class="fa-solid fa-plus text-[10px]"></i></button>
          </div>
      `;
      parentContainer.appendChild(div);
  };

  const buildFolderItem = (title, searchStr, parentContainer) => {
      const folderWrapper = document.createElement('div');
      folderWrapper.className = 'folder-item mb-1 border border-gray-300 dark:border-gray-600 rounded bg-gray-100 dark:bg-gray-800 shadow-xs flex flex-col overflow-hidden';
      folderWrapper.setAttribute('data-search', searchStr);
      folderWrapper.setAttribute('data-hover-context', `Service: ${title}`);

      const folderHeader = document.createElement('div');
      folderHeader.className = 'flex items-stretch border-b border-transparent dark:border-gray-700 folder-header cursor-pointer select-none hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors';
      
      folderHeader.innerHTML = `
          <div class="flex-1 flex flex-col p-1.5 min-w-0">
              <div class="flex items-center overflow-hidden pr-1 space-x-1.5 pl-0.5">
                  <button class="text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 shrink-0 flex justify-center transition-colors">
                      <i class="collapse-icon fa-solid fa-folder text-[12px] w-4 text-center"></i>
                  </button>
                  <span class="text-xs font-bold text-gray-700 dark:text-gray-200 truncate flex-1" aria-label="${escapeHtml(title)}" data-hover-context="Service: ${escapeHtml(title)}">${title}</span>
              </div>
          </div>
      `;

      const childrenDiv = document.createElement('div');
      childrenDiv.className = 'folder-children pl-4 pr-1 py-1 min-h-[15px] space-y-1 hidden transition-all';
      
      folderHeader.addEventListener('click', () => {
          const icon = folderHeader.querySelector('.collapse-icon');
          if (icon.classList.contains('fa-folder')) {
              icon.classList.remove('fa-folder');
              icon.classList.add('fa-folder-open');
          } else {
              icon.classList.remove('fa-folder-open');
              icon.classList.add('fa-folder');
          }
          childrenDiv.classList.toggle('hidden');
      });

      folderWrapper.appendChild(folderHeader);
      folderWrapper.appendChild(childrenDiv);
      parentContainer.appendChild(folderWrapper);

      return childrenDiv;
  };

  standaloneLayers.forEach(layer => buildLayerItem(layer, availableLayerList));

  const sortedServices = Object.values(servicesMap).sort((a,b) => a.serviceName.localeCompare(b.serviceName));

  sortedServices.forEach(service => {
      const rootChildrenDiv = buildFolderItem(service.serviceName, service.serviceName.toLowerCase(), availableLayerList);
      const groupContainers = { '-1': rootChildrenDiv };

      service.layers.sort((a, b) => {
          const depthA = a.depth || 1;
          const depthB = b.depth || 1;
          if (depthA !== depthB) return depthA - depthB;
          const idA = a.layerId !== undefined ? a.layerId : 0;
          const idB = b.layerId !== undefined ? b.layerId : 0;
          return idA - idB;
      });

      service.layers.forEach(layer => {
          const parentId = layer.parentLayerId !== undefined ? layer.parentLayerId : -1;
          const parentContainer = groupContainers[parentId] || rootChildrenDiv;

          if (layer.isGroup) {
              const searchStr = `${layer.title} ${layer.id} ${layer.serviceName}`.toLowerCase();
              const groupChildrenDiv = buildFolderItem(layer.title, searchStr, parentContainer);
              const gid = layer.layerId !== undefined ? layer.layerId : layer.id;
              groupContainers[gid] = groupChildrenDiv;
          } else {
              buildLayerItem(layer, parentContainer);
          }
      });
  });

  document.querySelectorAll('.layer-checkbox').forEach(cb => cb.addEventListener('change', (e) => togglePreviewLayer(e.target.value, e.target.checked)));
  document.querySelectorAll('.btn-add-single').forEach(btn => {
      btn.addEventListener('click', (e) => {
          const layerId = e.currentTarget.getAttribute('data-id');
          const cb = getEl(`cb-${layerId}`);
          if (cb) cb.checked = false;
          togglePreviewLayer(layerId, false);
          addLayerToMap(layerId, true);
      });
  });
  triggerSearch(); 
};

function catalogFeatureRequestUrl(meta) {
    const protocol = String(meta.protocol || meta.format || meta.type || '').toLowerCase();
    const rawUrl = meta.layerUrl || meta.url || meta.serviceUrl;
    if (!rawUrl) throw new Error('The catalog result has no feature endpoint.');
    const target = new URL(rawUrl, window.location.href);
    if (protocol === 'wfs') {
        target.searchParams.set('service', 'WFS');
        target.searchParams.set('version', '1.1.0');
        target.searchParams.set('request', 'GetFeature');
        target.searchParams.set('typeName', meta.layerName || meta.id);
        target.searchParams.set('outputFormat', 'application/json');
        target.searchParams.set('srsName', 'EPSG:4326');
        target.searchParams.set('maxFeatures', '5000');
    } else {
        target.searchParams.set('where', '1=1');
        target.searchParams.set('outFields', '*');
        target.searchParams.set('f', 'geojson');
        target.searchParams.set('outSR', '4326');
        target.searchParams.set('resultRecordCount', '5000');
    }
    return target.toString();
}

async function fetchCatalogLayerToMap(meta, switchTabAfter = true) {
    let requestUrl;
    try {
        requestUrl = catalogFeatureRequestUrl(meta);
        showToast(`Loading ${meta.title}...`);
        const response = await fetch(`/proxy?url=${encodeURIComponent(requestUrl)}`);
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || `Feature request failed (${response.status})`);
        if (payload?.type !== 'FeatureCollection' || !Array.isArray(payload.features)) {
            throw new Error('The provider did not return a GeoJSON FeatureCollection.');
        }
        if (!payload.features.length) throw new Error('The provider returned no features for this layer.');

        const index = AppState.fetchedLayers.findIndex(layer => layer.id === meta.id);
        if (index >= 0) {
            AppState.fetchedLayers[index] = { ...meta, geoJsonData: payload };
            renderAvailableLayers();
        }
        return addLayerToMap(meta.id, switchTabAfter);
    } catch (error) {
        console.error('Catalog layer load failed:', error);
        showToast(`Could not load ${meta.title}: ${error.message || error}`, true);
    }
}

const addLayerToMap = (layerId, switchTabAfter = true) => {
    const meta = AppState.fetchedLayers.find(l => l.id === layerId);
    if (!meta) return;

    if (meta.type === 'CKAN') {
        const sel = getEl(`sel-${layerId}`);
        let targetUrl = meta.resources[0].url;
        let targetExt = meta.resources[0].ext;
        
        if (sel) {
            targetUrl = sel.value;
            const selectedOption = sel.options[sel.selectedIndex];
            targetExt = selectedOption.getAttribute('data-ext');
        }
        
        const targetMeta = { ...meta, url: targetUrl, format: targetExt };
        return fetchAndProcessCKANLayer(targetMeta);
    }

    // Assistant catalog records are metadata until the user clicks +. Fetch
    // the actual vector features at that point so the added layer has
    // geometry, attribute-table data, export, and workspace persistence.
    if (meta.catalogResult && !meta.geoJsonData) {
        return fetchCatalogLayerToMap(meta, switchTabAfter);
    }

    let mapLayer, exportUrl = null, isLocalGeoJSON = false, geoJsonData = null, customStyle = null;

    if (AppState.previewLayers[layerId]) {
        map.removeLayer(AppState.previewLayers[layerId]);
        delete AppState.previewLayers[layerId];
    }
    
    const uniqueKey = Math.random().toString(36).substr(2,9);
    const paneName = 'pane-' + uniqueKey;

    if (meta.geoJsonData) {
        isLocalGeoJSON = true;
        geoJsonData = JSON.parse(JSON.stringify(meta.geoJsonData));
        customStyle = { type: 'single', fillColor: '#10b981', fillOpacity: 0.5, color: '#059669', opacity: 1.0, pointShape: 'circle', pointSize: 8 };
        mapLayer = createCustomGeoJSONLayer(geoJsonData, customStyle, paneName);
    } else {
        map.createPane(paneName);
        const baseUrl = meta.serviceUrl || meta.url || AppState.currentServerUrl.split('?')[0];
        const isFeatureServer = meta.serverType === 'FeatureServer' || baseUrl.toLowerCase().includes('featureserver') || (meta.url && meta.url.toLowerCase().includes('featureserver'));
        const layerServerType = String(meta.serverType || meta.type || AppState.currentServerType || '').toUpperCase();

        if (layerServerType === 'WFS') {
          const typeName = meta.layerName || meta.id;
          mapLayer = L.tileLayer.wms(baseUrl, { pane: paneName, layers: typeName, format: 'image/png', transparent: true });
          exportUrl = `${baseUrl}?service=WFS&version=1.1.0&request=GetFeature&typeName=${encodeURIComponent(typeName)}&outputFormat=application%2Fjson&srsName=EPSG:4326`;
        } else {
          if (!isFeatureServer) {
            const layerId = meta.layerId !== undefined ? meta.layerId : meta.id;
            mapLayer = L.esri.dynamicMapLayer({ pane: paneName, url: baseUrl, layers: [layerId], opacity: 0.8 });
            exportUrl = `${baseUrl}/${layerId}/query?where=1=1&outFields=*&f=geojson&outSR=4326`;
          } else {
            const targetUrl = meta.url || (baseUrl.endsWith(`/${meta.id}`) ? baseUrl : `${baseUrl}/${meta.id}`);
            mapLayer = L.esri.featureLayer({ pane: paneName, url: targetUrl });
            exportUrl = `${targetUrl}/query?where=1=1&outFields=*&f=geojson&outSR=4326`;
          }
        }
    }
    
    mapLayer.addTo(map);
    
    AppState.activeLayers = [{ 
      uniqueKey: uniqueKey, id: meta.id, displayName: meta.title, mapLayer, exportUrl, 
      isLocalGeoJSON, geoJsonData, customStyle, isVisible: true, parentId: null, isFolder: false
    }, ...AppState.activeLayers];
    
    updateMapLayerOrder();
    if (switchTabAfter) { renderAddedLayers(); switchTab('added'); showToast(`Added ${meta.title} to map!`); }
};

const handleFetchLayers = async () => {
  const sType = getEl('server-type');
  if (!sType) return;
  AppState.currentServerType = sType.value;
  clearAllPreviews(); 
  
  const fetchSpinner = getEl('btn-fetch-spinner') || getEl('btn-fetch-spinner-url');
  const fetchText = getEl('btn-fetch-text') || getEl('btn-fetch-text-url');
  fetchSpinner?.classList.remove('hidden'); 
  if (fetchText) fetchText.textContent = 'Fetching...';

  switchTab('available');
  if (availableLayerList) {
      availableLayerList.innerHTML = `
          <div class="flex flex-col items-center justify-center py-12 text-blue-600 dark:text-blue-500">
              <i class="fa-solid fa-circle-notch fa-spin text-3xl mb-3 opacity-80"></i>
              <p class="text-xs font-bold uppercase tracking-wider animate-pulse">Scanning Directory...</p>
              <p class="text-[10px] text-gray-500 dark:text-gray-400 mt-2 text-center max-w-[200px]">Large remote catalogs may take up to 15 seconds to fully index.</p>
          </div>
      `;
  }
  searchContainer?.classList.add('hidden');

  try {
    if (AppState.currentServerType === 'OVERPASS') {
        const followup = AppState.osmFeatureFollowup;
        const tagRows = document.querySelectorAll('.osm-tag-row');
        const tags = [];
        tagRows.forEach(row => {
            const key = row.querySelector('.osm-key').value.trim();
            const val = row.querySelector('.osm-val').value.trim();
            if (key) tags.push({ key, val });
        });

        if (tags.length === 0 && followup?.mode !== 'element') throw new Error("Please enter at least one Tag Key.");

        const timeout = parseInt(getEl('osm-timeout')?.value) || 25;
        const maxChunks = parseInt(getEl('osm-max-chunks')?.value) || 16;
        const maxAreaInput = getEl('osm-max-area');
        const maxArea = maxAreaInput ? parseFloat(maxAreaInput.value) : null;
        const loc = getEl('osm-location')?.value.trim();
        const geomType = getEl('osm-geom')?.value;

        const bounds = followup?.scopeBbox || (() => {
            const current = map.getBounds();
            return {
                south: current.getSouth(),
                west: current.getWest(),
                north: current.getNorth(),
                east: current.getEast()
            };
        })();
        const payload = {
            tags, loc, geomType, timeout, maxChunks,
            bbox: {
                south: bounds.south,
                west: bounds.west,
                north: bounds.north,
                east: bounds.east
            }
        };
        if (followup) {
            payload.maxArea = followup.maxAreaKm2 || FOLLOWUP_MAX_AREA_KM2;
            payload.followup = {
                mode: followup.mode,
                identityField: followup.identityField,
                identityValue: followup.identityValue,
                elementType: followup.elementType,
                elementId: followup.elementId,
                scopeBbox: followup.scopeBbox
            };
            if (followup.mode === 'element') {
                payload.osmElement = {
                    type: followup.elementType,
                    id: followup.elementId
                };
            }
        } else if (Number.isFinite(maxArea) && maxArea > 0) {
            payload.maxArea = maxArea;
        }

        if (fetchText) fetchText.textContent = 'Querying Grid...';

        const stopProgressPolling = pollOverpassProgress((latestMsg) => {
            const cellMatch = latestMsg.match(/cell\s+(\d+)\/(\d+)/i) || latestMsg.match(/(\d+)\/(\d+)/);
            if (cellMatch) {
                const current = cellMatch[1] || cellMatch[0].split('/')[0];
                const total = cellMatch[2] || cellMatch[0].split('/')[1];
                setAvailableListStatus(`Grid chunk ${current}/${total}`);
            } else if (/Overpass Grid/i.test(latestMsg)) {
                setAvailableListStatus('Preparing OSM grid...');
            } else if (/Fetching cell/i.test(latestMsg)) {
                setAvailableListStatus('Querying OSM grid...');
            }
        });

        try {
            const response = await fetch('/api/overpass_search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const data = await response.json();
            if (!response.ok) throw new Error(data.error || "Overpass API failed.");
            if (!data.elements || data.elements.length === 0) throw new Error("No data found for this query.");

            stopProgressPolling();
            setAvailableListStatus('Processing OSM results...');

            const geoJson = osmtogeojson(data, { flatProperties: true });
            geoJson.metadata = {
                source: 'OpenStreetMap',
                attribution: '© OpenStreetMap contributors',
                attribution_url: 'https://www.openstreetmap.org/copyright',
                ...(data.metadata || {}),
            };
            geoJson.features.forEach(f => {
                if (f.properties) { 
                    if (f.properties.id) f.properties.osm_id = f.properties.id; 
                    delete f.properties.id; delete f.properties['@id']; 
                    delete f.properties['@relations']; delete f.properties.meta; 
                }
            });
            
            if (geomType === 'lines_polygons') geoJson.features = geoJson.features.filter(f => !['Point', 'MultiPoint'].includes(f.geometry?.type));
            else if (geomType === 'points') geoJson.features = geoJson.features.filter(f => ['Point', 'MultiPoint'].includes(f.geometry?.type));

            if (!geoJson.features || geoJson.features.length === 0) throw new Error("No renderable geometry found.");
            
            if (loc) { 
                try { 
                    const tempLayer = L.geoJSON(geoJson); 
                    const layerBounds = tempLayer.getBounds(); 
                    if(layerBounds.isValid()) map.fitBounds(layerBounds); 
                } catch(e) {} 
            }

            const firstTag = tags[0];
            let layerName = firstTag
                ? `OSM: ${firstTag.key}${firstTag.val ? '=' + firstTag.val : ''}`
                : `OSM: ${followup?.elementType || 'element'} ${followup?.elementId || ''}`;
            if (tags.length > 1) layerName += ` (+${tags.length - 1})`;
            if (followup?.mode === 'named' && followup.identityValue) {
                layerName = `OSM: ${followup.identityValue}`;
            }
            if (loc) layerName = `OSM: ${loc}${firstTag ? ` (${firstTag.key})` : ''}`;

            AppState.fetchedLayers = [{
                id: `osm_${Date.now()}`,
                title: layerName,
                geoJsonData: geoJson,
                source: 'OpenStreetMap',
                provider: 'OpenStreetMap',
                protocol: 'Overpass API',
                provenanceUrl: geoJson.metadata.attribution_url,
                metadata: geoJson.metadata,
                validation: 'validated by Overpass response checks',
                featureCount: geoJson.features.length,
            }];
            AppState.lastFetchedOsmGeoJson = geoJson; 
            AppState.lastFetchedOsmLayerName = layerName;
            
            const toolsContainer = getEl('osm-available-tools');
            if (toolsContainer) { toolsContainer.classList.remove('hidden'); toolsContainer.classList.add('flex'); }

            const cols = new Set();
            geoJson.features.forEach(f => { if(f.properties) Object.keys(f.properties).forEach(k => cols.add(k)); });
            
            const sel = getEl('available-split-col');
            if (sel) {
                sel.innerHTML = '<option value="" disabled selected>Select attribute...</option>';
                Array.from(cols).sort().forEach(c => { sel.innerHTML += `<option value="${c}">${c}</option>`; });
            }

            renderAvailableLayers(); 
            switchTab('available'); 
            showToast(`Fetched & Merged ${geoJson.features.length} OSM features!`);
            if (followup) AppState.osmFeatureFollowup = null;
            return;
        } catch (e) {
            stopProgressPolling();
            throw e;
        } finally {
            stopProgressPolling();
        }
    }

    const sUrl = getEl('server-url');
    const rawUrl = sUrl ? sUrl.value.trim() : '';
    if (!rawUrl) throw new Error("Enter URL.");
    AppState.currentServerUrl = rawUrl; AppState.fetchedLayers = []; 
    if (layerSearch) layerSearch.value = ''; 
    btnClearSearch?.classList.add('hidden');
    
    const toolsContainer = getEl('osm-available-tools');
    if (toolsContainer) { toolsContainer.classList.add('hidden'); toolsContainer.classList.remove('flex'); }

    if (AppState.currentServerType === 'CKAN') {
        try {
            const response = await fetch('/api/ckan_search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: rawUrl })
            });

            const data = await response.json();

            if (!response.ok || !data.success) {
                throw new Error(data.error || "Failed to search CKAN portal");
            }

            AppState.fetchedLayers = data.layers || [];
            
            renderAvailableLayers();
            switchTab('available');
            showToast(`Loaded ${AppState.fetchedLayers.length} CKAN datasets!`);
            return;
        } catch (err) {
            console.error("CKAN fetch error:", err);
            throw new Error(err.message || "Failed to parse CKAN Catalog.");
        }
    }

    if (AppState.currentServerType === 'ARCGIS' || AppState.currentServerType === 'ESRI') {
        try {
            const response = await fetch('/api/esri_search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: rawUrl })
            });

            const data = await response.json();

            if (!response.ok || !data.success) {
                throw new Error(data.error || "Failed to search ArcGIS portal");
            }

            AppState.fetchedLayers = data.layers || [];
            
            renderAvailableLayers();
            switchTab('available');
            showToast(`Loaded ${AppState.fetchedLayers.length} ArcGIS layers!`);
            return;
        } catch (err) {
            console.error("ArcGIS fetch error:", err);
            throw new Error(err.message || "Failed to parse ArcGIS Catalog.");
        }
    }

    let targetUrl = new URL(rawUrl);
    if (AppState.currentServerType === 'WFS') { targetUrl.searchParams.set('service', 'WFS'); targetUrl.searchParams.set('request', 'GetCapabilities'); } 
    else { targetUrl.searchParams.set('f', 'json'); }

    const proxyRes = await fetch(`/proxy?url=${encodeURIComponent(targetUrl.toString())}`);
    if (!proxyRes.ok) {
        let errData;
        try { errData = await proxyRes.json(); } catch(e) {}
        throw new Error((errData && errData.error) ? errData.error : "Proxy error connecting to server.");
    }

    if (AppState.currentServerType === 'WFS') {
      const xml = new DOMParser().parseFromString(await proxyRes.text(), 'text/xml');
      Array.from(xml.getElementsByTagNameNS('*', 'FeatureType')).forEach(node => {
        let name='', title='';
        Array.from(node.children).forEach(c => { if(c.localName==='Name') name=c.textContent; if(c.localName==='Title') title=c.textContent; });
        if(name) AppState.fetchedLayers = [...AppState.fetchedLayers, { id: name, title: title || name }];
      });
    } else {
      const json = await proxyRes.json();
      if(json.layers) AppState.fetchedLayers = json.layers.map(l => ({ id: l.id.toString(), title: l.name }));
      else AppState.fetchedLayers = [...AppState.fetchedLayers, { id: targetUrl.pathname.split('/').pop(), title: json.name || "Layer" }];
    }
    renderAvailableLayers(); switchTab('available');

  } catch(e) {
    showToast(e.message || "Fetch failed. Check console.", true);
    
    if (availableLayerList) {
        availableLayerList.innerHTML = `<p class="text-[11px] text-red-500 font-semibold italic text-center mt-4 px-3">${e.message || "Failed to fetch. Check parameters."}</p>`; 
        searchContainer?.classList.add('hidden');
    }
  } finally {
    fetchSpinner?.classList.add('hidden'); 
    if (fetchText) fetchText.textContent = AppState.currentServerType === 'OVERPASS' ? 'Fetch OSM Data' : 'Fetch Layers';
  }
};

document.querySelectorAll('.btn-trigger-fetch').forEach(btn => btn.addEventListener('click', handleFetchLayers));


// ==========================================
// 7. EVENT LISTENERS
// ==========================================
getEl('toggle-agent')?.addEventListener('click', () => {
    getEl('content-agent')?.classList.toggle('hidden');
    getEl('icon-agent')?.classList.toggle('-rotate-90');
});

getEl('toggle-database')?.addEventListener('click', () => {
    getEl('content-database')?.classList.toggle('hidden');
    getEl('icon-database')?.classList.toggle('-rotate-90');
});

// --- NEW: Console Control Listeners & Resizer ---
const toggleSystemConsole = () => {
    const appConsole = getEl('app-console');
    if (!appConsole) return;

    const shouldOpen = appConsole.hidden || !appConsole.classList.contains('console-open');
    appConsole.hidden = !shouldOpen;
    appConsole.classList.toggle('console-open', shouldOpen);
    appConsole.classList.toggle('console-closed', !shouldOpen);

    if (shouldOpen) {
        const badge = getEl('console-badge');
        if (badge) badge.classList.add('hidden');
        unreadErrors = 0;
    }
    
    updateStacking();
};

// Keep the legacy hook for any external command-palette integration, while
// making the map status bar the visible home for the control.
getEl('btn-toggle-console')?.addEventListener('click', toggleSystemConsole);
btnMapConsole?.addEventListener('click', toggleSystemConsole);

btnMapWorkspace?.addEventListener('click', event => {
    event.stopPropagation();
    mapWorkspaceMenu?.classList.toggle('hidden');
});

document.addEventListener('click', event => {
    if (!mapWorkspaceMenu || mapWorkspaceMenu.classList.contains('hidden')) return;
    if (mapWorkspaceMenu.contains(event.target) || event.target === btnMapWorkspace) return;
    mapWorkspaceMenu.classList.add('hidden');
});

['btn-export-workspace', 'lbl-import-workspace', 'btn-clear-workspace'].forEach(id => {
    getEl(id)?.addEventListener('click', () => mapWorkspaceMenu?.classList.add('hidden'));
});

getEl('btn-close-console')?.addEventListener('click', () => {
    const appConsole = getEl('app-console');
    if (appConsole) {
        appConsole.hidden = true;
        appConsole.classList.remove('console-open');
        appConsole.classList.add('console-closed');
    }
    updateStacking();
});

getEl('btn-clear-console')?.addEventListener('click', () => {
    const output = getEl('console-output');
    if (output) output.innerHTML = '<div class="text-gray-500 italic border-b border-gray-800 pb-1 mb-1">Console cleared.</div>';
    unreadErrors = 0;
    const badge = getEl('console-badge');
    if (badge) badge.classList.add('hidden');
});

const attachConsoleResizer = () => {
    const appConsole = getEl('app-console');
    if (!appConsole) return;
    
    let resizer = appConsole.querySelector('.console-resizer');
    if (!resizer) {
        resizer = document.createElement('div');
        resizer.className = 'console-resizer absolute top-0 left-0 w-full h-1.5 bg-gray-700 hover:bg-blue-500 cursor-row-resize z-[2050] transition-colors';
        appConsole.appendChild(resizer);
    }
    
    let isResizing = false;
    resizer.addEventListener('mousedown', (e) => {
        e.preventDefault();
        isResizing = true;
        document.body.classList.add('select-none', 'cursor-row-resize');

        const startY = e.clientY;
        const startHeight = appConsole.offsetHeight;

        const doDrag = (moveEvt) => {
            if (!isResizing) return;
            
            const attrTable = getEl('attribute-table-container');
            if (attrTable) attrTable.style.transition = 'none';

            const dy = startY - moveEvt.clientY;
            const newHeight = Math.max(100, Math.min(window.innerHeight - 100, startHeight + dy));
            
            appConsole.style.height = `${newHeight}px`;
            updateStacking();
        };

        const stopDrag = () => {
            if (isResizing) {
                isResizing = false;
                document.body.classList.remove('select-none', 'cursor-row-resize');
                window.removeEventListener('mousemove', doDrag);
                window.removeEventListener('mouseup', stopDrag);
                
                const attrTable = getEl('attribute-table-container');
                if (attrTable) attrTable.style.transition = 'bottom 0.3s ease-in-out';
            }
        };

        window.addEventListener('mousemove', doDrag);
        window.addEventListener('mouseup', stopDrag);
    });
};
attachConsoleResizer();


tabBtnAvailable?.addEventListener('click', () => switchTab('available'));
tabBtnAdded?.addEventListener('click', () => switchTab('added'));

savedServersSelect?.addEventListener('change', (e) => {
    const opt = e.target.options[e.target.selectedIndex];
    if (opt.value) {
        const sUrl = getEl('server-url');
        const sType = getEl('server-type');
        if (sUrl) sUrl.value = opt.value;
        if (sType && opt.dataset.type) {
            const normalizedType = normalizeSavedServerType(opt.dataset.type);
            if (normalizedType && Array.from(sType.options).some(option => option.value === normalizedType)) {
                sType.value = normalizedType;
                sType.dispatchEvent(new Event('change'));
            }
        }
    }
});

btnSaveServer?.addEventListener('click', async () => {
    const sUrl = getEl('server-url');
    const sType = getEl('server-type');
    const url = sUrl ? sUrl.value.trim() : '';
    const type = sType ? sType.value : '';
    if (!url) return showToast("Enter a Server URL to save.", true);
    const name = prompt("Enter a recognizable name for this server database:");
    if (!name) return;
    try {
        const res = await fetch('/api/servers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, url, type }) });
        if (res.ok) { showToast("Server added to Database!"); await loadSavedServers(); if (savedServersSelect) savedServersSelect.value = url; }
    } catch (err) { showToast("Failed to save server.", true); }
});

getEl('btn-export-workspace')?.addEventListener('click', () => {
    if (AppState.activeLayers.length === 0) return showToast("No active layers to export in workspace.", true);
    const data = serializeWorkspace();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const dateStr = new Date().toISOString().split('T')[0];
    downloadBlob(blob, `gis_workspace_${dateStr}.json`);
});

getEl('file-import-workspace')?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
        try {
            const data = JSON.parse(evt.target.result);
            if (!data.activeLayers || !data.mapState) throw new Error("Invalid workspace file format.");
            
            isRestoringHistory = true;
            try { restoreWorkspaceState(data); } 
            finally { isRestoringHistory = false; }
            
            autoSaveWorkspace();
            switchTab('added');
            showToast("Workspace restored successfully!");
        } catch (err) { showToast("Failed to parse workspace JSON file.", true); } 
        finally { e.target.value = ''; }
    };
    reader.readAsText(file);
});

getEl('btn-clear-workspace')?.addEventListener('click', async () => {
    if (AppState.activeLayers.length === 0) return;
    if (confirm("Reset workspace? All added layers will be removed from the map.")) {
        closeAllPanels(); clearAllPreviews();
        AppState.currentSoloLayerKey = null;
        
        AppState.activeLayers.forEach(l => { 
            if (!l.isFolder) map.removeLayer(l.mapLayer); 
            releaseRasterObjectUrl(l);
            removePane(l.uniqueKey); 
        });
        AppState.activeLayers = []; 
        
        await clearWorkspaceDB();
        autoSaveWorkspace();
        renderAddedLayers(); 
        showToast("Workspace reset. (You can undo this)");
    }
});

getEl('btn-create-folder')?.addEventListener('click', () => {
    const folderKey = 'folder_' + Math.random().toString(36).substr(2,9);
    AppState.activeLayers = [{
        isFolder: true, uniqueKey: folderKey, displayName: "New Folder",
        isVisible: true, isExpanded: true, parentId: null
    }, ...AppState.activeLayers];
    
    renderAddedLayers();
    autoSaveWorkspace();
    
    setTimeout(() => {
        const span = document.querySelector(`.layer-name-editable[data-key="${folderKey}"]`);
        if (span) {
            span.setAttribute('contenteditable', 'true'); span.focus();
            const selection = window.getSelection(); const range = document.createRange();
            range.selectNodeContents(span); selection.removeAllRanges(); selection.addRange(range);
        }
    }, 50);
});

getEl('server-type')?.addEventListener('change', (e) => {
    const type = e.target.value;
    if (type !== 'OVERPASS' && AppState.osmFeatureFollowup) {
        AppState.osmFeatureFollowup = null;
    }
    const saveBtn = getEl('btn-save-server');
    const urlFetchBtn = getEl('btn-fetch-url');
    const urlContainer = getEl('server-url-container');
    const overpassBuilder = getEl('overpass-builder');
    const localContainer = getEl('local-upload-container');
    const savedServerConfig = getEl('saved-server-config');

    filterSavedServerOptions(type);
    savedServerConfig?.classList.toggle('hidden', type === 'OVERPASS' || type === 'LOCAL');

    if (type === 'OVERPASS') {
        urlContainer?.classList.add('hidden');
        localContainer?.classList.add('hidden');
        overpassBuilder?.classList.remove('hidden');
        overpassBuilder?.classList.add('flex');
        if (urlFetchBtn) urlFetchBtn.classList.add('hidden');
        if (saveBtn) { saveBtn.disabled = true; saveBtn.classList.add('opacity-50'); }
    } else if (type === 'LOCAL') {
        urlContainer?.classList.add('hidden');
        overpassBuilder?.classList.add('hidden');
        overpassBuilder?.classList.remove('flex');
        localContainer?.classList.remove('hidden');
        localContainer?.classList.add('flex');
        if (urlFetchBtn) urlFetchBtn.classList.add('hidden');
    } else {
        urlContainer?.classList.remove('hidden');
        overpassBuilder?.classList.add('hidden');
        overpassBuilder?.classList.remove('flex');
        localContainer?.classList.add('hidden');
        localContainer?.classList.remove('flex');
        if (urlFetchBtn) urlFetchBtn.classList.remove('hidden');
        if (saveBtn) { saveBtn.disabled = false; saveBtn.classList.remove('opacity-50'); }
        const tools = getEl('osm-available-tools');
        if (tools) { tools.classList.add('hidden'); tools.classList.remove('flex'); }
    }
});

// Apply the same visibility rules to the initial selection before any user
// interaction, including a browser-restored form value.
getEl('server-type')?.dispatchEvent(new Event('change'));

btnAddBulk?.addEventListener('click', () => {
  const cbs = document.querySelectorAll('.layer-checkbox:checked');
  if (cbs.length === 0) return showToast("Select at least one layer to add.", true);
  cbs.forEach(cb => { togglePreviewLayer(cb.value, false); cb.checked = false; addLayerToMap(cb.value, false); });
  renderAddedLayers(); switchTab('added'); showToast(`Bulk added ${cbs.length} layers to map!`);
});

getEl('btn-available-split')?.addEventListener('click', () => {
    const splitCol = getEl('available-split-col')?.value;
    if (!splitCol) return showToast("Select an attribute column first.", true);
    const sourceGeoJson = AppState.lastFetchedOsmGeoJson
        || AppState.fetchedLayers.find(layer => layer.geoJsonData?.features)?.geoJsonData;
    if (!sourceGeoJson) return showToast("Load a vector layer before splitting it.", true);

    const layerName = AppState.lastFetchedOsmLayerName || AppState.fetchedLayers.find(layer => layer.geoJsonData)?.title || 'Layer';
    const splitLayers = splitGeoJSONByColumn(sourceGeoJson, splitCol, layerName);
    if (splitLayers.length > 50 && !confirm(`This will unpack ${splitLayers.length} layers into the list below. Proceed?`)) return;
    applySplitToAvailableLayer(sourceGeoJson, splitCol, layerName);
});

layerSearch?.addEventListener('input', triggerSearch);
btnClearSearch?.addEventListener('click', () => { if (layerSearch) { layerSearch.value = ''; triggerSearch(); layerSearch.focus(); } });
addedLayerSearch?.addEventListener('input', triggerAddedSearch);
btnClearAddedSearch?.addEventListener('click', () => { if (addedLayerSearch) { addedLayerSearch.value = ''; triggerAddedSearch(); addedLayerSearch.focus(); } });
filterDataSearch?.addEventListener('input', triggerFilterDataSearch);
btnClearFilterSearch?.addEventListener('click', () => { if (filterDataSearch) { filterDataSearch.value = ''; triggerFilterDataSearch(); filterDataSearch.focus(); } });
btnCloseInspect?.addEventListener('click', () => {
    getEl('osm-inspect-container')?.classList.add('hidden');
    getEl('osm-inspect-container')?.classList.remove('flex');
    if (AppState.drawingMode === 'inspect') {
        AppState.drawingMode = null;
        map.getContainer().style.cursor = '';
        drawLayerGroup.clearLayers();
    }
});

btnDraw?.addEventListener('click', () => {
  if (!filterType) return;
  AppState.drawingMode = filterType.value; drawLayerGroup.clearLayers(); AppState.filterGeometryData = null;
  if (btnApplyFilter) btnApplyFilter.disabled = true; map.getContainer().style.cursor = 'crosshair'; drawStatus?.classList.remove('hidden');
});

map.on('mousedown', (e) => {
  if (AppState.drawingMode === 'box' || AppState.drawingMode === 'inspect') { 
      drawLayerGroup.clearLayers(); map.dragging.disable(); AppState.drawStart = e.latlng; 
      const color = AppState.drawingMode === 'inspect' ? '#2563eb' : '#0d9488'; 
      AppState.tempShape = L.rectangle([AppState.drawStart, AppState.drawStart], { color: color, weight: 2, fillOpacity: 0.2 }).addTo(drawLayerGroup); 
  }
});

map.on('mousemove', (e) => { 
    if ((AppState.drawingMode === 'box' || AppState.drawingMode === 'inspect') && AppState.tempShape) AppState.tempShape.setBounds([AppState.drawStart, e.latlng]); 
});

map.on('mouseup', (e) => {
  if (AppState.drawingMode === 'box' && AppState.tempShape) { 
      map.dragging.enable(); AppState.filterGeometryData = AppState.tempShape.getBounds(); AppState.drawingMode = null; map.getContainer().style.cursor = ''; checkApplyButton(); 
  } else if (AppState.drawingMode === 'inspect' && AppState.tempShape) {
      map.dragging.enable(); 
      const bounds = AppState.tempShape.getBounds();
      AppState.drawingMode = null; map.getContainer().style.cursor = '';
      executeOsmInspect(bounds);
      setTimeout(() => drawLayerGroup.clearLayers(), 800); 
  }
});

map.on('click', (e) => {
  if (AppState.drawingMode === 'radius') {
    drawLayerGroup.clearLayers(); AppState.drawStart = e.latlng;
    const radKm = parseFloat(filterRadius?.value) || 5;
    AppState.tempShape = L.circle(AppState.drawStart, { radius: radKm * 1000, color: '#0d9488', weight: 2, fillOpacity: 0.2 }).addTo(drawLayerGroup);
    L.marker(AppState.drawStart).addTo(drawLayerGroup); AppState.filterGeometryData = AppState.drawStart; AppState.drawingMode = null; map.getContainer().style.cursor = ''; checkApplyButton();
  }
});

filterRadius?.addEventListener('input', checkApplyButton);

filterType?.addEventListener('change', (e) => {
  const type = e.target.value;
  const layer = AppState.activeLayers.find(l => l.uniqueKey === AppState.activeCropLayerKey);
  
  filterRadius?.classList.add('hidden');
  filterDataContainer?.classList.add('hidden');
  filterDataContainer?.classList.remove('flex');
  btnDraw?.classList.remove('hidden');
  drawStatus?.classList.remove('hidden');
  
  if (type === 'radius') {
    filterRadius?.classList.remove('hidden');
    if (drawStatus) drawStatus.textContent = 'Click on map to set center point.';
  } else if (type === 'box') {
    if (drawStatus) drawStatus.textContent = 'Click & drag on map to draw box.';
  } else if (type === 'data') {
    btnDraw?.classList.add('hidden');
    filterDataContainer?.classList.remove('hidden');
    filterDataContainer?.classList.add('flex');
    if (layer) triggerDataFilterSetup(layer);
  }
  checkApplyButton();
});

filterDataCol?.addEventListener('change', (e) => {
    const col = e.target.value;
    const layer = AppState.activeLayers.find(l => l.uniqueKey === AppState.activeCropLayerKey);
    if (!layer || !col) return;
    
    if (filterDataSearch) filterDataSearch.value = '';
    btnClearFilterSearch?.classList.add('hidden');

    let uniqueVals = [...new Set(layer.geoJsonData.features.map(f => f.properties ? f.properties[col] : undefined))];
    uniqueVals = uniqueVals.filter(v => v !== null && v !== undefined).sort();

    if (!filterDataValues) return;
    if (uniqueVals.length === 0) {
        filterDataValues.innerHTML = '<p class="text-xs text-gray-400 dark:text-gray-500 italic text-center">No unique values found.</p>';
        return;
    }

    let html = '<div class="flex flex-col space-y-0.5">';
    uniqueVals.forEach(val => {
        html += `
            <label class="flex items-center space-x-1.5 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700 p-0.5 rounded transition-colors">
                <input type="checkbox" class="filter-data-val-cb w-3 h-3 text-blue-600 dark:text-blue-500 rounded accent-blue-600 dark:accent-blue-500" value="${val}">
                <span class="truncate dark:text-gray-300" title="${val}">${val}</span>
            </label>
        `;
    });
    html += '</div>';
    filterDataValues.innerHTML = html;

    document.querySelectorAll('.filter-data-val-cb').forEach(cb => {
        cb.addEventListener('change', checkApplyButton);
    });
    checkApplyButton();
});

getEl('btn-filter-select-all')?.addEventListener('click', () => {
    const visibleLabels = Array.from(document.querySelectorAll('#filter-data-values label:not(.hidden)'));
    const cbs = visibleLabels.map(l => l.querySelector('.filter-data-val-cb')).filter(Boolean);
    if (cbs.length === 0) return;
    
    const allChecked = cbs.every(cb => cb.checked);
    cbs.forEach(cb => cb.checked = !allChecked); 
    checkApplyButton();
});

btnApplyFilter?.addEventListener('click', async () => {
  const targetLayer = AppState.activeLayers.find(l => l.uniqueKey === AppState.activeCropLayerKey);
  if (!targetLayer) return;
  if (filterType?.value !== 'data' && !targetLayer.exportUrl && !targetLayer.isLocalGeoJSON) return showToast("Cannot filter this layer from server.", true);

  const filterText = getEl('btn-filter-text');
  const filterSpinner = getEl('btn-filter-spinner');
  if (filterText) filterText.textContent = 'Filtering...';
  filterSpinner?.classList.remove('hidden');
  btnApplyFilter.disabled = true;

  try {
    let finalFeatures = [];
    if (filterType?.value === 'data') {
        const col = filterDataCol?.value;
        const selectedVals = Array.from(document.querySelectorAll('.filter-data-val-cb:checked')).map(cb => cb.value);
        finalFeatures = targetLayer.geoJsonData.features.filter(f => f.properties && selectedVals.includes(String(f.properties[col])));
    } else {
        if (targetLayer.isLocalGeoJSON) {
            let b; 
            if (filterType?.value === 'box') {
               b = AppState.filterGeometryData;
               const turfBbox = turf.bboxPolygon([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
               finalFeatures = targetLayer.geoJsonData.features.filter(f => { try { return turf.booleanIntersects(f, turfBbox); } catch(e) { return false; } });
            } else {
               const radKm = parseFloat(filterRadius?.value) || 5;
               const turfCircle = turf.circle([AppState.filterGeometryData.lng, AppState.filterGeometryData.lat], radKm, {units: 'kilometers'});
               finalFeatures = targetLayer.geoJsonData.features.filter(f => { try { return turf.booleanIntersects(f, turfCircle); } catch(e) { return false; } });
            }
        } else {
            let queryUrl = targetLayer.exportUrl;
            let b; 
            if (filterType?.value === 'box') b = AppState.filterGeometryData; 
            else b = AppState.filterGeometryData.toBounds((parseFloat(filterRadius?.value) || 5) * 1000); 

            if (queryUrl.includes('WFS') || queryUrl.includes('GetFeature')) queryUrl += `&bbox=${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()},EPSG:4326`;
            else queryUrl += `&geometry=${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}&geometryType=esriGeometryEnvelope&spatialRel=esriSpatialRelWithin&inSR=4326`;

            const res = await fetch(`/proxy?url=${encodeURIComponent(queryUrl)}`);
            const rawGeojson = await res.json();
            let fetchedFeatures = rawGeojson.features || [];

            if (filterType?.value === 'box') {
                const turfBbox = turf.bboxPolygon([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
                finalFeatures = fetchedFeatures.filter(f => { try { return turf.booleanIntersects(f, turfBbox); } catch(e) { return false; } });
            } else if (filterType?.value === 'radius') {
                const radKm = parseFloat(filterRadius?.value) || 5;
                const turfCircle = turf.circle([AppState.filterGeometryData.lng, AppState.filterGeometryData.lat], radKm, {units: 'kilometers'});
                finalFeatures = fetchedFeatures.filter(f => { try { return turf.booleanIntersects(f, turfCircle); } catch(e) { return false; } });
            }
        }
    }

    if (finalFeatures.length === 0) { showToast("Filter resulted in 0 features.", true); return; }

    const newGeoJsonData = { type: "FeatureCollection", features: finalFeatures };
    const newStyleState = targetLayer.customStyle ? JSON.parse(JSON.stringify(targetLayer.customStyle)) : { type: 'single', fillColor: '#2563eb', fillOpacity: 0.5, color: '#2563eb', opacity: 1.0, pointShape: 'circle', pointSize: 8 };

    const uniqueKey = Math.random().toString(36).substr(2,9);
    const paneName = 'pane-' + uniqueKey;

    const newMapLayer = createCustomGeoJSONLayer(newGeoJsonData, newStyleState, paneName).addTo(map);
    map.fitBounds(newMapLayer.getBounds());

    const namePrefix = filterType?.value === 'data' ? '[Filtered]' : '[Cropped]';
    AppState.activeLayers = [{ uniqueKey: uniqueKey, id: `${targetLayer.id}_filtered`, displayName: `${namePrefix} ${targetLayer.displayName}`, mapLayer: newMapLayer, exportUrl: null, isLocalGeoJSON: true, geoJsonData: newGeoJsonData, customStyle: newStyleState, isVisible: true, parentId: targetLayer.parentId || null, isFolder: false }, ...AppState.activeLayers];
    if (targetLayer.isVisible) { targetLayer.isVisible = false; map.removeLayer(targetLayer.mapLayer); }

    closeSidebarPanels(); renderAddedLayers(); updateMapLayerOrder();
    showToast(`Created new filtered layer with ${finalFeatures.length} features.`);

  } catch(err) {
    showToast("Filter failed. Server might restrict spatial queries.", true);
  } finally {
    if (filterText) filterText.textContent = 'Apply Filter'; 
    filterSpinner?.classList.add('hidden'); 
    btnApplyFilter.disabled = false;
  }
});


// ==========================================
// 8. APP BOOTSTRAP
// ==========================================
const btnUndoDom = getEl('btn-undo');
const btnRedoDom = getEl('btn-redo');
const addedSearchContainerDOM = getEl('added-search-container');
const searchInputDiv = getEl('added-layer-search')?.parentElement;
if (addedSearchContainerDOM && btnUndoDom && btnRedoDom && searchInputDiv) {
    addedSearchContainerDOM.insertBefore(btnRedoDom, searchInputDiv);
    addedSearchContainerDOM.insertBefore(btnUndoDom, btnRedoDom);
}

const updateRemoveButtons = () => {
    const rows = document.querySelectorAll('.osm-tag-row');
    rows.forEach((row) => {
        const remBtn = row.querySelector('.btn-remove-tag');
        if (rows.length === 1) {
            remBtn.disabled = true;
            remBtn.classList.add('opacity-50', 'cursor-not-allowed');
        } else {
            remBtn.disabled = false;
            remBtn.classList.remove('opacity-50', 'cursor-not-allowed');
        }
    });
};

const setupTagButtons = () => {
    const container = getEl('osm-tags-container');
    if (!container) return;

    container.addEventListener('click', (e) => {
        const addBtn = e.target.closest('.btn-add-tag');
        const remBtn = e.target.closest('.btn-remove-tag');

        if (addBtn) {
            const newRow = createOsmTagRow();
            container.appendChild(newRow);
            updateRemoveButtons();
        }

        if (remBtn && !remBtn.disabled) {
            const row = remBtn.closest('.osm-tag-row');
            if (row) {
                row.remove();
                updateRemoveButtons();
            }
        }
    });
};

const initOsmDatalists = () => {
    setupTagButtons();
    const keysList = getEl('osm-keys');
    if (keysList) keysList.innerHTML = Object.keys(commonOsmTags).map(k => `<option value="${k}">`).join('');

    document.addEventListener('input', (e) => {
        if (e.target.classList.contains('osm-key')) {
            const key = e.target.value.toLowerCase().trim();
            const valuesList = getEl('osm-values');
            if (valuesList) {
                const values = commonOsmTags[key] || ['yes'];
                valuesList.innerHTML = values.map(v => `<option value="${v}">`).join('');
            }
        }
    });
};

loadSavedServers();
initOsmDatalists();
renderCommandPalette('');

btnCommandPalette?.addEventListener('click', () => openCommandPalette());
btnCommandPaletteClose?.addEventListener('click', () => closeCommandPalette());
commandPalette?.addEventListener('click', (e) => {
    if (e.target === commandPalette) closeCommandPalette();
});
commandPaletteSearch?.addEventListener('input', (e) => renderCommandPalette(e.target.value || ''));
commandPaletteSearch?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeCommandPalette();
});
window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        openCommandPalette();
    }
    if (e.key === 'Escape') closeCommandPalette();
});

map.on('moveend', () => {
    autoSaveWorkspace();
});

map.on('zoomend', () => {
    autoSaveWorkspace();
});


// ==========================================
// 9. SIDEBAR HORIZONTAL RESIZER
// ==========================================
const initSidebarResizer = () => {
    const leftPanel = getEl('left-panel');
    const resizer = getEl('sidebar-resizer');
    if (!leftPanel || !resizer) return;

    const minWidth = leftPanel.offsetWidth || 320;
    let isResizing = false;

    const syncMapStatusBarPosition = () => {
        if (!mapStatusBar) return;
        const isDesktop = window.matchMedia?.('(min-width: 768px)').matches;
        const mapPanel = getEl('map')?.parentElement;
        const mapRect = mapPanel?.getBoundingClientRect?.();
        const mapLeft = isDesktop
            ? leftPanel.getBoundingClientRect().right
            : 0;
        mapStatusBar.style.setProperty('--map-status-left', `${Math.max(0, mapLeft)}px`);

        const appConsole = getEl('app-console');
        if (appConsole && mapRect) {
            appConsole.style.left = `${Math.max(0, mapLeft)}px`;
            appConsole.style.right = `${Math.max(0, window.innerWidth - mapRect.right)}px`;
        }
    };

    syncMapStatusBarPosition();
    window.addEventListener('resize', syncMapStatusBarPosition);

    resizer.addEventListener('mousedown', (e) => {
        e.preventDefault();
        isResizing = true;
        document.body.classList.add('select-none', 'cursor-col-resize');

        const doDrag = (moveEvt) => {
            if (!isResizing) return;
            const newWidth = Math.max(minWidth, moveEvt.clientX);
            leftPanel.style.width = `${newWidth}px`;
            // Update both overlays during the drag, not only after mouseup.
            // This prevents a strip of map/resizer pixels appearing between
            // the sidebar and the bottom bar.
            syncMapStatusBarPosition();
        };

        const stopDrag = () => {
            if (isResizing) {
                isResizing = false;
                document.body.classList.remove('select-none', 'cursor-col-resize');
            window.removeEventListener('mousemove', doDrag);
            window.removeEventListener('mouseup', stopDrag);
            syncMapStatusBarPosition();
            map.invalidateSize();
            }
        };

        window.addEventListener('mousemove', doDrag);
        window.addEventListener('mouseup', stopDrag);
    });
};
initSidebarResizer();


// ==========================================
// 10. SUBMENU VERTICAL RESIZER
// ==========================================
const initContextPanelResizer = () => {
    const wrapper = getEl('context-panel-wrapper');
    const resizer = getEl('context-resizer');
    if (!wrapper || !resizer) return;

    let isResizing = false;

    resizer.addEventListener('mousedown', (e) => {
        e.preventDefault();
        isResizing = true;
        document.body.classList.add('select-none', 'cursor-row-resize');

        const startY = e.clientY;
        const startHeight = wrapper.offsetHeight;

        const doDrag = (moveEvt) => {
            if (!isResizing) return;
            const dy = startY - moveEvt.clientY;
            const maxDragHeight = window.innerHeight * 0.85;
            const newHeight = Math.max(120, Math.min(maxDragHeight, startHeight + dy));
            
            wrapper.style.maxHeight = 'none';
            wrapper.style.height = `${newHeight}px`;
        };

        const stopDrag = () => {
            if (isResizing) {
                isResizing = false;
                document.body.classList.remove('select-none', 'cursor-row-resize');
                window.removeEventListener('mousemove', doDrag);
                window.removeEventListener('mouseup', stopDrag);
            }
        };

        window.addEventListener('mousemove', doDrag);
        window.addEventListener('mouseup', stopDrag);
    });
};
initContextPanelResizer();

// ==========================================
// 11. MAP SEARCH GEOCODER CONTROL
// ==========================================
const executeMapSearch = async () => {
    const input = getEl('map-search-input');
    if (!input) return;
    const term = input.value.trim();
    if (!term) return;

    const btn = getEl('map-search-btn');
    const spinner = getEl('map-search-spinner');

    if (btn) btn.classList.add('hidden');
    if (spinner) spinner.classList.remove('hidden');

    try {
        const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(term)}&format=json&limit=1`);
        if (!res.ok) throw new Error("Search API failed");
        const data = await res.json();
        
        if (data && data.length > 0) {
            const place = data[0];
            if (place.boundingbox) {
                map.fitBounds([
                    [place.boundingbox[0], place.boundingbox[2]],
                    [place.boundingbox[1], place.boundingbox[3]]
                ]);
            } else {
                map.setView([place.lat, place.lon], 13);
            }
            showToast(`Jumped to: ${place.display_name.split(',')[0]}`);
        } else {
            showToast("Location not found.", true);
        }
    } catch (err) {
        showToast("Search failed.", true);
    } finally {
        if (btn) btn.classList.remove('hidden');
        if (spinner) spinner.classList.add('hidden');
    }
};

const GeoSearchControl = L.Control.extend({
    options: { position: 'topleft' }, 
    onAdd: function () {
        const container = L.DomUtil.create('div', 'leaflet-control flex bg-white dark:bg-gray-800 rounded border border-gray-300 dark:border-gray-600 shadow-sm overflow-hidden cursor-auto');
        L.DomEvent.disableClickPropagation(container);

        container.innerHTML = `
            <div class="flex items-center px-2 py-1.5 h-full">
                <i class="fa-solid fa-location-dot text-gray-400 dark:text-gray-500 mr-2 text-[11px]"></i>
                <input type="text" id="map-search-input" placeholder="Jump to location..." class="w-32 md:w-48 border-none focus:outline-none bg-transparent text-[11px] text-gray-700 dark:text-gray-200 p-0 m-0 leading-none h-full placeholder-gray-400">
                <button id="map-search-btn" class="text-gray-500 hover:text-blue-600 dark:hover:text-blue-400 transition-colors ml-1 flex items-center h-full cursor-pointer" title="Search">
                    <i class="fa-solid fa-magnifying-glass text-[11px]"></i>
                </button>
                <i id="map-search-spinner" class="fa-solid fa-circle-notch fa-spin text-blue-600 dark:text-blue-400 text-[11px] hidden ml-1"></i>
            </div>
        `;
        
        setTimeout(() => {
            getEl('map-search-btn')?.addEventListener('click', executeMapSearch);
            getEl('map-search-input')?.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    executeMapSearch();
                }
            });
        }, 100);

        return container;
    }
});

const searchControlInstance = new GeoSearchControl();
map.addControl(searchControlInstance);

const searchNode = searchControlInstance.getContainer();
if (searchNode && searchNode.parentNode) {
    const mapPanel = map.getContainer().parentElement;
    searchNode.parentNode.removeChild(searchNode);
    mapPanel?.appendChild(searchNode);
    searchNode.classList.add('gis-map-search-control');
}

// ==========================================
// 12. OFFLINE CACHING: INDEXEDDB HELPERS
// ==========================================
function initWorkspaceDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open("GIS_Workspace_DB", 1);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('workspace')) {
                db.createObjectStore('workspace');
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function persistStateToDB(stateObj) {
    try {
        const cleanState = JSON.parse(JSON.stringify(stateObj));
        const db = await initWorkspaceDB();
        const tx = db.transaction('workspace', 'readwrite');
        tx.objectStore('workspace').put(cleanState, 'latest_state');
    } catch (e) {
        console.error("IndexedDB write error:", e);
    }
}

async function loadStateFromDB() {
    const db = await initWorkspaceDB();
    return new Promise((resolve) => {
        const tx = db.transaction('workspace', 'readonly');
        const req = tx.objectStore('workspace').get('latest_state');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
    });
}

async function restoreLegacyLayerCache() {
    const cachedLayers = await getCachedLayers();
    if (!Array.isArray(cachedLayers) || cachedLayers.length === 0) return false;

    const activeLayers = cachedLayers.map(layer => ({
        uniqueKey: layer.layerKey,
        displayName: layer.name || layer.layerKey,
        layerType: layer.type,
        geoJsonData: layer.geoJsonData,
        customStyle: layer.style,
        isVisible: layer.visible ?? true,
        isFolder: false,
        parentId: null
    }));
    restoreWorkspaceState({ activeLayers }, { restoreMapView: false });
    return AppState.activeLayers.length > 0;
}

// --- RESTORE ON REFRESH ---
window.addEventListener('DOMContentLoaded', async () => {
    try {
        const savedState = await loadStateFromDB();
        if (savedState && savedState.activeLayers && savedState.activeLayers.length > 0) {
            console.log("Restoring workspace from IndexedDB...");
            isRestoringHistory = true; 
            try {
                const repairedMapView = restoreWorkspaceState(savedState);
                if (repairedMapView) autoSaveWorkspace();
            } finally {
                isRestoringHistory = false; 
            }
        } else if (!(await restoreLegacyLayerCache())) {
            autoSaveWorkspace();
        }
    } catch (e) {
        console.error("Failed to restore workspace from IndexedDB:", e);
        // Never replace a potentially recoverable IndexedDB record with an
        // empty workspace after a restore error.
    }
});

async function clearWorkspaceDB() {
    const db = await initWorkspaceDB();
    const tx = db.transaction('workspace', 'readwrite');
    tx.objectStore('workspace').clear();
}

// ==========================================
// 13. SERVICE WORKER REGISTRATION
// ==========================================
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
            .then(reg => {
                reg.update().catch(() => {});
                console.log('Service Worker registered with scope:', reg.scope);
            })
            .catch(err => console.error('Service Worker registration failed:', err));
    });
}

// ==========================================
// 14. LOCAL FILE UPLOAD & PARSING
// ==========================================
let pendingRasterPngFile = null;
let pendingRasterPgwFile = null;

const rasterFileStem = file => file.name.replace(/\.(png|pgw)$/i, '').toLowerCase();

const loadRasterImageDimensions = async file => {
    if (typeof createImageBitmap === 'function') {
        try {
            const bitmap = await createImageBitmap(file);
            const dimensions = { width: bitmap.width, height: bitmap.height };
            bitmap.close?.();
            return dimensions;
        } catch (error) {
            console.warn('createImageBitmap failed; falling back to HTML image decoding.', error);
        }
    }

    const objectUrl = URL.createObjectURL(file);
    try {
        return await new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
            image.onerror = () => reject(new Error('The PNG could not be decoded.'));
            image.src = objectUrl;
        });
    } finally {
        URL.revokeObjectURL(objectUrl);
    }
};

const loadRasterDataUrl = file => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('The PNG could not be read.'));
    reader.readAsDataURL(file);
});

const processGeoReferencedPng = async (pngFile, pgwFile) => {
    if (rasterFileStem(pngFile) !== rasterFileStem(pgwFile)) {
        throw new Error('The PNG and PGW must have the same base filename.');
    }

    const pgw = parsePgwText(await pgwFile.text());
    const dimensions = await loadRasterImageDimensions(pngFile);
    const bounds = pgwToEpsg3857Bounds(pgw, dimensions.width, dimensions.height);
    const rasterDataUrl = await loadRasterDataUrl(pngFile);
    const uniqueKey = Math.random().toString(36).substr(2, 9);
    const paneName = 'pane-' + uniqueKey;
    let mapLayer = null;

    try {
        if (!map.getPane(paneName)) map.createPane(paneName);
        mapLayer = L.imageOverlay(rasterDataUrl, bounds, {
            pane: paneName,
            opacity: 0.8,
            interactive: false,
        }).addTo(map);

        AppState.activeLayers = [{
            uniqueKey,
            id: `raster_${Date.now()}`,
            displayName: pngFile.name.replace(/\.png$/i, ''),
            mapLayer,
            exportUrl: null,
            isLocalGeoJSON: false,
            isRasterImage: true,
            rasterOpacity: 0.8,
            rasterDataUrl,
            rasterCrs: 'EPSG:3857',
            rasterBounds: bounds,
            geoJsonData: null,
            customStyle: null,
            isVisible: true,
            parentId: null,
            isFolder: false,
        }, ...AppState.activeLayers];

        // The bounds have already been validated in EPSG:3857 before this
        // changes the view. This fit can therefore never poison the persisted
        // map state with projected metre coordinates.
        map.fitBounds(bounds, { padding: [30, 30], maxZoom: 19 });
        updateMapLayerOrder();
        renderAddedLayers();
        switchTab('added');
        showToast(`Imported EPSG:3857 image: ${pngFile.name}`);
    } catch (error) {
        if (mapLayer) map.removeLayer(mapLayer);
        removePane(uniqueKey);
        throw error;
    }
};

const stageRasterFile = async file => {
    const extension = file.name.split('.').pop().toLowerCase();
    if (extension === 'png') {
        if (pendingRasterPgwFile) {
            const pgwFile = pendingRasterPgwFile;
            pendingRasterPgwFile = null;
            if (rasterFileStem(file) === rasterFileStem(pgwFile)) {
                await processGeoReferencedPng(file, pgwFile);
                return;
            }
            pendingRasterPgwFile = pgwFile;
            throw new Error('The selected PNG does not match the pending PGW file.');
        }
        pendingRasterPngFile = file;
        showToast(`PNG selected. Now choose the matching .pgw file for ${file.name}.`);
        return;
    }

    if (extension === 'pgw') {
        if (pendingRasterPngFile) {
            const pngFile = pendingRasterPngFile;
            pendingRasterPngFile = null;
            if (rasterFileStem(file) === rasterFileStem(pngFile)) {
                await processGeoReferencedPng(pngFile, file);
                return;
            }
            pendingRasterPngFile = pngFile;
            throw new Error('The selected PGW does not match the pending PNG file.');
        }
        pendingRasterPgwFile = file;
        showToast(`PGW selected. Now choose the matching .png file for ${file.name}.`);
    }
};

const processLocalFiles = async files => {
    const rasterFiles = files.filter(file => /\.(png|pgw)$/i.test(file.name));
    if (rasterFiles.length > 0) {
        if (rasterFiles.length === 2 && rasterFiles.some(file => /\.png$/i.test(file.name)) && rasterFiles.some(file => /\.pgw$/i.test(file.name))) {
            pendingRasterPngFile = null;
            pendingRasterPgwFile = null;
            await processGeoReferencedPng(
                rasterFiles.find(file => /\.png$/i.test(file.name)),
                rasterFiles.find(file => /\.pgw$/i.test(file.name)),
            );
        } else if (rasterFiles.length === 1) {
            await stageRasterFile(rasterFiles[0]);
        } else {
            throw new Error('Select one matching PNG and PGW pair.');
        }
        return;
    }

    await processLocalFile(files[0]);
};

getEl('local-file-input')?.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    
    showToast(`Processing local file${files.length > 1 ? 's' : ''}...`);
    try {
        await processLocalFiles(files);
    } catch (err) {
        console.error('Error importing local file:', err);
        showToast(`Failed to import file: ${err.message}`, true);
    }
    
    e.target.value = ''; 
});

async function processLocalFile(file) {
    const name = file.name;
    const ext = name.split('.').pop().toLowerCase();
    
    try {
        if (ext === 'png' || ext === 'pgw') {
            await stageRasterFile(file);
            return;
        }

        let geoJson = null;
        
        if (ext === 'geojson' || ext === 'json') {
            const text = await file.text();
            geoJson = JSON.parse(text);
        }
        else if (ext === 'kml') {
            const text = await file.text();
            const xml = new DOMParser().parseFromString(text, 'text/xml');
            geoJson = toGeoJSON.kml(xml);
        }
        else if (ext === 'zip') {
            const buffer = await file.arrayBuffer();
            geoJson = await shp(buffer);
            
            if (Array.isArray(geoJson)) {
                const mergedFeatures = [];
                geoJson.forEach(gj => {
                    if (gj && gj.features) mergedFeatures.push(...gj.features);
                });
                geoJson = { type: "FeatureCollection", features: mergedFeatures };
            }
        }
        else if (ext === 'csv') {
            const text = await file.text();
            geoJson = await parseCSVtoGeoJSON(text);
        }
        else {
            return showToast(`Unsupported file type: .${ext}`, true);
        }

        if (!geoJson || !geoJson.features || geoJson.features.length === 0) {
            throw new Error("No valid spatial features found in file.");
        }

        addLocalGeoJsonToMap(geoJson, name.replace(/\.[^/.]+$/, ""));
        
    } catch (err) {
        console.error("Error parsing file:", err);
        showToast(`Failed to parse ${name}: ${err.message}`, true);
    }
}

function parseCSVtoGeoJSON(csvText) {
    return new Promise((resolve, reject) => {
        Papa.parse(csvText, {
            header: true, skipEmptyLines: true,
            complete: function(results) {
                const data = results.data;
                const features = [];
                let latCol = null, lonCol = null;
                
                if (data.length > 0) {
                    const cols = Object.keys(data[0]);
                    const latAliases = ['lat', 'latitude', 'y', 'ycoord'];
                    const lonAliases = ['lon', 'long', 'longitude', 'x', 'xcoord'];
                    
                    latCol = cols.find(c => latAliases.includes(c.toLowerCase().trim()));
                    lonCol = cols.find(c => lonAliases.includes(c.toLowerCase().trim()));
                }
                
                if (!latCol || !lonCol) return reject(new Error("Could not detect Latitude/Longitude columns in CSV."));
                
                data.forEach(row => {
                    const lat = parseFloat(row[latCol]);
                    const lon = parseFloat(row[lonCol]);
                    
                    if (!isNaN(lat) && !isNaN(lon)) {
                        features.push({
                            type: "Feature",
                            geometry: { type: "Point", coordinates: [lon, lat] },
                            properties: { ...row }
                        });
                    }
                });
                
                if (features.length === 0) reject(new Error("No valid coordinate pairs found in CSV."));
                else resolve({ type: "FeatureCollection", features: features });
            },
            error: function(err) { reject(err); }
        });
    });
}

function addLocalGeoJsonToMap(geoJsonData, layerName) {
    const uniqueKey = Math.random().toString(36).substr(2,9);
    const paneName = 'pane-' + uniqueKey;
    
    const customStyle = { type: 'single', fillColor: '#8b5cf6', fillOpacity: 0.5, color: '#6d28d9', opacity: 1.0, pointShape: 'circle', pointSize: 8 };
    
    const newMapLayer = createCustomGeoJSONLayer(geoJsonData, customStyle, paneName).addTo(map);
    
    try {
        const bounds = newMapLayer.getBounds();
        if (bounds.isValid()) map.fitBounds(bounds, { padding: [30, 30] });
    } catch(e) {}
    
    AppState.activeLayers = [{ 
        uniqueKey: uniqueKey, id: `local_${Date.now()}`, displayName: layerName, 
        mapLayer: newMapLayer, exportUrl: null, isLocalGeoJSON: true, 
        geoJsonData: geoJsonData, customStyle: customStyle, isVisible: true, 
        parentId: null, isFolder: false
    }, ...AppState.activeLayers];
    
    updateMapLayerOrder();
    renderAddedLayers();
    switchTab('added');
    showToast(`Successfully imported local file: ${layerName}`);
}

// ==========================================
// 15. CKAN PROXY DOWNLOADER
// ==========================================
async function fetchAndProcessCKANLayer(meta) {
    showToast(`Downloading ${meta.title}...`);
    
    try {
        const ext = meta.format || 'geojson';
        const proxyUrl = `/proxy?url=${encodeURIComponent(meta.url)}&format=${ext}`;
        const response = await fetch(proxyUrl);
        
        if (!response.ok) {
            let errMsg = `${response.status} ${response.statusText}`;
            try {
                const errData = await response.json();
                errMsg = errData.error || errMsg;
            } catch(e) {}
            throw new Error(errMsg);
        }

        const blob = await response.blob();
        
        const fileExt = (ext === 'gpkg') ? 'geojson' : ext;
        const fileName = `${meta.name.replace(/[^a-z0-9]/gi, '_')}.${fileExt}`;
        const syntheticFile = new File([blob], fileName, { type: blob.type });

        await processLocalFile(syntheticFile);
        
    } catch (err) {
        console.error("CKAN Download Error:", err);
        showToast(`Failed to download: ${err.message}`, true);
    }
}

function setAvailableListStatus(message, isLoading = true) {
    if (!availableLayerList) return;
    const spinner = isLoading ? '<i class="fa-solid fa-circle-notch fa-spin text-3xl mb-3 opacity-80"></i>' : '';
    const text = message || 'Scanning Directory...';
    availableLayerList.innerHTML = '<div class="flex flex-col items-center justify-center py-12 text-blue-600 dark:text-blue-500">' + spinner + '<p class="text-xs font-bold uppercase tracking-wider animate-pulse">' + text + '</p><p class="text-[10px] text-gray-500 dark:text-gray-400 mt-2 text-center max-w-[200px]">Large remote catalogs may take up to 15 seconds to fully index.</p></div>';
}

function pollOverpassProgress(onMessage) {
    let timer = null;
    const tick = async () => {
        try {
            const res = await fetch('/api/logs');
            if (!res.ok) return;
            const data = await res.json();
            if (!data.logs || !data.logs.length) return;
            // This poller used to forward only the last message to the layer
            // status and silently discard the rest. Forward every server line
            // to the System Console so chunk/server diagnostics are preserved.
            data.logs.forEach(logMessage => {
                showToast(logMessage, false, true);
                onMessage(logMessage);
            });
        } catch (e) {}
    };
    timer = setInterval(tick, 400);
    return () => {
        if (timer) clearInterval(timer);
    };
}

// ==========================================
// 16. RENDERED ROAD QUERY HELPERS
// ==========================================

const roadFeatureGeometryIsUsable = (geometry) => {
    if (!geometry || !['LineString', 'MultiLineString'].includes(geometry.type)) return false;
    if (geometry.type === 'LineString') return Array.isArray(geometry.coordinates) && geometry.coordinates.length >= 2;
    return Array.isArray(geometry.coordinates) && geometry.coordinates.some(line => Array.isArray(line) && line.length >= 2);
};

const roadFeatureKey = (feature) => {
    const sourceLayer = feature.sourceLayer || feature.layer?.['source-layer'] || 'transportation';
    if (feature.id !== undefined && feature.id !== null) return `${sourceLayer}:${feature.id}`;
    const p = feature.properties || {};
    return `${sourceLayer}:${p.name || p.name_en || ''}:${p.class || ''}:${JSON.stringify(feature.geometry?.coordinates || [])}`;
};

const normalizeRoadFeature = (feature) => ({
    type: 'Feature',
    id: feature.id,
    properties: { ...(feature.properties || {}), source: 'OpenFreeMap/OpenMapTiles' },
    geometry: JSON.parse(JSON.stringify(feature.geometry))
});

const routeRoadClassRank = {
    motorway: 0,
    trunk: 1,
    primary: 2,
    secondary: 3,
    tertiary: 4,
    minor: 5,
    residential: 5,
    unclassified: 5,
    living_street: 5,
    service: 6,
    track: 6,
    path: 7,
    pedestrian: 7,
    footway: 7,
    cycleway: 7,
    steps: 7
};

const routeRoadClass = feature => String(feature.properties?.class || '').toLowerCase().replace(/_(?:link|ramp)$/, '');

const getRouteSnapPolicy = () => {
    const glMap = getMapLibreMap();
    const zoom = Number(glMap?.getZoom?.() ?? map.getZoom?.() ?? 0);
    if (zoom < 10) return { zoom, maxClassRank: 2, pixelTolerance: 32 };
    if (zoom < 12) return { zoom, maxClassRank: 3, pixelTolerance: 30 };
    if (zoom < 14) return { zoom, maxClassRank: 4, pixelTolerance: 28 };
    if (zoom < 16) return { zoom, maxClassRank: 5, pixelTolerance: 26 };
    return { zoom, maxClassRank: Number.POSITIVE_INFINITY, pixelTolerance: 24 };
};

const queryRenderedRoads = (event, pixelTolerance = null, policy = getRouteSnapPolicy()) => {
    if (!event?.latlng) return [];
    const glMap = getMapLibreMap();
    if (!glMap?.isStyleLoaded?.()) return [];
    const roadLayers = getRoadLayerIds();
    if (!roadLayers.length) return [];
    const tolerance = pixelTolerance ?? policy.pixelTolerance;

    // The binding's MapLibre canvas has its own padded coordinate space. Using
    // project() keeps the query aligned with the Leaflet event without adding
    // another map or canvas to the page.
    const point = glMap.project([event.latlng.lng, event.latlng.lat]);
    const rendered = glMap.queryRenderedFeatures([
        [point.x - tolerance, point.y - tolerance], [point.x + tolerance, point.y + tolerance]
    ], { layers: roadLayers });
    const seen = new Set();
    const roads = [];
    const excludedClasses = new Set(['rail', 'transit', 'ferry']);

    rendered.forEach(feature => {
        const properties = feature.properties || {};
        const geometry = feature.geometry;
        const roadClass = String(properties.class || '').toLowerCase();
        if (!roadFeatureGeometryIsUsable(geometry) || excludedClasses.has(roadClass)) return;
        const classRank = routeRoadClassRank[routeRoadClass(feature)] ?? 6;
        if (classRank > policy.maxClassRank) return;
        const key = roadFeatureKey(feature);
        if (seen.has(key)) return;
        seen.add(key);
        roads.push(normalizeRoadFeature(feature));
    });
    return roads;
};

// ==========================================
// 17. MAP FEATURE HIGHLIGHT AND SELECTION
// ==========================================
const featureSelectionPanel = getEl('feature-selection-panel');
const featureSelectionStatus = getEl('feature-selection-status');
const featureSelectionSummary = getEl('feature-selection-summary');
const btnFeatureSelection = getEl('btn-feature-selection');
const btnFeatureSelectionClose = getEl('btn-feature-selection-close');
const btnFeatureSelectionSave = getEl('btn-feature-selection-save');
const btnFeatureSelectionCenterline = getEl('btn-feature-selection-centerline');
const btnFeatureSelectionClear = getEl('btn-feature-selection-clear');
const featureSelectionPreviewGroup = L.featureGroup().addTo(map);
let featureSelectionBoxZoomWasEnabled = false;
let featureSelectionHoverKey = null;
let featureSelectionHoverCandidate = null;

const featureSourceLayer = feature => String(feature.sourceLayer || feature.layer?.['source-layer'] || '').toLowerCase();
const featureStyleLayer = feature => String(feature.layer?.id || '').toLowerCase();
const featurePropertiesText = feature => {
    const properties = feature.properties || {};
    return [properties.class, properties.subclass, properties.kind, properties.type, properties.boundary, properties.name]
        .filter(value => value !== undefined && value !== null)
        .join(' ')
        .toLowerCase();
};

const classifyMapFeature = feature => {
    const sourceLayer = featureSourceLayer(feature);
    const styleLayer = featureStyleLayer(feature);
    const propertiesText = featurePropertiesText(feature);

    if (sourceLayer.includes('transportation') || styleLayer.includes('road')) return 'roads';
    if (sourceLayer.includes('water') || sourceLayer.includes('waterway') || styleLayer.includes('water') || /\b(?:river|stream|canal|lake|reservoir|pond|ocean|sea)\b/.test(propertiesText)) {
        return 'water';
    }
    if (sourceLayer.includes('boundar') || sourceLayer === 'admin' || sourceLayer.includes('reserve') || styleLayer.includes('boundar') || styleLayer.includes('reserve') || /\b(?:reserve|protected|indigenous|aboriginal|administrative|conservation|territory|first[ _-]?nation)\b/.test(propertiesText)) {
        return 'boundaries';
    }
    const isGreenSource = sourceLayer.includes('park') || sourceLayer.includes('landuse') || sourceLayer.includes('landcover') || styleLayer.includes('park') || styleLayer.includes('green');
    if (isGreenSource && /\b(?:park|green|garden|cemetery|golf|recreation|pitch|playground|wood|forest|grass|reserve)\b/.test(propertiesText + ' ' + sourceLayer + ' ' + styleLayer)) {
        return 'parks';
    }
    if (sourceLayer.includes('building') || styleLayer.includes('building')) return 'buildings';
    return null;
};

const featureGeometryIsUsable = geometry => {
    if (!geometry || !['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'].includes(geometry.type)) return false;
    const coordinates = geometry.coordinates;
    if (!Array.isArray(coordinates)) return false;
    if (geometry.type === 'Point') return coordinates.length >= 2;
    if (geometry.type === 'MultiPoint' || geometry.type === 'LineString') return coordinates.length >= 1;
    return coordinates.some(part => Array.isArray(part) && part.length >= 1);
};

const featureStableKey = feature => {
    const source = feature.source || feature.layer?.source || feature.properties?.source_id || 'openfreemap';
    const sourceLayer = featureSourceLayer(feature) || feature.properties?.source_layer || 'unknown';
    if (feature.id !== undefined && feature.id !== null) return `${source}:${sourceLayer}:${feature.id}`;
    const properties = feature.properties || {};
    return `${source}:${sourceLayer}:${properties.name || properties.name_en || ''}:${properties.class || ''}:${JSON.stringify(feature.geometry?.coordinates || [])}`;
};

// A feature ID can be reused by multiple clipped vector-tile fragments. Keep
// the geometry in this key whenever raw rendered fragments are being used so
// the exact tile-edge piece can be matched to the lasso candidate.
const featureRenderedKey = feature => {
    const source = feature.source || feature.layer?.source || feature.properties?.source_id || 'openfreemap';
    const sourceLayer = featureSourceLayer(feature) || feature.properties?.source_layer || 'unknown';
    const id = feature.id === undefined || feature.id === null ? 'no-id' : feature.id;
    return `${source}:${sourceLayer}:${id}:${JSON.stringify(feature.geometry?.coordinates || [])}`;
};

const featureGeometryFamily = geometryType => {
    if (geometryType === 'Point' || geometryType === 'MultiPoint') return 'point';
    if (geometryType === 'LineString' || geometryType === 'MultiLineString') return 'line';
    if (geometryType === 'Polygon' || geometryType === 'MultiPolygon') return 'polygon';
    return null;
};

const mergeFeatureGeometries = fragments => {
    const usable = fragments.map(fragment => fragment.geometry).filter(featureGeometryIsUsable);
    if (!usable.length) return null;
    const family = featureGeometryFamily(usable[0].type);
    const matching = [...new Map(usable
        .filter(geometry => featureGeometryFamily(geometry.type) === family)
        .map(geometry => [JSON.stringify(geometry.coordinates), geometry])).values()];
    if (matching.length === 1) return JSON.parse(JSON.stringify(matching[0]));
    if (family === 'point') {
        const points = matching.flatMap(geometry => geometry.type === 'Point' ? [geometry.coordinates] : geometry.coordinates);
        return { type: 'MultiPoint', coordinates: points };
    }
    if (family === 'line') {
        const lines = matching.flatMap(geometry => geometry.type === 'LineString' ? [geometry.coordinates] : geometry.coordinates);
        return { type: 'MultiLineString', coordinates: lines };
    }
    const polygons = matching.flatMap(geometry => geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates);
    return { type: 'MultiPolygon', coordinates: polygons };
};

const loadedFeatureFragments = (glMap, feature) => {
    const source = feature.source || feature.layer?.source;
    const sourceLayer = feature.sourceLayer || feature.layer?.['source-layer'];
    if (feature.id === undefined || feature.id === null || !source || !sourceLayer || typeof glMap.querySourceFeatures !== 'function') return [feature];
    try {
        const sourceFeatures = glMap.querySourceFeatures(source, { sourceLayer });
        const matches = sourceFeatures.filter(item => item.id !== undefined && item.id !== null && String(item.id) === String(feature.id));
        return matches.length ? matches : [feature];
    } catch (error) {
        return [feature];
    }
};

const normalizeMapFeature = (glMap, feature, category, includeLoadedFragments = true) => {
    const fragments = includeLoadedFragments ? loadedFeatureFragments(glMap, feature) : [feature];
    const geometry = mergeFeatureGeometries(fragments);
    if (!geometry) return null;
    const sourceLayer = featureSourceLayer(feature) || 'unknown';
    const sourceId = feature.source || feature.layer?.source || feature.properties?.source_id || 'openfreemap';
    return {
        type: 'Feature',
        id: feature.id,
        properties: {
            ...(feature.properties || {}),
            source: 'OpenFreeMap/OpenMapTiles',
            source_id: sourceId,
            selection_category: category,
            source_layer: sourceLayer,
            geometry_scope: includeLoadedFragments && feature.id !== undefined && feature.id !== null
                ? 'loaded vector-tile fragments for feature ID'
                : 'rendered feature geometry'
        },
        geometry
    };
};

const queryRenderedMapFeatures = (event, pixelTolerance = 12, requestedCategory = null, includeOther = false, includeLoadedFragments = true) => {
    if (!event?.latlng) return [];
    const glMap = getMapLibreMap();
    const layerIds = getInteractiveFeatureLayerIds();
    if (!glMap?.isStyleLoaded?.() || !layerIds.length) return [];
    const point = glMap.project([event.latlng.lng, event.latlng.lat]);
    const rendered = glMap.queryRenderedFeatures([
        [point.x - pixelTolerance, point.y - pixelTolerance], [point.x + pixelTolerance, point.y + pixelTolerance]
    ], { layers: layerIds });
    const categoryFilter = requestedCategory ?? 'all';
    const groups = new Map();
    rendered.forEach(feature => {
        if (!featureGeometryIsUsable(feature.geometry)) return;
        const category = classifyMapFeature(feature) || (includeOther ? 'other' : null);
        if (category === 'roads' && !includeOther) return;
        if (!category || (categoryFilter !== 'all' && category !== categoryFilter)) return;
        const key = includeLoadedFragments ? featureStableKey(feature) : featureRenderedKey(feature);
        if (!groups.has(key)) groups.set(key, { feature, category });
    });
    return [...groups.values()]
        .map(group => normalizeMapFeature(glMap, group.feature, group.category, includeLoadedFragments))
        .filter(Boolean);
};

const featureDisplayName = feature => {
    const properties = feature.properties || {};
    return properties.road_name || properties.name || properties.name_en || properties.ref || properties.source_layer || 'Unnamed rendered feature';
};

const featureCategoryLabel = feature => {
    const category = feature?.properties?.selection_category || classifyMapFeature(feature);
    return ({
        roads: 'Road',
        water: 'Water feature',
        boundaries: 'Boundary / reserve',
        parks: 'Park / land cover',
        buildings: 'Building',
        other: 'Rendered feature'
    })[category] || 'Map feature';
};

const featureHoverContext = feature => {
    if (!feature) return null;
    return featureCategoryLabel(feature);
};

let lastGeneralFeatureHoverKey = null;
map.on('mousemove', event => {
    if (
        AppState.featureSelection.active
        || AppState.roadRoute.active
        || AppState.magneticLasso.active
        || AppState.drawingMode
    ) return;

    const candidate = queryRenderedMapFeatures(event, 5, 'all', true, false)[0] || null;
    const hoverKey = candidate ? featureRenderedKey(candidate) : null;
    if (hoverKey === lastGeneralFeatureHoverKey) return;
    lastGeneralFeatureHoverKey = hoverKey;
    setMapHoverContext(candidate ? featureHoverContext(candidate) : 'Map');
});

const featureIsRoad = feature => {
    const properties = feature?.properties || {};
    const sourceLayer = featureSourceLayer(feature) || properties.source_layer || '';
    return properties.selection_category === 'roads'
        || sourceLayer.toLowerCase().includes('transportation')
        || sourceLayer.toLowerCase().includes('road')
        || properties.highway !== undefined;
};

const roadNameFromProperties = properties => {
    const directKeys = [
        'road_name', 'name', 'name_en', 'name:en', 'name_local',
        'official_name', 'official_name:en', 'loc_name', 'short_name',
        'alt_name', 'ref'
    ];
    const directValue = directKeys.map(key => properties?.[key]).find(value => (
        value !== undefined && value !== null && String(value).trim() !== ''
    ));
    const localizedValue = Object.entries(properties || {}).find(([key, value]) => (
        /^name(?::|_)(en|fr|de|es|local)$/i.test(key)
        && value !== undefined && value !== null && String(value).trim() !== ''
    ))?.[1];
    const value = directValue ?? localizedValue;
    if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean).join(' / ');
    return value === undefined || value === null || String(value).trim() === '' ? '' : String(value).trim();
};

const roadNamePropertyKeys = new Set([
    'road_name', 'name', 'name_en', 'name:en', 'name_local',
    'official_name', 'official_name:en', 'loc_name', 'short_name',
    'alt_name', 'ref'
]);
const isRoadNameProperty = key => roadNamePropertyKeys.has(key)
    || /^name(?::|_)(en|fr|de|es|local)$/i.test(key);

const enrichSelectedRoadFeature = (feature, { allowSourceLookup = true } = {}) => {
    if (!featureIsRoad(feature)) return feature;
    const glMap = getMapLibreMap();
    const properties = { ...(feature.properties || {}) };
    let nameSource = roadNameFromProperties(properties) ? 'rendered road geometry' : '';
    const mergeProperties = (sourceProperties, includeRoadName = true) => {
        Object.entries(sourceProperties || {}).forEach(([key, value]) => {
            if (!includeRoadName && isRoadNameProperty(key)) return;
            if (properties[key] === undefined || properties[key] === null || properties[key] === '') properties[key] = value;
        });
        if (!nameSource && includeRoadName && roadNameFromProperties(sourceProperties)) nameSource = 'loaded transportation source';
    };

    if (allowSourceLookup && glMap?.querySourceFeatures) {
        const source = feature.source || feature.layer?.source || properties.source_id;
        const sourceLayer = featureSourceLayer(feature) || properties.source_layer;
        const sourceLayers = new Set(sourceLayer && sourceLayer !== 'unknown' ? [sourceLayer] : []);
        (glMap.getStyle?.()?.layers || [])
            .filter(layer => layer.source === source && layer['source-layer'] && String(layer['source-layer']).toLowerCase().includes('transportation'))
            .forEach(layer => sourceLayers.add(layer['source-layer']));
        const sourceFeatures = [];
        sourceLayers.forEach(layerName => {
            try {
                sourceFeatures.push(...glMap.querySourceFeatures(source, { sourceLayer: layerName }));
            } catch (error) {}
        });

        // The clicked line and the named transportation feature can be
        // separate OpenMapTiles layers. Match only by an explicit stable
        // feature/OSM identifier; never guess from geometric proximity or a
        // nearby label, since that is ambiguous at intersections and on
        // parallel roads.
        const selectedIdentifiers = roadStableIdentifiers(feature);
        const explicitSelectedIdentifiers = selectedIdentifiers.filter(identifier => (
            !['feature.id', 'properties.id'].includes(identifier.source)
        ));
        const identifiersForMatch = explicitSelectedIdentifiers.length
            ? explicitSelectedIdentifiers
            : selectedIdentifiers;
        const matchingSourceFeatures = sourceFeatures.filter(sourceFeature => {
            const sourceIds = roadStableIdentifiers(sourceFeature);
            const explicitSourceIds = sourceIds.filter(identifier => (
                !['feature.id', 'properties.id'].includes(identifier.source)
            ));
            const sourceIdentifiersForMatch = explicitSelectedIdentifiers.length
                ? explicitSourceIds
                : sourceIds;
            return identifiersForMatch.some(selectedIdentifier => sourceIdentifiersForMatch.some(sourceIdentifier => (
                selectedIdentifier.value === sourceIdentifier.value
            )));
        });
        const sourceNames = [...new Set(matchingSourceFeatures
            .map(sourceFeature => roadNameFromProperties(sourceFeature.properties))
            .filter(Boolean))];
        const sourceNameIsUnambiguous = sourceNames.length <= 1;
        matchingSourceFeatures.forEach(sourceFeature => mergeProperties(
            sourceFeature.properties,
            sourceNameIsUnambiguous
        ));
        if (!nameSource && sourceNames.length === 1) nameSource = 'loaded transportation source';
        if (!nameSource && sourceNames.length > 1) nameSource = 'ambiguous stable ID match';
    }

    const resolvedName = roadNameFromProperties(properties);
    return {
        ...feature,
        properties: {
            ...properties,
            ...(resolvedName ? { name: properties.name || resolvedName, road_name: resolvedName } : {}),
            road_name_source: nameSource || 'unresolved (no stable ID match)'
        }
    };
};

const isModifierExpandClick = event => Boolean(
    event?.ctrlKey
    || event?.metaKey
    || event?.originalEvent?.ctrlKey
    || event?.originalEvent?.metaKey
    || event?.originalEvent?.getModifierState?.('Control')
    || event?.originalEvent?.getModifierState?.('Meta')
);

const queryMatchingFeatureFragments = (feature, category) => {
    const glMap = getMapLibreMap();
    if (!glMap?.querySourceFeatures) return [];
    const properties = feature?.properties || {};
    const source = feature.source || feature.layer?.source || properties.source_id;
    const sourceLayer = featureSourceLayer(feature) || properties.source_layer;
    const identifiers = stableIdentifierValues(feature);
    if (!source || !sourceLayer || sourceLayer === 'unknown' || !identifiers.size) return [];
    let sourceFeatures = [];
    try {
        sourceFeatures = glMap.querySourceFeatures(source, { sourceLayer }) || [];
    } catch (error) {
        return [];
    }
    const normalized = new Map();
    sourceFeatures
        .filter(sourceFeature => {
            const sourceIdentifiers = stableIdentifierValues(sourceFeature);
            return [...identifiers].some(identifier => sourceIdentifiers.has(identifier));
        })
        .forEach(sourceFeature => {
            const fragment = normalizeMapFeature(glMap, sourceFeature, category, false);
            if (!fragment) return;
            fragment.properties.source_id = source;
            fragment.properties.source_layer = sourceLayer;
            normalized.set(featureRenderedKey(fragment), fragment);
        });
    return [...normalized.values()];
};

const expandFeatureSelection = (feature, category, fallbackFeature = feature) => {
    const enrichedFeature = enrichSelectedRoadFeature(feature, { allowSourceLookup: true });
    const fragments = queryMatchingFeatureFragments(enrichedFeature, category);
    if (!fragments.length) {
        return {
            features: [fallbackFeature],
            expanded: false,
            reason: stableIdentifierValues(feature).size
                ? 'No matching loaded source fragments were available.'
                : 'This rendered feature has no stable source identifier.'
        };
    }

    const sharedProperties = {};
    ['road_name', 'name', 'name_en', 'name:en', 'ref', 'road_name_source']
        .forEach(key => {
            const value = enrichedFeature.properties?.[key];
            if (value !== undefined && value !== null && String(value).trim() !== '') sharedProperties[key] = value;
        });
    return {
        features: fragments.map(fragment => ({
            ...fragment,
            properties: { ...fragment.properties, ...sharedProperties }
        })),
        expanded: true,
        reason: ''
    };
};

const updateFeatureSelectionPanel = () => {
    const state = AppState.featureSelection;
    if (!state.active) return;
    const selected = state.selected || [];
    const combinedSelected = selected.length ? combineFeatureSelectionFragments(selected) : [];
    const selectionModeLabel = state.selectionMode === 'expanded' ? 'expanded source fragment' : 'rendered element';
    if (featureSelectionStatus) featureSelectionStatus.textContent = selected.length
        ? `${selected.length} ${selectionModeLabel}${selected.length === 1 ? '' : 's'} selected · ${combinedSelected.length} output feature${combinedSelected.length === 1 ? '' : 's'}`
        : state.hovered ? 'Rendered feature under pointer' : 'Hover over a rendered map feature';
    if (featureSelectionSummary) {
        const names = [...new Set(combinedSelected.map(featureDisplayName))];
        featureSelectionSummary.textContent = names.length
            ? names.slice(0, 3).join(' · ') + (names.length > 3 ? ` · +${names.length - 3} more` : '')
            : '';
        featureSelectionSummary.classList.toggle('hidden', names.length === 0);
    }
    btnFeatureSelectionSave?.classList.toggle('hidden', selected.length === 0);
    btnFeatureSelectionCenterline?.classList.toggle('hidden', selected.length === 0);
    btnFeatureSelectionClear?.classList.toggle('hidden', selected.length === 0);
};

const setFeatureSelectionState = updates => {
    AppState.featureSelection = { ...AppState.featureSelection, ...updates };
    updateFeatureSelectionPanel();
};

const combineFeatureSelectionGeometry = fragments => {
    const fallback = mergeFeatureGeometries(fragments);
    if (!fallback) return { geometry: null, method: 'unavailable' };
    if (!['Polygon', 'MultiPolygon'].includes(fallback.type) || fragments.length < 2) {
        return { geometry: fallback, method: fragments.length > 1 ? 'multipart fragment aggregation' : 'single rendered fragment' };
    }

    const turfApi = window.turf;
    if (!turfApi?.union) return { geometry: fallback, method: 'MultiPolygon fragment aggregation' };
    try {
        let dissolved = null;
        fragments.forEach(fragment => {
            const piece = { type: 'Feature', properties: {}, geometry: fragment.geometry };
            dissolved = dissolved ? turfApi.union(dissolved, piece) : piece;
            if (!dissolved?.geometry) throw new Error('Polygon union returned no geometry.');
        });
        return dissolved?.geometry
            ? { geometry: dissolved.geometry, method: 'Turf polygon union of rendered tile fragments' }
            : { geometry: fallback, method: 'MultiPolygon fragment aggregation' };
    } catch (error) {
        return { geometry: fallback, method: 'MultiPolygon fragment aggregation (polygon union fallback)' };
    }
};

const combineNonRoadFeatureFragments = features => {
    return groupFeatureFragments(features).map(fragments => {
        const first = fragments[0];
        const combined = combineFeatureSelectionGeometry(fragments);
        const mergedProperties = fragments.reduce((properties, fragment) => {
            Object.entries(fragment.properties || {}).forEach(([key, value]) => {
                if (properties[key] === undefined || properties[key] === null || properties[key] === '') properties[key] = value;
            });
            return properties;
        }, { ...(first.properties || {}) });
        return {
            ...first,
            properties: {
                ...mergedProperties,
                selected_fragment_count: fragments.length,
                geometry_merge_method: combined.method
            },
            geometry: combined.geometry
        };
    }).filter(feature => feature.geometry);
};

const combineFeatureSelectionFragments = features => {
    const roadFeatures = (features || []).filter(feature => (
        featureIsRoad(feature)
        && ['LineString', 'MultiLineString'].includes(feature.geometry?.type)
    ));
    const otherFeatures = (features || []).filter(feature => !roadFeatures.includes(feature));
    return [
        ...combineRoadFeatureFragments(roadFeatures),
        ...combineNonRoadFeatureFragments(otherFeatures)
    ];
};

const renderFeatureSelectionPreview = () => {
    featureSelectionPreviewGroup.clearLayers();
    const selected = combineFeatureSelectionFragments(AppState.featureSelection.selected || []);
    selected.forEach(feature => {
        const lineParts = linePartsForLassoGeometry(feature.geometry);
        lineParts.forEach(({ coordinates }) => {
            if (!Array.isArray(coordinates) || coordinates.length < 2) return;
            featureSelectionPreviewGroup.addLayer(L.polyline(
                coordinates.map(([longitude, latitude]) => [latitude, longitude]),
                { pane: 'previewPane', color: '#2563eb', weight: 5, opacity: 0.95, interactive: false }
            ));
        });
        if (['Polygon', 'MultiPolygon'].includes(feature.geometry?.type)) {
            try {
                featureSelectionPreviewGroup.addLayer(L.geoJSON(feature, {
                    pane: 'previewPane',
                    style: { color: '#2563eb', weight: 3, opacity: 0.9, fillColor: '#2563eb', fillOpacity: 0.24 },
                    interactive: false
                }));
            } catch (error) {}
        }
    });

    const hoverLine = AppState.featureSelection.active ? featureSelectionHoverCandidate?.lineCoordinates : null;
    if (Array.isArray(hoverLine) && hoverLine.length > 1) {
        featureSelectionPreviewGroup.addLayer(L.polyline(
            hoverLine.map(([longitude, latitude]) => [latitude, longitude]),
            { pane: 'previewPane', color: '#22d3ee', weight: 5, opacity: 0.78, dashArray: '2 6', interactive: false }
        ));
    }
};

const clearFeatureSelection = () => {
    featureSelectionHoverKey = null;
    featureSelectionHoverCandidate = null;
    setFeatureSelectionState({ hovered: null, selected: [], selectionMode: 'rendered' });
    setMapHoverContext('Map');
    renderFeatureSelectionPreview();
};

const exitFeatureSelectionMode = () => {
    clearFeatureSelection();
    setFeatureSelectionState({ active: false });
    if (featureSelectionBoxZoomWasEnabled) map.boxZoom?.enable();
    featureSelectionBoxZoomWasEnabled = false;
    featureSelectionPanel?.classList.add('hidden');
    btnFeatureSelection?.classList.remove('bg-blue-600', 'text-white', 'border-blue-700');
    btnFeatureSelection?.classList.add('text-gray-700', 'dark:text-gray-200');
    map.getContainer().style.cursor = '';
};

const enterFeatureSelectionMode = async () => {
    if (AppState.featureSelection.active) { exitFeatureSelectionMode(); return; }
    const glMap = await ensureRouteRoadQueryReady();
    if (!glMap) {
        showToast('Feature selection requires the MapLibre/OpenFreeMap basemap.', true);
        return;
    }
    if (AppState.roadRoute.active) exitRouteDrawing();
    if (AppState.magneticLasso.active) exitMagneticLassoMode();
    if (AppState.drawingMode) {
        AppState.drawingMode = null;
        AppState.tempShape = null;
        map.dragging.enable();
        drawLayerGroup.clearLayers();
    }
    featureSelectionBoxZoomWasEnabled = Boolean(map.boxZoom?.enabled?.());
    map.boxZoom?.disable();
    featureSelectionHoverKey = null;
    featureSelectionHoverCandidate = null;
    setFeatureSelectionState({ active: true, hovered: null, selected: [], selectionMode: 'rendered' });
    setMapHoverContext('Hover over a rendered map feature');
    featureSelectionPanel?.classList.remove('hidden');
    btnFeatureSelection?.classList.add('bg-blue-600', 'text-white', 'border-blue-700');
    btnFeatureSelection?.classList.remove('text-gray-700', 'dark:text-gray-200');
    map.getContainer().style.cursor = 'crosshair';
    renderFeatureSelectionPreview();
};

map.on('mousemove', event => {
    if (!AppState.featureSelection.active) return;
    const nearest = nearestMagneticLassoPoint(event);
    const hovered = nearest?.feature || null;
    const hoverKey = nearest ? `${featureRenderedKey(nearest.feature)}:${nearest.lineKey || ''}` : null;
    if (hoverKey === featureSelectionHoverKey) {
        const desiredCursor = hovered ? 'pointer' : 'crosshair';
        if (map.getContainer().style.cursor !== desiredCursor) map.getContainer().style.cursor = desiredCursor;
        return;
    }
    featureSelectionHoverKey = hoverKey;
    featureSelectionHoverCandidate = nearest;
    setFeatureSelectionState({ hovered });
    setMapHoverContext(hovered ? featureHoverContext(hovered) : 'No rendered feature under pointer');
    renderFeatureSelectionPreview();
    map.getContainer().style.cursor = hovered ? 'pointer' : 'crosshair';
});

map.on('click', event => {
    if (!AppState.featureSelection.active) return;
    const nearest = nearestMagneticLassoPoint(event);
    const feature = featureForRenderedSelection(nearest);
    if (!feature) {
        showToast('No rendered feature is within the magnetic hover range. Move onto its highlighted outline and click.', false, true);
        return;
    }
    const category = nearest.feature.properties?.selection_category || 'other';
    const selected = [...(AppState.featureSelection.selected || [])];
    if (isModifierExpandClick(event)) {
        const expansion = expandFeatureSelection(nearest.feature, category, feature);
        if (!expansion.expanded) {
            showToast(`Selected the hovered rendered element only. ${expansion.reason}`, false, true);
        }
        featureSelectionHoverCandidate = nearest;
        featureSelectionHoverKey = `${featureRenderedKey(nearest.feature)}:${nearest.lineKey || ''}`;
        setFeatureSelectionState({
            selected: expansion.features,
            hovered: feature,
            selectionMode: expansion.expanded ? 'expanded' : 'rendered'
        });
        renderFeatureSelectionPreview();
        return;
    }

    const renderedFeature = enrichSelectedRoadFeature(feature, { allowSourceLookup: false });
    // Vector-tile feature IDs are not guaranteed to be globally unique. Use
    // the raw rendered-fragment key so Shift-clicking a neighboring tile
    // fragment adds it instead of accidentally toggling the prior fragment.
    const existingIndex = selected.findIndex(item => featureRenderedKey(item) === featureRenderedKey(renderedFeature));
    const shiftPressed = Boolean(
        event.shiftKey
        || event.originalEvent?.shiftKey
        || event.originalEvent?.getModifierState?.('Shift')
    );
    if (shiftPressed) {
        if (existingIndex >= 0) selected.splice(existingIndex, 1);
        else selected.push(renderedFeature);
    } else {
        selected.splice(0, selected.length, renderedFeature);
    }
    featureSelectionHoverCandidate = nearest;
    featureSelectionHoverKey = `${featureRenderedKey(feature)}:${nearest.lineKey || ''}`;
    setFeatureSelectionState({ selected, hovered: renderedFeature, selectionMode: 'rendered' });
    renderFeatureSelectionPreview();
});

const requestCenterlineFeatureCollection = async features => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
        const response = await fetch('/api/geometry/centerline', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
                geojson: {
                    type: 'FeatureCollection',
                    features: features.map(feature => ({
                        type: 'Feature',
                        id: feature.id,
                        properties: { ...(feature.properties || {}) },
                        geometry: JSON.parse(JSON.stringify(feature.geometry))
                    }))
                },
                options: { fidelity: 'adaptive', preserve_branches: true }
            })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || `Centerline request failed (${response.status})`);
        const geojson = payload.geojson;
        if (!geojson || geojson.type !== 'FeatureCollection' || !Array.isArray(geojson.features) || !geojson.features.length) {
            throw new Error('The server returned no centerline geometry.');
        }
        return payload;
    } catch (error) {
        if (error?.name === 'AbortError') throw new Error('The centerline request timed out.');
        throw error;
    } finally {
        clearTimeout(timeout);
    }
};

const saveFeatureSelectionLayer = async (asCenterline = false) => {
    const selected = AppState.featureSelection.selected || [];
    if (!selected.length) return;
    const combinedSelected = combineFeatureSelectionFragments(selected);
    let centerlineResult = null;
    if (asCenterline) {
        if (!combinedSelected.length) {
            showToast('No selected geometry is available for centerline conversion.', true);
            return;
        }
        const previousLabel = btnFeatureSelectionCenterline?.textContent || 'Save as centerline';
        if (btnFeatureSelectionCenterline) {
            btnFeatureSelectionCenterline.disabled = true;
            btnFeatureSelectionCenterline.textContent = 'Computing…';
        }
        try {
            centerlineResult = await requestCenterlineFeatureCollection(combinedSelected);
        } catch (error) {
            showToast(`Centerline unavailable: ${error.message}`, true);
            return;
        } finally {
            if (btnFeatureSelectionCenterline) {
                btnFeatureSelectionCenterline.disabled = false;
                btnFeatureSelectionCenterline.textContent = previousLabel;
            }
        }
    }
    const rawFragmentCount = combinedSelected.reduce(
        (count, feature) => count + Math.max(1, Number(feature.properties?.selected_fragment_count) || 1),
        0
    );
    const roadFeatureCount = combinedSelected.filter(featureIsRoad).length;
    const roadIdentityCount = new Set(combinedSelected
        .filter(featureIsRoad)
        .map(feature => feature.properties?.road_identity_key || feature.id)
    ).size;
    const sourceFeatures = asCenterline ? centerlineResult.geojson.features : combinedSelected;
    const features = sourceFeatures.map(feature => {
        const geometry = feature.geometry;
        if (!geometry) return null;
        const sourceLayer = String(feature.properties?.source_layer || '').toLowerCase();
        const isRoad = feature.properties?.selection_category === 'roads'
            || sourceLayer.includes('transportation')
            || feature.properties?.highway !== undefined;
        const roadName = feature.properties?.road_name
            || feature.properties?.name
            || feature.properties?.name_en
            || feature.properties?.name_local
            || feature.properties?.ref
            || '';
        const savedProperties = {
            ...(feature.properties || {})
        };
        if (isRoad) {
            Object.assign(savedProperties, {
                road_name: String(roadName || 'Unnamed road'),
                road_class: feature.properties?.class || feature.properties?.subclass || '',
                road_ref: feature.properties?.ref || '',
                road_source_layer: feature.properties?.source_layer || 'transportation',
                road_feature_id: feature.properties?.road_feature_id
                    || (feature.properties?.road_identity_source && feature.properties.road_identity_source !== 'none'
                        ? roadStableIdentifier(feature)
                        : ''),
                road_osm_id: feature.properties?.osm_id || feature.properties?.osm_way_id || ''
            });
        }
        return {
            type: 'Feature',
            id: feature.id,
            properties: {
                ...savedProperties,
                ...(asCenterline ? {
                    geometry_type: 'centerline',
                    centerline_method: feature.properties?.centerline_method || 'server-derived centerline network'
                } : {})
            },
            geometry: JSON.parse(JSON.stringify(geometry))
        };
    }).filter(Boolean);
    if (!features.length) {
        showToast('A centerline could not be derived from the selected feature geometry.', true);
        return;
    }
    const geoJsonData = {
        type: 'FeatureCollection',
        metadata: {
            ...(asCenterline ? (centerlineResult.geojson.metadata || {}) : {}),
            source: 'OpenFreeMap/OpenMapTiles',
            attribution: '© OpenFreeMap · © OpenMapTiles · © OpenStreetMap contributors',
            selection_type: asCenterline ? 'derived selected feature centerlines' : 'selected rendered features',
            selection_mode: AppState.featureSelection.selectionMode || 'rendered',
            feature_count: features.length,
            source_feature_count: selected.length,
            raw_fragment_count: rawFragmentCount,
            merged_fragment_count: Math.max(0, rawFragmentCount - features.length),
            road_feature_count: roadFeatureCount,
            disconnected_component_count: Math.max(0, roadFeatureCount - roadIdentityCount),
            geometry_merge_methods: [...new Set(combinedSelected.map(feature => feature.properties?.geometry_merge_method).filter(Boolean))],
            road_name_field: 'road_name',
            geometry_scope: asCenterline
                ? 'Centerline derived by server-side processing from the raw rendered vector geometry under the feature-selection hover.'
                : 'Raw rendered vector geometry under the magnetic hover; fragments from the same rendered feature are combined.'
        },
        features
    };
    const uniqueKey = Math.random().toString(36).substr(2, 9);
    const style = asCenterline
        ? { type: 'single', fillColor: '#4f46e5', fillOpacity: 0, color: '#4f46e5', opacity: 1, pointShape: 'circle', pointSize: 8 }
        : { type: 'single', fillColor: '#2563eb', fillOpacity: 0.24, color: '#2563eb', opacity: 1, pointShape: 'circle', pointSize: 8 };
    const mapLayer = createCustomGeoJSONLayer(geoJsonData, style, `pane-${uniqueKey}`).addTo(map);
    const names = [...new Set(combinedSelected.map(featureDisplayName))].filter(Boolean);
    const displayName = asCenterline
        ? (names.length ? `Centerlines: ${names.slice(0, 2).join(' / ')}` : 'Rendered feature centerlines')
        : (names.length ? `Rendered features: ${names.slice(0, 2).join(' / ')}` : 'Selected rendered features');
    AppState.activeLayers = [{
        uniqueKey, id: `feature_selection_${Date.now()}`, displayName, mapLayer,
        exportUrl: null, isLocalGeoJSON: true, geoJsonData, customStyle: style,
        isVisible: true, parentId: null, isFolder: false
    }, ...AppState.activeLayers];
    updateMapLayerOrder();
    renderAddedLayers();
    switchTab('added');
    if (typeof autoSaveWorkspace === 'function') autoSaveWorkspace();
    const fragmentNote = rawFragmentCount > features.length ? ` (merged ${rawFragmentCount - features.length} connected tile fragment${rawFragmentCount - features.length === 1 ? '' : 's'})` : '';
    showToast(`Saved ${features.length} separate ${asCenterline ? 'centerline' : 'road feature'}${features.length === 1 ? '' : 's'} in one GeoJSON layer${fragmentNote}.`);
    exitFeatureSelectionMode();
};

const saveFeatureSelection = () => saveFeatureSelectionLayer(false);
const saveFeatureSelectionCenterline = () => saveFeatureSelectionLayer(true);

btnFeatureSelection?.addEventListener('click', enterFeatureSelectionMode);
btnFeatureSelectionClose?.addEventListener('click', exitFeatureSelectionMode);
btnFeatureSelectionClear?.addEventListener('click', clearFeatureSelection);
btnFeatureSelectionSave?.addEventListener('click', saveFeatureSelection);
btnFeatureSelectionCenterline?.addEventListener('click', saveFeatureSelectionCenterline);
[featureSelectionPanel, btnFeatureSelection].forEach(element => {
    if (element) L.DomEvent.disableClickPropagation(element);
});
document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && AppState.featureSelection.active) exitFeatureSelectionMode();
});

// ==========================================
// 18. GEO-REFERENCED POLYGON DRAWING
// ==========================================
const drawShapePanel = getEl('draw-shape-panel');
const drawShapeStatus = getEl('draw-shape-status');
const btnDrawShape = getEl('btn-draw-shape');
const btnDrawShapeClose = getEl('btn-draw-shape-close');
const btnDrawShapeSave = getEl('btn-draw-shape-save');
const btnDrawShapeClear = getEl('btn-draw-shape-clear');
const shapePreviewPaneName = 'shapePreviewPane';
const shapeVertexPaneName = 'shapeVertexPane';
if (!map.getPane(shapePreviewPaneName)) map.createPane(shapePreviewPaneName);
if (!map.getPane(shapeVertexPaneName)) map.createPane(shapeVertexPaneName);
map.getPane(shapePreviewPaneName).style.zIndex = 3600;
map.getPane(shapeVertexPaneName).style.zIndex = 3700;
const shapePreviewGroup = L.featureGroup().addTo(map);
let shapeLineLayer = null;
let shapeCursorPoint = null;
let shapeCursorMarker = null;
const stopShapeEvent = event => {
    if (event?.originalEvent) L.DomEvent.stop(event.originalEvent);
};

const updateShapePanel = () => {
    const state = AppState.drawShape;
    if (!state.active) return;
    const count = state.points.length;
    drawShapeStatus.textContent = state.completed ? `Shape ready · ${count} points` : `${count} point${count === 1 ? '' : 's'} · ${count < 3 ? 'add more points' : 'right-click to finish'}`;
    btnDrawShapeSave?.classList.toggle('hidden', !state.completed || count < 3);
};

const shapeSegmentIndex = latlng => {
    const state = AppState.drawShape;
    if (state.points.length < 2) return -1;
    const point = map.latLngToLayerPoint(latlng);
    let best = { index: -1, distance: Infinity };
    const points = state.points;
    const segmentCount = state.completed ? points.length : points.length - 1;
    points.slice(0, segmentCount).forEach((candidate, index) => {
        const a = map.latLngToLayerPoint(candidate);
        const b = map.latLngToLayerPoint(points[(index + 1) % points.length]);
        const dx = b.x - a.x, dy = b.y - a.y;
        const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
        const distance = Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
        if (distance < best.distance) best = { index, distance };
    });
    return best.distance <= 12 ? best.index : -1;
};

const renderShapePreview = () => {
    shapePreviewGroup.clearLayers();
    shapeLineLayer = null;
    shapeCursorMarker = null;
    const state = AppState.drawShape;
    const previewPoints = state.completed
        ? [...state.points, state.points[0]]
        : [...state.points, ...(state.points.length > 0 && shapeCursorPoint ? [shapeCursorPoint] : [])];
    if (previewPoints.length >= 2) {
        const points = state.completed ? previewPoints : previewPoints;
        shapeLineLayer = state.completed
            ? L.polygon(points, { pane: shapePreviewPaneName, color: '#2563eb', weight: 3, opacity: 0.9, fillColor: '#60a5fa', fillOpacity: 0.25 })
            : L.polyline(points, { pane: shapePreviewPaneName, color: '#2563eb', weight: 3, opacity: 0.9 });
        shapeLineLayer.on('click', event => {
            const insertAfter = shapeSegmentIndex(event.latlng);
            if (insertAfter < 0) return;
            const currentState = AppState.drawShape;
            const nextPoints = [...currentState.points];
            nextPoints.splice(insertAfter + 1, 0, event.latlng);
            shapeCursorPoint = event.latlng;
            AppState.drawShape = { ...currentState, points: nextPoints };
            stopShapeEvent(event);
            renderShapePreview();
        });
        shapePreviewGroup.addLayer(shapeLineLayer);
    }
    state.points.forEach((point, index) => {
        const isFirstPoint = index === 0;
        const vertexSize = isFirstPoint ? 28 : 16;
        const marker = L.marker(point, {
            pane: shapeVertexPaneName,
            draggable: true,
            keyboard: false,
            bubblingMouseEvents: false,
            icon: L.divIcon({ className: 'gis-shape-vertex', html: '<span></span>', iconSize: [vertexSize, vertexSize], iconAnchor: [vertexSize / 2, vertexSize / 2] }),
            zIndexOffset: 1100
        });
        marker.bindTooltip(`Shape point ${index + 1}`, { direction: 'top', opacity: 0.9 });
        marker.on('click', event => {
            const currentState = AppState.drawShape;
            const isModifierClick = event.originalEvent?.metaKey || event.originalEvent?.ctrlKey;
            if (isModifierClick) {
                const points = currentState.points.filter((_, pointIndex) => pointIndex !== index);
                AppState.drawShape = { ...currentState, points, completed: points.length >= 3 && currentState.completed };
                renderShapePreview();
            } else if (isFirstPoint && !currentState.completed && currentState.points.length >= 3) {
                // The first vertex is an enlarged close target. Closing keeps
                // one copy of the first coordinate; GeoJSON serialization
                // adds the required closing coordinate later.
                AppState.drawShape = { ...currentState, completed: true };
                map.getContainer().style.cursor = '';
                renderShapePreview();
            }
            stopShapeEvent(event);
        });
        marker.on('dragstart', event => {
            map.dragging.disable();
            stopShapeEvent(event);
        });
        marker.on('drag', event => {
            const currentState = AppState.drawShape;
            const points = [...currentState.points];
            points[index] = event.target.getLatLng();
            AppState.drawShape = { ...currentState, points };
            if (shapeLineLayer) shapeLineLayer.setLatLngs(currentState.completed ? [...points, points[0]] : points);
            stopShapeEvent(event);
        });
        marker.on('dragend', event => {
            map.dragging.enable();
            renderShapePreview();
            stopShapeEvent(event);
        });
        shapePreviewGroup.addLayer(marker);
    });
    if (!state.completed && state.points.length > 0 && shapeCursorPoint) {
        const cursorMarker = L.marker(shapeCursorPoint, {
            pane: shapeVertexPaneName,
            draggable: false,
            keyboard: false,
            bubblingMouseEvents: false,
            icon: L.divIcon({ className: 'gis-shape-vertex gis-shape-cursor-vertex', html: '<span></span>', iconSize: [12, 12], iconAnchor: [6, 6] }),
            zIndexOffset: 1000
        });
        cursorMarker.on('click', event => {
            const currentState = AppState.drawShape;
            AppState.drawShape = { ...currentState, points: [...currentState.points, event.latlng] };
            shapeCursorPoint = event.latlng;
            renderShapePreview();
            stopShapeEvent(event);
        });
        shapeCursorMarker = cursorMarker;
        shapePreviewGroup.addLayer(cursorMarker);
    }
    updateShapePanel();
};

const clearShapeDrawing = () => {
    AppState.drawShape = { ...AppState.drawShape, points: [], completed: false };
    shapeCursorPoint = null;
    shapePreviewGroup.clearLayers();
    shapeLineLayer = null;
    shapeCursorMarker = null;
    updateShapePanel();
};

const exitShapeDrawing = () => {
    clearShapeDrawing();
    AppState.drawShape = { ...AppState.drawShape, active: false };
    setSavedLayerInteractionForDrawing(true);
    updateSoloView();
    drawShapePanel?.classList.add('hidden');
    btnDrawShape?.classList.remove('bg-blue-600', 'text-white', 'border-blue-700');
    btnDrawShape?.classList.add('text-gray-700', 'dark:text-gray-200');
    map.getContainer().style.cursor = '';
};

const enterShapeDrawing = () => {
    if (AppState.drawShape.active) { exitShapeDrawing(); return; }
    getEl('map-context-menu')?.classList.add('hidden');
    if (AppState.featureSelection.active) exitFeatureSelectionMode();
    if (AppState.magneticLasso.active) exitMagneticLassoMode();
    if (AppState.roadRoute.active) exitRouteDrawing();
    clearShapeDrawing();
    AppState.drawShape = { ...AppState.drawShape, active: true };
    setSavedLayerInteractionForDrawing(false);
    drawShapePanel?.classList.remove('hidden');
    btnDrawShape?.classList.add('bg-blue-600', 'text-white', 'border-blue-700');
    btnDrawShape?.classList.remove('text-gray-700', 'dark:text-gray-200');
    map.getContainer().style.cursor = 'crosshair';
    updateShapePanel();
};

map.on('mousemove', event => {
    const state = AppState.drawShape;
    if (!state.active || state.completed) return;
    if (state.points.length === 0) {
        shapeCursorPoint = null;
        return;
    }
    shapeCursorPoint = event.latlng;
    if (shapeCursorMarker) shapeCursorMarker.setLatLng(event.latlng);
    if (shapeLineLayer) {
        shapeLineLayer.setLatLngs([...state.points, event.latlng]);
    } else if (state.points.length === 0) {
        renderShapePreview();
    }
});

map.on('click', event => {
    const state = AppState.drawShape;
    if (!state.active || state.completed) return;
    AppState.drawShape = { ...state, points: [...state.points, event.latlng] };
    shapeCursorPoint = event.latlng;
    renderShapePreview();
    stopShapeEvent(event);
});

map.on('contextmenu', event => {
    if (!AppState.drawShape.active) return;
    getEl('map-context-menu')?.classList.add('hidden');
    stopShapeEvent(event);
    const state = AppState.drawShape;
    if (state.points.length < 3) { showToast('A shape needs at least 3 points.', false, true); return; }
    AppState.drawShape = { ...state, completed: true };
    map.getContainer().style.cursor = '';
    renderShapePreview();
});

const saveDrawnShape = () => {
    const state = AppState.drawShape;
    if (!state.completed || state.points.length < 3) return;
    const coordinates = state.points.map(point => [point.lng, point.lat]);
    coordinates.push(coordinates[0]);
    const shapeName = `Drawn shape (${state.points.length} points)`;
    const polygonFeature = {
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: [coordinates] },
    };
    if (typeof window.turf?.area !== 'function') {
        showToast('Unable to calculate shape area. Turf.js is not available.', true);
        return;
    }
    const totalAreaSquareMeters = window.turf.area(polygonFeature);
    polygonFeature.properties = {
        name: shapeName,
        number_of_points: state.points.length,
        total_area_square_meters: Number(totalAreaSquareMeters.toFixed(2)),
        total_area_square_kilometers: Number((totalAreaSquareMeters / 1000000).toFixed(6)),
    };
    const geoJsonData = { type: 'FeatureCollection', features: [polygonFeature] };
    const uniqueKey = Math.random().toString(36).substr(2, 9);
    const style = { type: 'single', fillColor: '#60a5fa', fillOpacity: 0.25, color: '#2563eb', opacity: 1, pointShape: 'circle', pointSize: 8 };
    const mapLayer = createCustomGeoJSONLayer(geoJsonData, style, `pane-${uniqueKey}`).addTo(map);
    AppState.activeLayers = [{ uniqueKey, id: `drawn_shape_${Date.now()}`, displayName: shapeName, mapLayer, exportUrl: null, isLocalGeoJSON: true, geoJsonData, customStyle: style, isVisible: true, parentId: null, isFolder: false }, ...AppState.activeLayers];
    updateMapLayerOrder(); renderAddedLayers(); switchTab('added');
    if (typeof autoSaveWorkspace === 'function') autoSaveWorkspace();
    showToast('Saved drawn shape as a polygon layer.');
    exitShapeDrawing();
};

btnDrawShape?.addEventListener('click', enterShapeDrawing);
btnDrawShapeClose?.addEventListener('click', exitShapeDrawing);
btnDrawShapeClear?.addEventListener('click', clearShapeDrawing);
btnDrawShapeSave?.addEventListener('click', saveDrawnShape);
[drawShapePanel, btnDrawShape].forEach(element => { if (element) L.DomEvent.disableClickPropagation(element); });
document.addEventListener('keydown', event => {
    if (!AppState.drawShape.active) return;
    if (event.key === 'Escape') {
        exitShapeDrawing();
        return;
    }
    if ((event.key === 'Backspace' || event.key === 'Delete') && !AppState.drawShape.completed) {
        event.preventDefault();
        const points = AppState.drawShape.points.slice(0, -1);
        AppState.drawShape = { ...AppState.drawShape, points };
        renderShapePreview();
    }
});

// ==========================================
// 19. OSRM SNAP-TO-ROAD ROUTE DRAWING
// ==========================================
const roadRoutePanel = getEl('road-route-panel');
const roadRouteStatus = getEl('road-route-status');
const roadRouteSummary = getEl('road-route-summary');
const btnRoadRoute = getEl('btn-road-route');
const btnRoadRouteClose = getEl('btn-road-route-close');
const btnRoadRouteSave = getEl('btn-road-route-save');
const btnRoadRouteClear = getEl('btn-road-route-clear');
const routePreviewGroup = L.featureGroup().addTo(map);
let routeHoverMarker = null;
let routeLineLayer = null;
let routeDraggingMarker = null;
let routeRequestSerial = 0;

const nearestRenderedRoadPoint = event => {
    const policy = getRouteSnapPolicy();
    const roads = queryRenderedRoads(event, policy.pixelTolerance, policy);
    const turfApi = window.turf;
    const glMap = getMapLibreMap();
    if (!roads.length || !turfApi?.nearestPointOnLine || !glMap?.project) return null;
    const clickPoint = turfApi.point([event.latlng.lng, event.latlng.lat]);
    const screenPoint = glMap.project([event.latlng.lng, event.latlng.lat]);
    let best = null;
    roads.forEach(feature => {
        const lines = feature.geometry.type === 'LineString'
            ? [feature.geometry.coordinates]
            : feature.geometry.coordinates;
        lines.forEach(coordinates => {
            if (!Array.isArray(coordinates) || coordinates.length < 2) return;
            const snapped = turfApi.nearestPointOnLine(turfApi.lineString(coordinates), clickPoint, { units: 'meters' });
            const distance = Number(snapped.properties?.dist);
            const snappedScreenPoint = glMap.project(snapped.geometry.coordinates);
            const pixelDistance = Math.hypot(snappedScreenPoint.x - screenPoint.x, snappedScreenPoint.y - screenPoint.y);
            if (pixelDistance > policy.pixelTolerance) return;
            if (!best || pixelDistance < best.pixelDistance) best = {
                coordinates: snapped.geometry.coordinates,
                distance,
                pixelDistance,
                feature
            };
        });
    });
    return best;
};

const formatRouteDistance = (meters) => {
    if (!Number.isFinite(Number(meters))) return '';
    return Number(meters) >= 1000 ? `${(Number(meters) / 1000).toFixed(1)} km` : `${Math.round(Number(meters))} m`;
};

const formatRouteDuration = (seconds) => {
    if (!Number.isFinite(Number(seconds))) return '';
    const minutes = Math.max(1, Math.round(Number(seconds) / 60));
    return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes} min`;
};

const updateRoutePanel = () => {
    const state = AppState.roadRoute;
    if (!state.active) return;
    const count = state.waypoints.length;
    if (roadRouteStatus) roadRouteStatus.textContent = state.geometry
        ? `${count} waypoint${count === 1 ? '' : 's'} · route ready`
        : count === 0 ? 'Click a road to add a waypoint' : `Add another road point (${count} waypoint${count === 1 ? '' : 's'})`;
    if (roadRouteSummary) {
        const parts = [formatRouteDistance(state.distance_m), formatRouteDuration(state.duration_s)].filter(Boolean);
        roadRouteSummary.textContent = parts.join(' · ');
        roadRouteSummary.classList.toggle('hidden', parts.length === 0);
    }
    btnRoadRouteSave?.classList.toggle('hidden', !state.geometry);
};

const setRoadRouteState = (updates) => {
    AppState.roadRoute = { ...AppState.roadRoute, ...updates };
    updateRoutePanel();
};

const savedLayerPointerEvents = new Map();
const savedLayerInteractiveState = new Map();

const setSavedLayerInteractionForDrawing = enabled => {
    AppState.activeLayers.forEach(layer => {
        if (layer.isFolder) return;
        const pane = map.getPane(`pane-${layer.uniqueKey}`);
        if (pane) pane.style.pointerEvents = enabled ? '' : 'none';
        layer.mapLayer?.eachLayer?.(featureLayer => {
            const element = featureLayer.getElement?.();
            if (!element) return;
            if (enabled) {
                if (savedLayerInteractiveState.has(featureLayer)) {
                    featureLayer.options.interactive = savedLayerInteractiveState.get(featureLayer);
                    savedLayerInteractiveState.delete(featureLayer);
                }
                if (savedLayerPointerEvents.has(element)) {
                    element.style.pointerEvents = savedLayerPointerEvents.get(element);
                    savedLayerPointerEvents.delete(element);
                }
            } else if (!savedLayerPointerEvents.has(element)) {
                savedLayerInteractiveState.set(featureLayer, featureLayer.options.interactive);
                featureLayer.options.interactive = false;
                savedLayerPointerEvents.set(element, element.style.pointerEvents);
                element.style.pointerEvents = 'none';
            }
        });
    });
    if (enabled) savedLayerPointerEvents.clear();
    if (enabled) savedLayerInteractiveState.clear();
};

const renderRoutePreview = () => {
    routePreviewGroup.clearLayers();
    routeLineLayer = null;
    const state = AppState.roadRoute;
    if (state.geometry) {
        routeLineLayer = L.geoJSON({ type: 'Feature', properties: {}, geometry: state.geometry }, {
            style: { color: '#7c3aed', weight: 6, opacity: 0.9 }
        });
        routePreviewGroup.addLayer(routeLineLayer);
    }
    state.waypoints.forEach(([lon, lat], index) => {
        const marker = L.marker([lat, lon], {
            icon: L.divIcon({
                className: 'gis-route-waypoint',
                html: `<span>${index + 1}</span>`,
                iconSize: [28, 28],
                iconAnchor: [14, 14]
            }),
            draggable: true,
            keyboard: false,
            bubblingMouseEvents: false,
            zIndexOffset: 1000
        }).bindTooltip(`Route point ${index + 1}`, { direction: 'top', offset: [0, -14], opacity: 0.9 });
        marker._routeWaypointIndex = index;
        marker.on('dragstart', event => {
            routeDraggingMarker = event.target;
            routeRequestSerial += 1;
            event.target._routeLastSnapped = event.target.getLatLng();
            if (routeLineLayer) {
                routePreviewGroup.removeLayer(routeLineLayer);
                routeLineLayer = null;
            }
            setRoadRouteState({ geometry: null, distance_m: null, duration_s: null });
            map.getContainer().style.cursor = 'grabbing';
        });
        marker.on('drag', event => {
            const draggedMarker = event.target;
            const pointerLatLng = event.latlng || draggedMarker.getLatLng();
            const nearest = nearestRenderedRoadPoint({ latlng: pointerLatLng });
            if (!nearest) {
                // Keep the point on its last known road position when the
                // pointer briefly leaves the magnet tolerance.
                if (draggedMarker._routeLastSnapped) draggedMarker.setLatLng(draggedMarker._routeLastSnapped);
                return;
            }
            const snappedLatLng = L.latLng(nearest.coordinates[1], nearest.coordinates[0]);
            draggedMarker.setLatLng(snappedLatLng);
            draggedMarker._routeLastSnapped = snappedLatLng;
            const waypoints = [...AppState.roadRoute.waypoints];
            waypoints[draggedMarker._routeWaypointIndex] = nearest.coordinates;
            setRoadRouteState({ waypoints });
        });
        marker.on('dragend', event => {
            const draggedMarker = event.target;
            try {
                const pointerLatLng = event.latlng || draggedMarker.getLatLng();
                const finalSnap = nearestRenderedRoadPoint({ latlng: pointerLatLng });
                const position = finalSnap
                    ? L.latLng(finalSnap.coordinates[1], finalSnap.coordinates[0])
                    : draggedMarker._routeLastSnapped || draggedMarker.getLatLng();
                draggedMarker.setLatLng(position);
                draggedMarker._routeLastSnapped = position;
                const waypoints = [...AppState.roadRoute.waypoints];
                waypoints[draggedMarker._routeWaypointIndex] = [position.lng, position.lat];
                routeDraggingMarker = null;
                setRoadRouteState({ waypoints, geometry: null, distance_m: null, duration_s: null });
                map.getContainer().style.cursor = 'crosshair';
                renderRoutePreview();
                if (waypoints.length >= 2) requestOsrmRoute(waypoints);
            } catch (error) {
                routeDraggingMarker = null;
                map.getContainer().style.cursor = 'crosshair';
                if (roadRouteStatus) roadRouteStatus.textContent = `Route unavailable: ${error.message}`;
                renderRoutePreview();
            }
        });
        routePreviewGroup.addLayer(marker);
    });
    if (routeHoverMarker) routePreviewGroup.addLayer(routeHoverMarker);
};

const clearRouteDrawing = () => {
    routeRequestSerial += 1;
    setRoadRouteState({ waypoints: [], geometry: null, distance_m: null, duration_s: null });
    routePreviewGroup.clearLayers();
    routeHoverMarker = null;
    routeLineLayer = null;
    routeDraggingMarker = null;
};

const exitRouteDrawing = () => {
    clearRouteDrawing();
    setRoadRouteState({ active: false });
    setSavedLayerInteractionForDrawing(true);
    updateSoloView();
    setMapHoverContext('Map');
    roadRoutePanel?.classList.add('hidden');
    btnRoadRoute?.classList.remove('bg-blue-600', 'text-white', 'border-blue-700');
    btnRoadRoute?.classList.add('text-gray-700', 'dark:text-gray-200');
    map.getContainer().style.cursor = '';
};

const requestOsrmRoute = async (waypoints) => {
    const requestId = ++routeRequestSerial;
    setRoadRouteState({ geometry: null, distance_m: null, duration_s: null });
    renderRoutePreview();
    if (roadRouteStatus) roadRouteStatus.textContent = 'Calculating route…';

    // Prefer the browser request. The public OSRM service permits CORS, and
    // this avoids depending on the Python runtime's TLS/OpenSSL stack. Keep
    // the application endpoint as a fallback for deployments with a custom
    // OSRM server or restrictive browser networking policies.
    const osrmBaseUrl = (window.GIS_OSRM_ROUTING_URL || 'https://router.project-osrm.org').replace(/\/+$/, '');
    const coordinatePath = waypoints.map(([lon, lat]) => `${Number(lon).toFixed(7)},${Number(lat).toFixed(7)}`).join(';');
    const routeQuery = 'overview=full&geometries=geojson&steps=false';

    const fetchJson = async (url, options = {}) => {
        const controller = new AbortController();
        const timeoutId = window.setTimeout(() => controller.abort(), 20000);
        try {
            const response = await fetch(url, { ...options, signal: controller.signal });
            let data;
            try {
                data = await response.json();
            } catch (parseError) {
                throw new Error(`Routing service returned an invalid response (${response.status}).`);
            }
            if (!response.ok) throw new Error(data.error || data.message || `Routing service returned HTTP ${response.status}.`);
            return data;
        } finally {
            window.clearTimeout(timeoutId);
        }
    };

    try {
        let data;
        let directError;
        try {
            const payload = await fetchJson(`${osrmBaseUrl}/route/v1/driving/${coordinatePath}?${routeQuery}`, {
                headers: { Accept: 'application/json' }
            });
            const route = payload.routes?.[0];
            if (payload.code !== 'Ok' || !route?.geometry) {
                throw new Error(payload.message || 'OSRM could not find a route between the selected roads.');
            }
            data = {
                geometry: route.geometry,
                distance_m: route.distance,
                duration_s: route.duration
            };
        } catch (error) {
            directError = error;
            data = await fetchJson('/api/osrm_route', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({ coordinates: waypoints })
            });
            if (!data.geometry) {
                throw new Error(data.error || directError?.message || 'OSRM could not calculate this route.');
            }
        }
        if (requestId !== routeRequestSerial) return;
        setRoadRouteState({ geometry: data.geometry, distance_m: data.distance_m, duration_s: data.duration_s });
        renderRoutePreview();
    } catch (error) {
        if (requestId !== routeRequestSerial) return;
        if (roadRouteStatus) roadRouteStatus.textContent = `Route unavailable: ${error.message}`;
        renderRoutePreview();
    }
};

const enterRouteDrawing = async () => {
    if (AppState.roadRoute.active) { exitRouteDrawing(); return; }
    const glMap = await ensureRouteRoadQueryReady();
    if (!glMap) {
        showToast('Route drawing requires the MapLibre/OpenFreeMap basemap.', true);
        return;
    }
    if (AppState.featureSelection.active) exitFeatureSelectionMode();
    if (AppState.magneticLasso.active) exitMagneticLassoMode();
    if (AppState.drawShape.active) exitShapeDrawing();
    if (AppState.drawingMode) {
        AppState.drawingMode = null;
        AppState.tempShape = null;
        map.dragging.enable();
        drawLayerGroup.clearLayers();
    }
    getEl('map-context-menu')?.classList.add('hidden');
    clearRouteDrawing();
    setRoadRouteState({ active: true });
    setSavedLayerInteractionForDrawing(false);
    setMapHoverContext('Move over a road to snap a route point');
    roadRoutePanel?.classList.remove('hidden');
    btnRoadRoute?.classList.add('bg-blue-600', 'text-white', 'border-blue-700');
    btnRoadRoute?.classList.remove('text-gray-700', 'dark:text-gray-200');
    map.getContainer().style.cursor = 'crosshair';
};

map.on('mousemove', event => {
    if (!AppState.roadRoute.active || routeDraggingMarker) return;
    const nearest = nearestRenderedRoadPoint(event);
    if (routeHoverMarker) routePreviewGroup.removeLayer(routeHoverMarker);
    routeHoverMarker = nearest ? L.circleMarker([nearest.coordinates[1], nearest.coordinates[0]], {
        radius: 5, color: '#f59e0b', weight: 2, fillColor: '#fef3c7', fillOpacity: 1
    }) : null;
    setMapHoverContext(nearest ? 'Road (snap point)' : 'No routable road under pointer');
    if (nearest) {
        map.getContainer().style.cursor = 'pointer';
        routePreviewGroup.addLayer(routeHoverMarker);
    } else {
        map.getContainer().style.cursor = 'crosshair';
    }
});

map.on('click', event => {
    if (!AppState.roadRoute.active) return;
    const nearest = nearestRenderedRoadPoint(event);
    if (!nearest) {
        showToast('No routable road is within the snapping range. Zoom in for smaller streets.', false, true);
        return;
    }
    const waypoints = [...AppState.roadRoute.waypoints, nearest.coordinates];
    setRoadRouteState({ waypoints, geometry: null, distance_m: null, duration_s: null });
    renderRoutePreview();
    if (waypoints.length >= 2) requestOsrmRoute(waypoints);
});

const saveRoadRoute = () => {
    const state = AppState.roadRoute;
    if (!state.geometry) return;
    const geoJsonData = {
        type: 'FeatureCollection',
        metadata: {
            source: 'OSRM', profile: 'driving',
            attribution: '© OpenStreetMap contributors via OSRM',
            waypoint_count: state.waypoints.length,
            distance_m: state.distance_m,
            duration_s: state.duration_s
        },
        features: [{
            type: 'Feature',
            properties: { source: 'OSRM', profile: 'driving', waypoint_count: state.waypoints.length, distance_m: state.distance_m, duration_s: state.duration_s },
            geometry: state.geometry
        }]
    };
    const uniqueKey = Math.random().toString(36).substr(2, 9);
    const style = { type: 'single', fillColor: '#7c3aed', fillOpacity: 0.2, color: '#7c3aed', opacity: 1, pointShape: 'circle', pointSize: 8 };
    const mapLayer = createCustomGeoJSONLayer(geoJsonData, style, `pane-${uniqueKey}`).addTo(map);
    AppState.activeLayers = [{
        uniqueKey, id: `osrm_route_${Date.now()}`, displayName: `OSRM route (${state.waypoints.length} points)`, mapLayer,
        exportUrl: null, isLocalGeoJSON: true, geoJsonData, customStyle: style,
        isVisible: true, parentId: null, isFolder: false
    }, ...AppState.activeLayers];
    updateMapLayerOrder();
    renderAddedLayers();
    switchTab('added');
    if (typeof autoSaveWorkspace === 'function') autoSaveWorkspace();
    showToast('Saved OSRM route as a vector line layer.');
    exitRouteDrawing();
};

btnRoadRoute?.addEventListener('click', enterRouteDrawing);
btnRoadRouteClose?.addEventListener('click', exitRouteDrawing);
btnRoadRouteClear?.addEventListener('click', clearRouteDrawing);
btnRoadRouteSave?.addEventListener('click', saveRoadRoute);
[roadRoutePanel, btnRoadRoute].forEach(element => {
    if (element) L.DomEvent.disableClickPropagation(element);
});
document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && AppState.roadRoute.active) exitRouteDrawing();
});

// ==========================================
// 19. MAGNETIC LASSO DRAWING
// ==========================================
const magneticLassoPanel = getEl('magnetic-lasso-panel');
const magneticLassoStatus = getEl('magnetic-lasso-status');
const btnMagneticLasso = getEl('btn-magnetic-lasso');
const btnMagneticLassoClose = getEl('btn-magnetic-lasso-close');
const btnMagneticLassoSave = getEl('btn-magnetic-lasso-save');
const btnMagneticLassoClear = getEl('btn-magnetic-lasso-clear');
const magneticLassoPreviewGroup = L.featureGroup().addTo(map);
let magneticLassoHoverPoint = null;
let magneticLassoMapDraggingWasEnabled = false;
let magneticLassoBoxZoomWasEnabled = false;
const MAGNETIC_LASSO_PIXEL_TOLERANCE = 26;
const MAGNETIC_LASSO_VERTEX_TOLERANCE = 10;

const linePartsForLassoGeometry = geometry => {
    if (!geometry) return [];
    if (geometry.type === 'LineString') return [{ coordinates: geometry.coordinates, partIndex: 0, polygonIndex: null, ringIndex: 0 }];
    if (geometry.type === 'MultiLineString') return geometry.coordinates.map((coordinates, partIndex) => ({ coordinates, partIndex, polygonIndex: null, ringIndex: 0 }));
    if (geometry.type === 'Polygon') return geometry.coordinates.map((coordinates, ringIndex) => ({ coordinates, partIndex: ringIndex, polygonIndex: 0, ringIndex }));
    if (geometry.type === 'MultiPolygon') {
        let partIndex = 0;
        return geometry.coordinates.flatMap((polygon, polygonIndex) => polygon.map((coordinates, ringIndex) => ({
            coordinates,
            partIndex: partIndex++,
            polygonIndex,
            ringIndex
        })));
    }
    return [];
};

const nearestMagneticLassoPoint = (event, requestedCategory = 'all', includeOther = true) => {
    const glMap = getMapLibreMap();
    const turfApi = window.turf;
    if (!glMap?.project || !turfApi?.nearestPointOnLine) return null;
    const candidates = queryRenderedMapFeatures(event, MAGNETIC_LASSO_PIXEL_TOLERANCE, requestedCategory, includeOther, false);
    if (!candidates.length) return null;
    const clickPoint = turfApi.point([event.latlng.lng, event.latlng.lat]);
    const screenPoint = glMap.project([event.latlng.lng, event.latlng.lat]);
    let bestSegment = null;
    let bestVertex = null;
    candidates.forEach(feature => {
        linePartsForLassoGeometry(feature.geometry).forEach(({ coordinates, partIndex, polygonIndex, ringIndex }) => {
            if (!Array.isArray(coordinates) || coordinates.length < 2) return;
            let line;
            try { line = turfApi.lineString(coordinates); } catch (error) { return; }
            const snapped = turfApi.nearestPointOnLine(line, clickPoint, { units: 'meters' });
            const snappedScreenPoint = glMap.project(snapped.geometry.coordinates);
            const pixelDistance = Math.hypot(snappedScreenPoint.x - screenPoint.x, snappedScreenPoint.y - screenPoint.y);
            const segmentIndex = Math.max(0, Math.min(coordinates.length - 2, Number(snapped.properties?.index) || 0));
            if (pixelDistance <= MAGNETIC_LASSO_PIXEL_TOLERANCE && (!bestSegment || pixelDistance < bestSegment.pixelDistance)) bestSegment = {
                coordinates: snapped.geometry.coordinates,
                feature,
                pixelDistance,
                lineKey: `${featureStableKey(feature)}:${partIndex}`,
                lineCoordinates: JSON.parse(JSON.stringify(coordinates)),
                segmentIndex,
                polygonIndex,
                ringIndex,
                snapKind: 'segment'
            };

            // MapLibre exposes the actual vector-tile vertices in rendered
            // line/polygon geometry. Give those vertices a wider, stronger
            // magnetic pull so the trace can lock onto meaningful corners,
            // junctions, and bends instead of hovering beside them.
            if (pixelDistance > MAGNETIC_LASSO_VERTEX_TOLERANCE) return;
            coordinates.forEach((coordinate, vertexIndex) => {
                if (!Array.isArray(coordinate) || coordinate.length < 2) return;
                const vertexScreenPoint = glMap.project(coordinate);
                const vertexDistance = Math.hypot(vertexScreenPoint.x - screenPoint.x, vertexScreenPoint.y - screenPoint.y);
                if (vertexDistance > MAGNETIC_LASSO_VERTEX_TOLERANCE) return;
                const vertexSegmentIndex = vertexIndex >= coordinates.length - 1
                    ? Math.max(0, coordinates.length - 2)
                    : vertexIndex;
                if (!bestVertex || vertexDistance < bestVertex.pixelDistance) bestVertex = {
                    coordinates: [...coordinate],
                    feature,
                    pixelDistance: vertexDistance,
                    lineKey: `${featureStableKey(feature)}:${partIndex}`,
                    lineCoordinates: JSON.parse(JSON.stringify(coordinates)),
                    segmentIndex: vertexSegmentIndex,
                    vertexIndex,
                    polygonIndex,
                    ringIndex,
                    snapKind: 'vertex'
                };
            });
        });
    });
    return bestVertex || bestSegment;
};

const lassoCoordinatesEqual = (first, second) => (
    Array.isArray(first) && Array.isArray(second)
    && first.length >= 2 && second.length >= 2
    && first[0] === second[0] && first[1] === second[1]
);

const appendUniqueLassoCoordinate = (coordinates, coordinate) => {
    if (!Array.isArray(coordinate) || coordinate.length < 2) return;
    const previous = coordinates[coordinates.length - 1];
    if (!lassoCoordinatesEqual(previous, coordinate)) coordinates.push([...coordinate]);
};

const makeMagneticLassoControl = (coordinate, nearest = null) => ({
    coordinate: [...coordinate],
    lineKey: nearest?.lineKey || null,
    lineCoordinates: nearest?.lineCoordinates ? JSON.parse(JSON.stringify(nearest.lineCoordinates)) : null,
    segmentIndex: Number.isFinite(nearest?.segmentIndex) ? nearest.segmentIndex : null
});

const buildMagneticLassoPath = controls => {
    if (!Array.isArray(controls) || !controls.length) return [];
    const path = [];
    appendUniqueLassoCoordinate(path, controls[0].coordinate);

    for (let controlIndex = 1; controlIndex < controls.length; controlIndex += 1) {
        const previous = controls[controlIndex - 1];
        const current = controls[controlIndex];
        const sameLine = previous.lineKey && current.lineKey
            && previous.lineKey === current.lineKey
            && Array.isArray(previous.lineCoordinates)
            && previous.lineCoordinates.length >= 2
            && Array.isArray(current.lineCoordinates)
            && current.lineCoordinates.length >= 2;

        if (sameLine) {
            // Rendered vector features expose the nearest segment index. Follow
            // those vertices in click order, preserving a straight fallback
            // when the two controls do not share one continuous line part.
            const coordinates = previous.lineCoordinates;
            const lastSegment = coordinates.length - 2;
            const previousSegment = Math.max(0, Math.min(lastSegment, Number(previous.segmentIndex) || 0));
            const currentSegment = Math.max(0, Math.min(lastSegment, Number(current.segmentIndex) || 0));
            const sameCoordinates = JSON.stringify(previous.lineCoordinates) === JSON.stringify(current.lineCoordinates);
            if (sameCoordinates) {
                if (previousSegment <= currentSegment) {
                    for (let index = previousSegment + 1; index <= currentSegment; index += 1) {
                        appendUniqueLassoCoordinate(path, coordinates[index]);
                    }
                } else {
                    for (let index = previousSegment; index >= currentSegment + 1; index -= 1) {
                        appendUniqueLassoCoordinate(path, coordinates[index]);
                    }
                }
            }
        }
        appendUniqueLassoCoordinate(path, current.coordinate);
    }
    return path;
};

const magneticLassoPreviewPath = state => {
    const path = [];
    [...(state.path || []), ...(state.trace || [])].forEach(coordinate => appendUniqueLassoCoordinate(path, coordinate));
    return path;
};

const appendMagneticLassoTrace = (state, coordinate, nearest = null) => {
    const current = makeMagneticLassoControl(coordinate, nearest);
    const trace = [...(state.trace || [])];
    const traceControls = [...(state.traceControls || [])];
    const previous = traceControls[traceControls.length - 1] || state.controls?.[state.controls.length - 1] || null;
    const previousCoordinate = trace[trace.length - 1] || state.path?.[state.path.length - 1] || previous?.coordinate;
    if (!previous || !previousCoordinate) {
        appendUniqueLassoCoordinate(trace, coordinate);
        traceControls.push(current);
        return { trace, traceControls };
    }

    const segment = buildMagneticLassoPath([previous, current]);
    segment.slice(1).forEach(point => appendUniqueLassoCoordinate(trace, point));
    traceControls.push(current);
    return { trace, traceControls };
};

const magneticLassoPointIsNearStart = coordinate => {
    const state = AppState.magneticLasso;
    const glMap = getMapLibreMap();
    if (state.points.length < 3 || !glMap?.project) return false;
    const start = glMap.project(state.points[0]);
    const current = glMap.project(coordinate);
    return Math.hypot(start.x - current.x, start.y - current.y) <= 18;
};

const magneticLassoGeometryFromState = state => {
    const path = Array.isArray(state.path) && state.path.length ? state.path : state.points;
    if (path.length < 2) return null;
    if (path[0] && path[path.length - 1] && lassoCoordinatesEqual(path[0], path[path.length - 1]) && path.length >= 4) {
        return { type: 'Polygon', coordinates: [path] };
    }
    return { type: 'LineString', coordinates: path };
};

const updateMagneticLassoPanel = () => {
    const state = AppState.magneticLasso;
    if (!state.active) return;
    if (magneticLassoStatus) {
        if (state.completed && state.geometry?.type === 'Polygon') magneticLassoStatus.textContent = 'Closed shape complete · save as a layer';
        else if (state.completed) magneticLassoStatus.textContent = 'Line complete · save as a layer';
        else if (!state.points.length) magneticLassoStatus.textContent = 'Hover a feature, then click to start';
        else magneticLassoStatus.textContent = `${state.points.length} control point${state.points.length === 1 ? '' : 's'} · hover a feature, then click to trace`;
    }
    btnMagneticLassoSave?.classList.toggle('hidden', !state.completed || !state.geometry);
};

const setMagneticLassoState = updates => {
    AppState.magneticLasso = { ...AppState.magneticLasso, ...updates };
    updateMagneticLassoPanel();
};

const renderMagneticLassoPreview = () => {
    magneticLassoPreviewGroup.clearLayers();
    const state = AppState.magneticLasso;
    const points = state.points || [];
    const path = magneticLassoPreviewPath(state);

    // Show only the currently hovered rendered vector part as a temporary
    // candidate. It is deliberately not added to the saved path until the
    // user clicks it.
    if (!state.completed && magneticLassoHoverPoint?.lineCoordinates?.length > 1) {
        magneticLassoPreviewGroup.addLayer(L.polyline(
            magneticLassoHoverPoint.lineCoordinates.map(([longitude, latitude]) => [latitude, longitude]),
            { color: '#22d3ee', weight: 5, opacity: 0.72, dashArray: '2 6', interactive: false }
        ));
    }
    if (state.geometry) {
        magneticLassoPreviewGroup.addLayer(L.geoJSON({ type: 'Feature', properties: {}, geometry: state.geometry }, {
            style: state.geometry.type === 'Polygon'
                ? { color: '#f97316', weight: 3, opacity: 0.95, fillColor: '#fb923c', fillOpacity: 0.2 }
                : { color: '#f97316', weight: 4, opacity: 0.95 },
            interactive: false
        }));
    } else if (path.length > 1) {
        const latLngs = path.map(([longitude, latitude]) => [latitude, longitude]);
        magneticLassoPreviewGroup.addLayer(L.polyline(latLngs, { color: '#f97316', weight: 3, opacity: 0.9, dashArray: '7 5', interactive: false }));
    }
    if (!state.completed && magneticLassoHoverPoint && points.length) {
        const lastPathPoint = path[path.length - 1] || points[points.length - 1];
        magneticLassoPreviewGroup.addLayer(L.polyline([
            [lastPathPoint[1], lastPathPoint[0]],
            [magneticLassoHoverPoint.coordinates[1], magneticLassoHoverPoint.coordinates[0]]
        ], { color: '#fbbf24', weight: 2, opacity: 0.8, dashArray: '4 5', interactive: false }));
    }
    points.forEach((point, index) => {
        magneticLassoPreviewGroup.addLayer(L.circleMarker([point[1], point[0]], {
            radius: index === 0 ? 7 : 5,
            color: '#ffffff',
            weight: 2,
            fillColor: index === 0 ? '#dc2626' : '#f97316',
            fillOpacity: 1,
            interactive: false
        }).bindTooltip(String(index + 1), { direction: 'top', offset: [0, -5], opacity: 0.9 }));
    });
    if (!state.completed && magneticLassoHoverPoint) {
        magneticLassoPreviewGroup.addLayer(L.circleMarker([
            magneticLassoHoverPoint.coordinates[1], magneticLassoHoverPoint.coordinates[0]
        ], { radius: 5, color: '#ffffff', weight: 2, fillColor: '#facc15', fillOpacity: 1, interactive: false }));
    }
};

const clearMagneticLasso = () => {
    magneticLassoHoverPoint = null;
    setMagneticLassoState({ controls: [], points: [], path: [], trace: [], traceControls: [], geometry: null, completed: false });
    renderMagneticLassoPreview();
};

const exitMagneticLassoMode = () => {
    clearMagneticLasso();
    setMagneticLassoState({ active: false });
    setMapHoverContext('Map');
    magneticLassoPanel?.classList.add('hidden');
    btnMagneticLasso?.classList.remove('bg-blue-600', 'text-white', 'border-blue-700');
    btnMagneticLasso?.classList.add('text-gray-700', 'dark:text-gray-200');
    if (magneticLassoMapDraggingWasEnabled) map.dragging.enable();
    if (magneticLassoBoxZoomWasEnabled) map.boxZoom?.enable();
    magneticLassoMapDraggingWasEnabled = false;
    magneticLassoBoxZoomWasEnabled = false;
    map.getContainer().style.cursor = '';
};

const enterMagneticLassoMode = async () => {
    if (AppState.magneticLasso.active) { exitMagneticLassoMode(); return; }
    const glMap = await ensureRouteRoadQueryReady();
    if (!glMap) {
        showToast('Magnetic lasso requires the MapLibre/OpenFreeMap basemap.', true);
        return;
    }
    if (AppState.featureSelection.active) exitFeatureSelectionMode();
    if (AppState.roadRoute.active) exitRouteDrawing();
    if (AppState.drawingMode) {
        AppState.drawingMode = null;
        AppState.tempShape = null;
        drawLayerGroup.clearLayers();
    }
    clearMagneticLasso();
    magneticLassoMapDraggingWasEnabled = Boolean(map.dragging?.enabled?.());
    magneticLassoBoxZoomWasEnabled = Boolean(map.boxZoom?.enabled?.());
    map.dragging?.disable();
    map.boxZoom?.disable();
    setMagneticLassoState({ active: true });
    setMapHoverContext('Move over a rendered feature to preview its geometry');
    magneticLassoPanel?.classList.remove('hidden');
    btnMagneticLasso?.classList.add('bg-blue-600', 'text-white', 'border-blue-700');
    btnMagneticLasso?.classList.remove('text-gray-700', 'dark:text-gray-200');
    map.getContainer().style.cursor = 'crosshair';
    renderMagneticLassoPreview();
};

map.on('mousemove', event => {
    if (!AppState.magneticLasso.active || AppState.magneticLasso.completed) return;
    const nearest = nearestMagneticLassoPoint(event);
    const coordinate = nearest?.coordinates || [event.latlng.lng, event.latlng.lat];
    magneticLassoHoverPoint = nearest || { coordinates: coordinate, snapKind: 'freehand' };
    setMapHoverContext(nearest ? featureHoverContext(nearest.feature) : 'Freehand map trace');
    map.getContainer().style.cursor = nearest ? 'pointer' : 'crosshair';
    renderMagneticLassoPreview();
});

map.on('click', event => {
    if (!AppState.magneticLasso.active || AppState.magneticLasso.completed) return;
    const nearest = nearestMagneticLassoPoint(event);
    let state = AppState.magneticLasso;
    let coordinate = nearest?.coordinates || [event.latlng.lng, event.latlng.lat];
    const closing = magneticLassoPointIsNearStart(coordinate);
    if (closing) coordinate = state.points[0];
    const control = makeMagneticLassoControl(coordinate, nearest);

    // Commit the currently previewed feature geometry up to the click before
    // adding the explicit control point. Mouse movement only previews; the
    // click is what accepts and fills in the magnetic path.
    const traceUpdate = appendMagneticLassoTrace(state, coordinate, nearest);
    const path = [...(state.path || [])];
    traceUpdate.trace.forEach(point => appendUniqueLassoCoordinate(path, point));
    const controls = [...(state.controls || []), control];
    const points = controls.map(item => item.coordinate);
    const closed = path.length >= 4 && lassoCoordinatesEqual(path[0], path[path.length - 1]);
    setMagneticLassoState({ controls, points, path, trace: [], traceControls: [], geometry: closed ? { type: 'Polygon', coordinates: [path] } : null, completed: closed });
    magneticLassoHoverPoint = null;
    renderMagneticLassoPreview();
});

const completeMagneticLasso = () => {
    const state = AppState.magneticLasso;
    if (state.completed) return;
    const path = magneticLassoPreviewPath(state);
    if (path.length < 2) {
        showToast('Move the pointer to draw at least two points before completing the lasso.', false, true);
        return;
    }
    setMagneticLassoState({ path, trace: [], traceControls: [], points: state.controls.map(control => control.coordinate), geometry: magneticLassoGeometryFromState({ ...state, path }), completed: true });
    magneticLassoHoverPoint = null;
    renderMagneticLassoPreview();
};

const removeLastMagneticLassoPoint = () => {
    const state = AppState.magneticLasso;
    if (state.trace?.length) {
        setMagneticLassoState({
            trace: state.trace.slice(0, -1),
            traceControls: (state.traceControls || []).slice(0, -1),
            geometry: null,
            completed: false
        });
        magneticLassoHoverPoint = null;
        renderMagneticLassoPreview();
        return;
    }

    const controls = (state.controls || []).slice(0, -1);
    if (!controls.length && !state.points.length) return;
    const points = controls.map(control => control.coordinate);
    let path = [...(state.path || [])];
    const previousControl = controls[controls.length - 1];
    if (previousControl) {
        for (let index = path.length - 1; index >= 0; index -= 1) {
            if (lassoCoordinatesEqual(path[index], previousControl.coordinate)) {
                path = path.slice(0, index + 1);
                break;
            }
        }
    } else {
        path = [];
    }
    setMagneticLassoState({ controls, points, path, trace: [], traceControls: [], geometry: null, completed: false });
    magneticLassoHoverPoint = null;
    renderMagneticLassoPreview();
};

const saveMagneticLasso = () => {
    const state = AppState.magneticLasso;
    if (!state.geometry) return;
    const isPolygon = state.geometry.type === 'Polygon';
    const geoJsonData = {
        type: 'FeatureCollection',
        metadata: {
            source: 'OpenFreeMap/OpenMapTiles',
            attribution: '© OpenFreeMap · © OpenMapTiles · © OpenStreetMap contributors',
            selection_type: 'magnetic lasso',
            geometry_type: isPolygon ? 'Polygon' : 'LineString',
            control_point_count: state.points.length,
            snapping_scope: 'Rendered map feature geometry within the current viewport'
        },
        features: [{
            type: 'Feature',
            properties: {
                source: 'OpenFreeMap/OpenMapTiles',
                selection_type: 'magnetic lasso',
                closed: isPolygon,
                control_point_count: state.points.length
            },
            geometry: state.geometry
        }]
    };
    const uniqueKey = Math.random().toString(36).substr(2, 9);
    const style = isPolygon
        ? { type: 'single', fillColor: '#f97316', fillOpacity: 0.25, color: '#ea580c', opacity: 1, pointShape: 'circle', pointSize: 8 }
        : { type: 'single', fillColor: '#f97316', fillOpacity: 0, color: '#ea580c', opacity: 1, pointShape: 'circle', pointSize: 8 };
    const mapLayer = createCustomGeoJSONLayer(geoJsonData, style, `pane-${uniqueKey}`).addTo(map);
    AppState.activeLayers = [{
        uniqueKey, id: `magnetic_lasso_${Date.now()}`, displayName: `Magnetic lasso ${isPolygon ? 'shape' : 'line'}`, mapLayer,
        exportUrl: null, isLocalGeoJSON: true, geoJsonData, customStyle: style,
        isVisible: true, parentId: null, isFolder: false
    }, ...AppState.activeLayers];
    updateMapLayerOrder();
    renderAddedLayers();
    switchTab('added');
    if (typeof autoSaveWorkspace === 'function') autoSaveWorkspace();
    showToast(`Saved magnetic lasso ${isPolygon ? 'shape' : 'line'} as a GeoJSON layer.`);
    exitMagneticLassoMode();
};

btnMagneticLasso?.addEventListener('click', enterMagneticLassoMode);
btnMagneticLassoClose?.addEventListener('click', exitMagneticLassoMode);
btnMagneticLassoClear?.addEventListener('click', clearMagneticLasso);
btnMagneticLassoSave?.addEventListener('click', saveMagneticLasso);
[magneticLassoPanel, btnMagneticLasso].forEach(element => {
    if (element) L.DomEvent.disableClickPropagation(element);
});
document.addEventListener('keydown', event => {
    if (!AppState.magneticLasso.active) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        removeLastMagneticLassoPoint();
    } else if (event.key === 'Enter') {
        event.preventDefault();
        completeMagneticLasso();
    } else if (event.key === 'Escape') {
        event.preventDefault();
        exitMagneticLassoMode();
    }
});
