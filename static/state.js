// static/state.js

// 1. Create a global Event Bus for state changes
export const stateEvents = new EventTarget();

// 2. Your existing raw state object
const rawState = {
    fetchedLayers: [],
    activeLayers: [],
    previewLayers: {}, 
    currentServerUrl: '',
    currentServerType: '',
    lastFetchedOsmGeoJson: null,
    lastFetchedOsmLayerName: '',
    activeTableLayerKey: null, 
    activeEditLayerKey: null,
    activeSplitLayerKey: null,
    activeCropLayerKey: null,
    copiedStyle: null,
    currentSoloLayerKey: null, 
    drawingMode: null, 
    drawStart: null,
    tempShape: null, 
    filterGeometryData: null, 
    currentTableFeatures: [],
    currentTableHeaders: [],
    tableSortCol: null,
    tableSortAsc: true,
    highlightLayer: null
};

// 3. The Proxy Wrapper
export const AppState = new Proxy(rawState, {
    set(target, property, value) {
        target[property] = value;
        
        // Broadcast that a state property just changed
        stateEvents.dispatchEvent(new CustomEvent('stateChanged', {
            detail: { property, value }
        }));
        
        return true; 
    }
});