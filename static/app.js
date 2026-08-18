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

// DOM Elements
const tabBtnAvailable = document.getElementById('tab-btn-available');
const tabBtnAdded = document.getElementById('tab-btn-added');
const tabAvailable = document.getElementById('tab-available');
const tabAdded = document.getElementById('tab-added');
const btnAddBulk = document.getElementById('btn-add');

const savedServersSelect = document.getElementById('saved-servers-select');
const btnSaveServer = document.getElementById('btn-save-server');

const searchContainer = document.getElementById('search-container');
const layerSearch = document.getElementById('layer-search');
const btnClearSearch = document.getElementById('btn-clear-search');
const availableLayerList = document.getElementById('available-layer-list');

const addedSearchContainer = document.getElementById('added-search-container');
const addedLayerSearch = document.getElementById('added-layer-search');
const btnClearAddedSearch = document.getElementById('btn-clear-added-search');
const addedLayerList = document.getElementById('added-layer-list');

const attributeTableContainer = document.getElementById('attribute-table-container');
const editPanelContainer = document.getElementById('edit-panel-container');
const splitPanelContainer = document.getElementById('split-panel-container');
const cropPanelContainer = document.getElementById('crop-panel-container');

const filterType = document.getElementById('filter-type');
const filterRadius = document.getElementById('filter-radius');
const btnDraw = document.getElementById('btn-draw');
const btnApplyFilter = document.getElementById('btn-apply-filter');
const drawStatus = document.getElementById('draw-status');
const filterDataContainer = document.getElementById('filter-data-container');
const filterDataCol = document.getElementById('filter-data-col');
const filterDataValues = document.getElementById('filter-data-values');
const filterDataSearch = document.getElementById('filter-data-search');
const btnClearFilterSearch = document.getElementById('btn-clear-filter-search');

const osmKeyInput = document.getElementById('osm-key');
const osmValueDatalist = document.getElementById('osm-values');
const btnOsmInspect = document.getElementById('btn-osm-inspect');
const osmInspectContainer = document.getElementById('osm-inspect-container');
const osmInspectResults = document.getElementById('osm-inspect-results');
const btnCloseInspect = document.getElementById('btn-close-inspect');
const osmInspectStatus = document.getElementById('osm-inspect-status');

const toast = document.getElementById('toast');


// ==========================================
// 2. CORE UTILITIES
// ==========================================
const showToast = (msg, isError=false) => {
  toast.className = `fixed bottom-6 right-6 px-4 py-3 rounded shadow-xl transform transition-all duration-300 z-50 max-w-sm ${isError ? 'bg-red-600 text-white' : 'bg-gray-800 dark:bg-gray-700 text-white'}`;
  document.getElementById('toast-message').textContent = msg;
  toast.classList.remove('translate-y-20', 'opacity-0');
  setTimeout(() => toast.classList.add('translate-y-20', 'opacity-0'), 5000);
};

const darkenHex = (hex, percent = 0.3) => {
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    let r = parseInt(hex.substring(0, 2), 16);
    let g = parseInt(hex.substring(2, 4), 16);
    let b = parseInt(hex.substring(4, 6), 16);
    r = Math.max(0, Math.floor(r * (1 - percent)));
    g = Math.max(0, Math.floor(g * (1 - percent)));
    b = Math.max(0, Math.floor(b * (1 - percent)));
    return '#' + r.toString(16).padStart(2, '0') + g.toString(16).padStart(2, '0') + b.toString(16).padStart(2, '0');
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

const closeAllPanels = () => {
    activeTableLayerKey = null;
    activeEditLayerKey = null;
    activeSplitLayerKey = null;
    activeCropLayerKey = null;
    
    attributeTableContainer.classList.add('hidden'); attributeTableContainer.classList.remove('flex');
    editPanelContainer.classList.add('hidden'); editPanelContainer.classList.remove('flex');
    splitPanelContainer.classList.add('hidden'); splitPanelContainer.classList.remove('flex');
    cropPanelContainer.classList.add('hidden'); cropPanelContainer.classList.remove('flex');
    
    filterType.value = 'box';
    filterRadius.classList.add('hidden');
    filterDataContainer.classList.add('hidden');
    btnDraw.classList.remove('hidden');

    drawLayerGroup.clearLayers();
    filterGeometryData = null;
    drawingMode = null;
    btnApplyFilter.disabled = true;
    drawStatus.classList.add('hidden');
    map.getContainer().style.cursor = '';
    
    if(activeLayers.length > 0) renderAddedLayers();
};
window.closeAllPanels = closeAllPanels;

const switchTab = (tabName) => {
  const isAvailable = (tabName === 'available');
  tabBtnAvailable.className = `flex-1 py-2 text-xs font-semibold uppercase tracking-wider transition-colors border-b-2 ${isAvailable ? 'text-blue-600 dark:text-blue-400 border-blue-600 dark:border-blue-400' : 'text-gray-500 dark:text-gray-400 border-transparent hover:text-gray-700 dark:hover:text-gray-200'}`;
  tabBtnAdded.className = `flex-1 py-2 text-xs font-semibold uppercase tracking-wider transition-colors border-b-2 ${!isAvailable ? 'text-blue-600 dark:text-blue-400 border-blue-600 dark:border-blue-400' : 'text-gray-500 dark:text-gray-400 border-transparent hover:text-gray-700 dark:hover:text-gray-200'}`;
  
  if (isAvailable) {
    tabAvailable.classList.replace('hidden', 'flex');
    tabAdded.classList.replace('flex', 'hidden');
    btnAddBulk.classList.remove('hidden');
  } else {
    tabAdded.classList.replace('hidden', 'flex');
    tabAvailable.classList.replace('flex', 'hidden');
    btnAddBulk.classList.add('hidden');
  }
};


// ==========================================
// 3. CANVAS STYLING & RENDERING
// ==========================================
const createGeoJsonStyleFunction = (styleState) => {
    return function(feature) {
        if (styleState && styleState.type === 'categorical') {
            const val = feature.properties[styleState.property];
            const cat = styleState.categories[val];
            return {
                fillColor: cat ? cat.fillColor : styleState.defaultFill,
                fillOpacity: cat ? cat.fillOpacity : styleState.defaultFillOpacity,
                color: cat ? cat.color : styleState.defaultColor,
                opacity: cat ? cat.opacity : styleState.defaultOpacity,
                weight: 2
            };
        } else {
            return {
                fillColor: styleState ? styleState.fillColor : '#4f46e5',
                fillOpacity: styleState ? styleState.fillOpacity : 0.5,
                color: styleState ? styleState.color : '#4f46e5',
                opacity: styleState ? styleState.opacity : 1.0,
                weight: 2
            };
        }
    };
};

const createGeoJsonPointToLayer = (styleState, paneName, customRenderer) => {
    return function(feature, latlng) {
        let fColor = '#4f46e5', sColor = '#4f46e5', fOp = 0.5, sOp = 1.0;
        if (styleState && styleState.type === 'categorical') {
            const val = feature.properties[styleState.property];
            const cat = styleState.categories[val];
            fColor = cat ? cat.fillColor : (styleState.defaultFill || '#cccccc');
            sColor = cat ? cat.color : (styleState.defaultColor || '#999999');
            fOp = cat ? cat.fillOpacity : (styleState.defaultFillOpacity ?? 0.5);
            sOp = cat ? cat.opacity : (styleState.defaultOpacity ?? 1.0);
        } else if (styleState) {
            fColor = styleState.fillColor || '#4f46e5';
            sColor = styleState.color || '#4f46e5';
            fOp = styleState.fillOpacity ?? 0.5;
            sOp = styleState.opacity ?? 1.0;
        }
        
        const shape = styleState ? (styleState.pointShape || 'circle') : 'circle';
        const size = styleState ? (styleState.pointSize || 8) : 8;
        
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
    if (feature.properties) {
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
    
    // Create dedicated SVG renderer for this pane
    const paneRenderer = L.svg({ pane: paneName, padding: 0.5 });
    
    return L.geoJSON(geoJsonData, {
        pane: paneName,
        renderer: paneRenderer,
        interactive: true,
        style: createGeoJsonStyleFunction(styleState),
        pointToLayer: createGeoJsonPointToLayer(styleState, paneName, paneRenderer),
        onEachFeature: (feature, layer) => {
            // Attach attribute table popups
            attachPopupsToFeatures(feature, layer);
            
            // Force mouse events to register on both shapes and point markers
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
        const defaultStyle = { type: 'single', fillColor: '#4f46e5', fillOpacity: 0.5, color: '#4f46e5', opacity: 1.0, pointShape: 'circle', pointSize: 8 };
        
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

    if(activeLayers.length > 0) {
        renderAddedLayers();
        updateMapLayerOrder();
    }
};

const loadSavedServers = async () => {
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
    osmInspectStatus.textContent = 'Scanning area...';
    osmInspectStatus.classList.remove('hidden');
    osmInspectResults.innerHTML = '';
    
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
            osmInspectStatus.textContent = 'No generic tags found in this area.';
            return;
        }
        
        osmInspectStatus.classList.add('hidden');
        let html = '';
        sortedTags.forEach(([pair, count]) => {
            const [k, v] = pair.split('=');
            html += `<div class="inspect-tag-item flex justify-between items-center p-1.5 hover:bg-indigo-100 dark:hover:bg-indigo-900/50 cursor-pointer rounded transition-colors border border-transparent hover:border-indigo-200 dark:hover:border-indigo-700" data-k="${k}" data-v="${v}">
                 <span class="text-indigo-800 dark:text-indigo-300 font-mono text-[10px] truncate pr-2">${k}=${v}</span>
                 <span class="text-gray-500 dark:text-gray-400 text-[9px] bg-gray-200 dark:bg-gray-700 px-1.5 py-0.5 rounded-full font-bold">${count}</span>
            </div>`;
        });
        osmInspectResults.innerHTML = html;
        
        document.querySelectorAll('.inspect-tag-item').forEach(item => {
            item.addEventListener('click', (e) => {
                const el = e.currentTarget;
                document.getElementById('osm-key').value = el.getAttribute('data-k');
                document.getElementById('osm-value').value = el.getAttribute('data-v');
                showToast(`Copied ${el.getAttribute('data-k')}=${el.getAttribute('data-v')} to Query Builder!`);
            });
        });
        
    } catch (err) {
        osmInspectStatus.textContent = 'Scan failed. Area might be too large.';
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
  if (layer.isVisible) { map.addLayer(layer.mapLayer); updateMapLayerOrder(); } 
  else { map.removeLayer(layer.mapLayer); autoSaveWorkspace(); }
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
  if(activeTableLayerKey === key || activeEditLayerKey === key || activeSplitLayerKey === key || activeCropLayerKey === key) { 
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
    if(!success) return;

    const newGeoJson = JSON.parse(JSON.stringify(layer.geoJsonData));
    const newStyleState = layer.customStyle ? JSON.parse(JSON.stringify(layer.customStyle)) : { type: 'single', fillColor: '#4f46e5', fillOpacity: 0.5, color: '#4f46e5', opacity: 1.0, pointShape: 'circle', pointSize: 8 };

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
  const key = e.currentTarget.getAttribute('data-key');
  const layer = activeLayers.find(l => l.uniqueKey === key);

  if (activeTableLayerKey === key) { closeAllPanels(); return; }

  closeAllPanels();
  activeTableLayerKey = key;
  renderAddedLayers(); 
  
  attributeTableContainer.classList.remove('hidden');
  attributeTableContainer.classList.add('flex');
  attributeTableContainer.innerHTML = '<div class="flex items-center justify-center h-full"><p class="text-sm text-gray-500 dark:text-gray-400 italic animate-pulse">Fetching attributes...</p></div>';

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

    if (features.length === 0 || Object.keys(features[0].properties || {}).length === 0) {
      attributeTableContainer.innerHTML = `
        <div class="flex justify-between items-center mb-2 shrink-0 border-b border-gray-200 dark:border-gray-700 pb-2">
            <div class="text-xs font-bold text-gray-700 dark:text-gray-200">${layer.displayName} Data</div>
            <button onclick="window.closeAllPanels()" class="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 px-2"><i class="fa-solid fa-times"></i></button>
        </div>
        <p class="text-sm text-gray-500 dark:text-gray-400 italic p-2 text-center">No attributes available.</p>`;
      return;
    }

    const headers = Object.keys(features[0].properties);
    let tableHtml = `
        <div class="flex justify-between items-center mb-2 shrink-0 border-b border-gray-200 dark:border-gray-700 pb-1">
            <div class="text-xs font-bold text-gray-700 dark:text-gray-200">${layer.displayName} Data</div>
            <button onclick="window.closeAllPanels()" class="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 px-2"><i class="fa-solid fa-times"></i></button>
        </div>
        <div class="flex-1 overflow-auto min-h-0 custom-scroll border border-gray-200 dark:border-gray-700">
            <table class="min-w-full text-xs text-left border-collapse bg-white dark:bg-gray-800">
                <thead class="bg-gray-100 dark:bg-gray-700 sticky top-0 shadow-sm z-10"><tr>`;
    headers.forEach(h => { tableHtml += `<th class="px-2 py-1 border border-gray-200 dark:border-gray-600 font-semibold text-gray-700 dark:text-gray-200 whitespace-nowrap">${h}</th>`; });
    tableHtml += '</tr></thead><tbody>';

    features.slice(0, 100).forEach(f => {
      tableHtml += '<tr class="hover:bg-indigo-50 dark:hover:bg-indigo-900/30">';
      headers.forEach(h => {
         const val = f.properties[h];
         const displayVal = (val !== null && val !== undefined) ? val : '';
         tableHtml += `<td class="px-2 py-1 border border-gray-200 dark:border-gray-700 text-gray-800 dark:text-gray-300 whitespace-nowrap max-w-[150px] truncate" title="${displayVal}">${displayVal}</td>`;
      });
      tableHtml += '</tr>';
    });

    tableHtml += '</tbody></table></div>';
    if (features.length >= 100 || (!layer.isLocalGeoJSON && features.length > 0)) {
       tableHtml += `<p class="text-[10px] text-gray-400 dark:text-gray-500 mt-2 italic text-center shrink-0">Showing up to 100 records for preview.</p>`;
    }
    attributeTableContainer.innerHTML = tableHtml;

  } catch (err) {
    attributeTableContainer.innerHTML = `
      <div class="flex justify-between items-center mb-2 shrink-0 border-b border-gray-200 dark:border-gray-700 pb-2">
          <div class="text-xs font-bold text-gray-700 dark:text-gray-200">${layer.displayName} Data</div>
          <button onclick="window.closeAllPanels()" class="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 px-2"><i class="fa-solid fa-times"></i></button>
      </div>
      <p class="text-sm text-red-500 dark:text-red-400 italic p-2 text-center">Failed to load attribute data.</p>`;
  }
};

const handleToggleEdit = async (e) => {
    const key = e.currentTarget ? e.currentTarget.getAttribute('data-key') : e;
    const layer = activeLayers.find(l => l.uniqueKey === key);

    if (activeEditLayerKey === key) { closeAllPanels(); return; }

    closeAllPanels();
    activeEditLayerKey = key;
    renderAddedLayers();
    editPanelContainer.classList.remove('hidden'); editPanelContainer.classList.add('flex');
    editPanelContainer.innerHTML = '<div class="flex justify-center p-4"><p class="text-sm italic animate-pulse text-gray-500 dark:text-gray-400">Preparing editable vector data...</p></div>';

    const success = await ensureGeoJSON(layer);
    if(!success) { closeAllPanels(); return; }

    const features = layer.geoJsonData.features || [];
    let cols = [];
    if (features.length > 0 && features[0].properties) cols = Object.keys(features[0].properties);
    
    const hasPoints = features.some(f => f.geometry && (f.geometry.type === 'Point' || f.geometry.type === 'MultiPoint'));
    const cs = layer.customStyle || { type: 'single', fillColor: '#4f46e5', fillOpacity: 0.5, color: '#4f46e5', opacity: 1.0, pointShape: 'circle', pointSize: 8 };
    const isCat = (cs.type === 'categorical');
    const pasteDisabled = copiedStyle ? '' : 'disabled';
    const pasteOpacity = copiedStyle ? '' : 'opacity-50 cursor-not-allowed';

    editPanelContainer.innerHTML = `
        <div class="p-3 text-sm flex flex-col h-full min-h-0 bg-purple-50 dark:bg-transparent">
            <div class="flex justify-between items-center mb-3 border-b border-purple-200 dark:border-purple-800 pb-2 shrink-0">
                <h4 class="font-bold text-gray-700 dark:text-gray-200 uppercase text-xs tracking-wider">Appearance & Alpha</h4>
                <div class="flex space-x-2 items-center">
                    <button id="btn-copy-style" class="text-xs bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 px-2 py-1 rounded transition-colors shadow-sm" title="Copy Style"><i class="fa-solid fa-copy"></i></button>
                    <button id="btn-paste-style" class="text-xs bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 px-2 py-1 rounded transition-colors shadow-sm ${pasteOpacity}" title="Paste Style" ${pasteDisabled}><i class="fa-solid fa-paste"></i></button>
                    <button onclick="window.closeAllPanels()" class="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 ml-2"><i class="fa-solid fa-times"></i></button>
                </div>
            </div>
            
            <div class="flex-1 overflow-y-auto custom-scroll pr-1 flex flex-col min-h-0">
                ${hasPoints ? `
                <div id="point-style-container" class="flex flex-col space-y-3 mb-3 shrink-0 bg-white dark:bg-gray-800 p-3 rounded border border-purple-100 dark:border-purple-800">
                    <h5 class="text-[10px] font-bold text-purple-500 dark:text-purple-400 uppercase tracking-wider mb-1">Point Markers</h5>
                    <div class="flex items-center space-x-3 w-full">
                        <label class="text-xs text-gray-600 dark:text-gray-300 font-bold w-12 shrink-0">Shape:</label>
                        <select id="edit-point-shape" class="flex-1 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white rounded px-2 py-1 text-xs focus:outline-none">
                            <option value="circle" ${cs.pointShape === 'circle' ? 'selected' : ''}>Circle</option>
                            <option value="square" ${cs.pointShape === 'square' ? 'selected' : ''}>Square</option>
                            <option value="triangle" ${cs.pointShape === 'triangle' ? 'selected' : ''}>Triangle</option>
                        </select>
                    </div>
                    <div class="flex items-center space-x-3 w-full">
                        <label class="text-xs text-gray-600 dark:text-gray-300 font-bold w-12 shrink-0">Scale:</label>
                        <input type="range" id="edit-point-size" min="2" max="30" step="1" value="${cs.pointSize || 8}" class="flex-1 w-full cursor-pointer accent-purple-600 dark:accent-purple-500" title="Point Size">
                        <span id="point-size-display" class="text-xs text-gray-500 font-mono w-4 text-right">${cs.pointSize || 8}</span>
                    </div>
                </div>
                ` : ''}

                <div class="flex items-center space-x-2 mb-3 bg-white dark:bg-gray-800 p-2 border border-purple-100 dark:border-purple-800 rounded shadow-sm shrink-0">
                    <input type="checkbox" id="use-data-style" class="w-4 h-4 text-purple-600 dark:text-purple-500 rounded cursor-pointer accent-purple-600 dark:accent-purple-500" ${isCat ? 'checked' : ''}>
                    <label for="use-data-style" class="text-xs font-semibold text-gray-700 dark:text-gray-300 whitespace-nowrap">Use Data Colors</label>
                    <select id="style-col-select" class="flex-1 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white rounded px-2 py-1 text-xs" ${isCat ? '' : 'disabled'}>
                        <option value="" disabled ${!isCat ? 'selected' : ''}>Select attribute...</option>
                        ${cols.map(c => `<option value="${c}" ${(isCat && cs.property === c) ? 'selected' : ''}>${c}</option>`).join('')}
                    </select>
                </div>

                <div id="single-style-container" class="${isCat ? 'hidden' : 'flex'} flex-col space-y-3 mb-3 shrink-0 bg-white dark:bg-gray-800 p-3 rounded border border-gray-200 dark:border-gray-700">
                    <div class="flex items-center space-x-3 w-full">
                        <label class="text-xs text-gray-600 dark:text-gray-300 font-bold w-12 shrink-0">Fill:</label>
                        <input type="color" id="edit-fill-color" value="${cs.fillColor || '#4f46e5'}" class="w-8 h-8 p-0 border-0 rounded cursor-pointer shadow-sm shrink-0 bg-transparent">
                        <input type="range" id="edit-fill-opacity" min="0" max="1" step="0.05" value="${cs.fillOpacity ?? 0.5}" class="flex-1 w-full cursor-pointer accent-purple-600 dark:accent-purple-500" title="Fill Opacity">
                    </div>
                    <div class="flex items-center space-x-3 w-full">
                        <label class="text-xs text-gray-600 dark:text-gray-300 font-bold w-12 shrink-0">Outline:</label>
                        <input type="color" id="edit-stroke-color" value="${cs.color || '#4f46e5'}" class="w-8 h-8 p-0 border-0 rounded cursor-pointer shadow-sm shrink-0 bg-transparent">
                        <input type="range" id="edit-stroke-opacity" min="0" max="1" step="0.05" value="${cs.opacity ?? 1.0}" class="flex-1 w-full cursor-pointer accent-purple-600 dark:accent-purple-500" title="Outline Opacity">
                    </div>
                </div>

                <div id="categorical-style-list" class="${isCat ? 'flex' : 'hidden'} flex-1 flex-col min-h-0 border border-gray-200 dark:border-gray-700 rounded p-2 bg-white dark:bg-gray-800 mb-2">
                    <div id="cat-inner-list" class="overflow-y-auto custom-scroll flex-1 min-h-0">
                        <p class="text-xs text-gray-400 dark:text-gray-500 italic text-center py-2">Select an attribute column to generate colors.</p>
                    </div>
                </div>
            </div>

            <div class="flex justify-between pt-3 border-t border-purple-100 dark:border-purple-800 shrink-0 mt-2">
                <button id="btn-bake-colors" class="bg-indigo-100 dark:bg-indigo-900/50 hover:bg-indigo-200 dark:hover:bg-indigo-800 text-indigo-800 dark:text-indigo-300 text-xs px-3 py-1.5 rounded transition-colors shadow-sm font-medium border border-indigo-200 dark:border-indigo-700" title="Write RGBA hex values to the attribute table">
                    <i class="fa-solid fa-database mr-1"></i>Bake to Table
                </button>
                <div class="flex space-x-2">
                    <button id="btn-refresh-colors" class="${isCat ? '' : 'hidden'} bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 text-xs px-3 py-1.5 rounded transition-colors shadow-sm font-medium border border-gray-300 dark:border-gray-600" title="Randomize category colors">
                        <i class="fa-solid fa-arrows-rotate mr-1"></i> Refresh
                    </button>
                    <button id="btn-apply-edit" class="bg-purple-600 hover:bg-purple-700 dark:bg-purple-600 dark:hover:bg-purple-500 text-white text-xs px-4 py-1.5 rounded transition-colors shadow-sm font-medium">Apply Style</button>
                </div>
            </div>
        </div>
    `;

    if (hasPoints) {
        document.getElementById('edit-point-size').addEventListener('input', (e) => {
            document.getElementById('point-size-display').textContent = e.target.value;
        });
    }

    const chkUseData = document.getElementById('use-data-style');
    const selCol = document.getElementById('style-col-select');
    const singleContainer = document.getElementById('single-style-container');
    const catListWrapper = document.getElementById('categorical-style-list');
    const catInnerList = document.getElementById('cat-inner-list');
    const btnRefreshColors = document.getElementById('btn-refresh-colors');

    const renderCategoryPickers = () => {
        const propName = selCol.value;
        if(!propName) return;
        let uniqueVals = [...new Set(layer.geoJsonData.features.map(f => f.properties[propName]))].filter(v => v !== null && v !== undefined);
        
        if (uniqueVals.length > 200 && !confirm(`Generate color pickers for ${uniqueVals.length} unique values?`)) return;
        if(uniqueVals.length === 0) { catInnerList.innerHTML = '<p class="text-xs text-gray-400 dark:text-gray-500 italic text-center">No unique values.</p>'; return; }

        let html = '';
        uniqueVals.forEach(val => {
            let fCol = '#' + Math.floor(Math.random()*16777215).toString(16).padStart(6, '0');
            let sCol = darkenHex(fCol, 0.3), fOp = 0.5, sOp = 1.0;

            if (isCat && cs.property === propName && cs.categories && cs.categories[val]) {
                fCol = cs.categories[val].fillColor; sCol = cs.categories[val].color;
                fOp = cs.categories[val].fillOpacity ?? 0.5; sOp = cs.categories[val].opacity ?? 1.0;
            }
            html += `
                <div class="flex items-center justify-between mb-2 pb-2 border-b border-gray-100 dark:border-gray-700 last:border-0 last:mb-0 last:pb-0 cat-row" data-val="${val}">
                    <span class="text-xs text-gray-700 dark:text-gray-300 truncate flex-1 pr-2 font-medium" title="${val}">${val}</span>
                    <div class="flex space-x-2 items-center shrink-0">
                        <span class="text-[10px] text-gray-400 dark:text-gray-500 font-bold" title="Fill">F:</span>
                        <input type="color" class="cat-fill w-6 h-6 p-0 border-0 rounded cursor-pointer shrink-0 bg-transparent" value="${fCol}">
                        <input type="range" class="cat-fill-op w-20 sm:w-24 cursor-pointer shrink-0 accent-purple-600 dark:accent-purple-500" min="0" max="1" step="0.05" value="${fOp}" title="Fill Opacity">
                        <span class="text-[10px] text-gray-400 dark:text-gray-500 font-bold ml-2" title="Outline">O:</span>
                        <input type="color" class="cat-stroke w-6 h-6 p-0 border-0 rounded cursor-pointer shrink-0 bg-transparent" value="${sCol}">
                        <input type="range" class="cat-stroke-op w-20 sm:w-24 cursor-pointer shrink-0 accent-purple-600 dark:accent-purple-500" min="0" max="1" step="0.05" value="${sOp}" title="Outline Opacity">
                    </div>
                </div>
            `;
        });
        catInnerList.innerHTML = html;
    };

    chkUseData.addEventListener('change', (e) => {
        if(e.target.checked) {
            selCol.disabled = false; singleContainer.classList.add('hidden'); singleContainer.classList.remove('flex');
            catListWrapper.classList.remove('hidden'); catListWrapper.classList.add('flex'); btnRefreshColors.classList.remove('hidden');
            if(selCol.value) renderCategoryPickers();
        } else {
            selCol.disabled = true; singleContainer.classList.remove('hidden'); singleContainer.classList.add('flex');
            catListWrapper.classList.add('hidden'); catListWrapper.classList.remove('flex'); btnRefreshColors.classList.add('hidden');
        }
    });

    selCol.addEventListener('change', renderCategoryPickers);
    if (isCat && cs.property) renderCategoryPickers();

    btnRefreshColors.addEventListener('click', () => {
        document.querySelectorAll('.cat-row').forEach(row => {
            const newFill = '#' + Math.floor(Math.random()*16777215).toString(16).padStart(6, '0');
            row.querySelector('.cat-fill').value = newFill;
            row.querySelector('.cat-stroke').value = darkenHex(newFill, 0.3);
        });
    });

    document.getElementById('btn-copy-style').addEventListener('click', () => {
        copiedStyle = layer.customStyle ? JSON.parse(JSON.stringify(layer.customStyle)) : { type: 'single', fillColor: '#4f46e5', fillOpacity: 0.5, color: '#4f46e5', opacity: 1.0, pointShape: 'circle', pointSize: 8 };
        showToast("Style copied to clipboard!");
        const pasteBtn = document.getElementById('btn-paste-style');
        pasteBtn.disabled = false; pasteBtn.classList.remove('opacity-50', 'cursor-not-allowed');
    });

    document.getElementById('btn-paste-style').addEventListener('click', () => {
        if (!copiedStyle) return;
        layer.customStyle = JSON.parse(JSON.stringify(copiedStyle));
        if (layer.customStyle.type === 'categorical') {
            const layerFeatures = layer.geoJsonData.features || [];
            if (layerFeatures.length > 0 && layerFeatures[0].properties && !(layer.customStyle.property in layerFeatures[0].properties)) {
                 showToast("Target layer missing attribute column. Applied fallback colors.", true);
                 layer.customStyle.type = 'single';
                 layer.customStyle.fillColor = layer.customStyle.defaultFill || '#cccccc';
                 layer.customStyle.color = layer.customStyle.defaultColor || '#999999';
                 layer.customStyle.fillOpacity = layer.customStyle.defaultFillOpacity || 0.5;
                 layer.customStyle.opacity = layer.customStyle.defaultOpacity || 1.0;
            }
        }
        map.removeLayer(layer.mapLayer);
        const paneName = 'pane-' + layer.uniqueKey;
        const newMapLayer = createCustomGeoJSONLayer(layer.geoJsonData, layer.customStyle, paneName);
        if (layer.isVisible) newMapLayer.addTo(map);
        layer.mapLayer = newMapLayer;
        updateMapLayerOrder();
        showToast("Style pasted and applied!");
        activeEditLayerKey = null; handleToggleEdit(key); 
    });

    document.getElementById('btn-apply-edit').addEventListener('click', () => {
        const shapeEl = document.getElementById('edit-point-shape');
        const sizeEl = document.getElementById('edit-point-size');
        const pShape = shapeEl ? shapeEl.value : (layer.customStyle.pointShape || 'circle');
        const pSize = sizeEl ? parseInt(sizeEl.value, 10) : (layer.customStyle.pointSize || 8);

        if (chkUseData.checked) {
            const prop = selCol.value;
            if(!prop) return showToast("Select an attribute column for data styling.", true);
            const newCategories = {};
            document.querySelectorAll('.cat-row').forEach(row => {
                const val = row.getAttribute('data-val');
                newCategories[val] = { 
                    fillColor: row.querySelector('.cat-fill').value, 
                    fillOpacity: parseFloat(row.querySelector('.cat-fill-op').value), 
                    color: row.querySelector('.cat-stroke').value, 
                    opacity: parseFloat(row.querySelector('.cat-stroke-op').value) 
                };
            });
            layer.customStyle = { type: 'categorical', property: prop, categories: newCategories, defaultFill: '#cccccc', defaultFillOpacity: 0.5, defaultColor: '#999999', defaultOpacity: 1.0, pointShape: pShape, pointSize: pSize };
        } else {
            layer.customStyle = { 
                type: 'single', 
                fillColor: document.getElementById('edit-fill-color').value, 
                fillOpacity: parseFloat(document.getElementById('edit-fill-opacity').value), 
                color: document.getElementById('edit-stroke-color').value, 
                opacity: parseFloat(document.getElementById('edit-stroke-opacity').value), 
                pointShape: pShape, pointSize: pSize 
            }; 
        }
        
        map.removeLayer(layer.mapLayer);
        const paneName = 'pane-' + layer.uniqueKey;
        const newMapLayer = createCustomGeoJSONLayer(layer.geoJsonData, layer.customStyle, paneName);
        if (layer.isVisible) newMapLayer.addTo(map);
        layer.mapLayer = newMapLayer;
        updateMapLayerOrder();
        showToast("Layer style updated!");
    });

    const hexAlpha = (hex, alpha) => { return (hex + Math.round(alpha * 255).toString(16).padStart(2, '0').toUpperCase()).toUpperCase(); };

    document.getElementById('btn-bake-colors').addEventListener('click', () => {
        if (!layer.customStyle) return showToast("Please Apply a style first.", true);
        let count = 0;
        layer.geoJsonData.features.forEach(f => {
            if (!f.properties) f.properties = {};
            let fColor = '#4F46E5', sColor = '#4F46E5', fOp = 0.5, sOp = 1.0;
            if (layer.customStyle.type === 'categorical') {
                const cat = layer.customStyle.categories[f.properties[layer.customStyle.property]];
                fColor = cat ? cat.fillColor : layer.customStyle.defaultFill;
                sColor = cat ? cat.color : layer.customStyle.defaultColor;
                fOp = cat ? cat.fillOpacity : layer.customStyle.defaultFillOpacity;
                sOp = cat ? cat.opacity : layer.customStyle.defaultOpacity;
            } else {
                fColor = layer.customStyle.fillColor; sColor = layer.customStyle.color;
                fOp = layer.customStyle.fillOpacity; sOp = layer.customStyle.opacity;
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
        showToast(`Baked RGBA hex values to ${count} features!`);
    });
};

const handleToggleSplit = async (e) => {
    const key = e.currentTarget.getAttribute('data-key');
    const layer = activeLayers.find(l => l.uniqueKey === key);

    if (activeSplitLayerKey === key) { closeAllPanels(); return; }

    closeAllPanels();
    activeSplitLayerKey = key;
    renderAddedLayers();
    splitPanelContainer.classList.remove('hidden');
    splitPanelContainer.classList.add('flex');
    splitPanelContainer.innerHTML = '<div class="flex justify-center p-4"><p class="text-sm italic animate-pulse text-gray-500 dark:text-gray-400">Preparing vector data for split...</p></div>';

    const success = await ensureGeoJSON(layer);
    if(!success) { closeAllPanels(); return; }

    const features = layer.geoJsonData.features || [];
    let cols = [];
    if (features.length > 0 && features[0].properties) cols = Object.keys(features[0].properties);

    splitPanelContainer.innerHTML = `
        <div class="p-3 text-sm flex flex-col h-full min-h-0 bg-amber-50 dark:bg-transparent">
            <div class="flex justify-between items-center mb-3 border-b border-amber-200 dark:border-amber-800 pb-2 shrink-0">
                <h4 class="font-bold text-gray-700 dark:text-gray-200 uppercase text-xs tracking-wider">Split Layer</h4>
                <button onclick="window.closeAllPanels()" class="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300"><i class="fa-solid fa-times"></i></button>
            </div>
            <div class="flex-1 overflow-y-auto custom-scroll pr-1 min-h-0">
                <p class="text-[10px] text-gray-500 dark:text-gray-400 mb-2 leading-tight">Select an attribute to duplicate this layer into multiple sub-layers based on unique data entries.</p>
                <div class="flex space-x-2">
                    <select id="split-col-select" class="flex-1 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white rounded px-2 py-1 text-xs">
                        <option value="" disabled selected>Select attribute column...</option>
                        ${cols.map(c => `<option value="${c}">${c}</option>`).join('')}
                    </select>
                    <button id="btn-apply-split" class="bg-amber-600 hover:bg-amber-700 dark:bg-amber-600 dark:hover:bg-amber-500 text-white text-xs px-3 py-1.5 rounded transition-colors shadow-sm shrink-0">Split Data</button>
                </div>
            </div>
        </div>
    `;

    document.getElementById('btn-apply-split').addEventListener('click', () => {
        const splitCol = document.getElementById('split-col-select').value;
        if(!splitCol) return showToast("Select an attribute column first.", true);
        
        const uniqueVals = [...new Set(layer.geoJsonData.features.map(f => f.properties[splitCol]))];
        if (uniqueVals.length > 50 && !confirm(`Create ${uniqueVals.length} layers?`)) return;

        let createdCount = 0;
        const newLayers = [];

        uniqueVals.forEach(val => {
            const filteredFeats = layer.geoJsonData.features.filter(f => f.properties[splitCol] === val);
            if(filteredFeats.length === 0) return;

            const newGeoJson = { type: "FeatureCollection", features: filteredFeats };
            const splitStyleState = layer.customStyle ? JSON.parse(JSON.stringify(layer.customStyle)) : { type: 'single', fillColor: '#4f46e5', fillOpacity: 0.5, color: '#4f46e5', opacity: 1.0, pointShape: 'circle', pointSize: 8 };

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
    drawStatus.classList.remove('hidden'); drawStatus.textContent = 'Ensuring local data for filtering...';
    filterDataSearch.value = ''; btnClearFilterSearch.classList.add('hidden');
    
    const success = await ensureGeoJSON(layer);
    if(!success) { drawStatus.textContent = 'Failed to load vector data.'; return; }
    drawStatus.textContent = 'Select an attribute column.';
    
    const features = layer.geoJsonData.features || [];
    let cols = [];
    if (features.length > 0 && features[0].properties) cols = Object.keys(features[0].properties);
    
    const sel = document.getElementById('filter-data-col');
    sel.innerHTML = `<option value="" disabled selected>Select attribute column...</option>` + cols.map(c => `<option value="${c}">${c}</option>`).join('');
    document.getElementById('filter-data-values').innerHTML = '<p class="text-gray-400 dark:text-gray-500 italic text-center">Select a column first.</p>';
    checkApplyButton();
};

const handleToggleCrop = (e) => {
    const key = e.currentTarget.getAttribute('data-key');
    const layer = activeLayers.find(l => l.uniqueKey === key);

    if (activeCropLayerKey === key) { closeAllPanels(); return; }

    closeAllPanels();
    activeCropLayerKey = key;
    cropPanelContainer.classList.remove('hidden');
    cropPanelContainer.classList.add('flex');
    renderAddedLayers();
    
    if (filterType.value === 'data') triggerDataFilterSetup(layer);
};

const checkApplyButton = () => {
  const type = filterType.value;
  if (type === 'data') {
     const checked = document.querySelectorAll('.filter-data-val-cb:checked');
     if (checked.length > 0) {
         btnApplyFilter.disabled = false;
         drawStatus.textContent = 'Ready to apply filter.';
         drawStatus.classList.replace('text-teal-700', 'text-emerald-700');
         drawStatus.classList.replace('dark:text-teal-400', 'dark:text-emerald-400');
     } else {
         btnApplyFilter.disabled = true;
         drawStatus.textContent = 'Select at least one value.';
         drawStatus.classList.replace('text-emerald-700', 'text-teal-700');
         drawStatus.classList.replace('dark:text-emerald-400', 'dark:text-teal-400');
     }
  } else {
     if (filterGeometryData && activeCropLayerKey) {
         btnApplyFilter.disabled = false;
         drawStatus.textContent = 'Ready to apply filter.';
         drawStatus.classList.replace('text-teal-700', 'text-emerald-700');
         drawStatus.classList.replace('dark:text-teal-400', 'dark:text-emerald-400');
     } else {
         btnApplyFilter.disabled = true;
     }
  }
};

const triggerSearch = () => {
  const term = layerSearch.value.toLowerCase();
  if (term === '') btnClearSearch.classList.add('hidden');
  else btnClearSearch.classList.remove('hidden');
  
  let visibleCount = 0;
  document.querySelectorAll('.available-layer-item').forEach(item => {
    if (item.getAttribute('data-search').includes(term)) { item.classList.remove('hidden'); visibleCount++; } 
    else { item.classList.add('hidden'); }
  });
  
  let emptyMsg = document.getElementById('search-empty-msg');
  if (visibleCount === 0 && fetchedLayers.length > 0) {
    if (!emptyMsg) {
      emptyMsg = document.createElement('p'); emptyMsg.id = 'search-empty-msg'; emptyMsg.className = 'text-sm text-gray-400 dark:text-gray-500 italic text-center mt-4'; emptyMsg.textContent = 'No matching layers found.';
      availableLayerList.appendChild(emptyMsg);
    }
    emptyMsg.classList.remove('hidden');
  } else if (emptyMsg) { emptyMsg.classList.add('hidden'); }
};

const triggerAddedSearch = () => {
  const term = addedLayerSearch.value.toLowerCase();
  if (term === '') btnClearAddedSearch.classList.add('hidden');
  else btnClearAddedSearch.classList.remove('hidden');
  
  let visibleCount = 0;
  document.querySelectorAll('.added-layer-item').forEach(item => {
    if (item.getAttribute('data-search').includes(term)) { item.classList.remove('hidden'); visibleCount++; } 
    else { item.classList.add('hidden'); }
  });
  
  let emptyMsg = document.getElementById('added-search-empty-msg');
  if (visibleCount === 0 && activeLayers.length > 0) {
    if (!emptyMsg) {
      emptyMsg = document.createElement('p'); emptyMsg.id = 'added-search-empty-msg'; emptyMsg.className = 'text-sm text-gray-400 dark:text-gray-500 italic text-center mt-4'; emptyMsg.textContent = 'No matching layers found.';
      addedLayerList.appendChild(emptyMsg);
    }
    emptyMsg.classList.remove('hidden');
  } else if (emptyMsg) { emptyMsg.classList.add('hidden'); }
};

const triggerFilterDataSearch = () => {
    const term = filterDataSearch.value.toLowerCase();
    if (term === '') btnClearFilterSearch.classList.add('hidden');
    else btnClearFilterSearch.classList.remove('hidden');
    
    document.querySelectorAll('#filter-data-values label').forEach(label => {
        const val = label.querySelector('input').value.toLowerCase();
        if (val.includes(term)) { label.classList.remove('hidden'); label.classList.add('flex'); } 
        else { label.classList.add('hidden'); label.classList.remove('flex'); }
    });
};


// ==========================================
// 7. MAIN UI RENDERERS
// ==========================================
const renderAvailableLayers = () => {
  availableLayerList.innerHTML = '';
  if (fetchedLayers.length === 0) {
    availableLayerList.innerHTML = `<p class="text-sm text-gray-400 dark:text-gray-500 italic text-center mt-4">No layers fetched yet.</p>`;
    searchContainer.classList.add('hidden');
    btnAddBulk.disabled = true;
    return;
  }
  
  searchContainer.classList.remove('hidden');
  btnAddBulk.disabled = false;

  fetchedLayers.forEach((layer) => {
    const div = document.createElement('div');
    div.className = 'available-layer-item flex items-center p-2 hover:bg-gray-50 dark:hover:bg-gray-700 rounded border border-transparent dark:border-transparent hover:border-gray-200 dark:hover:border-gray-600 mb-1 transition-colors';
    div.setAttribute('data-search', `${layer.title} ${layer.id}`.toLowerCase());
    
    div.innerHTML = `
      <div class="flex items-center h-5 mr-2 shrink-0">
         <input id="cb-${layer.id}" type="checkbox" value="${layer.id}" class="w-4 h-4 layer-checkbox cursor-pointer accent-blue-600 dark:accent-blue-500" title="Preview on Map">
      </div>
      <div class="ml-1 text-sm flex-1 overflow-hidden pr-2 cursor-pointer">
        <label for="cb-${layer.id}" class="font-medium text-gray-700 dark:text-gray-200 block truncate cursor-pointer" title="${layer.title}">${layer.title}</label>
        <p class="text-gray-400 dark:text-gray-500 text-[10px] truncate" title="${layer.id}">ID: ${layer.id}</p>
      </div>
      <button class="btn-add-single shrink-0 bg-blue-100 dark:bg-blue-900/40 hover:bg-blue-200 dark:hover:bg-blue-800 text-blue-700 dark:text-blue-300 w-8 h-8 rounded-full flex items-center justify-center transition-colors shadow-sm" data-id="${layer.id}" title="Add Single Layer"><i class="fa-solid fa-plus"></i></button>
    `;
    availableLayerList.appendChild(div);
  });
  
  document.querySelectorAll('.layer-checkbox').forEach(cb => cb.addEventListener('change', (e) => togglePreviewLayer(e.target.value, e.target.checked)));
  document.querySelectorAll('.btn-add-single').forEach(btn => {
      btn.addEventListener('click', (e) => {
          const layerId = e.currentTarget.getAttribute('data-id');
          const cb = document.getElementById(`cb-${layerId}`);
          if (cb) cb.checked = false;
          togglePreviewLayer(layerId, false);
          addLayerToMap(layerId, true);
      });
  });
  triggerSearch(); 
};

const renderAddedLayers = () => {
  tabBtnAdded.textContent = `Added (${activeLayers.length})`;
  addedLayerList.innerHTML = '';

  if (activeLayers.length === 0) {
    addedLayerList.innerHTML = `<p class="text-sm text-gray-400 dark:text-gray-500 italic text-center mt-4">No layers currently added to map.</p>`;
    addedSearchContainer.classList.add('hidden');
    return;
  }

  addedSearchContainer.classList.remove('hidden');

  activeLayers.forEach(layer => {
    const isTableActive = (activeTableLayerKey === layer.uniqueKey);
    const isEditActive = (activeEditLayerKey === layer.uniqueKey);
    const isSplitActive = (activeSplitLayerKey === layer.uniqueKey);
    const isCropActive = (activeCropLayerKey === layer.uniqueKey);
    
    let bgClass = 'bg-white border-gray-100 hover:bg-gray-50 shadow-sm dark:bg-gray-800 dark:border-gray-700 dark:hover:bg-gray-700';
    if (isTableActive) bgClass = 'bg-indigo-50 border-indigo-300 shadow-md dark:bg-indigo-900/30 dark:border-indigo-600';
    if (isEditActive) bgClass = 'bg-purple-50 border-purple-300 shadow-md dark:bg-purple-900/30 dark:border-purple-600';
    if (isSplitActive) bgClass = 'bg-amber-50 border-amber-300 shadow-md dark:bg-amber-900/30 dark:border-amber-600';
    if (isCropActive) bgClass = 'bg-teal-50 border-teal-300 shadow-md dark:bg-teal-900/30 dark:border-teal-600';

    const div = document.createElement('div');
    div.className = `added-layer-item flex flex-col p-2 mb-1 rounded border transition-colors ${bgClass}`;
    div.setAttribute('data-search', `${layer.displayName} ${layer.id}`.toLowerCase());
    
    div.innerHTML = `
      <div class="flex items-center justify-between">
        <div class="mr-3 shrink-0">
           <input type="checkbox" class="w-4 h-4 text-blue-600 dark:text-blue-500 rounded cursor-pointer btn-toggle-vis accent-blue-600 dark:accent-blue-500" data-key="${layer.uniqueKey}" ${layer.isVisible ? 'checked' : ''} title="Toggle visibility">
        </div>
        <div class="flex-1 overflow-hidden pr-2">
          <span class="text-sm font-semibold text-gray-800 dark:text-gray-200 truncate block" title="${layer.displayName}">${layer.displayName}</span>
          <span class="text-[10px] text-gray-400 dark:text-gray-500 block truncate" title="${layer.id}">ID: ${layer.id}</span>
        </div>
      </div>
      
      <div class="mt-2 flex justify-between border-t border-gray-200 dark:border-gray-700 pt-2 text-gray-500 dark:text-gray-400 text-sm">
        <div class="flex space-x-1.5">
           <button class="hover:text-blue-600 dark:hover:text-blue-400 transition-colors btn-reorder" data-key="${layer.uniqueKey}" data-action="top" title="Bring to Front"><i class="fa-solid fa-angles-up"></i></button>
           <button class="hover:text-blue-600 dark:hover:text-blue-400 transition-colors btn-reorder" data-key="${layer.uniqueKey}" data-action="up" title="Move Up"><i class="fa-solid fa-angle-up"></i></button>
           <button class="hover:text-blue-600 dark:hover:text-blue-400 transition-colors btn-reorder" data-key="${layer.uniqueKey}" data-action="down" title="Move Down"><i class="fa-solid fa-angle-down"></i></button>
           <button class="hover:text-blue-600 dark:hover:text-blue-400 transition-colors btn-reorder" data-key="${layer.uniqueKey}" data-action="bottom" title="Send to Back"><i class="fa-solid fa-angles-down"></i></button>
        </div>
        <div class="flex space-x-2.5 justify-end">
            <button class="transition-colors btn-table ${isTableActive ? 'text-indigo-600 dark:text-indigo-400' : 'hover:text-indigo-600 dark:hover:text-indigo-400'}" data-key="${layer.uniqueKey}" title="View Data Table"><i class="fa-solid fa-table"></i></button>
            <button class="transition-colors btn-edit ${isEditActive ? 'text-purple-600 dark:text-purple-400' : 'hover:text-purple-600 dark:hover:text-purple-400'}" data-key="${layer.uniqueKey}" title="Edit Appearance"><i class="fa-solid fa-palette"></i></button>
            <button class="transition-colors btn-crop ${isCropActive ? 'text-teal-600 dark:text-teal-400' : 'hover:text-teal-600 dark:hover:text-teal-400'}" data-key="${layer.uniqueKey}" title="Filter / Crop Layer"><i class="fa-solid fa-crop"></i></button>
            <button class="transition-colors btn-split ${isSplitActive ? 'text-amber-600 dark:text-amber-400' : 'hover:text-amber-600 dark:hover:text-amber-400'}" data-key="${layer.uniqueKey}" title="Split Layer by Attribute"><i class="fa-solid fa-object-ungroup"></i></button>
            <button class="hover:text-blue-500 dark:hover:text-blue-400 transition-colors btn-duplicate" data-key="${layer.uniqueKey}" title="Duplicate Layer"><i class="fa-solid fa-clone"></i></button>
            <button class="hover:text-orange-500 dark:hover:text-orange-400 transition-colors btn-rename" data-key="${layer.uniqueKey}" title="Rename Layer"><i class="fa-solid fa-pen"></i></button>
            <button class="hover:text-green-600 dark:hover:text-green-400 transition-colors btn-export" data-key="${layer.uniqueKey}" title="Export to GeoJSON"><i class="fa-solid fa-download"></i></button>
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
    if(!meta) return;

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
document.getElementById('toggle-workspace').addEventListener('click', () => {
    document.getElementById('content-workspace').classList.toggle('hidden');
    document.getElementById('icon-workspace').classList.toggle('-rotate-90');
});

document.getElementById('toggle-database').addEventListener('click', () => {
    document.getElementById('content-database').classList.toggle('hidden');
    document.getElementById('icon-database').classList.toggle('-rotate-90');
});

tabBtnAvailable.addEventListener('click', () => switchTab('available'));
tabBtnAdded.addEventListener('click', () => switchTab('added'));

savedServersSelect.addEventListener('change', (e) => {
    const opt = e.target.options[e.target.selectedIndex];
    if (opt.value) {
        document.getElementById('server-url').value = opt.value;
        document.getElementById('server-type').value = opt.dataset.type;
        document.getElementById('server-type').dispatchEvent(new Event('change')); 
    }
});

btnSaveServer.addEventListener('click', async () => {
    const url = document.getElementById('server-url').value.trim();
    const type = document.getElementById('server-type').value;
    if (!url) return showToast("Enter a Server URL to save.", true);
    const name = prompt("Enter a recognizable name for this server database:");
    if (!name) return;
    try {
        const res = await fetch('/api/servers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, url, type }) });
        if (res.ok) { showToast("Server added to Database!"); await loadSavedServers(); savedServersSelect.value = url; }
    } catch (err) { showToast("Failed to save server.", true); }
});

document.getElementById('btn-export-workspace').addEventListener('click', () => {
    if (activeLayers.length === 0) return showToast("No active layers to export in workspace.", true);
    const data = serializeWorkspace();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const dateStr = new Date().toISOString().split('T')[0];
    downloadBlob(blob, `gis_workspace_${dateStr}.json`);
});

document.getElementById('file-import-workspace').addEventListener('change', (e) => {
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

document.getElementById('btn-clear-workspace').addEventListener('click', () => {
    if (activeLayers.length === 0) return;
    if (confirm("Reset workspace? All added layers will be removed from the map.")) {
        closeAllPanels(); clearAllPreviews();
        activeLayers.forEach(l => { map.removeLayer(l.mapLayer); removePane(l.uniqueKey); });
        activeLayers = []; localStorage.removeItem('gis_previewer_auto_save');
        renderAddedLayers(); showToast("Workspace reset.");
    }
});

document.getElementById('server-type').addEventListener('change', (e) => {
    const type = e.target.value;
    if (type === 'OVERPASS') {
        document.getElementById('server-url-container').classList.add('hidden');
        document.getElementById('overpass-builder').classList.remove('hidden');
        document.getElementById('btn-fetch-text').textContent = 'Fetch OSM Data';
        document.getElementById('btn-save-server').disabled = true;
        document.getElementById('btn-save-server').classList.add('opacity-50');
    } else {
        document.getElementById('server-url-container').classList.remove('hidden');
        document.getElementById('overpass-builder').classList.add('hidden');
        document.getElementById('btn-fetch-text').textContent = 'Fetch Layers';
        document.getElementById('btn-save-server').disabled = false;
        document.getElementById('btn-save-server').classList.remove('opacity-50');
        document.getElementById('osm-available-tools').classList.add('hidden');
        document.getElementById('osm-available-tools').classList.remove('flex');
    }
});

btnAddBulk.addEventListener('click', () => {
  const cbs = document.querySelectorAll('.layer-checkbox:checked');
  if (cbs.length === 0) return showToast("Select at least one layer to add.", true);
  cbs.forEach(cb => { togglePreviewLayer(cb.value, false); cb.checked = false; addLayerToMap(cb.value, false); });
  renderAddedLayers(); switchTab('added'); showToast(`Bulk added ${cbs.length} layers to map!`);
});

document.getElementById('btn-available-split').addEventListener('click', () => {
    const splitCol = document.getElementById('available-split-col').value;
    if(!splitCol) return showToast("Select an attribute column first.", true);
    if(!lastFetchedOsmGeoJson) return;
    
    const uniqueVals = [...new Set(lastFetchedOsmGeoJson.features.map(f => f.properties[splitCol]))];
    if (uniqueVals.length > 50 && !confirm(`This will unpack ${uniqueVals.length} layers into the list below. Proceed?`)) return;
    
    clearAllPreviews(); 
    fetchedLayers = []; 
    
    uniqueVals.forEach(val => {
        const filteredFeats = lastFetchedOsmGeoJson.features.filter(f => f.properties[splitCol] === val);
        if(filteredFeats.length === 0) return;
        
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

layerSearch.addEventListener('input', triggerSearch);
btnClearSearch.addEventListener('click', () => { layerSearch.value = ''; triggerSearch(); layerSearch.focus(); });
addedLayerSearch.addEventListener('input', triggerAddedSearch);
btnClearAddedSearch.addEventListener('click', () => { addedLayerSearch.value = ''; triggerAddedSearch(); addedLayerSearch.focus(); });
filterDataSearch.addEventListener('input', triggerFilterDataSearch);
btnClearFilterSearch.addEventListener('click', () => { filterDataSearch.value = ''; triggerFilterDataSearch(); filterDataSearch.focus(); });

if (osmKeyInput) {
    osmKeyInput.addEventListener('input', (e) => {
        const key = e.target.value.toLowerCase().trim();
        osmValueDatalist.innerHTML = ''; 
        let values = commonOsmTags[key] || ['yes']; 
        values.forEach(val => { const opt = document.createElement('option'); opt.value = val; osmValueDatalist.appendChild(opt); });
    });
}

if (btnOsmInspect) {
    btnOsmInspect.addEventListener('click', () => {
        osmInspectContainer.classList.remove('hidden');
        osmInspectContainer.classList.add('flex');
        osmInspectStatus.textContent = 'Click and drag a box on the map...';
        osmInspectStatus.classList.remove('hidden');
        osmInspectResults.innerHTML = '';
        
        drawingMode = 'inspect';
        drawLayerGroup.clearLayers();
        map.getContainer().style.cursor = 'crosshair';
    });
}

if (btnCloseInspect) {
    btnCloseInspect.addEventListener('click', () => {
        osmInspectContainer.classList.add('hidden');
        osmInspectContainer.classList.remove('flex');
        if (drawingMode === 'inspect') {
            drawingMode = null;
            map.getContainer().style.cursor = '';
            drawLayerGroup.clearLayers();
        }
    });
}

btnDraw.addEventListener('click', () => {
  drawingMode = filterType.value; drawLayerGroup.clearLayers(); filterGeometryData = null;
  btnApplyFilter.disabled = true; map.getContainer().style.cursor = 'crosshair'; drawStatus.classList.remove('hidden');
});

map.on('mousedown', (e) => {
  if (drawingMode === 'box' || drawingMode === 'inspect') { 
      drawLayerGroup.clearLayers(); map.dragging.disable(); drawStart = e.latlng; 
      const color = drawingMode === 'inspect' ? '#4f46e5' : '#0d9488'; 
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
    const radKm = parseFloat(filterRadius.value) || 5;
    tempShape = L.circle(drawStart, { radius: radKm * 1000, color: '#0d9488', weight: 2, fillOpacity: 0.2 }).addTo(drawLayerGroup);
    L.marker(drawStart).addTo(drawLayerGroup); filterGeometryData = drawStart; drawingMode = null; map.getContainer().style.cursor = ''; checkApplyButton();
  }
});

filterRadius.addEventListener('input', checkApplyButton);

filterType.addEventListener('change', (e) => {
  const type = e.target.value;
  const layer = activeLayers.find(l => l.uniqueKey === activeCropLayerKey);
  
  filterRadius.classList.add('hidden');
  filterDataContainer.classList.add('hidden');
  filterDataContainer.classList.remove('flex');
  btnDraw.classList.remove('hidden');
  drawStatus.classList.remove('hidden');
  
  if(type === 'radius') {
    filterRadius.classList.remove('hidden');
    drawStatus.textContent = 'Click on map to set center point.';
  } else if (type === 'box') {
    drawStatus.textContent = 'Click & drag on map to draw box.';
  } else if (type === 'data') {
    btnDraw.classList.add('hidden');
    filterDataContainer.classList.remove('hidden');
    filterDataContainer.classList.add('flex');
    if(layer) triggerDataFilterSetup(layer);
  }
  checkApplyButton();
});

filterDataCol.addEventListener('change', (e) => {
    const col = e.target.value;
    const layer = activeLayers.find(l => l.uniqueKey === activeCropLayerKey);
    if (!layer || !col) return;
    
    filterDataSearch.value = '';
    btnClearFilterSearch.classList.add('hidden');

    let uniqueVals = [...new Set(layer.geoJsonData.features.map(f => f.properties[col]))];
    uniqueVals = uniqueVals.filter(v => v !== null && v !== undefined).sort();

    if (uniqueVals.length === 0) {
        filterDataValues.innerHTML = '<p class="text-gray-400 dark:text-gray-500 italic text-center">No unique values found.</p>';
        return;
    }

    let html = '<div class="flex flex-col space-y-1">';
    uniqueVals.forEach(val => {
        html += `
            <label class="flex items-center space-x-2 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700 p-1 rounded transition-colors">
                <input type="checkbox" class="filter-data-val-cb w-3 h-3 text-teal-600 dark:text-teal-500 rounded accent-teal-600 dark:accent-teal-500" value="${val}">
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

document.getElementById('btn-filter-select-all').addEventListener('click', () => {
    const visibleLabels = Array.from(document.querySelectorAll('#filter-data-values label:not(.hidden)'));
    const cbs = visibleLabels.map(l => l.querySelector('.filter-data-val-cb'));
    if (cbs.length === 0) return;
    
    const allChecked = cbs.every(cb => cb.checked);
    cbs.forEach(cb => cb.checked = !allChecked); 
    checkApplyButton();
});

btnApplyFilter.addEventListener('click', async () => {
  const targetLayer = activeLayers.find(l => l.uniqueKey === activeCropLayerKey);
  if (!targetLayer) return;
  if (filterType.value !== 'data' && !targetLayer.exportUrl && !targetLayer.isLocalGeoJSON) return showToast("Cannot filter this layer from server.", true);

  document.getElementById('btn-filter-text').textContent = 'Filtering...';
  document.getElementById('btn-filter-spinner').classList.remove('hidden');
  btnApplyFilter.disabled = true;

  try {
    let finalFeatures = [];
    if (filterType.value === 'data') {
        const col = filterDataCol.value;
        const selectedVals = Array.from(document.querySelectorAll('.filter-data-val-cb:checked')).map(cb => cb.value);
        finalFeatures = targetLayer.geoJsonData.features.filter(f => selectedVals.includes(String(f.properties[col])));
    } else {
        if (targetLayer.isLocalGeoJSON) {
            let b; 
            if (filterType.value === 'box') {
               b = filterGeometryData;
               const turfBbox = turf.bboxPolygon([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
               finalFeatures = targetLayer.geoJsonData.features.filter(f => turf.booleanIntersects(f, turfBbox));
            } else {
               const radKm = parseFloat(filterRadius.value) || 5;
               const turfCircle = turf.circle([filterGeometryData.lng, filterGeometryData.lat], radKm, {units: 'kilometers'});
               finalFeatures = targetLayer.geoJsonData.features.filter(f => turf.booleanIntersects(f, turfCircle));
            }
        } else {
            let queryUrl = targetLayer.exportUrl;
            let b; 
            if (filterType.value === 'box') b = filterGeometryData; 
            else b = filterGeometryData.toBounds((parseFloat(filterRadius.value) || 5) * 1000); 

            if (queryUrl.includes('WFS') || queryUrl.includes('GetFeature')) queryUrl += `&bbox=${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()},EPSG:4326`;
            else queryUrl += `&geometry=${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}&geometryType=esriGeometryEnvelope&inSR=4326`;

            const res = await fetch(`/proxy?url=${encodeURIComponent(queryUrl)}`);
            const rawGeojson = await res.json();
            finalFeatures = rawGeojson.features || [];

            if (filterType.value === 'radius' && finalFeatures.length > 0) {
                const radKm = parseFloat(filterRadius.value) || 5;
                const turfCircle = turf.circle([filterGeometryData.lng, filterGeometryData.lat], radKm, {units: 'kilometers'});
                finalFeatures = finalFeatures.filter(f => { try { return turf.booleanIntersects(f, turfCircle); } catch(e) { return false; } });
            }
        }
    }

    if (finalFeatures.length === 0) { showToast("Filter resulted in 0 features.", true); return; }

    const newGeoJsonData = { type: "FeatureCollection", features: finalFeatures };
    const newStyleState = targetLayer.customStyle ? JSON.parse(JSON.stringify(targetLayer.customStyle)) : { type: 'single', fillColor: '#0d9488', fillOpacity: 0.5, color: '#0d9488', opacity: 1.0, pointShape: 'circle', pointSize: 8 };

    const uniqueKey = Math.random().toString(36).substr(2,9);
    const paneName = 'pane-' + uniqueKey;

    const newMapLayer = createCustomGeoJSONLayer(newGeoJsonData, newStyleState, paneName).addTo(map);
    map.fitBounds(newMapLayer.getBounds());

    const namePrefix = filterType.value === 'data' ? '[Filtered]' : '[Cropped]';
    activeLayers.unshift({ uniqueKey: uniqueKey, id: `${targetLayer.id}_filtered`, displayName: `${namePrefix} ${targetLayer.displayName}`, mapLayer: newMapLayer, exportUrl: null, isLocalGeoJSON: true, geoJsonData: newGeoJsonData, customStyle: newStyleState, isVisible: true });

    if (targetLayer.isVisible) { targetLayer.isVisible = false; map.removeLayer(targetLayer.mapLayer); }

    closeAllPanels(); renderAddedLayers(); updateMapLayerOrder();
    showToast(`Created new filtered layer with ${finalFeatures.length} features.`);

  } catch(err) {
    showToast("Filter failed. Server might restrict spatial queries.", true);
  } finally {
    document.getElementById('btn-filter-text').textContent = 'Apply'; document.getElementById('btn-filter-spinner').classList.add('hidden'); btnApplyFilter.disabled = false;
  }
});

document.getElementById('btn-fetch').addEventListener('click', async () => {
  currentServerType = document.getElementById('server-type').value;
  clearAllPreviews(); 
  document.getElementById('btn-fetch-spinner').classList.remove('hidden'); document.getElementById('btn-fetch-text').textContent = 'Fetching...';

  try {
    if (currentServerType === 'OVERPASS') {
        const key = document.getElementById('osm-key').value.trim();
        const val = document.getElementById('osm-value').value.trim();
        const featName = document.getElementById('osm-name').value.trim();
        const loc = document.getElementById('osm-location').value.trim();
        const geomType = document.getElementById('osm-geom').value;

        if (!key) throw new Error("Please enter a Tag Key.");

        let query = `[out:json][timeout:50];\n`;
        let tagFilter = val ? `["${key}"="${val}"]` : `["${key}"]`;
        if (featName) tagFilter += `["name"~"${featName}",i]`;

        if (loc) {
            document.getElementById('btn-fetch-text').textContent = 'Locating Area...';
            const nomRes = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(loc)}&format=json&limit=1`);
            const nomData = await nomRes.json();
            if (nomData.length === 0) throw new Error(`Could not find the location: "${loc}"`);
            
            document.getElementById('btn-fetch-text').textContent = 'Fetching Data...';
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
            geoJson.features.forEach(f => { const c = f.properties['addr:city'] || f.properties['is_in:city'] || f.properties['is_in:municipality']; if (c) cities[c] = (cities[c] || 0) + 1; });
            autoCity = Object.keys(cities).sort((a,b) => cities[b] - cities[a])[0];
        }

        if (loc && featName) layerName = `OSM: ${featName}, ${loc} (${key})`;
        else if (featName) layerName = `OSM: ${featName} (${key})`;
        else if (loc) layerName = `OSM: ${loc} (${key}${val ? '=' + val : ''})`;
        else if (geoJson.features.length === 1 && geoJson.features[0].properties.name) layerName = `OSM: ${geoJson.features[0].properties.name} (${key}${val ? '=' + val : ''})`;
        else if (autoCity) layerName = `OSM: ${autoCity} (${key}${val ? '=' + val : ''})`;
        else layerName = `OSM: Map View (${key}${val ? '=' + val : ''})`;

        fetchedLayers = [{ id: `osm_${Date.now()}`, title: layerName, geoJsonData: geoJson }];
        lastFetchedOsmGeoJson = geoJson; lastFetchedOsmLayerName = layerName;
        
        const toolsContainer = document.getElementById('osm-available-tools');
        toolsContainer.classList.remove('hidden'); toolsContainer.classList.add('flex');

        const cols = new Set();
        geoJson.features.forEach(f => { if(f.properties) Object.keys(f.properties).forEach(k => cols.add(k)); });
        
        const sel = document.getElementById('available-split-col');
        sel.innerHTML = '<option value="" disabled selected>Select attribute...</option>';
        Array.from(cols).sort().forEach(c => { sel.innerHTML += `<option value="${c}">${c}</option>`; });

        renderAvailableLayers(); switchTab('available'); showToast(`Fetched ${geoJson.features.length} OSM features for preview!`);
        return;
    }

    const rawUrl = document.getElementById('server-url').value.trim();
    if (!rawUrl) throw new Error("Enter URL.");
    currentServerUrl = rawUrl; fetchedLayers = []; layerSearch.value = ''; btnClearSearch.classList.add('hidden');
    document.getElementById('osm-available-tools').classList.add('hidden'); document.getElementById('osm-available-tools').classList.remove('flex');

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
    if (currentServerType !== 'OVERPASS') {
        availableLayerList.innerHTML = `<p class="text-sm text-red-500 dark:text-red-400 italic text-center mt-4">Failed to fetch. Check server URL.</p>`; searchContainer.classList.add('hidden');
    }
  } finally {
    document.getElementById('btn-fetch-spinner').classList.add('hidden'); document.getElementById('btn-fetch-text').textContent = currentServerType === 'OVERPASS' ? 'Fetch OSM Data' : 'Fetch Layers';
  }
});

// ==========================================
// 9. APP BOOTSTRAP
// ==========================================
loadSavedServers();

try {
    const savedSession = localStorage.getItem('gis_previewer_auto_save');
    if (savedSession) {
        const data = JSON.parse(savedSession);
        restoreWorkspaceState(data);
    }
} catch(e) {
    console.warn("Could not auto-restore previous workspace.", e);
}