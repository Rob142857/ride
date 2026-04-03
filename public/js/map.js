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

    // User can manually locate via the locate button

    // Map click handler for adding waypoints
    this.map.on('click', (e) => this.handleMapClick(e));

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
      // Update route line weight
      if (this.routingControl) {
        const routes = this.routingControl._routes;
        if (routes) {
          this.routingControl.options.lineOptions.styles = this._routeStyles();
        }
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
   * Get route line weight based on current zoom level
   */
  _routeStyles() {
    const z = this.map?.getZoom() || 13;
    // Thinner at low zoom, fuller when zoomed in
    const w = z <= 8 ? 2 : z <= 11 ? 3 : z <= 14 ? 4 : 5;
    return [
      { color: '#e94560', opacity: 0.85, weight: w },
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
        styles: this._routeStyles()
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
