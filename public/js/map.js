/**
 * Map module - handles Leaflet map and routing
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
   * Acquire screen wake lock to prevent display from sleeping during ride
   */
  async _acquireWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      this._wakeLock = await navigator.wakeLock.request('screen');
      this._wakeLock.addEventListener('release', () => { this._wakeLock = null; });
      // Re-acquire on visibility change (system may release on tab switch)
      document.addEventListener('visibilitychange', this._onVisibilityChange);
    } catch (e) {
      console.warn('Wake lock failed:', e);
    }
  },

  _onVisibilityChange() {
    if (document.visibilityState === 'visible' && MapManager.rideWatchId && !MapManager._wakeLock) {
      MapManager._acquireWakeLock();
    }
  },

  async _releaseWakeLock() {
    document.removeEventListener('visibilitychange', this._onVisibilityChange);
    if (this._wakeLock) {
      try { await this._wakeLock.release(); } catch (e) { /* ignore */ }
      this._wakeLock = null;
    }
  },

  /**
   * Start riding mode: show live position and follow
   */
  startRide(onPosition) {
    if (!('geolocation' in navigator)) {
      UI.showToast('GPS not available on this device', 'error');
      return;
    }

    // Ensure map is ready
    if (!this.map) return;

    // Acquire wake lock to keep screen on
    this._acquireWakeLock();

    // Enable heading-up rotation
    this._headingUp = true;

    // Create rider marker
    if (!this.rideMarker) {
      this.rideMarker = L.marker([0, 0], {
        icon: this.createRideIcon(0),
        interactive: false
      }).addTo(this.map);
    }

    this.ridePositionCb = onPosition;
    this._gpsErrors = 0;

    this._startGpsWatch();
  },

  _startGpsWatch() {
    if (this.rideWatchId) {
      navigator.geolocation.clearWatch(this.rideWatchId);
    }
    clearTimeout(this._gpsRetryTimer);

    // Watch position
    this.rideWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        this._gpsErrors = 0; // reset on success
        const { latitude, longitude, heading, accuracy } = pos.coords;
        const latlng = [latitude, longitude];
        this.rideHeading = heading;
        this.rideMarker.setLatLng(latlng);
        // In heading-up mode the marker always points up; the map rotates instead
        this.rideMarker.setIcon(this.createRideIcon(this._headingUp ? 0 : (heading || 0)));

        // Heading-up: rotate map container so rider's heading points up
        if (this._headingUp && heading != null && isFinite(heading)) {
          this._setMapRotation(-heading);
        }

        // Auto-pan to rider
        const currentCenter = this.map.getCenter();
        const distToCenter = this.haversineLatLng(currentCenter, latlng);
        if (distToCenter > 30) {
          this.map.panTo(latlng, { animate: true });
        }

        if (!this.rideAccuracyCircle) {
          this.rideAccuracyCircle = L.circle(latlng, { radius: accuracy || 20, color: '#60a5fa', weight: 1, fillOpacity: 0.08 }).addTo(this.map);
        } else {
          this.rideAccuracyCircle.setLatLng(latlng);
          this.rideAccuracyCircle.setRadius(accuracy || 20);
        }

        if (typeof this.ridePositionCb === 'function') {
          this.ridePositionCb({ lat: latitude, lng: longitude, heading, accuracy });
        }
      },
      (err) => {
        console.error('Ride GPS error', err);
        this._gpsErrors = (this._gpsErrors || 0) + 1;
        // Retry up to 5 times with backoff before giving up
        if (this._gpsErrors <= 5) {
          const delay = Math.min(2000 * this._gpsErrors, 10000);
          UI.showToast(`GPS signal lost — retrying…`, 'error');
          this._gpsRetryTimer = setTimeout(() => this._startGpsWatch(), delay);
        } else {
          UI.showToast('GPS unavailable. Check location settings.', 'error');
        }
      },
      {
        enableHighAccuracy: true,
        maximumAge: 3000,
        timeout: 10000
      }
    );
  },

  /**
   * Stop riding mode tracking
   */
  stopRide() {
    if (this.rideWatchId && navigator.geolocation) {
      navigator.geolocation.clearWatch(this.rideWatchId);
    }
    clearTimeout(this._gpsRetryTimer);
    this.rideWatchId = null;
    this.ridePositionCb = null;
    this._gpsErrors = 0;
    this._headingUp = false;
    // Reset map rotation
    this._setMapRotation(0);
    this._releaseWakeLock();
    if (this.rideMarker) {
      this.map.removeLayer(this.rideMarker);
      this.rideMarker = null;
    }
    if (this.rideAccuracyCircle) {
      this.map.removeLayer(this.rideAccuracyCircle);
      this.rideAccuracyCircle = null;
    }
  },

  createRideIcon(heading) {
    const rotation = `transform: rotate(${heading || 0}deg);`;
    return L.divIcon({
      className: 'ride-marker',
      html: `<div class="ride-marker-inner" style="${rotation}"><div class="ride-arrow"></div></div>`
    });
  },

  /** Delegate to shared utility */
  haversineLatLng(a, b) { return RideUtils.haversine(a, b); },

  rerouteFromPosition(startPos, remainingWaypoints = []) {
    const startLatLng = L.latLng(startPos.lat, startPos.lng);
    const ordered = [startLatLng, ...remainingWaypoints.map(wp => L.latLng(wp.lat, wp.lng))];

    // Clear existing route/control and rebuild
    this.clearRoute();

    if (ordered.length < 2) return;

    this.routingControl = L.Routing.control({
      waypoints: ordered,
      serviceUrl: this.OSRM_SERVICE_URL,
      routeWhileDragging: false,
      showAlternatives: false,
      addWaypoints: false,
      fitSelectedRoutes: false,
      lineOptions: {
        styles: [
          { color: '#e94560', opacity: 0.8, weight: 6 },
          { color: '#ff6b6b', opacity: 0.5, weight: 10 }
        ]
      },
      createMarker: () => null,
      show: false
    }).addTo(this.map);

    this.routingControl.on('routesfound', (e) => {
      const route = e.routes[0];
      if (route) {
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
          steps
        });

        UI.showToast('Rerouted', 'info');
      }
    });

    this.routingControl.on('routingerror', (e) => {
      console.error('Reroute failed:', e.error);
      App.rideRerouting = false;
      UI.showToast('Reroute failed — following original route', 'error');
    });
  },

  /**
   * Recenter on rider (also re-enables heading-up if it was on)
   */
  recenterRide() {
    if (this.rideMarker) {
      this._headingUp = true;
      this.map.setView(this.rideMarker.getLatLng(), Math.max(this.map.getZoom(), 15));
      if (this.rideHeading != null && isFinite(this.rideHeading)) {
        this._setMapRotation(-this.rideHeading);
      }
    }
  },

  /**
   * Rotate the map container via CSS transform for heading-up display
   */
  _setMapRotation(deg) {
    const el = this.map?.getContainer();
    if (!el) return;
    el.style.transform = deg ? `rotate(${deg}deg)` : '';
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

    // Add tile layer (CARTO Voyager — full-color streets, good contrast)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 19
    }).addTo(this.map);

    // Disable heading-up when user manually drags/pans the map
    this.map.on('dragstart', () => { this._headingUp = false; });

    // Add zoom control to bottom left (away from nav)
    L.control.zoom({ position: 'bottomleft' }).addTo(this.map);

    // Try to get user's location
    this.locateUser();

    // Map click handler for adding waypoints
    this.map.on('click', (e) => this.handleMapClick(e));

    // Handle resize
    window.addEventListener('resize', () => {
      this.map.invalidateSize();
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
      const nameInput = document.getElementById('waypointName');
      if (nameInput && !nameInput.value.trim()) {
        const nextNum = (App.currentTrip?.waypoints?.length || 0) + 1;
        nameInput.value = `Waypoint ${nextNum}`;
      }

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
   * Create custom icon for waypoint type
   */
  createIcon(type) {
    const config = this.waypointIcons[type] || this.waypointIcons.stop;
    
    return L.divIcon({
      className: 'custom-marker',
      html: `<div style="
        background: ${config.color};
        width: 36px;
        height: 36px;
        border-radius: 50% 50% 50% 0;
        transform: rotate(-45deg);
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        border: 2px solid white;
      "><span style="transform: rotate(45deg); font-size: 16px;">${config.icon}</span></div>`,
      iconSize: [36, 36],
      iconAnchor: [18, 36],
      popupAnchor: [0, -36]
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
  },

  /**
   * Update route between waypoints
   */
  updateRoute(waypoints) {
    // Clear existing route
    this.clearRoute();

    if (waypoints.length < 2) return;

    // Create waypoints for routing
    const routeWaypoints = [...waypoints]
      .sort((a, b) => a.order - b.order)
      .map(wp => L.latLng(wp.lat, wp.lng));

    // Create routing control
    this.routingControl = L.Routing.control({
      waypoints: routeWaypoints,
      serviceUrl: this.OSRM_SERVICE_URL,
      routeWhileDragging: true,
      showAlternatives: false,
      addWaypoints: true, // Allow adding waypoints by clicking on route
      fitSelectedRoutes: false,
      lineOptions: {
        styles: [
          { color: '#e94560', opacity: 0.8, weight: 6 },
          { color: '#ff6b6b', opacity: 0.5, weight: 10 }
        ]
      },
      createMarker: () => null, // We manage our own markers
      show: false // Hide the directions panel
    }).addTo(this.map);

    // Handle route changes from dragging
    this.routingControl.on('routesfound', (e) => {
      const route = e.routes[0];
      if (route) {
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
          steps
        });

      }
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
  }
};

// Make available globally
window.MapManager = MapManager;
