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
      if (createWaypoint && position) {
        this._insertWaypointAtPosition(position);
      }
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
    if (!this.currentTrip) { UI.showToast('No trip loaded', 'error'); return; }
    if (!this.currentTrip.route?.coordinates) {
      UI.showToast('Add a route first to start riding', 'error'); return;
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
    document.getElementById('rideOverlay')?.classList.remove('hidden');
    document.body.classList.add('ride-mode');
    document.getElementById('rideTripName').textContent = this.currentTrip.name || 'Ride';
    document.getElementById('rideStops').textContent = (this.currentTrip.waypoints?.length ?? 0).toString();
    document.getElementById('rideDistanceRemaining').textContent = this.currentTrip.route?.distance ? this.formatDistance(this.currentTrip.route.distance) : '—';
    document.getElementById('rideEta').textContent = this.currentTrip.route?.duration ? this.formatDuration(this.currentTrip.route.duration) : '—';
    document.getElementById('rideNextInstruction').textContent = 'Follow the route';
    document.getElementById('rideNextMeta').textContent = 'Waiting for GPS…';
    this.precomputeRouteMetrics();
    MapManager.startRide(pos => this.onRidePosition(pos));
  },

  exitRideMode() {
    this.isRiding = false;
    this.rideVisitedWaypoints = null;
    this.rideRerouting = false;
    this.offRouteCounter = 0;
    this._rideArrived = false;
    document.getElementById('rideOverlay')?.classList.add('hidden');
    document.body.classList.remove('ride-mode');
    MapManager.stopRide();
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
  },

  /** @deprecated Use RideUtils.haversine directly */
  haversine(a, b) { return RideUtils.haversine(a, b); },

  markVisitedWaypoints(position) {
    if (!this.currentTrip?.waypoints) return;
    const threshold = 40;
    if (!this.rideVisitedWaypoints) this.rideVisitedWaypoints = new Set();
    this.currentTrip.waypoints.forEach(wp => {
      if (this.rideVisitedWaypoints.has(wp.id)) return;
      if (this.haversine(wp, position) <= threshold) {
        this.rideVisitedWaypoints.add(wp.id);
        UI.showToast(`📍 Arrived at ${wp.name || 'waypoint'}`, 'success');
      }
    });
  },

  getRemainingWaypoints() {
    if (!this.currentTrip?.waypoints) return [];
    if (!this.rideVisitedWaypoints) this.rideVisitedWaypoints = new Set();
    return [...this.currentTrip.waypoints]
      .filter(wp => !this.rideVisitedWaypoints.has(wp.id))
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

  onRidePosition(pos) {
    if (!this.isRiding || !this.currentTrip?.route?.coordinates || !this.currentTrip.route._cumulative) return;

    // On first GPS fix, check if we're far from the route.
    if (!this.rideInitialRouted) {
      this.rideInitialRouted = true;
      const coords = this.currentTrip.route.coordinates;
      let nearestDist = Infinity;
      for (let i = 0; i < coords.length; i++) {
        const d = this.haversine(coords[i], pos);
        if (d < nearestDist) nearestDist = d;
      }
      if (nearestDist > 200) {
        const allWaypoints = [...(this.currentTrip.waypoints || [])].sort((a, b) => a.order - b.order);
        if (allWaypoints.length) {
          UI.showToast('Routing to your first waypoint…', 'info');
          this.rideRerouting = true;
          this.lastRerouteAt = Date.now();
          MapManager.rerouteFromPosition(pos, allWaypoints);
          return;
        }
      }
    }

    const coords = this.currentTrip.route.coordinates;
    const cumulative = this.currentTrip.route._cumulative;
    const total = this.currentTrip.route._total || cumulative[cumulative.length - 1] || 0;
    this.markVisitedWaypoints(pos);
    const remainingWaypoints = this.getRemainingWaypoints();
    const stopsEl = document.getElementById('rideStops');
    if (stopsEl) stopsEl.textContent = remainingWaypoints.length.toString();

    // Find nearest route point (sliding window)
    const { idx: nearestIdx, dist: bestDist } = this._findNearestRouteIdx(coords, pos);

    // Off-route detection with dynamic threshold
    const dynamicThreshold = Math.max(50, (pos.accuracy || 30) * 1.6);
    const now = Date.now();
    if (bestDist > dynamicThreshold) {
      this.offRouteCounter = (this.offRouteCounter || 0) + 1;
    } else {
      this.offRouteCounter = 0;
    }

    const canReroute = bestDist > dynamicThreshold && this.offRouteCounter >= 4
      && !this.rideRerouting && (now - (this.lastRerouteAt || 0) > 45000);
    if (canReroute) {
      this.rideRerouting = true;
      this.lastRerouteAt = now;
      UI.showToast('Off route. Rerouting…', 'info');
      MapManager.rerouteFromPosition(pos, remainingWaypoints);
    }

    // Distance remaining
    const remaining = Math.max(0, total - cumulative[nearestIdx]);
    document.getElementById('rideDistanceRemaining').textContent = RideUtils.formatDistance(remaining);

    // Live ETA: estimate from remaining distance and average speed so far
    const elapsed = (now - (this._rideStartTime || now)) / 1000;
    const travelled = total - remaining;
    if (elapsed > 10 && travelled > 50) {
      const avgSpeed = travelled / elapsed; // m/s
      const etaSeconds = remaining / avgSpeed;
      document.getElementById('rideEta').textContent = RideUtils.formatDuration(etaSeconds);
    }

    // Arrival detection
    if (remaining < 30 && remainingWaypoints.length === 0 && !this._rideArrived) {
      this._rideArrived = true;
      document.getElementById('rideNextInstruction').textContent = '🏁 You have arrived!';
      document.getElementById('rideNextMeta').textContent = 'Ride complete';
      UI.showToast('🏁 You have arrived at your destination!', 'success');
      return;
    }

    // Turn-by-turn instruction
    const steps = this.currentTrip.route.steps || [];
    const nextStep = steps.find(s => s.index > nearestIdx);
    if (nextStep) {
      document.getElementById('rideNextInstruction').textContent = nextStep.text || 'Continue';
      const distToNextStep = cumulative[nextStep.index] - cumulative[nearestIdx];
      document.getElementById('rideNextMeta').textContent = `${RideUtils.formatDistance(Math.max(0, distToNextStep))} ahead`;
    } else if (!this._rideArrived) {
      document.getElementById('rideNextInstruction').textContent = 'Continue to destination';
      document.getElementById('rideNextMeta').textContent = RideUtils.formatDistance(remaining) + ' remaining';
    }
  }
});
