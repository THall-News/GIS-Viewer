// static/mapEngine.js

import { AppState } from './state.js';

// ==========================================
// 1. MAP INITIALIZATION ("The Canvas")
// ==========================================
export const map = L.map('map', { preferCanvas: true }).setView([0, 0], 2);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);

// Force Leaflet's built-in popups to render above all custom dynamic layers
map.getPane('popupPane').style.zIndex = 3000;

map.createPane('previewPane');
map.getPane('previewPane').style.zIndex = 2000;
map.getPane('previewPane').style.pointerEvents = 'none';
export const previewRenderer = L.canvas({ pane: 'previewPane' });

export const drawLayerGroup = L.featureGroup().addTo(map);

// ==========================================
// 2. STYLING UTILITIES ("The Paint Palette")
// ==========================================
export const darkenHex = (hex = '#2563eb', percent = 0.3) => {
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

export const hexAlpha = (hex = '#2563eb', alpha = 1.0) => {
    if (!hex) hex = '#2563eb';
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    const validAlpha = Math.max(0, Math.min(1, isNaN(parseFloat(alpha)) ? 1.0 : parseFloat(alpha)));
    const a = Math.round(validAlpha * 255).toString(16).padStart(2, '0');
    return (`#${hex}${a}`).toUpperCase();
};

export const interpolateColor = (color1, color2, factor) => {
    if (typeof factor !== 'number' || isNaN(factor)) factor = 0.5;
    let c1 = (color1 || '#ffeda0').toString().replace('#', '');
    let c2 = (color2 || '#f03b20').toString().replace('#', '');
    if (c1.length === 3) c1 = c1.split('').map(c => c + c).join('');
    if (c2.length === 3) c2 = c2.split('').map(c => c + c).join('');
    
    const r1 = parseInt(c1.substring(0, 2), 16) || 0;
    const g1 = parseInt(c1.substring(2, 4), 16) || 0;
    const b1 = parseInt(c1.substring(4, 6), 16) || 0;
    const r2 = parseInt(c2.substring(0, 2), 16) || 0;
    const g2 = parseInt(c2.substring(2, 4), 16) || 0;
    const b2 = parseInt(c2.substring(4, 6), 16) || 0;
    
    let r = Math.round(r1 + factor * (r2 - r1));
    let g = Math.round(g1 + factor * (g2 - g1));
    let b = Math.round(b1 + factor * (b2 - b1));
    
    r = Math.max(0, Math.min(255, r || 0));
    g = Math.max(0, Math.min(255, g || 0));
    b = Math.max(0, Math.min(255, b || 0));
    
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
};

// ==========================================
// 3. LAYER RENDERERS ("The Paintbrushes")
// ==========================================
export const createGeoJsonStyleFunction = (styleState) => {
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
        } else if (styleState && styleState.type === 'graduated') {
            const rawVal = parseFloat(feature.properties[styleState.property]);
            if (!isNaN(rawVal)) {
                const min = typeof styleState.graduatedMinVal === 'number' && !isNaN(styleState.graduatedMinVal) ? styleState.graduatedMinVal : 0;
                const max = typeof styleState.graduatedMaxVal === 'number' && !isNaN(styleState.graduatedMaxVal) ? styleState.graduatedMaxVal : 1;
                let t = (max > min) ? (rawVal - min) / (max - min) : 0.5;
                t = Math.max(0, Math.min(1, isNaN(t) ? 0.5 : t)); 
                
                return {
                    fillColor: interpolateColor(styleState.graduatedMinColor, styleState.graduatedMaxColor, t),
                    fillOpacity: styleState.graduatedFillOpacity ?? 0.7,
                    color: interpolateColor(styleState.graduatedMinStroke, styleState.graduatedMaxStroke, t),
                    opacity: styleState.graduatedStrokeOpacity ?? 1.0,
                    weight: 2
                };
            } else {
                return {
                    fillColor: styleState.defaultFill || '#cccccc',
                    fillOpacity: styleState.defaultFillOpacity ?? 0.5,
                    color: styleState.defaultColor || '#999999',
                    opacity: styleState.defaultOpacity ?? 1.0,
                    weight: 2
                };
            }
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

export const createGeoJsonPointToLayer = (styleState, paneName, customRenderer) => {
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
        } else if (styleState && styleState.type === 'graduated' && feature.properties) {
            const rawVal = parseFloat(feature.properties[styleState.property]);
            if (!isNaN(rawVal)) {
                const min = typeof styleState.graduatedMinVal === 'number' && !isNaN(styleState.graduatedMinVal) ? styleState.graduatedMinVal : 0;
                const max = typeof styleState.graduatedMaxVal === 'number' && !isNaN(styleState.graduatedMaxVal) ? styleState.graduatedMaxVal : 1;
                let t = (max > min) ? (rawVal - min) / (max - min) : 0.5;
                t = Math.max(0, Math.min(1, isNaN(t) ? 0.5 : t)); 
                
                fColor = interpolateColor(styleState.graduatedMinColor, styleState.graduatedMaxColor, t);
                sColor = interpolateColor(styleState.graduatedMinStroke, styleState.graduatedMaxStroke, t);
                fOp = styleState.graduatedFillOpacity ?? 0.7;
                sOp = styleState.graduatedStrokeOpacity ?? 1.0;
            } else {
                fColor = styleState.defaultFill || '#cccccc';
                sColor = styleState.defaultColor || '#999999';
                fOp = styleState.defaultFillOpacity ?? 0.5;
                sOp = styleState.defaultOpacity ?? 1.0;
            }
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
                pane: paneName, renderer: customRenderer, interactive: true,
                radius: size, fillColor: fColor, color: sColor, weight: 2, 
                opacity: sOp, fillOpacity: fOp 
            });
        } else {
            const w = size * 2 + 4; const c = w / 2; let svgHtml = '';
            if (shape === 'square') {
                svgHtml = `<svg width="${w}" height="${w}" viewBox="0 0 ${w} ${w}" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="2" width="${w-4}" height="${w-4}" fill="${fColor}" fill-opacity="${fOp}" stroke="${sColor}" stroke-opacity="${sOp}" stroke-width="2"/></svg>`;
            } else if (shape === 'triangle') {
                svgHtml = `<svg width="${w}" height="${w}" viewBox="0 0 ${w} ${w}" xmlns="http://www.w3.org/2000/svg"><polygon points="2,${w-2} ${c},2 ${w-2},${w-2}" fill="${fColor}" fill-opacity="${fOp}" stroke="${sColor}" stroke-opacity="${sOp}" stroke-width="2" stroke-linejoin="round"/></svg>`;
            }
            return L.marker(latlng, {
                pane: paneName, interactive: true,
                icon: L.divIcon({ className: '', html: svgHtml, iconSize: [w, w], iconAnchor: [c, c] }) 
            });
        }
    };
};

export const attachPopupsToFeatures = function(feature, l) {
    if (feature && feature.properties) {
        let popupContent = '<div class="max-h-48 overflow-y-auto custom-scroll"><table class="text-xs text-left w-full text-gray-800 dark:text-gray-200">';
        for (let k in feature.properties) {
            popupContent += `<tr class="border-b border-gray-200 dark:border-gray-600"><td class="font-bold pr-2 py-1">${k}</td><td class="py-1">${feature.properties[k]}</td></tr>`;
        }
        popupContent += '</table></div>';
        l.bindPopup(popupContent);
    }
};

export const createCustomGeoJSONLayer = (geoJsonData, styleState, paneName) => {
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

// ==========================================
// 4. MAP MAINTENANCE ("The Cleanup Crew")
// ==========================================
export const removePane = (uniqueKey) => {
    const paneName = 'pane-' + uniqueKey;
    const pane = map.getPane(paneName);
    if (pane) {
        L.DomUtil.remove(pane);
        delete map._panes[paneName];
    }
};

export const clearAllPreviews = () => {
    Object.values(AppState.previewLayers).forEach(layer => map.removeLayer(layer));
    AppState.previewLayers = {};
};