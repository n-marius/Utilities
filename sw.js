// Service Worker: App offline verfügbar machen, Kartenkacheln zwischenspeichern.
// ASSETS und VERSION werden von scripts/precache.js aktualisiert.

const VERSION = 'dev';
const ASSETS = [
  './',
  'index.html'
];

const APP_CACHE = 'utilities-app-' + VERSION;
const TILE_CACHE = 'utilities-tiles-v1';
const DATA_CACHE = 'utilities-data-v1';
const TILE_HOSTS = ['basemaps.cartocdn.com', 'tile.opentopomap.org', 'tile.openstreetmap.org'];
const DATA_HOSTS = ['celestrak.org'];
const MAX_TILES = 6000;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(APP_CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k.startsWith('utilities-app-') && k !== APP_CACHE) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (TILE_HOSTS.some(h => url.hostname.endsWith(h))) {
    e.respondWith(tile(req));
    return;
  }
  if (DATA_HOSTS.some(h => url.hostname.endsWith(h))) {
    e.respondWith(networkFirst(req, DATA_CACHE));
    return;
  }
  if (url.origin === self.location.origin) {
    if (req.mode === 'navigate') {
      e.respondWith(caches.match('index.html', { ignoreSearch: true }).then(r => r || fetch(req)));
      return;
    }
    e.respondWith(caches.match(req, { ignoreSearch: true }).then(r => r || fetch(req).then(res => {
      if (res.ok) caches.open(APP_CACHE).then(c => c.put(req, res.clone()));
      return res;
    })));
  }
});

async function tile(req) {
  const cache = await caches.open(TILE_CACHE);
  const hit = await cache.match(req, { ignoreVary: true });
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok || res.type === 'opaque') {
      await cache.put(req, res.clone());
      trim(cache);
    }
    return res;
  } catch {
    return new Response('', { status: 504, statusText: 'offline' });
  }
}

let trimming = false;
async function trim(cache) {
  if (trimming) return;
  trimming = true;
  try {
    const keys = await cache.keys();
    if (keys.length > MAX_TILES) {
      for (const k of keys.slice(0, keys.length - MAX_TILES)) await cache.delete(k);
    }
  } finally {
    trimming = false;
  }
}

async function networkFirst(req, name) {
  const cache = await caches.open(name);
  try {
    const res = await fetch(req);
    if (res.ok) await cache.put(req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw new Error('offline');
  }
}
