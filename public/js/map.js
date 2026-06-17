/**
 * Map module — Leaflet map, markers, routing, controls
 * Ride GPS tracking is in map-ride.js
 */
const MapManager = {
  map: null,
  routingControl: null,

  // Self-hosted OSRM routing endpoint (Cloudflare Tunnel → Docker)
  OSRM_SERVICE_URL: 'https://maps.incitat.io/route/v1',
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
  _headingUp: false,

  // Alternative route UI state
  _selectedRouteIndex: 0,
  _cachedAlternatives: null,

  // Extracted UI components
  routeSelector: null,
  routeEditor: null,

  // Waypoint type icons
  waypointIcons: {
    stop: { color: '#e94560', icon: '📍' },
    scenic: { color: '#4ade80', icon: '🏞️' },
    fuel: { color: '#fbbf24', icon: '⛽' },
    food: { color: '#f97316', icon: '🍽️' },
    lodging: { color: '#8b5cf6', icon: '🏨' },
    custom: { color: '#06b6d4', icon: '⭐' }
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

    // Add tile layer (OpenStreetMap default renderer — strong road / topology detail)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      subdomains: 'abc',
      maxZoom: 19,
      crossOrigin: true
    }).addTo(this.map);

    // Disable heading-up when user manually drags/pans the map
    this.map.on('dragstart', () => { this._headingUp = false; });

    // Add zoom control to bottom left (away from nav)
    L.control.zoom({ position: 'bottomleft' }).addTo(this.map);

    // User can manually locate via the locate button

    // Map click handler for adding waypoints
    this.map.on('click', (e) => this.handleMapClick(e));

    // Accessible route-alternatives UI and visible midpoint route editor.
    this.routeSelector = window.RouteSelector?.create(this.map, {
      position: 'top',
      onSelect: (idx) => this._selectRoute(idx)
    });
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
      // Update route line weight if routing control exists
      if (this.routingControl) {
        this._updateRouteLineStyles();
      }
    });

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
          console.log('Geolocation error:', error);
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
      const addressInput = document.getElementById('waypointAddress');
      if (addressInput && !addressInput.value.trim()) {
        addressInput.value = 'Dropped pin from map';
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

  /**
   * Format seconds into "1h 23m" or "45m"
   */
  _fmtTime(seconds) {
    if (!seconds && seconds !== 0) return '';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  },

  /**
   * Format metres into "12.5 km" or "800 m"
   */
  _fmtDist(metres) {
    if (!metres && metres !== 0) return '';
    if (metres >= 1000) return `${(metres / 1000).toFixed(1)} km`;
    return `${Math.round(metres)} m`;
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
   * User tapped an alternative route card
   */
  _selectRoute(index, routes) {
    routes = routes || this._cachedAlternatives;
    if (index === this._selectedRouteIndex || !routes || !routes[index]) return;
    this._selectedRouteIndex = index;

    // Keep the selector component in sync.
    if (this.routeSelector) {
      this.routeSelector.selectRoute(index);
    }

    // Update polyline styles on map
    this._updateRouteLineStyles();

    // Save selected route to App state
    const route = routes[index];
    const steps = (route.instructions || []).map((instr) => ({
      text: instr.text,
      distance: instr.distance,
      time: instr.time,
      index: instr.index
    }));

    App.saveRouteData({
      distance: route.summary.totalDistance,
      duration: route.summary.totalTime,
      coordinates: route.coordinates,
      steps,
      _selectedIndex: index,
      _allAlternatives: routes.map(r => ({
        distance: r.summary.totalDistance,
        duration: r.summary.totalTime,
        coordinates: r.coordinates,
        steps: (r.instructions || []).map(i => ({
          text: i.text,
          distance: i.distance,
          time: i.time,
          index: i.index
        }))
      }))
    });
  },

  /**
   * Re-apply line styles so selected route pops, alternatives subdued
   */
  _updateRouteLineStyles() {
    if (!this.routingControl) return;
    const rc = this.routingControl;
    const lines = [];
    if (rc._line) lines.push(rc._line);
    if (rc._alternatives) lines.push(...rc._alternatives);

    lines.forEach((line, idx) => {
      if (!line || !line.setStyle) return;
      const isSel = idx === this._selectedRouteIndex;
      line.setStyle({
        opacity: isSel ? 0.9 : 0.45,
        weight: isSel ? this._routeWeight() : Math.max(2, this._routeWeight() - 2)
      });
      if (isSel && line.bringToFront) line.bringToFront();
    });
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

  /**
   * Get route line styles based on current zoom level
   */
  _routeStyles() {
    const w = this._routeWeight();
    return [
      { color: '#e94560', opacity: 0.9, weight: w },
      { color: '#ff6b6b', opacity: 0.3, weight: w + 3 }
    ];
  },

  /**
   * Create custom icon for waypoint type
   */
  createIcon(type) {
    const config = this.waypointIcons[type] || this.waypointIcons.stop;
    const z = this.map?.getZoom() || 13;
    const size = z <= 9 ? 22 : z <= 12 ? 28 : 34;
    const fontSize = z <= 9 ? 11 : z <= 12 ? 13 : 15;

    return L.divIcon({
      className: 'custom-marker',
      html: `<div style="
        background: ${config.color};
        width: ${size}px;
        height: ${size}px;
        border-radius: 50% 50% 50% 0;
        transform: rotate(-45deg);
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 2px 6px rgba(0,0,0,0.25);
        border: 2px solid white;
      "><span style="transform: rotate(45deg); font-size: ${fontSize}px;">${config.icon}</span></div>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size],
      popupAnchor: [0, -size]
    });
  },

  /**
   * Add waypoint marker to map
   */
  addWaypointMarker(waypoint) {
    const marker = L.marker([waypoint.lat, waypoint.lng], {
      icon: this.createIcon(waypoint.type),
      draggable: true
    }).addTo(this.map);

    // Store type for zoom-responsive icon refresh
    marker._wpType = waypoint.type || 'stop';

    // Popup with waypoint info
    marker.bindPopup(`
      <div style="min-width: 150px;">
        <strong>${waypoint.name}</strong>
        ${waypoint.notes ? `<p style="margin: 8px 0 0; font-size: 12px;">${waypoint.notes}</p>` : ''}
      </div>
    `);

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
    waypoints.forEach(wp => this.addWaypointMarker(wp));

    // Update routing if we have 2+ waypoints
    if (waypoints.length >= 2) {
      this.updateRoute(waypoints);
    } else {
      this.clearRoute();
    }

    // Keep midpoint handles in sync while editing.
    if (this.routeEditor && waypoints.length >= 2) {
      this.routeEditor.update(waypoints, null);
    }
  },

  /**
   * Update route between waypoints — now with alternatives
   */
  updateRoute(waypoints) {
    this.clearRoute();
    this._hideRouteSelector();
    this._selectedRouteIndex = 0;
    this._cachedAlternatives = null;

    if (waypoints.length < 2) return;

    const routeWaypoints = [...waypoints]
      .sort((a, b) => a.order - b.order)
      .map(wp => L.latLng(wp.lat, wp.lng));

    this.routingControl = L.Routing.control({
      waypoints: routeWaypoints,
      serviceUrl: this.OSRM_SERVICE_URL,
      routeWhileDragging: false,
      showAlternatives: true,
      addWaypoints: false,
      fitSelectedRoutes: false,
      lineOptions: {
        styles: this._routeStyles()
      },
      altLineOptions: {
        styles: [{ color: '#6B8E8E', opacity:0.45, weight: 4 }]
      },
      createMarker: () => null,
      show: false
    }).addTo(this.map);

    this.routingControl.on('routesfound', (e) => {
      const routes = e.routes;
      if (!routes || !routes.length) return;

      this._cachedAlternatives = routes;
      this._renderRouteSelector(routes);
      this._updateRouteLineStyles();

      const route = routes[this._selectedRouteIndex] || routes[0];
      const steps = (route.instructions || []).map((instr) => ({
        text: instr.text,
        distance: instr.distance,
        time: instr.time,
        index: instr.index
      }));

      // Render visible midpoint drag handles on the selected route.
      if (this.routeEditor) {
        this.routeEditor.update(waypoints, route.coordinates);
      }

      App.saveRouteData({
        distance: route.summary.totalDistance,
        duration: route.summary.totalTime,
        coordinates: route.coordinates,
        steps,
        _selectedIndex: this._selectedRouteIndex,
        _allAlternatives: routes.map(r => ({
          distance: r.summary.totalDistance,
          duration: r.summary.totalTime,
          coordinates: r.coordinates,
          steps: (r.instructions || []).map(i => ({
            text: i.text,
            distance: i.distance,
            time: i.time,
            index: i.index
          }))
        }))
      });
    });
  },

  /**
   * Clear route from map
   */
  clearRoute() {
    if (this.routingControl) {
      this.map.removeControl(this.routingControl);
      this.routingControl = null;
    }
    this._hideRouteSelector();
    if (this.routeEditor) this.routeEditor.clear();
    this._selectedRouteIndex = 0;
    this._cachedAlternatives = null;
  },

  /**
   * Fit map to show all waypoints
   */
  fitToWaypoints(waypoints) {
    if (waypoints.length === 0) return;

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
    Object.keys(this.waypointMarkers).forEach(id => {
      this.map.removeLayer(this.waypointMarkers[id]);
    });
    this.waypointMarkers = {};
    if (this.routeEditor) this.routeEditor.clear();
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
        color: '#10b981',
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