/**
 * Ride Controller — ride mode, GPS tracking, rerouting, metrics
 * Extends App object (loaded after app-core.js)
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
    document.getElementById('rideExitBtn')?.addEventListener('click', () => this.exitRideMode());
    document.getElementById('rideBannerExitBtn')?.addEventListener('click', () => this.exitRideMode());
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

    // Build photo title — include GPS if tagged
    const now = new Date();
    let title = `Photo ${now.toLocaleString()}`;
    const gpsPos = opts.tagGps && opts.position ? opts.position : null;
    if (gpsPos) {
      title += ` [${gpsPos.lat.toFixed(5)}, ${gpsPos.lng.toFixed(5)}]`;
    }

    let entry;
    try {
      const entryData = { title, content: '', is_private: false, tags: [] };
      if (gpsPos) {
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
      console.error('Photo upload failed', err);
      UI.showToast('Photo upload failed', 'error');
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
    if (this.isRiding) return;
    if (!this.currentTrip) { UI.showToast('No trip loaded', 'error'); return; }
    if (!this.currentUser || !this.useCloud) {
      UI.showToast('Sign in to record a ride', 'error');
      UI.showAuthGate('Sign in to record a ride');
      return;
    }
    const activeRoute = this.getActiveRoute();
    if (!activeRoute?.coordinates?.length) {
      UI.showToast('Add a route first to start riding', 'error'); return;
    }
    if (!('geolocation' in navigator)) {
      UI.showToast('Your device does not support GPS', 'error'); return;
    }
    this.isRiding = true;
    window.RideInsights?.track('ride_start');
    this.rideVisitedWaypoints = new Set();
    this.rideRerouting = false;
    this.rideInitialRouted = false;
    this.offRouteCounter = 0;
    this.lastRerouteAt = 0;
    this._rideNearIdx = 0;
    this._rideSessionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this._rideTripId = this.currentTrip.id;
    this._rideUserId = this.currentUser.id ?? this.currentUser.userId ?? null;
    this._ridePlanRoute = {
      ...activeRoute,
      coordinates: activeRoute.coordinates,
      steps: Array.isArray(activeRoute.steps) ? activeRoute.steps : []
    };
    this._ridePlanFingerprint = RideNavigation.routeFingerprint(this._ridePlanRoute);
    this._rideProgress = null;
    this._savedRideProgress = null;
    this._rideLastFixTimestamp = null;
    this._lastRidePosition = null;
    this._rideRequestId = 0;
    this._rideNavigationRoute = null;
    this._rideDetourPromptedTargets = new Set();
    this._rideDetourDecisions = new Map();
    this._rideArrived = false;
    const capturedTripId = this._rideTripId;
    const capturedUserId = this._rideUserId;
    try {
      this._rideRecorder = window.RideRecorder?.create({
        userId: capturedUserId,
        tripId: capturedTripId,
        saveLog: payload => {
          if (App.currentUser?.id !== capturedUserId) throw new Error('Sign in to sync this ride');
          return API.rideLogs.save(capturedTripId, payload);
        },
        onStatus: status => this._onRideRecorderStatus(status)
      }) || null;
    } catch (error) {
      this._rideRecorder = null;
      console.error('RideRecorder could not start', error);
      window.RideRideUI?.setRecordingStatus?.('Recording unavailable');
    }
    if (!this._rideRecorder) console.warn('RideRecorder is unavailable; this ride will not be recorded.');
    this._onRideVisibilityChange = () => {
      if (!this.isRiding || !this._rideRecorder) return;
      if (document.visibilityState === 'hidden') {
        MapManager._rideGapPending = true;
        this._rideRecorder.pause('hidden');
      } else this._rideRecorder.resume();
    };
    this._onRidePageHide = () => {
      if (!this.isRiding || !this._rideRecorder) return;
      MapManager._rideGapPending = true;
      this._rideRecorder.pause('pagehide');
    };
    document.addEventListener('visibilitychange', this._onRideVisibilityChange);
    window.addEventListener('pagehide', this._onRidePageHide);
    document.getElementById('rideOverlay')?.classList.remove('hidden');
    document.body.classList.add('ride-mode');
    const setText = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    };
    setText('rideTripName', this.currentTrip.name || 'Ride');
    setText('rideStops', (this.currentTrip.waypoints?.length ?? 0).toString());
    setText('rideDistanceRemaining', this._ridePlanRoute.distance ? RideUtils.formatDistance(this._ridePlanRoute.distance) : '—');
    setText('rideEta', this._ridePlanRoute.duration ? RideUtils.formatDuration(this._ridePlanRoute.duration) : '—');
    setText('rideNextInstruction', 'Follow the route');
    setText('rideNextMeta', 'Waiting for GPS…');
    this._savedRideProgress = this._readRideProgress(capturedTripId, this._ridePlanFingerprint, RideNavigation.routeMetrics(this._ridePlanRoute).total);
    MapManager.clearRideNavigationRoute?.();
    MapManager.startRide(pos => this.onRidePosition(pos), status => this._onRideGpsStatus(status));
  },

  endRideForTripSwitch() {
    if (this.isRiding) this.exitRideMode();
  },

  exitRideMode() {
    window.RideInsights?.track('ride_exit');
    this.isRiding = false;
    this.rideVisitedWaypoints = null;
    this.rideRerouting = false;
    this.offRouteCounter = 0;
    this._rideArrived = false;
    document.getElementById('rideOverlay')?.classList.add('hidden');
    document.body.classList.remove('ride-mode');
    MapManager.stopRide();
    document.removeEventListener('visibilitychange', this._onRideVisibilityChange);
    window.removeEventListener('pagehide', this._onRidePageHide);
    const recorder = this._rideRecorder;
    const stoppedTripId = this._rideTripId;
    const stoppedUserId = this._rideUserId;
    this._rideRecorder = null;
    Promise.resolve().then(() => recorder?.stop()).catch(error => {
      console.warn('Ride recording stop could not finish:', error);
    }).finally(() => {
      if (this.currentTrip?.id === stoppedTripId && this.currentUser?.id === stoppedUserId && this.useCloud) {
        this.refreshRideTracks?.();
      }
    });
    this._rideNavigationRoute = null;
    this._ridePlanRoute = null;
    this._ridePlanFingerprint = null;
    this._savedRideProgress = null;
    this._rideDetourPromptedTargets = null;
    this._rideDetourDecisions = null;
    this._rideSessionId = null;
    this._rideTripId = null;
    this._rideUserId = null;
    this._rideRequestId++;
    MapManager.clearRideNavigationRoute?.();
    window.RideRideUI?.clearDeviation?.();
    window.RideRideUI?.clearUndo?.();
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
    const route = this._rideNavigationRoute || this._ridePlanRoute || this.currentTrip?.route;
    if (!route?.coordinates) return;
    const metrics = RideNavigation.routeMetrics(route);
    route._cumulative = metrics.cumulative;
    route._total = metrics.total;
  },

  /** @deprecated Use RideUtils.haversine directly */
  haversine(a, b) { return RideUtils.haversine(a, b); },

  _onRideRecorderStatus(status) {
    const state = status?.state;
    const reason = status?.reason;
    const text = typeof status === 'string' ? status : (status?.message || (
      reason === 'storage-error' || reason === 'unsaved-data' || state === 'storage-error' ? 'Storage unavailable · fixes not saved'
        : reason === 'another-tab' ? 'Recording in another tab'
          : reason === 'pending-limit' ? 'Sync needed · recording paused'
            : state === 'recording' && status?.syncPending ? 'Recording · sync pending'
              : state === 'sync-pending' ? 'Sync pending'
                : reason === 'stationary' ? 'Stopped briefly · waiting for movement'
                : state === 'paused' ? 'Recording paused'
                  : state === 'recording' ? 'Recording ride' : 'Waiting for GPS'
    ));
    window.RideRideUI?.setRecordingStatus?.(text);
  },

  _onRideGpsStatus(status) {
    if (!this._rideRecorder) return;
    if (status?.type === 'weak-fix') {
      window.RideRideUI?.setRecordingStatus?.('Waiting for accurate GPS');
      return;
    }
    if (status?.type === 'error' || status?.type === 'gap') {
      this._rideRecorder.pause(status.reason || 'gps-error');
      window.RideRideUI?.setRecordingStatus?.(status.reason === 'gps-gap' ? 'GPS gap · trail segmented' : 'GPS signal lost · saving track');
    } else if (status?.type === 'fix') {
      if (document.visibilityState === 'visible') this._rideRecorder.resume();
    }
  },

  _rideProgressKey(tripId) { return `ride-progress:${tripId}`; },

  _readRideProgress(tripId, fingerprint, routeLength) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(this._rideProgressKey(tripId)) || 'null');
      if (!Number.isFinite(saved?.progress) || saved.progress < 0 || saved.progress > routeLength || saved.fingerprint !== fingerprint || !Number.isFinite(saved.updatedAt)) return null;
      if (Date.now() - saved.updatedAt > 24 * 60 * 60 * 1000 || saved.updatedAt > Date.now() + 60000) return null;
      return { progress: saved.progress, fingerprint: saved.fingerprint, updatedAt: saved.updatedAt };
    } catch (_) { return null; }
  },

  _writeRideProgress(progress) {
    if (!this._rideTripId || !Number.isFinite(progress)) return;
    try { sessionStorage.setItem(this._rideProgressKey(this._rideTripId), JSON.stringify({ progress, fingerprint: this._ridePlanFingerprint, updatedAt: Date.now() })); } catch (_) {}
  },

  markVisitedWaypoints(position, nextWaypoint) {
    if (!nextWaypoint || !this.rideVisitedWaypoints) return;
    const arrivalRadius = Math.min(90, Math.max(45, (position.accuracy || 0) * 0.7));
    if (this.haversine(nextWaypoint, position) <= arrivalRadius) {
      this.rideVisitedWaypoints.add(nextWaypoint.id);
      UI.showToast(`📍 Arrived at ${nextWaypoint.name || 'waypoint'}`, 'success');
    }
  },

  getRemainingWaypoints() {
    const waypoints = [...(this.currentTrip?.waypoints || [])].sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
    return waypoints.filter(wp => !this.rideVisitedWaypoints?.has(wp.id));
  },

  _makePlannedNavigationRoute(position, progress, stopInfo) {
    const route = this._ridePlanRoute;
    const routeMetrics = RideNavigation.routeMetrics(route);
    const end = stopInfo?.nextWaypoint ? stopInfo.waypointProgress : routeMetrics.total;
    const coordinates = RideNavigation.sliceRoute(route, progress, end);
    const distance = Math.max(0, end - progress);
    const sourceDuration = Number(route.duration);
    const duration = Number.isFinite(sourceDuration) && sourceDuration > 0
      ? sourceDuration * distance / Math.max(1, routeMetrics.total) : null;
    return {
      coordinates: coordinates.length ? coordinates : [position, stopInfo?.nextWaypoint].filter(Boolean),
      steps: RideNavigation.mapStepsToLeg(route, progress, end),
      distance,
      duration,
      _planned: true,
      _targetWaypointId: stopInfo?.nextWaypoint?.id || null
    };
  },

  _setRideNavigationRoute(route) {
    if (!route?.coordinates?.length) return;
    this._rideNavigationRoute = route;
    if (!route._planned) MapManager.setRideNavigationRoute?.(route);
    const metrics = RideNavigation.routeMetrics(route);
    route._cumulative = metrics.cumulative;
    route._total = metrics.total;
    this._rideNavProgress = 0;
    this.precomputeRouteMetrics();
  },

  _requestRideLeg(position, waypoint, reason = 'reroute') {
    if (!this.isRiding || !waypoint || this.rideRerouting) return;
    const priorNavigationRoute = this._cloneRideRoute(this._rideNavigationRoute);
    const requestDetails = {
      position: { lat: position.lat, lng: position.lng, accuracy: position.accuracy, timestamp: position.timestamp },
      progress: this._rideProgress,
      targetWaypointId: waypoint.id,
      targetProgress: this._rideStopInfo?.waypointProgress ?? null,
      reason,
      priorNavigationRoute
    };
    this.rideRerouting = true;
    const requestId = ++this._rideRequestId;
    const context = RideNavigation.requestContext(this._rideSessionId, this._rideTripId, requestId);
    const detourContext = { ...context, ...requestDetails };
    const isCurrent = () => this.isRiding && RideNavigation.isCurrentRequest(context, {
      sessionId: this._rideSessionId, tripId: this.currentTrip?.id, requestId: this._rideRequestId
    });
    this.lastRerouteAt = Date.now();
    MapManager.rerouteRideLeg(position, waypoint, context, (routeData, resultContext) => {
      if (!isCurrent() || !RideNavigation.isCurrentRequest(resultContext, context)) return;
      if (this._rideNextWaypoint?.id !== waypoint.id) { this.rideRerouting = false; return; }
      this.rideRerouting = false;
      const decision = this._rideDetourDecisions.get(waypoint.id);
      window.RideRideUI?.clearDeviation?.();
      if (decision === 'update') {
        this._setRideNavigationRoute(routeData);
        this._updateRideHud(this._lastRidePosition || position);
        UI.showToast(`Rerouted to ${waypoint.name || 'next stop'}`, 'info');
        return;
      }
      if (decision === 'keep') return;
      if (!this._rideDetourPromptedTargets.has(waypoint.id) || !decision) {
        this._rideDetourPromptedTargets.add(waypoint.id);
        const adoptionContext = { ...detourContext, routeData };
        App.offerRideDetour?.({
          context: adoptionContext,
          onUpdate: () => {
            this._rideDetourDecisions.set(waypoint.id, 'update');
            return App.adoptRideDetour?.(adoptionContext);
          },
          onKeep: () => {
            this._rideDetourDecisions.set(waypoint.id, 'keep');
            this._restorePlannedRideGuidance(adoptionContext);
          }
        });
      }
    }, (_error, resultContext) => {
      if (!isCurrent() || !RideNavigation.isCurrentRequest(resultContext, context)) return;
      this.rideRerouting = false;
      if (this._rideNextWaypoint?.id !== waypoint.id) return;
      UI.showToast('Reroute unavailable. Continuing with offline guidance.', 'info');
      this._updateRideHud(position, true);
    });
  },

  _cloneRideRoute(route) {
    if (!route) return null;
    return {
      ...route,
      coordinates: (route.coordinates || []).map(point => Array.isArray(point) ? [...point] : { ...point }),
      steps: (route.steps || []).map(step => ({ ...step }))
    };
  },

  _restorePlannedRideGuidance(context) {
    if (!this.isRiding || context?.tripId !== this._rideTripId || !this._ridePlanRoute) return;
    if (context.targetWaypointId !== this._rideNextWaypoint?.id) return;
    const waypoint = this._rideNextWaypoint || this.currentTrip?.waypoints?.find(item => item.id === context.targetWaypointId) || null;
    const total = RideNavigation.routeMetrics(this._ridePlanRoute).total;
    const progress = Number.isFinite(this._rideProgress) ? this._rideProgress : context.progress;
    const planned = this._makePlannedNavigationRoute(
      this._lastRidePosition || context.position || {},
      Number.isFinite(progress) ? progress : 0,
      this._rideStopInfo?.nextWaypoint?.id === waypoint?.id
        ? this._rideStopInfo
        : { nextWaypoint: waypoint, waypointProgress: context.targetProgress ?? total }
    );
    this._rideNavigationRoute = planned;
    this._ridePlannedLegTargetId = waypoint?.id ?? null;
    this._rideNavProgress = 0;
    this.precomputeRouteMetrics();
    MapManager.clearRideNavigationRoute?.();
  },

  _updateRideHud(position, forcePlanned = false) {
    const route = forcePlanned || !this._rideNavigationRoute ? this._ridePlanRoute : this._rideNavigationRoute;
    if (!route?.coordinates?.length) return;
    const previous = this._rideNavProgress;
    const projected = RideNavigation.projectProgress(route, position, previous);
    if (!projected) return;
    this._rideNavProgress = Math.max(previous || 0, projected.progress);
    const metrics = RideNavigation.routeMetrics(route);
    const remaining = Math.max(0, metrics.total - this._rideNavProgress);
    const distanceEl = document.getElementById('rideDistanceRemaining');
    if (distanceEl) distanceEl.textContent = RideUtils.formatDistance(remaining);
    const etaEl = document.getElementById('rideEta');
    if (etaEl && route.duration) etaEl.textContent = RideUtils.formatDuration(route.duration * (remaining / Math.max(1, metrics.total)));
    const meta = document.getElementById('rideNextMeta');
    const instruction = document.getElementById('rideNextInstruction');
    const currentSegment = RideNavigation.segmentAtProgress(metrics.cumulative, this._rideNavProgress);
    const step = (route.steps || []).find(item => Number(item.index) > currentSegment);
    if (route._planned && !step && this._rideNextWaypoint) {
      if (instruction) instruction.textContent = `Heading to ${this._rideNextWaypoint.name || 'next stop'}`;
      if (meta) meta.textContent = `${RideUtils.formatDistance(remaining)} remaining`;
      return;
    }
    if (instruction) instruction.textContent = step?.text || (this._rideNextWaypoint ? `Heading to ${this._rideNextWaypoint.name || 'next stop'}` : 'Continue to destination');
    if (meta) meta.textContent = step ? `${RideUtils.formatDistance(Math.max(0, (metrics.cumulative[step.index] || this._rideNavProgress) - this._rideNavProgress))} ahead` : `${RideUtils.formatDistance(remaining)} remaining`;
  },

  onRidePosition(pos) {
    // Recording is independent of route readiness and navigation state.
    this._rideRecorder?.record(pos);
    if (!RideNavigation.isUsableNavigationFix(pos)) {
      window.RideRideUI?.setRecordingStatus?.('Waiting for accurate GPS');
      return;
    }
    const lastFix = this._lastRidePosition;
    const fixElapsed = lastFix ? (pos.timestamp - lastFix.timestamp) / 1000 : null;
    if (fixElapsed != null && (fixElapsed <= 0 || RideNavigation.distance(lastFix, pos) / fixElapsed > 70)) return;
    if (!this.isRiding || !this.currentTrip || this.currentTrip.id !== this._rideTripId || !this._ridePlanRoute?.coordinates?.length) return;
    this._lastRidePosition = { lat: pos.lat, lng: pos.lng, accuracy: pos.accuracy, timestamp: pos.timestamp };

    const route = this._ridePlanRoute;
    if (this._rideProgress == null && this._savedRideProgress) {
      const savedPoint = RideNavigation.pointAtProgress(route, this._savedRideProgress.progress);
      const accuracy = Number(pos.accuracy);
      const validationRadius = Math.max(100, (Number.isFinite(accuracy) ? Math.max(0, accuracy) : 0) * 2);
      if (savedPoint && RideNavigation.distance(savedPoint, pos) <= validationRadius) {
        this._rideProgress = this._savedRideProgress.progress;
      }
      this._savedRideProgress = null;
    }
    const hadPriorProgress = Number.isFinite(this._rideProgress);
    const previousFixTimestamp = this._rideLastFixTimestamp;
    const elapsedSeconds = Number.isFinite(previousFixTimestamp) ? Math.max(0, (Number(pos.timestamp) - previousFixTimestamp) / 1000) : 0;
    const gpsGap = Number.isFinite(previousFixTimestamp) && elapsedSeconds > 30;
    const maxForwardMeters = gpsGap ? 5000 : Math.min(1200, 60 + elapsedSeconds * 70);
    const projected = RideNavigation.projectProgress(route, pos, this._rideProgress, { gpsGap, maxForwardMeters });
    if (!projected) return;
    if (!hadPriorProgress) this._rideProgress = projected.progress;
    else this._rideProgress = Math.max(this._rideProgress - 35, projected.progress);
    this._rideLastFixTimestamp = Number(pos.timestamp) || Date.now();
    this._writeRideProgress(this._rideProgress);

    const priorTargetId = this._rideNextWaypoint?.id ?? null;
    let stopInfo = RideNavigation.inferNextStop(route, this.currentTrip.waypoints, pos, this._rideProgress, this.rideVisitedWaypoints, { projection: projected, gpsGap });
    if (!projected.ambiguous) this.markVisitedWaypoints(pos, stopInfo.nextWaypoint);
    stopInfo = RideNavigation.inferNextStop(route, this.currentTrip.waypoints, pos, this._rideProgress, this.rideVisitedWaypoints, { projection: projected, gpsGap });
    this._rideNextWaypoint = stopInfo.nextWaypoint;
    this._rideStopInfo = stopInfo;
    this._rideProgress = Math.max(this._rideProgress, stopInfo.progress || 0);
    this._rideAmbiguousPosition = !!projected.ambiguous || !!stopInfo.ambiguous;
    const targetId = this._rideNextWaypoint?.id ?? null;
    const targetChanged = priorTargetId !== targetId;
    if (targetChanged) {
      this._rideRequestId++;
      this.rideRerouting = false;
      MapManager.clearRideNavigationRoute?.();
      window.RideRideUI?.clearDeviation?.();
      window.RideRideUI?.clearUndo?.();
      this._ridePlannedLegTargetId = undefined;
    }
    if (targetChanged || !this._rideNavigationRoute || (this._rideNavigationRoute._planned && this._ridePlannedLegTargetId !== targetId)) {
      this._setRideNavigationRoute(this._makePlannedNavigationRoute(pos, this._rideProgress, stopInfo));
      this._ridePlannedLegTargetId = targetId;
    }
    const inferredVisited = new Set(stopInfo.inferredVisitedIds || []);
    const remaining = this.getRemainingWaypoints().filter(wp => !inferredVisited.has(wp.id));
    const stopsEl = document.getElementById('rideStops');
    if (stopsEl) stopsEl.textContent = remaining.length.toString();

    const activeRoute = this._rideNavigationRoute || this._ridePlanRoute;
    const near = RideNavigation.projectProgress(activeRoute, pos, this._rideNavProgress);
    const threshold = Math.max(60, (pos.accuracy || 30) * 1.8);
    this.offRouteCounter = near && near.distance > threshold ? (this.offRouteCounter || 0) + 1 : 0;
    const now = Date.now();
    if (this._rideNextWaypoint && this._rideDetourDecisions.get(this._rideNextWaypoint.id) !== 'keep' &&
        this.offRouteCounter >= 4 && !this.rideRerouting && now - (this.lastRerouteAt || 0) > 45000) {
      this._requestRideLeg(pos, this._rideNextWaypoint, 'off-route');
    }

    this._updateRideHud(pos);
    if (!this._rideNextWaypoint && stopInfo.distance < 30 && !this._rideAmbiguousPosition && !this._rideArrived) {
      this._rideArrived = true;
      const instruction = document.getElementById('rideNextInstruction');
      const meta = document.getElementById('rideNextMeta');
      if (instruction) instruction.textContent = '🏁 You have arrived!';
      if (meta) meta.textContent = 'Ride complete';
    }
  }
});
