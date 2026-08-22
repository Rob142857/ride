/**
 * Ride Controller — ride mode, GPS tracking, rerouting, metrics
 * Extends App object (loaded after app-core.js)
 *
 * localStorage keys:
 *   ride_track_checkpoint — {tripId, startedAt, track} for the ride in
 *     progress; lets a killed/reloaded app recover the track on next launch.
 *   ride_pending_logs — [{qid, tripId, log}] ride logs that couldn't reach
 *     the API; flushed on ride start/exit and when connectivity returns.
 */
Object.assign(App, {
  bindRideControls() {
    document.getElementById('rideAddBtn')?.addEventListener('click', () => {
      document.getElementById('rideAddSheet')?.classList.remove('hidden');
    });
    document.getElementById('rideAddSheetClose')?.addEventListener('click', () => {
      document.getElementById('rideAddSheet')?.classList.add('hidden');
    });
    document.getElementById('rideAddNoteBtn')?.addEventListener('click', () => {
      const createWaypoint = document.getElementById('rideOptWaypoint')?.checked ?? false;
      const position = MapManager.rideMarker ? MapManager.rideMarker.getLatLng() : null;
      document.getElementById('rideAddSheet')?.classList.add('hidden');
      if (!this.ensureEditable('add a note')) return;
      // Defer waypoint creation until the note is actually saved — if the user
      // cancels the note modal, we don't want an orphan waypoint left behind.
      this._pendingRideNoteWaypoint = (createWaypoint && position) ? position : null;
      UI.openModal('noteModal');
    });
    document.getElementById('rideAddPhotoBtn')?.addEventListener('click', () => {
      // Capture ride options before closing sheet
      this._ridePhotoOpts = {
        tagGps: document.getElementById('rideOptGps')?.checked ?? false,
        createWaypoint: document.getElementById('rideOptWaypoint')?.checked ?? false,
        position: MapManager.rideMarker ? MapManager.rideMarker.getLatLng() : null
      };
      document.getElementById('rideAddSheet')?.classList.add('hidden');
      if (!this.ensureEditable('add a photo')) return;
      document.getElementById('ridePhotoInput')?.click();
    });
    document.getElementById('ridePhotoInput')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) { e.target.value = ''; return; }
      const opts = this._ridePhotoOpts || {};
      this._ridePhotoOpts = null;
      await this.addRidePhoto(file, opts);
      e.target.value = '';
    });
    document.getElementById('rideRecenterBtn')?.addEventListener('click', () => {
      MapManager.recenterRide();
    });
    document.getElementById('rideBannerExitBtn')?.addEventListener('click', () => this.exitRideMode());
    // Tank Filled and Find Fuel live in the + menu now (declutters the
    // permanent HUD) — both close the sheet like Note/Photo do.
    document.getElementById('tankFilledBtn')?.addEventListener('click', () => {
      document.getElementById('rideAddSheet')?.classList.add('hidden');
      this._onTankFilled();
    });
    document.getElementById('findFuelBtn')?.addEventListener('click', () => {
      document.getElementById('rideAddSheet')?.classList.add('hidden');
      window.FuelFinder?.openForRoute();
    });

    // Sync locally-queued ride logs whenever connectivity returns, and rescue
    // any checkpointed track left behind by a ride that never exited cleanly
    // (app killed, tab discarded, mid-ride reload).
    window.addEventListener('online', () => this._flushPendingRideLogs());
    setTimeout(() => this._scheduleRideRecovery(), 1500);

    // Fuel settings/percent can change from the Settings modal (or another
    // tap of Tank Filled) — resync visibility and, if mid-ride, the HUD's
    // cached percent whenever that happens.
    window.addEventListener('ride:fuelSettingsChanged', () => this._onFuelSettingsChanged());
    // A fuel stop inserted mid-ride (Find Fuel) or toggled from the waypoint
    // detail panel isn't in route._wpAlong until it's rebuilt — cheapest
    // correct fix is to just rebuild it, same as a reroute does.
    window.addEventListener('ride:fuelStopsChanged', () => {
      if (this.isRiding) this.precomputeRouteMetrics();
    });
  },

  /**
   * Run track recovery once the auth state has settled. Recovering while
   * checkAuth() is still in flight would file a signed-in rider's rescued ride
   * log into localStorage (API._isLocal() reads useCloud, which defaults false)
   * instead of their account. Bounded poll so guests aren't left waiting.
   */
  _scheduleRideRecovery(attempt = 0) {
    const settled = this._authState !== 'UNKNOWN' && this._authState !== 'CHECKING';
    if (!settled && attempt < 10) {
      setTimeout(() => this._scheduleRideRecovery(attempt + 1), 1000);
      return;
    }
    this._recoverAbandonedRide();
    this._flushPendingRideLogs();
  },

  /**
   * Add a photo during ride mode with optional GPS tagging and waypoint creation
   */
  async addRidePhoto(file, opts = {}) {
    if (!this.currentTrip || !this.ensureEditable('save photos')) return;

    // Create waypoint at current GPS position if requested
    if (opts.createWaypoint && opts.position) {
      await this._insertWaypointAtPosition(opts.position);
    }

    // Build photo title — structured location travels on the entry itself
    const now = new Date();
    const title = `Photo ${now.toLocaleString()}`;
    const gpsPos = opts.tagGps && opts.position ? opts.position : null;

    let entry;
    try {
      const entryData = { title, content: '', is_private: false, tags: [] };
      if (gpsPos) {
        entryData.location = { lat: gpsPos.lat, lng: gpsPos.lng };
        entryData.content = `📍 GPS: ${gpsPos.lat.toFixed(6)}, ${gpsPos.lng.toFixed(6)}`;
      }
      entry = await API.journal.add(this.currentTrip.id, entryData);
      if (!this.currentTrip.journal) this.currentTrip.journal = [];
      entry.attachments = [];
      this.currentTrip.journal.push(entry);
    } catch (err) {
      console.error('Failed to create photo note', err);
      UI.showToast('Could not create note for photo.', 'error');
      return;
    }

    this._activeUploads++;
    try {
      UI.showToast('Uploading photo...', 'info');
      const attachment = await API.attachments.upload(this.currentTrip.id, file, { journal_entry_id: entry.id });
      this.addAttachmentToEntry(entry.id, attachment, true);
      UI.showToast('Photo saved to trip', 'success');
    } catch (err) {
      if (err?.code === 'LOGIN_REQUIRED' && typeof UI.suggestLogin === 'function') {
        UI.suggestLogin('upload photos');
      } else {
        console.error('Photo upload failed', err);
        UI.showToast('Photo upload failed', 'error');
      }
    } finally {
      this._activeUploads = Math.max(0, this._activeUploads - 1);
    }
    UI.renderJournal(this.currentTrip.journal);
    this.renderNoteAttachments(entry);
  },

  /**
   * Insert a waypoint at the rider's current GPS position,
   * placed in order between the nearest existing waypoints
   */
  async _insertWaypointAtPosition(latlng) {
    if (!this.currentTrip) return;
    const lat = latlng.lat;
    const lng = latlng.lng;
    const waypoints = this.currentTrip.waypoints || [];

    // Find the best insertion index: after the nearest visited waypoint
    let insertAfter = waypoints.length; // default: append at end
    if (waypoints.length > 0 && this.rideVisitedWaypoints) {
      // Find the last visited waypoint in order — insert after it
      for (let i = waypoints.length - 1; i >= 0; i--) {
        if (this.rideVisitedWaypoints.has(waypoints[i].id)) {
          insertAfter = i + 1;
          break;
        }
      }
    }

    const waypointData = {
      name: `📍 ${new Date().toLocaleTimeString()}`,
      lat, lng
    };

    const newWp = await this.addWaypoint(waypointData);
    if (!newWp) return;

    // Reorder so the new waypoint sits at the correct position
    if (insertAfter < waypoints.length) {
      const order = waypoints.map(w => w.id);
      // Move the new waypoint from end to insertAfter position
      const idx = order.indexOf(newWp.id);
      if (idx !== -1) {
        order.splice(idx, 1);
        order.splice(insertAfter, 0, newWp.id);
        await this.reorderWaypoints(order);
      }
    }
  },

  enterRideMode() {
    // Re-entering mid-ride would reset _rideTrack and overwrite the checkpoint,
    // throwing away everything recorded so far.
    if (this.isRiding) return;
    if (!this.currentTrip) { UI.showToast('No trip loaded', 'error'); return; }
    const activeRoute = this.getActiveRoute();
    if (!activeRoute?.coordinates?.length) {
      UI.showToast('Add a route first to start riding', 'error'); return;
    }
    if (!('geolocation' in navigator)) {
      UI.showToast('Your device does not support GPS', 'error'); return;
    }

    // Rescue any track from a ride that never finished, and retry logs that
    // couldn't reach the server last time — before this ride starts writing
    // its own checkpoint.
    this._recoverAbandonedRide();
    this._flushPendingRideLogs();

    // Snapshot the route unconditionally. Mid-ride reroutes are ephemeral
    // navigation state — they embed the rider's live GPS position as their
    // first coordinate — and must never survive past the ride (privacy:
    // a later trip save would push them to the public trip page).
    this._preRideRoute = this.currentTrip.route;

    // Navigate the ACTIVE route (the alternative the rider selected), not just
    // the primary. We temporarily point currentTrip.route at the active route
    // so the existing HUD / metrics / reroute code all operate on the same
    // geometry the rider sees drawn on the map. The snapshot above is restored
    // on exit so we never persist the swapped value.
    if (activeRoute !== this.currentTrip.route) {
      this.currentTrip.route = {
        ...activeRoute,
        coordinates: activeRoute.coordinates,
        steps: Array.isArray(activeRoute.steps) ? activeRoute.steps : []
      };
    }
    this.isRiding = true;
    this.rideVisitedWaypoints = new Set();
    this.rideRerouting = false;
    this.rideInitialRouted = false;
    this.offRouteCounter = 0;
    this.lastRerouteAt = 0;
    this._rideNearIdx = 0;           // sliding window cursor
    this._rideStartTime = Date.now();
    this._rideArrived = false;
    // GPS breadcrumb track — sampled during ride, saved as private log on exit
    this._rideTrack = [];
    this._rideTrackLastPt = null;
    // Speed / ETA rolling state
    this._speedHist = [];
    this._lastGoodFix = null;
    this._lastDerivedSpeed = null;
    this._poorFixStreak = 0;
    this._rideGpsState = null;
    this._maneuverIconKey = null;

    document.getElementById('rideOverlay')?.classList.remove('hidden');
    document.body.classList.add('ride-mode');
    // Ride mode makes the map full-bleed (body.ride-mode #map { inset: 0 }) —
    // Leaflet must re-measure or the newly exposed band stays blank.
    setTimeout(() => MapManager.map?.invalidateSize(), 60);

    // Keep the screen on for the duration of the ride — a phone that sleeps
    // mid-navigation defeats the point. Best-effort only: unsupported
    // browsers no-op silently (never a toast), and the OS still releases the
    // lock on tab-hide, so a visibilitychange listener re-acquires it.
    this._acquireWakeLock();
    this._rideVisibilityHandler = () => {
      if (document.visibilityState === 'visible' && this.isRiding) this._acquireWakeLock();
    };
    document.addEventListener('visibilitychange', this._rideVisibilityHandler);

    const stops = (this.currentTrip.waypoints || []).filter(wp => !['via', 'leg-break'].includes(wp.type || ''));
    this._setHudText('rideTripName', this.currentTrip.name || 'Ride');
    this._setHudText('rideStops', stops.length.toString());
    this._setHudText('rideDistanceRemaining', this.currentTrip.route?.distance ? RideUtils.formatDistance(this.currentTrip.route.distance) : '—');
    this._setHudText('rideEta', this.currentTrip.route?.duration ? this._formatEtaClock(this.currentTrip.route.duration) : '—');
    this._setHudText('rideSpeedVal', '—');
    this._setHudText('rideSpeedUnit', RideUtils.speedUnitLabel());
    this._setHudText('rideManeuverDist', '');
    this._setHudText('rideNextInstruction', 'Follow the route');
    this._setHudText('rideNextMeta', 'Waiting for GPS…');
    this._setManeuverIcon('straight');

    // Fuel HUD: hidden + zero per-tick work unless the feature is on and a
    // tank range is actually configured. Re-checked on every ride start
    // since settings may have changed since the last ride.
    this._loadFuelSettings();
    if (this._updateFuelVisibility()) {
      this._resetFuelRideState();
      const startRemaining = this._fuelSettings.tankRangeKm * (this._fuelPercent / 100);
      this._setFuelValueHud(startRemaining, this._fuelLevel(startRemaining));
      this._setFuelGaugeHud(startRemaining, this._fuelLevel(startRemaining));
    }
    // The map's fuel overlay is position-aware and drops the "runs dry" chip
    // while riding (it would sit on top of the turn-by-turn banner) — it needs
    // one refresh now that isRiding is true, since nothing else fires here.
    MapManager.refreshFuelOverlay?.();

    this.precomputeRouteMetrics();
    MapManager.startRide(pos => this.onRidePosition(pos));
  },

  exitRideMode() {
    this.isRiding = false;
    this.rideVisitedWaypoints = null;
    this.rideRerouting = false;
    this.offRouteCounter = 0;
    this._rideArrived = false;
    this._rideGpsState = null;

    // Restore the pre-ride route unconditionally: any mid-ride reroute is
    // discarded here so GPS-contaminated geometry can never be persisted by
    // a later trip save.
    if (this._preRideRoute && this.currentTrip) {
      this.currentTrip.route = this._preRideRoute;
      UI.updateTripStats(this.currentTrip);
    }
    this._preRideRoute = null;

    document.getElementById('rideOverlay')?.classList.add('hidden');
    document.body.classList.remove('ride-mode');
    // Map shrinks back between the top bar and bottom nav — re-measure.
    setTimeout(() => MapManager.map?.invalidateSize(), 60);
    MapManager.stopRide();

    if (this._rideVisibilityHandler) {
      document.removeEventListener('visibilitychange', this._rideVisibilityHandler);
      this._rideVisibilityHandler = null;
    }
    this._releaseWakeLock();

    // Save GPS track as a private journal entry + ride log (async, non-blocking)
    const track = this._rideTrack || [];
    const startTime = this._rideStartTime;
    this._rideTrack = [];
    this._rideTrackLastPt = null;
    if (track.length >= 3) {
      this._saveRideLog(track, startTime).catch(err => console.warn('Ride log save failed:', err));
    } else {
      this._clearTrackCheckpoint();
    }

    this._flushPendingRideLogs();

    // Bank the fuel actually burned on this ride before the live counters go
    // away, so tomorrow's planning starts from the tank the bike really has.
    // Erring low is the safe direction here: a percent that's too low warns
    // early, one that's too high strands someone.
    this._persistRideFuelBurn();
    // Back to the planning view of the fuel overlay: whole route, stored tank
    // percent, chip allowed again (see MapManager._liveRideFuel).
    this._clearFuelAlertLine();
    MapManager.refreshFuelOverlay?.();

    // Tell the shell the ride is over (deferred build updates apply now)
    window.dispatchEvent(new CustomEvent('ride:ended'));
  },

  /* --- Screen wake lock: keep the display on for the ride --- */

  /**
   * Request a screen wake lock. No-op (silent, never a toast) when the API
   * doesn't exist, permission is denied, or the tab is hidden at request
   * time — any of those are unsupported/transient conditions, not errors
   * worth interrupting a rider over. Safe to call when a lock is already
   * held (e.g. a visibilitychange firing twice in a row).
   */
  async _acquireWakeLock() {
    if (!('wakeLock' in navigator)) return;
    if (this._wakeLockSentinel && !this._wakeLockSentinel.released) return;
    try {
      const sentinel = await navigator.wakeLock.request('screen');
      this._wakeLockSentinel = sentinel;
      // The OS can release the lock for reasons other than tab-hide (e.g.
      // power saving) without a visibilitychange ever firing — listen to
      // the sentinel itself so those cases still get re-acquired.
      sentinel.addEventListener('release', () => {
        if (this._wakeLockSentinel !== sentinel) return; // superseded already
        this._wakeLockSentinel = null;
        if (this.isRiding && document.visibilityState === 'visible') this._acquireWakeLock();
      });
    } catch (_) { /* unsupported, denied, or backgrounded — silent no-op */ }
  },

  /** Double-exit safe: a null/already-released sentinel is a normal no-op. */
  _releaseWakeLock() {
    const sentinel = this._wakeLockSentinel;
    this._wakeLockSentinel = null;
    if (!sentinel) return;
    try { sentinel.release().catch(() => {}); } catch (_) { /* already released */ }
  },

  /**
   * Resolve the route the rider should actually navigate, honouring the
   * selected alternative (activeRouteIndex). Index 0 is the primary route
   * (currentTrip.route); higher indices map to a stored alternative. Falls
   * back to the primary route if the active alternative has no geometry.
   */
  getActiveRoute() {
    const trip = this.currentTrip;
    if (!trip) return null;
    const idx = Number(trip.activeRouteIndex ?? trip.active_route_index ?? 0) || 0;
    if (idx > 0) {
      const alts = trip.alternativeRoutes || trip.alternative_routes || [];
      // alts may be keyed by route_index (0 = primary included) OR be the
      // primary-excluded slice form (0-based = idx-1). Try both.
      let match = alts.find(r => Number(r.route_index ?? r.routeIndex ?? r.alt_idx) === idx);
      if (!match) match = alts[idx - 1];
      if (match?.coordinates?.length) {
        return {
          coordinates: match.coordinates,
          steps: Array.isArray(match.steps) ? match.steps : [],
          distance: match.distance ?? match.distance_meters ?? null,
          duration: match.duration ?? match.duration_seconds ?? match.time ?? null
        };
      }
    }
    return trip.route;
  },

  precomputeRouteMetrics() {
    if (!this.currentTrip?.route?.coordinates) return;
    const coords = this.currentTrip.route.coordinates;
    const cumulative = [0];
    let total = 0;
    for (let i = 1; i < coords.length; i++) {
      total += this.haversine(coords[i - 1], coords[i]);
      cumulative.push(total);
    }
    this.currentTrip.route._cumulative = cumulative;
    this.currentTrip.route._total = total;

    // While riding, also precompute each stop's along-route position so the
    // skip detector can tell when the rider has driven well past a missed stop.
    if (this.isRiding) {
      const wpAlong = {};
      (this.currentTrip.waypoints || []).forEach(wp => {
        if (['via', 'leg-break'].includes(wp.type || '')) return; // shaping points and leg dividers are not stops
        let best = Infinity;
        let bestIdx = 0;
        for (let i = 0; i < coords.length; i++) {
          const d = this.haversine(coords[i], wp);
          if (d < best) { best = d; bestIdx = i; }
        }
        wpAlong[wp.id] = cumulative[bestIdx];
      });
      this.currentTrip.route._wpAlong = wpAlong;
    }
  },

  /**
   * Apply an in-ride reroute. Ephemeral by design: updates the in-memory
   * route for the HUD and off-route logic only — never persisted, never
   * gated on edit permission (fixes the auth-gate-over-HUD deadlock), and
   * discarded when the ride exits.
   */
  applyRideReroute(routeData) {
    if (!this.isRiding || !this.currentTrip) return;
    const duration = routeData?.duration ?? routeData?.time ?? null;
    this.currentTrip.route = {
      ...routeData, duration, time: duration,
      coordinates: routeData?.coordinates || [],
      steps: Array.isArray(routeData?.steps) ? routeData.steps : []
    };
    this.precomputeRouteMetrics();
    this.rideRerouting = false;
    this.offRouteCounter = 0;
    this._rideNearIdx = 0;
    this._maneuverIconKey = null; // force glyph refresh against the new steps
    // The new route's `along` numbering starts fresh from the rider's current
    // position — anchoring the fuel delta to the old numbering would read as
    // a huge (or negative) jump. Drop the anchor; the accumulated km-ridden
    // total itself is untouched, so fuel range doesn't reset on a reroute.
    this._fuelLastAlongM = null;
    UI.updateTripStats(this.currentTrip);
  },

  /** @deprecated Use RideUtils.haversine directly */
  haversine(a, b) { return RideUtils.haversine(a, b); },

  _setHudText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  },

  /**
   * GPS health surfaced on the HUD meta line. States: 'weak' (fixes arriving
   * but too inaccurate to navigate by), 'lost' (watch erroring, retrying),
   * 'denied' (permission revoked — fatal), 'ok'.
   */
  _setRideGpsState(state) {
    if (!this.isRiding || this._rideGpsState === state) return;
    this._rideGpsState = state;
    if (state === 'ok') return; // next HUD tick repaints the meta line
    const messages = {
      weak: 'GPS weak — waiting for a better fix…',
      lost: 'GPS signal lost — retrying…',
      denied: 'Location permission denied — check browser settings'
    };
    this._setHudText('rideNextMeta', messages[state] || '');
  },

  markVisitedWaypoints(position) {
    if (!this.currentTrip?.waypoints) return;
    if (!this.rideVisitedWaypoints) this.rideVisitedWaypoints = new Set();
    // Scale the arrival radius with GPS accuracy so poor fixes still register
    const threshold = Math.max(40, (position.accuracy || 0) * 1.5);
    // Waypoints reached in the first 30 s are where the ride began —
    // mark them silently instead of toasting "Arrived" at the start line.
    const silent = (Date.now() - (this._rideStartTime || 0)) < 30000;
    this.currentTrip.waypoints.forEach(wp => {
      if (['via', 'leg-break'].includes(wp.type || '')) return; // shaping points and leg dividers are not stops
      if (this.rideVisitedWaypoints.has(wp.id)) return;
      if (this.haversine(wp, position) <= threshold) {
        this.rideVisitedWaypoints.add(wp.id);
        if (!silent) {
          UI.showToast(`Arrived at ${wp.name || 'waypoint'}`, 'success');
          // Suggest, never auto-reset — the rider may be passing the pin
          // without actually stopping to fill up.
          if (this._fuelActive && wp.fuelStop) {
            UI.showToast('Fuel stop — tap Tank Filled once you’ve filled up.', 'info');
          }
        }
      }
    });
  },

  getRemainingWaypoints() {
    if (!this.currentTrip?.waypoints) return [];
    if (!this.rideVisitedWaypoints) this.rideVisitedWaypoints = new Set();
    return [...this.currentTrip.waypoints]
      .filter(wp => !['via', 'leg-break'].includes(wp.type || '') && !this.rideVisitedWaypoints.has(wp.id))
      .sort((a, b) => a.order - b.order);
  },

  /**
   * Find nearest route coordinate using sliding window from last known position.
   * Falls back to full scan if the window doesn't find a close match.
   */
  _findNearestRouteIdx(coords, pos) {
    const windowSize = 150; // look ±150 points from last position
    const start = Math.max(0, (this._rideNearIdx || 0) - 20);
    const end = Math.min(coords.length, (this._rideNearIdx || 0) + windowSize);

    let bestIdx = this._rideNearIdx || 0;
    let bestDist = Infinity;

    // Windowed search (fast path)
    for (let i = start; i < end; i++) {
      const d = this.haversine(coords[i], pos);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }

    // If windowed result is far (>300m), do a full scan as fallback
    if (bestDist > 300) {
      for (let i = 0; i < coords.length; i++) {
        const d = this.haversine(coords[i], pos);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
    }

    this._rideNearIdx = bestIdx;
    return { idx: bestIdx, dist: bestDist };
  },

  /**
   * Locate the rider on the route: nearest vertex, then projected onto the
   * flanking segments. On sparse geometry (long straight roads with vertices
   * hundreds of meters apart) the perpendicular distance to the line is far
   * smaller than the distance to either vertex — using it prevents false
   * off-route reroutes, and the fractional position smooths distance/ETA.
   * Returns { idx, dist, along } — along is meters travelled along the route.
   */
  _locateOnRoute(coords, cumulative, pos) {
    const { idx, dist: vertexDist } = this._findNearestRouteIdx(coords, pos);
    let dist = vertexDist;
    let along = cumulative[idx] ?? 0;
    for (const s of [idx - 1, idx]) {
      if (s < 0 || s >= coords.length - 1) continue;
      const proj = RideUtils.pointToSegmentDistance(pos, coords[s], coords[s + 1]);
      if (proj.dist < dist) {
        dist = proj.dist;
        along = cumulative[s] + proj.t * (cumulative[s + 1] - cumulative[s]);
      }
    }
    return { idx, dist, along };
  },

  onRidePosition(pos) {
    if (!this.isRiding || !this.currentTrip?.route?.coordinates || !this.currentTrip.route._cumulative) return;

    const now = Date.now();
    const poorFix = (pos.accuracy || 0) > 80;

    // Speed: doppler speed from the fix when present, derived from
    // consecutive good fixes otherwise. Good fixes also feed the rolling ETA.
    if (!poorFix) this._recordSpeedSample(pos, now);
    this._updateRideSpeed(pos);

    if (poorFix) {
      // Fix too fuzzy to navigate by — the marker still moves (map-ride.js),
      // but keep it out of the track, off-route logic, and arrival detection.
      this._poorFixStreak = (this._poorFixStreak || 0) + 1;
      if (this._poorFixStreak >= 3) this._setRideGpsState('weak');
      return;
    }
    this._poorFixStreak = 0;
    if (this._rideGpsState && this._rideGpsState !== 'ok') this._setRideGpsState('ok');

    // On first usable GPS fix, check if we're far from the route.
    if (!this.rideInitialRouted) {
      this.rideInitialRouted = true;
      const startCoords = this.currentTrip.route.coordinates;
      let nearestDist = Infinity;
      for (let i = 0; i < startCoords.length; i++) {
        const d = this.haversine(startCoords[i], pos);
        if (d < nearestDist) nearestDist = d;
      }
      if (nearestDist > 200) {
        UI.showToast('Routing from your location…', 'info');
        this.rideRerouting = true;
        this.lastRerouteAt = now;
        MapManager.rerouteFromPosition(pos, this.getRemainingWaypoints());
        return;
      }
    }

    const coords = this.currentTrip.route.coordinates;
    const cumulative = this.currentTrip.route._cumulative;
    const total = this.currentTrip.route._total || cumulative[cumulative.length - 1] || 0;
    this.markVisitedWaypoints(pos);

    // Locate the rider on the route (segment-projected)
    const { idx: nearestIdx, dist: routeDist, along } = this._locateOnRoute(coords, cumulative, pos);

    // Off-route detection with dynamic threshold
    const dynamicThreshold = Math.max(50, (pos.accuracy || 30) * 1.6);
    if (routeDist > dynamicThreshold) {
      this.offRouteCounter = (this.offRouteCounter || 0) + 1;
    } else {
      this.offRouteCounter = 0;
      // On-route and >2 km past the next stop without ever reaching it:
      // treat it as skipped so rerouting stops dragging the rider back.
      this._checkSkippedWaypoint(along);
    }

    const remainingWaypoints = this.getRemainingWaypoints();
    this._setHudText('rideStops', remainingWaypoints.length.toString());

    const canReroute = routeDist > dynamicThreshold && this.offRouteCounter >= 4
      && !this.rideRerouting && (now - (this.lastRerouteAt || 0) > 45000);
    if (canReroute) {
      this.rideRerouting = true;
      this.lastRerouteAt = now;
      UI.showToast('Off route. Rerouting…', 'info');
      MapManager.rerouteFromPosition(pos, remainingWaypoints);
    }

    // Distance remaining — measured from the projected along-track position
    const remaining = Math.max(0, total - along);
    this._setHudText('rideDistanceRemaining', RideUtils.formatDistance(remaining));

    // ETA: rolling average of the last 60 s of actual movement (stopped time
    // excluded); falls back to route duration scaled by the remaining fraction.
    const etaSeconds = this._estimateEtaSeconds(remaining, total);
    if (etaSeconds != null) this._setHudText('rideEta', this._formatEtaClock(etaSeconds));

    // Live fuel range HUD — a no-op (feature checked internally) unless fuel
    // planning is enabled and a tank range is configured.
    this._updateFuelHud(along);

    // Arrival detection
    if (remaining < 30 && remainingWaypoints.length === 0 && !this._rideArrived) {
      this._rideArrived = true;
      this._setHudText('rideNextInstruction', 'You have arrived!');
      this._setHudText('rideNextMeta', 'Ride complete');
      this._setHudText('rideManeuverDist', '');
      this._setManeuverIcon('arrive');
      UI.showToast('🏁 You have arrived at your destination!', 'success');
      return;
    }

    // Turn-by-turn instruction + maneuver glyph + distance countdown
    this._updateManeuverHud(nearestIdx, along, cumulative, remaining);

    // Append breadcrumb to GPS track (sampled, not every tick)
    this._recordTrackPoint(pos);
  },

  /** Mark the next stop skipped once the rider is >2 km past it along the route. */
  _checkSkippedWaypoint(along) {
    const next = this.getRemainingWaypoints()[0];
    if (!next) return;
    const wpAlong = this.currentTrip.route?._wpAlong?.[next.id];
    if (Number.isFinite(wpAlong) && along > wpAlong + 2000) {
      this.rideVisitedWaypoints.add(next.id);
      UI.showToast(`Skipped ${next.name || 'stop'}`, 'info');
    }
  },

  /* --- HUD: speed, ETA, maneuver --- */

  _updateRideSpeed(pos) {
    const el = document.getElementById('rideSpeedVal');
    if (!el) return;
    let mps = (typeof pos.speed === 'number' && isFinite(pos.speed) && pos.speed >= 0) ? pos.speed : null;
    if (mps == null && this._lastDerivedSpeed && (Date.now() - this._lastDerivedSpeed.t) < 8000) {
      mps = this._lastDerivedSpeed.v;
    }
    el.textContent = mps == null ? '—' : Math.round(RideUtils.speedFromMps(mps)).toString();
  },

  _recordSpeedSample(pos, now) {
    const last = this._lastGoodFix;
    this._lastGoodFix = { lat: pos.lat, lng: pos.lng, t: now };
    if (!last) return;
    const dt = (now - last.t) / 1000;
    if (dt <= 0 || dt > 30) return;
    const dm = this.haversine(last, pos);
    const v = dm / dt;
    if (v > 70) return; // >250 km/h between fixes — GPS glitch, not riding
    this._lastDerivedSpeed = { v, t: now };
    if (!this._speedHist) this._speedHist = [];
    if (v >= 1) this._speedHist.push({ t: now, d: dm, dt }); // moving samples only
    const cutoff = now - 60000;
    while (this._speedHist.length && this._speedHist[0].t < cutoff) this._speedHist.shift();
  },

  _estimateEtaSeconds(remaining, total) {
    let d = 0;
    let t = 0;
    for (const s of (this._speedHist || [])) { d += s.d; t += s.dt; }
    if (t >= 10 && d >= 30) return remaining / (d / t);
    const routeDur = this.currentTrip?.route?.duration;
    if (routeDur && total > 0) return routeDur * (remaining / total);
    return null;
  },

  /** ETA rendered as arrival clock time ("3:45 pm") — glanceable, unlike a countdown. */
  _formatEtaClock(etaSeconds) {
    const d = new Date(Date.now() + Math.max(0, etaSeconds) * 1000);
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  },

  /** Distance-to-turn with nav-style rounding: 1.2 km → 850 m → 40 m → Now. */
  _fmtManeuverDist(meters) {
    if (!Number.isFinite(meters)) return '';
    if (meters < 30) return 'Now';
    if (meters < 100) return `${Math.round(meters / 10) * 10} m`;
    if (meters < 1000) return `${Math.round(meters / 50) * 50} m`;
    return `${(meters / 1000).toFixed(1)} km`;
  },

  // Inline stroke paths for the maneuver glyph (24x24, stroke=currentColor
  // set on the #rideManeuverIcon svg in index.html).
  _maneuverPaths: {
    'straight':     '<path d="M12 20V7M12 7l-5 5M12 7l5 5"/>',
    'left':         '<path d="M16 20v-6a4 4 0 0 0-4-4H8M11 6l-4 4 4 4"/>',
    'right':        '<path d="M8 20v-6a4 4 0 0 1 4-4h4M13 6l4 4-4 4"/>',
    'slight-left':  '<path d="M14 20v-7L9 6M9 11V6h5"/>',
    'slight-right': '<path d="M10 20v-7l5-7M15 11V6h-5"/>',
    'sharp-left':   '<path d="M16 20v-9l-7 5M10 11l-1 5 6-1"/>',
    'sharp-right':  '<path d="M8 20v-9l7 5M14 11l1 5-6-1"/>',
    'uturn':        '<path d="M17 20v-9a5 5 0 0 0-10 0v4M4 13l3 4 3-4"/>',
    'roundabout':   '<path d="M12 21v-4"/><circle cx="12" cy="11" r="5"/>',
    'arrive':       '<path d="M6 21V4h12l-3 4 3 4H6"/>'
  },

  /**
   * Resolve a step to a maneuver glyph key. Prefers the structured LRM
   * type/modifier (present on reroute steps); planned-route steps only carry
   * text (map.js drops type/modifier), so fall back to parsing it.
   */
  _maneuverKeyFor(step) {
    const type = (step?.type || '').toLowerCase();
    const mod = (step?.modifier || '').toLowerCase();
    if (type.includes('destination') || type.includes('waypoint')) return 'arrive';
    if (type.includes('roundabout') || type.includes('rotary')) return 'roundabout';
    if (type === 'turnaround' || mod === 'uturn') return 'uturn';
    const src = mod || type;
    if (src) {
      if (src.includes('sharpleft')) return 'sharp-left';
      if (src.includes('sharpright')) return 'sharp-right';
      if (src.includes('slightleft')) return 'slight-left';
      if (src.includes('slightright')) return 'slight-right';
      if (src.includes('left')) return 'left';
      if (src.includes('right')) return 'right';
      if (src.includes('straight') || src === 'continue' || src === 'head') return 'straight';
    }
    const t = (step?.text || '').toLowerCase();
    if (t.includes('u-turn') || t.includes('turn around')) return 'uturn';
    if (t.includes('roundabout') || t.includes('rotary')) return 'roundabout';
    if (t.includes('destination') || t.includes('arrive')) return 'arrive';
    if (t.includes('sharp left')) return 'sharp-left';
    if (t.includes('sharp right')) return 'sharp-right';
    if (t.includes('slight left') || t.includes('slightly left') || t.includes('keep left') || t.includes('bear left')) return 'slight-left';
    if (t.includes('slight right') || t.includes('slightly right') || t.includes('keep right') || t.includes('bear right')) return 'slight-right';
    if (t.includes('left')) return 'left';
    if (t.includes('right')) return 'right';
    return 'straight';
  },

  _setManeuverIcon(key) {
    if (key === this._maneuverIconKey) return;
    this._maneuverIconKey = key;
    const svg = document.getElementById('rideManeuverIcon');
    if (svg) svg.innerHTML = this._maneuverPaths[key] || this._maneuverPaths.straight;
  },

  _updateManeuverHud(nearestIdx, along, cumulative, remaining) {
    const steps = this.currentTrip.route.steps || [];
    const nextStep = steps.find(s => s.index > nearestIdx);
    if (nextStep) {
      this._setHudText('rideNextInstruction', nextStep.text || 'Continue');
      const distToStep = Math.max(0, (cumulative[nextStep.index] ?? along) - along);
      this._setHudText('rideManeuverDist', this._fmtManeuverDist(distToStep));
      this._setManeuverIcon(this._maneuverKeyFor(nextStep));
      // Meta: what comes after this turn, or the road it leads onto
      const after = steps.find(s => s.index > nextStep.index);
      if (after?.text) {
        this._setHudText('rideNextMeta', `Then ${after.text}`);
      } else if (nextStep.road) {
        this._setHudText('rideNextMeta', `Toward ${nextStep.road}`);
      } else {
        this._setHudText('rideNextMeta', `${RideUtils.formatDistance(remaining)} remaining`);
      }
    } else if (!this._rideArrived) {
      this._setHudText('rideNextInstruction', 'Continue to destination');
      this._setHudText('rideNextMeta', `${RideUtils.formatDistance(remaining)} remaining`);
      this._setHudText('rideManeuverDist', this._fmtManeuverDist(remaining));
      this._setManeuverIcon('straight');
    }
  },

  /* --- Fuel planning: live remaining range + threshold alerts ---
   * Fuel state (tank percent) is device-local via window.FuelPlanner —
   * deliberately not trip data. Everything here is a no-op when the feature
   * is off or no tank range is configured (see _updateFuelVisibility). */

  _loadFuelSettings() {
    const raw = Storage.load(Storage.KEYS.SETTINGS, {}) || {};
    this._fuelSettings = {
      enabled: !!raw.fuelPlanningEnabled,
      tankRangeKm: Number(raw.fuelTankRangeKm) || 0,
      warnMode: raw.fuelWarnMode || 'percent30'
    };
    return this._fuelSettings;
  },

  /**
   * Show/hide the fuel stat + the + menu's Tank Filled / Find Fuel items,
   * and widen the stat strip to a 5th column while active. Called on ride
   * start and whenever fuel settings change. Returns whether the feature
   * is active.
   */
  _updateFuelVisibility() {
    const s = this._fuelSettings || this._loadFuelSettings();
    const active = !!(s.enabled && s.tankRangeKm > 0);
    this._fuelActive = active;
    document.getElementById('rideFuelVal')?.closest('.ride-stat')?.classList.toggle('hidden', !active);
    document.getElementById('tankFilledBtn')?.classList.toggle('hidden', !active);
    // Find Fuel additionally needs the module actually loaded — an app build
    // without fuel-finder.js just never shows the item.
    const findFuelAvailable = active && typeof window.FuelFinder?.openForRoute === 'function';
    document.getElementById('findFuelBtn')?.classList.toggle('hidden', !findFuelAvailable);
    document.querySelector('.ride-statbar')?.classList.toggle('has-fuel', active);
    if (!active) this._clearFuelAlertLine();
    return active;
  },

  /** Reset per-ride fuel tracking to "current stored percent, zero ridden since". */
  _resetFuelRideState() {
    this._fuelKmRidden = 0;
    this._fuelLastAlongM = null;
    this._fuelAlertActive = false;
    this._fuelShortfallActive = false;
    this._fuelLastOverlayBucket = 0;
    this._clearFuelAlertLine();
    const state = (typeof FuelPlanner !== 'undefined' && typeof FuelPlanner.getState === 'function')
      ? FuelPlanner.getState() : null;
    this._fuelPercent = (state && Number.isFinite(state.percent)) ? state.percent : 100;
  },

  /**
   * Write the ride's fuel consumption back into the device-local tank state on
   * exit. Without this the stored percent only ever moves on a Tank Filled tap,
   * so the map would happily plan tomorrow's ride on a tank that was emptied
   * today. No-op when the feature is off or nothing was ridden.
   */
  _persistRideFuelBurn() {
    if (!this._fuelActive) return;
    const s = this._fuelSettings || this._loadFuelSettings();
    const ridden = Number(this._fuelKmRidden);
    if (!(s.tankRangeKm > 0) || !Number.isFinite(ridden) || ridden <= 0) return;
    if (typeof FuelPlanner === 'undefined' || typeof FuelPlanner.setPercent !== 'function') return;
    const startPercent = Number.isFinite(this._fuelPercent) ? this._fuelPercent : 100;
    const remainingKm = Math.max(0, s.tankRangeKm * (startPercent / 100) - ridden);
    FuelPlanner.setPercent((remainingKm / s.tankRangeKm) * 100);
    this._fuelPercent = (remainingKm / s.tankRangeKm) * 100;
    this._fuelKmRidden = 0;
    this._fuelLastAlongM = null;
  },

  /** Fixed colour bands — mirrors FuelPlanner.levelForRemaining as a fallback. */
  _fuelLevel(remainingKm) {
    if (typeof FuelPlanner !== 'undefined' && typeof FuelPlanner.levelForRemaining === 'function') {
      return FuelPlanner.levelForRemaining(remainingKm);
    }
    if (remainingKm <= 0) return 'empty';
    if (remainingKm <= 20) return 'critical';
    if (remainingKm <= 50) return 'low';
    if (remainingKm <= 100) return 'warn';
    return 'ok';
  },

  _setFuelValueHud(remainingKm, level) {
    const valEl = document.getElementById('rideFuelVal');
    if (!valEl) return;
    valEl.textContent = RideUtils.formatDistance(Math.max(0, remainingKm) * 1000);
    valEl.classList.remove('ride-fuel-warn', 'ride-fuel-low', 'ride-fuel-critical', 'ride-fuel-empty');
    if (level === 'warn') valEl.classList.add('ride-fuel-warn');
    else if (level === 'low') valEl.classList.add('ride-fuel-low');
    else if (level === 'critical') valEl.classList.add('ride-fuel-critical');
    else if (level === 'empty') valEl.classList.add('ride-fuel-critical', 'ride-fuel-empty');
    // 'ok' → no class, default stat colour.
  },

  /**
   * Fill the fuel gauge to remainingKm/tankRangeKm (clamped 0..1) and colour
   * it from the same level bands as the numeric readout beside it. The bar
   * is created once in index.html — this only ever touches style.width and
   * a class, never innerHTML, so it's cheap enough to call every GPS tick.
   */
  _setFuelGaugeHud(remainingKm, level) {
    const fillEl = document.getElementById('rideFuelGaugeFill');
    if (!fillEl) return;
    const tankRangeKm = this._fuelSettings?.tankRangeKm;
    const fraction = tankRangeKm > 0 ? Math.max(0, Math.min(1, remainingKm / tankRangeKm)) : 0;
    fillEl.style.width = `${(fraction * 100).toFixed(1)}%`;
    fillEl.classList.remove('ride-fuel-warn', 'ride-fuel-low', 'ride-fuel-critical', 'ride-fuel-empty');
    if (level === 'warn') fillEl.classList.add('ride-fuel-warn');
    else if (level === 'low') fillEl.classList.add('ride-fuel-low');
    else if (level === 'critical') fillEl.classList.add('ride-fuel-critical');
    else if (level === 'empty') fillEl.classList.add('ride-fuel-critical', 'ride-fuel-empty');
    // 'ok' → no class, default (--success) fill colour.
  },

  /**
   * Per-tick fuel update: accumulate km ridden since the last fill via the
   * delta between consecutive ticks' `along` (reroute-safe — a reroute
   * renumbers `along` from the rider's live position, so it resets the
   * anchor rather than the accumulated total; see applyRideReroute).
   */
  _updateFuelHud(along) {
    if (!this._fuelActive) return;
    const s = this._fuelSettings || this._loadFuelSettings();
    if (this._fuelLastAlongM != null) {
      const deltaM = along - this._fuelLastAlongM;
      // Ignore backtrack jitter (<=0) and implausible jumps from an anchor
      // discontinuity (e.g. right after a reroute) rather than a real ride.
      if (deltaM > 0 && deltaM < 2000) this._fuelKmRidden += deltaM / 1000;
    }
    this._fuelLastAlongM = along;

    const percent = Number.isFinite(this._fuelPercent) ? this._fuelPercent : 100;
    const remainingKm = Math.max(0, s.tankRangeKm * (percent / 100) - this._fuelKmRidden);
    const level = this._fuelLevel(remainingKm);
    this._setFuelValueHud(remainingKm, level);
    this._setFuelGaugeHud(remainingKm, level);

    // "Next fuel vs range" is the sharper, glanceable question — only the
    // generic threshold line shows when there's no actual shortfall against
    // the next stop (or destination) ahead. Never both at once.
    if (!this._checkFuelShortfall(along, remainingKm)) {
      this._checkFuelAlert(remainingKm, s);
    }

    // Bands ahead on the map should reflect reality, but recomputing them
    // every GPS tick would be wasted work — refresh once per ~2 km ridden.
    const overlayBucket = Math.floor(this._fuelKmRidden / 2);
    if (overlayBucket !== this._fuelLastOverlayBucket) {
      this._fuelLastOverlayBucket = overlayBucket;
      MapManager.refreshFuelOverlay?.();
    }
  },

  /**
   * Where the rider's fuel needs to reach: the next waypoint ahead flagged
   * fuelStop, or — once there are none left — the destination itself
   * (flagged noFuelAhead so the copy can say so honestly). Relies on
   * route._wpAlong (precomputeRouteMetrics), which is rebuilt on ride start,
   * reroute, and ride:fuelStopsChanged, so a stop inserted mid-ride via Find
   * Fuel is picked up without any extra plumbing here.
   */
  _nextFuelTarget(along) {
    const route = this.currentTrip?.route;
    const wpAlong = route?._wpAlong;
    if (!wpAlong) return null;
    let bestAlong = Infinity;
    for (const wp of (this.currentTrip.waypoints || [])) {
      if (!wp.fuelStop) continue;
      const a = wpAlong[wp.id];
      if (!Number.isFinite(a) || a <= along) continue; // behind us, or not on this route
      if (a < bestAlong) bestAlong = a;
    }
    if (bestAlong !== Infinity) return { distM: Math.max(0, bestAlong - along), noFuelAhead: false };
    const total = route._total || 0;
    return { distM: Math.max(0, total - along), noFuelAhead: true };
  },

  /**
   * The fuel picture only needs to speak up when there's an actual
   * shortfall — plenty of range to the next fuel stop (or the destination)
   * is exactly the boring, expected case. Same once-per-crossing toast
   * discipline as _checkFuelAlert; re-armed when the shortfall clears
   * (refuel, or a closer stop inserted via Find Fuel). Returns whether a
   * shortfall line is showing, so the caller can skip the generic threshold
   * line — the two must never stack.
   */
  _checkFuelShortfall(along, remainingKm) {
    const target = this._nextFuelTarget(along);
    if (!target) return false;
    const shortfall = target.distM > remainingKm * 1000;
    if (!shortfall) {
      if (this._fuelShortfallActive) {
        this._fuelShortfallActive = false;
        this._clearFuelAlertLine();
      }
      return false;
    }
    const distStr = RideUtils.formatDistance(target.distM);
    const rangeStr = RideUtils.formatDistance(Math.max(0, remainingKm) * 1000);
    const msg = target.noFuelAhead
      ? `⛽ No fuel stop ahead — ~${distStr} to go, range ~${rangeStr}`
      : `⛽ Next fuel ~${distStr} ahead — beyond your ~${rangeStr} range`;
    if (!this._fuelShortfallActive) {
      this._fuelShortfallActive = true;
      UI.showToast(msg, 'error');
    }
    this._setFuelAlertLine(msg);
    return true;
  },

  /** fuelWarnMode is an alert threshold only — the colour bands are fixed regardless. */
  _fuelAlertThresholdKm(s) {
    switch (s.warnMode) {
      case 'km100': return 100;
      case 'km50': return 50;
      case 'km20': return 20;
      case 'percent30':
      default: return s.tankRangeKm * 0.30;
    }
  },

  /** Fires the toast once per crossing; the persistent banner line keeps updating until refuel. */
  _checkFuelAlert(remainingKm, s) {
    const crossed = remainingKm <= this._fuelAlertThresholdKm(s);
    if (crossed) {
      // Formatted through RideUtils, not hardcoded "km": it defaults to
      // imperial on en-US/en-GB locales (utils.js), and the HUD readout +
      // gauge already honour that. A banner claiming "90 km left" beside a
      // readout showing "56 mi" is worse than either unit alone — this is a
      // range-safety number, so the two must always agree.
      const msg = `⛽ Fuel low — ~${RideUtils.formatDistance(Math.max(0, remainingKm) * 1000)} left. Plan a fuel stop.`;
      if (!this._fuelAlertActive) {
        this._fuelAlertActive = true;
        UI.showToast(msg, 'error');
      }
      this._setFuelAlertLine(msg);
    } else if (this._fuelAlertActive) {
      // remainingKm only decreases between refuels, so this is defensive —
      // but a settings/percent resync could legitimately clear it.
      this._fuelAlertActive = false;
      this._clearFuelAlertLine();
    }
  },

  /** Persistent second line under the turn-by-turn text — #rideNextMeta gets
   * overwritten every good-fix tick, so the fuel warning needs its own node. */
  _ensureFuelAlertEl() {
    let el = document.getElementById('rideFuelAlertLine');
    if (!el) {
      const container = document.querySelector('.ride-banner-content');
      if (!container) return null;
      el = document.createElement('div');
      el.id = 'rideFuelAlertLine';
      el.className = 'ride-fuel-alert hidden';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      container.appendChild(el);
    }
    return el;
  },

  _setFuelAlertLine(msg) {
    const el = this._ensureFuelAlertEl();
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
    document.getElementById('tankFilledBtn')?.classList.add('ride-fab-fuel-alert');
    // Tank Filled now lives inside the + sheet, invisible until opened — glow
    // the + FAB itself too, or the alert line becomes the only cue that
    // something needs attention with no pointer to where to act on it.
    document.getElementById('rideAddBtn')?.classList.add('ride-fab-fuel-alert');
  },

  _clearFuelAlertLine() {
    document.getElementById('rideFuelAlertLine')?.classList.add('hidden');
    document.getElementById('tankFilledBtn')?.classList.remove('ride-fab-fuel-alert');
    document.getElementById('rideAddBtn')?.classList.remove('ride-fab-fuel-alert');
  },

  /**
   * Tank Filled tap: resets the tank to full and the km-since-fill baseline,
   * re-arms the alert, refreshes the map's fuel overlay from the rider's
   * current position, and tells other listeners (map overlay, settings) the
   * fuel state changed.
   */
  _onTankFilled() {
    if (!this.isRiding || !this._fuelActive) return;
    if (typeof FuelPlanner === 'undefined' || typeof FuelPlanner.tankFilled !== 'function') return;
    const s = this._fuelSettings || this._loadFuelSettings();

    FuelPlanner.tankFilled();
    this._fuelPercent = 100;
    this._fuelKmRidden = 0;
    this._fuelLastOverlayBucket = 0;
    this._fuelAlertActive = false;
    this._fuelShortfallActive = false;
    this._clearFuelAlertLine();
    this._setFuelValueHud(s.tankRangeKm, this._fuelLevel(s.tankRangeKm));
    this._setFuelGaugeHud(s.tankRangeKm, this._fuelLevel(s.tankRangeKm));

    MapManager.refreshFuelOverlay?.({ startAtIdx: this._rideNearIdx || 0, percent: 100 });
    // Same unit-consistency rule as _checkFuelAlert — never hardcode "km".
    UI.showToast(`Tank filled — range ~${RideUtils.formatDistance(s.tankRangeKm * 1000)}`, 'success');
    window.dispatchEvent(new CustomEvent('ride:fuelSettingsChanged'));
  },

  /** Fuel settings/percent changed elsewhere (Settings modal, or this same event
   * looping back from _onTankFilled) — resync visibility and, if the stored
   * percent actually moved, the HUD's cached percent + counters. */
  _onFuelSettingsChanged() {
    this._loadFuelSettings();
    this._updateFuelVisibility();
    if (!this.isRiding) return;
    const state = (typeof FuelPlanner !== 'undefined' && typeof FuelPlanner.getState === 'function')
      ? FuelPlanner.getState() : null;
    if (state && Number.isFinite(state.percent) && state.percent !== this._fuelPercent) {
      this._fuelPercent = state.percent;
      this._fuelKmRidden = 0;
      this._fuelLastOverlayBucket = 0;
      this._fuelAlertActive = false;
      this._fuelShortfallActive = false;
      this._clearFuelAlertLine();
    }
  },

  /* --- Track recording, checkpointing, and pending-log recovery --- */

  /**
   * Sample GPS position into the ride track at most once every 5 seconds and
   * only when the rider has moved ≥ 5 m, to keep track size sensible.
   */
  _recordTrackPoint(pos) {
    const now = Date.now();
    const pt = { lat: pos.lat, lng: pos.lng, t: now, accuracy: pos.accuracy || null };
    if (this._rideTrack.length === 0) {
      this._rideTrack.push(pt);
      this._rideTrackLastPt = pt;
      this._checkpointTrack();
      return;
    }
    const last = this._rideTrackLastPt;
    const dt = (now - last.t) / 1000;   // seconds since last sample
    const dm = this.haversine(last, pt); // meters moved
    // Movement threshold scales with the fix's accuracy: a parked phone
    // wanders a few metres per fix, which would otherwise log hundreds of
    // phantom points during a photo stop and inflate the ride's distance.
    // Capped so a mediocre-but-usable fix still records at walking pace.
    const minMove = Math.min(30, Math.max(5, (pos.accuracy || 0) * 0.8));
    if (dt >= 5 && dm >= minMove) {
      this._rideTrack.push(pt);
      this._rideTrackLastPt = pt;
      // Cap by halving resolution — long rides keep their full extent
      // (start point, distance) instead of silently losing the beginning.
      if (this._rideTrack.length > 3000) {
        const lastIdx = this._rideTrack.length - 1;
        this._rideTrack = this._rideTrack.filter((_, i) => i % 2 === 0 || i === lastIdx);
        this._rideTrackLastPt = this._rideTrack[this._rideTrack.length - 1];
      }
      // Checkpoint every ~10 points so an app kill loses ≤ ~1 min of track
      if (this._rideTrack.length % 10 === 0) this._checkpointTrack();
    }
  },

  _checkpointTrack() {
    try {
      localStorage.setItem('ride_track_checkpoint', JSON.stringify({
        tripId: this.currentTrip?.id ?? null,
        startedAt: this._rideStartTime,
        // Remember where this ride belongs so recovery can't file a cloud
        // trip's log into localStorage if the session lapsed meanwhile.
        cloud: !!(this.useCloud && this.currentUser),
        track: this._rideTrack
      }));
    } catch (_) { /* storage full or unavailable — checkpointing is best-effort */ }
  },

  _clearTrackCheckpoint() {
    try { localStorage.removeItem('ride_track_checkpoint'); } catch (_) { /* ignore */ }
  },

  /**
   * Rescue a checkpointed track from a ride that never exited cleanly
   * (app killed, tab discarded, mid-ride reload). Saves it as a ride log,
   * or queues it locally if the API is unreachable.
   */
  async _recoverAbandonedRide() {
    if (this.isRiding) return; // never touch the live ride's checkpoint
    let ckpt = null;
    try { ckpt = JSON.parse(localStorage.getItem('ride_track_checkpoint') || 'null'); } catch (_) { /* corrupt */ }
    this._clearTrackCheckpoint(); // claimed — synchronously, before any await
    if (!ckpt || !ckpt.tripId || !Array.isArray(ckpt.track) || ckpt.track.length < 3) return;

    const track = ckpt.track;
    let distMeters = 0;
    for (let i = 1; i < track.length; i++) {
      distMeters += this.haversine(track[i - 1], track[i]);
    }
    if (distMeters < 100) return; // stationary / accidental — nothing worth saving

    const endMs = track[track.length - 1].t || Date.now();
    const startMs = ckpt.startedAt || track[0].t || endMs;
    const logPayload = {
      journal_entry_id: null,
      started_at: new Date(startMs).toISOString(),
      ended_at: new Date(endMs).toISOString(),
      distance_meters: Math.round(distMeters),
      duration_seconds: Math.max(0, Math.round((endMs - startMs) / 1000)),
      track
    };
    // Recorded while signed in but the session is gone now: hold it rather
    // than writing a cloud trip's log into local storage under an id that
    // has no local trip behind it.
    if (ckpt.cloud && !(this.useCloud && this.currentUser)) {
      this._queuePendingRideLog(ckpt.tripId, logPayload, true);
      return;
    }
    try {
      await API.rideLogs.save(ckpt.tripId, logPayload);
      UI.showToast(`Recovered an unsaved ride — ${RideUtils.formatDistance(distMeters)} logged`, 'success');
      if (this.currentTrip?.id === ckpt.tripId) {
        try { MapManager.drawRideLogs(await API.rideLogs.list(ckpt.tripId)); } catch (_) { /* redraws on next load */ }
      }
    } catch (_) {
      this._queuePendingRideLog(ckpt.tripId, logPayload, !!ckpt.cloud);
    }
  },

  /** Keep a ride log on this device until it can reach the server. */
  _queuePendingRideLog(tripId, log, cloud = false) {
    try {
      let arr = [];
      try { arr = JSON.parse(localStorage.getItem('ride_pending_logs') || '[]'); } catch (_) { arr = []; }
      if (!Array.isArray(arr)) arr = [];
      arr.push({ qid: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, tripId, log, cloud });
      while (arr.length > 20) arr.shift(); // sanity cap
      localStorage.setItem('ride_pending_logs', JSON.stringify(arr));
      UI.showToast('Ride saved on this device — will sync when online', 'info');
    } catch (_) {
      UI.showToast('Could not save the ride log on this device', 'error');
    }
  },

  /** Push locally-queued ride logs to the API; called on start/exit/online. */
  async _flushPendingRideLogs() {
    if (this._flushingRideLogs) return;
    let queue = [];
    try { queue = JSON.parse(localStorage.getItem('ride_pending_logs') || '[]'); } catch (_) { return; }
    if (!Array.isArray(queue) || !queue.length) return;
    this._flushingRideLogs = true;
    const synced = new Set();
    const cloudReady = !!(this.useCloud && this.currentUser);
    try {
      for (const item of queue) {
        if (!item?.tripId || !item?.log) { synced.add(item?.qid); continue; } // drop malformed
        // Cloud-recorded logs wait for a session — flushing them now would
        // just move them into local storage and mark them synced.
        if (item.cloud && !cloudReady) continue;
        try {
          await API.rideLogs.save(item.tripId, item.log);
          synced.add(item.qid);
        } catch (_) { /* still unreachable — keep for the next flush */ }
      }
      if (synced.size) {
        try {
          const latest = JSON.parse(localStorage.getItem('ride_pending_logs') || '[]');
          const remaining = (Array.isArray(latest) ? latest : []).filter(i => !synced.has(i.qid));
          localStorage.setItem('ride_pending_logs', JSON.stringify(remaining));
        } catch (_) { /* ignore */ }
        UI.showToast('Ride log synced', 'success');
        const currentTripSynced = queue.some(i => synced.has(i.qid) && i.tripId === this.currentTrip?.id);
        if (currentTripSynced) {
          try { MapManager.drawRideLogs(await API.rideLogs.list(this.currentTrip.id)); } catch (_) { /* ignore */ }
        }
      }
    } finally {
      this._flushingRideLogs = false;
    }
  },

  /**
   * Build a private journal entry and persist the ride log.
   * Works for guests too — API.rideLogs/journal store locally when cloud is
   * off. On API failure the log is queued in localStorage, never discarded.
   * Called asynchronously after exitRideMode() so it never blocks the UI.
   */
  async _saveRideLog(track, startedAtMs) {
    const trip = this.currentTrip;
    if (!trip) { this._clearTrackCheckpoint(); return; }
    const tripId = trip.id;

    // Compute distance from track
    let distMeters = 0;
    for (let i = 1; i < track.length; i++) {
      distMeters += this.haversine(track[i - 1], track[i]);
    }
    if (distMeters < 100) { this._clearTrackCheckpoint(); return; } // stationary / accidental — skip

    const endedAtMs = Date.now();
    const durationSec = Math.round((endedAtMs - (startedAtMs || endedAtMs)) / 1000);
    const startedAtISO = new Date(startedAtMs || endedAtMs).toISOString();
    const endedAtISO   = new Date(endedAtMs).toISOString();
    const startPt = track[0];

    const distStr    = RideUtils.formatDistance(distMeters);
    const durStr     = RideUtils.formatDuration(durationSec);
    const avgSpeed   = durationSec > 0 ? RideUtils.speedFromMps(distMeters / durationSec).toFixed(1) : '—';
    const dateStr    = new Date(startedAtMs || endedAtMs).toLocaleDateString(undefined, {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });
    const timeStr    = new Date(startedAtMs || endedAtMs).toLocaleTimeString(undefined, {
      hour: '2-digit', minute: '2-digit'
    });

    const title   = `Ride — ${dateStr} at ${timeStr}`;
    const content = `🏍️ **${distStr}** · ${durStr} · avg ${avgSpeed} ${RideUtils.speedUnitLabel()}\n\n_Automatically recorded during navigation._`;

    let entry = null;
    try {
      entry = await API.journal.add(tripId, {
        title,
        content,
        is_private: true,
        tags: ['ride-log'],
        location: { lat: startPt.lat, lng: startPt.lng }
      });
      entry.attachments = [];
      if (!trip.journal) trip.journal = [];
      trip.journal.unshift(entry);
      if (this.currentTrip === trip) UI.renderJournal(trip.journal);
    } catch (err) {
      console.warn('Ride journal entry failed:', err);
    }

    const logPayload = {
      journal_entry_id: entry?.id || null,
      started_at: startedAtISO,
      ended_at: endedAtISO,
      distance_meters: Math.round(distMeters),
      duration_seconds: durationSec,
      track
    };

    let saved = false;
    try {
      await API.rideLogs.save(tripId, logPayload);
      saved = true;
    } catch (err) {
      console.warn('Ride log save failed, keeping a local copy:', err);
      this._queuePendingRideLog(tripId, logPayload, !!(this.useCloud && this.currentUser));
    }
    // Either way the track is now safe (server or pending queue) — the
    // checkpoint has served its purpose.
    this._clearTrackCheckpoint();

    if (saved) {
      UI.showToast(`Ride logged — ${distStr} in ${durStr}`, 'success');
      // Refresh ride logs on the map so the new track shows immediately
      if (this.currentTrip?.id === tripId) {
        try {
          const logs = await API.rideLogs.list(tripId);
          MapManager.drawRideLogs(logs);
        } catch (_) { /* non-fatal — logs draw on next trip load */ }
      }
    }
  }
});
