/**
 * Ride Service Worker — Build-aware caching with seamless updates
 *
 * Strategy:
 *   App shell (HTML/CSS/JS/icons) → Network-first, cache fallback
 *   API requests                  → Network-only (never cached)
 *   Owned Australia map tiles     → Stale-while-revalidate (bounded cache)
 *   External map tiles            → Browser HTTP cache (provider rules)
 *   Routing                       → Network-only
 *
 * On activate and every 2 minutes, polls /api/_build.
 * If the server build ID differs → purge app-shell cache, re-fetch assets,
 * and post a 'ride:update' message to all clients so they can reload.
 */

const CACHE_NAME = 'ride-v11';
const TILES_CACHE = 'ride-owned-tiles-v1';
const MAX_CACHED_TILES = 800;

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/app.css',
  '/css/global.css',
  '/css/ride-mode.css',
  '/css/itinerary.css',
  '/js/api.js',
  '/js/app-core.js',
  '/js/auth-controller.js',
  '/js/trip-controller.js',
  '/js/waypoint-controller.js',
  '/js/journal-controller.js',
  '/js/ride-controller.js',
  '/js/insights-hook.js',
  '/insights.js',
  '/js/utils.js',
  '/js/storage.js',
  '/js/trip.js',
  '/js/itinerary.js',
  '/js/itinerary-ui.js',
  '/js/basemaps.js',
  '/js/map.js',
  '/js/ui.js',
  '/js/share.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon.svg'
];

const EXTERNAL_ASSETS = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/leaflet-routing-machine@3.2.12/dist/leaflet-routing-machine.css',
  'https://unpkg.com/leaflet-routing-machine@3.2.12/dist/leaflet-routing-machine.min.js'
];

/* ── Build version tracking ──────────────────────────────────────────── */
let knownBuildId = null;

async function fetchBuildId() {
  try {
    const res = await fetch('/api/_build', { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    return data.build || null;
  } catch {
    return null;
  }
}

async function checkForUpdate() {
  const remoteBuild = await fetchBuildId();
  if (!remoteBuild) return;

  if (knownBuildId && remoteBuild !== knownBuildId) {
    knownBuildId = remoteBuild;

    // Purge app-shell cache, retaining the bounded cache of viewed owned tiles.
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== TILES_CACHE).map(k => caches.delete(k)));

    // Re-populate with fresh assets
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(STATIC_ASSETS.map(u => new Request(u, { cache: 'reload' })));

    // Tell every open tab to reload
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(c => c.postMessage({ type: 'ride:update', build: remoteBuild }));
  } else if (!knownBuildId) {
    knownBuildId = remoteBuild;
  }
}

/* ── Install ─────────────────────────────────────────────────────────── */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await cache.addAll(STATIC_ASSETS.map(u => new Request(u, { cache: 'reload' })));
      await cache.addAll(EXTERNAL_ASSETS);
    })
  );
  self.skipWaiting();
});

/* ── Activate ────────────────────────────────────────────────────────── */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Clean legacy caches
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(n => n !== CACHE_NAME && n !== TILES_CACHE)
          .map(n => caches.delete(n))
      );
      await self.clients.claim();
      await checkForUpdate();
    })()
  );
});

/* ── Periodic build polling (every 2 min while SW is alive) ──────── */
setInterval(() => checkForUpdate(), 2 * 60 * 1000);

/* ── Fetch ───────────────────────────────────────────────────────────── */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Non-GET → pass through
  if (request.method !== 'GET') return;

  // ── API: network only ──
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(request));
    return;
  }

  // ── Share target redirect ──
  if (url.pathname === '/share') {
    event.respondWith(Response.redirect('/?shared=true'));
    return;
  }

  // ── App shell: network first, cache fallback ──
  const isAppShell = url.origin === self.location.origin && (
    url.pathname === '/' ||
    url.pathname === '/index.html' ||
    url.pathname === '/manifest.json' ||
    url.pathname.startsWith('/css/') ||
    url.pathname.startsWith('/js/') ||
    url.pathname.startsWith('/icons/')
  );

  const isNavigation = url.origin === self.location.origin && request.mode === 'navigate';
  if (isAppShell || isNavigation) {
    event.respondWith(
      fetch(request).then((response) => {
        if (response && response.status === 200) {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE_NAME).then(c => c.put(request, copy)).catch(() => undefined));
        }
        return response;
      }).catch(async () => {
        const cache = await caches.open(CACHE_NAME);
        // Deploy stamps script/style URLs with a build query. The precached
        // unversioned shell must also work on the first offline reload.
        const cached = await cache.match(request, { ignoreSearch: !isNavigation });
        return cached || (isNavigation ? cache.match('/index.html') : undefined);
      })
    );
    return;
  }

  // ── Owned raster tiles: stale-while-revalidate, never cache error/login HTML ──
  if (url.origin === 'https://maps.incitat.io' &&
      /^\/styles\/ride-australia(?:-labels)?\/\d+\/\d+\/\d+\.png$/.test(url.pathname)) {
    const result = caches.open(TILES_CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      const network = fetch(request).then(async (res) => {
        if (res.ok && !res.redirected && /^image\/png(?:;|$)/i.test(res.headers.get('Content-Type') || '')) {
          try {
            await cache.put(request, res.clone());
            const keys = await cache.keys();
            await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_CACHED_TILES)).map(key => cache.delete(key)));
          } catch {
            // Quota or cache failures must not hide a successful live tile.
          }
        }
        return res;
      }).catch(() => cached || Response.error());
      return { cached, network };
    });
    event.waitUntil(result.then(({ network }) => network).then(() => undefined));
    event.respondWith(result.then(({ cached, network }) => cached || network));
    return;
  }

  // Public OSM allows normal interactive viewing and browser HTTP caching,
  // not application-managed offline downloads. Do not intercept these hosts.
  if (url.hostname === 'tile.openstreetmap.org' ||
      url.hostname.endsWith('.tile.openstreetmap.org') ||
      url.hostname === 'basemaps.cartocdn.com' ||
      url.hostname.endsWith('.basemaps.cartocdn.com') ||
      url.hostname.endsWith('.arcgisonline.com')) {
    return;
  }

  // ── OSRM routing: network only ──
  if (url.hostname.includes('router.project-osrm.org') ||
      url.hostname.includes('maps.incitat.io')) {
    event.respondWith(fetch(request));
    return;
  }

  // ── Everything else: cache first ──
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }
        const copy = response.clone();
        caches.open(CACHE_NAME).then(c => c.put(request, copy));
        return response;
      });
    }).catch(() => {
      if (request.mode === 'navigate') return caches.match('/index.html');
    })
  );
});
