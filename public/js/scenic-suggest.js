/**
 * Scenic Suggest — famous-road suggestion chips.
 *
 * Self-contained, event-driven module. Listens for the shared
 * 'ride:routeComputed' window event (fired whenever the active route's
 * geometry changes — single-leg or multi-leg, initial compute or reroute)
 * and, when the route passes near a curated famous road, shows one
 * dismissible chip offering to weave that road's shape points into the
 * route as 'via' waypoints.
 *
 * Fully guest-safe: only touches App.currentTrip / App.addWaypointOnRoute,
 * both of which behave identically for guest (localStorage) and cloud
 * trips. Never shown during a ride (App.isRiding) and never more than one
 * chip at a time. No index.html changes required — the chip's DOM is built
 * and appended at runtime.
 */
(function (window) {
  'use strict';

  const DATA_URL = '/data/scenic-roads-au.json';
  // A famous road's *entry* point within this distance of any route vertex
  // counts as "near the route". Approximate on purpose — this is a
  // suggestion trigger, not turn-by-turn matching.
  const CORRIDOR_THRESHOLD_M = 40000; // ~40 km
  // Per-trip suppression list: road ids the rider has already dismissed OR
  // already accepted (accepting weaves the road into the route, so it would
  // otherwise re-match itself as "near the route" forever). This key is
  // deliberately NOT declared in Storage.KEYS — that map is owned by
  // another agent in this pass — but it follows the same ride_* + per-trip
  // suffix convention already used elsewhere (e.g. ride_leg_collapse_<id>).
  // See findings: a future pass should add it to storage.js's documented
  // keyspace comment.
  const DISMISSED_KEY_PREFIX = 'ride_scenic_dismissed_';
  // Coalesce bursts of route-computed events (e.g. several waypoint edits
  // in quick succession) into a single corridor check.
  const DEBOUNCE_MS = 150;

  let roadsPromise = null;
  let chipEl = null;
  let activeRoadId = null;
  let lastTripId = null;
  let debounceTimer = null;
  // Set while handleAccept() is chaining sequential inserts for a road, so
  // the route-recompute events that chaining itself triggers don't re-show
  // (or re-flicker) a chip for the very road being inserted.
  let insertingRoadId = null;

  /* ------------------------------------------------------------------ */
  /* Geometry                                                            */
  /* ------------------------------------------------------------------ */

  /** Haversine distance in meters. Delegates to RideUtils when available;
   *  falls back to a local copy so this module never hard-fails if script
   *  load order ever changes (defensive only — utils.js loads first today). */
  function distanceMeters(a, b) {
    if (window.RideUtils && typeof RideUtils.haversine === 'function') {
      return RideUtils.haversine(a, b);
    }
    const toRad = (v) => (v * Math.PI) / 180;
    const R = 6371000;
    const dLat = toRad((b.lat || 0) - (a.lat || 0));
    const dLng = toRad((b.lng || 0) - (a.lng || 0));
    const lat1 = toRad(a.lat || 0);
    const lat2 = toRad(b.lat || 0);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  /**
   * Cheapest possible point-to-polyline distance: a nearest-vertex scan.
   * The route has at most a few hundred vertices and the road list has
   * ~20 entries, so a per-vertex haversine scan is plenty fast — no need
   * for real point-to-segment projection here.
   */
  function minDistanceToRoute(point, routeCoords) {
    let best = Infinity;
    for (let i = 0; i < routeCoords.length; i++) {
      const d = distanceMeters(point, routeCoords[i]);
      if (d < best) {
        best = d;
        if (best === 0) break;
      }
    }
    return best;
  }

  /** Nearest current waypoint to a given point (used to anchor insertion). */
  function findNearestWaypoint(waypoints, point) {
    let best = null;
    let bestDist = Infinity;
    for (const wp of waypoints) {
      const lat = Number(wp?.lat);
      const lng = Number(wp?.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const d = distanceMeters(point, { lat, lng });
      if (d < bestDist) {
        bestDist = d;
        best = wp;
      }
    }
    return best;
  }

  /* ------------------------------------------------------------------ */
  /* Data — loaded once, cached in memory                                */
  /* ------------------------------------------------------------------ */

  function loadRoads() {
    if (!roadsPromise) {
      roadsPromise = fetch(DATA_URL)
        .then((res) => (res && res.ok ? res.json() : []))
        .then((data) => (Array.isArray(data) ? data : []))
        .catch((err) => {
          console.error('ScenicSuggest: failed to load scenic-roads-au.json', err);
          return [];
        });
    }
    return roadsPromise;
  }

  /* ------------------------------------------------------------------ */
  /* Per-trip suppression list (dismissed + already-accepted roads)      */
  /* ------------------------------------------------------------------ */

  function suppressedKey(tripId) {
    return `${DISMISSED_KEY_PREFIX}${tripId}`;
  }

  function getSuppressed(tripId) {
    if (!tripId) return [];
    if (window.Storage && typeof Storage.load === 'function') {
      const list = Storage.load(suppressedKey(tripId), []);
      return Array.isArray(list) ? list : [];
    }
    try {
      const raw = localStorage.getItem(suppressedKey(tripId));
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }

  function addSuppressed(tripId, roadId) {
    if (!tripId || !roadId) return;
    const list = getSuppressed(tripId);
    if (list.indexOf(roadId) !== -1) return;
    list.push(roadId);
    if (window.Storage && typeof Storage.save === 'function') {
      Storage.save(suppressedKey(tripId), list);
    } else {
      try {
        localStorage.setItem(suppressedKey(tripId), JSON.stringify(list));
      } catch (_) { /* best effort — a missed suppression just re-shows the chip once */ }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Matching                                                             */
  /* ------------------------------------------------------------------ */

  /** Closest not-yet-suppressed road whose entry point is within the
   *  corridor threshold of the route. Returns null when nothing matches. */
  function findClosestMatch(roads, routeCoords, suppressedIds) {
    let best = null;
    let bestDist = Infinity;
    roads.forEach((road) => {
      const entry = road && road.entry;
      const lat = Number(entry?.lat);
      const lng = Number(entry?.lng);
      if (!road?.id || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
      if (suppressedIds.indexOf(road.id) !== -1) return;
      if (road.id === insertingRoadId) return;
      const dist = minDistanceToRoute({ lat, lng }, routeCoords);
      if (dist <= CORRIDOR_THRESHOLD_M && dist < bestDist) {
        bestDist = dist;
        best = road;
      }
    });
    return best;
  }

  /* ------------------------------------------------------------------ */
  /* Chip UI                                                              */
  /* ------------------------------------------------------------------ */

  function removeChip() {
    if (chipEl && chipEl.parentNode) chipEl.parentNode.removeChild(chipEl);
    chipEl = null;
    activeRoadId = null;
  }

  /**
   * All styling is inline (style.cssText), mirroring route-selector.js's
   * buildBadge() defensive pattern: the chip must look right even before a
   * dedicated stylesheet rule exists for .scenic-chip. Every color comes
   * from a tokens.css var() reference with a literal fallback.
   *
   * Class contract for a future CSS pass: .scenic-chip (wrapper),
   * .scenic-chip-text (name + blurb), .scenic-chip-accept (accept button),
   * .scenic-chip-dismiss (44px close button).
   */
  function buildChip(road) {
    const wrap = document.createElement('div');
    wrap.className = 'scenic-chip';
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Scenic road suggestion');
    wrap.style.cssText = [
      'position:fixed',
      'left:50%',
      'transform:translateX(-50%)',
      'top:calc(var(--header-height, 56px) + var(--safe-area-top, 0px) + 10px)',
      'z-index:var(--z-chrome, 900)',
      'display:flex',
      'align-items:center',
      'gap:10px',
      'max-width:min(92vw, 420px)',
      'width:max-content',
      'background:var(--bg-glass, rgba(18,22,46,0.82))',
      'border:1px solid var(--border-elegant, rgba(255,255,255,0.11))',
      'border-radius:var(--radius-lg, 14px)',
      'box-shadow:var(--shadow-2, 0 4px 20px rgba(0,0,0,0.3))',
      '-webkit-backdrop-filter:blur(16px) saturate(1.3)',
      'backdrop-filter:blur(16px) saturate(1.3)',
      'padding:10px 8px 10px 14px',
      'color:var(--text-primary, #f4f5fb)',
      'font-family:var(--font-sans, sans-serif)'
    ].join(';');

    const text = document.createElement('div');
    text.className = 'scenic-chip-text';
    text.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;';

    const nameEl = document.createElement('span');
    nameEl.style.cssText = [
      'font-weight:600',
      `font-size:var(--text-sm, 0.875rem)`,
      'overflow:hidden',
      'text-overflow:ellipsis',
      'white-space:nowrap'
    ].join(';');
    nameEl.textContent = `${road.name} is near your route`;
    text.appendChild(nameEl);

    if (road.blurb) {
      const blurbEl = document.createElement('span');
      blurbEl.style.cssText = [
        'font-size:var(--text-xs, 0.75rem)',
        'color:var(--text-secondary, #aab1d0)',
        'overflow:hidden',
        'text-overflow:ellipsis',
        'display:-webkit-box',
        '-webkit-line-clamp:2',
        '-webkit-box-orient:vertical'
      ].join(';');
      blurbEl.textContent = road.blurb;
      text.appendChild(blurbEl);
    }
    wrap.appendChild(text);

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;align-items:center;gap:4px;flex-shrink:0;';

    const acceptBtn = document.createElement('button');
    acceptBtn.type = 'button';
    acceptBtn.className = 'scenic-chip-accept';
    acceptBtn.textContent = 'Take it';
    acceptBtn.style.cssText = [
      'background:var(--accent, #6366f1)',
      'color:var(--text-on-accent, #fff)',
      'border:none',
      'border-radius:var(--radius, 10px)',
      'padding:0 14px',
      'height:40px',
      'min-width:44px',
      'font-size:var(--text-sm, 0.875rem)',
      'font-weight:600',
      'cursor:pointer',
      'white-space:nowrap'
    ].join(';');
    acceptBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleAccept(road);
    });
    actions.appendChild(acceptBtn);

    const dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.className = 'scenic-chip-dismiss';
    dismissBtn.setAttribute('aria-label', `Dismiss ${road.name} suggestion`);
    dismissBtn.textContent = '×';
    dismissBtn.style.cssText = [
      'width:44px',
      'height:44px',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'background:transparent',
      'border:none',
      'color:var(--text-muted, #7e86ad)',
      'font-size:22px',
      'line-height:1',
      'cursor:pointer',
      'border-radius:50%',
      'flex-shrink:0'
    ].join(';');
    dismissBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleDismiss(road);
    });
    actions.appendChild(dismissBtn);

    wrap.appendChild(actions);

    // This chip floats over the map, same as the route-selector bar —
    // gesture-starts on it must not fall through to Leaflet underneath.
    ['pointerdown', 'touchstart', 'mousedown'].forEach((type) =>
      wrap.addEventListener(type, (e) => e.stopPropagation()));

    return wrap;
  }

  function showChip(road) {
    if (activeRoadId === road.id && chipEl) return; // already showing this one
    removeChip();
    const host = document.getElementById('app') || document.body;
    const chip = buildChip(road);
    host.appendChild(chip);
    chipEl = chip;
    activeRoadId = road.id;
  }

  /* ------------------------------------------------------------------ */
  /* Actions                                                              */
  /* ------------------------------------------------------------------ */

  async function handleAccept(road) {
    const app = window.App;
    if (!app || !app.currentTrip || typeof app.addWaypointOnRoute !== 'function') {
      removeChip();
      return;
    }
    const tripId = app.currentTrip.id;
    const waypoints = Array.isArray(app.currentTrip.waypoints) ? app.currentTrip.waypoints : [];
    const entry = road.entry || {};
    const anchor = findNearestWaypoint(waypoints, { lat: Number(entry.lat), lng: Number(entry.lng) });
    let insertAfterId = anchor ? anchor.id : null;
    const shape = Array.isArray(road.shape) ? road.shape : [];

    // Remove the chip immediately: each insert below triggers its own
    // route recompute (and a fresh 'ride:routeComputed' event), so the
    // corridor check must not re-match this same road mid-insertion.
    removeChip();
    insertingRoadId = road.id;

    let insertedCount = 0;
    try {
      for (const pt of shape) {
        const lat = Number(pt?.lat);
        const lng = Number(pt?.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        // Per contract: call the existing App.addWaypointOnRoute for each
        // shape point in sequence, chaining insertAfterWaypointId onto the
        // id it just created so points land in order.
        const inserted = await app.addWaypointOnRoute({
          lat,
          lng,
          insertAfterWaypointId: insertAfterId,
          type: 'via',
          name: 'Shape point'
        });
        if (inserted && inserted.id) {
          insertAfterId = inserted.id;
          insertedCount += 1;
        } else {
          break; // insertion failed (offline / conflict / read-only) — stop chaining
        }
      }
    } finally {
      insertingRoadId = null;
    }

    if (insertedCount > 0) {
      // The road is now woven into the route — its entry point will keep
      // matching the corridor check forever otherwise, so treat "accepted"
      // the same as "dismissed" for suggestion purposes.
      addSuppressed(tripId, road.id);
      if (window.UI && typeof UI.showToast === 'function') {
        UI.showToast(`${road.name} added to your route`, 'success');
      }
    } else if (shape.length > 0 && window.UI && typeof UI.showToast === 'function') {
      UI.showToast(`Could not add ${road.name}`, 'error');
    }
  }

  function handleDismiss(road) {
    const app = window.App;
    const tripId = app && app.currentTrip && app.currentTrip.id;
    addSuppressed(tripId, road.id);
    removeChip();
  }

  /* ------------------------------------------------------------------ */
  /* Corridor check — the 'ride:routeComputed' handler                   */
  /* ------------------------------------------------------------------ */

  function runCorridorCheck() {
    const app = window.App;
    if (!app || app.isRiding) return; // never during a ride

    const trip = app.currentTrip;
    if (!trip || !trip.id) {
      removeChip();
      return;
    }
    if (trip.id !== lastTripId) {
      removeChip();
      lastTripId = trip.id;
    }

    const waypoints = Array.isArray(trip.waypoints) ? trip.waypoints : [];
    if (waypoints.length < 2) {
      removeChip();
      return;
    }
    const coords = trip.route && Array.isArray(trip.route.coordinates) ? trip.route.coordinates : [];
    if (!coords.length) {
      removeChip();
      return;
    }

    loadRoads().then((roads) => {
      if (!roads.length) return;
      // Re-validate: this resolves after an async fetch, and the rider may
      // have started a ride, switched trips, or cleared the route meanwhile.
      const app2 = window.App;
      if (!app2 || app2.isRiding) return;
      const t2 = app2.currentTrip;
      if (!t2 || t2.id !== trip.id) return;
      const wps2 = Array.isArray(t2.waypoints) ? t2.waypoints : [];
      if (wps2.length < 2) return;
      const coords2 = t2.route && Array.isArray(t2.route.coordinates) ? t2.route.coordinates : [];
      if (!coords2.length) return;

      const suppressed = getSuppressed(t2.id);
      const match = findClosestMatch(roads, coords2, suppressed);
      if (!match) {
        removeChip();
        return;
      }
      showChip(match);
    });
  }

  function onRouteComputed() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      runCorridorCheck();
    }, DEBOUNCE_MS);
  }

  window.addEventListener('ride:routeComputed', onRouteComputed);

  // Exposed for debugging / CDP test scripts only — nothing in the app
  // calls these; the module is otherwise fully event-driven.
  window.ScenicSuggest = {
    _check: runCorridorCheck,
    _removeChip: removeChip
  };
})(window);
