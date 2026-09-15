import { AppState } from './state.js';
import { map } from './mapEngine.js';

export function createStyleEditorController(deps) {
    const { editPanelContainer, renderAddedLayers, ensureGeoJSON, closeSidebarPanels, openContextSubmenu, showToast, updateMapLayerOrder, createCustomGeoJSONLayer, handleToggleTable, autoSaveWorkspace, hexAlpha, darkenHex, interpolateColor, getEl } = deps;

    const normalizePickerHex = (value, fallback = '#2563eb') => {
        const raw = String(value || '').trim().replace(/^#/, '');
        if (/^(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(raw)) {
            if (raw.length === 3 || raw.length === 4) {
                return `#${raw.slice(0, 3).split('').map(character => character + character).join('')}`;
            }
            return `#${raw.slice(0, 6)}`;
        }

        if (typeof document !== 'undefined' && document.body) {
            const probe = document.createElement('span');
            probe.style.color = String(value || '');
            if (probe.style.color) {
                probe.style.position = 'fixed';
                probe.style.opacity = '0';
                document.body.appendChild(probe);
                const computed = getComputedStyle(probe).color;
                probe.remove();
                const channels = computed.match(/rgba?\(([^)]+)\)/i)?.[1]?.split(',').slice(0, 3).map(channel => {
                    const trimmed = channel.trim();
                    const numeric = parseFloat(trimmed);
                    return trimmed.endsWith('%') ? numeric * 2.55 : numeric;
                });
                if (channels?.length === 3 && channels.every(Number.isFinite)) {
                    return `#${channels.map(channel => Math.round(Math.max(0, Math.min(255, channel))).toString(16).padStart(2, '0')).join('')}`;
                }
            }
        }
        return fallback;
    };

    const contrastBorderForRgb = rgb => {
        const r = Array.isArray(rgb) ? rgb[0] : rgb?.r;
        const g = Array.isArray(rgb) ? rgb[1] : rgb?.g;
        const b = Array.isArray(rgb) ? rgb[2] : rgb?.b;
        const luminance = (0.2126 * Number(r || 0) + 0.7152 * Number(g || 0) + 0.0722 * Number(b || 0)) / 255;
        return luminance > 0.55 ? 'rgba(0, 0, 0, 0.5)' : 'rgba(255, 255, 255, 0.5)';
    };

    // Global array to track Pickr instances so we can destroy them to prevent memory leaks
    window.activePickrs = window.activePickrs || [];
    
    const ensurePickrLoaded = () => {
        return new Promise((resolve) => {
            if (typeof Pickr !== 'undefined') return resolve(true);
            
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = 'https://cdn.jsdelivr.net/npm/@simonwep/pickr/dist/themes/nano.min.css';
            document.head.appendChild(link);
    
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/@simonwep/pickr/dist/pickr.min.js';
            script.onload = () => resolve(true);
            script.onerror = () => {
                console.error("Failed to load Pickr from CDN");
                resolve(false);
            };
            document.head.appendChild(script);
        });
    };
    
    const handleToggleEdit = async (e, forceStyle = null) => {
        const key = typeof e === 'string' ? e : (e.currentTarget ? e.currentTarget.getAttribute('data-key') : e);
        const layer = AppState.activeLayers.find(l => l.uniqueKey === key);
        if (!layer || layer.isFolder) return;
    
        if (AppState.activeEditLayerKey === key && e && e.currentTarget) { closeSidebarPanels(); return; }
    
        closeSidebarPanels();
        openContextSubmenu();
        editPanelContainer?.classList.remove('hidden');
        editPanelContainer?.classList.add('flex');
        if (editPanelContainer) editPanelContainer.innerHTML = '<div class="flex justify-center p-3"><p class="text-xs italic animate-pulse">Preparing editable vector data...</p></div>';
        
        window.activePickrs.forEach(p => { try { p.destroy(); } catch(err){} });
        window.activePickrs = [];
    
        AppState.activeEditLayerKey = key;
        renderAddedLayers();
        if (!editPanelContainer) return;
        
        const [success, pickrLoaded] = await Promise.all([
            ensureGeoJSON(layer),
            ensurePickrLoaded()
        ]);
        
        if (!success) { closeSidebarPanels(); return; }
        if (!pickrLoaded) showToast("Color picker library failed to load.", true);
    
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
        const useDataScale = cs.usePointScaleData || false;
        const activeScaleType = useDataScale ? 'data' : 'single';
        
        const currentScaleCurve = cs.pointScaleCurve || 'linear';
        const currentGradCurve = cs.graduatedCurve || 'linear';
    
        const minFOp = cs.graduatedMinFillOpacity ?? (cs.graduatedFillOpacity ?? 0.7);
        const maxFOp = cs.graduatedMaxFillOpacity ?? (cs.graduatedFillOpacity ?? 0.7);
        const minSOp = cs.graduatedMinStrokeOpacity ?? (cs.graduatedStrokeOpacity ?? 1.0);
        const maxSOp = cs.graduatedMaxStrokeOpacity ?? (cs.graduatedStrokeOpacity ?? 1.0);
    
        const pasteDisabled = AppState.copiedStyle ? '' : 'disabled';
        const pasteOpacity = AppState.copiedStyle ? '' : 'opacity-50 cursor-not-allowed';
    
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
                
                <div class="flex-1 min-h-0 flex flex-col overflow-y-auto custom-scroll pr-1 pb-1 space-y-3">
                    
                    <!-- 1. SHAPE BLOCK -->
                    ${hasPoints ? `
                    <div class="border border-blue-200 dark:border-gray-700 bg-white dark:bg-gray-800 rounded p-2 shrink-0 shadow-xs">
                        <div class="flex items-center space-x-2">
                            <label class="text-[11px] font-bold text-gray-700 dark:text-gray-300 w-20 shrink-0">Shape Type:</label>
                            <select id="edit-point-shape" class="flex-1 border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-white rounded px-2 py-1 text-xs focus:ring-1 focus:ring-blue-500 font-medium">
                                <option value="circle" ${cs.pointShape === 'circle' ? 'selected' : ''}>Circle</option>
                                <option value="square" ${cs.pointShape === 'square' ? 'selected' : ''}>Square</option>
                                <option value="triangle" ${cs.pointShape === 'triangle' ? 'selected' : ''}>Triangle</option>
                            </select>
                        </div>
                    </div>
                    ` : ''}
    
                    <!-- 2. COLOUR BLOCK -->
                    <div class="border border-blue-200 dark:border-gray-700 bg-white dark:bg-gray-800 rounded p-2 flex flex-col shrink-0 shadow-xs">
                        <div class="flex items-center space-x-2 mb-2 pb-2 border-b border-gray-100 dark:border-gray-700 shrink-0">
                            <label class="text-[11px] font-bold text-gray-700 dark:text-gray-300 w-20 shrink-0">Colour Type:</label>
                            <select id="edit-style-type" class="flex-1 border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-white rounded px-2 py-1 text-xs focus:ring-1 focus:ring-blue-500 font-medium">
                                <option value="single" ${activeStyleType === 'single' ? 'selected' : ''}>Single Value</option>
                                <option value="categorical" ${activeStyleType === 'categorical' ? 'selected' : ''}>Category</option>
                                <option value="graduated" ${activeStyleType === 'graduated' ? 'selected' : ''}>Choropleth</option>
                            </select>
                        </div>
    
                        <!-- Single Colour UI -->
                        <div id="single-style-container" class="${activeStyleType === 'single' ? 'flex' : 'hidden'} items-center justify-center space-x-6 py-2">
                            <div class="flex items-center space-x-2">
                                <label class="text-[11px] text-gray-600 dark:text-gray-400 font-bold">Fill:</label>
                                <div id="edit-fill-wrapper" class="color-picker-wrapper w-6 h-6 rounded shadow-sm" data-hex="${cs.fillColor || '#2563eb'}" data-opacity="${cs.fillOpacity ?? 0.5}"></div>
                            </div>
                            <div class="flex items-center space-x-2">
                                <label class="text-[11px] text-gray-600 dark:text-gray-400 font-bold">Outline:</label>
                                <div id="edit-stroke-wrapper" class="color-picker-wrapper w-6 h-6 rounded shadow-sm" data-hex="${cs.color || '#2563eb'}" data-opacity="${cs.opacity ?? 1.0}"></div>
                            </div>
                        </div>
    
                        <!-- Categorical Colour UI -->
                        <div id="categorical-style-container" class="${activeStyleType === 'categorical' ? 'flex' : 'hidden'} flex-col flex-1 min-h-0">
                            <div class="flex items-center space-x-2 mb-1 shrink-0">
                                <label class="text-[9px] font-bold text-gray-500 dark:text-gray-400 uppercase w-12 shrink-0">Column:</label>
                                <select id="cat-col-select" class="flex-1 border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-white rounded px-1.5 py-0.5 text-xs">
                                    <option value="" disabled ${!cs.property ? 'selected' : ''}>Select attribute...</option>
                                    ${cols.map(c => `<option value="${c}" ${(activeStyleType === 'categorical' && cs.property === c) ? 'selected' : ''}>${c}</option>`).join('')}
                                </select>
                            </div>
                            <div id="cat-inner-list" class="flex-1 overflow-y-auto custom-scroll -mx-1 px-1">
                                <p class="text-[10px] text-gray-400 dark:text-gray-500 italic text-center py-2 mt-2">Select a column to generate categories.</p>
                            </div>
                        </div>
    
                        <!-- Choropleth Colour UI -->
                        <div id="graduated-style-container" class="${activeStyleType === 'graduated' ? 'flex' : 'hidden'} flex-col flex-1 min-h-0">
                            <div class="flex items-center space-x-2 mb-2 shrink-0">
                                <label class="text-[9px] font-bold text-gray-500 dark:text-gray-400 uppercase w-12 shrink-0">Column:</label>
                                <select id="graduated-col-select" class="flex-1 border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-white rounded px-1.5 py-0.5 text-xs">
                                    <option value="" disabled ${!cs.property ? 'selected' : ''}>Select numeric attribute...</option>
                                    ${numericCols.map(c => `<option value="${c}" ${(activeStyleType === 'graduated' && cs.property === c) ? 'selected' : ''}>${c}</option>`).join('')}
                                </select>
                            </div>
                            
                            <div class="flex-1 overflow-y-auto custom-scroll space-y-2">
                                <!-- Low Row -->
                                <div class="flex items-center justify-between pb-1.5 border-b border-gray-100 dark:border-gray-700/50">
                                    <div class="flex items-center space-x-1 flex-1 pr-1 overflow-hidden">
                                        <span class="text-[11px] font-bold text-gray-800 dark:text-gray-200 uppercase shrink-0">LOW:</span>
                                        <input type="text" id="graduated-min-val" readonly value="${cs.graduatedMinVal ?? '0'}" class="w-full bg-transparent font-mono text-[11px] text-gray-500 dark:text-gray-400 truncate">
                                    </div>
                                    <div class="flex space-x-3 items-center shrink-0">
                                        <div class="flex items-center space-x-1.5">
                                            <span class="text-[9px] text-gray-500 dark:text-gray-400 font-bold uppercase">Fill:</span>
                                            <div id="graduated-min-fill-wrapper" class="color-picker-wrapper w-5 h-5 rounded shrink-0 shadow-sm" data-hex="${cs.graduatedMinColor || '#ffeda0'}" data-opacity="${minFOp}"></div>
                                        </div>
                                        <div class="flex items-center space-x-1.5 border-l border-gray-200 dark:border-gray-600 pl-3">
                                            <span class="text-[9px] text-gray-500 dark:text-gray-400 font-bold uppercase">Outline:</span>
                                            <div id="graduated-min-stroke-wrapper" class="color-picker-wrapper w-5 h-5 rounded shrink-0 shadow-sm" data-hex="${cs.graduatedMinStroke || '#feb24c'}" data-opacity="${minSOp}"></div>
                                        </div>
                                    </div>
                                </div>
    
                                <!-- High Row -->
                                <div class="flex items-center justify-between pb-1 border-b border-gray-100 dark:border-gray-700/50">
                                    <div class="flex items-center space-x-1 flex-1 pr-1 overflow-hidden">
                                        <span class="text-[11px] font-bold text-gray-800 dark:text-gray-200 uppercase shrink-0">HIGH:</span>
                                        <input type="text" id="graduated-max-val" readonly value="${cs.graduatedMaxVal ?? '99'}" class="w-full bg-transparent font-mono text-[11px] text-gray-500 dark:text-gray-400 truncate">
                                    </div>
                                    <div class="flex space-x-3 items-center shrink-0">
                                        <div class="flex items-center space-x-1.5">
                                            <span class="text-[9px] text-gray-500 dark:text-gray-400 font-bold uppercase">Fill:</span>
                                            <div id="graduated-max-fill-wrapper" class="color-picker-wrapper w-5 h-5 rounded shrink-0 shadow-sm" data-hex="${cs.graduatedMaxColor || '#f03b20'}" data-opacity="${maxFOp}"></div>
                                        </div>
                                        <div class="flex items-center space-x-1.5 border-l border-gray-200 dark:border-gray-600 pl-3">
                                            <span class="text-[9px] text-gray-500 dark:text-gray-400 font-bold uppercase">Outline:</span>
                                            <div id="graduated-max-stroke-wrapper" class="color-picker-wrapper w-5 h-5 rounded shrink-0 shadow-sm" data-hex="${cs.graduatedMaxStroke || '#bd0026'}" data-opacity="${maxSOp}"></div>
                                        </div>
                                    </div>
                                </div>
                                
                                <!-- Graduated Curve -->
                                <div class="pt-1">
                                    <label class="block text-[9px] font-bold text-gray-500 uppercase tracking-wide mb-1">Gradient Curve Weighting</label>
                                    <div class="grid grid-cols-4 gap-1.5">
                                        <button type="button" class="btn-grad-curve-type flex items-center justify-center text-[10px] py-1 border rounded font-semibold transition-colors ${currentGradCurve === 'linear' ? 'bg-blue-600 text-white border-blue-600 shadow-inner' : 'bg-gray-50 dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-600'}" data-curve="linear">
                                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="w-3 h-3 mr-1 shrink-0"><path d="M4 20 L20 4"/></svg>Linear
                                        </button>
                                        <button type="button" class="btn-grad-curve-type flex items-center justify-center text-[10px] py-1 border rounded font-semibold transition-colors ${currentGradCurve === 'exp' ? 'bg-blue-600 text-white border-blue-600 shadow-inner' : 'bg-gray-50 dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-600'}" data-curve="exp">
                                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="w-3 h-3 mr-1 shrink-0"><path d="M4 20 Q 16 20, 20 4"/></svg>Exp
                                        </button>
                                        <button type="button" class="btn-grad-curve-type flex items-center justify-center text-[10px] py-1 border rounded font-semibold transition-colors ${currentGradCurve === 'log' ? 'bg-blue-600 text-white border-blue-600 shadow-inner' : 'bg-gray-50 dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-600'}" data-curve="log">
                                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="w-3 h-3 mr-1 shrink-0"><path d="M4 20 Q 4 8, 20 4"/></svg>Log
                                        </button>
                                        <button type="button" class="btn-grad-curve-type flex items-center justify-center text-[10px] py-1 border rounded font-semibold transition-colors ${currentGradCurve === 'sigmoid' ? 'bg-blue-600 text-white border-blue-600 shadow-inner' : 'bg-gray-50 dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-600'}" data-curve="sigmoid">
                                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="w-3 h-3 mr-1 shrink-0"><path d="M4 20 C 12 20, 12 4, 20 4"/></svg>Sigmoid
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
    
                    <!-- 3. SCALE BLOCK -->
                    ${hasPoints ? `
                    <div class="border border-blue-200 dark:border-gray-700 bg-white dark:bg-gray-800 rounded p-2 flex flex-col shrink-0 shadow-xs">
                        <div class="flex items-center space-x-2 mb-2 pb-2 border-b border-gray-100 dark:border-gray-700 shrink-0">
                            <label class="text-[11px] font-bold text-gray-700 dark:text-gray-300 w-20 shrink-0">Scale Type:</label>
                            <select id="edit-scale-type" class="flex-1 border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-white rounded px-2 py-1 text-xs focus:ring-1 focus:ring-blue-500 font-medium">
                                <option value="single" ${activeScaleType === 'single' ? 'selected' : ''}>Single Value</option>
                                <option value="data" ${activeScaleType === 'data' ? 'selected' : ''}>Table Data</option>
                            </select>
                        </div>
    
                        <!-- Single Scale UI -->
                        <div id="constant-scale-container" class="${activeScaleType === 'single' ? 'flex' : 'hidden'} items-center space-x-3 w-full py-2 px-1">
                            <label class="text-[11px] text-gray-600 dark:text-gray-400 font-bold w-10 shrink-0">Size:</label>
                            <input type="range" id="edit-point-size" min="2" max="30" step="1" value="${cs.pointSize || 8}" class="flex-1 cursor-pointer accent-blue-600 dark:accent-blue-500">
                            <span id="point-size-display" class="text-[11px] font-mono font-bold w-6 text-center text-gray-700 dark:text-gray-200 bg-gray-100 dark:bg-gray-900 py-1 rounded">${cs.pointSize || 8}</span>
                        </div>
    
                        <!-- Table Data Scale UI -->
                        <div id="data-scale-container" class="${activeScaleType === 'data' ? 'flex' : 'hidden'} flex-col flex-1 min-h-0">
                            <div class="flex items-center space-x-2 mb-2 shrink-0">
                                <label class="text-[9px] font-bold text-gray-500 dark:text-gray-400 uppercase w-12 shrink-0">Column:</label>
                                <select id="point-scale-col-select" class="flex-1 border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-white rounded px-1.5 py-0.5 text-xs">
                                    <option value="" disabled ${!cs.pointScaleProp ? 'selected' : ''}>Select numeric attribute...</option>
                                    ${numericCols.map(c => `<option value="${c}" ${(useDataScale && cs.pointScaleProp === c) ? 'selected' : ''}>${c}</option>`).join('')}
                                </select>
                            </div>
    
                            <div class="flex-1 overflow-y-auto custom-scroll space-y-2">
                                <!-- Low Scale Row -->
                                <div class="flex items-center justify-between pb-1 border-b border-gray-100 dark:border-gray-700/50">
                                    <div class="flex items-center space-x-1 flex-1 pr-1 overflow-hidden">
                                        <span class="text-[11px] font-bold text-gray-800 dark:text-gray-200 uppercase shrink-0">LOW:</span>
                                        <input type="text" id="point-scale-min-data" readonly value="${cs.pointScaleMinData ?? '0'}" class="w-full bg-transparent font-mono text-[11px] text-gray-500 dark:text-gray-400 truncate">
                                    </div>
                                    <div class="flex items-center space-x-2 shrink-0">
                                        <label class="text-[10px] font-bold text-blue-600 dark:text-blue-400 uppercase tracking-wide">MIN SIZE:</label>
                                        <input type="number" id="point-scale-min-target" min="1" max="50" value="${cs.pointScaleMinTarget ?? 4}" class="w-12 px-1.5 py-0.5 bg-gray-50 dark:bg-gray-900 border border-blue-400 dark:border-blue-600 rounded text-gray-900 dark:text-white font-mono text-[11px] text-center focus:ring-1 focus:ring-blue-500">
                                    </div>
                                </div>
    
                                <!-- High Scale Row -->
                                <div class="flex items-center justify-between pb-1 border-b border-gray-100 dark:border-gray-700/50">
                                    <div class="flex items-center space-x-1 flex-1 pr-1 overflow-hidden">
                                        <span class="text-[11px] font-bold text-gray-800 dark:text-gray-200 uppercase shrink-0">HIGH:</span>
                                        <input type="text" id="point-scale-max-data" readonly value="${cs.pointScaleMaxData ?? '99'}" class="w-full bg-transparent font-mono text-[11px] text-gray-500 dark:text-gray-400 truncate">
                                    </div>
                                    <div class="flex items-center space-x-2 shrink-0">
                                        <label class="text-[10px] font-bold text-blue-600 dark:text-blue-400 uppercase tracking-wide">MAX SIZE:</label>
                                        <input type="number" id="point-scale-max-target" min="1" max="100" value="${cs.pointScaleMaxTarget ?? 24}" class="w-12 px-1.5 py-0.5 bg-gray-50 dark:bg-gray-900 border border-blue-400 dark:border-blue-600 rounded text-gray-900 dark:text-white font-mono text-[11px] text-center focus:ring-1 focus:ring-blue-500">
                                    </div>
                                </div>
    
                                <!-- Scale Curve -->
                                <div class="pt-1">
                                    <label class="block text-[9px] font-bold text-gray-500 uppercase tracking-wide mb-1">Gradient Curve Weighting</label>
                                    <div class="grid grid-cols-4 gap-1.5">
                                        <button type="button" class="btn-curve-type flex items-center justify-center text-[10px] py-1 border rounded font-semibold transition-colors ${currentScaleCurve === 'linear' ? 'bg-blue-600 text-white border-blue-600 shadow-inner' : 'bg-gray-50 dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-600'}" data-curve="linear">
                                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="w-3 h-3 mr-1 shrink-0"><path d="M4 20 L20 4"/></svg>Linear
                                        </button>
                                        <button type="button" class="btn-curve-type flex items-center justify-center text-[10px] py-1 border rounded font-semibold transition-colors ${currentScaleCurve === 'exp' ? 'bg-blue-600 text-white border-blue-600 shadow-inner' : 'bg-gray-50 dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-600'}" data-curve="exp">
                                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="w-3 h-3 mr-1 shrink-0"><path d="M4 20 Q 16 20, 20 4"/></svg>Exp
                                        </button>
                                        <button type="button" class="btn-curve-type flex items-center justify-center text-[10px] py-1 border rounded font-semibold transition-colors ${currentScaleCurve === 'log' ? 'bg-blue-600 text-white border-blue-600 shadow-inner' : 'bg-gray-50 dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-600'}" data-curve="log">
                                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="w-3 h-3 mr-1 shrink-0"><path d="M4 20 Q 4 8, 20 4"/></svg>Log
                                        </button>
                                        <button type="button" class="btn-curve-type flex items-center justify-center text-[10px] py-1 border rounded font-semibold transition-colors ${currentScaleCurve === 'sigmoid' ? 'bg-blue-600 text-white border-blue-600 shadow-inner' : 'bg-gray-50 dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-600'}" data-curve="sigmoid">
                                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="w-3 h-3 mr-1 shrink-0"><path d="M4 20 C 12 20, 12 4, 20 4"/></svg>Sigmoid
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                    ` : ''}
    
                </div> <!-- END FLEX BODY -->
    
                <!-- FOOTER -->
                <div class="flex justify-between items-center pt-2 pb-1 border-t border-blue-100 dark:border-blue-800 shrink-0 mt-2 bg-blue-50 dark:bg-gray-900 relative z-10">
                    <div class="flex space-x-1.5 items-center">
                    <button id="btn-repair-shape" class="bg-amber-100 dark:bg-amber-900/40 hover:bg-amber-200 dark:hover:bg-amber-900/60 text-amber-800 dark:text-amber-200 text-[10px] px-2 py-1 rounded transition-colors font-medium border border-amber-300 dark:border-amber-700" title="Create a repaired working copy of invalid polygon geometry. The original server data is preserved.">
                        <i class="fa-solid fa-wand-magic-sparkles mr-1"></i>Repair Shape
                    </button>
                    <button id="btn-bake-colors" class="bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 text-[10px] px-2 py-1 rounded transition-colors font-medium border border-gray-300 dark:border-gray-600">
                        <i class="fa-solid fa-database mr-1"></i>Bake to Table
                    </button>
                    </div>
                    <div class="flex space-x-1.5 items-center">
                        <button id="btn-refresh-colors" class="${activeStyleType === 'categorical' ? '' : 'hidden'} bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 text-[10px] px-2 py-1 rounded transition-colors font-medium border border-gray-300 dark:border-gray-600">
                            <i class="fa-solid fa-arrows-rotate mr-1"></i> Refresh
                        </button>
                        <button id="btn-apply-edit" class="bg-blue-600 hover:bg-blue-700 text-white text-xs px-4 py-1.5 rounded transition-colors font-semibold shadow-md">Apply Style</button>
                    </div>
                </div>
            </div>
        `;
    
        const initPickrs = (container) => {
            if (typeof Pickr === 'undefined') return console.error("Pickr failed to initialize!");
            
            container.querySelectorAll('.color-picker-wrapper').forEach(wrapper => {
                if (wrapper.dataset.initialized) return; 
                wrapper.dataset.initialized = "true";
    
                const initialHex = normalizePickerHex(wrapper.getAttribute('data-hex'));
                const initialOp = parseFloat(wrapper.getAttribute('data-opacity') || 1.0);
                const initialColor = hexAlpha(initialHex, initialOp);
                const initialRgb = {
                    r: parseInt(initialHex.slice(1, 3), 16),
                    g: parseInt(initialHex.slice(3, 5), 16),
                    b: parseInt(initialHex.slice(5, 7), 16),
                    a: initialOp
                };

                // Pickr's button paints its preview in a pseudo-element whose
                // built-in dimensions do not reliably follow our compact
                // wrapper. Render the swatch ourselves so its fill always
                // occupies the exact same box as the border.
                wrapper.style.position = 'relative';
                wrapper.style.boxSizing = 'border-box';
                wrapper.style.overflow = 'hidden';
                wrapper.style.backgroundColor = '#ffffff';
                const checkerboard = [
                    'linear-gradient(45deg, #94a3b8 25%, transparent 25%)',
                    'linear-gradient(-45deg, #94a3b8 25%, transparent 25%)',
                    'linear-gradient(45deg, transparent 75%, #94a3b8 75%)',
                    'linear-gradient(-45deg, transparent 75%, #94a3b8 75%)'
                ].join(',');
                wrapper.style.backgroundSize = '8px 8px';
                wrapper.style.backgroundPosition = '0 0, 0 4px, 4px -4px, -4px 0';

                const swatchFill = document.createElement('span');
                swatchFill.setAttribute('aria-hidden', 'true');
                swatchFill.style.position = 'absolute';
                swatchFill.style.inset = '0';
                swatchFill.style.display = 'block';
                swatchFill.style.borderRadius = 'inherit';
                swatchFill.style.pointerEvents = 'none';
                swatchFill.style.zIndex = '0';
                wrapper.appendChild(swatchFill);
                
                const targetEl = document.createElement('div');
                targetEl.style.position = 'absolute';
                targetEl.style.inset = '0';
                wrapper.appendChild(targetEl);
                
                const p = Pickr.create({
                    el: targetEl,
                    theme: 'nano',
                    default: initialColor,
                    position: 'left-middle',
                    components: {
                        preview: true,
                        opacity: true,
                        hue: true,
                        // The web app's Apply Style button is the single
                        // commit action; Pickr's separate Save button only
                        // added an unnecessary extra click.
                        interaction: { input: true, save: false }
                    }
                });
                // Keep the visible swatch synchronized even when Pickr starts
                // with a persisted 8-digit color value.
                p.setColor(initialColor, true);
                const preview = wrapper.querySelector('.pcr-button');
                const syncPreview = color => {
                    const previewColor = color?.toHEXA?.().toString() || initialColor;
                    const rgba = color?.toRGBA?.() || initialRgb;
                    const contrastBorder = contrastBorderForRgb(rgba);
                    const alpha = Array.isArray(rgba) ? rgba[3] : (rgba?.a ?? initialOp);
                    swatchFill.style.backgroundColor = previewColor;
                    // Only transparent colours need a checkerboard. In
                    // particular, an opaque outline must remain a solid colour.
                    wrapper.style.backgroundImage = alpha < 0.999 ? checkerboard : 'none';
                    if (preview) {
                        preview.style.position = 'absolute';
                        preview.style.inset = '0';
                        preview.style.display = 'block';
                        preview.style.margin = '0';
                        preview.style.width = '100%';
                        preview.style.height = '100%';
                        preview.style.opacity = '0';
                        preview.style.zIndex = '1';
                        preview.style.cursor = 'pointer';
                        preview.style.pointerEvents = 'none';
                    }
                    wrapper.style.border = `1px solid ${contrastBorder}`;
                };
                syncPreview({
                    toHEXA: () => ({ toString: () => initialColor }),
                    toRGBA: () => initialRgb
                });

                // The generated Pickr button has theme-specific pseudo-element
                // sizing, so use the aligned wrapper as the click target.
                wrapper.setAttribute('role', 'button');
                wrapper.setAttribute('tabindex', '0');
                wrapper.style.cursor = 'pointer';
                wrapper.addEventListener('click', event => {
                    event.preventDefault();
                    p.show();
                });
                wrapper.addEventListener('keydown', event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        p.show();
                    }
                });
                
                p.on('save', (color, instance) => {
                    const rgba = color.toRGBA();
                    wrapper.setAttribute('data-hex', color.toHEXA().toString().slice(0, 7));
                    wrapper.setAttribute('data-opacity', rgba[3].toFixed(2));
                    syncPreview(color);
                    instance.hide();
                }).on('change', (color) => {
                    const rgba = color.toRGBA();
                    wrapper.setAttribute('data-hex', color.toHEXA().toString().slice(0, 7));
                    wrapper.setAttribute('data-opacity', rgba[3].toFixed(2));
                    syncPreview(color);
                });
                
                wrapper.pickrInstance = p;
                window.activePickrs.push(p);
            });
        };
    
        initPickrs(editPanelContainer);

        getEl('btn-repair-shape')?.addEventListener('click', async (e) => {
            e.preventDefault();
            const button = e.currentTarget;
            if (!layer.geoJsonData?.features?.length) return showToast('There is no vector geometry to repair.', true);
            const original = JSON.parse(JSON.stringify(layer.geoJsonData));
            button.disabled = true;
            button.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i>Repairing...';
            try {
                const response = await fetch('/api/geometry/repair', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ geojson: original })
                });
                const repaired = await response.json();
                if (!response.ok) throw new Error(repaired.error || 'The shape could not be repaired.');
                if (!layer.originalGeoJsonData) layer.originalGeoJsonData = original;
                layer.geoJsonData = repaired;
                map.removeLayer(layer.mapLayer);
                const paneName = 'pane-' + layer.uniqueKey;
                const existingPane = map.getPane(paneName);
                if (existingPane) existingPane.innerHTML = '';
                const newMapLayer = createCustomGeoJSONLayer(layer.geoJsonData, layer.customStyle || cs, paneName);
                if (layer.isVisible) newMapLayer.addTo(map);
                layer.mapLayer = newMapLayer;
                updateMapLayerOrder();
                autoSaveWorkspace();
                const count = repaired.metadata?.repaired_geometry_count || 0;
                showToast(count ? `Repaired ${count} shape${count === 1 ? '' : 's'} in this working layer.` : 'No invalid polygon geometry was found.');
                handleToggleEdit(key, layer.customStyle || cs);
            } catch (error) {
                showToast(error.message || 'The shape could not be repaired.', true);
                button.disabled = false;
                button.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles mr-1"></i>Repair Shape';
            }
        });
    
        let activeScaleCurve = currentScaleCurve;
        let activeGradCurve = currentGradCurve;
    
        const getPickerData = (selector, context = document) => {
            const el = context.querySelector(selector);
            if (!el) return { hex: '#2563eb', opacity: 0.5 };
            return {
                hex: el.getAttribute('data-hex') || '#2563eb',
                opacity: parseFloat(el.getAttribute('data-opacity') || 0.5)
            };
        };
    
        const extractStyleFromUI = () => {
            const shapeEl = getEl('edit-point-shape');
            const sizeEl = getEl('edit-point-size');
            const pShape = shapeEl ? shapeEl.value : (layer.customStyle?.pointShape || 'circle');
            const pSize = sizeEl ? parseInt(sizeEl.value, 10) : (layer.customStyle?.pointSize || 8);
    
            const scaleTypeSel = getEl('edit-scale-type');
            const isScaleData = scaleTypeSel ? (scaleTypeSel.value === 'data') : false;
            
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
                    const fillData = getPickerData('.cat-fill-wrapper', row);
                    const strokeData = getPickerData('.cat-stroke-wrapper', row);
    
                    newCategories[val] = { 
                        fillColor: fillData.hex, 
                        fillOpacity: fillData.opacity, 
                        color: strokeData.hex, 
                        opacity: strokeData.opacity 
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
                
                const minFill = getPickerData('#graduated-min-fill-wrapper');
                const minStroke = getPickerData('#graduated-min-stroke-wrapper');
                const maxFill = getPickerData('#graduated-max-fill-wrapper');
                const maxStroke = getPickerData('#graduated-max-stroke-wrapper');
    
                return {
                    type: 'graduated', property: prop,
                    graduatedMinVal: isNaN(minData) ? 0 : minData,
                    graduatedMaxVal: isNaN(maxData) ? 1 : maxData,
                    graduatedMinColor: minFill.hex,
                    graduatedMaxColor: maxFill.hex,
                    graduatedMinStroke: minStroke.hex,
                    graduatedMaxStroke: maxStroke.hex,
                    graduatedMinFillOpacity: minFill.opacity,
                    graduatedMaxFillOpacity: maxFill.opacity,
                    graduatedMinStrokeOpacity: minStroke.opacity,
                    graduatedMaxStrokeOpacity: maxStroke.opacity,
                    graduatedCurve: activeGradCurve || 'linear',
                    pointShape: pShape, pointSize: pSize,
                    ...scaleStateObj
                };
            } else {
                const fillData = getPickerData('#edit-fill-wrapper');
                const strokeData = getPickerData('#edit-stroke-wrapper');
                return { 
                    type: 'single', 
                    fillColor: fillData.hex, 
                    fillOpacity: fillData.opacity, 
                    color: strokeData.hex, 
                    opacity: strokeData.opacity, 
                    pointShape: pShape, pointSize: pSize,
                    ...scaleStateObj 
                }; 
            }
        };
    
        if (hasPoints) {
            const scaleTypeSelect = getEl('edit-scale-type');
            const constantScaleContainer = getEl('constant-scale-container');
            const dataScaleContainer = getEl('data-scale-container');
            const pointScaleColSelect = getEl('point-scale-col-select');
            const inputMinData = getEl('point-scale-min-data');
            const inputMaxData = getEl('point-scale-max-data');
    
            getEl('edit-point-size')?.addEventListener('input', (e) => {
                const disp = getEl('point-size-display');
                if (disp) disp.textContent = e.target.value;
            });
    
            scaleTypeSelect?.addEventListener('change', (e) => {
                if (e.target.value === 'data') {
                    constantScaleContainer?.classList.replace('flex', 'hidden');
                    dataScaleContainer?.classList.replace('hidden', 'flex');
                } else {
                    constantScaleContainer?.classList.replace('hidden', 'flex');
                    dataScaleContainer?.classList.replace('flex', 'hidden');
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
                        b.className = 'btn-curve-type flex items-center justify-center text-[10px] py-1 border rounded font-semibold transition-colors bg-gray-50 dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-600';
                    });
                    e.currentTarget.className = 'btn-curve-type flex items-center justify-center text-[10px] py-1 border rounded font-semibold transition-colors bg-blue-600 text-white border-blue-600 shadow-inner';
                    activeScaleCurve = e.currentTarget.getAttribute('data-curve');
                });
            });
        }
    
        document.querySelectorAll('.btn-grad-curve-type').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.btn-grad-curve-type').forEach(b => {
                    b.className = 'btn-grad-curve-type flex items-center justify-center text-[10px] py-1 border rounded font-semibold transition-colors bg-gray-50 dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-600';
                });
                e.currentTarget.className = 'btn-grad-curve-type flex items-center justify-center text-[10px] py-1 border rounded font-semibold transition-colors bg-blue-600 text-white border-blue-600 shadow-inner';
                activeGradCurve = e.currentTarget.getAttribute('data-curve');
            });
        });
    
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
            if (uniqueVals.length === 0) { catInnerList.innerHTML = '<p class="text-[10px] text-gray-400 dark:text-gray-500 italic text-center py-2 mt-2">No unique values.</p>'; return; }
    
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
                    <div class="flex items-center justify-between py-1.5 border-b border-gray-100 dark:border-gray-700/50 last:border-0 cat-row" data-val="${val}">
                        <span class="text-[11px] text-gray-700 dark:text-gray-300 font-medium truncate flex-1 pr-1" title="${val}">${val}</span>
                        <div class="flex space-x-3 items-center shrink-0">
                            <div class="flex items-center space-x-1.5">
                                <span class="text-[9px] text-gray-500 dark:text-gray-400 font-bold uppercase">Fill:</span>
                                <div class="color-picker-wrapper cat-fill-wrapper w-5 h-5 rounded shrink-0 shadow-sm" data-hex="${fCol}" data-opacity="${fOp}"></div>
                            </div>
                            <div class="flex items-center space-x-1.5 border-l border-gray-200 dark:border-gray-600 pl-3">
                                <span class="text-[9px] text-gray-500 dark:text-gray-400 font-bold uppercase">Outline:</span>
                                <div class="color-picker-wrapper cat-stroke-wrapper w-5 h-5 rounded shrink-0 shadow-sm" data-hex="${sCol}" data-opacity="${sOp}"></div>
                            </div>
                        </div>
                    </div>
                `;
            });
            catInnerList.innerHTML = html;
            initPickrs(catInnerList);
        };
    
        catColSelect?.addEventListener('change', renderCategoryPickers);
        if (activeStyleType === 'categorical' && cs.property) renderCategoryPickers();
    
        btnRefreshColors?.addEventListener('click', () => {
            document.querySelectorAll('.cat-row').forEach(row => {
                const newFill = '#' + Math.floor(Math.random()*16777215).toString(16).padStart(6, '0');
                const newStroke = darkenHex(newFill, 0.3);
                
                const fillWrapper = row.querySelector('.cat-fill-wrapper');
                const strokeWrapper = row.querySelector('.cat-stroke-wrapper');
                
                if (fillWrapper && fillWrapper.pickrInstance) {
                    fillWrapper.pickrInstance.setColor(hexAlpha(newFill, parseFloat(fillWrapper.getAttribute('data-opacity'))));
                }
                if (strokeWrapper && strokeWrapper.pickrInstance) {
                    strokeWrapper.pickrInstance.setColor(hexAlpha(newStroke, parseFloat(strokeWrapper.getAttribute('data-opacity'))));
                }
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
    
        getEl('btn-copy-style')?.addEventListener('click', (e) => {
            e.preventDefault();
            const styleToCopy = extractStyleFromUI() || layer.customStyle;
            AppState.copiedStyle = JSON.parse(JSON.stringify(styleToCopy));
            showToast("Style copied to clipboard!");
            
            const pasteBtn = getEl('btn-paste-style');
            if (pasteBtn) { 
                pasteBtn.disabled = false; 
                pasteBtn.classList.remove('opacity-50', 'cursor-not-allowed'); 
            }
        });
    
        getEl('btn-paste-style')?.addEventListener('click', (e) => {
            e.preventDefault();
            if (!AppState.copiedStyle) return showToast("Clipboard is empty!", true);
            
            const newStyle = JSON.parse(JSON.stringify(AppState.copiedStyle));
            layer.customStyle = newStyle;
            
            map.removeLayer(layer.mapLayer);
            const paneName = 'pane-' + layer.uniqueKey;
            
            const existingPane = map.getPane(paneName);
            if (existingPane) existingPane.innerHTML = ''; 
    
            const newMapLayer = createCustomGeoJSONLayer(layer.geoJsonData, layer.customStyle, paneName);
            if (layer.isVisible) newMapLayer.addTo(map);
            layer.mapLayer = newMapLayer;
            updateMapLayerOrder();
            
            handleToggleEdit(key, newStyle);
            showToast("Style pasted and applied to map!");
        });
    
        getEl('btn-apply-edit')?.addEventListener('click', (e) => {
            e.preventDefault();
            const newStyle = extractStyleFromUI();
            if (!newStyle) return showToast("Please configure valid style mapping.", true);
            
            layer.customStyle = newStyle;
            map.removeLayer(layer.mapLayer);
            const paneName = 'pane-' + layer.uniqueKey;
            
            const existingPane = map.getPane(paneName);
            if (existingPane) existingPane.innerHTML = ''; 
    
            const newMapLayer = createCustomGeoJSONLayer(layer.geoJsonData, layer.customStyle, paneName);
            if (layer.isVisible) newMapLayer.addTo(map);
            layer.mapLayer = newMapLayer;
            updateMapLayerOrder();
            showToast("Layer style updated!");
        });
    
        gradColSelect?.addEventListener('change', updateGraduatedMinMax);
        if (activeStyleType === 'graduated' && cs.property) updateGraduatedMinMax();
    
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
                        
                        const curve = currentStyle.graduatedCurve || 'linear';
                        if (curve === 'exp') t = Math.pow(t, 2);
                        else if (curve === 'log') t = Math.sqrt(t);
                        else if (curve === 'sigmoid') t = 1 / (1 + Math.exp(-10 * (t - 0.5)));
    
                        fColor = interpolateColor(currentStyle.graduatedMinColor || '#ffeda0', currentStyle.graduatedMaxColor || '#f03b20', t);
                        sColor = interpolateColor(currentStyle.graduatedMinStroke || '#feb24c', currentStyle.graduatedMaxStroke || '#bd0026', t);
                        
                        const minFOp = currentStyle.graduatedMinFillOpacity ?? (currentStyle.graduatedFillOpacity ?? 0.7);
                        const maxFOp = currentStyle.graduatedMaxFillOpacity ?? (currentStyle.graduatedFillOpacity ?? 0.7);
                        const minSOp = currentStyle.graduatedMinStrokeOpacity ?? (currentStyle.graduatedStrokeOpacity ?? 1.0);
                        const maxSOp = currentStyle.graduatedMaxStrokeOpacity ?? (currentStyle.graduatedStrokeOpacity ?? 1.0);
                        
                        fOp = minFOp + (maxFOp - minFOp) * t;
                        sOp = minSOp + (maxSOp - minSOp) * t;
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
    
    
    return { handleToggleEdit };
}
