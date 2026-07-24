// Service Worker: App-Shell für Offline-Betrieb + zuverlässige Updates.
//
// Strategie: NETWORK-FIRST für eigene Seiten/Skripte/Styles. Ist eine Verbindung
// da, wird immer die AKTUELLE Version vom Server geladen (so kommen Korrekturen
// sofort beim nächsten Öffnen an). Ohne Verbindung wird der zuletzt gecachte
// Stand geliefert, damit die App offline weiter funktioniert.
// API-Aufrufe laufen nie über den Cache (Offline-Daten regelt die App via IndexedDB).
const CACHE = 'jf-praesenz-v11';
const SHELL = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/db.js',
  '/js/api.js',
  '/js/sync.js',
  '/js/app.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
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

// Network-First mit Cache-Fallback (für gleiche Herkunft)
async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const resp = await fetch(request);
    if (resp && resp.status === 200 && new URL(request.url).origin === self.location.origin) {
      cache.put(request, resp.clone());
    }
    return resp;
  } catch (e) {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const fallback = await cache.match('/index.html');
      if (fallback) return fallback;
    }
    throw e;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // API niemals cachen – die App verarbeitet Offline-Fälle selbst.
  if (url.pathname.startsWith('/api/')) return;

  // Nur eigene Ressourcen behandeln; fremde (falls vorhanden) normal durchlassen.
  if (url.origin !== self.location.origin) return;

  event.respondWith(networkFirst(request));
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
