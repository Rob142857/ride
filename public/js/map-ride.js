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
      try { await this._wakeLock.release(); } catch { /* ignore */ }
      this._wakeLock = null;
    }
  },

  /**
   * Start riding mode: show live position and follow
   */
  startRide(onPosition, onStatus) {
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
    this.rideStatusCb = onStatus;
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
    this._rideTrailSegments = [[]];
    if (this._rideTrailLayer) this.map.removeLayer(this._rideTrailLayer);
    this._rideTrailLayer = L.polyline([], {
      ...RideBasemaps.routeStyle(this.map.getZoom(), { color: '#34d399' }),
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
        if (document.visibilityState === 'hidden') return;
        this._gpsErrors = 0; // reset on success
        const timestamp = Number(pos.timestamp) || Date.now();
        const { latitude, longitude, heading, accuracy } = pos.coords;
        const fix = { lat: latitude, lng: longitude, heading, accuracy, timestamp };
        if (window.RideNavigation && !window.RideNavigation.isUsableNavigationFix(fix)) {
          this.rideStatusCb?.({ type: 'weak-fix' });
          return;
        }
        const last = this._lastAcceptedRideFix;
        const elapsed = last ? (timestamp - last.timestamp) / 1000 : null;
        if (elapsed != null && (elapsed <= 0 || RideUtils.haversine(last, fix) / elapsed > 70)) {
          this.rideStatusCb?.({ type: 'weak-fix' });
          return;
        }
        this._lastAcceptedRideFix = fix;
        if ((this._lastRideFixAt && timestamp - this._lastRideFixAt > 30000) || this._rideGapPending) {
          this.rideStatusCb?.({ type: 'gap', reason: 'gps-gap', durationMs: this._lastRideFixAt ? timestamp - this._lastRideFixAt : null });
          this._rideTrailSegments.push([]);
        }
        this._rideGapPending = false;
        this._lastRideFixAt = timestamp;
        this.rideStatusCb?.({ type: 'fix' });
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
        this._rideTrailSegments[this._rideTrailSegments.length - 1].push(latlng);
        if (this._rideTrailLayer) {
          this._rideTrailLayer.setLatLngs(this._rideTrailSegments);
        }

        if (!this.rideAccuracyCircle) {
          this.rideAccuracyCircle = L.circle(latlng, { radius: accuracy || 20, color: '#60a5fa', weight: 1, fillOpacity: 0.08 }).addTo(this.map);
        } else {
          this.rideAccuracyCircle.setLatLng(latlng);
          this.rideAccuracyCircle.setRadius(accuracy || 20);
        }

        if (typeof this.ridePositionCb === 'function') {
          this.ridePositionCb(fix);
        }
      },
      (err) => {
        console.error('Ride GPS error', err);
        this._gpsErrors = (this._gpsErrors || 0) + 1;
        this._rideGapPending = true;
        this.rideStatusCb?.({ type: 'error', reason: 'gps-error', error: err });
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
    this._cancelPendingRideRoute();
    if (this.rideWatchId && navigator.geolocation) {
      navigator.geolocation.clearWatch(this.rideWatchId);
    }
    clearTimeout(this._gpsRetryTimer);
    this.rideWatchId = null;
    this.ridePositionCb = null;
    this.rideStatusCb = null;
    this._lastRideFixAt = null;
    this._lastAcceptedRideFix = null;
    this._rideGapPending = false;
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
      this._rideTrailSegments = [];
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

  /** Request a route for the active navigation leg without touching the plan. */
  rerouteRideLeg(startPos, targetWaypoint, context, onSuccess, onError) {
    if (!targetWaypoint || !this.map) return;
    this._cancelPendingRideRoute();
    const map = this.map;
    const pending = { context, handle: null, cancelled: false };
    this._pendingRideRouteRequest = pending;
    // A direct OSRM request adds no map control or provisional route. Removing
    // a Routing.control inside routesfound would interrupt LRM's subsequent
    // setAlternatives/rendering on a control whose map has become null.
    try {
      const router = L.Routing.osrmv1({ serviceUrl: this.OSRM_SERVICE_URL });
      const formatter = new L.Routing.Formatter();
      const waypoints = [startPos, targetWaypoint].map(point =>
        L.Routing.waypoint(L.latLng(point.lat, point.lng)));
      pending.handle = router.route(waypoints, (error, routes) => {
        if (pending.cancelled || this._pendingRideRouteRequest !== pending || this.map !== map) return;
        const route = routes?.[0];
        if (error || !route?.coordinates?.length) {
          this._pendingRideRouteRequest = null;
          onError?.(error || new Error('Routing service returned no route'), context);
          return;
        }
        let routeData;
        try {
          routeData = {
            distance: route.summary.totalDistance,
            duration: route.summary.totalTime,
            coordinates: route.coordinates.map(point => ({ lat: point.lat, lng: point.lng })),
            steps: (route.instructions || []).map((instruction, index) => ({
              text: instruction.text || formatter.formatInstruction(instruction, index),
              distance: instruction.distance,
              time: instruction.time,
              index: instruction.index
            }))
          };
        } catch (conversionError) {
          this._pendingRideRouteRequest = null;
          onError?.(conversionError, context);
          return;
        }
        this._pendingRideRouteRequest = null;
        onSuccess?.(routeData, context);
      }, this, { alternatives: false, steps: true });
    } catch (error) {
      if (this._pendingRideRouteRequest !== pending || pending.cancelled) return;
      this._pendingRideRouteRequest = null;
      onError?.(error, context);
    }
  },

  _cancelPendingRideRoute() {
    const pending = this._pendingRideRouteRequest;
    this._pendingRideRouteRequest = null;
    if (!pending) return;
    pending.cancelled = true;
    try { pending.handle?.abort(); } catch { /* stale callbacks are also ignored */ }
  },

  setRideNavigationRoute(routeData) {
    if (!this.map || !routeData?.coordinates?.length) return;
    if (this._rideNavigationLayer) this.map.removeLayer(this._rideNavigationLayer);
    const coords = routeData.coordinates.map(point => [point.lat ?? point[1], point.lng ?? point[0]]);
    this._rideNavigationLayer = L.polyline(coords, {
      ...RideBasemaps.routeStyle(this.map.getZoom(), { color: '#3b82f6', selected: true }),
      className: 'ride-navigation-route'
    }).addTo(this.map);
  },

  clearRideNavigationRoute() {
    this._cancelPendingRideRoute();
    if (this._rideNavigationLayer && this.map) this.map.removeLayer(this._rideNavigationLayer);
    this._rideNavigationLayer = null;
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
