// ==========================================
// 1. INITIALIZATION & VARIABLES
// ==========================================
const map = L.map('map', { preferCanvas: true }).setView([0, 0], 2);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);

// Force Leaflet's built-in popups to render above all custom dynamic layers
map.getPane('popupPane').style.zIndex = 3000;

map.createPane('previewPane');
map.getPane('previewPane').style.zIndex = 2000;
map.getPane('previewPane').style.pointerEvents = 'none';
const previewRenderer = L.canvas({ pane: 'previewPane' });

let fetchedLayers = [];
let activeLayers = [];
let previewLayers = {}; 
let currentServerUrl = '';
let currentServerType = '';

let lastFetchedOsmGeoJson = null;
let lastFetchedOsmLayerName = '';

let activeTableLayerKey = null; 
let activeEditLayerKey = null;
let activeSplitLayerKey = null;
let activeCropLayerKey = null;
let copiedStyle = null;

let drawingMode = null; 
let drawStart = null;
let tempShape = null; 
let filterGeometryData = null; 
const drawLayerGroup = L.featureGroup().addTo(map);

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

// Popular OSM Tag Combo-Box Dictionary
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
// 2. CORE UTILITIES
// ==========================================
const showToast = (msg, isError=false) => {
  if (!toast) return;
  toast.className = `fixed bottom-6 right-6 px-4 py-3 rounded shadow-xl transform transition-all duration-300 z-50 max-w-sm ${isError ? 'bg-red-600 text-white' : 'bg-gray-800 dark:bg-gray-700 text-white'}`;
  const msgEl = getEl('toast-message');
  if (msgEl) msgEl.textContent = msg;
  toast.classList.remove('translate-y-20', 'opacity-0');
  setTimeout(() => toast.classList.add('translate-y-20', 'opacity-0'), 5000);
};

const darkenHex = (hex = '#2563eb', percent = 0.3) => {
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    let r = parseInt(hex.substring(0, 2), 16) || 37;
    let g = parseInt(hex.substring(2, 4), 16) || 99;
    let b = parseInt(hex.substring(4, 6), 16) || 235;
    r = Math.max(0, Math.floor(r * (1 - percent)));
    g = Math.max(0, Math.floor(g * (1 - percent)));
    b = Math.max(0, Math.floor(b * (1 - percent)));
    return '#' + r.toString(16).padStart(2, '0') + g.toString(16).padStart(2, '0') + b.toString(16).padStart(2, '0');
};

const hexAlpha = (hex = '#2563eb', alpha = 1.0) => {
    if (!hex) hex = '#2563eb';
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    const validAlpha = Math.max(0, Math.min(1, isNaN(parseFloat(alpha)) ? 1.0 : parseFloat(alpha)));
    const a = Math.round(validAlpha * 255).toString(16).padStart(2, '0');
    return (`#${hex}${a}`).toUpperCase();
};

const removePane = (uniqueKey) => {
    const paneName = 'pane-' + uniqueKey;
    const pane = map.getPane(paneName);
    if (pane) {
        L.DomUtil.remove(pane);
        delete map._panes[paneName];
    }
};

const updateMapLayerOrder = () => {
    for (let i = activeLayers.length - 1; i >= 0; i--) {
        const layer = activeLayers[i];
        if (!layer.isVisible) continue;
        const pane = map.getPane('pane-' + layer.uniqueKey);
        if (pane) pane.style.zIndex = 1000 - i;
    }
    autoSaveWorkspace(); 
};

const clearAllPreviews = () => {
    Object.values(previewLayers).forEach(layer => map.removeLayer(layer));
    previewLayers = {};
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
  showToast(`Exported successfully!`);
};

const openContextSubmenu = () => {
    getEl('context-panel-wrapper')?.classList.remove('hidden');
    getEl('context-panel-wrapper')?.classList.add('flex');
    getEl('context-resizer')?.classList.remove('hidden');
};

const closeAllPanels = () => {
    activeTableLayerKey = null;
    activeEditLayerKey = null;
    activeSplitLayerKey = null;
    activeCropLayerKey = null;
    
    attributeTableContainer?.classList.add('hidden'); 
    attributeTableContainer?.classList.remove('flex');
    
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
    filterGeometryData = null;
    drawingMode = null;
    if (btnApplyFilter) btnApplyFilter.disabled = true;
    drawStatus?.classList.add('hidden');
    map.getContainer().style.cursor = '';
    
    if (activeLayers.length > 0) renderAddedLayers();
};
window.closeAllPanels = closeAllPanels;

const switchTab = (tabName) => {
  const isAvailable = (tabName === 'available');
  if (tabBtnAvailable) tabBtnAvailable.className = `flex-1 py-1.5 text-xs font-semibold uppercase tracking-wider transition-colors border-b-2 ${isAvailable ? 'text-blue-600 dark:text-blue-400 border-blue-600 dark:border-blue-400' : 'text-gray-500 dark:text-gray-400 border-transparent hover:text-gray-700 dark:hover:text-gray-200'}`;
  if (tabBtnAdded) tabBtnAdded.className = `flex-1 py-1.5 text-xs font-semibold uppercase tracking-wider transition-colors border-b-2 ${!isAvailable ? 'text-blue-600 dark:text-blue-400 border-blue-600 dark:border-blue-400' : 'text-gray-500 dark:text-gray-400 border-transparent hover:text-gray-700 dark:hover:text-gray-200'}`;
  
  if (isAvailable) {
    tabAvailable?.classList.replace('hidden', 'flex');
    tabAdded?.classList.replace('flex', 'hidden');
    btnAddBulk?.classList.remove('hidden');
  } else {
    tabAdded?.classList.replace('hidden', 'flex');
    tabAvailable?.classList.replace('flex', 'hidden');
    btnAddBulk?.classList.add('hidden');
  }
};


// ==========================================
// 3. SVG STYLING & RENDERING
// ==========================================
const createGeoJsonStyleFunction = (styleState) => {
    return function(feature) {
        if (!feature || !feature.properties) return { fillColor: '#2563eb', fillOpacity: 0.5, color: '#2563eb', opacity: 1.0, weight: 2 };
        
        if (styleState && styleState.type === 'categorical') {
            const rawVal = feature.properties[styleState.property];
            const strVal = String(rawVal);
            const cat = styleState.categories?.[rawVal] || styleState.categories?.[strVal];
            return {
                fillColor: cat ? cat.fillColor : (styleState.defaultFill || '#cccccc'),
                fillOpacity: cat ? cat.fillOpacity : (styleState.defaultFillOpacity ?? 0.5),
                color: cat ? cat.color : (styleState.defaultColor || '#999999'),
                opacity: cat ? cat.opacity : (styleState.defaultOpacity ?? 1.0),
                weight: 2
            };
        } else {
            return {
                fillColor: styleState ? (styleState.fillColor || '#2563eb') : '#2563eb',
                fillOpacity: styleState ? (styleState.fillOpacity ?? 0.5) : 0.5,
                color: styleState ? (styleState.color || '#2563eb') : '#2563eb',
                opacity: styleState ? (styleState.opacity ?? 1.0) : 1.0,
                weight: 2
            };
        }
    };
};

const createGeoJsonPointToLayer = (styleState, paneName, customRenderer) => {
    return function(feature, latlng) {
        let fColor = '#2563eb', sColor = '#2563eb', fOp = 0.5, sOp = 1.0;
        if (styleState && styleState.type === 'categorical' && feature.properties) {
            const rawVal = feature.properties[styleState.property];
            const strVal = String(rawVal);
            const cat = styleState.categories?.[rawVal] || styleState.categories?.[strVal];
            fColor = cat ? cat.fillColor : (styleState.defaultFill || '#cccccc');
            sColor = cat ? cat.color : (styleState.defaultColor || '#999999');
            fOp = cat ? cat.fillOpacity : (styleState.defaultFillOpacity ?? 0.5);
            sOp = cat ? cat.opacity : (styleState.defaultOpacity ?? 1.0);
        } else if (styleState) {
            fColor = styleState.fillColor || '#2563eb';
            sColor = styleState.color || '#2563eb';
            fOp = styleState.fillOpacity ?? 0.5;
            sOp = styleState.opacity ?? 1.0;
        }
        
        const shape = styleState ? (styleState.pointShape || 'circle') : 'circle';
        let size = styleState ? (styleState.pointSize || 8) : 8;

        if (styleState && styleState.usePointScaleData && styleState.pointScaleProp && feature.properties) {
            const val = parseFloat(feature.properties[styleState.pointScaleProp]);
            if (!isNaN(val)) {
                const minD = styleState.pointScaleMinData ?? 0;
                const maxD = styleState.pointScaleMaxData ?? 1;
                const minT = styleState.pointScaleMinTarget ?? 4;
                const maxT = styleState.pointScaleMaxTarget ?? 24;
                const curve = styleState.pointScaleCurve || 'linear';

                let t = (maxD > minD) ? (val - minD) / (maxD - minD) : 0.5;
                t = Math.max(0, Math.min(1, isNaN(t) ? 0.5 : t)); 

                if (curve === 'exp') t = Math.pow(t, 2);
                else if (curve === 'log') t = Math.sqrt(t);
                else if (curve === 'sigmoid') t = 1 / (1 + Math.exp(-10 * (t - 0.5)));

                size = minT + t * (maxT - minT);
            }
        }
        size = Math.max(1, isNaN(size) ? 8 : size);
        
        if (shape === 'circle') {
            return L.circleMarker(latlng, { 
                pane: paneName, 
                renderer: customRenderer, 
                interactive: true,
                radius: size, 
                fillColor: fColor, 
                color: sColor, 
                weight: 2, 
                opacity: sOp, 
                fillOpacity: fOp 
            });
        } else {
            const w = size * 2 + 4; 
            const c = w / 2;
            let svgHtml = '';
            if (shape === 'square') {
                svgHtml = `<svg width="${w}" height="${w}" viewBox="0 0 ${w} ${w}" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="2" width="${w-4}" height="${w-4}" fill="${fColor}" fill-opacity="${fOp}" stroke="${sColor}" stroke-opacity="${sOp}" stroke-width="2"/></svg>`;
            } else if (shape === 'triangle') {
                svgHtml = `<svg width="${w}" height="${w}" viewBox="0 0 ${w} ${w}" xmlns="http://www.w3.org/2000/svg"><polygon points="2,${w-2} ${c},2 ${w-2},${w-2}" fill="${fColor}" fill-opacity="${fOp}" stroke="${sColor}" stroke-opacity="${sOp}" stroke-width="2" stroke-linejoin="round"/></svg>`;
            }
            return L.marker(latlng, {
                pane: paneName,
                interactive: true,
                icon: L.divIcon({ className: '', html: svgHtml, iconSize: [w, w], iconAnchor: [c, c] }) 
            });
        }
    };
};

const attachPopupsToFeatures = function(feature, l) {
    if (feature && feature.properties) {
        let popupContent = '<div class="max-h-48 overflow-y-auto custom-scroll"><table class="text-xs text-left w-full text-gray-800 dark:text-gray-200">';
        for (let k in feature.properties) {
            popupContent += `<tr class="border-b border-gray-200 dark:border-gray-600"><td class="font-bold pr-2 py-1">${k}</td><td class="py-1">${feature.properties[k]}</td></tr>`;
        }
        popupContent += '</table></div>';
        l.bindPopup(popupContent);
    }
};

const createCustomGeoJSONLayer = (geoJsonData, styleState, paneName) => {
    if (!map.getPane(paneName)) map.createPane(paneName);
    const paneRenderer = L.svg({ pane: paneName, padding: 0.5 });
    
    return L.geoJSON(geoJsonData, {
        pane: paneName,
        renderer: paneRenderer,
        interactive: true,
        style: createGeoJsonStyleFunction(styleState),
        pointToLayer: createGeoJsonPointToLayer(styleState, paneName, paneRenderer),
        onEachFeature: (feature, layer) => {
            attachPopupsToFeatures(feature, layer);
            if (layer.getElement) {
                const el = layer.getElement();
                if (el) el.style.pointerEvents = 'auto';
            }
        }
    });
};

const ensureGeoJSON = async (layer) => {
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

const togglePreviewLayer = (layerId, isVisible) => {
    if (!isVisible) {
        if (previewLayers[layerId]) { map.removeLayer(previewLayers[layerId]); delete previewLayers[layerId]; }
        return;
    }

    const meta = fetchedLayers.find(l => l.id === layerId);
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
        const baseUrl = currentServerUrl.split('?')[0];
        if (currentServerType === 'WFS') {
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
    previewLayers[layerId] = mapLayer;
};


// ==========================================
// 4. WORKSPACE PERSISTENCE
// ==========================================
const serializeWorkspace = () => {
    const center = map.getCenter();
    const zoom = map.getZoom();
    const layersData = activeLayers.map(l => ({
        uniqueKey: l.uniqueKey, id: l.id, displayName: l.displayName, exportUrl: l.exportUrl,
        isLocalGeoJSON: l.isLocalGeoJSON, geoJsonData: l.geoJsonData, customStyle: l.customStyle, isVisible: l.isVisible
    }));
    return { version: "1.0", savedAt: new Date().toISOString(), mapState: { lat: center.lat, lng: center.lng, zoom }, activeLayers: layersData };
};

const autoSaveWorkspace = () => {
    try { localStorage.setItem('gis_previewer_auto_save', JSON.stringify(serializeWorkspace())); } catch (e) {}
};

const restoreWorkspaceState = (data) => {
    closeAllPanels();
    clearAllPreviews();

    activeLayers.forEach(l => {
        if (l.mapLayer) map.removeLayer(l.mapLayer);
        removePane(l.uniqueKey);
    });
    activeLayers = [];

    if (data.mapState && data.mapState.lat !== undefined) {
        map.setView([data.mapState.lat, data.mapState.lng], data.mapState.zoom || 10);
    }

    if (data.activeLayers && Array.isArray(data.activeLayers)) {
        data.activeLayers.forEach(lData => {
            let mapLayer;
            const uniqueKey = lData.uniqueKey || Math.random().toString(36).substr(2,9);
            const paneName = 'pane-' + uniqueKey;
            
            if (!map.getPane(paneName)) map.createPane(paneName);
            
            if (lData.isLocalGeoJSON && lData.geoJsonData) {
                mapLayer = createCustomGeoJSONLayer(lData.geoJsonData, lData.customStyle, paneName);
            } else if (lData.exportUrl) {
                const baseUrl = lData.exportUrl.split('?')[0];
                if (lData.exportUrl.includes('WFS')) {
                    mapLayer = L.tileLayer.wms(baseUrl, { pane: paneName, layers: lData.id, format: 'image/png', transparent: true });
                } else if (lData.exportUrl.includes('featureserver')) {
                    mapLayer = L.esri.featureLayer({ pane: paneName, url: baseUrl });
                } else {
                    mapLayer = L.esri.dynamicMapLayer({ pane: paneName, url: baseUrl, layers: [lData.id], opacity: 0.8 });
                }
            }

            if (mapLayer) {
                if (lData.isVisible) mapLayer.addTo(map);
                activeLayers.push({
                    uniqueKey: uniqueKey, id: lData.id, displayName: lData.displayName, mapLayer: mapLayer,
                    exportUrl: lData.exportUrl, isLocalGeoJSON: lData.isLocalGeoJSON, geoJsonData: lData.geoJsonData,
                    customStyle: lData.customStyle, isVisible: lData.isVisible ?? true
                });
            }
        });
    }

    if (activeLayers.length > 0) {
        renderAddedLayers();
        updateMapLayerOrder();
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
// 5. OSM INSPECT AREA TOOL
// ==========================================
const executeOsmInspect = async (bounds) => {
    const container = getEl('osm-inspect-container');
    const status = getEl('osm-inspect-status');
    const results = getEl('osm-inspect-results');

    if (!status || !results) return;
    container?.classList.remove('hidden');
    container?.classList.add('flex');
    status.textContent = 'Scanning area...';
    status.classList.remove('hidden');
    results.innerHTML = '';
    
    try {
        const bbox = `${bounds.getSouth()},${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()}`;
        const query = `[out:json][timeout:25];\n(\n  node(${bbox});\n  way(${bbox});\n  relation(${bbox});\n);\nout tags;`;
        
        const res = await fetch(`https://overpass-api.de/api/interpreter`, { 
            method: 'POST', body: "data=" + encodeURIComponent(query), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } 
        });
        
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
        
        if (sortedTags.length === 0) {
            status.textContent = 'No generic tags found in this area.';
            return;
        }
        
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
        
    } catch (err) {
        status.textContent = 'Scan failed. Area might be too large.';
    }
};


// ==========================================
// 6. MAIN LAYER ACTION HANDLERS
// ==========================================
const handleReorder = (e) => {
    const btn = e.currentTarget;
    const key = btn.getAttribute('data-key');
    const action = btn.getAttribute('data-action');
    const idx = activeLayers.findIndex(l => l.uniqueKey === key);
    if (idx === -1) return;

    const layer = activeLayers.splice(idx, 1)[0];
    if (action === 'top') { activeLayers.unshift(layer); } 
    else if (action === 'up') { activeLayers.splice(Math.max(0, idx - 1), 0, layer); } 
    else if (action === 'down') { activeLayers.splice(Math.min(activeLayers.length, idx + 1), 0, layer); } 
    else if (action === 'bottom') { activeLayers.push(layer); }

    renderAddedLayers();
    updateMapLayerOrder();
};

const handleToggleVisibility = (e) => {
  const key = e.target.getAttribute('data-key');
  const layer = activeLayers.find(l => l.uniqueKey === key);
  if (!layer) return;
  layer.isVisible = e.target.checked;
  if (layer.isVisible) { 
    map.addLayer(layer.mapLayer); 
    updateMapLayerOrder(); 
  } else { 
    map.removeLayer(layer.mapLayer); 
    autoSaveWorkspace(); 
  }
};

const handleRename = (e) => {
  const layer = activeLayers.find(l => l.uniqueKey === e.currentTarget.getAttribute('data-key'));
  const newName = prompt("Enter new display name:", layer.displayName);
  if (newName) { layer.displayName = newName.trim(); renderAddedLayers(); autoSaveWorkspace(); }
};

const handleRemove = (e) => {
  const key = e.currentTarget.getAttribute('data-key');
  const idx = activeLayers.findIndex(l => l.uniqueKey === key);
  map.removeLayer(activeLayers[idx].mapLayer);
  removePane(key); 
  activeLayers.splice(idx, 1);
  if (activeTableLayerKey === key || activeEditLayerKey === key || activeSplitLayerKey === key || activeCropLayerKey === key) { 
     closeAllPanels(); 
  } else { renderAddedLayers(); }
  autoSaveWorkspace();
};

const handleExport = async (e) => {
  const layer = activeLayers.find(l => l.uniqueKey === e.currentTarget.getAttribute('data-key'));
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

const handleDuplicate = async (e) => {
    const key = e.currentTarget.getAttribute('data-key');
    const layer = activeLayers.find(l => l.uniqueKey === key);
    showToast(`Duplicating ${layer.displayName}...`);
    
    const success = await ensureGeoJSON(layer);
    if (!success) return;

    const newGeoJson = JSON.parse(JSON.stringify(layer.geoJsonData));
    const defaultStyle = { type: 'single', fillColor: '#2563eb', fillOpacity: 0.5, color: '#2563eb', opacity: 1.0, pointShape: 'circle', pointSize: 8 };
    const newStyleState = layer.customStyle ? JSON.parse(JSON.stringify(layer.customStyle)) : defaultStyle;

    const uniqueKey = Math.random().toString(36).substr(2,9);
    const paneName = 'pane-' + uniqueKey;

    const newMapLayer = createCustomGeoJSONLayer(newGeoJson, newStyleState, paneName).addTo(map);

    activeLayers.unshift({
        uniqueKey: uniqueKey, id: `${layer.id}_copy`, displayName: `${layer.displayName} (Copy)`, mapLayer: newMapLayer,
        exportUrl: null, isLocalGeoJSON: true, geoJsonData: newGeoJson, customStyle: newStyleState, isVisible: true 
    });

    renderAddedLayers();
    updateMapLayerOrder();
    showToast("Layer duplicated successfully!");
};

const handleToggleTable = async (e) => {
  const key = e.currentTarget ? e.currentTarget.getAttribute('data-key') : e;
  const layer = activeLayers.find(l => l.uniqueKey === key);
  if (!layer) return;

  if (activeTableLayerKey === key && e.currentTarget) { closeAllPanels(); return; }

  closeAllPanels();
  activeTableLayerKey = key;
  renderAddedLayers(); 
  
  if (!attributeTableContainer) return;
  attributeTableContainer.classList.remove('hidden');
  attributeTableContainer.classList.add('flex');
  attributeTableContainer.innerHTML = '<div class="flex items-center justify-center h-full"><p class="text-xs text-gray-500 dark:text-gray-400 italic animate-pulse">Fetching attributes...</p></div>';

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
        <div class="flex justify-between items-center mb-1 shrink-0 border-b border-gray-200 dark:border-gray-700 pb-1">
            <div class="text-xs font-bold text-gray-700 dark:text-gray-200">${layer.displayName} Data</div>
            <button onclick="window.closeAllPanels()" class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 px-1"><i class="fa-solid fa-times"></i></button>
        </div>
        <p class="text-xs text-gray-500 dark:text-gray-400 italic p-2 text-center">No attributes available.</p>`;
      return;
    }

    // Collect all unique property keys across ALL features
    const headerSet = new Set();
    features.forEach(f => {
        if (f.properties) Object.keys(f.properties).forEach(k => headerSet.add(k));
    });
    const headers = Array.from(headerSet);

    let tableHtml = `
        <div class="flex justify-between items-center mb-1 shrink-0 border-b border-gray-200 dark:border-gray-700 pb-1">
            <div class="text-xs font-bold text-gray-700 dark:text-gray-200">${layer.displayName} Data</div>
            <button onclick="window.closeAllPanels()" class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 px-1"><i class="fa-solid fa-times"></i></button>
        </div>
        <div class="flex-1 overflow-auto min-h-0 custom-scroll border border-gray-200 dark:border-gray-700 rounded">
            <table class="min-w-full text-xs text-left border-collapse bg-white dark:bg-gray-800">
                <thead class="bg-gray-100 dark:bg-gray-700 sticky top-0 shadow-xs z-10"><tr>`;
    headers.forEach(h => { tableHtml += `<th class="px-2 py-1 border border-gray-200 dark:border-gray-600 font-semibold text-gray-700 dark:text-gray-200 whitespace-nowrap">${h}</th>`; });
    tableHtml += '</tr></thead><tbody>';

    features.slice(0, 100).forEach(f => {
      tableHtml += '<tr class="hover:bg-blue-50 dark:hover:bg-blue-900/30">';
      headers.forEach(h => {
         const val = f.properties ? f.properties[h] : '';
         const displayVal = (val !== null && val !== undefined) ? val : '';
         tableHtml += `<td class="px-2 py-0.5 border border-gray-200 dark:border-gray-700 text-gray-800 dark:text-gray-300 whitespace-nowrap max-w-[200px] truncate" title="${displayVal}">${displayVal}</td>`;
      });
      tableHtml += '</tr>';
    });

    tableHtml += '</tbody></table></div>';
    if (features.length >= 100 || (!layer.isLocalGeoJSON && features.length > 0)) {
       tableHtml += `<p class="text-[9px] text-gray-400 dark:text-gray-500 mt-1 italic text-center shrink-0">Showing up to 100 records for preview.</p>`;
    }
    attributeTableContainer.innerHTML = tableHtml;

  } catch (err) {
    attributeTableContainer.innerHTML = `
      <div class="flex justify-between items-center mb-1 shrink-0 border-b border-gray-200 dark:border-gray-700 pb-1">
          <div class="text-xs font-bold text-gray-700 dark:text-gray-200">${layer.displayName} Data</div>
          <button onclick="window.closeAllPanels()" class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 px-1"><i class="fa-solid fa-times"></i></button>
      </div>
      <p class="text-xs text-red-500 dark:text-red-400 italic p-2 text-center">Failed to load attribute data.</p>`;
  }
};

const handleToggleEdit = async (e) => {
    const key = e.currentTarget ? e.currentTarget.getAttribute('data-key') : e;
    const layer = activeLayers.find(l => l.uniqueKey === key);
    if (!layer) return;

    if (activeEditLayerKey === key && e.currentTarget) { closeAllPanels(); return; }

    closeAllPanels();
    activeEditLayerKey = key;
    renderAddedLayers();
    if (!editPanelContainer) return;
    
    openContextSubmenu();
    editPanelContainer.classList.remove('hidden'); 
    editPanelContainer.classList.add('flex');
    editPanelContainer.innerHTML = '<div class="flex justify-center p-3"><p class="text-xs italic animate-pulse text-gray-500 dark:text-gray-400">Preparing editable vector data...</p></div>';

    const success = await ensureGeoJSON(layer);
    if (!success) { closeAllPanels(); return; }

    const features = layer.geoJsonData.features || [];
    const colsSet = new Set();
    features.forEach(f => { if (f.properties) Object.keys(f.properties).forEach(k => colsSet.add(k)); });
    const cols = Array.from(colsSet).sort();

    const hasPoints = features.some(f => f.geometry && (f.geometry.type === 'Point' || f.geometry.type === 'MultiPoint'));
    const cs = layer.customStyle || { type: 'single', fillColor: '#2563eb', fillOpacity: 0.5, color: '#2563eb', opacity: 1.0, pointShape: 'circle', pointSize: 8 };
    const isCat = (cs.type === 'categorical');
    const pasteDisabled = copiedStyle ? '' : 'disabled';
    const pasteOpacity = copiedStyle ? '' : 'opacity-50 cursor-not-allowed';

    const useDataScale = cs.usePointScaleData || false;
    const currentScaleCurve = cs.pointScaleCurve || 'linear';

    editPanelContainer.innerHTML = `
        <div class="p-2 text-xs flex flex-col h-full min-h-0 bg-blue-50/50 dark:bg-transparent overflow-y-auto custom-scroll">
            <div class="flex justify-between items-center mb-2 pb-1 border-b border-blue-200 dark:border-blue-800 shrink-0">
                <h4 class="font-bold text-gray-700 dark:text-gray-200 uppercase text-[11px] tracking-wider">Edit Appearance</h4>
                <div class="flex space-x-1 items-center">
                    <button id="btn-copy-style" class="text-[10px] bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 px-1.5 py-0.5 rounded transition-colors font-medium" title="Copy Style"><i class="fa-solid fa-copy"></i></button>
                    <button id="btn-paste-style" class="text-[10px] bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 px-1.5 py-0.5 rounded transition-colors font-medium ${pasteOpacity}" title="Paste Style" ${pasteDisabled}><i class="fa-solid fa-paste"></i></button>
                    <button onclick="window.closeAllPanels()" class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 ml-1"><i class="fa-solid fa-times text-xs"></i></button>
                </div>
            </div>
            
            <div class="space-y-2 flex-1 min-h-0">
                ${hasPoints ? `
                <div id="point-style-container" class="flex flex-col space-y-2 bg-white dark:bg-gray-800 p-2 rounded border border-blue-100 dark:border-blue-800">
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
                                ${cols.map(c => `<option value="${c}" ${(useDataScale && cs.pointScaleProp === c) ? 'selected' : ''}>${c}</option>`).join('')}
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

                <div class="flex items-center space-x-1.5 bg-white dark:bg-gray-800 p-1.5 border border-blue-100 dark:border-blue-800 rounded">
                    <input type="checkbox" id="use-data-style" class="w-3.5 h-3.5 text-blue-600 dark:text-blue-500 rounded cursor-pointer accent-blue-600 dark:accent-blue-500" ${isCat ? 'checked' : ''}>
                    <label for="use-data-style" class="text-[11px] font-semibold text-gray-700 dark:text-gray-300 shrink-0">Use Data Colors</label>
                    <select id="style-col-select" class="flex-1 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white rounded px-1.5 py-0.5 text-xs" ${isCat ? '' : 'disabled'}>
                        <option value="" disabled ${!isCat ? 'selected' : ''}>Select attribute...</option>
                        ${cols.map(c => `<option value="${c}" ${(isCat && cs.property === c) ? 'selected' : ''}>${c}</option>`).join('')}
                    </select>
                </div>

                <div id="single-style-container" class="${isCat ? 'hidden' : 'flex'} flex-col space-y-2 bg-white dark:bg-gray-800 p-2 rounded border border-gray-200 dark:border-gray-700">
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

                <div id="categorical-style-list" class="${isCat ? 'flex' : 'hidden'} flex-col border border-gray-200 dark:border-gray-700 rounded p-1.5 bg-white dark:bg-gray-800">
                    <div id="cat-inner-list" class="max-h-36 overflow-y-auto custom-scroll">
                        <p class="text-xs text-gray-400 dark:text-gray-500 italic text-center py-1">Select an attribute column to generate colors.</p>
                    </div>
                </div>
            </div>

            <div class="flex justify-between pt-2 border-t border-blue-100 dark:border-blue-800 shrink-0 mt-1">
                <button id="btn-bake-colors" class="bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 text-[10px] px-2 py-1 rounded transition-colors font-medium border border-gray-300 dark:border-gray-600">
                    <i class="fa-solid fa-database mr-1"></i>Bake to Table
                </button>
                <div class="flex space-x-1.5">
                    <button id="btn-refresh-colors" class="${isCat ? '' : 'hidden'} bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 text-[10px] px-2 py-1 rounded transition-colors font-medium border border-gray-300 dark:border-gray-600">
                        <i class="fa-solid fa-arrows-rotate mr-1"></i> Refresh
                    </button>
                    <button id="btn-apply-edit" class="bg-blue-600 hover:bg-blue-700 text-white text-xs px-3 py-1 rounded transition-colors font-medium">Apply Style</button>
                </div>
            </div>
        </div>
    `;

    let activeScaleCurve = currentScaleCurve;

    // Dynamically extract active style settings directly from current UI DOM state
    const extractStyleFromUI = () => {
        const shapeEl = getEl('edit-point-shape');
        const sizeEl = getEl('edit-point-size');
        const pShape = shapeEl ? shapeEl.value : (layer.customStyle?.pointShape || 'circle');
        const pSize = sizeEl ? parseInt(sizeEl.value, 10) : (layer.customStyle?.pointSize || 8);

        const chkDataScale = getEl('use-data-scale');
        const isScaleData = chkDataScale ? chkDataScale.checked : false;
        const pScaleCol = isScaleData ? getEl('point-scale-col-select')?.value : null;
        const pMinData = isScaleData ? parseFloat(getEl('point-scale-min-data')?.value) : null;
        const pMaxData = isScaleData ? parseFloat(getEl('point-scale-max-data')?.value) : null;
        const pMinTarget = isScaleData ? parseFloat(getEl('point-scale-min-target')?.value) : 4;
        const pMaxTarget = isScaleData ? parseFloat(getEl('point-scale-max-target')?.value) : 24;

        const scaleStateObj = {
            usePointScaleData: isScaleData,
            pointScaleProp: pScaleCol,
            pointScaleMinData: isNaN(pMinData) ? 0 : pMinData,
            pointScaleMaxData: isNaN(pMaxData) ? 1 : pMaxData,
            pointScaleMinTarget: isNaN(pMinTarget) ? 4 : pMinTarget,
            pointScaleMaxTarget: isNaN(pMaxTarget) ? 24 : pMaxTarget,
            pointScaleCurve: activeScaleCurve || 'linear'
        };

        const chkUseData = getEl('use-data-style');
        const selCol = getEl('style-col-select');

        if (chkUseData?.checked) {
            const prop = selCol?.value;
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
            if (!pointScaleColSelect) return;
            const col = pointScaleColSelect.value;
            if (!col) return;
            const nums = layer.geoJsonData.features.map(f => parseFloat(f.properties ? f.properties[col] : NaN)).filter(n => !isNaN(n));
            if (nums.length > 0) {
                if (inputMinData) inputMinData.value = Math.min(...nums);
                if (inputMaxData) inputMaxData.value = Math.max(...nums);
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

    const chkUseData = getEl('use-data-style');
    const selCol = getEl('style-col-select');
    const singleContainer = getEl('single-style-container');
    const catListWrapper = getEl('categorical-style-list');
    const catInnerList = getEl('cat-inner-list');
    const btnRefreshColors = getEl('btn-refresh-colors');

    const renderCategoryPickers = () => {
        if (!selCol) return;
        const propName = selCol.value;
        if (!propName) return;
        let uniqueVals = [...new Set(layer.geoJsonData.features.map(f => f.properties ? f.properties[propName] : undefined))].filter(v => v !== null && v !== undefined);
        if (uniqueVals.length > 200 && !confirm(`Generate color pickers for ${uniqueVals.length} unique values?`)) return;
        if (!catInnerList) return;
        if (uniqueVals.length === 0) { catInnerList.innerHTML = '<p class="text-xs text-gray-400 italic text-center py-1">No unique values.</p>'; return; }

        let html = '';
        uniqueVals.forEach(val => {
            let fCol = '#' + Math.floor(Math.random()*16777215).toString(16).padStart(6, '0');
            let sCol = darkenHex(fCol, 0.3), fOp = 0.5, sOp = 1.0;
            if (isCat && cs.property === propName && cs.categories) {
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

    chkUseData?.addEventListener('change', (e) => {
        if (e.target.checked) {
            if (selCol) selCol.disabled = false; singleContainer?.classList.add('hidden'); singleContainer?.classList.remove('flex');
            catListWrapper?.classList.remove('hidden'); catListWrapper?.classList.add('flex'); btnRefreshColors?.classList.remove('hidden');
            if (selCol?.value) renderCategoryPickers();
        } else {
            if (selCol) selCol.disabled = true; singleContainer?.classList.remove('hidden'); singleContainer?.classList.add('flex');
            catListWrapper?.classList.add('hidden'); catListWrapper?.classList.remove('flex'); btnRefreshColors?.classList.add('hidden');
        }
    });

    selCol?.addEventListener('change', renderCategoryPickers);
    if (isCat && cs.property) renderCategoryPickers();

    btnRefreshColors?.addEventListener('click', () => {
        document.querySelectorAll('.cat-row').forEach(row => {
            const newFill = '#' + Math.floor(Math.random()*16777215).toString(16).padStart(6, '0');
            const fillIn = row.querySelector('.cat-fill');
            const strokeIn = row.querySelector('.cat-stroke');
            if (fillIn) fillIn.value = newFill;
            if (strokeIn) strokeIn.value = darkenHex(newFill, 0.3);
        });
    });

    getEl('btn-copy-style')?.addEventListener('click', () => {
        copiedStyle = extractStyleFromUI() || layer.customStyle;
        showToast("Style copied to clipboard!");
        const pasteBtn = getEl('btn-paste-style');
        if (pasteBtn) { pasteBtn.disabled = false; pasteBtn.classList.remove('opacity-50', 'cursor-not-allowed'); }
    });

    getEl('btn-paste-style')?.addEventListener('click', () => {
        if (!copiedStyle) return;
        layer.customStyle = JSON.parse(JSON.stringify(copiedStyle));
        map.removeLayer(layer.mapLayer);
        const paneName = 'pane-' + layer.uniqueKey;
        const newMapLayer = createCustomGeoJSONLayer(layer.geoJsonData, layer.customStyle, paneName);
        if (layer.isVisible) newMapLayer.addTo(map);
        layer.mapLayer = newMapLayer;
        updateMapLayerOrder();
        showToast("Style pasted and applied!");
        activeEditLayerKey = null; handleToggleEdit(key); 
    });

    getEl('btn-apply-edit')?.addEventListener('click', () => {
        const newStyle = extractStyleFromUI();
        if (!newStyle) return showToast("Select an attribute column for data styling.", true);
        
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

        // Re-render map layer with updated style
        map.removeLayer(layer.mapLayer);
        const paneName = 'pane-' + layer.uniqueKey;
        const newMapLayer = createCustomGeoJSONLayer(layer.geoJsonData, layer.customStyle, paneName);
        if (layer.isVisible) newMapLayer.addTo(map);
        layer.mapLayer = newMapLayer;
        updateMapLayerOrder();

        // Refresh Attribute Table drawer if open for this layer
        if (activeTableLayerKey === layer.uniqueKey) {
            handleToggleTable(layer.uniqueKey);
        }

        showToast(`Baked RGBA hex values to ${count} features!`);
    });
};

const handleToggleSplit = async (e) => {
    const key = e.currentTarget ? e.currentTarget.getAttribute('data-key') : e;
    const layer = activeLayers.find(l => l.uniqueKey === key);
    if (!layer) return;

    if (activeSplitLayerKey === key && e.currentTarget) { closeAllPanels(); return; }

    closeAllPanels();
    activeSplitLayerKey = key;
    renderAddedLayers();
    if (!splitPanelContainer) return;
    
    openContextSubmenu();
    splitPanelContainer.classList.remove('hidden');
    splitPanelContainer.classList.add('flex');
    splitPanelContainer.innerHTML = '<div class="flex justify-center p-3"><p class="text-xs italic animate-pulse text-gray-500 dark:text-gray-400">Preparing vector data for split...</p></div>';

    const success = await ensureGeoJSON(layer);
    if (!success) { closeAllPanels(); return; }

    const features = layer.geoJsonData.features || [];
    const colsSet = new Set();
    features.forEach(f => { if (f.properties) Object.keys(f.properties).forEach(k => colsSet.add(k)); });
    const cols = Array.from(colsSet).sort();

    splitPanelContainer.innerHTML = `
        <div class="p-2 text-xs flex flex-col h-full min-h-0 bg-blue-50/50 dark:bg-transparent">
            <div class="flex justify-between items-center mb-2 pb-1 border-b border-blue-200 dark:border-blue-800 shrink-0">
                <h4 class="font-bold text-gray-700 dark:text-gray-200 uppercase text-[11px] tracking-wider">Split Layer</h4>
                <button onclick="window.closeAllPanels()" class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"><i class="fa-solid fa-times text-xs"></i></button>
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

        let createdCount = 0;
        const newLayers = [];

        uniqueVals.forEach(val => {
            const filteredFeats = layer.geoJsonData.features.filter(f => f.properties && f.properties[splitCol] === val);
            if (filteredFeats.length === 0) return;

            const newGeoJson = { type: "FeatureCollection", features: filteredFeats };
            const splitStyleState = layer.customStyle ? JSON.parse(JSON.stringify(layer.customStyle)) : { type: 'single', fillColor: '#2563eb', fillOpacity: 0.5, color: '#2563eb', opacity: 1.0, pointShape: 'circle', pointSize: 8 };

            const uniqueKey = Math.random().toString(36).substr(2,9);
            const paneName = 'pane-' + uniqueKey;

            const newMapLayer = createCustomGeoJSONLayer(newGeoJson, splitStyleState, paneName).addTo(map);

            newLayers.push({
                uniqueKey: uniqueKey, id: `${layer.id}_${val}`, displayName: `${layer.displayName} [${val}]`,
                mapLayer: newMapLayer, exportUrl: null, isLocalGeoJSON: true, geoJsonData: newGeoJson,
                customStyle: splitStyleState, isVisible: true 
            });
            createdCount++;
        });
        
        activeLayers = [...newLayers, ...activeLayers];
        layer.isVisible = false;
        map.removeLayer(layer.mapLayer);
        
        closeAllPanels();
        renderAddedLayers();
        updateMapLayerOrder();
        showToast(`Split into ${createdCount} new layers!`);
    });
};

const triggerDataFilterSetup = async (layer) => {
    const drawStatusEl = getEl('draw-status');
    if (drawStatusEl) { 
        drawStatusEl.classList.remove('hidden'); 
        drawStatusEl.textContent = 'Ensuring local data for filtering...'; 
    }

    const searchInput = getEl('filter-data-search');
    if (searchInput) searchInput.value = '';
    getEl('btn-clear-filter-search')?.classList.add('hidden');

    const success = await ensureGeoJSON(layer);
    if (!success) { 
        if (drawStatusEl) drawStatusEl.textContent = 'Failed to load vector data.'; 
        return; 
    }
    
    if (drawStatusEl) drawStatusEl.textContent = 'Select an attribute column.';

    // Collect all unique property keys across ALL features
    const cols = new Set();
    (layer.geoJsonData?.features || []).forEach(f => {
        if (f.properties) Object.keys(f.properties).forEach(k => cols.add(k));
    });
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

const handleToggleCrop = (e) => {
    const key = e.currentTarget ? e.currentTarget.getAttribute('data-key') : e;
    const layer = activeLayers.find(l => l.uniqueKey === key);
    if (!layer) return;

    if (activeCropLayerKey === key && e.currentTarget) { closeAllPanels(); return; }

    closeAllPanels();
    activeCropLayerKey = key;
    if (cropPanelContainer) {
        openContextSubmenu();
        cropPanelContainer.classList.remove('hidden');
        cropPanelContainer.classList.add('flex');
    }
    renderAddedLayers();
    
    if (filterType?.value === 'data') triggerDataFilterSetup(layer);
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
     if (filterGeometryData && activeCropLayerKey) {
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
  if (visibleCount === 0 && fetchedLayers.length > 0) {
    if (!emptyMsg && availableLayerList) {
      emptyMsg = document.createElement('p'); emptyMsg.id = 'search-empty-msg'; emptyMsg.className = 'text-xs text-gray-400 italic text-center mt-3'; emptyMsg.textContent = 'No matching layers found.';
      availableLayerList.appendChild(emptyMsg);
    }
    emptyMsg?.classList.remove('hidden');
  } else if (emptyMsg) { emptyMsg.classList.add('hidden'); }
};

const triggerAddedSearch = () => {
  if (!addedLayerSearch) return;
  const term = addedLayerSearch.value.toLowerCase();
  if (term === '') btnClearAddedSearch?.classList.add('hidden');
  else btnClearAddedSearch?.classList.remove('hidden');
  
  let visibleCount = 0;
  document.querySelectorAll('.added-layer-item').forEach(item => {
    if (item.getAttribute('data-search').includes(term)) { item.classList.remove('hidden'); visibleCount++; } 
    else { item.classList.add('hidden'); }
  });
  
  let emptyMsg = getEl('added-search-empty-msg');
  if (visibleCount === 0 && activeLayers.length > 0) {
    if (!emptyMsg && addedLayerList) {
      emptyMsg = document.createElement('p'); emptyMsg.id = 'added-search-empty-msg'; emptyMsg.className = 'text-xs text-gray-400 italic text-center mt-3'; emptyMsg.textContent = 'No matching layers found.';
      addedLayerList.appendChild(emptyMsg);
    }
    emptyMsg?.classList.remove('hidden');
  } else if (emptyMsg) { emptyMsg.classList.add('hidden'); }
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


// ==========================================
// 7. MAIN UI RENDERERS
// ==========================================
const renderAvailableLayers = () => {
  if (!availableLayerList) return;
  availableLayerList.innerHTML = '';
  if (fetchedLayers.length === 0) {
    availableLayerList.innerHTML = `<p class="text-xs text-gray-400 dark:text-gray-500 italic text-center mt-3">No layers fetched yet.</p>`;
    searchContainer?.classList.add('hidden');
    if (btnAddBulk) btnAddBulk.disabled = true;
    return;
  }
  
  searchContainer?.classList.remove('hidden');
  if (btnAddBulk) btnAddBulk.disabled = false;

  fetchedLayers.forEach((layer) => {
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

const renderAddedLayers = () => {
  if (tabBtnAdded) tabBtnAdded.textContent = `Added (${activeLayers.length})`;
  if (!addedLayerList) return;
  addedLayerList.innerHTML = '';

  if (activeLayers.length === 0) {
    addedLayerList.innerHTML = `<p class="text-xs text-gray-400 dark:text-gray-500 italic text-center mt-3">No layers currently added to map.</p>`;
    addedSearchContainer?.classList.add('hidden');
    return;
  }

  addedSearchContainer?.classList.remove('hidden');

  activeLayers.forEach(layer => {
    const isTableActive = (activeTableLayerKey === layer.uniqueKey);
    const isEditActive = (activeEditLayerKey === layer.uniqueKey);
    const isSplitActive = (activeSplitLayerKey === layer.uniqueKey);
    const isCropActive = (activeCropLayerKey === layer.uniqueKey);
    
    let bgClass = 'bg-white border-gray-100 hover:bg-gray-50 shadow-xs dark:bg-gray-800 dark:border-gray-700 dark:hover:bg-gray-700';
    if (isTableActive || isEditActive || isSplitActive || isCropActive) {
        bgClass = 'bg-blue-50 border-blue-300 shadow-sm dark:bg-blue-900/30 dark:border-blue-600';
    }

    const div = document.createElement('div');
    div.className = `added-layer-item flex flex-col p-1.5 mb-1 rounded border transition-colors ${bgClass}`;
    div.setAttribute('data-search', `${layer.displayName} ${layer.id}`.toLowerCase());
    
    div.innerHTML = `
      <div class="flex items-center justify-between">
        <div class="mr-2 shrink-0">
           <input type="checkbox" class="w-3.5 h-3.5 text-blue-600 dark:text-blue-500 rounded cursor-pointer btn-toggle-vis accent-blue-600 dark:accent-blue-500" data-key="${layer.uniqueKey}" ${layer.isVisible ? 'checked' : ''} title="Toggle Visibility">
        </div>
        <div class="flex-1 overflow-hidden pr-1">
          <span class="text-xs font-semibold text-gray-800 dark:text-gray-200 truncate block" title="${layer.displayName}">${layer.displayName}</span>
          <span class="text-[9px] text-gray-400 dark:text-gray-500 block truncate" title="${layer.id}">ID: ${layer.id}</span>
        </div>
      </div>
      
      <div class="mt-1.5 flex justify-between border-t border-gray-200 dark:border-gray-700 pt-1.5 text-gray-500 dark:text-gray-400 text-xs">
        <div class="flex space-x-1">
           <button class="hover:text-blue-600 dark:hover:text-blue-400 transition-colors btn-reorder" data-key="${layer.uniqueKey}" data-action="top" title="Bring to Front"><i class="fa-solid fa-angles-up"></i></button>
           <button class="hover:text-blue-600 dark:hover:text-blue-400 transition-colors btn-reorder" data-key="${layer.uniqueKey}" data-action="up" title="Move Up"><i class="fa-solid fa-angle-up"></i></button>
           <button class="hover:text-blue-600 dark:hover:text-blue-400 transition-colors btn-reorder" data-key="${layer.uniqueKey}" data-action="down" title="Move Down"><i class="fa-solid fa-angle-down"></i></button>
           <button class="hover:text-blue-600 dark:hover:text-blue-400 transition-colors btn-reorder" data-key="${layer.uniqueKey}" data-action="bottom" title="Send to Back"><i class="fa-solid fa-angles-down"></i></button>
        </div>
        <div class="flex space-x-2 justify-end">
            <button class="transition-colors btn-table ${isTableActive ? 'text-blue-600 dark:text-blue-400' : 'hover:text-blue-600 dark:hover:text-blue-400'}" data-key="${layer.uniqueKey}" title="Data Table"><i class="fa-solid fa-table"></i></button>
            <button class="transition-colors btn-edit ${isEditActive ? 'text-blue-600 dark:text-blue-400' : 'hover:text-blue-600 dark:hover:text-blue-400'}" data-key="${layer.uniqueKey}" title="Edit Appearance"><i class="fa-solid fa-palette"></i></button>
            <button class="transition-colors btn-crop ${isCropActive ? 'text-blue-600 dark:text-blue-400' : 'hover:text-blue-600 dark:hover:text-blue-400'}" data-key="${layer.uniqueKey}" title="Filter / Crop Layer"><i class="fa-solid fa-crop"></i></button>
            <button class="transition-colors btn-split ${isSplitActive ? 'text-blue-600 dark:text-blue-400' : 'hover:text-blue-600 dark:hover:text-blue-400'}" data-key="${layer.uniqueKey}" title="Split Layer"><i class="fa-solid fa-object-ungroup"></i></button>
            <button class="hover:text-blue-600 dark:hover:text-blue-400 transition-colors btn-duplicate" data-key="${layer.uniqueKey}" title="Duplicate Layer"><i class="fa-solid fa-clone"></i></button>
            <button class="hover:text-blue-600 dark:hover:text-blue-400 transition-colors btn-rename" data-key="${layer.uniqueKey}" title="Rename Layer"><i class="fa-solid fa-pen"></i></button>
            <button class="hover:text-blue-600 dark:hover:text-blue-400 transition-colors btn-export" data-key="${layer.uniqueKey}" title="Export Layer"><i class="fa-solid fa-download"></i></button>
            <button class="hover:text-red-500 dark:hover:text-red-400 transition-colors btn-remove" data-key="${layer.uniqueKey}" title="Remove Layer"><i class="fa-solid fa-trash"></i></button>
        </div>
      </div>
    `;
    addedLayerList.appendChild(div);
  });

  document.querySelectorAll('.btn-table').forEach(btn => btn.addEventListener('click', handleToggleTable));
  document.querySelectorAll('.btn-edit').forEach(btn => btn.addEventListener('click', handleToggleEdit));
  document.querySelectorAll('.btn-split').forEach(btn => btn.addEventListener('click', handleToggleSplit));
  document.querySelectorAll('.btn-crop').forEach(btn => btn.addEventListener('click', handleToggleCrop));
  document.querySelectorAll('.btn-duplicate').forEach(btn => btn.addEventListener('click', handleDuplicate));
  document.querySelectorAll('.btn-rename').forEach(btn => btn.addEventListener('click', handleRename));
  document.querySelectorAll('.btn-export').forEach(btn => btn.addEventListener('click', handleExport));
  document.querySelectorAll('.btn-remove').forEach(btn => btn.addEventListener('click', handleRemove));
  document.querySelectorAll('.btn-toggle-vis').forEach(btn => btn.addEventListener('change', handleToggleVisibility));
  document.querySelectorAll('.btn-reorder').forEach(btn => btn.addEventListener('click', handleReorder));
};

const addLayerToMap = (layerId, switchTabAfter = true) => {
    const meta = fetchedLayers.find(l => l.id === layerId);
    if (!meta) return;

    let mapLayer, exportUrl = null, isLocalGeoJSON = false, geoJsonData = null, customStyle = null;

    if (previewLayers[layerId]) {
        map.removeLayer(previewLayers[layerId]);
        delete previewLayers[layerId];
    }
    
    const uniqueKey = Math.random().toString(36).substr(2,9);
    const paneName = 'pane-' + uniqueKey;

    if (meta.geoJsonData) {
        isLocalGeoJSON = true;
        geoJsonData = meta.geoJsonData;
        customStyle = { type: 'single', fillColor: '#10b981', fillOpacity: 0.5, color: '#059669', opacity: 1.0, pointShape: 'circle', pointSize: 8 };
        mapLayer = createCustomGeoJSONLayer(geoJsonData, customStyle, paneName);
    } else {
        map.createPane(paneName);
        const baseUrl = currentServerUrl.split('?')[0];
        if (currentServerType === 'WFS') {
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
    
    activeLayers.unshift({ 
      uniqueKey: uniqueKey, id: meta.id, displayName: meta.title, mapLayer, exportUrl, 
      isLocalGeoJSON, geoJsonData, customStyle, isVisible: true 
    });
    
    updateMapLayerOrder();
    if (switchTabAfter) { renderAddedLayers(); switchTab('added'); showToast(`Added ${meta.title} to map!`); }
};


// ==========================================
// 8. EVENT LISTENERS
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
            
            if (rawType.includes('ARCGIS') || rawType.includes('ESRI') || rawType.includes('REST')) {
                sType.value = 'ARCGIS';
            } else if (rawType.includes('WFS') || rawType.includes('OGC')) {
                sType.value = 'WFS';
            } else if (rawType.includes('OVERPASS') || rawType.includes('OSM')) {
                sType.value = 'OVERPASS';
            } else {
                sType.value = rawType;
            }
            
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
    if (activeLayers.length === 0) return showToast("No active layers to export in workspace.", true);
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
            restoreWorkspaceState(data);
            switchTab('added');
            showToast("Workspace restored successfully!");
        } catch (err) { showToast("Failed to parse workspace JSON file.", true); } 
        finally { e.target.value = ''; }
    };
    reader.readAsText(file);
});

getEl('btn-clear-workspace')?.addEventListener('click', () => {
    if (activeLayers.length === 0) return;
    if (confirm("Reset workspace? All added layers will be removed from the map.")) {
        closeAllPanels(); clearAllPreviews();
        activeLayers.forEach(l => { map.removeLayer(l.mapLayer); removePane(l.uniqueKey); });
        activeLayers = []; localStorage.removeItem('gis_previewer_auto_save');
        renderAddedLayers(); showToast("Workspace reset.");
    }
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
    if (!lastFetchedOsmGeoJson) return;
    
    const uniqueVals = [...new Set(lastFetchedOsmGeoJson.features.map(f => f.properties ? f.properties[splitCol] : undefined))];
    if (uniqueVals.length > 50 && !confirm(`This will unpack ${uniqueVals.length} layers into the list below. Proceed?`)) return;
    
    clearAllPreviews(); 
    fetchedLayers = []; 
    
    uniqueVals.forEach(val => {
        const filteredFeats = lastFetchedOsmGeoJson.features.filter(f => f.properties && f.properties[splitCol] === val);
        if (filteredFeats.length === 0) return;
        
        const displayVal = (val === null || val === undefined || val === '') ? 'null' : val;
        let extraName = '';
        if (filteredFeats.length === 1 && filteredFeats[0].properties.name && splitCol !== 'name') {
            extraName = ` - ${filteredFeats[0].properties.name}`;
        }
        
        fetchedLayers.push({
            id: `osm_${Date.now()}_${Math.random().toString(36).substr(2,5)}`,
            title: `${lastFetchedOsmLayerName} [${splitCol}: ${displayVal}]${extraName}`,
            geoJsonData: { type: "FeatureCollection", features: filteredFeats }
        });
    });
    renderAvailableLayers();
    showToast(`Successfully unpacked into ${fetchedLayers.length} sub-layers!`);
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
    
    drawingMode = 'inspect';
    drawLayerGroup.clearLayers();
    map.getContainer().style.cursor = 'crosshair';
    showToast("Click and drag a box on the map to inspect tags.");
});

btnCloseInspect?.addEventListener('click', () => {
    getEl('osm-inspect-container')?.classList.add('hidden');
    getEl('osm-inspect-container')?.classList.remove('flex');
    if (drawingMode === 'inspect') {
        drawingMode = null;
        map.getContainer().style.cursor = '';
        drawLayerGroup.clearLayers();
    }
});

btnDraw?.addEventListener('click', () => {
  if (!filterType) return;
  drawingMode = filterType.value; drawLayerGroup.clearLayers(); filterGeometryData = null;
  if (btnApplyFilter) btnApplyFilter.disabled = true; map.getContainer().style.cursor = 'crosshair'; drawStatus?.classList.remove('hidden');
});

map.on('mousedown', (e) => {
  if (drawingMode === 'box' || drawingMode === 'inspect') { 
      drawLayerGroup.clearLayers(); map.dragging.disable(); drawStart = e.latlng; 
      const color = drawingMode === 'inspect' ? '#2563eb' : '#0d9488'; 
      tempShape = L.rectangle([drawStart, drawStart], { color: color, weight: 2, fillOpacity: 0.2 }).addTo(drawLayerGroup); 
  }
});

map.on('mousemove', (e) => { 
    if ((drawingMode === 'box' || drawingMode === 'inspect') && tempShape) tempShape.setBounds([drawStart, e.latlng]); 
});

map.on('mouseup', (e) => {
  if (drawingMode === 'box' && tempShape) { 
      map.dragging.enable(); filterGeometryData = tempShape.getBounds(); drawingMode = null; map.getContainer().style.cursor = ''; checkApplyButton(); 
  } else if (drawingMode === 'inspect' && tempShape) {
      map.dragging.enable(); 
      const bounds = tempShape.getBounds();
      drawingMode = null; map.getContainer().style.cursor = '';
      executeOsmInspect(bounds);
      setTimeout(() => drawLayerGroup.clearLayers(), 800); 
  }
});

map.on('click', (e) => {
  if (drawingMode === 'radius') {
    drawLayerGroup.clearLayers(); drawStart = e.latlng;
    const radKm = parseFloat(filterRadius?.value) || 5;
    tempShape = L.circle(drawStart, { radius: radKm * 1000, color: '#0d9488', weight: 2, fillOpacity: 0.2 }).addTo(drawLayerGroup);
    L.marker(drawStart).addTo(drawLayerGroup); filterGeometryData = drawStart; drawingMode = null; map.getContainer().style.cursor = ''; checkApplyButton();
  }
});

filterRadius?.addEventListener('input', checkApplyButton);

filterType?.addEventListener('change', (e) => {
  const type = e.target.value;
  const layer = activeLayers.find(l => l.uniqueKey === activeCropLayerKey);
  
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
    const layer = activeLayers.find(l => l.uniqueKey === activeCropLayerKey);
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
  const targetLayer = activeLayers.find(l => l.uniqueKey === activeCropLayerKey);
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
               b = filterGeometryData;
               const turfBbox = turf.bboxPolygon([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
               // Enforce strictly 'Within' instead of 'Intersects'
               finalFeatures = targetLayer.geoJsonData.features.filter(f => { try { return turf.booleanWithin(f, turfBbox); } catch(e) { return false; } });
            } else {
               const radKm = parseFloat(filterRadius?.value) || 5;
               const turfCircle = turf.circle([filterGeometryData.lng, filterGeometryData.lat], radKm, {units: 'kilometers'});
               finalFeatures = targetLayer.geoJsonData.features.filter(f => { try { return turf.booleanWithin(f, turfCircle); } catch(e) { return false; } });
            }
        } else {
            let queryUrl = targetLayer.exportUrl;
            let b; 
            if (filterType?.value === 'box') b = filterGeometryData; 
            else b = filterGeometryData.toBounds((parseFloat(filterRadius?.value) || 5) * 1000); 

            // Ask the server for the bounding box envelope first (adding esriSpatialRelWithin for servers that support it)
            if (queryUrl.includes('WFS') || queryUrl.includes('GetFeature')) queryUrl += `&bbox=${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()},EPSG:4326`;
            else queryUrl += `&geometry=${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}&geometryType=esriGeometryEnvelope&spatialRel=esriSpatialRelWithin&inSR=4326`;

            const res = await fetch(`/proxy?url=${encodeURIComponent(queryUrl)}`);
            const rawGeojson = await res.json();
            let fetchedFeatures = rawGeojson.features || [];

            // Strict client-side post-filtering to guarantee shapes are 'Within' (since standard WFS defaults to Intersect)
            if (filterType?.value === 'box') {
                const turfBbox = turf.bboxPolygon([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
                finalFeatures = fetchedFeatures.filter(f => { try { return turf.booleanWithin(f, turfBbox); } catch(e) { return false; } });
            } else if (filterType?.value === 'radius') {
                const radKm = parseFloat(filterRadius?.value) || 5;
                const turfCircle = turf.circle([filterGeometryData.lng, filterGeometryData.lat], radKm, {units: 'kilometers'});
                finalFeatures = fetchedFeatures.filter(f => { try { return turf.booleanWithin(f, turfCircle); } catch(e) { return false; } });
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
    activeLayers.unshift({ uniqueKey: uniqueKey, id: `${targetLayer.id}_filtered`, displayName: `${namePrefix} ${targetLayer.displayName}`, mapLayer: newMapLayer, exportUrl: null, isLocalGeoJSON: true, geoJsonData: newGeoJsonData, customStyle: newStyleState, isVisible: true });

    if (targetLayer.isVisible) { targetLayer.isVisible = false; map.removeLayer(targetLayer.mapLayer); }

    closeAllPanels(); renderAddedLayers(); updateMapLayerOrder();
    showToast(`Created new filtered layer with ${finalFeatures.length} features.`);

  } catch(err) {
    showToast("Filter failed. Server might restrict spatial queries.", true);
  } finally {
    if (filterText) filterText.textContent = 'Apply Filter'; 
    filterSpinner?.classList.add('hidden'); 
    btnApplyFilter.disabled = false;
  }
});

// Shared Handler for Fetch Triggering (Works for both OSM and URL buttons)
const handleFetchLayers = async () => {
  const sType = getEl('server-type');
  if (!sType) return;
  currentServerType = sType.value;
  clearAllPreviews(); 
  
  const fetchSpinner = getEl('btn-fetch-spinner') || getEl('btn-fetch-spinner-url');
  const fetchText = getEl('btn-fetch-text') || getEl('btn-fetch-text-url');
  fetchSpinner?.classList.remove('hidden'); 
  if (fetchText) fetchText.textContent = 'Fetching...';

  try {
    if (currentServerType === 'OVERPASS') {
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

        fetchedLayers = [{ id: `osm_${Date.now()}`, title: layerName, geoJsonData: geoJson }];
        lastFetchedOsmGeoJson = geoJson; lastFetchedOsmLayerName = layerName;
        
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
    currentServerUrl = rawUrl; fetchedLayers = []; 
    if (layerSearch) layerSearch.value = ''; 
    btnClearSearch?.classList.add('hidden');
    
    const toolsContainer = getEl('osm-available-tools');
    if (toolsContainer) { toolsContainer.classList.add('hidden'); toolsContainer.classList.remove('flex'); }

    let targetUrl = new URL(rawUrl);
    if (currentServerType === 'WFS') { targetUrl.searchParams.set('service', 'WFS'); targetUrl.searchParams.set('request', 'GetCapabilities'); } 
    else { targetUrl.searchParams.set('f', 'json'); }

    const proxyRes = await fetch(`/proxy?url=${encodeURIComponent(targetUrl.toString())}`);
    if (!proxyRes.ok) throw new Error("Proxy error");

    if (currentServerType === 'WFS') {
      const xml = new DOMParser().parseFromString(await proxyRes.text(), 'text/xml');
      Array.from(xml.getElementsByTagNameNS('*', 'FeatureType')).forEach(node => {
        let name='', title='';
        Array.from(node.children).forEach(c => { if(c.localName==='Name') name=c.textContent; if(c.localName==='Title') title=c.textContent; });
        if(name) fetchedLayers.push({ id: name, title: title || name });
      });
    } else {
      const json = await proxyRes.json();
      if(json.layers) fetchedLayers = json.layers.map(l => ({ id: l.id.toString(), title: l.name }));
      else fetchedLayers.push({ id: targetUrl.pathname.split('/').pop(), title: json.name || "Layer" });
    }
    renderAvailableLayers(); switchTab('available');

  } catch(e) {
    showToast(e.message || "Fetch failed. Check console.", true);
    if (currentServerType !== 'OVERPASS' && availableLayerList) {
        availableLayerList.innerHTML = `<p class="text-xs text-red-500 italic text-center mt-3">Failed to fetch. Check server URL.</p>`; searchContainer?.classList.add('hidden');
    }
  } finally {
    fetchSpinner?.classList.add('hidden'); 
    if (fetchText) fetchText.textContent = currentServerType === 'OVERPASS' ? 'Fetch OSM Data' : 'Fetch Layers';
  }
};

document.querySelectorAll('.btn-trigger-fetch').forEach(btn => btn.addEventListener('click', handleFetchLayers));


// ==========================================
// 9. APP BOOTSTRAP
// ==========================================
const initOsmDatalists = () => {
    const keysList = getEl('osm-keys');
    const valuesList = getEl('osm-values');
    const keyInput = getEl('osm-key');

    if (keysList) {
        keysList.innerHTML = Object.keys(commonOsmTags).map(k => `<option value="${k}">`).join('');
    }

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

try {
    const savedSession = localStorage.getItem('gis_previewer_auto_save');
    if (savedSession) {
        const data = JSON.parse(savedSession);
        restoreWorkspaceState(data);
    }
} catch(e) {
    console.warn("Could not auto-restore previous workspace.", e);
}


// ==========================================
// 10. SIDEBAR HORIZONTAL RESIZER
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
            map.invalidateSize();
        };

        const stopDrag = () => {
            if (isResizing) {
                isResizing = false;
                document.body.classList.remove('select-none', 'cursor-col-resize');
                window.removeEventListener('mousemove', doDrag);
                window.removeEventListener('mouseup', stopDrag);
                map.invalidateSize();
            }
        };

        window.addEventListener('mousemove', doDrag);
        window.addEventListener('mouseup', stopDrag);
    });
};

initSidebarResizer();


// ==========================================
// 11. SUBMENU VERTICAL RESIZER
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
            const newHeight = Math.max(120, Math.min(600, startHeight + dy));
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