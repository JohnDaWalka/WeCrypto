// Bug fix: sw.js crashes on file:// protocol in Electron (err2.log: Request scheme 'file' is unsupported)
const _isFileProtocol = self.location.protocol === 'file:';

const CACHE_NAME = 'we-cfm-pwa-v3';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './data.js',
  './cfm-engine.js',
  './predictions.js',
  './prediction-markets.js',
  './proxy-fetch.js',
  './manifest.webmanifest',
  './pwa-icon.svg'
];

self.addEventListener('install', event => {
  if (_isFileProtocol) { self.skipWaiting(); return; }
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
      .catch(err => {
        console.error('[SW] cache.addAll failed — continuing:', err);
        return self.skipWaiting();
      })
  );
});

self.addEventListener('activate', event => {
  if (_isFileProtocol) { self.clients.claim(); return; }
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (_isFileProtocol) return;
  if (!event.request.url.startsWith('http')) return; // skip file:// and other non-http schemes
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('./index.html'))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => {
      const networkFetch = fetch(request).then(response => {
        if (response && response.status === 200) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, responseClone));
        }
        return response;
      }).catch(() => cached);

      return cached || networkFetch;
    })
  );
});
