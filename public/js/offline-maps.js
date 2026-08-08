/**
 * Offline Maps — download the basemap along a trip so it still draws with no
 * phone signal.
 *
 * Ride is used on long remote rides where coverage simply is not there, so a
 * downloaded map is closer to a safety item than a convenience. That shapes
 * every decision in this file:
 *
 *   - Deliberately downloaded tiles live in their OWN Cache Storage bucket
 *     ('ride-offline-v1', see public/sw.js). The browsing tile cache
 *     ('ride-tiles') is size-capped and prunes oldest-first, so anything the
 *     rider is depending on must never be stored there — a week of casual
 *     map panning would silently evict it.
 *   - The service worker does the fetching. It survives the page being
 *     backgrounded, which is exactly what happens on a phone.
 *   - Nothing is downloaded without showing a size first, and nothing starts
 *     if it would not fit in the remaining storage quota. Filling a rider's
 *     phone mid-trip is the one failure this feature must not cause.
 *
 * Contract — window.OfflineMaps:
 *   OfflineMaps.PRESETS            — detail levels, shallowest first.
 *   OfflineMaps.MAX_TILES          — hard cap per trip (see below).
 *   OfflineMaps.BYTES_PER_TILE     — the per-tile figure estimates use.
 *   OfflineMaps.isSupported()      — Cache Storage + a controlling SW.
 *   OfflineMaps.estimate(trip)     — tile counts and byte sizes for every
 *                                    preset, plus the computed tile sets. Pass
 *                                    the returned object back into download()
 *                                    so the maths only runs once.
 *   OfflineMaps.checkQuota(bytes)  — navigator.storage.estimate() headroom.
 *   OfflineMaps.download(trip, presetId, estimate)
 *                                  — resolves when the whole download finishes;
 *                                    progress arrives via onProgress().
 *   OfflineMaps.cancel(tripId)     — stop a running download.
 *   OfflineMaps.remove(tripId)     — delete a trip's tiles, reclaiming space.
 *   OfflineMaps.status()           — { entries, jobs } from the SW manifest.
 *   OfflineMaps.statusFor(tripId)  — { entry, job } for one trip.
 *   OfflineMaps.onProgress(fn)     — subscribe; returns an unsubscribe fn.
 *                                    A 'ride:offline-progress' window event
 *                                    carries the same payload.
 *   OfflineMaps.formatBytes(n)     — '74 MB' style, for UI copy.
 *
 * Tile URLs are never written here: the shape comes from
 * MapTiles.urlTemplate(style) (public/js/map-tiles.js) and is passed to the
 * service worker as a template, so a provider or path change stays one edit.
 */
(function (window) {
  'use strict';

  /* ══════════════════════════════════════════════════════════════════
     Sizing — every judgement call in this feature lives in this block
     ══════════════════════════════════════════════════════════════════ */

  /**
   * Every preset starts at z5: a handful of z5 tiles covers a whole state, so
   * the rider always has continental context to pan out to for free.
   */
  const MIN_ZOOM = 5;

  /**
   * 18 KB per tile — the midpoint of the 15-20 KB a 256 px raster tile
   * typically weighs. Sizes shown before a download use this figure; the
   * download itself reports real bytes as they land, so the estimate only ever
   * has to be good enough to decide on.
   */
  const BYTES_PER_TILE = 18 * 1024;

  /**
   * Hard cap: 12,000 tiles per trip ≈ 216 MB at 18 KB/tile. Why this number:
   *   - It is an amount of storage a phone can genuinely spare, and stays well
   *     inside the few-percent-of-disk quota browsers hand a single origin.
   *   - At 6 concurrent fetches and ~150 ms a tile it completes in about five
   *     minutes, which is roughly as long as a service worker can be relied on
   *     to keep working on one job.
   *   - Above it the honest answer is not "wait longer": it is a shallower
   *     detail level, or downloading one leg at a time. Legs are a first-class
   *     feature (type 'leg-break' dividers), so splitting is real advice.
   */
  const MAX_TILES = 12000;

  /**
   * Counting stops at 3x the cap. Past that the only useful answer is "far too
   * big", and walking a 15,000 km route at z16 to arrive at that answer is
   * work for nothing. A preset that hits this reports its count as a floor.
   */
  const COMPUTE_CEILING = MAX_TILES * 3;

  /**
   * Leave 64 MB of the quota free no matter what. A download that exactly
   * fills the quota breaks the app it was meant to protect: no room left for
   * the shell, journal photos or the ride log the rider records on the way.
   */
  const QUOTA_HEADROOM_BYTES = 64 * 1024 * 1024;

  /**
   * Detail levels. Trip lengths in this app span three orders of magnitude —
   * a Sunday loop against a lap of Australia — so a single zoom range would be
   * useless at one end and impossible at the other.
   */
  const PRESETS = [
    {
      id: 'overview',
      label: 'Overview',
      maxZoom: 11,
      blurb: 'Highways, towns and the shape of the whole route. Enough to know where you are, not to navigate a town.'
    },
    {
      id: 'standard',
      label: 'Standard',
      maxZoom: 14,
      blurb: 'Adds road layout and town names — the level you can actually navigate from. The right pick for most trips.'
    },
    {
      id: 'detailed',
      label: 'Detailed',
      maxZoom: 16,
      blurb: 'Adds street-level detail in towns: fuel, side streets, campgrounds. Best kept for a single day or leg.'
    }
  ];

  /* ══════════════════════════════════════════════════════════════════
     Slippy-map maths
     ══════════════════════════════════════════════════════════════════ */

  /** Web Mercator is undefined past ±85.0511; clamp rather than produce NaN. */
  function clampLat(lat) {
    return Math.max(-85.05112878, Math.min(85.05112878, lat));
  }

  /** Fractional tile column. Kept fractional so segments can be walked. */
  function tileXFloat(lng, z) {
    return ((lng + 180) / 360) * Math.pow(2, z);
  }

  /** Fractional tile row — the standard Web Mercator latitude projection. */
  function tileYFloat(lat, z) {
    const rad = (clampLat(lat) * Math.PI) / 180;
    const merc = Math.log(Math.tan(rad) + 1 / Math.cos(rad));
    return ((1 - merc / Math.PI) / 2) * Math.pow(2, z);
  }

  /**
   * Corridor width, in tiles either side of the route.
   *
   * Tile-space dilation, not a geodesic buffer — at these zooms the difference
   * is meaningless and the cost difference is not. Wider at low zooms because
   * those tiles are nearly free and a wide overview is genuinely useful; one
   * tile at z16 is still ~550 m of pan room, which is all a rider needs before
   * the deeper tiles stop being relevant anyway.
   */
  function bufferForZoom(z) {
    return z <= 12 ? 2 : 1;
  }

  /**
   * Tiles are keyed as a single number (y * 2^z + x) rather than a 'z/x/y'
   * string. A long route revisits the same low-zoom tiles thousands of times,
   * so the Set does a lot of work — numbers keep it cheap, and at z16 the key
   * peaks around 2^32, far inside safe integer range.
   */
  function addTile(set, xFloat, yFloat, n) {
    const y = Math.floor(yFloat);
    if (y < 0 || y >= n) return;                 // above/below the projection
    const x = ((Math.floor(xFloat) % n) + n) % n; // wrap the date line
    set.add(y * n + x);
  }

  /**
   * Mark every tile a straight segment passes through.
   *
   * Sampling at quarter-tile steps: consecutive samples can never be more than
   * a quarter tile apart on the dominant axis, so no tile in a straight line is
   * skipped. This matters more than it sounds — outback route geometry can run
   * 100 km between vertices, which at z16 is 180 tiles that endpoint-only
   * marking would leave blank.
   */
  function walkSegment(set, ax, ay, bx, by, n) {
    const dx = bx - ax;
    const dy = by - ay;
    // A segment spanning more than half the world is a short hop across 180°,
    // not a ride across the Pacific. Nothing in Australia does this; mark the
    // endpoint rather than dragging a corridor around the planet.
    if (Math.abs(dx) > n / 2) {
      addTile(set, bx, by, n);
      return;
    }
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) * 4));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      addTile(set, ax + dx * t, ay + dy * t, n);
    }
  }

  /** The tiles the route line itself crosses at one zoom, before dilation. */
  function routeTilesAtZoom(points, z) {
    const n = Math.pow(2, z);
    const set = new Set();
    let px = null;
    let py = null;
    for (const p of points) {
      const x = tileXFloat(p.lng, z);
      const y = tileYFloat(p.lat, z);
      if (px === null) addTile(set, x, y, n);
      else walkSegment(set, px, py, x, y, n);
      px = x;
      py = y;
    }
    return set;
  }

  /** Grow a tile set by `radius` tiles in every direction. */
  function dilate(set, z, radius) {
    if (radius <= 0) return set;
    const n = Math.pow(2, z);
    const out = new Set();
    for (const key of set) {
      const x = key % n;
      const y = (key - x) / n;
      for (let dy = -radius; dy <= radius; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= n) continue;
        const row = ny * n;
        for (let dx = -radius; dx <= radius; dx++) {
          out.add(row + ((((x + dx) % n) + n) % n));
        }
      }
    }
    return out;
  }

  /* ══════════════════════════════════════════════════════════════════
     Turning a trip into a tile plan
     ══════════════════════════════════════════════════════════════════ */

  /**
   * Accept [{lat,lng}], [[lng,lat]] or [[lat,lng]] — stored routes come from
   * several producers. Same disambiguation rule as MapManager._normalizeCoords
   * in public/js/map.js: a value beyond ±90 can only be a longitude.
   */
  function normalizePoints(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const c of raw) {
      if (!c) continue;
      if (Array.isArray(c)) {
        const a = Number(c[0]);
        const b = Number(c[1]);
        if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
        if (Math.abs(a) <= 90 && Math.abs(b) > 90) out.push({ lat: a, lng: b });
        else out.push({ lat: b, lng: a });
      } else {
        const lat = Number(c.lat);
        const lng = Number(c.lng);
        if (Number.isFinite(lat) && Number.isFinite(lng)) out.push({ lat, lng });
      }
    }
    return out;
  }

  /**
   * The line to download along. The stored route geometry when there is one;
   * otherwise straight lines between the stops, which is a rough corridor the
   * UI warns about rather than a silent downgrade.
   */
  function routePoints(trip) {
    const geometry = normalizePoints(trip?.route?.coordinates);
    if (geometry.length >= 2) return geometry;

    const list = (trip?.waypoints || []).filter(w => w && w.type !== 'leg-break');
    const ordered = window.Trip?.normalizeWaypointOrder
      ? window.Trip.normalizeWaypointOrder(list)
      : list;
    return normalizePoints(ordered);
  }

  /**
   * Walk every zoom once, shallowest first, and stop when the running total
   * passes COMPUTE_CEILING. Presets share the walk because each one's range is
   * the previous one plus deeper zooms.
   */
  function estimate(trip) {
    const points = routePoints(trip);
    const hasRoute = normalizePoints(trip?.route?.coordinates).length >= 2;
    const deepest = PRESETS[PRESETS.length - 1].maxZoom;
    const styleMax = window.MapTiles ? window.MapTiles.maxZoom(tileStyle()) : deepest;

    const perZoom = [];
    let total = 0;
    const walkTo = points.length ? Math.min(deepest, styleMax) : MIN_ZOOM - 1;
    for (let z = MIN_ZOOM; z <= walkTo; z++) {
      const set = dilate(routeTilesAtZoom(points, z), z, bufferForZoom(z));
      perZoom.push({ z, set });
      total += set.size;
      if (total > COMPUTE_CEILING) break;
    }

    const deepestCounted = perZoom.length ? perZoom[perZoom.length - 1].z : MIN_ZOOM - 1;
    const presets = PRESETS.map((preset) => {
      let tiles = 0;
      // A preset whose range we stopped short of only knows a floor for its
      // size, so it is over the cap by definition of why we stopped.
      const counted = Math.min(preset.maxZoom, deepestCounted);
      for (const entry of perZoom) {
        if (entry.z <= counted) tiles += entry.set.size;
      }
      const partial = counted < preset.maxZoom;
      return {
        id: preset.id,
        label: preset.label,
        blurb: preset.blurb,
        maxZoom: preset.maxZoom,
        tiles,
        bytes: tiles * BYTES_PER_TILE,
        partial,
        overCap: partial || tiles > MAX_TILES || tiles === 0
      };
    });

    return { tripId: trip?.id ? String(trip.id) : '', points, hasRoute, presets, perZoom };
  }

  /** The [z,x,y] triples for one preset, taken from a prior estimate(). */
  function tilesFor(est, presetId) {
    const preset = PRESETS.find(p => p.id === presetId);
    if (!preset || !est?.perZoom) return [];
    const tiles = [];
    for (const entry of est.perZoom) {
      if (entry.z > preset.maxZoom) continue;
      const n = Math.pow(2, entry.z);
      for (const key of entry.set) {
        const x = key % n;
        tiles.push([entry.z, x, (key - x) / n]);
      }
    }
    return tiles;
  }

  /* ══════════════════════════════════════════════════════════════════
     Storage quota
     ══════════════════════════════════════════════════════════════════ */

  /**
   * Would this fit? Unknown quota (older browsers) is treated as OK rather
   * than blocking the feature outright — the download tolerates failures, and
   * refusing on a missing API would deny the rider a map for no reason.
   */
  async function checkQuota(bytes) {
    const needed = bytes + QUOTA_HEADROOM_BYTES;
    if (!navigator.storage || !navigator.storage.estimate) {
      return { ok: true, unknown: true, needed };
    }
    try {
      const { quota = 0, usage = 0 } = await navigator.storage.estimate();
      const available = Math.max(0, quota - usage);
      return { ok: available >= needed, quota, usage, available, needed };
    } catch (_) {
      return { ok: true, unknown: true, needed };
    }
  }

  /* ══════════════════════════════════════════════════════════════════
     Talking to the service worker
     ══════════════════════════════════════════════════════════════════ */

  const COMMAND_TIMEOUT_MS = 20000;
  const progressListeners = new Set();
  let listening = false;

  function tileStyle() {
    // The planner only draws 'street' today (public/js/map.js), so that is what
    // gets downloaded. Reading the default from MapTiles keeps this honest if a
    // style switcher lands later.
    return window.MapTiles ? window.MapTiles.DEFAULT_STYLE : 'street';
  }

  function isSupported() {
    return !!(window.caches && navigator.serviceWorker);
  }

  /** Guests keep their trips in localStorage — see LocalDB in public/js/api.js. */
  function isGuest() {
    return !!(window.App && window.App.useCloud === false);
  }

  /**
   * Trip JSON worth pinning so the trip actually OPENS offline, not just its
   * map. Cloud only: a guest trip already lives in localStorage, which is
   * durable and offline by nature, so there is nothing to pin.
   *
   * Both URLs matter. /api/trips/:id is the trip itself (waypoints, journal and
   * route come embedded); /api/trips is the list the trip has to appear in for
   * a cold offline open to reach it at all.
   *
   * These must be byte-identical to the URLs API.request builds ('/api' +
   * '/trips/' + id, unencoded — see public/js/api.js) or the pinned copy will
   * not be the cache entry the page later looks up. Trip ids are UUIDs, so
   * there is nothing to escape.
   */
  function tripDataUrls(trip) {
    if (isGuest() || !trip?.id) return [];
    return [`/api/trips/${trip.id}`, '/api/trips'];
  }

  function ensureListening() {
    if (listening || !navigator.serviceWorker) return;
    listening = true;
    navigator.serviceWorker.addEventListener('message', (event) => {
      const data = event.data;
      if (!data || data.type !== 'ride:offline:progress' || !data.job) return;
      progressListeners.forEach((fn) => { try { fn(data.job); } catch (_) {} });
      window.dispatchEvent(new CustomEvent('ride:offline-progress', { detail: data.job }));
    });
  }

  function onProgress(fn) {
    ensureListening();
    progressListeners.add(fn);
    return () => progressListeners.delete(fn);
  }

  /**
   * One command, one reply, over a private MessageChannel. Progress does NOT
   * come back this way — it is broadcast to every open tab so a reload
   * mid-download reattaches instead of losing the bar.
   *
   * timeoutMs of 0 means no timeout, which is what a download needs.
   */
  async function command(type, payload, timeoutMs) {
    if (!isSupported()) throw fail('UNSUPPORTED', 'This browser cannot store offline maps.');
    const registration = await navigator.serviceWorker.ready;
    const worker = registration.active;
    if (!worker) throw fail('NO_WORKER', 'Offline maps need the app to finish installing. Try again in a moment.');
    ensureListening();

    return new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      const wait = timeoutMs === undefined ? COMMAND_TIMEOUT_MS : timeoutMs;
      const timer = wait > 0 ? setTimeout(() => {
        channel.port1.close();
        reject(fail('TIMEOUT', 'The offline download service stopped responding.'));
      }, wait) : null;
      channel.port1.onmessage = (event) => {
        if (timer) clearTimeout(timer);
        channel.port1.close();
        resolve(event.data);
      };
      worker.postMessage(Object.assign({ type }, payload), [channel.port2]);
    });
  }

  function fail(code, message) {
    return Object.assign(new Error(message), { code });
  }

  /* ══════════════════════════════════════════════════════════════════
     Public actions
     ══════════════════════════════════════════════════════════════════ */

  /**
   * Download one preset for one trip. Resolves when the last tile has landed
   * (or been given up on); watch onProgress() for the live count.
   *
   * Refusals happen here, before a single byte moves: over the tile cap, or
   * not enough storage quota left.
   */
  async function download(trip, presetId, est) {
    const plan = est && est.tripId === String(trip?.id) ? est : estimate(trip);
    const preset = plan.presets.find(p => p.id === presetId);
    if (!preset) throw fail('BAD_PRESET', 'Unknown detail level.');
    if (!plan.points.length) {
      throw fail('NO_ROUTE', 'This trip has no route or stops to download a map for yet.');
    }
    if (preset.overCap) {
      throw fail('OVER_CAP',
        `${preset.label} for this trip needs ${preset.partial ? 'over ' : 'about '}${formatCount(preset.tiles)} tiles — ` +
        `more than the ${formatCount(MAX_TILES)} tile limit. Pick a lower detail level, or split the trip into legs and download one leg at a time.`);
    }

    const quota = await checkQuota(preset.bytes);
    if (!quota.ok) {
      throw fail('NO_QUOTA',
        `Not enough free storage: ${preset.label} needs about ${formatBytes(preset.bytes)} and only ` +
        `${formatBytes(quota.available)} is available. Free some space or pick a lower detail level.`);
    }

    // Best-effort: ask the browser to treat our storage as persistent, so a
    // downloaded map is not first in line when the device gets tight. sw.js
    // asks on activate too; this is the moment it actually matters.
    try { await navigator.storage?.persist?.(); } catch (_) {}

    const style = tileStyle();
    const result = await command('ride:offline:download', {
      tripId: String(trip.id),
      tripName: trip.name || '',
      detail: preset.id,
      detailLabel: preset.label,
      style,
      urlTemplate: window.MapTiles.urlTemplate(style),
      tiles: tilesFor(plan, presetId),
      dataUrls: tripDataUrls(trip)
    }, 0);

    if (!result || !result.ok) {
      if (result?.reason === 'cancelled') throw fail('CANCELLED', 'Download cancelled.');
      if (result?.reason === 'already-downloaded') {
        throw fail('ALREADY_DOWNLOADED', 'This trip is already downloaded. Delete it first to change the detail level.');
      }
      if (result?.reason === 'in-progress') throw fail('IN_PROGRESS', 'This trip is already downloading.');
      throw fail('DOWNLOAD_FAILED', 'The download could not be completed.');
    }
    return result.entry;
  }

  async function cancel(tripId) {
    const result = await command('ride:offline:cancel', { tripId: String(tripId || '') });
    return !!result?.ok;
  }

  async function remove(tripId) {
    const result = await command('ride:offline:remove', { tripId: String(tripId || '') }, 60000);
    if (!result || !result.ok) throw fail('REMOVE_FAILED', 'Could not delete the offline map.');
    return result;
  }

  async function status() {
    const result = await command('ride:offline:status', {});
    return {
      entries: Array.isArray(result?.entries) ? result.entries : [],
      jobs: Array.isArray(result?.jobs) ? result.jobs : []
    };
  }

  async function statusFor(tripId) {
    const id = String(tripId || '');
    const { entries, jobs } = await status();
    return {
      entry: entries.find(e => e.tripId === id) || null,
      job: jobs.find(j => j.tripId === id) || null
    };
  }

  /* ══════════════════════════════════════════════════════════════════
     Formatting
     ══════════════════════════════════════════════════════════════════ */

  /** Decimal MB/GB — matches what a phone's storage settings screen shows. */
  function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1000) return `${Math.round(n)} B`;
    if (n < 1000 * 1000) return `${Math.round(n / 1000)} KB`;
    if (n < 1000 * 1000 * 1000) {
      const mb = n / (1000 * 1000);
      return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
    }
    return `${(n / (1000 * 1000 * 1000)).toFixed(1)} GB`;
  }

  function formatCount(n) {
    return (Number(n) || 0).toLocaleString();
  }

  window.OfflineMaps = {
    PRESETS,
    MIN_ZOOM,
    MAX_TILES,
    BYTES_PER_TILE,
    isSupported,
    isGuest,
    estimate,
    tilesFor,
    routePoints,
    checkQuota,
    download,
    cancel,
    remove,
    status,
    statusFor,
    onProgress,
    formatBytes,
    formatCount
  };
})(window);
