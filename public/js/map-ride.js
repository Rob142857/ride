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

    // Create rider marker
    if (!this.rideMarker) {
      this.rideMarker = L.marker([0, 0], {
        icon: this.createRideIcon(0),
        interactive: false
      }).addTo(this.map);
    }

    this.ridePositionCb = onPosition;
    this._gpsErrors = 0;

    // Follow mode: true = auto-pan to rider; false = user has panned away
    this._rideFollowing = true;
    this._rideInitialZoomDone = false;

    // Detect user-initiated map moves and break follow mode.
    // Leaflet populates e.originalEvent only for user gestures (touch/mouse);
    // programmatic moves (panTo, setView) have no originalEvent.
    this._onRideMoveStart = (e) => {
      if (e.originalEvent && !this._programmaticMove && this._rideFollowing) {
        this._rideFollowing = false;
        this._updateFollowBtn();
      }
    };
    this.map.on('movestart', this._onRideMoveStart);

    // Live trail polyline — drawn as the rider moves
    this._rideTrailCoords = [];
    if (this._rideTrailLayer) this.map.removeLayer(this._rideTrailLayer);
    this._rideTrailLayer = L.polyline([], {
      color: '#34d399',
      weight: 4,
      opacity: 0.75,
      className: 'ride-trail-live'
    }).addTo(this.map);

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
        // Rotate the rider arrow to point in direction of travel
        this.rideMarker.setIcon(this.createRideIcon(heading || 0));

        // First GPS fix: fly to the rider's position at a navigation-friendly
        // zoom (15), then never force-zoom again — honour the user's choice.
        if (!this._rideInitialZoomDone) {
          this._rideInitialZoomDone = true;
          this._rideFollowing = true;
          this._updateFollowBtn();
          this._programmaticMove = true;
          this.map.setView(latlng, Math.max(this.map.getZoom(), 15), { animate: true });
          setTimeout(() => { this._programmaticMove = false; }, 600);
        } else if (this._rideFollowing) {
          // Auto-pan only — never change zoom after the first fix
          const currentCenter = this.map.getCenter();
          const distToCenter = this.haversineLatLng(currentCenter, latlng);
          if (distToCenter > 30) {
            this._programmaticMove = true;
            this.map.panTo(latlng, { animate: true, duration: 0.5 });
            setTimeout(() => { this._programmaticMove = false; }, 600);
          }
        }

        // Grow live trail
        this._rideTrailCoords.push(latlng);
        if (this._rideTrailLayer) {
          this._rideTrailLayer.setLatLngs(this._rideTrailCoords);
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
    this._rideFollowing = false;
    this._rideInitialZoomDone = false;
    this._programmaticMove = false;

    if (this._onRideMoveStart) {
      this.map.off('movestart', this._onRideMoveStart);
      this._onRideMoveStart = null;
    }

    this._releaseWakeLock();
    if (this.rideMarker) {
      this.map.removeLayer(this.rideMarker);
      this.rideMarker = null;
    }
    if (this.rideAccuracyCircle) {
      this.map.removeLayer(this.rideAccuracyCircle);
      this.rideAccuracyCircle = null;
    }
    // Remove live trail (historical logs will be drawn separately)
    if (this._rideTrailLayer) {
      this.map.removeLayer(this._rideTrailLayer);
      this._rideTrailLayer = null;
      this._rideTrailCoords = [];
    }
    this._updateFollowBtn();
  },

  /**
   * Update the recenter button appearance to reflect follow-mode state.
   */
  _updateFollowBtn() {
    const btn = document.getElementById('rideRecenterBtn');
    if (!btn) return;
    if (this._rideFollowing) {
      btn.classList.add('ride-fab-following');
      btn.setAttribute('aria-label', 'Following — tap to stop');
    } else {
      btn.classList.remove('ride-fab-following');
      btn.setAttribute('aria-label', 'Recenter on rider');
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
   * Recenter on rider.
   * Re-enables follow mode; pans to rider at current zoom (floor 13 so the
   * map is still useful for navigation if the user had zoomed way out).
   */
  recenterRide() {
    if (this.rideMarker) {
      this._rideFollowing = true;
      this._updateFollowBtn();
      this._programmaticMove = true;
      const targetZoom = Math.max(this.map.getZoom(), 13);
      this.map.setView(this.rideMarker.getLatLng(), targetZoom, { animate: true });
      setTimeout(() => { this._programmaticMove = false; }, 600);
    }
  }
});
