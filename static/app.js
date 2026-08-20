// ==========================================
// 1. INITIALIZATION & IMPORTS
// ==========================================

import { AppState } from './state.js';
import { renderAddedLayers } from './uiRenderer.js';
import { 
    map, drawLayerGroup, previewRenderer, createCustomGeoJSONLayer, 
    removePane, clearAllPreviews, darkenHex, hexAlpha, interpolateColor,
    createGeoJsonStyleFunction, createGeoJsonPointToLayer, attachPopupsToFeatures
} from './mapEngine.js';
import { saveLayerToCache, deleteCachedLayer } from './db.js';

// Sync layer state whenever a layer is added, cropped, or re-styled
export const syncLayerCache = async (layerKey) => {
    const layerObj = AppState.activeLayers.find(l => l.key === layerKey);
    if (!layerObj) return;

    await saveLayerToCache({
        layerKey: layerObj.key,
        name: layerObj.name,
        type: layerObj.type,
        geoJsonData: layerObj.geoJsonData,
        style: layerObj.style,
        visible: layerObj.visible,
        lastUpdated: Date.now()
    });
};

// Hook into layer removal
export const removeLayerFromCache = async (layerKey) => {
    await deleteCachedLayer(layerKey);
};
import { getCachedLayers } from './db.js';

// DELETED: Legacy restoreCachedWorkspace and duplicate DOMContentLoaded listener.
// Workspace initialization is handled asynchronously by loadStateFromDB at the bottom of this file.

// Safely Query DOM Elements
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

const osmKeyInput = getEl('osm-key');
const osmValueDatalist = getEl('osm-values');
const btnOsmInspect = getEl('btn-osm-inspect');
const osmInspectContainer = getEl('osm-inspect-container');
const osmInspectResults = getEl('osm-inspect-results');
const btnCloseInspect = getEl('btn-close-inspect');
const osmInspectStatus = getEl('osm-inspect-status');

const toast = getEl('toast');

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
            restoreWorkspaceState(JSON.parse(JSON.stringify(historyStack[historyIndex])));
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
            restoreWorkspaceState(JSON.parse(JSON.stringify(historyStack[historyIndex])));
        } finally {
            isRestoringHistory = false;
            updateUndoRedoButtons();
        }
        showToast("Action redone.");
    }
};

getEl('btn-undo')?.addEventListener('click', handleUndo);
getEl('btn-redo')?.addEventListener('click', handleRedo);

const showToast = (msg, isError=false) => {
  if (!toast) return;
  toast.className = `fixed bottom-6 right-6 px-4 py-3 rounded shadow-xl transform transition-all duration-300 z-50 max-w-sm ${isError ? 'bg-red-600 text-white' : 'bg-gray-800 dark:bg-gray-700 text-white'}`;
  const msgEl = getEl('toast-message');
  if (msgEl) msgEl.textContent = msg;
  toast.classList.remove('translate-y-20', 'opacity-0');
  setTimeout(() => toast.classList.add('translate-y-20', 'opacity-0'), 5000);
};

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
    // Loop forwards so top of UI list gets highest zIndex
    for (let i = 0; i < AppState.activeLayers.length; i++) {
        const layer = AppState.activeLayers[i];
        if (layer.isFolder || !layer.isVisible) continue;
        const pane = map.getPane('pane-' + layer.uniqueKey);
        if (pane) pane.style.zIndex = zIndex--;
    }
    updateSoloView(); 
    autoSaveWorkspace(); 
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
        wrapper.style.height = 'auto'; // Resets any fixed height set by previous dragging
        wrapper.style.maxHeight = '';  // Restores the default 45vh max-height limit
    }
    getEl('context-resizer')?.classList.remove('hidden');
};

const closeTablePanel = () => {
    AppState.activeTableLayerKey = null;
    attributeTableContainer?.classList.add('hidden'); 
    attributeTableContainer?.classList.remove('flex');
    
    if (AppState.highlightLayer) {
        map.removeLayer(AppState.highlightLayer);
        AppState.highlightLayer = null;
    }
    
    if (AppState.activeLayers.length > 0) renderAddedLayers();
};
window.closeTablePanel = closeTablePanel;

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
            pointToLayer: createGeoJsonPointToLayer(customStyle, previewPaneName, previewRenderer)
            // No popups attached to preview layer for performance
        });
    } else {
        const baseUrl = AppState.currentServerUrl.split('?')[0];
        if (AppState.currentServerType === 'WFS') {
            mapLayer = L.tileLayer.wms(baseUrl, { pane: previewPaneName, layers: meta.id, format: 'image/png', transparent: true });
        } else {
            if (!baseUrl.toLowerCase().includes('featureserver')) {
                mapLayer = L.esri.dynamicMapLayer({ pane: previewPaneName, url: baseUrl, layers: [meta.id], opacity: 0.8 });
            } else {
                const fUrl = baseUrl.endsWith(`/${meta.id}`) ? baseUrl : `${baseUrl}/${meta.id}`;
                mapLayer = L.esri.featureLayer({ pane: previewPaneName, url: fUrl });
            }
        }
    }
    mapLayer.addTo(map);
    AppState.previewLayers[layerId] = mapLayer;
};

// Helper to strip Leaflet internal properties & circular references before saving
const sanitizeGeoJSON = (geoJson) => {
    if (!geoJson) return null;
    try {
        return JSON.parse(JSON.stringify(geoJson, (key, value) => {
            // Strip out Leaflet circular references and internal state flags
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
        // Strip out Leaflet circular references before serializing
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
            customStyle: l.customStyle,
            isVisible: l.isVisible,
            isFolder: l.isFolder,
            parentId: l.parentId || null,
            isExpanded: l.isExpanded
        };
    });
    return { version: "1.2", savedAt: new Date().toISOString(), mapState: { lat: center.lat, lng: center.lng, zoom }, activeLayers: layersData };
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

const restoreWorkspaceState = (data) => {
    closeAllPanels(); clearAllPreviews();
    AppState.currentSoloLayerKey = null; 

    AppState.activeLayers.forEach(l => {
        if (!l.isFolder && l.mapLayer) map.removeLayer(l.mapLayer);
        removePane(l.uniqueKey);
    });
    AppState.activeLayers = [];

    if (data.mapState && data.mapState.lat !== undefined) map.setView([data.mapState.lat, data.mapState.lng], data.mapState.zoom || 10);

    if (data.activeLayers && Array.isArray(data.activeLayers)) {
        data.activeLayers.forEach(lData => {
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
            
            // Rebuild layer if shape data exists regardless of flag
            if (lData.geoJsonData) {
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
                    isLocalGeoJSON: lData.isLocalGeoJSON, geoJsonData: lData.geoJsonData, customStyle: lData.customStyle,
                    isVisible: lData.isVisible ?? true, parentId: lData.parentId || null, isFolder: false
                }];
            }
        });
    }

    if (AppState.activeLayers.length > 0) {
        renderAddedLayers(); updateMapLayerOrder(); 
    } else {
        renderAddedLayers(); autoSaveWorkspace();
    }
};

const loadSavedServers = async () => {
    if (!savedServersSelect) return;
    try {
        const res = await fetch('/api/servers');
        const servers = await res.json();
        savedServersSelect.innerHTML = '<option value="" disabled selected>-- Load saved server --</option>';
        servers.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s.url; opt.textContent = s.name; opt.dataset.type = s.type;
            savedServersSelect.appendChild(opt);
        });
    } catch (err) { console.error("Failed to load servers", err); }
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
        
        const res = await fetch(`https://overpass-api.de/api/interpreter`, { method: 'POST', body: "data=" + encodeURIComponent(query), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        if (!res.ok) throw new Error("API limits or area too large.");
        
        const data = await res.json();
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
                if (osmKeyInput) osmKeyInput.value = el.getAttribute('data-k');
                const valEl = getEl('osm-value');
                if (valEl) valEl.value = el.getAttribute('data-v');
                showToast(`Copied ${el.getAttribute('data-k')}=${el.getAttribute('data-v')} to Query Builder!`);
            });
        });
    } catch (err) { status.textContent = 'Scan failed. Area might be too large.'; }
};


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
                  removePane(k);
                  if (AppState.activeTableLayerKey === k) closeTablePanel();
                  if (AppState.activeEditLayerKey === k || AppState.activeSplitLayerKey === k || AppState.activeCropLayerKey === k) closeSidebarPanels();
                  AppState.activeLayers = AppState.activeLayers.filter((_, index) => index !== i);
              }
          });
      } else { return; }
  } else {
      map.removeLayer(layer.mapLayer);
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

    const zip = new JSZip(); // JSZip is now globally available from head.html
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
    const key = e.currentTarget.getAttribute('data-key');
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
// 6. ATTRIBUTE TABLE RENDERING
// ==========================================
const attachTableResizer = () => {
    if (attributeTableContainer) attributeTableContainer.style.position = 'relative';
    
    const resizer = attributeTableContainer?.querySelector('.table-resizer');
    if (!resizer) return;
    
    let isResizing = false;
    resizer.addEventListener('mousedown', (e) => {
        e.preventDefault();
        isResizing = true;
        document.body.classList.add('select-none', 'cursor-row-resize');

        const startY = e.clientY;
        const startHeight = attributeTableContainer.offsetHeight;

        const doDrag = (moveEvt) => {
            if (!isResizing) return;
            const dy = startY - moveEvt.clientY;
            const newHeight = Math.max(100, Math.min(window.innerHeight - 40, startHeight + dy));
            
            // FORCE OVERRIDE: Kill any Tailwind max-height classes on the HTML element
            attributeTableContainer.style.maxHeight = 'none';
            attributeTableContainer.style.height = `${newHeight}px`;
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

const renderTableContent = (layerName) => {
    let displayFeatures = [...AppState.currentTableFeatures].slice(0, 100);
    
    if (AppState.tableSortCol) {
        displayFeatures.sort((a, b) => {
            let valA = a.properties ? a.properties[AppState.tableSortCol] : '';
            let valB = b.properties ? b.properties[AppState.tableSortCol] : '';
            if (valA === null || valA === undefined) valA = '';
            if (valB === null || valB === undefined) valB = '';
            
            let cmp = String(valA).localeCompare(String(valB), undefined, { numeric: true, sensitivity: 'base' });
            return AppState.tableSortAsc ? cmp : -cmp;
        });
    }

    let tableHtml = `
        <div class="table-resizer absolute top-0 left-0 w-full h-1.5 bg-gray-200 hover:bg-blue-400 dark:bg-gray-700 dark:hover:bg-blue-500 cursor-row-resize z-50 transition-colors" title="Drag to resize"></div>
        <div class="flex justify-between items-center mb-1 shrink-0 border-b border-gray-200 dark:border-gray-700 pb-1 pt-1.5">
            <div class="text-xs font-bold text-gray-700 dark:text-gray-200">${layerName} Data</div>
            <button onclick="window.closeTablePanel()" class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 px-1"><i class="fa-solid fa-times"></i></button>
        </div>
        <div class="flex-1 overflow-auto min-h-0 custom-scroll border border-gray-200 dark:border-gray-700 rounded">
            <table class="min-w-full text-xs text-left border-collapse bg-white dark:bg-gray-800">
                <thead class="bg-gray-100 dark:bg-gray-700 sticky top-0 shadow-xs z-10"><tr>`;
    
    AppState.currentTableHeaders.forEach(h => { 
        let sortIcon = '<i class="fa-solid fa-sort ml-1 text-gray-400 opacity-40"></i>';
        if (AppState.tableSortCol === h) {
            sortIcon = AppState.tableSortAsc 
                ? '<i class="fa-solid fa-sort-up ml-1 text-blue-600 dark:text-blue-400"></i>' 
                : '<i class="fa-solid fa-sort-down ml-1 text-blue-600 dark:text-blue-400"></i>';
        }
        tableHtml += `<th class="px-2 py-1 border border-gray-200 dark:border-gray-600 font-semibold text-gray-700 dark:text-gray-200 whitespace-nowrap cursor-pointer hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors select-none tbl-header" data-col="${h}">${h} ${sortIcon}</th>`; 
    });
    tableHtml += '</tr></thead><tbody>';

    displayFeatures.forEach(f => {
        const isHighlighted = AppState.highlightLayer && AppState.highlightLayer._row_id === f.__row_id;
        const rowClass = isHighlighted ? 'bg-cyan-100 dark:bg-cyan-900/40' : 'hover:bg-blue-50 dark:hover:bg-blue-900/30';

        tableHtml += `<tr class="tbl-row cursor-pointer transition-colors ${rowClass}" data-id="${f.__row_id}">`;
        AppState.currentTableHeaders.forEach(h => {
            const val = f.properties ? f.properties[h] : '';
            const displayVal = (val !== null && val !== undefined) ? val : '';
            tableHtml += `<td class="px-2 py-0.5 border border-gray-200 dark:border-gray-700 text-gray-800 dark:text-gray-300 whitespace-nowrap max-w-[200px] truncate" title="${displayVal}">${displayVal}</td>`;
        });
        tableHtml += '</tr>';
    });

    tableHtml += '</tbody></table></div>';
    if (AppState.currentTableFeatures.length >= 100 || AppState.currentTableFeatures.length > displayFeatures.length) {
       tableHtml += `<p class="text-[9px] text-gray-400 dark:text-gray-500 mt-1 italic text-center shrink-0">Showing up to 100 records for preview.</p>`;
    }
    
    attributeTableContainer.innerHTML = tableHtml;
    attachTableResizer();

    document.querySelectorAll('.tbl-header').forEach(th => {
        th.addEventListener('click', (e) => {
            const col = e.currentTarget.getAttribute('data-col');
            if (AppState.tableSortCol === col) AppState.tableSortAsc = !AppState.tableSortAsc;
            else { AppState.tableSortCol = col; AppState.tableSortAsc = true; }
            renderTableContent(layerName); 
        });
    });

    document.querySelectorAll('.tbl-row').forEach(tr => {
        tr.addEventListener('click', (e) => {
            const rowId = parseInt(e.currentTarget.getAttribute('data-id'), 10);
            const isAlreadyHighlighted = AppState.highlightLayer && AppState.highlightLayer._row_id === rowId;
            
            if (AppState.highlightLayer) {
                map.removeLayer(AppState.highlightLayer);
                AppState.highlightLayer = null;
            }

            document.querySelectorAll('.tbl-row').forEach(row => {
                row.classList.remove('bg-cyan-100', 'dark:bg-cyan-900/40');
                row.classList.add('hover:bg-blue-50', 'dark:hover:bg-blue-900/30');
            });

            if (isAlreadyHighlighted) return;

            const targetFeature = AppState.currentTableFeatures.find(f => f.__row_id === rowId);
            if (targetFeature && targetFeature.geometry) {
                if (!map.getPane('highlightPane')) {
                    map.createPane('highlightPane');
                    map.getPane('highlightPane').style.zIndex = 2500; 
                    map.getPane('highlightPane').style.pointerEvents = 'none'; 
                }

                AppState.highlightLayer = L.geoJSON(targetFeature, {
                    pane: 'highlightPane', 
                    interactive: false,
                    style: { color: '#00ffff', weight: 5, opacity: 1, fillColor: '#00ffff', fillOpacity: 0.3 },
                    pointToLayer: (feature, latlng) => {
                        return L.circleMarker(latlng, { pane: 'highlightPane', interactive: false, radius: 10, color: '#00ffff', weight: 4, opacity: 1, fillColor: '#00ffff', fillOpacity: 0.3 });
                    }
                }).addTo(map);
                AppState.highlightLayer._row_id = rowId; 
            }
            
            e.currentTarget.classList.remove('hover:bg-blue-50', 'dark:hover:bg-blue-900/30');
            e.currentTarget.classList.add('bg-cyan-100', 'dark:bg-cyan-900/40');
        });
    });
};

export const handleToggleTable = async (e) => {
  const key = e.currentTarget ? e.currentTarget.getAttribute('data-key') : e;
  const layer = AppState.activeLayers.find(l => l.uniqueKey === key);
  if (!layer || layer.isFolder) return;

  if (AppState.activeTableLayerKey === key && e.currentTarget) { closeTablePanel(); return; }

  closeTablePanel();
  AppState.activeTableLayerKey = key;
  renderAddedLayers(); 
  
  if (!attributeTableContainer) return;
  attributeTableContainer.classList.remove('hidden');
  attributeTableContainer.classList.add('flex');
  
  attributeTableContainer.innerHTML = `
    <div class="table-resizer absolute top-0 left-0 w-full h-1.5 bg-gray-200 hover:bg-blue-400 dark:bg-gray-700 dark:hover:bg-blue-500 cursor-row-resize z-50 transition-colors" title="Drag to resize"></div>
    <div class="flex items-center justify-center h-full pt-2">
        <p class="text-xs text-gray-500 dark:text-gray-400 italic animate-pulse">Fetching attributes...</p>
    </div>`;
  attachTableResizer();

  try {
    let features = [];
    if (layer.isLocalGeoJSON) {
      features = layer.geoJsonData.features || [];
    } else {
      if (!layer.exportUrl) throw new Error("No data endpoint available.");
      let queryUrl = layer.exportUrl;
      if (queryUrl.includes('WFS')) queryUrl += '&maxFeatures=100';
      else if (queryUrl.includes('f=geojson')) queryUrl += '&resultRecordCount=100';

      const res = await fetch(`/proxy?url=${encodeURIComponent(queryUrl)}`);
      if (!res.ok) throw new Error("Failed to fetch attributes.");
      const data = await res.json();
      features = data.features || [];
    }

    if (features.length === 0 || !features[0].properties || Object.keys(features[0].properties).length === 0) {
      attributeTableContainer.innerHTML = `
        <div class="table-resizer absolute top-0 left-0 w-full h-1.5 bg-gray-200 hover:bg-blue-400 dark:bg-gray-700 dark:hover:bg-blue-500 cursor-row-resize z-50 transition-colors" title="Drag to resize"></div>
        <div class="flex justify-between items-center mb-1 shrink-0 border-b border-gray-200 dark:border-gray-700 pb-1 pt-1.5">
            <div class="text-xs font-bold text-gray-700 dark:text-gray-200">${layer.displayName} Data</div>
            <button onclick="window.closeTablePanel()" class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 px-1"><i class="fa-solid fa-times"></i></button>
        </div>
        <p class="text-xs text-gray-500 dark:text-gray-400 italic p-2 text-center">No attributes available.</p>`;
      attachTableResizer();
      return;
    }

    features.forEach((f, i) => f.__row_id = i);
    AppState.currentTableFeatures = features;

    const headerSet = new Set();
    features.forEach(f => {
        if (f.properties) Object.keys(f.properties).forEach(k => headerSet.add(k));
    });
    
    let headers = Array.from(headerSet);
    const bakedCols = ['COLOR_FILL', 'COLOR_OUTLINE'];
    AppState.currentTableHeaders = headers.filter(h => !bakedCols.includes(h)).concat(headers.filter(h => bakedCols.includes(h)));
    
    AppState.tableSortCol = null;
    AppState.tableSortAsc = true;
    renderTableContent(layer.displayName);
  } catch (err) {
    attributeTableContainer.innerHTML = `
      <div class="table-resizer absolute top-0 left-0 w-full h-1.5 bg-gray-200 hover:bg-blue-400 dark:bg-gray-700 dark:hover:bg-blue-500 cursor-row-resize z-50 transition-colors" title="Drag to resize"></div>
      <div class="flex justify-between items-center mb-1 shrink-0 border-b border-gray-200 dark:border-gray-700 pb-1 pt-1.5">
          <div class="text-xs font-bold text-gray-700 dark:text-gray-200">${layer.displayName} Data</div>
          <button onclick="window.closeTablePanel()" class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 px-1"><i class="fa-solid fa-times"></i></button>
      </div>
      <p class="text-xs text-red-500 dark:text-red-400 italic p-2 text-center">Failed to load attribute data.</p>`;
    attachTableResizer();
  }
};

export const handleToggleEdit = async (e, forceStyle = null) => {
    const key = typeof e === 'string' ? e : (e.currentTarget ? e.currentTarget.getAttribute('data-key') : e);
    const layer = AppState.activeLayers.find(l => l.uniqueKey === key);
    if (!layer || layer.isFolder) return;

    if (AppState.activeEditLayerKey === key && e && e.currentTarget) { closeSidebarPanels(); return; }

    closeSidebarPanels();
    AppState.activeEditLayerKey = key;
    renderAddedLayers();
    if (!editPanelContainer) return;
    
    openContextSubmenu();
    editPanelContainer.classList.remove('hidden'); 
    editPanelContainer.classList.add('flex');
    editPanelContainer.innerHTML = '<div class="flex justify-center p-3"><p class="text-xs italic animate-pulse text-gray-500 dark:text-gray-400">Preparing editable vector data...</p></div>';

    const success = await ensureGeoJSON(layer);
    if (!success) { closeSidebarPanels(); return; }

    const features = layer.geoJsonData.features || [];
    const colsSet = new Set();
    features.forEach(f => { if (f.properties) Object.keys(f.properties).forEach(k => colsSet.add(k)); });
    const cols = Array.from(colsSet).sort();

    const numericCols = cols.filter(c => {
        return features.some(f => {
            const v = f.properties ? f.properties[c] : undefined;
            return (v !== undefined && v !== null && v !== '' && !isNaN(Number(v)));
        });
    });

    const hasPoints = features.some(f => f.geometry && (f.geometry.type === 'Point' || f.geometry.type === 'MultiPoint'));
    const cs = forceStyle ? JSON.parse(JSON.stringify(forceStyle)) : (layer.customStyle || { type: 'single', fillColor: '#2563eb', fillOpacity: 0.5, color: '#2563eb', opacity: 1.0, pointShape: 'circle', pointSize: 8 });
    const activeStyleType = cs.type || 'single';
    const pasteDisabled = AppState.copiedStyle ? '' : 'disabled';
    const pasteOpacity = AppState.copiedStyle ? '' : 'opacity-50 cursor-not-allowed';
    const useDataScale = cs.usePointScaleData || false;
    const currentScaleCurve = cs.pointScaleCurve || 'linear';

    editPanelContainer.innerHTML = `
        <div class="p-2 text-xs flex flex-col h-full min-h-0 bg-blue-50/50 dark:bg-transparent">
            <!-- HEADER -->
            <div class="flex justify-between items-center mb-2 pb-1 border-b border-blue-200 dark:border-blue-800 shrink-0">
                <h4 class="font-bold text-gray-700 dark:text-gray-200 uppercase text-[11px] tracking-wider">Edit Appearance</h4>
                <div class="flex space-x-1 items-center">
                    <button id="btn-copy-style" class="text-[10px] bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 px-1.5 py-0.5 rounded transition-colors font-medium" title="Copy Style"><i class="fa-solid fa-copy"></i></button>
                    <button id="btn-paste-style" class="text-[10px] bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 px-1.5 py-0.5 rounded transition-colors font-medium ${pasteOpacity}" title="Paste Style into UI" ${pasteDisabled}><i class="fa-solid fa-paste"></i></button>
                    <button onclick="window.closeSidebarPanels()" class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 ml-1"><i class="fa-solid fa-times text-xs"></i></button>
                </div>
            </div>
            
            <!-- FLEXIBLE CONFIG BODY -->
            <div class="flex-1 min-h-0 flex flex-col overflow-y-auto custom-scroll pr-1 pb-1">
                
                <!-- POINT STYLE OPTIONS -->
                ${hasPoints ? `
                <div id="point-style-container" class="shrink-0 flex flex-col space-y-2 bg-white dark:bg-gray-800 p-2 rounded border border-blue-100 dark:border-blue-800 mb-2">
                    <h5 class="text-[9px] font-bold text-blue-600 dark:text-blue-400 uppercase tracking-wider">Point Markers</h5>
                    <div class="flex items-center space-x-2 w-full">
                        <label class="text-[11px] text-gray-600 dark:text-gray-300 font-bold w-10 shrink-0">Shape:</label>
                        <select id="edit-point-shape" class="flex-1 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white rounded px-1.5 py-0.5 text-xs">
                            <option value="circle" ${cs.pointShape === 'circle' ? 'selected' : ''}>Circle</option>
                            <option value="square" ${cs.pointShape === 'square' ? 'selected' : ''}>Square</option>
                            <option value="triangle" ${cs.pointShape === 'triangle' ? 'selected' : ''}>Triangle</option>
                        </select>
                    </div>

                    <div id="constant-scale-container" class="${useDataScale ? 'hidden' : 'flex'} items-center space-x-2 w-full">
                        <label class="text-[11px] text-gray-600 dark:text-gray-300 font-bold w-10 shrink-0">Scale:</label>
                        <input type="range" id="edit-point-size" min="2" max="30" step="1" value="${cs.pointSize || 8}" class="flex-1 cursor-pointer accent-blue-600 dark:accent-blue-500">
                        <span id="point-size-display" class="text-xs font-mono w-4 text-right">${cs.pointSize || 8}</span>
                    </div>

                    <div class="flex items-center space-x-1.5 pt-1 border-t border-blue-100 dark:border-blue-900">
                        <input type="checkbox" id="use-data-scale" class="w-3.5 h-3.5 text-blue-600 dark:text-blue-500 rounded cursor-pointer accent-blue-600 dark:accent-blue-500" ${useDataScale ? 'checked' : ''}>
                        <label for="use-data-scale" class="text-[11px] font-semibold text-gray-700 dark:text-gray-300 cursor-pointer">Use Data for Scale</label>
                    </div>

                    <div id="data-scale-container" class="${useDataScale ? 'flex' : 'hidden'} flex-col space-y-1.5 bg-blue-50/50 dark:bg-gray-900/50 p-1.5 rounded border border-blue-200 dark:border-blue-800">
                        <div class="flex items-center space-x-1.5">
                            <label class="text-[9px] font-bold text-gray-500 dark:text-gray-400 uppercase w-12 shrink-0">Column:</label>
                            <select id="point-scale-col-select" class="flex-1 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white rounded px-1.5 py-0.5 text-xs">
                                <option value="" disabled ${!cs.pointScaleProp ? 'selected' : ''}>Select numeric attribute...</option>
                                ${numericCols.map(c => `<option value="${c}" ${(useDataScale && cs.pointScaleProp === c) ? 'selected' : ''}>${c}</option>`).join('')}
                            </select>
                        </div>

                        <div class="flex space-x-1.5">
                            <div class="flex-1">
                                <label class="block text-[8px] font-bold text-gray-400 uppercase">Min Data Val</label>
                                <input type="text" id="point-scale-min-data" readonly value="${cs.pointScaleMinData ?? ''}" placeholder="Min" class="w-full px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded text-gray-600 dark:text-gray-300 font-mono text-[10px] cursor-not-allowed">
                            </div>
                            <div class="flex-1">
                                <label class="block text-[8px] font-bold text-gray-400 uppercase">Max Data Val</label>
                                <input type="text" id="point-scale-max-data" readonly value="${cs.pointScaleMaxData ?? ''}" placeholder="Max" class="w-full px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded text-gray-600 dark:text-gray-300 font-mono text-[10px] cursor-not-allowed">
                            </div>
                        </div>

                        <div class="flex space-x-1.5">
                            <div class="flex-1">
                                <label class="block text-[8px] font-bold text-blue-600 dark:text-blue-400 uppercase">Min Scale Size</label>
                                <input type="number" id="point-scale-min-target" min="1" max="50" value="${cs.pointScaleMinTarget ?? 4}" class="w-full px-1.5 py-0.5 bg-white dark:bg-gray-700 border border-blue-300 dark:border-blue-600 rounded text-gray-900 dark:text-white font-mono text-[10px]">
                            </div>
                            <div class="flex-1">
                                <label class="block text-[8px] font-bold text-blue-600 dark:text-blue-400 uppercase">Max Scale Size</label>
                                <input type="number" id="point-scale-max-target" min="1" max="100" value="${cs.pointScaleMaxTarget ?? 24}" class="w-full px-1.5 py-0.5 bg-white dark:bg-gray-700 border border-blue-300 dark:border-blue-600 rounded text-gray-900 dark:text-white font-mono text-[10px]">
                            </div>
                        </div>

                        <div class="pt-0.5">
                            <label class="block text-[8px] font-bold text-gray-500 uppercase mb-0.5">Curve Weighting</label>
                            <div class="grid grid-cols-4 gap-1">
                                <button type="button" class="btn-curve-type text-[9px] py-0.5 border rounded font-semibold transition-colors ${currentScaleCurve === 'linear' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600'}" data-curve="linear">Linear</button>
                                <button type="button" class="btn-curve-type text-[9px] py-0.5 border rounded font-semibold transition-colors ${currentScaleCurve === 'exp' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600'}" data-curve="exp">Exp</button>
                                <button type="button" class="btn-curve-type text-[9px] py-0.5 border rounded font-semibold transition-colors ${currentScaleCurve === 'log' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600'}" data-curve="log">Log</button>
                                <button type="button" class="btn-curve-type text-[9px] py-0.5 border rounded font-semibold transition-colors ${currentScaleCurve === 'sigmoid' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600'}" data-curve="sigmoid">Sigmoid</button>
                            </div>
                        </div>
                    </div>
                </div>
                ` : ''}

                <!-- STYLE TYPE SELECTOR -->
                <div class="shrink-0 flex items-center space-x-1.5 bg-white dark:bg-gray-800 p-1.5 border border-blue-100 dark:border-blue-800 rounded mb-2">
                    <label class="text-[11px] font-semibold text-gray-700 dark:text-gray-300 shrink-0 px-1">Style Type:</label>
                    <select id="edit-style-type" class="flex-1 border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-white rounded px-1.5 py-0.5 text-xs focus:ring-1 focus:ring-blue-500 font-medium">
                        <option value="single" ${activeStyleType === 'single' ? 'selected' : ''}>Single Color</option>
                        <option value="categorical" ${activeStyleType === 'categorical' ? 'selected' : ''}>Categorical (Text)</option>
                        <option value="graduated" ${activeStyleType === 'graduated' ? 'selected' : ''}>Graduated Choropleth (Numeric)</option>
                    </select>
                </div>

                <!-- 1. SINGLE STYLE (SHRINK-0) -->
                <div id="single-style-container" class="${activeStyleType === 'single' ? 'flex' : 'hidden'} shrink-0 flex-col space-y-2 bg-white dark:bg-gray-800 p-2 rounded border border-gray-200 dark:border-gray-700">
                    <div class="flex items-center space-x-2 w-full">
                        <label class="text-[11px] text-gray-600 dark:text-gray-300 font-bold w-10 shrink-0">Fill:</label>
                        <input type="color" id="edit-fill-color" value="${cs.fillColor || '#2563eb'}" class="w-6 h-6 p-0 border-0 rounded cursor-pointer shrink-0 bg-transparent">
                        <input type="range" id="edit-fill-opacity" min="0" max="1" step="0.05" value="${cs.fillOpacity ?? 0.5}" class="flex-1 cursor-pointer accent-blue-600 dark:accent-blue-500">
                    </div>
                    <div class="flex items-center space-x-2 w-full">
                        <label class="text-[11px] text-gray-600 dark:text-gray-300 font-bold w-10 shrink-0">Outline:</label>
                        <input type="color" id="edit-stroke-color" value="${cs.color || '#2563eb'}" class="w-6 h-6 p-0 border-0 rounded cursor-pointer shrink-0 bg-transparent">
                        <input type="range" id="edit-stroke-opacity" min="0" max="1" step="0.05" value="${cs.opacity ?? 1.0}" class="flex-1 cursor-pointer accent-blue-600 dark:accent-blue-500">
                    </div>
                </div>

                <!-- 2. CATEGORICAL STYLE (FLEX-1 MIN-H-[100px]) -->
                <div id="categorical-style-container" class="${activeStyleType === 'categorical' ? 'flex' : 'hidden'} flex-1 flex-col min-h-[100px] border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-800">
                    <div class="shrink-0 p-1.5 border-b border-gray-100 dark:border-gray-700 flex items-center space-x-1.5">
                        <label class="text-[9px] font-bold text-gray-500 dark:text-gray-400 uppercase w-12 shrink-0">Column:</label>
                        <select id="cat-col-select" class="flex-1 border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-white rounded px-1.5 py-0.5 text-xs">
                            <option value="" disabled ${!cs.property ? 'selected' : ''}>Select attribute...</option>
                            ${cols.map(c => `<option value="${c}" ${(activeStyleType === 'categorical' && cs.property === c) ? 'selected' : ''}>${c}</option>`).join('')}
                        </select>
                    </div>
                    <div id="cat-inner-list" class="flex-1 overflow-y-auto custom-scroll p-1.5">
                        <p class="text-xs text-gray-400 dark:text-gray-500 italic text-center py-1 mt-2">Select an attribute column to map colors.</p>
                    </div>
                </div>

                <!-- 3. GRADUATED STYLE (FLEX-1 MIN-H-[100px]) -->
                <div id="graduated-style-container" class="${activeStyleType === 'graduated' ? 'flex' : 'hidden'} flex-1 flex-col min-h-[100px] border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-800">
                    <div class="shrink-0 p-1.5 border-b border-gray-100 dark:border-gray-700 flex items-center space-x-1.5">
                        <label class="text-[9px] font-bold text-gray-500 dark:text-gray-400 uppercase w-12 shrink-0">Numeric:</label>
                        <select id="graduated-col-select" class="flex-1 border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-white rounded px-1.5 py-0.5 text-xs">
                            <option value="" disabled ${!cs.property ? 'selected' : ''}>Select numeric attribute...</option>
                            ${numericCols.map(c => `<option value="${c}" ${(activeStyleType === 'graduated' && cs.property === c) ? 'selected' : ''}>${c}</option>`).join('')}
                        </select>
                    </div>
                    
                    <div class="flex-1 overflow-y-auto custom-scroll p-1.5 space-y-2">
                        <!-- Min config -->
                        <div class="p-1.5 bg-gray-50 dark:bg-gray-900/50 rounded border border-gray-200 dark:border-gray-700">
                            <div class="flex justify-between items-center mb-1">
                                <span class="text-[10px] font-bold text-gray-600 dark:text-gray-300 uppercase">Low Value</span>
                                <input type="text" id="graduated-min-val" readonly value="${cs.graduatedMinVal ?? 'N/A'}" class="w-20 bg-transparent text-right font-mono text-[10px] text-gray-500">
                            </div>
                            <div class="flex items-center space-x-2">
                                <span class="text-[9px] font-bold text-gray-400 w-10">Fill:</span>
                                <input type="color" id="graduated-min-fill" value="${cs.graduatedMinColor || '#ffeda0'}" class="w-5 h-5 p-0 border-0 rounded cursor-pointer bg-transparent">
                                <span class="text-[9px] font-bold text-gray-400 ml-2">Outline:</span>
                                <input type="color" id="graduated-min-stroke" value="${cs.graduatedMinStroke || '#feb24c'}" class="w-5 h-5 p-0 border-0 rounded cursor-pointer bg-transparent">
                            </div>
                        </div>
                        
                        <!-- Max config -->
                        <div class="p-1.5 bg-gray-50 dark:bg-gray-900/50 rounded border border-gray-200 dark:border-gray-700">
                            <div class="flex justify-between items-center mb-1">
                                <span class="text-[10px] font-bold text-gray-600 dark:text-gray-300 uppercase">High Value</span>
                                <input type="text" id="graduated-max-val" readonly value="${cs.graduatedMaxVal ?? 'N/A'}" class="w-20 bg-transparent text-right font-mono text-[10px] text-gray-500">
                            </div>
                            <div class="flex items-center space-x-2">
                                <span class="text-[9px] font-bold text-gray-400 w-10">Fill:</span>
                                <input type="color" id="graduated-max-fill" value="${cs.graduatedMaxColor || '#f03b20'}" class="w-5 h-5 p-0 border-0 rounded cursor-pointer bg-transparent">
                                <span class="text-[9px] font-bold text-gray-400 ml-2">Outline:</span>
                                <input type="color" id="graduated-max-stroke" value="${cs.graduatedMaxStroke || '#bd0026'}" class="w-5 h-5 p-0 border-0 rounded cursor-pointer bg-transparent">
                            </div>
                        </div>
                        
                        <!-- Opacities -->
                        <div class="pt-1">
                            <div class="flex items-center space-x-2 w-full mb-1">
                                <span class="text-[9px] font-bold text-gray-500 dark:text-gray-400 w-12">Fill Op:</span>
                                <input type="range" id="graduated-fill-opacity" min="0" max="1" step="0.05" value="${cs.graduatedFillOpacity ?? 0.7}" class="flex-1 cursor-pointer accent-blue-600">
                            </div>
                            <div class="flex items-center space-x-2 w-full">
                                <span class="text-[9px] font-bold text-gray-500 dark:text-gray-400 w-12">Stroke Op:</span>
                                <input type="range" id="graduated-stroke-opacity" min="0" max="1" step="0.05" value="${cs.graduatedStrokeOpacity ?? 1.0}" class="flex-1 cursor-pointer accent-blue-600">
                            </div>
                        </div>
                    </div>
                </div>

            </div> <!-- END FLEX BODY -->

            <!-- FOOTER -->
            <div class="flex justify-between items-center pt-2 pb-1 border-t border-blue-100 dark:border-blue-800 shrink-0 mt-2 bg-blue-50 dark:bg-gray-900 relative z-10">
                <button id="btn-bake-colors" class="bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 text-[10px] px-2 py-1 rounded transition-colors font-medium border border-gray-300 dark:border-gray-600">
                    <i class="fa-solid fa-database mr-1"></i>Bake to Table
                </button>
                <div class="flex space-x-1.5 items-center">
                    <button id="btn-refresh-colors" class="${activeStyleType === 'categorical' ? '' : 'hidden'} bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 text-[10px] px-2 py-1 rounded transition-colors font-medium border border-gray-300 dark:border-gray-600">
                        <i class="fa-solid fa-arrows-rotate mr-1"></i> Refresh
                    </button>
                    <button id="btn-apply-edit" class="bg-blue-600 hover:bg-blue-700 text-white text-xs px-3 py-1.5 rounded transition-colors font-semibold shadow-xs">Apply Style</button>
                </div>
            </div>
        </div>
    `;

    let activeScaleCurve = currentScaleCurve;

    const extractStyleFromUI = () => {
        const shapeEl = getEl('edit-point-shape');
        const sizeEl = getEl('edit-point-size');
        const pShape = shapeEl ? shapeEl.value : (layer.customStyle?.pointShape || 'circle');
        const pSize = sizeEl ? parseInt(sizeEl.value, 10) : (layer.customStyle?.pointSize || 8);

        const chkDataScale = getEl('use-data-scale');
        const isScaleData = chkDataScale ? chkDataScale.checked : false;
        const pScaleCol = isScaleData ? getEl('point-scale-col-select')?.value : null;
        
        let pMinData = parseFloat(getEl('point-scale-min-data')?.value);
        let pMaxData = parseFloat(getEl('point-scale-max-data')?.value);
        let pMinTarget = parseFloat(getEl('point-scale-min-target')?.value);
        let pMaxTarget = parseFloat(getEl('point-scale-max-target')?.value);

        const scaleStateObj = {
            usePointScaleData: isScaleData,
            pointScaleProp: pScaleCol,
            pointScaleMinData: isNaN(pMinData) ? 0 : pMinData,
            pointScaleMaxData: isNaN(pMaxData) ? 1 : pMaxData,
            pointScaleMinTarget: isNaN(pMinTarget) ? 4 : pMinTarget,
            pointScaleMaxTarget: isNaN(pMaxTarget) ? 24 : pMaxTarget,
            pointScaleCurve: activeScaleCurve || 'linear'
        };

        const activeType = getEl('edit-style-type')?.value || 'single';

        if (activeType === 'categorical') {
            const prop = getEl('cat-col-select')?.value;
            if (!prop) return null;
            const newCategories = {};
            document.querySelectorAll('.cat-row').forEach(row => {
                const val = row.getAttribute('data-val');
                const fillEl = row.querySelector('.cat-fill');
                const fillOpEl = row.querySelector('.cat-fill-op');
                const strokeEl = row.querySelector('.cat-stroke');
                const strokeOpEl = row.querySelector('.cat-stroke-op');

                newCategories[val] = { 
                    fillColor: fillEl ? fillEl.value : '#2563eb', 
                    fillOpacity: fillOpEl ? parseFloat(fillOpEl.value) : 0.5, 
                    color: strokeEl ? strokeEl.value : '#2563eb', 
                    opacity: strokeOpEl ? parseFloat(strokeOpEl.value) : 1.0 
                };
            });
            return { 
                type: 'categorical', property: prop, categories: newCategories, 
                defaultFill: '#cccccc', defaultFillOpacity: 0.5, defaultColor: '#999999', defaultOpacity: 1.0, 
                pointShape: pShape, pointSize: pSize,
                ...scaleStateObj
            };
        } else if (activeType === 'graduated') {
            const prop = getEl('graduated-col-select')?.value;
            if (!prop) return null;
            
            let minData = parseFloat(getEl('graduated-min-val')?.value);
            let maxData = parseFloat(getEl('graduated-max-val')?.value);
            
            return {
                type: 'graduated', property: prop,
                graduatedMinVal: isNaN(minData) ? 0 : minData,
                graduatedMaxVal: isNaN(maxData) ? 1 : maxData,
                graduatedMinColor: getEl('graduated-min-fill')?.value || '#ffeda0',
                graduatedMaxColor: getEl('graduated-max-fill')?.value || '#f03b20',
                graduatedMinStroke: getEl('graduated-min-stroke')?.value || '#feb24c',
                graduatedMaxStroke: getEl('graduated-max-stroke')?.value || '#bd0026',
                graduatedFillOpacity: parseFloat(getEl('graduated-fill-opacity')?.value ?? 0.7),
                graduatedStrokeOpacity: parseFloat(getEl('graduated-stroke-opacity')?.value ?? 1.0),
                pointShape: pShape, pointSize: pSize,
                ...scaleStateObj
            };
        } else {
            return { 
                type: 'single', 
                fillColor: getEl('edit-fill-color')?.value || '#2563eb', 
                fillOpacity: parseFloat(getEl('edit-fill-opacity')?.value ?? 0.5), 
                color: getEl('edit-stroke-color')?.value || '#2563eb', 
                opacity: parseFloat(getEl('edit-stroke-opacity')?.value ?? 1.0), 
                pointShape: pShape, pointSize: pSize,
                ...scaleStateObj 
            }; 
        }
    };

    if (hasPoints) {
        const chkDataScale = getEl('use-data-scale');
        const constantScaleContainer = getEl('constant-scale-container');
        const dataScaleContainer = getEl('data-scale-container');
        const pointScaleColSelect = getEl('point-scale-col-select');
        const inputMinData = getEl('point-scale-min-data');
        const inputMaxData = getEl('point-scale-max-data');

        getEl('edit-point-size')?.addEventListener('input', (e) => {
            const disp = getEl('point-size-display');
            if (disp) disp.textContent = e.target.value;
        });

        chkDataScale?.addEventListener('change', (e) => {
            if (e.target.checked) {
                constantScaleContainer?.classList.add('hidden'); constantScaleContainer?.classList.remove('flex');
                dataScaleContainer?.classList.remove('hidden'); dataScaleContainer?.classList.add('flex');
            } else {
                constantScaleContainer?.classList.remove('hidden'); constantScaleContainer?.classList.add('flex');
                dataScaleContainer?.classList.add('hidden'); dataScaleContainer?.classList.remove('flex');
            }
        });

        const updateMinMaxDataValues = () => {
            if (!pointScaleColSelect || !pointScaleColSelect.value) return;
            const col = pointScaleColSelect.value;
            let min = Infinity, max = -Infinity;
            layer.geoJsonData.features.forEach(f => {
                if (!f.properties) return;
                const v = parseFloat(f.properties[col]);
                if (!isNaN(v)) {
                    if (v < min) min = v;
                    if (v > max) max = v;
                }
            });

            if (min !== Infinity) {
                if (inputMinData) inputMinData.value = min.toFixed(2).replace(/\.00$/, '');
                if (inputMaxData) inputMaxData.value = max.toFixed(2).replace(/\.00$/, '');
            } else {
                if (inputMinData) inputMinData.value = 'N/A';
                if (inputMaxData) inputMaxData.value = 'N/A';
            }
        };

        pointScaleColSelect?.addEventListener('change', updateMinMaxDataValues);
        if (cs.pointScaleProp) updateMinMaxDataValues();

        document.querySelectorAll('.btn-curve-type').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.btn-curve-type').forEach(b => {
                    b.className = 'btn-curve-type text-[9px] py-0.5 border rounded font-semibold transition-colors bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600';
                });
                e.currentTarget.className = 'btn-curve-type text-[9px] py-0.5 border rounded font-semibold transition-colors bg-blue-600 text-white border-blue-600';
                activeScaleCurve = e.currentTarget.getAttribute('data-curve');
            });
        });
    }

    const styleTypeSelect = getEl('edit-style-type');
    const singleContainer = getEl('single-style-container');
    const catContainer = getEl('categorical-style-container');
    const gradContainer = getEl('graduated-style-container');
    const btnRefreshColors = getEl('btn-refresh-colors');

    styleTypeSelect?.addEventListener('change', (e) => {
        const val = e.target.value;
        singleContainer?.classList.replace('flex', 'hidden');
        catContainer?.classList.replace('flex', 'hidden');
        gradContainer?.classList.replace('flex', 'hidden');
        btnRefreshColors?.classList.add('hidden');

        if (val === 'single') {
            singleContainer?.classList.replace('hidden', 'flex');
        } else if (val === 'categorical') {
            catContainer?.classList.replace('hidden', 'flex');
            btnRefreshColors?.classList.remove('hidden');
        } else if (val === 'graduated') {
            gradContainer?.classList.replace('hidden', 'flex');
            const gradColSelect = getEl('graduated-col-select');
            if (gradColSelect && !gradColSelect.value && gradColSelect.options.length > 1) {
                gradColSelect.selectedIndex = 1; 
                gradColSelect.dispatchEvent(new Event('change'));
            }
        }
    });

    const catColSelect = getEl('cat-col-select');
    const catInnerList = getEl('cat-inner-list');

    const renderCategoryPickers = () => {
        if (!catColSelect || !catColSelect.value) return;
        const propName = catColSelect.value;
        let uniqueVals = [...new Set(layer.geoJsonData.features.map(f => f.properties ? f.properties[propName] : undefined))].filter(v => v !== null && v !== undefined);
        if (uniqueVals.length > 200 && !confirm(`Generate color pickers for ${uniqueVals.length} unique values?`)) return;
        if (!catInnerList) return;
        if (uniqueVals.length === 0) { catInnerList.innerHTML = '<p class="text-xs text-gray-400 italic text-center py-1 mt-2">No unique values.</p>'; return; }

        let html = '';
        uniqueVals.forEach(val => {
            let fCol = '#' + Math.floor(Math.random()*16777215).toString(16).padStart(6, '0');
            let sCol = darkenHex(fCol, 0.3), fOp = 0.5, sOp = 1.0;
            if (activeStyleType === 'categorical' && cs.property === propName && cs.categories) {
                const cat = cs.categories[val] || cs.categories[String(val)];
                if (cat) {
                    fCol = cat.fillColor; sCol = cat.color;
                    fOp = cat.fillOpacity ?? 0.5; sOp = cat.opacity ?? 1.0;
                }
            }
            html += `
                <div class="flex items-center justify-between mb-1 pb-1 border-b border-gray-100 dark:border-gray-700 last:border-0 cat-row" data-val="${val}">
                    <span class="text-xs text-gray-700 dark:text-gray-300 truncate flex-1 pr-1" title="${val}">${val}</span>
                    <div class="flex space-x-1 items-center shrink-0">
                        <span class="text-[9px] text-gray-400 font-bold">F:</span>
                        <input type="color" class="cat-fill w-5 h-5 p-0 border-0 rounded cursor-pointer bg-transparent" value="${fCol}">
                        <input type="range" class="cat-fill-op w-16 cursor-pointer accent-blue-600" min="0" max="1" step="0.05" value="${fOp}">
                        <span class="text-[9px] text-gray-400 font-bold ml-1">O:</span>
                        <input type="color" class="cat-stroke w-5 h-5 p-0 border-0 rounded cursor-pointer bg-transparent" value="${sCol}">
                        <input type="range" class="cat-stroke-op w-16 cursor-pointer accent-blue-600" min="0" max="1" step="0.05" value="${sOp}">
                    </div>
                </div>
            `;
        });
        catInnerList.innerHTML = html;
    };

    catColSelect?.addEventListener('change', renderCategoryPickers);
    if (activeStyleType === 'categorical' && cs.property) renderCategoryPickers();

    btnRefreshColors?.addEventListener('click', () => {
        document.querySelectorAll('.cat-row').forEach(row => {
            const newFill = '#' + Math.floor(Math.random()*16777215).toString(16).padStart(6, '0');
            const fillIn = row.querySelector('.cat-fill');
            const strokeIn = row.querySelector('.cat-stroke');
            if (fillIn) fillIn.value = newFill;
            if (strokeIn) strokeIn.value = darkenHex(newFill, 0.3);
        });
    });

    const gradColSelect = getEl('graduated-col-select');
    const updateGraduatedMinMax = () => {
        const col = gradColSelect?.value;
        if (!col) return;
        let min = Infinity, max = -Infinity;
        layer.geoJsonData.features.forEach(f => {
            if (!f.properties) return;
            const v = parseFloat(f.properties[col]);
            if (!isNaN(v)) {
                if (v < min) min = v;
                if (v > max) max = v;
            }
        });

        const minInp = getEl('graduated-min-val');
        const maxInp = getEl('graduated-max-val');
        if (min !== Infinity) {
            minInp.value = min.toFixed(2).replace(/\.00$/, '');
            maxInp.value = max.toFixed(2).replace(/\.00$/, '');
        } else {
            minInp.value = 'N/A';
            maxInp.value = 'N/A';
        }
    };

    gradColSelect?.addEventListener('change', updateGraduatedMinMax);
    if (activeStyleType === 'graduated' && cs.property) updateGraduatedMinMax();

    getEl('btn-copy-style')?.addEventListener('click', () => {
        AppState.copiedStyle = extractStyleFromUI() || layer.customStyle;
        showToast("Style copied to clipboard!");
        const pasteBtn = getEl('btn-paste-style');
        if (pasteBtn) { pasteBtn.disabled = false; pasteBtn.classList.remove('opacity-50', 'cursor-not-allowed'); }
    });

    getEl('btn-paste-style')?.addEventListener('click', () => {
        if (!AppState.copiedStyle) return;
        showToast("Style pasted into UI! Click 'Apply Style' to update map.");
        handleToggleEdit(key, AppState.copiedStyle); 
    });

    getEl('btn-apply-edit')?.addEventListener('click', () => {
        const newStyle = extractStyleFromUI();
        if (!newStyle) return showToast("Please configure valid style mapping.", true);
        
        layer.customStyle = newStyle;
        map.removeLayer(layer.mapLayer);
        const paneName = 'pane-' + layer.uniqueKey;
        const newMapLayer = createCustomGeoJSONLayer(layer.geoJsonData, layer.customStyle, paneName);
        if (layer.isVisible) newMapLayer.addTo(map);
        layer.mapLayer = newMapLayer;
        updateMapLayerOrder();
        showToast("Layer style updated!");
    });

    getEl('btn-bake-colors')?.addEventListener('click', () => {
        const currentStyle = extractStyleFromUI() || layer.customStyle;
        if (!currentStyle) return showToast("Please configure valid style parameters first.", true);

        layer.customStyle = currentStyle;

        let count = 0;
        layer.geoJsonData.features.forEach(f => {
            if (!f.properties) f.properties = {};
            let fColor = '#2563eb', sColor = '#2563eb', fOp = 0.5, sOp = 1.0;

            if (currentStyle.type === 'categorical') {
                const rawVal = f.properties[currentStyle.property];
                const strVal = String(rawVal);
                const cat = currentStyle.categories?.[rawVal] || currentStyle.categories?.[strVal];
                fColor = cat ? cat.fillColor : (currentStyle.defaultFill || '#cccccc');
                sColor = cat ? cat.color : (currentStyle.defaultColor || '#999999');
                fOp = cat ? cat.fillOpacity : (currentStyle.defaultFillOpacity ?? 0.5);
                sOp = cat ? cat.opacity : (currentStyle.defaultOpacity ?? 1.0);
            } else if (currentStyle.type === 'graduated') {
                const rawVal = parseFloat(f.properties[currentStyle.property]);
                if (!isNaN(rawVal)) {
                    const min = typeof currentStyle.graduatedMinVal === 'number' && !isNaN(currentStyle.graduatedMinVal) ? currentStyle.graduatedMinVal : 0;
                    const max = typeof currentStyle.graduatedMaxVal === 'number' && !isNaN(currentStyle.graduatedMaxVal) ? currentStyle.graduatedMaxVal : 1;
                    let t = (max > min) ? (rawVal - min) / (max - min) : 0.5;
                    t = Math.max(0, Math.min(1, isNaN(t) ? 0.5 : t)); 
                    fColor = interpolateColor(currentStyle.graduatedMinColor || '#ffeda0', currentStyle.graduatedMaxColor || '#f03b20', t);
                    sColor = interpolateColor(currentStyle.graduatedMinStroke || '#feb24c', currentStyle.graduatedMaxStroke || '#bd0026', t);
                    fOp = currentStyle.graduatedFillOpacity ?? 0.7;
                    sOp = currentStyle.graduatedStrokeOpacity ?? 1.0;
                } else {
                    fColor = currentStyle.defaultFill || '#cccccc';
                    sColor = currentStyle.defaultColor || '#999999';
                    fOp = currentStyle.defaultFillOpacity ?? 0.5;
                    sOp = currentStyle.defaultOpacity ?? 1.0;
                }
            } else {
                fColor = currentStyle.fillColor || '#2563eb';
                sColor = currentStyle.color || '#2563eb';
                fOp = currentStyle.fillOpacity ?? 0.5;
                sOp = currentStyle.opacity ?? 1.0;
            }

            f.properties['COLOR_FILL'] = hexAlpha(fColor, fOp);
            f.properties['COLOR_OUTLINE'] = hexAlpha(sColor, sOp);
            count++;
        });

        map.removeLayer(layer.mapLayer);
        const paneName = 'pane-' + layer.uniqueKey;
        const newMapLayer = createCustomGeoJSONLayer(layer.geoJsonData, layer.customStyle, paneName);
        if (layer.isVisible) newMapLayer.addTo(map);
        layer.mapLayer = newMapLayer;
        updateMapLayerOrder();

        if (AppState.activeTableLayerKey === layer.uniqueKey) handleToggleTable(layer.uniqueKey);
        showToast(`Baked RGBA hex values to ${count} features!`);
    });
};

export const handleToggleSplit = async (e) => {
    const key = e.currentTarget ? e.currentTarget.getAttribute('data-key') : e;
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
        const splitCol = getEl('split-col-select')?.value;
        if (!splitCol) return showToast("Select an attribute column first.", true);
        
        const uniqueVals = [...new Set(layer.geoJsonData.features.map(f => f.properties ? f.properties[splitCol] : undefined))];
        if (uniqueVals.length > 50 && !confirm(`Create ${uniqueVals.length} layers?`)) return;

        const folderKey = 'folder_' + Math.random().toString(36).substr(2,9);
        const newFolder = {
            isFolder: true, uniqueKey: folderKey, displayName: `Split: ${layer.displayName} [${splitCol}]`,
            isVisible: true, isExpanded: true, parentId: layer.parentId || null
        };
        
        const newLayers = [];
        let createdCount = 0;

        uniqueVals.forEach(val => {
            const filteredFeats = layer.geoJsonData.features.filter(f => f.properties && f.properties[splitCol] === val);
            if (filteredFeats.length === 0) return;

            const newGeoJson = JSON.parse(JSON.stringify({ type: "FeatureCollection", features: filteredFeats }));
            const splitStyleState = layer.customStyle ? JSON.parse(JSON.stringify(layer.customStyle)) : { type: 'single', fillColor: '#2563eb', fillOpacity: 0.5, color: '#2563eb', opacity: 1.0, pointShape: 'circle', pointSize: 8 };

            const uniqueKey = Math.random().toString(36).substr(2,9);
            const paneName = 'pane-' + uniqueKey;

            const newMapLayer = createCustomGeoJSONLayer(newGeoJson, splitStyleState, paneName).addTo(map);

            newLayers.push({
                uniqueKey: uniqueKey, id: `${layer.id}_${val}`, displayName: `${layer.displayName} [${val}]`,
                mapLayer: newMapLayer, exportUrl: null, isLocalGeoJSON: true, geoJsonData: newGeoJson,
                customStyle: splitStyleState, isVisible: true, parentId: folderKey, isFolder: false 
            });
            createdCount++;
        });
        
        AppState.activeLayers = [newFolder, ...newLayers, ...AppState.activeLayers];
        layer.isVisible = false;
        map.removeLayer(layer.mapLayer);
        
        closeSidebarPanels(); renderAddedLayers(); updateMapLayerOrder();
        showToast(`Split into ${createdCount} new layers inside folder!`);
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
  
  let visibleCount = 0;
  document.querySelectorAll('.available-layer-item').forEach(item => {
    if (item.getAttribute('data-search').includes(term)) { item.classList.remove('hidden'); visibleCount++; } 
    else { item.classList.add('hidden'); }
  });
  
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

  AppState.fetchedLayers.forEach((layer) => {
    const div = document.createElement('div');
    div.className = 'available-layer-item flex items-center p-1.5 hover:bg-gray-50 dark:hover:bg-gray-700 rounded border border-transparent hover:border-gray-200 dark:hover:border-gray-600 mb-1 transition-colors';
    div.setAttribute('data-search', `${layer.title} ${layer.id}`.toLowerCase());
    
    div.innerHTML = `
      <div class="flex items-center h-4 mr-2 shrink-0">
         <input id="cb-${layer.id}" type="checkbox" value="${layer.id}" class="w-3.5 h-3.5 layer-checkbox cursor-pointer accent-blue-600 dark:accent-blue-500" title="Preview on Map">
      </div>
      <div class="ml-1 text-xs flex-1 overflow-hidden pr-2 cursor-pointer">
        <label for="cb-${layer.id}" class="font-medium text-gray-700 dark:text-gray-200 block truncate cursor-pointer" title="${layer.title}">${layer.title}</label>
        <p class="text-gray-400 dark:text-gray-500 text-[10px] truncate" title="${layer.id}">ID: ${layer.id}</p>
      </div>
      <button class="btn-add-single shrink-0 bg-blue-100 dark:bg-blue-900/40 hover:bg-blue-200 dark:hover:bg-blue-800 text-blue-700 dark:text-blue-300 w-7 h-7 rounded-full flex items-center justify-center transition-colors shadow-xs" data-id="${layer.id}" title="Add Single Layer"><i class="fa-solid fa-plus text-[10px]"></i></button>
    `;
    availableLayerList.appendChild(div);
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

const addLayerToMap = (layerId, switchTabAfter = true) => {
    const meta = AppState.fetchedLayers.find(l => l.id === layerId);
    if (!meta) return;

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
        const baseUrl = AppState.currentServerUrl.split('?')[0];
        if (AppState.currentServerType === 'WFS') {
          mapLayer = L.tileLayer.wms(baseUrl, { pane: paneName, layers: meta.id, format: 'image/png', transparent: true });
          exportUrl = `${baseUrl}?service=WFS&version=1.1.0&request=GetFeature&typeName=${encodeURIComponent(meta.id)}&outputFormat=application%2Fjson&srsName=EPSG:4326`;
        } else {
          if (!baseUrl.toLowerCase().includes('featureserver')) {
            mapLayer = L.esri.dynamicMapLayer({ pane: paneName, url: baseUrl, layers: [meta.id], opacity: 0.8 });
            exportUrl = `${baseUrl}/${meta.id}/query?where=1=1&outFields=*&f=geojson&outSR=4326`;
          } else {
            const fUrl = baseUrl.endsWith(`/${meta.id}`) ? baseUrl : `${baseUrl}/${meta.id}`;
            mapLayer = L.esri.featureLayer({ pane: paneName, url: fUrl });
            exportUrl = `${fUrl}/query?where=1=1&outFields=*&f=geojson&outSR=4326`;
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

  try {
    if (AppState.currentServerType === 'OVERPASS') {
        const key = getEl('osm-key')?.value.trim();
        const val = getEl('osm-value')?.value.trim();
        const featName = getEl('osm-name')?.value.trim();
        const loc = getEl('osm-location')?.value.trim();
        const geomType = getEl('osm-geom')?.value;

        if (!key) throw new Error("Please enter a Tag Key.");

        let query = `[out:json][timeout:50];\n`;
        let tagFilter = val ? `["${key}"="${val}"]` : `["${key}"]`;
        if (featName) tagFilter += `["name"~"${featName}",i]`;

        if (loc) {
            if (fetchText) fetchText.textContent = 'Locating Area...';
            const nomRes = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(loc)}&format=json&limit=1`);
            const nomData = await nomRes.json();
            if (nomData.length === 0) throw new Error(`Could not find the location: "${loc}"`);
            
            if (fetchText) fetchText.textContent = 'Fetching Data...';
            const place = nomData[0];
            
            if (place.osm_type === 'relation' || place.osm_type === 'way') {
                const areaId = (place.osm_type === 'relation' ? 3600000000 : 2400000000) + parseInt(place.osm_id);
                query += `area(${areaId})->.searchArea;\n(\n`;
                if (geomType === 'all' || geomType === 'points') query += `  node${tagFilter}(area.searchArea);\n`;
                if (geomType === 'all' || geomType === 'lines_polygons') { query += `  way${tagFilter}(area.searchArea);\n  relation${tagFilter}(area.searchArea);\n`; }
                query += `);\n`;
            } else {
                const bb = place.boundingbox; const bbox = `${bb[0]},${bb[2]},${bb[1]},${bb[3]}`;
                query += `(\n`;
                if (geomType === 'all' || geomType === 'points') query += `  node${tagFilter}(${bbox});\n`;
                if (geomType === 'all' || geomType === 'lines_polygons') { query += `  way${tagFilter}(${bbox});\n  relation${tagFilter}(${bbox});\n`; }
                query += `);\n`;
            }
        } else {
            const b = map.getBounds(); const bbox = `${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()}`;
            query += `(\n`;
            if (geomType === 'all' || geomType === 'points') query += `  node${tagFilter}(${bbox});\n`;
            if (geomType === 'all' || geomType === 'lines_polygons') { query += `  way${tagFilter}(${bbox});\n  relation${tagFilter}(${bbox});\n`; }
            query += `);\n`;
        }
        
        query += `out body;\n>;\nout skel qt;`;
        const res = await fetch(`https://overpass-api.de/api/interpreter`, { method: 'POST', body: "data=" + encodeURIComponent(query), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        
        if (!res.ok) throw new Error("Overpass API failed. Query may be too large.");
        const data = await res.json();
        if (!data.elements || data.elements.length === 0) throw new Error("No data found for this query.");

        const geoJson = osmtogeojson(data, { flatProperties: true });
        geoJson.features.forEach(f => {
            if (f.properties) { if (f.properties.id) f.properties.osm_id = f.properties.id; delete f.properties.id; delete f.properties['@id']; delete f.properties['@relations']; delete f.properties.meta; }
        });
        
        if (geomType === 'lines_polygons') geoJson.features = geoJson.features.filter(f => !['Point', 'MultiPoint'].includes(f.geometry?.type));
        else if (geomType === 'points') geoJson.features = geoJson.features.filter(f => ['Point', 'MultiPoint'].includes(f.geometry?.type));

        if (!geoJson.features || geoJson.features.length === 0) throw new Error("No renderable geometry found.");
        
        if (loc || featName) { try { const tempLayer = L.geoJSON(geoJson); const bounds = tempLayer.getBounds(); if(bounds.isValid()) map.fitBounds(bounds); } catch(e) {} }

        let layerName = `OSM: ${key}${val ? '=' + val : ''}`;
        let autoCity = null;
        if (!loc) {
            const cities = {};
            geoJson.features.forEach(f => { const c = f.properties ? (f.properties['addr:city'] || f.properties['is_in:city'] || f.properties['is_in:municipality']) : null; if (c) cities[c] = (cities[c] || 0) + 1; });
            autoCity = Object.keys(cities).sort((a,b) => cities[b] - cities[a])[0];
        }

        if (loc && featName) layerName = `OSM: ${featName}, ${loc} (${key})`;
        else if (featName) layerName = `OSM: ${featName} (${key})`;
        else if (loc) layerName = `OSM: ${loc} (${key}${val ? '=' + val : ''})`;
        else if (geoJson.features.length === 1 && geoJson.features[0].properties && geoJson.features[0].properties.name) layerName = `OSM: ${geoJson.features[0].properties.name} (${key}${val ? '=' + val : ''})`;
        else if (autoCity) layerName = `OSM: ${autoCity} (${key}${val ? '=' + val : ''})`;
        else layerName = `OSM: Map View (${key}${val ? '=' + val : ''})`;

        AppState.fetchedLayers = [{ id: `osm_${Date.now()}`, title: layerName, geoJsonData: geoJson }];
        AppState.lastFetchedOsmGeoJson = geoJson; AppState.lastFetchedOsmLayerName = layerName;
        
        const toolsContainer = getEl('osm-available-tools');
        if (toolsContainer) { toolsContainer.classList.remove('hidden'); toolsContainer.classList.add('flex'); }

        const cols = new Set();
        geoJson.features.forEach(f => { if(f.properties) Object.keys(f.properties).forEach(k => cols.add(k)); });
        
        const sel = getEl('available-split-col');
        if (sel) {
            sel.innerHTML = '<option value="" disabled selected>Select attribute...</option>';
            Array.from(cols).sort().forEach(c => { sel.innerHTML += `<option value="${c}">${c}</option>`; });
        }

        renderAvailableLayers(); switchTab('available'); showToast(`Fetched ${geoJson.features.length} OSM features for preview!`);
        return;
    }

    const sUrl = getEl('server-url');
    const rawUrl = sUrl ? sUrl.value.trim() : '';
    if (!rawUrl) throw new Error("Enter URL.");
    AppState.currentServerUrl = rawUrl; AppState.fetchedLayers = []; 
    if (layerSearch) layerSearch.value = ''; 
    btnClearSearch?.classList.add('hidden');
    
    const toolsContainer = getEl('osm-available-tools');
    if (toolsContainer) { toolsContainer.classList.add('hidden'); toolsContainer.classList.remove('flex'); }

    let targetUrl = new URL(rawUrl);
    if (AppState.currentServerType === 'WFS') { targetUrl.searchParams.set('service', 'WFS'); targetUrl.searchParams.set('request', 'GetCapabilities'); } 
    else { targetUrl.searchParams.set('f', 'json'); }

    const proxyRes = await fetch(`/proxy?url=${encodeURIComponent(targetUrl.toString())}`);
    if (!proxyRes.ok) throw new Error("Proxy error");

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
    if (AppState.currentServerType !== 'OVERPASS' && availableLayerList) {
        availableLayerList.innerHTML = `<p class="text-xs text-red-500 italic text-center mt-3">Failed to fetch. Check server URL.</p>`; searchContainer?.classList.add('hidden');
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
getEl('toggle-workspace')?.addEventListener('click', () => {
    getEl('content-workspace')?.classList.toggle('hidden');
    getEl('icon-workspace')?.classList.toggle('-rotate-90');
});

getEl('toggle-database')?.addEventListener('click', () => {
    getEl('content-database')?.classList.toggle('hidden');
    getEl('icon-database')?.classList.toggle('-rotate-90');
});

tabBtnAvailable?.addEventListener('click', () => switchTab('available'));
tabBtnAdded?.addEventListener('click', () => switchTab('added'));

savedServersSelect?.addEventListener('change', (e) => {
    const opt = e.target.options[e.target.selectedIndex];
    if (opt.value) {
        const sUrl = getEl('server-url');
        const sType = getEl('server-type');
        if (sUrl) sUrl.value = opt.value;
        if (sType && opt.dataset.type) {
            const rawType = opt.dataset.type.toUpperCase();
            if (rawType.includes('ARCGIS') || rawType.includes('ESRI') || rawType.includes('REST')) sType.value = 'ARCGIS';
            else if (rawType.includes('WFS') || rawType.includes('OGC')) sType.value = 'WFS';
            else if (rawType.includes('OVERPASS') || rawType.includes('OSM')) sType.value = 'OVERPASS';
            else sType.value = rawType;
            sType.dispatchEvent(new Event('change'));
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
            removePane(l.uniqueKey); 
        });
        AppState.activeLayers = []; 
        
        // NEW: Wipe the offline IndexedDB cache
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
    const saveBtn = getEl('btn-save-server');
    const urlFetchBtn = getEl('btn-fetch-url');

    if (type === 'OVERPASS') {
        getEl('server-url-container')?.classList.add('hidden');
        getEl('overpass-builder')?.classList.remove('hidden');
        if (urlFetchBtn) urlFetchBtn.classList.add('hidden');
        if (saveBtn) { saveBtn.disabled = true; saveBtn.classList.add('opacity-50'); }
    } else {
        getEl('server-url-container')?.classList.remove('hidden');
        getEl('overpass-builder')?.classList.add('hidden');
        if (urlFetchBtn) urlFetchBtn.classList.remove('hidden');
        if (saveBtn) { saveBtn.disabled = false; saveBtn.classList.remove('opacity-50'); }
        const tools = getEl('osm-available-tools');
        if (tools) { tools.classList.add('hidden'); tools.classList.remove('flex'); }
    }
});

btnAddBulk?.addEventListener('click', () => {
  const cbs = document.querySelectorAll('.layer-checkbox:checked');
  if (cbs.length === 0) return showToast("Select at least one layer to add.", true);
  cbs.forEach(cb => { togglePreviewLayer(cb.value, false); cb.checked = false; addLayerToMap(cb.value, false); });
  renderAddedLayers(); switchTab('added'); showToast(`Bulk added ${cbs.length} layers to map!`);
});

getEl('btn-available-split')?.addEventListener('click', () => {
    const splitCol = getEl('available-split-col')?.value;
    if (!splitCol) return showToast("Select an attribute column first.", true);
    if (!AppState.lastFetchedOsmGeoJson) return;
    
    const uniqueVals = [...new Set(AppState.lastFetchedOsmGeoJson.features.map(f => f.properties ? f.properties[splitCol] : undefined))];
    if (uniqueVals.length > 50 && !confirm(`This will unpack ${uniqueVals.length} layers into the list below. Proceed?`)) return;
    
    clearAllPreviews(); 
    AppState.fetchedLayers = []; 
    
    uniqueVals.forEach(val => {
        const filteredFeats = AppState.lastFetchedOsmGeoJson.features.filter(f => f.properties && f.properties[splitCol] === val);
        if (filteredFeats.length === 0) return;
        
        const displayVal = (val === null || val === undefined || val === '') ? 'null' : val;
        let extraName = '';
        if (filteredFeats.length === 1 && filteredFeats[0].properties.name && splitCol !== 'name') {
            extraName = ` - ${filteredFeats[0].properties.name}`;
        }
        
        AppState.fetchedLayers = [...AppState.fetchedLayers, {
            id: `osm_${Date.now()}_${Math.random().toString(36).substr(2,5)}`,
            title: `${AppState.lastFetchedOsmLayerName} [${splitCol}: ${displayVal}]${extraName}`,
            geoJsonData: { type: "FeatureCollection", features: filteredFeats }
        }];
    });
    renderAvailableLayers();
    showToast(`Successfully unpacked into ${AppState.fetchedLayers.length} sub-layers!`);
});

layerSearch?.addEventListener('input', triggerSearch);
btnClearSearch?.addEventListener('click', () => { if (layerSearch) { layerSearch.value = ''; triggerSearch(); layerSearch.focus(); } });
addedLayerSearch?.addEventListener('input', triggerAddedSearch);
btnClearAddedSearch?.addEventListener('click', () => { if (addedLayerSearch) { addedLayerSearch.value = ''; triggerAddedSearch(); addedLayerSearch.focus(); } });
filterDataSearch?.addEventListener('input', triggerFilterDataSearch);
btnClearFilterSearch?.addEventListener('click', () => { if (filterDataSearch) { filterDataSearch.value = ''; triggerFilterDataSearch(); filterDataSearch.focus(); } });

btnOsmInspect?.addEventListener('click', () => {
    const container = getEl('osm-inspect-container');
    const status = getEl('osm-inspect-status');
    const results = getEl('osm-inspect-results');

    container?.classList.remove('hidden');
    container?.classList.add('flex');
    if (status) {
        status.textContent = 'Click and drag a box on the map...';
        status.classList.remove('hidden');
    }
    if (results) results.innerHTML = '';
    
    AppState.drawingMode = 'inspect';
    drawLayerGroup.clearLayers();
    map.getContainer().style.cursor = 'crosshair';
    showToast("Click and drag a box on the map to inspect tags.");
});

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

const initOsmDatalists = () => {
    const keysList = getEl('osm-keys');
    const valuesList = getEl('osm-values');
    const keyInput = getEl('osm-key');

    if (keysList) keysList.innerHTML = Object.keys(commonOsmTags).map(k => `<option value="${k}">`).join('');

    const populateValues = (selectedKey) => {
        if (!valuesList) return;
        const key = selectedKey ? selectedKey.toLowerCase().trim() : '';
        const values = commonOsmTags[key] || ['yes'];
        valuesList.innerHTML = values.map(v => `<option value="${v}">`).join('');
    };

    keyInput?.addEventListener('input', (e) => populateValues(e.target.value));
    keyInput?.addEventListener('focus', (e) => populateValues(e.target.value));
};

loadSavedServers();
initOsmDatalists();

// Persist position and zoom whenever the user moves the map
map.on('moveend', () => {
    autoSaveWorkspace();
});

map.on('zoomend', () => {
    autoSaveWorkspace();
});

// The synchronous localStorage check has been removed to prevent the boot-time DB wipe.
// Workspace restoration is now handled exclusively by the DOMContentLoaded listener below.


// ==========================================
// 9. SIDEBAR HORIZONTAL RESIZER
// ==========================================
const initSidebarResizer = () => {
    const leftPanel = getEl('left-panel');
    const resizer = getEl('sidebar-resizer');
    if (!leftPanel || !resizer) return;

    const minWidth = leftPanel.offsetWidth || 320;
    let isResizing = false;

    resizer.addEventListener('mousedown', (e) => {
        e.preventDefault();
        isResizing = true;
        document.body.classList.add('select-none', 'cursor-col-resize');

        const doDrag = (moveEvt) => {
            if (!isResizing) return;
            const newWidth = Math.max(minWidth, moveEvt.clientX);
            leftPanel.style.width = `${newWidth}px`;
            // Removed map.invalidateSize() from here to stop the continuous render lag
        };

        const stopDrag = () => {
            if (isResizing) {
                isResizing = false;
                document.body.classList.remove('select-none', 'cursor-col-resize');
                window.removeEventListener('mousemove', doDrag);
                window.removeEventListener('mouseup', stopDrag);
                
                // Fire the map recalculation only once the user finishes dragging
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
            // Allow manual drag up to 85% of the window height
            const maxDragHeight = window.innerHeight * 0.85;
            const newHeight = Math.max(120, Math.min(maxDragHeight, startHeight + dy));
            
            // Override the Tailwind max-h class so it can grow beyond 45%
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
    searchNode.parentNode.insertBefore(searchNode, searchNode.parentNode.firstChild);
}
// --- OFFLINE CACHING: INDEXEDDB HELPERS ---
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
// --- RESTORE ON REFRESH ---
window.addEventListener('DOMContentLoaded', async () => {
    try {
        const savedState = await loadStateFromDB();
        if (savedState && savedState.activeLayers && savedState.activeLayers.length > 0) {
            console.log("Restoring workspace from IndexedDB...");
            isRestoringHistory = true; // Lock autosave during load
            try {
                restoreWorkspaceState(savedState);
            } finally {
                isRestoringHistory = false; // Unlock autosave
            }
        } else {
            // Only trigger an initial save if we confirmed the DB is actually empty
            autoSaveWorkspace();
        }
    } catch (e) {
        console.error("Failed to restore workspace from IndexedDB:", e);
        // Fallback to seeding empty state if DB read fails entirely
        autoSaveWorkspace(); 
    }
});

async function clearWorkspaceDB() {
    const db = await initWorkspaceDB();
    const tx = db.transaction('workspace', 'readwrite');
    tx.objectStore('workspace').clear();
}

// ==========================================
// 12. SERVICE WORKER REGISTRATION
// ==========================================
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        // We request the worker from the root URL so it has security scope over the entire app
        navigator.serviceWorker.register('/sw.js')
            .then(reg => console.log('Service Worker registered with scope:', reg.scope))
            .catch(err => console.error('Service Worker registration failed:', err));
    });
}

