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
    // Temporary context-menu follow-up state. This is intentionally not part
    // of workspace data; it only survives until the next OSM fetch/retry.
    osmFeatureFollowup: null,
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
    highlightLayer: null,
    featureSelection: {
        active: false,
        hovered: null,
        selected: [],
        selectionMode: 'rendered'
    },
    magneticLasso: {
        active: false,
        controls: [],
        points: [],
        path: [],
        trace: [],
        traceControls: [],
        geometry: null,
        completed: false
    },
    roadRoute: {
        active: false,
        waypoints: [],
        geometry: null,
        distance_m: null,
        duration_s: null
    },
    drawShape: {
        active: false,
        points: [],
        completed: false
    }
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
