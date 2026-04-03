/**
 * Map ride module — GPS tracking, heading-up rotation, wake lock, rerouting
 * Extends MapManager defined in map.js
 */
Object.assign(MapManager, {
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
  }
});
