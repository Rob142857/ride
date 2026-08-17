/**
 * Map module — Leaflet map, markers, routing, controls
 * Ride GPS tracking is in map-ride.js
 *
 * Routing owns its own OSRM calls (L.Routing.osrmv1 router, no L.Routing.control)
 * and draws its own polylines, so nothing depends on Leaflet Routing Machine
 * private state. Every request carries a generation stamp; responses from a
 * superseded request are dropped.
 */
const MapManager = {
  map: null,

  // Self-hosted OSRM routing endpoint (Cloudflare Tunnel → Docker)
  OSRM_SERVICE_URL: 'https://maps.incitat.io/route/v1',

  /**
   * Route line colors. Leaflet needs literal color values, so these mirror the
   * design tokens in public/css/tokens.css and are only used when the live
   * custom property cannot be read. Keep in sync with tokens.css.
   */
  ROUTE_COLORS: {
    route: '#f59e0b',                 /* --route        gold — the golden route */
    casing: 'rgba(11, 14, 31, 0.55)', /* --route-casing dark outline */
    alt: '#8b97b8',                   /* --route-alt    unselected alternatives */
    via: '#8b97b8'                    /* --wp-via       shaping points */
  },

  /** Fallback literals for the fuel-range warning bands — mirrors tokens.css (see ROUTE_COLORS above). */
  FUEL_COLORS: {
    warn: '#fb923c',     /* --fuel-warn */
    low: '#ea580c',      /* --fuel-low */
    critical: '#ef4444'  /* --fuel-critical → --danger */
  },

  waypointMarkers: {},
  isAddingWaypoint: false,
  pendingLocation: null,
  tempMarker: null,
  rideWatchId: null,
  rideMarker: null,
  rideHeading: null,
  rideAccuracyCircle: null,
  ridePositionCb: null,
  _wakeLock: null,
  _gpsRetryTimer: null,

  /* ── Routing state ─────────────────────────────────────────────── */
  _planRouter: null,
  _planRouterAvoidMotorways: null, // separate cached LRM instance — requestParameters is baked in at construction, not per-request
  _routeGen: 0,               // generation stamp — stale responses are ignored
  _routeXhr: null,            // in-flight OSRM request (abortable)
  _ghAbortController: null,   // in-flight windy (GraphHopper proxy) fetch (abortable)
  _routeDebounceTimer: null,
  _routeLayers: [],           // app-owned polylines, one entry per route
  _cachedAlternatives: [],    // normalized route objects
  _selectedRouteIndex: 0,
  _lastRoutedWaypoints: [],
  _restoredTripKey: null,     // trip whose saved route we already restored
  _routeErrorAt: 0,

  /* ── Fuel overlay state (public/js/fuel.js supplies the math) ─────── */
  _fuelLayers: [],            // app-owned polylines + fill circleMarkers, mirrors _routeLayers
  _fuelChipEl: null,          // the floating "runs dry" warning chip, if shown
  _fuelChipSignature: null,   // identifies the dry point currently being warned about
  _fuelChipDismissedFor: null, // signature the rider closed — suppressed until it changes
  _fuelChipShownFor: null,    // signature of the chip currently in the DOM (rebuild when it moves)

  // Extracted UI components
  routeSelector: null,
  routeEditor: null,

  // Waypoint type icons. Colors come from tokens.css; the hex is the fallback.
  waypointIcons: {
    stop:    { token: '--wp-stop',    color: '#6366f1', icon: '📍' },
    scenic:  { token: '--wp-scenic',  color: '#10b981', icon: '🏞️' },
    fuel:    { token: '--wp-fuel',    color: '#fbbf24', icon: '⛽' },
    food:    { token: '--wp-food',    color: '#f97316', icon: '🍽️' },
    lodging: { token: '--wp-lodging', color: '#8b5cf6', icon: '🏨' },
    custom:  { token: '--wp-custom',  color: '#06b6d4', icon: '⭐' },
    // Shaping point — quiet by design; the list uses the glyph, the map a dot.
    via:     { token: '--wp-via',     color: '#8b97b8', icon: '•' }
  },

  /** Read a design token off :root with a hard fallback (Leaflet needs literal colors). */
  _cssVar(name, fallback) {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch (_) {
      return fallback;
    }
  },

  /**
   * Initialize the map
   */
  init() {
    // Create map centered on Colinroobie, NSW
    this.map = L.map('map', {
      zoomControl: false,
      attributionControl: true
    }).setView([-34.5386, 146.5933], 12);

    // Basemap comes from the shared MapTiles module (public/js/map-tiles.js), so
    // the planner and the public share page draw the same tiles through the same
    // cached proxy. 'street' keeps the planner's existing look: the OpenStreetMap
    // default renderer, strong road / topology detail.
    window.MapTiles?.createLayer('street')?.addTo(this.map);

    // Add zoom control to bottom left (away from nav)
    L.control.zoom({ position: 'bottomleft' }).addTo(this.map);

    // Map click handler for adding waypoints
    this.map.on('click', (e) => this.handleMapClick(e));

    // Accessible route-alternatives UI and visible midpoint route editor.
    this.routeSelector = window.RouteSelector?.create(this.map, {
      position: 'top',
      onSelect: (idx) => this._selectRoute(idx)
    });
    this.routeSelector?.onModeChange((state) => this._onRouteModeChange(state));
    this.routeEditor = window.RouteEditor?.create(this.map);
    this.routeEditor?.onInsertWaypoint((detail) => {
      if (typeof App.addWaypointOnRoute === 'function') {
        App.addWaypointOnRoute(detail);
      }
    });

    // Handle resize
    window.addEventListener('resize', () => {
      this.map.invalidateSize();
    });

    // Resize markers + route line on zoom change
    this.map.on('zoomend', () => {
      // Refresh waypoint marker icons at new zoom size
      Object.keys(this.waypointMarkers).forEach(id => {
        const marker = this.waypointMarkers[id];
        if (marker?._wpType) marker.setIcon(this.createIcon(marker._wpType));
      });
      if (this._routeLayers.length) this._restyleRoutes();
      // Fuel overlay has no in-place restyle (§ refreshFuelOverlay doc) — a
      // full recompute is cheap and only actually redraws when there is
      // something to draw, so only bother when it already drew something.
      if (this._fuelLayers.length || this._fuelChipEl) this.refreshFuelOverlay();
    });

    // Fuel planning is entirely event-driven from here — settings/markup and
    // fuel.js own the triggers, this module only reacts (contract §5/§6).
    window.addEventListener('ride:routeComputed', () => this.refreshFuelOverlay());
    window.addEventListener('ride:fuelStopsChanged', () => this.refreshFuelOverlay());
    window.addEventListener('ride:fuelSettingsChanged', () => this.refreshFuelOverlay());

    return this;
  },

  /**
   * Locate user and center map
   */
  locateUser(options = {}) {
    const toast = !!options.toast;
    const animate = options.animate !== false;
    const desiredZoom = Number.isFinite(options.zoom)
      ? options.zoom
      : Math.max((this.map?.getZoom?.() || 13), 14);

    return new Promise((resolve, reject) => {
      if (!('geolocation' in navigator)) {
        if (toast) UI.showToast('Location not available on this device', 'error');
        reject(new Error('Geolocation not supported'));
        return;
      }

      navigator.geolocation.getCurrentPosition(
        (position) => {
          const { latitude, longitude } = position.coords;
          if (this.map) {
            this.map.setView([latitude, longitude], desiredZoom, { animate });
          }
          resolve({ lat: latitude, lng: longitude });
        },
        (error) => {
          if (toast) {
            const msg = error?.code === 1
              ? 'Location permission denied'
              : 'Unable to get your location';
            UI.showToast(msg, 'error');
          }
          reject(error);
        },
        { enableHighAccuracy: true, timeout: 10000 }
      );
    });
  },

  /**
   * Handle map click
   */
  handleMapClick(e) {
    if (this.isAddingWaypoint) {
      this.pendingLocation = { lat: e.latlng.lat, lng: e.latlng.lng };

      // Update the modal inputs if open
      const latInput = document.getElementById('waypointLat');
      const lngInput = document.getElementById('waypointLng');
      const modal = document.getElementById('waypointModal');
      if (modal && modal.classList.contains('hidden')) {
        UI.openModal('waypointModal');
      }
      if (latInput && lngInput) {
        latInput.value = e.latlng.lat.toFixed(6);
        lngInput.value = e.latlng.lng.toFixed(6);
      }
      const nameInput = document.getElementById('waypointName');
      if (nameInput && !nameInput.value.trim()) {
        const nextNum = (App.currentTrip?.waypoints?.length || 0) + 1;
        nameInput.value = `Waypoint ${nextNum}`;
      }
      UI.setWaypointPlannerState('selected', 'Pinned on the map. Add any details, then save the waypoint.');

      // Show temporary marker
      if (this.tempMarker) {
        this.tempMarker.setLatLng(e.latlng);
      } else {
        this.tempMarker = L.marker(e.latlng, {
          icon: this.createIcon('custom')
        }).addTo(this.map);
      }
    }
  },

  /**
   * Enable waypoint adding mode
   */
  enableAddWaypointMode() {
    this.isAddingWaypoint = true;
    this.map.getContainer().style.cursor = 'crosshair';
    document.body.classList.add('map-pick-mode');
    UI.setWaypointPlannerState('pick', 'Tap anywhere on the map to position the next waypoint.');
    UI.showToast('Tap on map to set location', 'info');
  },

  /**
   * Disable waypoint adding mode
   */
  disableAddWaypointMode() {
    this.isAddingWaypoint = false;
    this.map.getContainer().style.cursor = '';
    this.pendingLocation = null;
    document.body.classList.remove('map-pick-mode');
    UI.setWaypointPlannerState('idle');

    if (this.tempMarker) {
      this.map.removeLayer(this.tempMarker);
      this.tempMarker = null;
    }
  },

  /**
   * Show or move a temporary marker for previews (e.g., search results)
   */
  showTempLocation(lat, lng) {
    if (!this.map) return;
    const latlng = L.latLng(lat, lng);
    if (this.tempMarker) {
      this.tempMarker.setLatLng(latlng);
    } else {
      this.tempMarker = L.marker(latlng, {
        icon: this.createIcon('custom')
      }).addTo(this.map);
    }
  },

  /* ══════════════════════════════════════════════════════════════════
     Route data — normalization, scoring, persistence
     ══════════════════════════════════════════════════════════════════ */

  /**
   * Accept coordinates as [{lat,lng}], [[lng,lat]] or [[lat,lng]] and return
   * a clean [{lat,lng}] array. Stored routes come from several producers.
   */
  _normalizeCoords(coords) {
    if (!Array.isArray(coords)) return [];
    const out = [];
    for (const c of coords) {
      if (!c) continue;
      if (Array.isArray(c)) {
        const a = Number(c[0]);
        const b = Number(c[1]);
        if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
        // A value beyond ±90 can only be a longitude — use it to disambiguate.
        if (Math.abs(a) <= 90 && Math.abs(b) > 90) out.push({ lat: a, lng: b });
        else out.push({ lat: b, lng: a });
      } else {
        const lat = Number(c.lat);
        const lng = Number(c.lng);
        if (Number.isFinite(lat) && Number.isFinite(lng)) out.push({ lat, lng });
      }
    }
    return out;
  },

  /**
   * Convert an OSRM route (or a stored route row) into the single internal
   * shape the map, the selector and persistence all speak.
   */
  _normalizeRoute(raw, index) {
    const coordinates = this._normalizeCoords(raw?.coordinates);
    const distance = Number(
      raw?.summary?.totalDistance ?? raw?.distance ?? raw?.distance_meters ?? 0
    ) || 0;
    const duration = Number(
      raw?.summary?.totalTime ?? raw?.duration ?? raw?.duration_seconds ?? raw?.time ?? 0
    ) || 0;

    const instructions = Array.isArray(raw?.instructions) ? raw.instructions : null;
    const steps = instructions
      ? instructions.map((i) => ({
          text: i.text,
          distance: i.distance,
          time: i.time,
          index: i.index,
          type: i.type,
          modifier: i.modifier,
          road: i.road
        }))
      : (Array.isArray(raw?.steps) ? raw.steps : []);

    return {
      index,
      name: typeof raw?.name === 'string' ? raw.name : '',
      coordinates,
      distance,
      duration,
      steps,
      waypointIndices: Array.isArray(raw?.waypointIndices) ? raw.waypointIndices : null,
      curviness: 0,
      badges: []
    };
  },

  /**
   * Curviness: mean absolute bearing change per kilometre over the geometry.
   * This is what makes the scenic choice visible — a twisty mountain road
   * scores an order of magnitude above a motorway. O(n), run once per response.
   */
  _curviness(coords) {
    if (!Array.isArray(coords) || coords.length < 3) return 0;
    const SAMPLE_M = 25; // ignore sub-25 m jitter between polyline vertices
    let anchor = coords[0];
    let prevBearing = null;
    let turned = 0;
    let distance = 0;

    for (let i = 1; i < coords.length; i++) {
      const seg = RideUtils.haversine(anchor, coords[i]);
      if (seg < SAMPLE_M && i < coords.length - 1) continue;
      const bearing = RideUtils.bearing(anchor, coords[i]);
      distance += seg;
      if (prevBearing !== null) {
        let delta = Math.abs(bearing - prevBearing) % 360;
        if (delta > 180) delta = 360 - delta;
        turned += delta;
      }
      prevBearing = bearing;
      anchor = coords[i];
    }

    if (distance < 100) return 0;
    return turned / (distance / 1000);
  },

  /**
   * Score every alternative and tag the two that matter to a rider:
   * the windiest (gold) and the fastest.
   */
  _scoreRoutes(routes) {
    routes.forEach((r) => {
      r.curviness = this._curviness(r.coordinates);
      r.badges = [];
    });
    if (routes.length < 2) return;

    let windy = 0;
    let fast = 0;
    routes.forEach((r, i) => {
      if (r.curviness > routes[windy].curviness) windy = i;
      if ((r.duration || Infinity) < (routes[fast].duration || Infinity)) fast = i;
    });

    // Only call something "windiest" when it is meaningfully twistier.
    const runnerUp = routes.reduce(
      (max, r, i) => (i === windy ? max : Math.max(max, r.curviness)), 0
    );
    if (routes[windy].curviness > runnerUp * 1.12 && routes[windy].curviness > 0) {
      routes[windy].badges.push('windiest');
    }
    if (routes[fast].duration > 0) routes[fast].badges.push('fastest');
  },

  /** True when two routes describe the same line (same length + endpoints). */
  _sameGeometry(a, b) {
    const ac = a?.coordinates;
    const bc = b?.coordinates;
    if (!ac?.length || !bc?.length || ac.length !== bc.length) return false;
    const near = (p, q) => Math.abs(p.lat - q.lat) < 1e-6 && Math.abs(p.lng - q.lng) < 1e-6;
    return near(ac[0], bc[0]) && near(ac[ac.length - 1], bc[bc.length - 1]);
  },

  /** Route payload shape consumed by App.saveRouteData. */
  _toRouteData(route) {
    const data = {
      distance: route.distance,
      duration: route.duration,
      coordinates: route.coordinates,
      steps: route.steps,
      name: route.name,
      curviness: Math.round(route.curviness)
    };
    // Multi-leg stitched routes carry the coordinate index where each leg's
    // segment starts — harmless extra field, not consumed anywhere yet (§D3).
    if (Array.isArray(route.legBoundaries) && route.legBoundaries.length) {
      data.legBoundaries = route.legBoundaries;
    }
    return data;
  },

  /**
   * Persist the current selection. Only ever called from an explicit user
   * action (picking an alternative) or from a recompute caused by a waypoint
   * edit — never from opening a trip.
   *
   * App.saveRouteData persists [currentTrip.route, ..._allAlternatives], so
   * _allAlternatives deliberately EXCLUDES the selected route: that keeps the
   * saved array free of duplicates and pins the selection at index 0.
   */
  _persistSelected() {
    const app = window.App;
    if (typeof app?.saveRouteData !== 'function') return;
    // A shared trip is read-only, and in-ride reroutes stay in memory.
    if (app.isSharedView || app.isRiding || !app.currentTrip) return;
    const routes = this._cachedAlternatives || [];
    const selected = routes[this._selectedRouteIndex];
    if (!selected) return;
    const others = routes
      .filter((_, i) => i !== this._selectedRouteIndex)
      .map((r) => this._toRouteData(r));

    app.saveRouteData({
      ...this._toRouteData(selected),
      _selectedIndex: 0,
      _allAlternatives: others
    });

    // saveRouteData is async but sets currentTrip.route synchronously before
    // its first await, so this event's detail.trip already reflects the new
    // geometry. This is the ONLY hook the scenic-chips feature uses to know
    // when to run its corridor check (contract #4) — fire on every recompute.
    window.dispatchEvent(new CustomEvent('ride:routeComputed', { detail: { trip: app.currentTrip } }));
  },

  /* ══════════════════════════════════════════════════════════════════
     Route rendering
     ══════════════════════════════════════════════════════════════════ */

  _routePalette() {
    return {
      route: this._cssVar('--route', this.ROUTE_COLORS.route),
      casing: this._cssVar('--route-casing', this.ROUTE_COLORS.casing),
      alt: this._cssVar('--route-alt', this.ROUTE_COLORS.alt)
    };
  },

  /**
   * Route line weight based on zoom
   */
  _routeWeight() {
    const z = this.map?.getZoom() || 13;
    if (z >= 16) return 8;
    if (z >= 13) return 6;
    if (z >= 10) return 5;
    return 3;
  },

  _clearRouteLayers() {
    (this._routeLayers || []).forEach((entry) => {
      entry.layers.forEach((layer) => {
        try { this.map.removeLayer(layer); } catch (_) { /* already detached */ }
      });
    });
    this._routeLayers = [];
  },

  /**
   * Draw every route: alternatives underneath in quiet grey, the selected one
   * on top in gold with a dark casing. Alternatives carry a wide invisible hit
   * line so tapping one selects it (and stays in sync with the pill bar).
   */
  _drawRoutes(routes) {
    this._clearRouteLayers();
    if (!this.map || !Array.isArray(routes) || !routes.length) return;

    const palette = this._routePalette();
    const weight = this._routeWeight();
    const selectedIdx = this._selectedRouteIndex;

    // Alternatives first so the selected route paints over them.
    const order = routes
      .map((_, i) => i)
      .filter((i) => i !== selectedIdx)
      .concat(routes[selectedIdx] ? [selectedIdx] : []);

    order.forEach((idx) => {
      const route = routes[idx];
      if (!route?.coordinates?.length) return;
      const latlngs = route.coordinates.map((c) => [c.lat, c.lng]);
      const isSelected = idx === selectedIdx;
      const entry = { index: idx, layers: [], isSelected };

      if (isSelected) {
        entry.layers.push(L.polyline(latlngs, {
          color: palette.casing,
          weight: weight + 5,
          opacity: 1,
          lineCap: 'round',
          lineJoin: 'round',
          interactive: false,
          className: 'route-line-casing'
        }).addTo(this.map));

        entry.layers.push(L.polyline(latlngs, {
          color: palette.route,
          weight,
          opacity: 0.95,
          lineCap: 'round',
          lineJoin: 'round',
          interactive: false,
          className: 'route-line route-line--selected'
        }).addTo(this.map));
      } else {
        const select = (e) => {
          if (e?.originalEvent) L.DomEvent.stopPropagation(e.originalEvent);
          this._selectRoute(idx);
        };
        const label = this._routeTooltip(route);

        const line = L.polyline(latlngs, {
          color: palette.alt,
          weight: Math.max(3, weight - 2),
          opacity: 0.5,
          lineCap: 'round',
          lineJoin: 'round',
          interactive: true,
          bubblingMouseEvents: false,
          className: 'route-line route-line--alt'
        }).addTo(this.map);
        line.on('click', select);
        entry.layers.push(line);

        // Wide invisible hit line — a 4 px grey line is not a tap target.
        const hit = L.polyline(latlngs, {
          color: palette.alt,
          weight: Math.max(18, weight + 12),
          opacity: 0,
          interactive: true,
          bubblingMouseEvents: false,
          className: 'route-line-hit'
        }).addTo(this.map);
        // SVG hit-testing ignores a stroke that isn't painted, so ask for
        // geometry-based hits explicitly rather than relying on a stylesheet.
        const hitEl = hit.getElement?.();
        if (hitEl) hitEl.style.pointerEvents = 'stroke';
        hit.on('click', select);
        if (label) hit.bindTooltip(label, { sticky: true, className: 'route-alt-tooltip' });
        entry.layers.push(hit);
      }

      this._routeLayers.push(entry);
    });

    // Every path that puts a route on screen funnels through here — a fresh
    // compute (_applyRoutes), picking an alternative (_selectRoute), and the
    // restore path used when a trip is simply opened (_restoreStoredRoute /
    // drawRoute / _adoptStoredRoutes). ride:routeComputed only fires from
    // _persistSelected, so without this the fuel overlay would never appear
    // on trip open — only after an edit forced a reroute.
    this.refreshFuelOverlay();
  },

  _routeTooltip(route) {
    const parts = [
      RideUtils.formatDuration(route.duration),
      RideUtils.formatDistance(route.distance)
    ].filter((p) => p && p !== '—');
    if (route.badges?.includes('windiest')) parts.push('Windiest');
    return parts.join(' · ');
  },

  /** Re-apply widths/colors in place (zoom change) without rebuilding layers. */
  _restyleRoutes() {
    const palette = this._routePalette();
    const weight = this._routeWeight();
    (this._routeLayers || []).forEach((entry) => {
      entry.layers.forEach((layer) => {
        const cls = layer.options.className || '';
        if (cls.includes('route-line-casing')) layer.setStyle({ weight: weight + 5, color: palette.casing });
        else if (cls.includes('route-line-hit')) layer.setStyle({ weight: Math.max(18, weight + 12) });
        else if (entry.isSelected) layer.setStyle({ weight, color: palette.route });
        else layer.setStyle({ weight: Math.max(3, weight - 2), color: palette.alt });
      });
    });
  },

  /**
   * Route selector UI — delegates to RouteSelector component
   */
  _renderRouteSelector(routes) {
    if (this.routeSelector) {
      this.routeSelector.render(routes, this._selectedRouteIndex);
    }
  },

  /**
   * Hide the route selector panel
   */
  _hideRouteSelector() {
    if (this.routeSelector) {
      this.routeSelector.clear();
    }
  },

  /**
   * User picked an alternative — from a pill or by tapping the grey line on
   * the map. Both funnel through here so UI, map and storage never diverge.
   */
  _selectRoute(index, routes) {
    const list = routes || this._cachedAlternatives || [];
    if (!list[index] || index === this._selectedRouteIndex) return;
    this._selectedRouteIndex = index;

    if (this.routeSelector) this.routeSelector.selectRoute(index, { silent: true });
    this._drawRoutes(list);

    const selected = list[index];
    if (this.routeEditor) {
      this.routeEditor.update(this._lastRoutedWaypoints || [], selected.coordinates, selected.waypointIndices);
    }
    this._persistSelected();
  },

  /* ══════════════════════════════════════════════════════════════════
     Fuel overlay (planning view) — pure rendering; all fuel math lives in
     window.FuelPlanner (public/js/fuel.js). This module never computes a
     range or a fill point itself, only draws what FuelPlanner returns.
     ══════════════════════════════════════════════════════════════════ */

  /** Read the fuel settings out of the shared settings blob (contract §1). */
  _fuelSettings() {
    const raw = (window.Storage?.load && window.Storage.load(window.Storage.KEYS.SETTINGS, {})) || {};
    return {
      enabled: !!raw.fuelPlanningEnabled,
      tankRangeKm: Number(raw.fuelTankRangeKm) || 0,
      warnMode: raw.fuelWarnMode || 'percent30'
    };
  },

  /**
   * The route currently on screen — same source _persistSelected reads from.
   * While riding, currentTrip.route wins: an in-ride reroute replaces it
   * (ride-controller.js applyRideReroute) without touching the cached
   * planning alternatives, and the startAtIdx the ride HUD hands us indexes
   * that array — reading a stale alternative here would misplace the rider.
   */
  _activeRouteCoordinates() {
    if (window.App?.isRiding) {
      const live = this._normalizeCoords(window.App?.currentTrip?.route?.coordinates);
      if (live.length >= 2) return live;
    }
    const selected = (this._cachedAlternatives || [])[this._selectedRouteIndex];
    if (selected?.coordinates?.length) return selected.coordinates;
    return this._normalizeCoords(window.App?.currentTrip?.route?.coordinates);
  },

  /** Dedicated pane so fuel segments paint above the base route (400) but
   *  below the route-editor's drag handles / via markers (450, route-editor.js:59). */
  _ensureFuelPane() {
    if (!this.map) return undefined;
    if (!this.map.getPane('fuelOverlayPane')) {
      const pane = this.map.createPane('fuelOverlayPane');
      if (pane) pane.style.zIndex = 420;
    }
    return 'fuelOverlayPane';
  },

  _fuelLevelColor(level) {
    if (level === 'warn') return this._cssVar('--fuel-warn', this.FUEL_COLORS.warn);
    if (level === 'low') return this._cssVar('--fuel-low', this.FUEL_COLORS.low);
    if (level === 'critical' || level === 'empty') {
      return this._cssVar('--fuel-critical', this._cssVar('--danger', this.FUEL_COLORS.critical));
    }
    return null; // 'ok' — no overlay drawn for this stretch
  },

  /** Slightly under the route line's own weight so its gold edges still show either side. */
  _fuelWeight() {
    return Math.max(2, this._routeWeight() - 2);
  },

  _clearFuelLayers() {
    (this._fuelLayers || []).forEach((layer) => {
      try { this.map.removeLayer(layer); } catch (_) { /* already detached */ }
    });
    this._fuelLayers = [];
  },

  /** One polyline per non-'ok' segment, drawn over the base route. */
  _drawFuelSegments(coordinates, segments) {
    if (!Array.isArray(segments) || !segments.length) return;
    const pane = this._ensureFuelPane();
    const weight = this._fuelWeight();

    segments.forEach((seg) => {
      const color = seg && this._fuelLevelColor(seg.level);
      if (!color) return;
      const from = Math.max(0, Number(seg.from) || 0);
      const to = Math.min(coordinates.length - 1, Number(seg.to) || 0);
      if (to < from) return;
      // FuelPlanner returns a STRICT partition (adjacent segments share no
      // index) so 'empty' starts exactly at dryPointIdx. Drawn as-is that
      // leaves a one-edge gap at every boundary, so extend each slice by the
      // next coordinate — the overlap is one edge, painted by both colours,
      // which is what makes the bands look continuous. This is also what lets
      // a single-coordinate band (from === to) draw at all.
      const latlngs = coordinates.slice(from, Math.min(to + 2, coordinates.length)).map((c) => [c.lat, c.lng]);
      if (latlngs.length < 2) return;

      const layer = L.polyline(latlngs, {
        pane,
        color,
        weight,
        opacity: 0.92,
        lineCap: 'round',
        lineJoin: 'round',
        interactive: false,
        // The empty stretch is dashed on top of the (also critical-colored)
        // solid line so it reads as "gone", not just "still critical".
        dashArray: seg.level === 'empty' ? '2 9' : null,
        className: `fuel-line fuel-line--${seg.level}`
      }).addTo(this.map);
      this._fuelLayers.push(layer);
    });
  },

  /**
   * One subtle marker per refill point — but only where the existing
   * waypoint pin doesn't already say "fuel". addWaypointMarker() (§ Markers
   * below) gives every real stop a pin regardless of fuelStop; only
   * type 'fuel' pins render the ⛽ glyph via createIcon()/waypointIcons.fuel.
   * A fuelStop:true waypoint of some other type (e.g. a lodging stop that
   * happens to also have a pump) shows a pin with no fuel cue at all, so
   * that's the case this circleMarker exists for — reusing --wp-fuel (the
   * same color createIcon() already uses for fuel pins) rather than one of
   * the new --fuel-* range-warning tokens, since this marks "you can refill
   * here", not a warning band.
   */
  _drawFuelFills(coordinates, waypoints, fills) {
    if (!Array.isArray(fills) || !fills.length) return;
    const pane = this._ensureFuelPane();
    const color = this._cssVar('--wp-fuel', this.waypointIcons.fuel.color);
    const ring = this._cssVar('--surface-0', '#0b0e1f');
    const SNAP_TOLERANCE_M = 250; // fills[].coordIdx is the nearest route vertex to the waypoint, not the waypoint itself

    fills.forEach((fill) => {
      const coord = coordinates[fill?.coordIdx];
      if (!coord) return;
      const alreadyMarked = (waypoints || []).some((wp) => (
        wp?.type === 'fuel' &&
        Number.isFinite(Number(wp.lat)) && Number.isFinite(Number(wp.lng)) &&
        RideUtils.haversine(wp, coord) <= SNAP_TOLERANCE_M
      ));
      if (alreadyMarked) return;

      const marker = L.circleMarker([coord.lat, coord.lng], {
        pane,
        radius: 6,
        weight: 2,
        color: ring,
        fillColor: color,
        fillOpacity: 0.95,
        opacity: 1,
        interactive: false,
        className: 'fuel-fill-marker'
      }).addTo(this.map);
      this._fuelLayers.push(marker);
    });
  },

  /**
   * Where a NEW scenic-suggest chip (js/scenic-suggest.js) would currently
   * sit, plus clearance for its own height — so the fuel chip can never end
   * up under it, whichever chip appears first. Prefers measuring the real
   * DOM over recomputing route-components.css's pill-bar arithmetic: if a
   * scenic chip is already on screen, its rendered bottom edge already
   * reflects that CSS (route-components.css:561-568), so just stack under it.
   */
  _fuelChipTopOffset() {
    const GAP = 10;
    const SCENIC_CHIP_RESERVE = 92; // generous estimate of scenic-suggest.js's chip height (name + 2-line blurb + padding)
    const scenicChip = document.querySelector('.scenic-chip');
    if (scenicChip) {
      const rect = scenicChip.getBoundingClientRect();
      return `${Math.round(rect.bottom + GAP)}px`;
    }

    const bar = document.querySelector('.route-selector:not(.hidden):not(.route-selector--bottom)');
    const barIsTop = bar && !document.body.classList.contains('ride-mode') && window.innerWidth > 640;
    if (barIsTop) {
      const rect = bar.getBoundingClientRect();
      return `${Math.round(rect.bottom + GAP + SCENIC_CHIP_RESERVE)}px`;
    }

    return `calc(var(--header-height, 56px) + var(--safe-area-top, 0px) + 10px + ${SCENIC_CHIP_RESERVE}px)`;
  },

  _removeFuelChip() {
    if (this._fuelChipEl?.parentNode) this._fuelChipEl.parentNode.removeChild(this._fuelChipEl);
    this._fuelChipEl = null;
    this._fuelChipShownFor = null;
  },

  /**
   * Styling follows js/scenic-suggest.js's buildChip() precedent exactly:
   * inline styles only (no stylesheet dependency), tokens.css var() with a
   * literal fallback for every color, 44px dismiss target.
   * Class contract for a future CSS pass: .fuel-chip, .fuel-chip-text,
   * .fuel-chip-dismiss.
   */
  _buildFuelChip(remainingKm) {
    const wrap = document.createElement('div');
    wrap.className = 'fuel-chip';
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Fuel range warning');
    wrap.style.cssText = [
      'position:fixed',
      'left:50%',
      'transform:translateX(-50%)',
      `top:${this._fuelChipTopOffset()}`,
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
    text.className = 'fuel-chip-text';
    text.style.cssText = 'flex:1;min-width:0;display:flex;align-items:center;gap:8px;';

    const icon = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '⛽';
    icon.style.cssText = 'font-size:18px;line-height:1;flex-shrink:0;';
    text.appendChild(icon);

    const msg = document.createElement('span');
    msg.style.cssText = [
      'font-weight:600',
      'font-size:var(--text-sm, 0.875rem)',
      'color:var(--fuel-critical, var(--danger, #ef4444))'
    ].join(';');
    msg.textContent = `Runs dry ~${remainingKm} km before the end — add a fuel stop`;
    text.appendChild(msg);
    wrap.appendChild(text);

    const dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.className = 'fuel-chip-dismiss';
    dismissBtn.setAttribute('aria-label', 'Dismiss fuel warning');
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
      this._fuelChipDismissedFor = this._fuelChipSignature;
      this._removeFuelChip();
    });
    wrap.appendChild(dismissBtn);

    // Same reasoning as scenic-suggest.js: this chip floats over the map, so
    // gesture-starts on it must not fall through to Leaflet underneath.
    ['pointerdown', 'touchstart', 'mousedown'].forEach((type) =>
      wrap.addEventListener(type, (e) => e.stopPropagation()));

    return wrap;
  },

  /**
   * Show/update/hide the "runs dry" chip. Re-arms the same way
   * scenic-suggest.js's per-road dismissal does: a dismissal only suppresses
   * the exact dry point it was shown for — a materially different route (a
   * different trip, a different coordinate count, or the dry point landing
   * somewhere new) gets its own signature and can show again.
   */
  _updateFuelChip(trip, coordinates, profile) {
    // Never during a ride: this chip is fixed to the top centre of the screen,
    // which in ride mode is the turn-by-turn banner. The rider already gets
    // the fuel warning in the HUD (ride-controller.js _setFuelAlertLine), so
    // covering the next manoeuvre with a second copy of it would be worse
    // than useless at 100 km/h.
    if (window.App?.isRiding) {
      this._removeFuelChip();
      this._fuelChipSignature = null;
      return;
    }

    const dryIdx = profile?.dryPointIdx;
    if (dryIdx == null || !Number.isFinite(dryIdx) || !coordinates[dryIdx]) {
      this._removeFuelChip();
      this._fuelChipSignature = null;
      this._fuelChipShownFor = null;
      return;
    }

    let remainingM = 0;
    for (let i = dryIdx; i < coordinates.length - 1; i++) {
      remainingM += RideUtils.haversine(coordinates[i], coordinates[i + 1]);
    }
    const remainingKm = Math.round(remainingM / 1000);
    const signature = `${trip?.id || 'local'}:${coordinates.length}:${dryIdx}`;
    this._fuelChipSignature = signature;

    if (this._fuelChipDismissedFor === signature) {
      this._removeFuelChip();
      this._fuelChipShownFor = null;
      return;
    }
    // Already showing this exact warning — leave it alone. A DIFFERENT
    // signature must rebuild, or the chip would keep quoting the km figure
    // from a route the rider has since changed.
    if (this._fuelChipEl && this._fuelChipShownFor === signature) return;

    this._removeFuelChip();
    const host = document.getElementById('app') || document.body;
    this._fuelChipEl = this._buildFuelChip(remainingKm);
    this._fuelChipShownFor = signature;
    host.appendChild(this._fuelChipEl);
  },

  /**
   * Defaults for a refresh that wasn't given an explicit position/percent.
   * Outside a ride that's simply "the whole route on the stored tank".
   *
   * Mid-ride it has to be the rider's live numbers instead: the stored
   * percent is only rewritten on a Tank Filled tap, so ride-controller.js
   * tracks the km ridden since that fill in _fuelKmRidden and _rideNearIdx
   * (an index into currentTrip.route.coordinates — see _activeRouteCoordinates).
   * Deriving both here means an unqualified refreshFuelOverlay() — the one
   * every window event fires — agrees with the explicit call _onTankFilled
   * makes, instead of clobbering it back to the start of the route on a full
   * tank.
   */
  _liveRideFuel(app, tankRangeKm, storedPercent) {
    const out = { percent: storedPercent, startAtIdx: 0 };
    if (!app?.isRiding || !(tankRangeKm > 0)) return out;
    out.startAtIdx = Number.isFinite(app._rideNearIdx) ? app._rideNearIdx : 0;
    const ridden = Number(app._fuelKmRidden);
    if (Number.isFinite(ridden) && ridden > 0) {
      const remaining = Math.max(0, tankRangeKm * (storedPercent / 100) - ridden);
      out.percent = Math.max(0, Math.min(100, (remaining / tankRangeKm) * 100));
    }
    return out;
  },

  /**
   * Public entry point (contract §5) — settings changes, fuel-stop toggles
   * and every route recompute all funnel through here via the window events
   * wired in init(). Always clears its own layers/chip first: disabled,
   * no route, or no tank range set all mean "remove the overlay and stop".
   */
  refreshFuelOverlay({ startAtIdx, percent } = {}) {
    this._clearFuelLayers();

    const app = window.App;
    const settings = this._fuelSettings();
    if (!this.map || !app?.currentTrip || !settings.enabled || !(settings.tankRangeKm > 0)) {
      this._removeFuelChip();
      this._fuelChipSignature = null;
      return;
    }

    const coordinates = this._activeRouteCoordinates();
    const waypoints = Array.isArray(app.currentTrip.waypoints) ? app.currentTrip.waypoints : [];
    if (coordinates.length < 2 || waypoints.length < 2 || typeof window.FuelPlanner?.computeProfile !== 'function') {
      this._removeFuelChip();
      this._fuelChipSignature = null;
      return;
    }

    const state = typeof window.FuelPlanner.getState === 'function' ? window.FuelPlanner.getState() : null;
    const stored = Number.isFinite(state?.percent) ? state.percent : 100;
    const live = this._liveRideFuel(app, settings.tankRangeKm, stored);
    const startPercent = Number.isFinite(percent) ? percent : live.percent;
    const startAt = Number.isFinite(startAtIdx) ? startAtIdx : live.startAtIdx;

    const profile = window.FuelPlanner.computeProfile({
      coordinates,
      waypoints,
      tankRangeKm: settings.tankRangeKm,
      startPercent,
      startAtIdx: startAt
    });
    if (!profile) {
      this._removeFuelChip();
      this._fuelChipSignature = null;
      return;
    }

    this._drawFuelSegments(coordinates, profile.segments);
    this._drawFuelFills(coordinates, waypoints, profile.fills);
    this._updateFuelChip(app.currentTrip, coordinates, profile);
  },

  /* ══════════════════════════════════════════════════════════════════
     Markers
     ══════════════════════════════════════════════════════════════════ */

  /**
   * Create custom icon for waypoint type
   */
  createIcon(type) {
    if (type === 'via') return this._createViaIcon();

    const config = this.waypointIcons[type] || this.waypointIcons.stop;
    const color = this._cssVar(config.token, config.color);
    const z = this.map?.getZoom() || 13;
    const size = z <= 9 ? 22 : z <= 12 ? 28 : 34;
    const fontSize = z <= 9 ? 11 : z <= 12 ? 13 : 15;

    return L.divIcon({
      className: 'custom-marker',
      html: `<div style="
        background: ${color};
        width: ${size}px;
        height: ${size}px;
        border-radius: 50% 50% 50% 0;
        transform: rotate(-45deg);
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 2px 6px rgba(0,0,0,0.35);
        border: 2px solid rgba(255,255,255,0.92);
      "><span style="transform: rotate(45deg); font-size: ${fontSize}px;">${config.icon}</span></div>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size],
      popupAnchor: [0, -size]
    });
  },

  /**
   * Shaping point ("via"): a small quiet dot that bends the route. It is not a
   * stop, so it gets no pin, no emoji and no number.
   */
  _createViaIcon() {
    const z = this.map?.getZoom() || 13;
    const size = z <= 10 ? 10 : z <= 13 ? 12 : 14;
    const color = this._cssVar('--wp-via', this.ROUTE_COLORS.via);
    const ring = this._cssVar('--surface-0', '#0b0e1f');

    return L.divIcon({
      className: 'via-marker',
      html: `<div class="via-marker-inner" style="
        width: ${size}px;
        height: ${size}px;
        background: ${color};
        border: 2px solid ${ring};
        border-radius: 50%;
        box-shadow: 0 1px 3px rgba(0,0,0,0.45);
      "></div>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
      popupAnchor: [0, -size / 2]
    });
  },

  /**
   * Popup content built with DOM APIs — waypoint name and notes are
   * user-supplied and travel through public share links.
   */
  _buildWaypointPopup(waypoint) {
    const wrap = document.createElement('div');
    wrap.className = 'waypoint-popup';
    wrap.style.minWidth = '150px';

    const title = document.createElement('strong');
    title.textContent = waypoint.name || 'Waypoint';
    wrap.appendChild(title);

    if (waypoint.notes) {
      const notes = document.createElement('p');
      notes.style.cssText = 'margin: 8px 0 0; font-size: 12px;';
      notes.textContent = waypoint.notes;
      wrap.appendChild(notes);
    }
    return wrap;
  },

  /**
   * Add waypoint marker to map
   */
  addWaypointMarker(waypoint) {
    const type = waypoint.type || 'stop';
    // Leg dividers are not a place — they never get a pin on the map.
    if (type === 'leg-break') return null;
    const isVia = type === 'via';

    const marker = L.marker([waypoint.lat, waypoint.lng], {
      icon: this.createIcon(type),
      draggable: true,
      keyboard: !isVia,
      zIndexOffset: isVia ? -300 : 0,
      title: isVia ? 'Shaping point — drag to reshape the route' : (waypoint.name || 'Waypoint')
    }).addTo(this.map);

    // Store type for zoom-responsive icon refresh
    marker._wpType = type;

    // Shaping points are route geometry, not stops — no popup, no clutter.
    if (!isVia) {
      marker.bindPopup(this._buildWaypointPopup(waypoint), { minWidth: 160 });
    }

    // Handle drag end
    marker.on('dragend', (e) => {
      const newPos = e.target.getLatLng();
      App.updateWaypointPosition(waypoint.id, newPos.lat, newPos.lng);
    });

    this.waypointMarkers[waypoint.id] = marker;
    return marker;
  },

  /**
   * Remove waypoint marker
   */
  removeWaypointMarker(waypointId) {
    if (this.waypointMarkers[waypointId]) {
      this.map.removeLayer(this.waypointMarkers[waypointId]);
      delete this.waypointMarkers[waypointId];
    }
  },

  /**
   * Update all waypoint markers from trip
   */
  updateWaypoints(waypoints) {
    // Clear existing markers
    Object.keys(this.waypointMarkers).forEach(id => {
      this.map.removeLayer(this.waypointMarkers[id]);
    });
    this.waypointMarkers = {};

    // Add new markers
    (waypoints || []).forEach(wp => this.addWaypointMarker(wp));

    // Routing (and with it the editor handles) follows the waypoint list.
    this.updateRoute(waypoints || []);
  },

  /* ══════════════════════════════════════════════════════════════════
     Routing
     ══════════════════════════════════════════════════════════════════ */

  /**
   * Recompute the route between waypoints.
   *
   * Trailing-debounced so a burst of drags issues one request, and skipped
   * entirely the first time a trip is drawn — opening a trip renders the
   * geometry and the alternative already stored on it instead of re-querying
   * OSRM (which used to overwrite the rider's saved choice).
   */
  updateRoute(waypoints, options = {}) {
    // Reflect this trip's saved engine preference on the toggle (silent —
    // does not itself trigger a reroute or persistence).
    this.routeSelector?.setRouteMode(this._routingSettings());

    const ordered = (Array.isArray(waypoints) ? waypoints : [])
      .filter(wp => Number.isFinite(Number(wp?.lat)) && Number.isFinite(Number(wp?.lng)))
      .slice()
      .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));

    if (ordered.length < 2) {
      this.clearRoute();
      return;
    }

    this._lastRoutedWaypoints = ordered;

    if (!options.force && this._restoreStoredRoute(ordered)) return;

    clearTimeout(this._routeDebounceTimer);
    this._routeDebounceTimer = setTimeout(() => this._requestRoute(ordered), 250);
  },

  /**
   * Collect the routes a trip already carries. The selected route lives on
   * trip.route; the alternatives list has been written in two shapes over
   * time (with and without the selected route), so match on geometry rather
   * than trusting the stored index.
   */
  _storedRoutes(trip) {
    const primary = trip?.route?.coordinates?.length ? this._normalizeRoute(trip.route, 0) : null;

    let list = Array.isArray(trip?.alternatives) && trip.alternatives.length
      ? trip.alternatives
      : (trip?.alternativeRoutes || trip?.alternative_routes);
    if (!Array.isArray(list)) list = [];

    let routes = list
      .map((r, i) => this._normalizeRoute(r, i))
      .filter(r => r.coordinates.length >= 2);

    if (primary && primary.coordinates.length >= 2) {
      if (!routes.some(r => this._sameGeometry(r, primary))) routes = [primary, ...routes];
    }
    routes.forEach((r, i) => { r.index = i; });

    let selected = primary ? routes.findIndex(r => this._sameGeometry(r, primary)) : -1;
    if (selected < 0) {
      selected = Number(trip?.activeRouteIndex ?? trip?.active_route_index ?? 0);
      if (!Number.isFinite(selected) || selected < 0 || selected >= routes.length) selected = 0;
    }
    return { routes, selected };
  },

  /**
   * Sanity check before trusting a stored route: every waypoint must lie close
   * to it. Catches a route saved before a waypoint was added or moved
   * elsewhere, in which case we fall through to a fresh OSRM query.
   */
  _routeCoversWaypoints(route, waypoints) {
    const coords = route?.coordinates;
    if (!coords?.length || !waypoints?.length) return false;
    const TOLERANCE_M = 400; // generous — OSRM snaps waypoints to the road
    return waypoints.every((wp) => {
      for (let i = 0; i < coords.length; i++) {
        if (RideUtils.haversine(wp, coords[i]) <= TOLERANCE_M) return true;
      }
      return false;
    });
  },

  /**
   * Draw the trip's saved route instead of recomputing it. Runs at most once
   * per trip load (MapManager.clear() re-arms it), and never persists — this
   * is what stops opening a trip from overwriting the rider's chosen line.
   */
  _restoreStoredRoute(orderedWaypoints) {
    const trip = window.App?.currentTrip;
    const key = trip ? (trip.id || 'local') : null;
    if (!key || this._restoredTripKey === key) return false;
    this._restoredTripKey = key;

    const { routes, selected } = this._storedRoutes(trip);
    if (!routes.length) return false;
    if (!this._routeCoversWaypoints(routes[selected] || routes[0], orderedWaypoints)) return false;

    this._selectedRouteIndex = selected;
    this._applyRoutes(routes, orderedWaypoints, { persist: false });
    // The restore path never reaches _persistSelected (the event's only other
    // dispatcher), so purely event-driven consumers — scenic-suggest's chip in
    // particular — would miss every trip that opens with a saved route and is
    // never edited. Same detail shape as _persistSelected's dispatch.
    window.dispatchEvent(new CustomEvent('ride:routeComputed', {
      detail: { trip: window.App?.currentTrip }
    }));
    return true;
  },

  /**
   * Read trip.settings.routing (contract: trip.settings.routing = { mode,
   * avoidMotorways }). Defaults to fastest/OSRM with motorways allowed when
   * absent, matching pre-windy-routing behavior exactly.
   */
  _routingSettings() {
    const routing = window.App?.currentTrip?.settings?.routing;
    return {
      mode: routing?.mode === 'windy' ? 'windy' : 'fastest',
      avoidMotorways: !!routing?.avoidMotorways
    };
  },

  /**
   * Split the sorted waypoint list on `type === 'leg-break'` entries (§D3).
   * Each segment is the run of real waypoints between two dividers (or the
   * start/end of the list); leg-break waypoints themselves are dividers, not
   * routing points, so they never appear in a segment. Zero leg-breaks yields
   * exactly one segment — the whole list — which is what keeps the
   * single-segment path byte-for-byte identical to pre-legs behavior.
   */
  _splitIntoLegs(orderedWaypoints) {
    const segments = [];
    let current = [];
    (orderedWaypoints || []).forEach((wp) => {
      if (wp?.type === 'leg-break') {
        if (current.length) segments.push(current);
        current = [];
        return;
      }
      current.push(wp);
    });
    if (current.length) segments.push(current);
    return segments;
  },

  /**
   * Fastest engine: one OSRM request via the vendored LRM osrmv1 router.
   * `avoidMotorways` uses a second cached router instance — LRM bakes
   * requestParameters into the router at construction, not per-request — so
   * the default (avoid-motorways off) path reuses the exact same cached
   * instance this codebase used before windy routing existed.
   * Resolves to an array of normalized route alternatives (OSRM/LRM can
   * return several); rejects on error or an empty result.
   */
  _routeSegmentOSRM(segmentWaypoints, avoidMotorways) {
    return new Promise((resolve, reject) => {
      if (!this.map || !window.L?.Routing?.osrmv1) {
        reject(new Error('OSRM router unavailable'));
        return;
      }

      if (avoidMotorways) {
        if (!this._planRouterAvoidMotorways) {
          this._planRouterAvoidMotorways = L.Routing.osrmv1({
            serviceUrl: this.OSRM_SERVICE_URL,
            requestParameters: { exclude: 'motorway' }
          });
        }
      } else if (!this._planRouter) {
        this._planRouter = L.Routing.osrmv1({ serviceUrl: this.OSRM_SERVICE_URL });
      }
      const router = avoidMotorways ? this._planRouterAvoidMotorways : this._planRouter;

      const wps = segmentWaypoints.map((wp) => {
        const ll = L.latLng(Number(wp.lat), Number(wp.lng));
        return typeof L.Routing.waypoint === 'function' ? L.Routing.waypoint(ll) : { latLng: ll };
      });

      this._routeXhr = router.route(wps, (err, routes) => {
        this._routeXhr = null; // matches the pre-existing OSRM callback: clear as soon as it settles
        if (err || !Array.isArray(routes) || !routes.length) {
          reject(err instanceof Error ? err : new Error('No route found'));
          return;
        }
        resolve(routes.map((r, i) => this._normalizeRoute(r, i)));
      }, this);
    });
  },

  /**
   * Windy engine: POST to the Worker's GraphHopper proxy (/api/gh/route,
   * contract #3), which already returns the OSRM-normalized shape. The
   * request timeout lives server-side (FETCH_TIMEOUT_MS in api/gh.js); the
   * AbortController here exists purely for the stale-response guard when a
   * newer edit supersedes this request.
   */
  _routeSegmentGH(segmentWaypoints, avoidMotorways) {
    const controller = new AbortController();
    this._ghAbortController = controller;
    const points = segmentWaypoints.map((wp) => [Number(wp.lng), Number(wp.lat)]);

    return fetch('/api/gh/route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ points, avoidMotorways: !!avoidMotorways }),
      signal: controller.signal
    }).then(async (res) => {
      if (!res.ok) {
        let code = 'ROUTING_UNAVAILABLE';
        try {
          const errBody = await res.json();
          code = errBody?.error?.code || code;
        } catch (_) { /* body not JSON — keep default code */ }
        const err = new Error(`GH routing failed (${res.status})`);
        err.code = code;
        throw err;
      }
      const data = await res.json();
      if (data?.code !== 'Ok' || !Array.isArray(data.routes) || !data.routes.length) {
        const err = new Error('GH routing returned no routes');
        err.code = 'ROUTING_UNAVAILABLE';
        throw err;
      }
      return data.routes.map((r, i) => this._normalizeRoute(r, i));
    }).finally(() => {
      // Only clear if nothing newer has already replaced it (a superseding
      // _requestRoute call aborts and reassigns this before we get here).
      if (this._ghAbortController === controller) this._ghAbortController = null;
    });
  },

  /** Route one contiguous segment through whichever engine is active. */
  _routeSegment(segmentWaypoints, mode, avoidMotorways) {
    return mode === 'windy'
      ? this._routeSegmentGH(segmentWaypoints, avoidMotorways)
      : this._routeSegmentOSRM(segmentWaypoints, avoidMotorways);
  },

  /**
   * Route every leg segment and stitch the results into the shape
   * App.saveRouteData expects (§D3). A single segment (no leg-breaks)
   * returns the engine's alternatives untouched — the compatibility path
   * that must match pre-legs behavior exactly. Multiple segments are routed
   * SEQUENTIALLY (never concurrently, to avoid hammering the routing
   * service — one call in flight at a time) and concatenated into one route
   * with no alternatives: "windiest of leg 2" has no meaning next to
   * "fastest of leg 1", so v1 applies one engine/avoid-motorways state to
   * the whole trip rather than per leg (simplification — see findings).
   */
  async _computeSegments(segments, mode, avoidMotorways) {
    if (segments.length === 1) {
      const routes = await this._routeSegment(segments[0], mode, avoidMotorways);
      return { routes };
    }

    let coordinates = [];
    let steps = [];
    let distance = 0;
    let duration = 0;
    const legBoundaries = [];

    for (const segment of segments) {
      // Deliberately sequential — one engine call in flight at a time (see doc comment above).
      const routes = await this._routeSegment(segment, mode, avoidMotorways);
      const primary = routes[0];
      if (!primary) continue;
      const baseIndex = coordinates.length;
      legBoundaries.push(baseIndex);
      const rebasedSteps = (primary.steps || []).map((s) => ({
        ...s,
        index: Number.isFinite(s.index) ? s.index + baseIndex : s.index
      }));
      coordinates = coordinates.concat(primary.coordinates);
      steps = steps.concat(rebasedSteps);
      distance += primary.distance || 0;
      duration += primary.duration || 0;
    }

    if (!coordinates.length) throw new Error('No route found for any leg');

    return {
      routes: [{
        index: 0,
        name: '',
        coordinates,
        distance,
        duration,
        steps,
        waypointIndices: null,
        curviness: 0,
        badges: [],
        legBoundaries
      }]
    };
  },

  /**
   * Issue one routing pass — possibly several sequential engine calls, one
   * per leg segment. Every response (and every fallback) is checked against
   * the generation stamp, so a slow answer from a superseded edit can never
   * repaint the map or write stale geometry to the server.
   */
  _requestRoute(orderedWaypoints) {
    if (!this.map) return;
    const { mode, avoidMotorways } = this._routingSettings();
    // Matches the pre-existing guard exactly for the default (fastest)
    // engine — a trip with zero leg-breaks on 'fastest' takes precisely this
    // early-return path when LRM hasn't loaded, same as before this feature.
    if (mode !== 'windy' && !window.L?.Routing?.osrmv1) return;

    const gen = ++this._routeGen;
    if (this._routeXhr) {
      try { this._routeXhr.abort(); } catch (_) { /* already settled */ }
      this._routeXhr = null;
    }
    if (this._ghAbortController) {
      try { this._ghAbortController.abort(); } catch (_) { /* already settled */ }
      this._ghAbortController = null;
    }

    const segments = this._splitIntoLegs(orderedWaypoints).filter((seg) => seg.length >= 2);
    if (!segments.length) return;

    this._setRoutingBusy(true);
    this._runRouteRequest(segments, mode, avoidMotorways, gen, orderedWaypoints);
  },

  /** Async body of _requestRoute — split out so the sync guards above run before any await. */
  async _runRouteRequest(segments, mode, avoidMotorways, gen, orderedWaypoints) {
    try {
      const { routes } = await this._computeSegments(segments, mode, avoidMotorways);
      if (gen !== this._routeGen) return; // superseded by a newer edit
      this._selectedRouteIndex = 0;
      this._applyRoutes(routes, orderedWaypoints, { persist: true });
    } catch (_err) {
      if (gen !== this._routeGen) return; // superseded — drop silently
      if (mode === 'windy') {
        // Fall back to fastest for THIS render only — never mutate the
        // rider's saved mode preference (contract #3d).
        UI.showToast('Windy routing unavailable — showing fastest', 'info');
        try {
          const fallback = await this._computeSegments(segments, 'fastest', avoidMotorways);
          if (gen !== this._routeGen) return;
          this._selectedRouteIndex = 0;
          this._applyRoutes(fallback.routes, orderedWaypoints, { persist: true });
          return;
        } catch (_err2) {
          if (gen !== this._routeGen) return;
          this._handleRoutingError();
          return;
        }
      }
      this._handleRoutingError();
    } finally {
      if (gen === this._routeGen) this._setRoutingBusy(false);
    }
  },

  /**
   * The route-selector's Fastest/Windy + avoid-motorways controls are a pure
   * UI component with no API/App coupling — this is where their clicks turn
   * into a persisted trip setting and an immediate reroute. Persists via the
   * same settings PATCH path other trip settings already use (API.trips.update
   * shallow-merges `settings` server-side on both cloud and the guest
   * localStorage shim, so this can't clobber unrelated keys like `share`).
   */
  async _onRouteModeChange({ mode, avoidMotorways }) {
    const app = window.App;
    const trip = app?.currentTrip;
    if (!trip) return;

    if (!trip.settings || typeof trip.settings !== 'object') trip.settings = {};
    trip.settings.routing = { mode: mode === 'windy' ? 'windy' : 'fastest', avoidMotorways: !!avoidMotorways };

    if (trip.id && !app.isSharedView && typeof window.API?.trips?.update === 'function') {
      try {
        await API.trips.update(trip.id, { settings: { routing: trip.settings.routing } });
      } catch (err) {
        console.error('Failed to persist routing mode', err);
        // Keep going — the in-memory preference still drives the reroute
        // below even if the persist call failed; it'll retry on the next edit.
      }
    }

    if (this._lastRoutedWaypoints?.length >= 2) {
      this.updateRoute(this._lastRoutedWaypoints, { force: true });
    }
  },

  /**
   * Routing failed. Keep whatever route is currently drawn — a slightly stale
   * line beats a blank map — and tell the rider once, not once per retry.
   */
  _handleRoutingError() {
    this._setRoutingBusy(false);
    const now = Date.now();
    if (now - (this._routeErrorAt || 0) > 8000) {
      this._routeErrorAt = now;
      UI.showToast('Route service unavailable — check connection', 'error');
    }
  },

  _setRoutingBusy(busy) {
    document.body.classList.toggle('routing-busy', !!busy);
  },

  /** Score, cache, draw, and hand the routes to the selector and the editor. */
  _applyRoutes(routes, waypoints, { persist = false } = {}) {
    if (!Array.isArray(routes) || !routes.length) return;

    this._scoreRoutes(routes);
    this._cachedAlternatives = routes;
    this._selectedRouteIndex = Math.min(Math.max(this._selectedRouteIndex, 0), routes.length - 1);

    this._drawRoutes(routes);
    this._renderRouteSelector(routes);

    const selected = routes[this._selectedRouteIndex] || routes[0];
    if (this.routeEditor) {
      this.routeEditor.update(waypoints || [], selected.coordinates, selected.waypointIndices);
    }
    if (persist) this._persistSelected();
  },

  /**
   * Clear route from map
   */
  clearRoute() {
    clearTimeout(this._routeDebounceTimer);
    this._routeGen++; // invalidate any in-flight response
    if (this._routeXhr) {
      try { this._routeXhr.abort(); } catch (_) { /* already settled */ }
      this._routeXhr = null;
    }
    if (this._ghAbortController) {
      try { this._ghAbortController.abort(); } catch (_) { /* already settled */ }
      this._ghAbortController = null;
    }
    this._setRoutingBusy(false);
    this._clearRouteLayers();
    this._hideRouteSelector();
    if (this.routeEditor) this.routeEditor.clear();
    this._selectedRouteIndex = 0;
    this._cachedAlternatives = [];
    // No route means nothing for the fuel overlay to draw either.
    this._clearFuelLayers();
    this._removeFuelChip();
    this._fuelChipSignature = null;
  },

  /* ══════════════════════════════════════════════════════════════════
     Restore hooks used by App.restoreAlternativesToMap / trip-controller
     ══════════════════════════════════════════════════════════════════ */

  /**
   * Draw a specific route geometry (App.restoreAlternativesToMap and the
   * ride:routeSelected handler). If it is one of the cached alternatives this
   * just moves the selection; otherwise it becomes the drawn route. Never
   * persists — the caller owns that decision.
   */
  drawRoute(coordinates) {
    const coords = this._normalizeCoords(coordinates);
    if (coords.length < 2) return;

    const routes = this._cachedAlternatives || [];
    const idx = routes.findIndex(r => this._sameGeometry(r, { coordinates: coords }));
    if (idx >= 0) {
      if (idx !== this._selectedRouteIndex) {
        this._selectedRouteIndex = idx;
        this.routeSelector?.selectRoute(idx, { silent: true });
        this._drawRoutes(routes);
        this.routeEditor?.update(
          this._lastRoutedWaypoints || [], routes[idx].coordinates, routes[idx].waypointIndices
        );
      }
      return;
    }

    const route = this._normalizeRoute({ coordinates: coords }, 0);
    this._selectedRouteIndex = 0;
    this._cachedAlternatives = [route];
    this._scoreRoutes([route]);
    this._drawRoutes([route]);
    this._hideRouteSelector();
    this.routeEditor?.update(this._lastRoutedWaypoints || [], route.coordinates, null);
  },

  /**
   * Merge stored alternatives into the drawn set without touching the
   * selection or the server. updateRoute's restore path normally has these
   * already; this reconciles the leftovers (e.g. a trip whose primary route
   * was never saved).
   */
  _adoptStoredRoutes(list) {
    if (!Array.isArray(list) || !list.length) return;
    const incoming = list
      .map((r, i) => this._normalizeRoute(r, i))
      .filter(r => r.coordinates.length >= 2);
    if (!incoming.length) return;

    const current = this._cachedAlternatives || [];
    const merged = current.slice();
    incoming.forEach((r) => {
      if (!merged.some(m => this._sameGeometry(m, r))) merged.push(r);
    });
    if (merged.length === current.length) return;

    const selected = current[this._selectedRouteIndex] || null;
    merged.forEach((r, i) => { r.index = i; });
    this._cachedAlternatives = merged;
    const foundIdx = selected ? merged.findIndex(m => this._sameGeometry(m, selected)) : -1;
    this._selectedRouteIndex = foundIdx >= 0 ? foundIdx : 0;

    this._scoreRoutes(merged);
    this._drawRoutes(merged);
    this._renderRouteSelector(merged);
  },

  setAlternativeRoots(routes) { this._adoptStoredRoutes(routes); },

  onAlternativesChange(routes) { this._adoptStoredRoutes(routes); },

  showAlternativeRoute(route, isActive) {
    if (!isActive || !route) return;
    this.drawRoute(route.coordinates);
  },

  /* ══════════════════════════════════════════════════════════════════
     Viewport helpers
     ══════════════════════════════════════════════════════════════════ */

  /**
   * Fit map to show all waypoints
   */
  fitToWaypoints(waypoints) {
    if (!waypoints || waypoints.length === 0) return;

    const bounds = L.latLngBounds(
      waypoints.map(wp => [wp.lat, wp.lng])
    );

    this.map.fitBounds(bounds, { padding: [50, 50] });
  },

  /**
   * Center on specific waypoint
   */
  centerOnWaypoint(waypoint) {
    if (!waypoint) return;
    this.map.setView([waypoint.lat, waypoint.lng], 15);

    // Open popup
    if (this.waypointMarkers[waypoint.id]) {
      this.waypointMarkers[waypoint.id].openPopup();
    }
  },

  /**
   * Clear all markers and routes
   */
  clear() {
    this.clearRoute();
    // Re-arm restore-on-open: the next route pass draws the saved geometry
    // of whichever trip is loaded rather than re-querying OSRM.
    this._restoredTripKey = null;
    this._lastRoutedWaypoints = [];
    Object.keys(this.waypointMarkers).forEach(id => {
      this.map.removeLayer(this.waypointMarkers[id]);
    });
    this.waypointMarkers = {};
    if (this.routeSelector) this.routeSelector.clear();
    this.clearRideLogs();
  },

  /**
   * Draw historical ride-log tracks for the current trip.
   * Each track is a subtle dashed emerald polyline, distinct from the planned route.
   * @param {Array} logs — array of {id, started_at, track: [{lat,lng,t}], distance_meters, duration_seconds}
   */
  drawRideLogs(logs) {
    this.clearRideLogs();
    if (!Array.isArray(logs) || !logs.length) return;
    logs.forEach(log => {
      const pts = Array.isArray(log.track) ? log.track : [];
      if (pts.length < 2) return;
      const latlngs = pts.map(p => [p.lat, p.lng]);
      const dist = log.distance_meters ? RideUtils.formatDistance(log.distance_meters) : '';
      const dur  = log.duration_seconds ? RideUtils.formatDuration(log.duration_seconds) : '';
      const date = log.started_at
        ? new Date(log.started_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
        : '';
      const layer = L.polyline(latlngs, {
        color: this._cssVar('--trail-log', '#10b981'),
        weight: 3,
        opacity: 0.55,
        dashArray: '6 4',
        className: 'ride-log-track'
      }).addTo(this.map);
      const label = [date, dist, dur].filter(Boolean).join(' · ');
      if (label) layer.bindTooltip(label, { sticky: true, className: 'ride-log-tooltip' });
      (this._rideLogLayers = this._rideLogLayers || []).push(layer);
    });
  },

  /**
   * Remove all historical ride-log track layers.
   */
  clearRideLogs() {
    (this._rideLogLayers || []).forEach(l => { try { this.map.removeLayer(l); } catch (_) {} });
    this._rideLogLayers = [];
  }
};

// Make available globally
window.MapManager = MapManager;
