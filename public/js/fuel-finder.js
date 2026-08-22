/**
 * Fuel Finder — "Find fuel along the route"
 *
 * Reads the active route + FuelPlanner's fuel-range profile, asks
 * FuelPlanner.refuelSearchPoints (public/js/fuel.js, contract owned by the
 * fuel-overlay work) where along the route the tank would run low, and
 * looks up nearby petrol stations at (at most) the first two of those
 * points. Picking a result inserts it as a real waypoint — type 'fuel',
 * fuelStop true — through App.addWaypoint/App.reorderWaypoints (the same
 * canonical path waypoint-controller.js itself uses) so guest/cloud
 * storage, If-Match versioning, undo history and re-routing all behave
 * exactly as they do for any other waypoint edit.
 *
 * Entry points:
 *   - window.FuelFinder.openForRoute() — called by the fuel chip's second
 *     action button (public/js/map.js, owned by the fuel-overlay work).
 *   - #findFuelAlongRouteBtn inside the place-search modal (bound below),
 *     so the feature is discoverable from waypoint search too.
 *
 * No DOM ownership outside its own #fuelFinderModal (public/index.html) —
 * everything else is read from App/MapManager/FuelPlanner/Storage.
 */

// API.places gains a sibling method the same way ui-place-search.js and
// waypoint-controller.js extend UI/App from a file that doesn't own the
// object's definition: Object.assign onto the already-loaded global.
Object.assign(API.places, {
  /**
   * Nearby gas stations around a point, ranked by distance (api/places.js
   * searchFuel). Same LOGIN_REQUIRED contract as places.search — this can
   * never work for a local/guest session because the Places key only ever
   * lives server-side.
   */
  async searchFuel(lat, lng, radius) {
    if (API._isLocal()) {
      throw Object.assign(new Error('Sign in required'), { code: 'LOGIN_REQUIRED', action: 'find fuel stations' });
    }
    const params = new URLSearchParams({ lat: String(lat), lng: String(lng) });
    if (radius) params.set('radius', String(Math.round(radius)));
    const data = await API.request(`/places/fuel?${params}`, { quiet: true });
    return data.results || [];
  },
});

const FuelFinder = {
  _busy: false,
  _groups: [],       // last rendered [{ point, stations }]
  _coordinates: [],  // route coordinates the last search ran against

  /** Public entry point (contract §2/§discoverability) — see file header. */
  async openForRoute() {
    if (this._busy) return;
    this._busy = true;
    try {
      await this._run();
    } catch (err) {
      console.error('Fuel finder failed', err);
      UI.showToast('Could not search for fuel stations right now.', 'error');
    } finally {
      this._busy = false;
    }
  },

  async _run() {
    const app = window.App;
    const trip = app?.currentTrip;
    if (!trip) {
      UI.showToast('Plan a route before finding fuel.', 'info');
      return;
    }

    const settings = this._fuelSettings();
    if (!settings.enabled || !(settings.tankRangeKm > 0)) {
      UI.showToast('Turn on fuel planning and set your tank range in Settings first.', 'info');
      return;
    }

    const coordinates = this._activeRouteCoordinates();
    const waypoints = Array.isArray(trip.waypoints) ? trip.waypoints : [];
    if (coordinates.length < 2 || waypoints.length < 2) {
      UI.showToast('Plan a route with at least two stops first.', 'info');
      return;
    }

    if (typeof window.FuelPlanner?.computeProfile !== 'function' ||
        typeof window.FuelPlanner?.refuelSearchPoints !== 'function') {
      UI.showToast('Fuel finder is not available in this build.', 'error');
      return;
    }

    const state = typeof window.FuelPlanner.getState === 'function' ? window.FuelPlanner.getState() : null;
    const startPercent = Number.isFinite(state?.percent) ? state.percent : 100;
    const startAtIdx = (app.isRiding && Number.isFinite(app._rideNearIdx)) ? app._rideNearIdx : 0;

    const profile = window.FuelPlanner.computeProfile({
      coordinates,
      waypoints,
      tankRangeKm: settings.tankRangeKm,
      startPercent,
      startAtIdx,
    });
    if (!profile || !profile.totalKm) {
      UI.showToast('Could not read the route for a fuel search.', 'error');
      return;
    }

    const points = window.FuelPlanner.refuelSearchPoints(profile, coordinates) || [];
    if (!points.length) {
      UI.showToast('Your route already has enough fuel stops planned.', 'info');
      return;
    }

    // Guests never reach the Places proxy — short-circuit before opening a
    // modal that would otherwise sit there loading forever.
    if (API._isLocal()) {
      UI.suggestLogin('find fuel stations along your route');
      return;
    }

    // Cap searches at 2 points to protect the shared weekly/monthly quota
    // (api/places.js) — each point can cost up to 2 requests (15km, then a
    // 40km widen if the first comes back empty).
    const searchPoints = points.slice(0, 2);
    this._coordinates = coordinates;
    this._openLoadingModal(searchPoints.length);

    const groups = [];
    let quotaOrAuthError = null;
    for (const point of searchPoints) {
      if (quotaOrAuthError) break;
      try {
        groups.push({ point, stations: await this._searchNear(point) });
      } catch (err) {
        if (err?.code === 'LOGIN_REQUIRED' || err?.status === 429) {
          quotaOrAuthError = err;
        } else {
          console.error('Fuel station search failed', err);
          groups.push({ point, stations: [] });
        }
      }
    }

    if (quotaOrAuthError) {
      this._closeModal();
      if (quotaOrAuthError.code === 'LOGIN_REQUIRED') {
        UI.suggestLogin('find fuel stations along your route');
      } else {
        UI.showToast(quotaOrAuthError.message || 'Weekly place-search limit reached. Resets Monday.', 'error');
      }
      return;
    }

    this._render(groups);
  },

  /** Radius ~15km first; widen once to ~40km if that comes back empty. */
  async _searchNear(point) {
    let stations = await API.places.searchFuel(point.lat, point.lng, 15000);
    if (!stations.length) stations = await API.places.searchFuel(point.lat, point.lng, 40000);
    return stations;
  },

  _render(groups) {
    this._groups = groups;
    const resultsEl = document.getElementById('fuelFinderResults');
    const statusEl = document.getElementById('fuelFinderStatus');
    if (!resultsEl || !statusEl) return;

    const total = groups.reduce((n, g) => n + (g.stations?.length || 0), 0);
    if (!total) {
      statusEl.textContent = 'No fuel stations found near your route.';
      resultsEl.innerHTML = '<div class="microcopy">Try zooming into that stretch of the map and adding a fuel stop manually.</div>';
      return;
    }

    statusEl.textContent = `Found ${total} fuel station${total === 1 ? '' : 's'} near your route.`;
    // Read at arm's length, one-handed, often gloved: every tap target below
    // is pinned to at least --touch-target (44px) via inline style, since
    // this module can't touch app.css to widen the shared .secondary-btn/
    // .link-btn classes without affecting every other caller of them.
    resultsEl.innerHTML = groups.map((group, gi) => {
      if (!group.stations.length) return '';
      const km = Math.round(group.point.kmFromStart || 0);
      const header = `<div class="microcopy" style="margin-top:10px;font-weight:600;font-size:0.95rem;color:var(--text-secondary);">~${km} km into your ride</div>`;
      const items = group.stations.map((station, si) => {
        const offRouteKm = this._distanceKm(group.point, station.location);
        const context = offRouteKm != null ? `~${offRouteKm} km off-route · ~${km} km into your ride` : `~${km} km into your ride`;
        return `
          <div class="place-result" style="padding:16px;">
            <div class="place-result-main">
              <div class="place-name" style="font-size:1.05rem;">${UI.escapeHtml(station.name || 'Fuel station')}</div>
              ${station.rating ? `<div class="place-rating">★ ${Number(station.rating).toFixed(1)}</div>` : ''}
            </div>
            <div class="place-address">${UI.escapeHtml(station.address || '')}</div>
            <div class="microcopy" style="font-size:0.95rem;color:var(--text-secondary);">${UI.escapeHtml(context)}</div>
            <div class="place-actions" style="gap:12px;margin-top:4px;">
              <button type="button" class="secondary-btn" style="min-height:var(--touch-target);padding:12px 22px;font-size:0.95rem;display:inline-flex;align-items:center;justify-content:center;" data-fuel-group="${gi}" data-fuel-station="${si}">Use this stop</button>
              <button type="button" class="link-btn" style="min-height:var(--touch-target);padding:12px 16px;display:inline-flex;align-items:center;justify-content:center;" data-fuel-preview-group="${gi}" data-fuel-preview-station="${si}">Show on map</button>
            </div>
          </div>`;
      }).join('');
      return header + items;
    }).join('');

    resultsEl.querySelectorAll('[data-fuel-group]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const group = this._groups[Number(btn.dataset.fuelGroup)];
        const station = group?.stations?.[Number(btn.dataset.fuelStation)];
        if (station) this._useStation(station, group.point);
      });
    });
    resultsEl.querySelectorAll('[data-fuel-preview-group]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const group = this._groups[Number(btn.dataset.fuelPreviewGroup)];
        const station = group?.stations?.[Number(btn.dataset.fuelPreviewStation)];
        if (!station?.location) return;
        MapManager.map?.setView([station.location.lat, station.location.lng], Math.max(MapManager.map.getZoom() || 12, 14));
        MapManager.showTempLocation?.(station.location.lat, station.location.lng);
      });
    });
  },

  /**
   * Add the chosen station as a fuel-stop waypoint at the correct position:
   * immediately before the first existing waypoint whose along-route
   * distance exceeds the search point's kmFromStart. Uses App.addWaypoint
   * for the write itself (guest/cloud, If-Match, undo, re-route) and only
   * follows up with App.reorderWaypoints — also canonical — when the
   * natural append position isn't already correct (api/waypoints.js
   * addWaypoint always appends at the end; see App.addWaypointOnRoute in
   * waypoint-controller.js for the same pattern).
   *
   * A leg-break divider counts as a candidate boundary here, same as a real
   * stop — map.js's _splitIntoLegs routes each leg independently, so a fuel
   * stop found to be needed in leg N must never be spliced in AFTER that
   * leg's closing divider (it would silently land in leg N+1's segment,
   * leaving leg N exactly as fuel-starved as before). Only 'via' points are
   * skipped as candidates: they shape the route but never bound a leg.
   */
  async _useStation(station, point) {
    const app = window.App;
    const trip = app?.currentTrip;
    if (!trip || !station?.location) return;
    this._closeModal();

    const ordered = (trip.waypoints || []).slice().sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
    const coordinates = this._coordinates.length ? this._coordinates : this._activeRouteCoordinates();
    const cumKm = this._cumulativeKm(coordinates);

    let beforeId = null;
    for (const wp of ordered) {
      if (!wp || wp.type === 'via') continue;
      const km = this._kmFromStartForWaypoint(wp, coordinates, cumKm);
      if (km != null && km > point.kmFromStart) { beforeId = wp.id; break; }
    }

    const waypoint = await app.addWaypoint({
      name: station.name || 'Fuel stop',
      address: station.address || '',
      lat: station.location.lat,
      lng: station.location.lng,
      type: 'fuel',
      fuelStop: true,
    });
    if (!waypoint) return; // App.addWaypoint already reported the failure

    if (beforeId && beforeId !== waypoint.id) {
      const targetIds = ordered.map((w) => w.id);
      const insertIdx = targetIds.indexOf(beforeId);
      if (insertIdx >= 0) {
        targetIds.splice(insertIdx, 0, waypoint.id);
        const currentIds = (trip.waypoints || []).map((w) => w.id);
        if (JSON.stringify(currentIds) !== JSON.stringify(targetIds)) {
          await app.reorderWaypoints(targetIds);
        }
      }
    }

    // Contract §3 — the fuel-stop write above already flags fuelStop true,
    // but the overlay only re-draws on this event (same one the manual
    // "fuel stop" toggle dispatches in waypoint-controller.js).
    window.dispatchEvent(new CustomEvent('ride:fuelStopsChanged', { detail: { waypointId: waypoint.id, fuelStop: true } }));
    UI.showToast(`${station.name || 'Fuel stop'} added to your route`, 'success');
  },

  /* --- small helpers (self-contained on purpose — see fuel.js's own header) --- */

  _fuelSettings() {
    const raw = (window.Storage?.load && window.Storage.load(window.Storage.KEYS.SETTINGS, {})) || {};
    return {
      enabled: !!raw.fuelPlanningEnabled,
      tankRangeKm: Number(raw.fuelTankRangeKm) || 0,
    };
  },

  /**
   * The route currently on screen. MapManager._activeRouteCoordinates (an
   * underscore-prefixed convention, not a real private member) already
   * accounts for the selected alternative and a live ride's route replay —
   * reproducing that logic here would just drift from it. Falls back to the
   * trip's stored route if MapManager isn't ready yet for any reason.
   */
  _activeRouteCoordinates() {
    if (typeof MapManager?._activeRouteCoordinates === 'function') {
      const coords = MapManager._activeRouteCoordinates();
      if (Array.isArray(coords) && coords.length >= 2) return coords;
    }
    const raw = window.App?.currentTrip?.route?.coordinates;
    if (!Array.isArray(raw)) return [];
    return raw.map((c) => (Array.isArray(c)
      ? { lat: Number(c[0]), lng: Number(c[1]) }
      : { lat: Number(c?.lat), lng: Number(c?.lng) }))
      .filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lng));
  },

  _haversineKm(a, b) {
    const toRad = (v) => (v * Math.PI) / 180;
    const R = 6371;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  },

  _cumulativeKm(coordinates) {
    const cum = new Array(coordinates.length).fill(0);
    for (let i = 1; i < coordinates.length; i++) {
      cum[i] = cum[i - 1] + this._haversineKm(coordinates[i - 1], coordinates[i]);
    }
    return cum;
  },

  /** Nearest-coordinate snap over the WHOLE route, same technique FuelPlanner.computeProfile uses for fill points. */
  _kmFromStartForWaypoint(wp, coordinates, cumKm) {
    if (!wp || typeof wp.lat !== 'number' || typeof wp.lng !== 'number' || !coordinates?.length) return null;
    let bestIdx = -1;
    let bestD = Infinity;
    for (let i = 0; i < coordinates.length; i++) {
      const d = this._haversineKm(wp, coordinates[i]);
      if (d < bestD) { bestD = d; bestIdx = i; }
    }
    return bestIdx >= 0 ? cumKm[bestIdx] : null;
  },

  _distanceKm(point, location) {
    if (!point || !location) return null;
    return Math.round(this._haversineKm({ lat: point.lat, lng: point.lng }, location) * 10) / 10;
  },

  _openLoadingModal(pointCount) {
    const resultsEl = document.getElementById('fuelFinderResults');
    const statusEl = document.getElementById('fuelFinderStatus');
    if (resultsEl) resultsEl.innerHTML = '<div class="microcopy">Searching for fuel stations near your route…</div>';
    if (statusEl) statusEl.textContent = `Searching near ${pointCount} point${pointCount === 1 ? '' : 's'} on your route…`;
    UI.openModal('fuelFinderModal');
  },

  _closeModal() {
    UI.closeModal('fuelFinderModal');
  },
};

window.FuelFinder = FuelFinder;
