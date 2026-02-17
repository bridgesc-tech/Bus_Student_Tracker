// Update this version number when you deploy a new version
const APP_VERSION = '1.0.3';
const CACHE_NAME = `bus-student-tracker-${APP_VERSION}`;
const urlsToCache = [
  './',
  './index.html',
  './styles.css',
  './script.js',
  './manifest.json',
  './firebase-config.js'
];

self.addEventListener('install', (event) => {
  console.log('Service Worker installing, version:', APP_VERSION);
  // Skip waiting to activate new service worker immediately
  self.skipWaiting();
  
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('Caching files for version:', APP_VERSION);
        return cache.addAll(urlsToCache);
      })
      .catch((error) => {
        console.error('Cache failed:', error);
      })
  );
});

self.addEventListener('activate', (event) => {
  console.log('Service Worker activating, version:', APP_VERSION);
  event.waitUntil(
    // Clean up old caches
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      // Take control of all pages immediately
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', (event) => {
  // For HTML files, always try network first to get updates
  if (event.request.destination === 'document' || 
      event.request.url.includes('index.html') ||
      event.request.url.endsWith('/')) {
    event.respondWith(
      fetch(event.request)
        .then((fetchResponse) => {
          // Cache the fresh response
          if (fetchResponse && fetchResponse.status === 200) {
            const responseToCache = fetchResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseToCache);
            });
          }
          return fetchResponse;
        })
        .catch(() => {
          // If network fails, try cache
          return caches.match(event.request);
        })
    );
  } else {
    // For other resources, use cache first, then network
    event.respondWith(
      caches.match(event.request)
        .then((response) => {
          // Return cached version or fetch from network
          return response || fetch(event.request).then((fetchResponse) => {
            // Cache new responses for future use
            if (fetchResponse && fetchResponse.status === 200) {
              const responseToCache = fetchResponse.clone();
              caches.open(CACHE_NAME).then((cache) => {
                cache.put(event.request, responseToCache);
              });
            }
            return fetchResponse;
          });
        })
    );
  }
});

// Listen for messages from the client
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'GET_VERSION') {
    event.ports[0].postMessage({ version: APP_VERSION });
  }
});
