/**
 * Ride Service Worker — Build-aware caching with seamless updates
 *
 * Strategy:
 *   App shell (HTML/CSS/JS/vendor/icons) → Network-first with a short
 *     timeout racing the cache: on slow links the cached copy is served
 *     after 3.5s while the network response refreshes the cache in the
 *     background. All shell lookups use {ignoreSearch:true} so the
 *     ?v= cache-busting suffix still hits the precache.
 *   API requests → Network-only, EXCEPT GET /api/trips* which keeps a
 *     last-known-good JSON copy served only when the network fails
 *     (stale-if-offline; no max-age — each successful fetch replaces it,
 *     logout clears it, and the cache is capped at MAX_API_ENTRIES). Each
 *     snapshot is stamped with an `X-Ride-Cached-At` header, so a response
 *     carrying that header is by definition the offline copy and the page
 *     can date it. A cold offline open of a cloud trip still shows data.
 *   Map tiles → Offline-download cache first (authoritative, never a network
 *     round trip), then stale-while-revalidate in a dedicated browsing cache,
 *     capped at ~2000 entries (oldest pruned, fire-and-forget). Survives
 *     updates. Matched BEFORE the API rule: tiles are served by our own proxy
 *     at /api/tiles/... , which the network-only API rule would otherwise claim.
 *   Google Fonts → runtime cache; cache-first for immutable gstatic woff2.
 *   Routing (OSRM) → Network-only.
 *
 * Offline trip downloads (OFFLINE_CACHE, driven by public/js/offline-maps.js
 * over postMessage) are deliberately a SEPARATE cache from TILES_CACHE. The
 * tiles cache is size-capped and prunes oldest-first, so a week of casual map
 * panning would silently evict the map a rider is out in the desert depending
 * on. Nothing prunes OFFLINE_CACHE by size — only an explicit delete.
 *
 * Updates: the server build ID (/api/_build) is persisted in Cache
 * Storage so it survives SW termination. Compared on activate, on the
 * first fetch after each SW wake, and every 2 minutes while alive.
 * On change: purge + re-precache the shell, then notify clients
 * ('ride:update' — the page defers the reload while a ride is active).
 */

const SHELL_CACHE = 'ride-shell-v8';
const TILES_CACHE = 'ride-tiles';
const API_CACHE = 'ride-api-v1';
const RUNTIME_CACHE = 'ride-runtime-v1';
const META_CACHE = 'ride-meta';
const OFFLINE_CACHE = 'ride-offline-v1';
// Anything missing from this list is deleted on activate.
const KNOWN_CACHES = [SHELL_CACHE, TILES_CACHE, API_CACHE, RUNTIME_CACHE, META_CACHE, OFFLINE_CACHE];

const SHELL_TIMEOUT_MS = 3500;
const MAX_TILE_ENTRIES = 2000;
const MAX_API_ENTRIES = 40;

/**
 * Tiles fetched at a time during an offline download. Six, not six hundred:
 * the tile proxy is one origin over HTTP/2, six is also the classic per-host
 * HTTP/1.1 limit, and thousands of parallel fetches would rate-limit us or
 * take the tab down. Enough to saturate a phone link, not enough to abuse it.
 */
const OFFLINE_CONCURRENCY = 6;

/** Broadcast progress every N tiles — a message per tile would flood the page. */
const OFFLINE_PROGRESS_EVERY = 25;

/** Synthetic keys inside OFFLINE_CACHE (same idiom as BUILD_META_KEY). */
const OFFLINE_MANIFEST_KEY = '/__ride/offline-manifest';
const OFFLINE_LIST_PREFIX = '/__ride/offline-tiles/';

/**
 * Every asset index.html and trip.html reference (bare paths — requests
 * carry ?v= and are matched with ignoreSearch). Must all exist or
 * install fails, which is intentional: a partial shell is worse than none.
 */
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/tokens.css',
  '/css/global.css',
  '/css/app.css',
  '/css/ride-mode.css',
  '/css/route-components.css',
  '/css/trip.css',
  '/vendor/leaflet/leaflet.css',
  '/vendor/leaflet/leaflet.js',
  '/vendor/leaflet/leaflet-routing-machine.css',
  '/vendor/leaflet/leaflet-routing-machine.min.js',
  '/vendor/leaflet/images/layers.png',
  '/vendor/leaflet/images/layers-2x.png',
  '/vendor/leaflet/images/marker-icon.png',
  '/vendor/leaflet/images/marker-icon-2x.png',
  '/vendor/leaflet/images/marker-shadow.png',
  '/js/api.js',
  '/js/storage.js',
  '/js/utils.js',
  '/js/trip.js',
  '/js/map-tiles.js',
  '/js/offline-maps.js',
  '/js/map.js',
  '/js/map-ride.js',
  '/js/map-photos.js',
  '/js/route-editor.js',
  '/js/route-selector.js',
  '/js/route-alternatives.js',
  '/js/ui.js',
  '/js/ui-renderers.js',
  '/js/ui-place-search.js',
  '/js/share.js',
  '/js/share-patch.js',
  '/js/export-import.js',
  '/js/app-core.js',
  '/js/auth-controller.js',
  '/js/trip-controller.js',
  '/js/trip-details.js',
  '/js/waypoint-controller.js',
  '/js/journal-controller.js',
  '/js/ride-controller.js',
  '/js/trip-share-hero.js',
  '/js/scenic-suggest.js',
  '/data/scenic-roads-au.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon.svg',
  '/icons/ride-logo-32.png',
  '/icons/ride-logo-48.png'
];

/** Best-effort extras (pretty URLs served by the worker) — never fail install. */
const OPTIONAL_ASSETS = [
  '/trip',
  '/about'
];

/** Every path the shell cache is allowed to hold after a build refresh. */
const SHELL_PATHS = new Set([...STATIC_ASSETS, ...OPTIONAL_ASSETS]);

/**
 * Fetch the whole shell fresh (cache:'reload' bypasses the HTTP cache).
 * cache.addAll is all-or-nothing: if any asset fails, nothing is written and
 * the previously cached shell stays intact — so a client that goes offline
 * mid-update is never left with a half (i.e. broken) app.
 */
async function precacheShell() {
  const cache = await caches.open(SHELL_CACHE);
  await cache.addAll(STATIC_ASSETS.map(u => new Request(u, { cache: 'reload' })));
  await Promise.all(
    OPTIONAL_ASSETS.map(u => cache.add(new Request(u, { cache: 'reload' })).catch(() => {}))
  );
}

/** Drop shell entries the current build no longer ships. */
async function pruneShellCache() {
  const cache = await caches.open(SHELL_CACHE);
  const keys = await cache.keys();
  await Promise.all(keys.map((req) => {
    const path = new URL(req.url).pathname;
    if (SHELL_PATHS.has(path)) return Promise.resolve();
    return cache.delete(req).catch(() => {});
  }));
}

/** Shell lookups always ignore the ?v= suffix. */
async function matchShell(request) {
  const cache = await caches.open(SHELL_CACHE);
  return cache.match(request, { ignoreSearch: true });
}

/** Store runtime shell entries keyed on the bare path (no query). */
function shellCacheKey(request) {
  const u = new URL(request.url);
  u.search = '';
  return u.href;
}

/* ── Build version tracking (persisted in Cache Storage) ─────────────── */
const BUILD_META_KEY = '/__ride/known-build-id';

async function readKnownBuildId() {
  try {
    const cache = await caches.open(META_CACHE);
    const res = await cache.match(BUILD_META_KEY);
    return res ? (await res.text()) || null : null;
  } catch (_) {
    return null;
  }
}

async function writeKnownBuildId(buildId) {
  try {
    const cache = await caches.open(META_CACHE);
    await cache.put(BUILD_META_KEY, new Response(String(buildId)));
  } catch (_) {
    // ignore
  }
}

async function fetchBuildId() {
  try {
    const res = await fetch('/api/_build', { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    return data.build || null;
  } catch (_) {
    return null;
  }
}

async function checkForUpdate() {
  const remoteBuild = await fetchBuildId();
  if (!remoteBuild) return;

  const knownBuildId = await readKnownBuildId();
  if (!knownBuildId) {
    await writeKnownBuildId(remoteBuild);
    return;
  }
  if (remoteBuild === knownBuildId) return;

  // Re-fetch the shell BEFORE adopting the new build id. addAll leaves the
  // old shell untouched if it fails, so a flaky link just means we retry on
  // the next poll instead of reloading tabs onto a cache we couldn't fill.
  // Tiles, API snapshots, fonts and meta are never purged.
  try {
    await precacheShell();
    await pruneShellCache();
  } catch (_) {
    return; // offline mid-update — keep serving the build we have
  }

  await writeKnownBuildId(remoteBuild);

  // Tell every open tab (the page defers reload while a ride is active)
  const clients = await self.clients.matchAll({ type: 'window' });
  clients.forEach(c => c.postMessage({ type: 'ride:update', build: remoteBuild }));
}

/* ── Install ─────────────────────────────────────────────────────────── */
self.addEventListener('install', (event) => {
  event.waitUntil(precacheShell());
  self.skipWaiting();
});

/* ── Activate ────────────────────────────────────────────────────────── */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Clean legacy caches
      const keys = await caches.keys();
      await Promise.all(
        keys.filter(n => !KNOWN_CACHES.includes(n)).map(n => caches.delete(n))
      );
      // Speeds up navigations: the browser starts the request while the SW boots
      if (self.registration.navigationPreload) {
        try { await self.registration.navigationPreload.enable(); } catch (_) {}
      }
      // Best-effort: ask the browser not to evict our origin's caches (tiles,
      // shell, offline trip snapshots) under storage pressure. Silently a
      // no-op where unsupported or the heuristic isn't met yet.
      if (self.navigator?.storage?.persist) {
        try { await self.navigator.storage.persist(); } catch (_) {}
      }
      await self.clients.claim();
      await checkForUpdate();
    })()
  );
});

/* ── Periodic build polling (every 2 min while SW is alive) ──────────── */
setInterval(() => checkForUpdate(), 2 * 60 * 1000);

// SWs are terminated when idle; run one check per wake so updates are
// detected even though the interval above rarely survives long.
let startupCheckDone = false;

/* ── Strategy helpers ────────────────────────────────────────────────── */

/** Network response for a shell request, using navigation preload when present. */
async function shellNetworkFetch(event, request) {
  if (event.preloadResponse) {
    const preloaded = await event.preloadResponse;
    if (preloaded) return preloaded;
  }
  return fetch(request);
}

/**
 * App shell: network-first racing a 3.5s timer against the cache.
 * Timeout → serve cache immediately, let the network refresh in background.
 */
async function shellNetworkFirst(event, request) {
  const network = shellNetworkFetch(event, request).then((response) => {
    // Never cache a redirect: replaying a redirected response for a later
    // navigation fails ("redirected response used for a request whose
    // redirect mode is not follow") — short-code URLs like /abc123 hit this.
    if (response && response.status === 200 && !response.redirected) {
      const copy = response.clone();
      caches.open(SHELL_CACHE).then(c => c.put(shellCacheKey(request), copy)).catch(() => {});
    }
    return response;
  });

  let timer;
  const TIMEOUT = Symbol('timeout');
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(TIMEOUT), SHELL_TIMEOUT_MS); });

  try {
    const winner = await Promise.race([network, timeout]);
    if (winner !== TIMEOUT) {
      clearTimeout(timer);
      return winner;
    }
  } catch (_) {
    // Network rejected — fall through to cache
    clearTimeout(timer);
    const cached = await matchShell(request);
    if (cached) return cached;
    return shellNavigationFallback(request);
  }

  // Timed out on a slow link: serve cache now, keep refreshing behind it
  const cached = await matchShell(request);
  if (cached) {
    event.waitUntil(network.catch(() => {}));
    return cached;
  }
  // Nothing cached — wait out the network after all
  try {
    return await network;
  } catch (_) {
    return shellNavigationFallback(request);
  }
}

/** Offline navigation fallback: share pages get /trip, everything else the app. */
async function shellNavigationFallback(request) {
  if (request.mode === 'navigate') {
    const url = new URL(request.url);
    if (url.pathname === '/trip' || url.pathname === '/trip.html' || /^\/[a-zA-Z0-9]{6}$/.test(url.pathname)) {
      const tripPage = await matchShell('/trip');
      if (tripPage) return tripPage;
    }
    const shell = await matchShell('/index.html');
    if (shell) return shell;
  }
  return Response.error();
}

/**
 * Store one trip-data snapshot, stamped with the time it was taken and
 * bounded to MAX_API_ENTRIES (oldest first out). Best-effort throughout —
 * a failed snapshot must never affect the response the page receives.
 */
async function putApiSnapshot(request, response) {
  try {
    const headers = new Headers(response.headers);
    headers.set('X-Ride-Cached-At', new Date().toISOString());
    const body = await response.blob();
    const cache = await caches.open(API_CACHE);
    await cache.put(request, new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers
    }));
    const keys = await cache.keys();
    if (keys.length > MAX_API_ENTRIES) {
      await Promise.all(
        keys.slice(0, keys.length - MAX_API_ENTRIES).map(k => cache.delete(k).catch(() => {}))
      );
    }
  } catch (_) {
    // ignore
  }
}

/**
 * GET /api/trips* — network always wins; the cache exists purely so a
 * cold offline open still shows last-known trip data.
 * Only 200 responses are stored (trips list/get, waypoints, journal,
 * alternatives, ride-logs, versions). Cleared on logout.
 *
 * Two layers of fallback, in order of how much the rider is relying on them:
 * a pinned copy in OFFLINE_CACHE (they explicitly downloaded this trip, and it
 * is exempt from the MAX_API_ENTRIES cap) beats the rolling API snapshot.
 */
async function apiNetworkWithOfflineFallback(event, request) {
  try {
    const response = await fetch(request);
    if (response && response.status === 200 && !response.redirected) {
      // Neither of these rejects, so a lost waitUntil window is harmless.
      const snapshot = putApiSnapshot(request, response.clone());
      const pinned = refreshPinnedTripData(request, response.clone());
      try { event.waitUntil(Promise.all([snapshot, pinned])); } catch (_) { /* event lifetime ended */ }
    }
    return response;
  } catch (err) {
    const pinned = await matchPinnedTripData(request);
    if (pinned) return pinned;
    const cache = await caches.open(API_CACHE);
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

let tilePutCounter = 0;

/** Cap the tile cache; prune oldest entries (insertion order), fire-and-forget. */
function pruneTilesCache(cache) {
  cache.keys().then((keys) => {
    if (keys.length <= MAX_TILE_ENTRIES) return;
    const excess = keys.slice(0, keys.length - MAX_TILE_ENTRIES);
    excess.forEach(k => { cache.delete(k).catch(() => {}); });
  }).catch(() => {});
}

/**
 * Is this a basemap tile?
 *
 * Tiles now come from our own Worker proxy at /api/tiles/... (see api/tiles.js),
 * which is why this is a path test as well as a hostname test. The provider
 * hostnames stay matched: harmless, and ride-test-page.html still hits them
 * directly.
 */
function isTileRequest(url) {
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/tiles/')) return true;
  return url.hostname.includes('basemaps.cartocdn.com') ||
    url.hostname.includes('tile.openstreetmap.org') ||
    url.hostname.includes('arcgisonline.com');
}

/**
 * Every tile request starts here.
 *
 * A deliberately downloaded tile is authoritative: served straight from
 * OFFLINE_CACHE with no network round trip, no revalidation, no expiry. That is
 * the whole promise of the feature — out of coverage the map must draw, and in
 * coverage it must not burn a rider's data re-fetching what they already paid
 * to download. Everything else falls through to the browsing cache.
 */
async function tilesOfflineFirst(request) {
  try {
    const offline = await caches.open(OFFLINE_CACHE);
    const pinned = await offline.match(request);
    if (pinned) return pinned;
  } catch (_) {
    // Cache trouble must never cost us the tile.
  }
  return tilesStaleWhileRevalidate(request);
}

/** Map tiles: stale-while-revalidate with a bounded cache. */
async function tilesStaleWhileRevalidate(request) {
  const cache = await caches.open(TILES_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request).then((res) => {
    if (res && res.status === 200) {
      cache.put(request, res.clone()).catch(() => {});
      if (++tilePutCounter % 20 === 0) pruneTilesCache(cache);
    }
    return res;
  }).catch(() => cached || Response.error());
  return cached || network;
}

/** Cross-origin runtime cache (fonts, unpkg): cache-first for immutable files. */
async function runtimeCacheFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res && (res.status === 200 || res.type === 'opaque')) {
    cache.put(request, res.clone()).catch(() => {});
  }
  return res;
}

/** Google Fonts CSS: stale-while-revalidate (UA-dependent, may change). */
async function runtimeStaleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request).then((res) => {
    if (res && (res.status === 200 || res.type === 'opaque')) {
      cache.put(request, res.clone()).catch(() => {});
    }
    return res;
  }).catch(() => cached || Response.error());
  return cached || network;
}

/* ── Offline trip downloads ──────────────────────────────────────────────
 *
 * The page (public/js/offline-maps.js) works out WHICH tiles a trip needs; the
 * service worker does the fetching, because it keeps working when the phone is
 * pocketed and the tab is backgrounded.
 *
 * Commands arrive by postMessage with a MessageChannel port for the single
 * reply. Progress does not use that port — it is broadcast to every window
 * client, so a reload mid-download reattaches to the running job instead of
 * losing sight of it.
 *
 * Stored per downloaded trip:
 *   OFFLINE_MANIFEST_KEY          — { [tripId]: metadata } for the UI list.
 *   OFFLINE_LIST_PREFIX + tripId  — { tiles: [url], data: [url] }, the exact
 *                                   entries this trip owns. Kept separate from
 *                                   the manifest because it is ~12k strings and
 *                                   the manifest is read on every status call.
 * Two trips through the same country share tiles, so deleting one only removes
 * entries no other downloaded trip still lists.
 */

/** tripId → live job. Not persisted: a killed SW means a killed download. */
const offlineJobs = new Map();

function offlineListKey(tripId) {
  return OFFLINE_LIST_PREFIX + encodeURIComponent(tripId);
}

async function readOfflineManifest() {
  try {
    const cache = await caches.open(OFFLINE_CACHE);
    const res = await cache.match(OFFLINE_MANIFEST_KEY);
    if (!res) return {};
    const data = await res.json();
    return (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
  } catch (_) {
    return {};
  }
}

async function writeOfflineManifest(manifest) {
  const cache = await caches.open(OFFLINE_CACHE);
  await cache.put(OFFLINE_MANIFEST_KEY, new Response(JSON.stringify(manifest), {
    headers: { 'Content-Type': 'application/json' }
  }));
}

async function readOfflineList(tripId) {
  try {
    const cache = await caches.open(OFFLINE_CACHE);
    const res = await cache.match(offlineListKey(tripId));
    if (!res) return { urlTemplate: '', tiles: [], data: [] };
    const data = await res.json();
    return {
      urlTemplate: typeof data?.urlTemplate === 'string' ? data.urlTemplate : '',
      tiles: Array.isArray(data?.tiles) ? data.tiles : [],
      data: Array.isArray(data?.data) ? data.data : []
    };
  } catch (_) {
    return { urlTemplate: '', tiles: [], data: [] };
  }
}

async function writeOfflineList(tripId, list) {
  const cache = await caches.open(OFFLINE_CACHE);
  await cache.put(offlineListKey(tripId), new Response(JSON.stringify(list), {
    headers: { 'Content-Type': 'application/json' }
  }));
}

/**
 * Every cache entry a trip's plan covers. Regenerated from [z,x,y] triples
 * rather than stored as URLs: a quarter of the bytes, and it means delete works
 * off the PLAN, not off a list of what happened to succeed. That is what makes
 * a download the browser killed halfway still fully deletable.
 */
function expandListUrls(list) {
  const urls = list.data.slice();
  if (!list.urlTemplate) return urls;
  for (const t of list.tiles) {
    urls.push(fillTileTemplate(list.urlTemplate, t[0], t[1], t[2]));
  }
  return urls;
}

/** Delete in batches — 12,000 sequential awaits would take a visible age. */
async function deleteAll(cache, urls) {
  const BATCH = 64;
  for (let i = 0; i < urls.length; i += BATCH) {
    await Promise.all(urls.slice(i, i + BATCH).map(u => cache.delete(u).catch(() => {})));
  }
}

/** What the page is allowed to see of a job — no URL arrays, no cancel flag. */
function publicJob(job) {
  return {
    tripId: job.tripId,
    name: job.name,
    detail: job.detail,
    state: job.state,
    total: job.total,
    done: job.done,
    failed: job.failed,
    bytes: job.bytes
  };
}

function broadcastOfflineJob(job) {
  const payload = { type: 'ride:offline:progress', job: publicJob(job) };
  self.clients.matchAll({ type: 'window' })
    .then(clients => clients.forEach(c => c.postMessage(payload)))
    .catch(() => {});
}

/** Fill a Leaflet-style template. The tile URL shape belongs to map-tiles.js. */
function fillTileTemplate(template, z, x, y) {
  return template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
}

/**
 * Pin the trip's own JSON so the trip OPENS offline, not just its map.
 * Stamped like an API snapshot (X-Ride-Cached-At) so the page can date it, plus
 * X-Ride-Offline-Pinned to mark it as the durable copy rather than the rolling
 * one. Done before the tiles: it is a few KB and it is the part without which
 * the tiles are useless.
 */
async function pinTripData(cache, urls, job) {
  const written = [];
  for (const url of urls) {
    if (job.cancelled) break;
    try {
      const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
      if (!res || res.status !== 200) continue;
      const body = await res.arrayBuffer();
      const headers = new Headers(res.headers);
      headers.set('X-Ride-Cached-At', new Date().toISOString());
      headers.set('X-Ride-Offline-Pinned', '1');
      await cache.put(url, new Response(body, { status: 200, headers }));
      job.bytes += body.byteLength;
      written.push(url);
    } catch (_) {
      // A failed pin is survivable — the rolling API snapshot still exists.
    }
  }
  return written;
}

/** Is there a durable pinned copy of this trip-data request? */
async function matchPinnedTripData(request) {
  try {
    const cache = await caches.open(OFFLINE_CACHE);
    return await cache.match(request);
  } catch (_) {
    return null;
  }
}

/**
 * Keep an already-pinned trip snapshot current. Only replaces an entry that
 * exists — this must never start pinning trips nobody downloaded.
 */
async function refreshPinnedTripData(request, response) {
  try {
    const cache = await caches.open(OFFLINE_CACHE);
    const existing = await cache.match(request);
    if (!existing) return;
    const body = await response.arrayBuffer();
    const headers = new Headers(response.headers);
    headers.set('X-Ride-Cached-At', new Date().toISOString());
    headers.set('X-Ride-Offline-Pinned', '1');
    await cache.put(request, new Response(body, { status: 200, headers }));
  } catch (_) {
    // ignore
  }
}

/**
 * Drop pinned trip JSON on logout (tiles are not user data, so they stay).
 * Without this, one account's trip data would sit readable in the cache after
 * a different rider signs in on the same phone.
 */
async function purgePinnedTripData() {
  try {
    const cache = await caches.open(OFFLINE_CACHE);
    const manifest = await readOfflineManifest();
    let changed = false;
    for (const tripId of Object.keys(manifest)) {
      const list = await readOfflineList(tripId);
      if (!list.data.length) continue;
      await deleteAll(cache, list.data);
      await writeOfflineList(tripId, { urlTemplate: list.urlTemplate, tiles: list.tiles, data: [] });
      manifest[tripId].dataPinned = 0;
      changed = true;
    }
    if (changed) await writeOfflineManifest(manifest);
  } catch (_) {
    // ignore
  }
}

/**
 * Fetch and store a whole trip's tiles.
 *
 * Individual failures are counted, never fatal: a handful of tiles the proxy
 * couldn't serve (it answers 502 with a blank PNG upstream is unreachable, and
 * that must NOT be stored as if it were map) is a few grey squares, not a
 * failed download.
 *
 * Cancel deletes what this job wrote. That is deliberate: someone cancelling a
 * 200 MB download on mobile data wants the space and the data back, not a
 * useless half-map. A trip that is already downloaded is refused rather than
 * re-downloaded, so cancel can never eat a working map.
 *
 * The plan and a provisional manifest entry are written BEFORE any fetching.
 * If the browser shuts the worker down halfway, the partial download is still
 * listed (partial: true) and still fully deletable, instead of becoming storage
 * the rider can neither see nor reclaim.
 */
async function runOfflineDownload(payload) {
  const tripId = String(payload?.tripId || '');
  const template = String(payload?.urlTemplate || '');
  const tiles = Array.isArray(payload?.tiles) ? payload.tiles : [];
  if (!tripId || !tiles.length || !template.includes('{z}')) {
    return { ok: false, reason: 'bad-request' };
  }
  if (offlineJobs.has(tripId)) return { ok: false, reason: 'in-progress' };

  const manifest = await readOfflineManifest();
  if (manifest[tripId]) return { ok: false, reason: 'already-downloaded' };

  const job = {
    tripId,
    name: String(payload.tripName || ''),
    detail: String(payload.detailLabel || payload.detail || ''),
    state: 'running',
    total: tiles.length,
    done: 0,
    failed: 0,
    bytes: 0,
    cancelled: false
  };
  offlineJobs.set(tripId, job);
  broadcastOfflineJob(job);

  const cache = await caches.open(OFFLINE_CACHE);
  const dataUrls = Array.isArray(payload.dataUrls) ? payload.dataUrls : [];
  const style = String(payload.style || '');

  const entry = {
    tripId,
    name: job.name,
    detail: job.detail,
    style,
    tiles: 0,
    failed: 0,
    bytes: 0,
    dataPinned: 0,
    partial: true,
    updatedAt: new Date().toISOString()
  };
  try {
    await writeOfflineList(tripId, { urlTemplate: template, tiles, data: dataUrls });
    manifest[tripId] = entry;
    await writeOfflineManifest(manifest);
  } catch (err) {
    offlineJobs.delete(tripId);
    job.state = 'error';
    broadcastOfflineJob(job);
    return { ok: false, reason: 'manifest-write-failed' };
  }

  const writtenData = await pinTripData(cache, dataUrls, job);

  const urls = tiles.map(t => fillTileTemplate(template, t[0], t[1], t[2]));
  let cursor = 0;
  let sinceReport = 0;
  let stored = 0;

  // Fixed pool of workers pulling from one shared cursor — OFFLINE_CONCURRENCY
  // requests in flight at any moment, no more.
  const worker = async () => {
    while (!job.cancelled) {
      const index = cursor++;
      if (index >= urls.length) return;
      const url = urls[index];
      try {
        const res = await fetch(url);
        if (res && res.status === 200) {
          const body = await res.arrayBuffer();
          await cache.put(url, new Response(body, {
            status: 200,
            headers: { 'Content-Type': res.headers.get('Content-Type') || 'image/png' }
          }));
          job.bytes += body.byteLength;
          stored++;
        } else {
          job.failed++;
        }
      } catch (_) {
        job.failed++;
      }
      job.done++;   // failures count too, so the bar always reaches 100%
      if (++sinceReport >= OFFLINE_PROGRESS_EVERY) {
        sinceReport = 0;
        broadcastOfflineJob(job);
      }
    }
  };

  await Promise.all(Array.from({ length: OFFLINE_CONCURRENCY }, worker));

  if (job.cancelled) {
    // Clean up through the normal delete path so shared tiles another
    // downloaded trip still needs are spared.
    offlineJobs.delete(tripId);
    await removeOfflineTrip(tripId);
    job.state = 'cancelled';
    broadcastOfflineJob(job);
    return { ok: false, reason: 'cancelled' };
  }

  entry.tiles = stored;
  entry.failed = job.failed;
  entry.bytes = job.bytes;
  entry.dataPinned = writtenData.length;
  entry.partial = false;
  entry.updatedAt = new Date().toISOString();

  try {
    const current = await readOfflineManifest();
    current[tripId] = entry;
    await writeOfflineManifest(current);
  } catch (err) {
    // The provisional entry is still there, so the download stays visible and
    // deletable — it just reads as partial until it is retried.
    offlineJobs.delete(tripId);
    job.state = 'error';
    broadcastOfflineJob(job);
    return { ok: false, reason: 'manifest-write-failed' };
  }

  job.state = 'done';
  offlineJobs.delete(tripId);
  broadcastOfflineJob(job);
  return { ok: true, entry };
}

/**
 * Delete one trip's download. Works off the stored plan, not off a record of
 * what succeeded, so a download the browser interrupted cleans up completely.
 * Entries another downloaded trip still lists are kept — two trips through the
 * same country share tiles, and deleting one must not blank the other.
 */
async function removeOfflineTrip(tripId) {
  const id = String(tripId || '');
  if (!id) return { ok: false, reason: 'bad-request' };

  const job = offlineJobs.get(id);
  if (job) { job.cancelled = true; job.state = 'cancelling'; }

  const cache = await caches.open(OFFLINE_CACHE);
  const manifest = await readOfflineManifest();
  const mine = expandListUrls(await readOfflineList(id));
  delete manifest[id];

  const keep = new Set();
  for (const otherId of Object.keys(manifest)) {
    expandListUrls(await readOfflineList(otherId)).forEach(u => keep.add(u));
  }

  const doomed = mine.filter(u => !keep.has(u));
  await deleteAll(cache, doomed);
  await cache.delete(offlineListKey(id)).catch(() => {});
  await writeOfflineManifest(manifest);
  return { ok: true, removed: doomed.length };
}

/* ── Page → SW commands ──────────────────────────────────────────────── */
self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data.type !== 'string' || !data.type.startsWith('ride:offline:')) return;

  const port = event.ports && event.ports[0];
  const reply = (payload) => { try { port?.postMessage(payload); } catch (_) {} };
  const settle = (promise) => {
    // waitUntil keeps the SW alive for the job. A very large download can still
    // outlive what the browser will grant one event; that is what MAX_TILES in
    // offline-maps.js is sized against.
    const done = promise.then(reply, (err) => reply({ ok: false, reason: 'error', message: String(err?.message || err) }));
    try { event.waitUntil(done); } catch (_) { /* event lifetime ended */ }
  };

  switch (data.type) {
    case 'ride:offline:download':
      settle(runOfflineDownload(data));
      break;

    case 'ride:offline:cancel': {
      const job = offlineJobs.get(String(data.tripId || ''));
      if (job) {
        job.cancelled = true;
        job.state = 'cancelling';
        broadcastOfflineJob(job);
      }
      reply({ ok: !!job });
      break;
    }

    case 'ride:offline:remove':
      settle(removeOfflineTrip(data.tripId));
      break;

    case 'ride:offline:status':
      settle(readOfflineManifest().then(manifest => ({
        ok: true,
        entries: Object.keys(manifest).map(k => manifest[k]),
        jobs: Array.from(offlineJobs.values()).map(publicJob)
      })));
      break;

    default:
      reply({ ok: false, reason: 'unknown-command' });
  }
});

/* ── Fetch ───────────────────────────────────────────────────────────── */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // One build check per SW wake (cheap; result persisted in Cache Storage)
  if (!startupCheckDone) {
    startupCheckDone = true;
    event.waitUntil(checkForUpdate().catch(() => {}));
  }

  // Non-GET → pass through, with two exceptions
  if (request.method !== 'GET') {
    if (url.origin !== self.location.origin) return;
    // A successful logout drops every cached API snapshot, including the
    // pinned copies inside OFFLINE_CACHE. Downloaded tiles survive: they are
    // basemap, not the departing rider's data.
    if (url.pathname === '/api/auth/logout') {
      event.respondWith(
        fetch(request).then((res) => {
          event.waitUntil(Promise.all([
            caches.delete(API_CACHE).catch(() => {}),
            purgePinnedTripData()
          ]));
          return res;
        })
      );
      return;
    }
    // Legacy share_target: manifests installed before share_target was
    // removed still POST here, and nothing server-side answers POST /share.
    // 303 makes the browser re-issue it as a GET instead of showing a 405.
    if (url.pathname === '/share') {
      event.respondWith(Response.redirect('/?shared=true', 303));
    }
    return;
  }

  // ── Map tiles: offline download first, then stale-while-revalidate ──
  // MUST stay ahead of the /api/ block below: the tile proxy lives at
  // /api/tiles/..., and network-only API handling would swallow it and leave
  // the map blank offline.
  if (isTileRequest(url)) {
    event.respondWith(tilesOfflineFirst(request));
    return;
  }

  // ── API: network-only, with a stale-if-offline fallback for trip data ──
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) {
    if (/^\/api\/trips(\/|$)/.test(url.pathname)) {
      event.respondWith(apiNetworkWithOfflineFallback(event, request));
    } else {
      event.respondWith(fetch(request));
    }
    return;
  }

  // ── Share target redirect ──
  if (url.pathname === '/share' && url.origin === self.location.origin) {
    event.respondWith(Response.redirect('/?shared=true'));
    return;
  }

  // ── OSRM routing: network only ──
  if (url.hostname.includes('router.project-osrm.org') ||
      url.hostname.includes('maps.incitat.io')) {
    event.respondWith(fetch(request));
    return;
  }

  // ── Google Fonts: runtime cache (woff2 files are immutable → cache-first) ──
  if (url.hostname === 'fonts.gstatic.com') {
    event.respondWith(runtimeCacheFirst(request));
    return;
  }
  if (url.hostname === 'fonts.googleapis.com') {
    event.respondWith(runtimeStaleWhileRevalidate(request));
    return;
  }

  // ── unpkg (legacy references on the share page): immutable versioned URLs ──
  if (url.hostname === 'unpkg.com') {
    event.respondWith(runtimeCacheFirst(request));
    return;
  }

  // ── App shell: network first (with timeout), cache fallback ──
  const isAppShell = url.origin === self.location.origin && (
    request.mode === 'navigate' ||
    url.pathname === '/' ||
    url.pathname === '/index.html' ||
    url.pathname === '/trip' ||
    url.pathname === '/trip.html' ||
    url.pathname === '/about' ||
    url.pathname === '/about.html' ||
    url.pathname === '/manifest.json' ||
    url.pathname.startsWith('/css/') ||
    url.pathname.startsWith('/js/') ||
    url.pathname.startsWith('/vendor/') ||
    url.pathname.startsWith('/icons/')
  );

  if (isAppShell) {
    event.respondWith(shellNetworkFirst(event, request));
    return;
  }

  // ── Everything else: cache first (shell + runtime, ?v= ignored) ──
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (!response || response.status !== 200 || response.redirected ||
            (response.type !== 'basic' && response.type !== 'cors')) {
          return response;
        }
        const copy = response.clone();
        caches.open(RUNTIME_CACHE).then(c => c.put(request, copy)).catch(() => {});
        return response;
      });
    }).catch(() => shellNavigationFallback(request))
  );
});
