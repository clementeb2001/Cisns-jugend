// Service Worker: cached die App-Shell für Offline-Betrieb.
// Statische Assets: Cache-First. API-Aufrufe: Network-Only
// (Offline-Daten werden von der App über IndexedDB verwaltet).
const CACHE = 'jf-praesenz-v1';
const SHELL = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/db.js',
  '/js/api.js',
  '/js/sync.js',
  '/js/app.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // API niemals cachen – die App verarbeitet Offline-Fälle selbst.
  if (url.pathname.startsWith('/api/')) return;

  // Navigations-Anfragen: Netzwerk zuerst, Fallback auf App-Shell.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Statische Assets: Cache-First, danach Netzwerk (und Cache aktualisieren).
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request).then((resp) => {
        if (resp && resp.status === 200 && url.origin === self.location.origin) {
          const copy = resp.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return resp;
      }).catch(() => cached);
      return cached || network;
    })
  );
});

// Background Sync: stößt beim Wiederverbinden einen Sync in der App an.
self.addEventListener('sync', (event) => {
  if (event.tag === 'jf-sync') {
    event.waitUntil(
      self.clients.matchAll().then((clients) => {
        clients.forEach((c) => c.postMessage({ type: 'do-sync' }));
      })
    );
  }
});
