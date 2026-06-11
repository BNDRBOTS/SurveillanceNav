/**
 * STN service worker — offline-first PWA.
 *  - app shell + hashed assets: cache-first (immutable)
 *  - API GETs: network-first with 6s timeout → cache fallback (marked stale)
 *  - navigations: network-first → cached index.html
 *  - 'sync'/'online' → tells the app to flush its IndexedDB outbox
 * Mutations are NOT cached or replayed here — the app's outbox owns that
 * (idempotency keys make replays conflict-safe).
 */
const VERSION = 'stn-v1';
const SHELL_CACHE = `${VERSION}-shell`;
const DATA_CACHE = `${VERSION}-data`;
const ASSET_CACHE = `${VERSION}-assets`;
const TILE_CACHE = `${VERSION}-tiles`;
const TILE_LIMIT = 600;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(['/', '/manifest.webmanifest'])).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function timeoutFetch(request, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('sw-timeout')), ms);
    fetch(request).then(
      (res) => {
        clearTimeout(timer);
        resolve(res);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function trimCache(name, limit) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  if (keys.length > limit) {
    await Promise.all(keys.slice(0, keys.length - limit).map((k) => cache.delete(k)));
  }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;

  // hashed build assets: cache-first
  if (url.origin === self.location.origin && url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.open(ASSET_CACHE).then(async (cache) => {
        const hit = await cache.match(event.request);
        if (hit) return hit;
        const res = await fetch(event.request);
        if (res.ok) cache.put(event.request, res.clone());
        return res;
      }),
    );
    return;
  }

  // map raster tiles: cache-first with LRU-ish trim
  if (url.hostname.endsWith('tile.openstreetmap.org') || url.hostname === 'server.arcgisonline.com') {
    event.respondWith(
      caches.open(TILE_CACHE).then(async (cache) => {
        const hit = await cache.match(event.request);
        if (hit) return hit;
        try {
          const res = await timeoutFetch(event.request, 8000);
          if (res.ok) {
            cache.put(event.request, res.clone());
            trimCache(TILE_CACHE, TILE_LIMIT);
          }
          return res;
        } catch {
          return new Response('', { status: 504 });
        }
      }),
    );
    return;
  }

  // API GETs: network-first → cache fallback flagged stale
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) {
    event.respondWith(
      caches.open(DATA_CACHE).then(async (cache) => {
        try {
          const res = await timeoutFetch(event.request, 6000);
          if (res.ok && !url.pathname.includes('/auth/')) cache.put(event.request, res.clone());
          return res;
        } catch (err) {
          const hit = await cache.match(event.request);
          if (hit) {
            const headers = new Headers(hit.headers);
            headers.set('X-From-SW-Cache', 'true');
            return new Response(await hit.blob(), { status: hit.status, headers });
          }
          throw err;
        }
      }),
    );
    return;
  }

  // navigations: network-first → cached shell
  if (event.request.mode === 'navigate') {
    event.respondWith(
      timeoutFetch(event.request, 6000)
        .then((res) => {
          caches.open(SHELL_CACHE).then((cache) => cache.put('/', res.clone()));
          return res.clone();
        })
        .catch(async () => {
          const hit = await caches.match('/');
          return hit ?? new Response('Offline', { status: 503 });
        }),
    );
  }
});

async function notifyClientsToSync() {
  const clients = await self.clients.matchAll({ type: 'window' });
  for (const client of clients) client.postMessage({ type: 'stn-sync-outbox' });
}

self.addEventListener('sync', (event) => {
  if (event.tag === 'stn-outbox') event.waitUntil(notifyClientsToSync());
});
self.addEventListener('message', (event) => {
  if (event.data === 'stn-flush') notifyClientsToSync();
});
