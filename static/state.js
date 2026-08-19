// static/state.js

export const AppState = {
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