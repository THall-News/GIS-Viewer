const CACHE_NAME = 'gis-viewer-v1';

// Only pre-cache local files to avoid strict CORS installation crashes
const ASSETS_TO_CACHE = [
    '/',
    '/static/app.js',
    '/static/mapEngine.js',
    '/static/state.js',
    '/static/uiRenderer.js',
    '/static/db.js',
    '/static/style.css'
];

// Install: Download and cache the App Shell
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(ASSETS_TO_CACHE);
        })
    );
    self.skipWaiting();
});

// Activate: Clean up any old caches if we update the version
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
            );
        })
    );
    self.clients.claim();
});

// Fetch: Intercept requests and serve from cache if offline
self.addEventListener('fetch', (event) => {
    // We do NOT want to cache dynamic API proxy requests or server saves
    if (event.request.url.includes('/proxy') || event.request.url.includes('/api/')) {
        event.respondWith(fetch(event.request));
        return;
    }

    // Cache-first strategy for the app shell and UI elements
    event.respondWith(
        caches.match(event.request).then((cachedResponse) => {
            return cachedResponse || fetch(event.request).then((fetchResponse) => {
                return caches.open(CACHE_NAME).then((cache) => {
                    // Allow caching of local files (status 200) AND external CDNs (opaque responses)
                    if (event.request.method === 'GET' && (fetchResponse.status === 200 || fetchResponse.type === 'opaque')) {
                        cache.put(event.request, fetchResponse.clone());
                    }
                    return fetchResponse;
                });
            });
        }).catch(() => {
            // Fails silently; your frontend IndexedDB handles the rest of the offline data
        })
    );
});