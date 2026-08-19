// static/db.js
const DB_NAME = 'GISViewerDB';
const DB_VERSION = 1;

export const initDB = () => {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            // Store for layer GeoJSON, user styles, and metadata
            if (!db.objectStoreNames.contains('layers')) {
                db.createObjectStore('layers', { keyPath: 'layerKey' });
            }
            // Store for saved server configurations
            if (!db.objectStoreNames.contains('servers')) {
                db.createObjectStore('servers', { keyPath: 'url' });
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
};

export const saveLayerToCache = async (layerData) => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('layers', 'readwrite');
        tx.objectStore('layers').put(layerData);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
};

export const getCachedLayers = async () => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('layers', 'readonly');
        const request = tx.objectStore('layers').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
};

export const deleteCachedLayer = async (layerKey) => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('layers', 'readwrite');
        tx.objectStore('layers').delete(layerKey);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
};