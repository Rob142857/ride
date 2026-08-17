/**
 * Map ride module — GPS tracking, wake lock, rerouting
 * Extends MapManager defined in map.js
 */
Object.assign(MapManager, {
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
    this._gpsLostToastShown = false;
    this._lastIconHeading = null;
    this._lastMarkerFix = null;

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

    // Live trail polyline — appended as the rider moves (sampled ≥5 m)
    this._rideTrailLast = null;
    if (this._rideTrailLayer) this.map.removeLayer(this._rideTrailLayer);
    this._rideTrailLayer = L.polyline([], {
      color: this._cssVar('--trail', '#34d399'),
      weight: 4,
      opacity: 0.75,
      className: 'ride-trail-live'
    }).addTo(this.map);

    // Any stale ephemeral reroute line from a previous ride
    this.clearRideRouteLine();

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
        this._gpsLostToastShown = false;
        const { latitude, longitude, heading, accuracy, speed } = pos.coords;
        const latlng = [latitude, longitude];
        const poorFix = (accuracy || 0) > 80;

        // Heading: prefer the GPS course; fall back to the bearing between
        // consecutive fixes so the arrow still rotates on devices that never
        // report heading. Keep the last known heading while stationary.
        let hdg = (heading != null && isFinite(heading)) ? heading : null;
        if (hdg == null && this._lastMarkerFix) {
          const moved = RideUtils.haversine(this._lastMarkerFix, { lat: latitude, lng: longitude });
          if (moved >= 3) hdg = RideUtils.bearing(this._lastMarkerFix, { lat: latitude, lng: longitude });
        }
        if (hdg == null) hdg = this._lastIconHeading ?? 0;
        this.rideHeading = hdg;
        this._lastMarkerFix = { lat: latitude, lng: longitude };

        // Always move the marker — even a poor fix is better than a frozen one
        this.rideMarker.setLatLng(latlng);
        const roundedHdg = Math.round(hdg);
        if (roundedHdg !== this._lastIconHeading) {
          this._lastIconHeading = roundedHdg;
          this.rideMarker.setIcon(this.createRideIcon(roundedHdg));
        }

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

        // Grow live trail — appended, sampled, and only from trustworthy fixes
        // so cold-start teleports don't scribble across the map.
        if (!poorFix && this._rideTrailLayer) {
          if (!this._rideTrailLast ||
              RideUtils.haversine(this._rideTrailLast, { lat: latitude, lng: longitude }) >= 15) {
            this._rideTrailLast = { lat: latitude, lng: longitude };
            this._rideTrailLayer.addLatLng(latlng);
            // Keep the drawn trail bounded — an all-day ride would otherwise
            // re-project tens of thousands of points every frame, exactly when
            // battery and thermals matter most. Halving preserves full extent.
            const pts = this._rideTrailLayer.getLatLngs();
            if (pts.length > 2000) {
              const lastIdx = pts.length - 1;
              this._rideTrailLayer.setLatLngs(pts.filter((_, i) => i % 2 === 0 || i === lastIdx));
            }
          }
        }

        if (!this.rideAccuracyCircle) {
          this.rideAccuracyCircle = L.circle(latlng, {
            radius: accuracy || 20,
            color: this._cssVar('--gps-accuracy', '#60a5fa'),
            weight: 1,
            fillOpacity: 0.08
          }).addTo(this.map);
        } else {
          this.rideAccuracyCircle.setLatLng(latlng);
          this.rideAccuracyCircle.setRadius(accuracy || 20);
        }
        // Dim the circle on poor fixes — visible "weak GPS" cue without alarm
        this.rideAccuracyCircle.setStyle({
          opacity: poorFix ? 0.35 : 1,
          fillOpacity: poorFix ? 0.04 : 0.08
        });

        if (typeof this.ridePositionCb === 'function') {
          this.ridePositionCb({ lat: latitude, lng: longitude, heading, accuracy, speed });
        }
      },
      (err) => {
        if (err && err.code === 1) {
          // PERMISSION_DENIED — retrying is pointless; stop and guide the user.
          if (this.rideWatchId && navigator.geolocation) {
            navigator.geolocation.clearWatch(this.rideWatchId);
          }
          this.rideWatchId = null;
          if (typeof App._setRideGpsState === 'function') App._setRideGpsState('denied');
          UI.showToast('Location permission denied. Enable location access for this site in your browser settings, then start the ride again.', 'error');
          return;
        }
        // TIMEOUT / POSITION_UNAVAILABLE — retry forever with capped backoff.
        this._gpsErrors = (this._gpsErrors || 0) + 1;
        if (typeof App._setRideGpsState === 'function') App._setRideGpsState('lost');
        if (!this._gpsLostToastShown) {
          this._gpsLostToastShown = true;
          UI.showToast('GPS signal lost — retrying…', 'error');
        }
        const delay = Math.min(2000 * this._gpsErrors, 15000);
        this._gpsRetryTimer = setTimeout(() => this._startGpsWatch(), delay);
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
    clearTimeout(this._rerouteWatchdog);
    // Invalidate any in-flight reroute so a late response can't touch state
    this._rerouteSeq = (this._rerouteSeq || 0) + 1;
    this.rideWatchId = null;
    this.ridePositionCb = null;
    this._gpsErrors = 0;
    this._gpsLostToastShown = false;
    this._rideFollowing = false;
    this._rideInitialZoomDone = false;
    this._programmaticMove = false;
    this._lastMarkerFix = null;

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
      this._rideTrailLast = null;
    }
    // Remove the ephemeral in-ride reroute line — the planned (golden) route
    // drawn by the routing control was never touched, so it remains intact.
    this.clearRideRouteLine();
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
    // iconSize/iconAnchor must be explicit: L.DivIcon's default is [12,12],
    // and Leaflet writes that as INLINE width/height/margins which override
    // .ride-marker's 28px CSS box — leaving the visual centre ~8px down-right
    // of the true GPS fix on every tick. Every other divIcon in the codebase
    // passes both; this one was the outlier.
    return L.divIcon({
      className: 'ride-marker',
      iconSize: [28, 28],
      iconAnchor: [14, 14],
      html: `<div class="ride-marker-inner" style="${rotation}"><div class="ride-arrow"></div></div>`
    });
  },

  /** Delegate to shared utility */
  haversineLatLng(a, b) { return RideUtils.haversine(a, b); },

  /**
   * Reroute from the rider's live position through the remaining stops.
   *
   * Deliberately does NOT touch the planning routing control: the planned
   * route line stays drawn no matter what, the new navigation path is drawn
   * as a separate ephemeral polyline, and route data is handed to
   * App.applyRideReroute (in-memory only — never persisted). The rideRerouting
   * flag is guaranteed to clear via success, error, and a 20 s watchdog.
   */
  rerouteFromPosition(startPos, remainingWaypoints = []) {
    const startLatLng = L.latLng(startPos.lat, startPos.lng);
    let targets = remainingWaypoints.map(wp => L.latLng(wp.lat, wp.lng));

    // All stops visited (or none exist): navigate to the route's destination.
    if (!targets.length) {
      const coords = App.currentTrip?.route?.coordinates;
      const dest = coords && coords.length ? coords[coords.length - 1] : null;
      if (dest) {
        targets = [L.latLng(dest.lat ?? dest[0], dest.lng ?? dest[1])];
      }
    }
    if (!targets.length) {
      App.rideRerouting = false;
      return;
    }

    const seq = (this._rerouteSeq = (this._rerouteSeq || 0) + 1);

    // Watchdog: never leave the rerouting flag stuck if the router hangs.
    clearTimeout(this._rerouteWatchdog);
    this._rerouteWatchdog = setTimeout(() => {
      if (this._rerouteSeq === seq) App.rideRerouting = false;
    }, 20000);

    let waypoints;
    try {
      waypoints = [startLatLng, ...targets].map(ll =>
        typeof L.Routing.waypoint === 'function' ? L.Routing.waypoint(ll) : { latLng: ll });
      if (!this._rideRouter) {
        this._rideRouter = L.Routing.osrmv1({ serviceUrl: this.OSRM_SERVICE_URL });
      }
    } catch (_) {
      // Router unavailable — clear the flag now rather than blocking every
      // future reroute for the rest of the ride.
      clearTimeout(this._rerouteWatchdog);
      App.rideRerouting = false;
      return;
    }

    this._rideRouter.route(waypoints, function (err, routes) {
      if (this._rerouteSeq !== seq) return; // superseded or ride ended
      clearTimeout(this._rerouteWatchdog);
      App.rideRerouting = false;

      if (err || !routes || !routes.length) {
        console.warn('Reroute failed:', err);
        UI.showToast('Reroute failed — following original route', 'error');
        return; // planned route line untouched
      }

      const route = routes[0];
      const steps = (route.instructions || []).map((instr) => ({
        text: instr.text,
        distance: instr.distance,
        time: instr.time,
        index: instr.index,
        type: instr.type,
        modifier: instr.modifier,
        road: instr.road
      }));

      App.applyRideReroute({
        distance: route.summary.totalDistance,
        duration: route.summary.totalTime,
        coordinates: route.coordinates,
        steps
      });

      this._drawRideRouteLine(route.coordinates);
      UI.showToast('Rerouted', 'info');
    }, this);
  },

  /** Draw the ephemeral in-ride navigation path (above the planned route). */
  _drawRideRouteLine(coordinates) {
    if (!this.map || !Array.isArray(coordinates) || !coordinates.length) return;
    this.clearRideRouteLine();
    this._rideRouteLayer = L.polyline(coordinates, {
      color: this._cssVar('--accent', '#6366f1'),
      weight: 6,
      opacity: 0.9,
      className: 'ride-reroute-line'
    }).addTo(this.map);
  },

  /** Remove the ephemeral in-ride reroute line, if any. */
  clearRideRouteLine() {
    if (this._rideRouteLayer) {
      try { this.map.removeLayer(this._rideRouteLayer); } catch (_) { /* map gone */ }
      this._rideRouteLayer = null;
    }
  },

  /**
   * Recenter on rider.
   * Re-enables follow mode; pans to rider at current zoom (floor 15 to match
   * the initial-fix navigation zoom).
   */
  recenterRide() {
    if (this.rideMarker) {
      this._rideFollowing = true;
      this._updateFollowBtn();
      this._programmaticMove = true;
      const targetZoom = Math.max(this.map.getZoom(), 15);
      this.map.setView(this.rideMarker.getLatLng(), targetZoom, { animate: true });
      setTimeout(() => { this._programmaticMove = false; }, 600);
    }
  }
});
