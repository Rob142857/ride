/**
 * App Core — state, init, shared utilities
 * Controllers (auth, trip, waypoint, journal, ride) extend this object via Object.assign.
 *
 * Guest-first: the app boots straight to the map. Signed-out users plan trips
 * locally (api.js serves the same API surface from localStorage when
 * App.useCloud is false); login is only suggested when an action needs the cloud.
 */
const App = {
  currentTrip: null,
  currentUser: null,
  isOnline: true,
  useCloud: false,
  isSharedView: false,
  isRiding: false,
  isRefreshing: false,
  _activeUploads: 0,
  rideVisitedWaypoints: null,
  rideRerouting: false,
  offRouteCounter: 0,
  lastRerouteAt: 0,
  tripDetailId: null,
  tripListCache: [],
  tripDataCache: {},
  waypointSaveToastAt: 0,
  isReorderingWaypoints: false,
  tripWriteClock: {},
  _waypointHistory: [],
  _waypointHistoryIndex: -1,
  _restoreSaving: false,
  _migratingLocal: false,
  _failedMigrationIds: null,

  /* --- Waypoint history (undo / redo) --- */

  /** Return a deep clone of the given waypoints array */
  _cloneWaypoints(waypoints) {
    return (waypoints || []).map(wp => ({ ...wp }));
  },

   /** Reset the waypoints history stack. Call whenever a trip is loaded. */
   _resetWaypointHistory() {
     this._waypointHistory = [];
     this._waypointHistoryIndex = -1;
     if (this.currentTrip?.waypoints) {
       this._waypointHistory.push(this._cloneWaypoints(this.currentTrip.waypoints));
       this._waypointHistoryIndex = 0;
     }
     this._updateUndoRedoButtons();
   },

   /** Test whether two waypoint arrays represent the same edits (for refresh preservation). */
   _waypointsEqual(a, b) {
     const left = (a || []).slice().sort((x, y) => String(x.id).localeCompare(String(y.id)));
     const right = (b || []).slice().sort((x, y) => String(x.id).localeCompare(String(y.id)));
     if (left.length !== right.length) return false;
     return left.every((wp, i) => {
       const other = right[i];
       if (!wp || !other) return false;
       return wp.id === other.id &&
         wp.order === other.order &&
         Math.abs((wp.lat ?? 0) - (other.lat ?? 0)) < 1e-8 &&
         Math.abs((wp.lng ?? 0) - (other.lng ?? 0)) < 1e-8;
     });
   },

   /**
    * If a new/refresh response has the same waypoints as the currently edited trip,
    * preserve the user's undo/redo stack so refreshes don't silently wipe history.
    * Returns a clone of the stack/index, or null if nothing to preserve.
    */
   _preserveWaypointHistoryIfUnchanged(newTrip) {
     if (!newTrip?.id || newTrip.id !== this.currentTrip?.id) return null;
     if (!this._waypointsEqual(this.currentTrip.waypoints, newTrip.waypoints)) return null;
     return {
       stack: this._waypointHistory.map(s => this._cloneWaypoints(s)),
       index: this._waypointHistoryIndex
     };
   },

   /** Restore a preserved history stack (used after loadTripData resets history). */
   _restoreWaypointHistory(saved) {
     if (!saved || !Array.isArray(saved.stack)) return;
     this._waypointHistory = saved.stack;
     this._waypointHistoryIndex = Math.max(0, Math.min(saved.index, saved.stack.length - 1));
     this._updateUndoRedoButtons();
   },

  /**
   * Push current (pre-mutation) waypoints state onto the history stack,
   * truncating any redo branch. Callers invoke this immediately BEFORE a
   * mutation; undo/redo capture the live post-mutation state lazily.
   */
  _pushWaypointHistory() {
    if (!this.currentTrip) return;
    const snapshot = this._cloneWaypoints(this.currentTrip.waypoints);
    // Truncate any redo entries ahead of the current position
    if (this._waypointHistoryIndex < this._waypointHistory.length - 1) {
      this._waypointHistory = this._waypointHistory.slice(0, this._waypointHistoryIndex + 1);
    }
    this._waypointHistory.push(snapshot);
    this._waypointHistoryIndex++;
    // Limit history depth to 30 to avoid memory bloat
    if (this._waypointHistory.length > 30) {
      this._waypointHistory.shift();
      this._waypointHistoryIndex--;
    }
    this._updateUndoRedoButtons();
  },

  /** Restore waypoints from a history snapshot and refresh UI */
  _restoreWaypointsFromHistory(waypoints) {
    if (!this.currentTrip) return;
    this.currentTrip.waypoints = this._cloneWaypoints(waypoints);
    if (!this.currentTrip.settings || typeof this.currentTrip.settings !== 'object') {
      this.currentTrip.settings = {};
    }
    this.currentTrip.settings.waypoint_order = this.currentTrip.waypoints.map(w => w.id);
    UI.renderWaypoints(this.currentTrip.waypoints);
    MapManager.updateWaypoints(this.currentTrip.waypoints);
    if (this.currentTrip.waypoints.length >= 2) {
      MapManager.updateRoute(this.currentTrip.waypoints);
    } else {
      MapManager.clearRoute();
    }
  },

  /** True when the live waypoints differ from the snapshot at the history cursor. */
  _historyDirty() {
    if (!this.currentTrip || this._waypointHistoryIndex < 0) return false;
    return !this._waypointsEqual(this.currentTrip.waypoints, this._waypointHistory[this._waypointHistoryIndex]);
  },

  undoWaypointChange() {
    if (!this.currentTrip || this._waypointHistoryIndex < 0) return;
    if (this._restoreSaving) { UI.showToast('Still saving the previous change…', 'info'); return; }
    if (!this.ensureEditable('undo changes')) return;
    const dirty = this._historyDirty();
    if (!dirty && this._waypointHistoryIndex <= 0) return;
    const before = this._cloneWaypoints(this.currentTrip.waypoints);
    if (dirty) {
      // Capture the live (post-mutation) state so redo can return to it.
      this._waypointHistory = this._waypointHistory.slice(0, this._waypointHistoryIndex + 1);
      this._waypointHistory.push(before.map(wp => ({ ...wp })));
      this._waypointHistoryIndex = this._waypointHistory.length - 1;
    }
    let target = this._waypointHistoryIndex - 1;
    // Skip over snapshots identical to the current state (pre-mutation pushes
    // can leave adjacent duplicates at the base of the stack).
    while (target > 0 && this._waypointsEqual(this._waypointHistory[target], before)) target--;
    this._waypointHistoryIndex = target;
    if (this._waypointsEqual(this._waypointHistory[target], before)) {
      // Nothing actually changes — just settle the cursor.
      this._updateUndoRedoButtons();
      return;
    }
    this._restoreWaypointsFromHistory(this._waypointHistory[target]);
    this._updateUndoRedoButtons();
    this._persistWaypointRestore(before);
  },

  redoWaypointChange() {
    if (!this.currentTrip) return;
    if (this._waypointHistoryIndex >= this._waypointHistory.length - 1) return;
    if (this._restoreSaving) { UI.showToast('Still saving the previous change…', 'info'); return; }
    if (!this.ensureEditable('redo changes')) return;
    const before = this._cloneWaypoints(this.currentTrip.waypoints);
    let target = this._waypointHistoryIndex + 1;
    while (target < this._waypointHistory.length - 1 &&
           this._waypointsEqual(this._waypointHistory[target], before)) target++;
    this._waypointHistoryIndex = target;
    if (this._waypointsEqual(this._waypointHistory[target], before)) {
      this._updateUndoRedoButtons();
      return;
    }
    this._restoreWaypointsFromHistory(this._waypointHistory[target]);
    this._updateUndoRedoButtons();
    this._persistWaypointRestore(before);
  },

  /**
   * Persist an undo/redo restoration through the same API surface normal edits
   * use (delete/add/move/reorder + trip save), so a refresh can't resurrect
   * undone changes. `before` is the pre-restore waypoint set (matching what the
   * server currently has); the live trip holds the restored target state.
   */
  async _persistWaypointRestore(before) {
    const trip = this.currentTrip;
    if (!trip?.id || this.isSharedView) return;
    this._restoreSaving = true;
    if (typeof this.setWaypointsSaving === 'function') this.setWaypointsSaving(true);
    try {
      const after = trip.waypoints || [];
      const beforeById = new Map((before || []).map(w => [w.id, w]));
      const afterIds = new Set(after.map(w => w.id));

      // 1) Remove waypoints the restore took away
      for (const w of before || []) {
        if (afterIds.has(w.id)) continue;
        const res = await API.waypoints.delete(trip.id, w.id, { headers: this.getTripIfMatchHeaders() });
        this.applyTripMetaFromResponse(trip, res);
      }

      // 2) Re-add waypoints the restore brought back. The server assigns fresh
      //    ids — remap them through the whole history stack so redo stays coherent.
      let idsChanged = false;
      for (let i = 0; i < after.length; i++) {
        const w = after[i];
        if (beforeById.has(w.id)) continue;
        const res = await API.waypoints.add(trip.id, {
          lat: w.lat,
          lng: w.lng,
          name: w.name || 'Waypoint',
          type: w.type || 'stop',
          notes: w.notes || '',
          address: w.address || '',
          order: i,
          sort_order: i
        }, { headers: this.getTripIfMatchHeaders() });
        this.applyTripMetaFromResponse(trip, res);
        const newId = res?.waypoint?.id;
        if (newId && newId !== w.id) {
          const oldId = w.id;
          w.id = newId;
          idsChanged = true;
          this._waypointHistory.forEach(snap => snap.forEach(s => { if (s.id === oldId) s.id = newId; }));
        }
      }
      // Rendered rows and markers still carry the pre-restore ids — repaint so
      // a follow-up tap (delete, drag, details) addresses the right waypoint.
      if (idsChanged) {
        UI.renderWaypoints(after);
        MapManager.updateWaypoints(after);
      }

      // 3) Move waypoints whose position changed
      for (const w of after) {
        const prev = beforeById.get(w.id);
        if (!prev) continue;
        const moved = Math.abs((prev.lat ?? 0) - (w.lat ?? 0)) > 1e-8 ||
                      Math.abs((prev.lng ?? 0) - (w.lng ?? 0)) > 1e-8;
        if (!moved) continue;
        const res = await API.waypoints.update(trip.id, w.id, { lat: w.lat, lng: w.lng },
          { headers: this.getTripIfMatchHeaders() });
        this.applyTripMetaFromResponse(trip, res);
      }

      // 4) Persist order + trip-level state through the normal save path
      const orderIds = after.map(w => w.id);
      const orderChanged = JSON.stringify(orderIds) !== JSON.stringify((before || []).map(w => w.id));
      if (orderIds.length && orderChanged) {
        const res = await API.waypoints.reorder(trip.id, orderIds, { headers: this.getTripIfMatchHeaders() });
        this.applyTripMetaFromResponse(trip, res);
      }
      if (!trip.settings || typeof trip.settings !== 'object') trip.settings = {};
      trip.settings.waypoint_order = orderIds;
      this.markTripWritten(trip.id);
      await this.saveCurrentTrip();
      this.refreshTripsList();
    } catch (error) {
      if (error?.status === 409 || error?.status === 428) {
        await this.handleTripConflict(error);
      } else {
        console.error('Failed to persist waypoint restore:', error);
        UI.showToast('Undo not saved — refresh to resync.', 'error');
      }
    } finally {
      this._restoreSaving = false;
      if (typeof this.setWaypointsSaving === 'function') this.setWaypointsSaving(false);
    }
  },

  _updateUndoRedoButtons() {
     const undoBtn = document.getElementById('undoWaypointBtn');
     const redoBtn = document.getElementById('redoWaypointBtn');
     const hasUndo = this._waypointHistoryIndex > 0;
     const hasRedo = this._waypointHistoryIndex < this._waypointHistory.length - 1;
     if (undoBtn) {
       undoBtn.disabled = !hasUndo;
       undoBtn.setAttribute('aria-disabled', hasUndo ? 'false' : 'true');
       undoBtn.title = hasUndo ? 'Undo last waypoint change' : 'Nothing to undo';
       undoBtn.classList.toggle('has-history', hasUndo);
     }
     if (redoBtn) {
       redoBtn.disabled = !hasRedo;
       redoBtn.setAttribute('aria-disabled', hasRedo ? 'false' : 'true');
       redoBtn.title = hasRedo ? 'Redo waypoint change' : 'Nothing to redo';
       redoBtn.classList.toggle('has-history', hasRedo);
     }
   },

  /* --- /Waypoint history --- */

  async init() {
    this.isOnline = navigator.onLine;
    window.addEventListener('online', () => this.handleOnlineChange(true));
    window.addEventListener('offline', () => this.handleOnlineChange(false));

    UI.init();
    MapManager.init();

    const urlParams = new URLSearchParams(window.location.search);
    const sharedTripId = urlParams.get('trip');
    const isEmbed = urlParams.get('embed') === 'true';
    const authError = urlParams.get('error');
    const authErrorDesc = urlParams.get('error_description');
    this.isSharedView = !!sharedTripId;

    // Guest-first boot: no landing gate, no login wall. checkAuth silently
    // resolves the session; signed-out users get the local trip experience.
    await this.checkAuth();

    window.addEventListener('ride:auth-expired', () => this.handleAuthExpired());
    window.addEventListener('ride:connection-lost', (e) => this.handleConnectionLost(e?.detail));
    window.addEventListener('beforeunload', (e) => {
      if (this._activeUploads > 0) {
        e.preventDefault();
        e.returnValue = '';
      }
    });

    this.configureLoginLinks();

    this.bindUserButton();
    this.bindTripDetails();
    this.bindEvents();
    this.bindSessionRefresh();

    if (authError) this.handleAuthErrorFromUrl(authError, authErrorDesc);

    // Just signed in (OAuth returns via a full page load) — lift any trips the
    // user planned as a guest into their account before the first render.
    if (!sharedTripId) await this.migrateLocalTripsToCloud();

    if (sharedTripId) {
      await this.loadSharedTrip(sharedTripId, isEmbed);
    } else {
      await this.loadInitialTrip();
      UI.switchView('map');
    }

    this.refreshTripsList();
  },

  /* --- Shared utilities --- */

  handleOnlineChange(online) {
    this.isOnline = online;
    UI.showToast(online ? 'Back online' : 'You are offline', online ? 'success' : 'info');
  },

  /**
   * Nudge — never block — a guest toward signing in for a cloud-only action.
   * Callers reach here after catching an err.code === 'LOGIN_REQUIRED'.
   */
  _suggestLogin(action = 'sync your trips') {
    if (typeof UI.suggestLogin === 'function') UI.suggestLogin(action);
    else UI.showToast(`Sign in to ${action}.`, 'info');
  },

  /**
   * Gate for edit actions. Guests can edit local trips freely; only cloud
   * trips require an online, authenticated session.
   */
  ensureEditable(action = 'make changes') {
    if (this.isSharedView) {
      UI.showToast(`This is a shared trip — import it to ${action}.`, 'info');
      return false;
    }
    if (this.useCloud && this.currentUser) {
      if (!this.isOnline) {
        UI.showToast('Offline. Editing will resume when you reconnect.', 'error');
        return false;
      }
      return true;
    }
    // Guest mode: a cloud trip whose session lapsed needs re-auth first.
    if (this.currentTrip?._fromCloud) {
      this._suggestLogin(action);
      return false;
    }
    return true;
  },

  normalizeTrip(trip) {
    if (!trip) return trip;
    const normalized = { ...trip };
    // Ensure camelCase aliases exist (API normalizer handles most, but locally-created trips may not have them)
    if (!normalized.createdAt && normalized.created_at) normalized.createdAt = normalized.created_at;
    if (!normalized.updatedAt && normalized.updated_at) normalized.updatedAt = normalized.updated_at;
    if (normalized.waypoints) normalized.waypoints = Trip.normalizeWaypointOrder(normalized.waypoints);
    if (normalized.route) {
      const duration = normalized.route.duration ?? normalized.route.time ?? null;
      normalized.route = {
        ...normalized.route, duration, time: duration,
        coordinates: normalized.route.coordinates || []
      };
    }
    // Ensure cover focus defaults
    if (!Number.isFinite(normalized.coverFocusX)) normalized.coverFocusX = normalized.cover_focus_x ?? 50;
    if (!Number.isFinite(normalized.coverFocusY)) normalized.coverFocusY = normalized.cover_focus_y ?? 50;
    normalized.cover_focus_x = normalized.coverFocusX;
    normalized.cover_focus_y = normalized.coverFocusY;
    // Ensure coverImageUrl alias
    if (!normalized.coverImageUrl) normalized.coverImageUrl = normalized.cover_image_url || '';
    normalized.cover_image_url = normalized.coverImageUrl;
    // Normalize alternative routes
    if (!Array.isArray(normalized.alternativeRoutes)) {
      normalized.alternativeRoutes = Array.isArray(normalized.alternative_routes) ? normalized.alternative_routes : [];
    }
    normalized.activeRouteIndex = normalized.active_route_index ?? normalized.activeRouteIndex ?? 0;
    normalized.alternative_routes = normalized.alternativeRoutes;
    normalized.active_route_index = normalized.activeRouteIndex;
    return normalized;
  },

  getTripSortTimestamp(trip) {
    const ts = trip?.updatedAt || trip?.createdAt;
    return ts ? new Date(ts).getTime() : 0;
  },

  formatDistance(m) { return RideUtils.formatDistance(m); },
  formatDuration(s) { return RideUtils.formatDuration(s); },

  /** Clear all trip-related UI (used on logout / trip removal) */
  _clearTripUI() {
    this.currentTrip = null;
    this.tripListCache = [];
    MapManager.clear();
    if (typeof MapManager.clearJournalPhotos === 'function') MapManager.clearJournalPhotos();
    UI.renderTrips([], null);
    UI.renderWaypoints([]);
    UI.renderJournal([]);
    UI.updateTripTitle('');
    UI.updateTripStats(null);
  },

  /* --- Event binding --- */

  bindEvents() {
    this.bindJournalAttachmentPicker();
    this.bindWaypointDetails();
    this.bindRideControls();
    this.bindClearShapingBtn();
  },

  bindTripDetails() {
    const form = document.getElementById('tripDetailsForm');
    const copyBtn = document.getElementById('tripDetailCopy');
    const coverFileInput = document.getElementById('tripDetailCoverFile');
    const coverFileBtn = document.getElementById('tripDetailCoverFileBtn');
    const coverFileName = document.getElementById('tripDetailCoverFileName');
    const coverInput = document.getElementById('tripDetailCover');
    const focusXInput = document.getElementById('tripDetailCoverFocusX');
    const focusYInput = document.getElementById('tripDetailCoverFocusY');

    if (form) form.addEventListener('submit', e => { e.preventDefault(); this.saveTripDetails(); });
    if (coverFileBtn && coverFileInput) {
      coverFileBtn.addEventListener('click', () => coverFileInput.click());
      coverFileInput.addEventListener('change', () => {
        const file = coverFileInput.files?.[0];
        if (coverFileName) coverFileName.textContent = file?.name || '';
        // Show local preview immediately via blob URL
        if (file && file.type.startsWith('image/')) {
          if (this._coverBlobUrl) URL.revokeObjectURL(this._coverBlobUrl);
          this._coverBlobUrl = URL.createObjectURL(file);
          this.updateCoverFocusUI();
        }
      });
    }
    if (coverInput) coverInput.addEventListener('input', () => {
      // Clear blob preview when user types a URL manually
      if (this._coverBlobUrl) { URL.revokeObjectURL(this._coverBlobUrl); this._coverBlobUrl = null; }
      this.updateCoverFocusUI();
    });

    // Wire 2-D focal-point picker (click/drag to set focus)
    const picker = document.getElementById('tripDetailCoverFocusPicker');
    if (picker) {
      const applyPointer = (clientX, clientY) => {
        const rect = picker.getBoundingClientRect();
        const x = Math.round(Math.max(0, Math.min(100, (clientX - rect.left) / rect.width * 100)));
        const y = Math.round(Math.max(0, Math.min(100, (clientY - rect.top) / rect.height * 100)));
        const fx = document.getElementById('tripDetailCoverFocusX');
        const fy = document.getElementById('tripDetailCoverFocusY');
        if (fx) fx.value = x;
        if (fy) fy.value = y;
        this.updateCoverFocusUI();
      };
      let _pickerDragging = false;
      picker.addEventListener('mousedown', (e) => {
        _pickerDragging = true;
        picker.classList.add('is-dragging');
        applyPointer(e.clientX, e.clientY);
        e.preventDefault();
      });
      picker.addEventListener('touchstart', (e) => {
        _pickerDragging = true;
        picker.classList.add('is-dragging');
        applyPointer(e.touches[0].clientX, e.touches[0].clientY);
      }, { passive: true });
      document.addEventListener('mousemove', (e) => { if (_pickerDragging) applyPointer(e.clientX, e.clientY); });
      document.addEventListener('touchmove', (e) => { if (_pickerDragging) applyPointer(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
      const stopPick = () => { _pickerDragging = false; picker.classList.remove('is-dragging'); };
      document.addEventListener('mouseup', stopPick);
      document.addEventListener('touchend', stopPick);
    }

    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        const input = document.getElementById('tripDetailLink');
        if (!input?.value) { UI.showToast('No link to copy yet', 'info'); return; }
        try {
          await navigator.clipboard.writeText(input.value);
          UI.showToast('Link copied', 'success');
        } catch (err) { console.error(err); UI.showToast('Copy failed', 'error'); }
      });
    }
    this.updateCoverFocusUI();
  },

  updateCoverFocusUI() {
    const coverInput = document.getElementById('tripDetailCover');
    const img = document.getElementById('tripDetailCoverFocusImg');
    const dot = document.getElementById('tripDetailCoverFocusDot');
    const emptyState = document.getElementById('tripDetailCoverFocusEmpty');
    const focusXInput = document.getElementById('tripDetailCoverFocusX');
    const focusYInput = document.getElementById('tripDetailCoverFocusY');
    const xRaw = Number(focusXInput?.value);
    const yRaw = Number(focusYInput?.value);
    const x = Number.isFinite(xRaw) ? xRaw : 50;
    const y = Number.isFinite(yRaw) ? yRaw : 50;
    // Prefer local blob preview (file just picked), then fall back to URL input
    const imageUrl = this._coverBlobUrl || coverInput?.value?.trim() || '';
    const hasImage = !!imageUrl;
    if (img) {
      img.src = imageUrl || '';
      img.style.objectPosition = `${x}% ${y}%`;
    }
    if (dot) {
      dot.style.display = hasImage ? 'block' : 'none';
      dot.style.left = `${x}%`;
      dot.style.top = `${y}%`;
    }
    if (emptyState) emptyState.style.display = hasImage ? 'none' : 'flex';
  },

  /* --- Import & share --- */

  /**
   * Recreate a trip's content through the API (used by JSON import and
   * local→cloud migration). Preserves waypoint order and shaping points
   * (type 'via'). Returns the created trip id; on failure rolls the partial
   * trip back and rethrows so the caller keeps its source data.
   */
  async _replayTripToApi(source) {
    const created = await API.trips.create({ name: source.name || 'Imported trip' });
    const shell = { version: created.version };
    try {
      const waypoints = Trip.normalizeWaypointOrder(this._cloneWaypoints(source.waypoints));
      for (let i = 0; i < waypoints.length; i++) {
        const wp = waypoints[i];
        if (!Number.isFinite(Number(wp.lat)) || !Number.isFinite(Number(wp.lng))) continue;
        const res = await API.waypoints.add(created.id, {
          lat: Number(wp.lat),
          lng: Number(wp.lng),
          name: wp.name || 'Waypoint',
          type: wp.type || 'stop',
          notes: wp.notes || '',
          address: wp.address || '',
          order: i,
          sort_order: i
        }, { headers: this.getTripIfMatchHeaders(shell) });
        this.applyTripMetaFromResponse(shell, res);
      }
      for (const entry of (source.journal || [])) {
        await API.journal.add(created.id, {
          title: entry.title || '',
          content: entry.content || '',
          is_private: !!(entry.is_private ?? entry.isPrivate),
          tags: Array.isArray(entry.tags) ? entry.tags : [],
          ...(entry.location ? { location: entry.location } : {})
        });
      }
      if (source.description || source.route) {
        try {
          await API.trips.update(created.id, {
            ...(source.description ? { description: source.description } : {}),
            ...(source.route ? {
              route: {
                coordinates: source.route.coordinates || [],
                distance: source.route.distance ?? null,
                duration: source.route.duration ?? source.route.time ?? null,
                steps: source.route.steps || [],
                travelMode: source.route.travelMode || 'drive'
              }
            } : {})
          }, { headers: this.getTripIfMatchHeaders(shell) });
        } catch (_) {
          // Non-fatal: waypoints and journal are already safe.
        }
      }
      return created.id;
    } catch (err) {
      try { await API.trips.delete(created.id); } catch (_) {}
      throw err;
    }
  },

  /**
   * Lift guest (localStorage) trips into the account after a successful login.
   * Each trip is replayed through the normal API surface — waypoints keep their
   * order and their type (including 'via' shaping points), journal entries keep
   * privacy, tags and location. A trip that fails to migrate stays in local
   * storage, so a partial failure never loses data.
   * @returns {Promise<number>} number of trips moved to the cloud
   */
  async migrateLocalTripsToCloud() {
    if (this._migratingLocal) return 0;
    if (!this.useCloud || !this.currentUser || !this.isOnline) return 0;
    if (typeof API.local?.exportAllTrips !== 'function') return 0;
    if (!this._failedMigrationIds) this._failedMigrationIds = new Set();

    let localTrips = [];
    try { localTrips = API.local.exportAllTrips(); } catch (_) { return 0; }
    if (!Array.isArray(localTrips)) return 0;
    // Empty shells (the placeholder trip a guest never filled in) aren't worth
    // syncing. Trips that already failed this session are skipped so a broken
    // one can't loop on every reconnect.
    const hasContent = t => (t.waypoints?.length || 0) > 0 || (t.journal?.length || 0) > 0;
    const pending = localTrips.filter(t => t?.id && hasContent(t) && !this._failedMigrationIds.has(t.id));
    if (!pending.length) return 0;

    this._migratingLocal = true;
    const migrated = new Set();
    try {
      for (const local of pending) {
        try {
          const waypoints = [...(local.waypoints || [])]
            .sort((a, b) => (a.sort_order ?? a.order ?? 0) - (b.sort_order ?? b.order ?? 0));
          await this._replayTripToApi({ ...local, waypoints, journal: local.journal || [] });
          migrated.add(local.id);
        } catch (error) {
          this._failedMigrationIds.add(local.id);
          console.error('Failed to sync a local trip:', error);
        }
      }
    } finally {
      this._migratingLocal = false;
    }

    // Anything that failed stays on this device rather than being dropped.
    const remaining = localTrips.filter(t => hasContent(t) && !migrated.has(t.id));

    // The replay above carries name/waypoints/journal/description/route, but
    // not ride logs, saved alternatives, cover art or share settings. Archive
    // the originals before clearing so a migration can never destroy them.
    const archived = localTrips.filter(t => migrated.has(t.id));
    if (archived.length) {
      try {
        Storage.save('ride_local_trips_archive', archived);
      } catch (_) { /* quota — the cloud copy is already the primary */ }
    }

    if (!remaining.length) API.local.clearAllTrips();
    else Storage.saveLocalTrips(remaining);

    const failed = pending.length - migrated.size;
    const plural = n => (n === 1 ? 'trip' : 'trips');
    if (migrated.size && failed) {
      UI.showToast(`${migrated.size} ${plural(migrated.size)} synced — ${failed} kept on this device to retry.`, 'info');
    } else if (migrated.size) {
      UI.showToast(`${migrated.size} ${plural(migrated.size)} synced to your account`, 'success');
    } else if (failed) {
      UI.showToast('Could not sync your local trips — they are still saved on this device.', 'error');
    }
    return migrated.size;
  },

  async importTrip() {
    try {
      const trip = await Share.importFromFile();
      const tripId = await this._replayTripToApi(trip);
      const fullTrip = await API.trips.get(tripId);
      this.loadTripData(fullTrip);
      this.bumpTripToTop(tripId);
      this.refreshTripsList();
      UI.showToast(`Imported: ${trip.name}`, 'success');
    } catch (err) {
      if (err?.code === 'LOGIN_REQUIRED') { this._suggestLogin('import this trip'); return; }
      console.error('Import error:', err);
      UI.showToast('Failed to import trip', 'error');
    }
  },

  async loadSharedTrip(shareId, isEmbed) {
    try {
      let sharedData = null;
      // Public share endpoint works signed-out too — always try the API first.
      try {
        const res = await API.request(`/s/${shareId}`, { silent: true, quiet: true });
        sharedData = res.trip || res;
      } catch (_) {
        sharedData = (typeof Share !== 'undefined' && Share.loadSharedTrip)
          ? Share.loadSharedTrip(shareId)
          : null;
      }
      if (sharedData) {
        const trip = Trip.create(sharedData.name);
        trip.waypoints = Trip.normalizeWaypointOrder(sharedData.waypoints || []);
        trip.journal = (sharedData.journal || []).map(e => ({
          ...e,
          isPrivate: !!(e.is_private ?? e.isPrivate),
          createdAt: e.created_at ?? e.createdAt,
          updatedAt: e.updated_at ?? e.updatedAt,
          tags: Array.isArray(e.tags) ? e.tags : [],
          attachments: e.attachments || [],
        }));
        trip.shareId = sharedData.share_id ?? sharedData.shareId;
        trip.share_id = trip.shareId;
        trip.shortCode = sharedData.short_code ?? sharedData.shortCode;
        trip.short_code = trip.shortCode;
        trip.isPublic = !!(sharedData.is_public ?? sharedData.isPublic);
        trip.is_public = trip.isPublic ? 1 : 0;
        trip.coverImageUrl = sharedData.cover_image_url || sharedData.coverImageUrl || sharedData.cover_image || '';
        trip.cover_image_url = trip.coverImageUrl;
        trip.coverFocusX = Number.isFinite(sharedData.cover_focus_x) ? sharedData.cover_focus_x : (sharedData.coverFocusX ?? 50);
        trip.cover_focus_x = trip.coverFocusX;
        trip.coverFocusY = Number.isFinite(sharedData.cover_focus_y) ? sharedData.cover_focus_y : (sharedData.coverFocusY ?? 50);
        trip.cover_focus_y = trip.coverFocusY;
        this.loadTripData(trip);
        if (isEmbed) {
          document.getElementById('bottomNav').classList.add('hidden');
          document.getElementById('topBar').style.display = 'none';
        }
        UI.showToast(`Viewing: ${trip.name}`, 'info');
      } else {
        UI.showToast('Shared trip not found', 'error');
        this.loadInitialTrip();
      }
    } catch (error) {
      console.error('Failed to load shared trip:', error);
      UI.showToast('Failed to load shared trip', 'error');
      this.loadInitialTrip();
    }
  }
};

// Initialize app when DOM is ready (all controller scripts loaded by then)
document.addEventListener('DOMContentLoaded', () => App.init());
window.App = App;
