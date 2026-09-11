// Bump this whenever the application shell changes.  A cache-first service
// worker must not continue serving an older geometry/rendering implementation.
const CACHE_NAME = 'gis-viewer-v71';

// Only pre-cache local files to avoid strict CORS installation crashes
const ASSETS_TO_CACHE = [
    '/',
    '/static/app.js',
    '/static/mapEngine.js',
    '/static/mapContextMenu.js',
    '/static/geoReferencedRaster.js',
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
    const requestUrl = new URL(event.request.url);

    // The document and the worker itself must be refreshed from the running
    // server. Otherwise an older cached HTML shell can hide newly-added UI
    // such as the map status bar indefinitely.
    if (event.request.mode === 'navigate' || requestUrl.pathname === '/sw.js') {
        const networkRequest = new Request(event.request, { cache: 'no-store' });
        event.respondWith(
            fetch(networkRequest).then(response => {
                if (event.request.mode === 'navigate' && response.status === 200) {
                    return caches.open(CACHE_NAME).then(cache => {
                        cache.put(event.request, response.clone());
                        return response;
                    });
                }
                return response;
            }).catch(() => caches.match(event.request))
        );
        return;
    }

    // We do NOT want to cache dynamic API proxy requests or server saves
    if (event.request.url.includes('/proxy') || event.request.url.includes('/api/')) {
        event.respondWith(fetch(event.request));
        return;
    }

    // OpenFreeMap styles and vector tiles must not be held cache-first. A
    // stale style can reference an old source URL and leave MapLibre with a
    // blank canvas even after the application has been hard-refreshed. Keep
    // the existing response as an offline fallback, but prefer the provider.
    if (requestUrl.hostname === 'tiles.openfreemap.org') {
        const styleRequest = requestUrl.pathname.includes('/styles/');
        const networkRequest = styleRequest
            ? new Request(event.request, { cache: 'no-store' })
            : event.request;
        event.respondWith(
            fetch(networkRequest).then((response) => {
                if (response.status === 200 || response.type === 'opaque') {
                    return caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, response.clone());
                        return response;
                    });
                }
                return response;
            }).catch(() => caches.match(event.request))
        );
        return;
    }

    // Application code must be checked against the server first. A stale
    // cached module can change how imported geometries are interpreted even
    // after the source has been reverted. Keep the cache only as an offline
    // fallback for these files.
    const appCode = /\/static\/(app|mapEngine|mapContextMenu|geoReferencedRaster|uiRenderer|headlessExecutor|headlessApi|styleEditor|tablePanel|attributeTable|tableUtils|roadSelection|featureSelection)\.js$/.test(new URL(event.request.url).pathname);
    if (appCode) {
        event.respondWith(
            fetch(event.request).then((response) => {
                if (response.status === 200) {
                    return caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, response.clone());
                        return response;
                    });
                }
                return response;
            }).catch(() => caches.match(event.request))
        );
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
