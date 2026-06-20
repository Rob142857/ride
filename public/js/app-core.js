/**
 * App Core — state, init, shared utilities
 * Controllers (auth, trip, waypoint, journal, ride) extend this object via Object.assign.
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
  loginPromptShown: false,
  tripDetailId: null,
  tripListCache: [],
  tripDataCache: {},
  waypointSaveToastAt: 0,
  isReorderingWaypoints: false,
  tripWriteClock: {},
  _waypointHistory: [],
  _waypointHistoryIndex: -1,

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
       this._waypointHistoryIndex =0;
     }
     this._updateUndoRedoButtons();
   },

   /** Test whether two waypoint arrays represent the same edits (for refresh preservation). */
   _waypointsEqual(a, b) {
     const left = (a || []).slice().sort((x, y) => x.id.localeCompare(y.id));
     const right = (b || []).slice().sort((x, y) => x.id.localeCompare(y.id));
     if (left.length !== right.length) return false;
     return left.every((wp, i) => {
       const other = right[i];
       if (!wp || !other) return false;
       return wp.id === other.id &&
         wp.order === other.order &&
         Math.abs((wp.lat ?? 0) - (other.lat ?? 0)) <1e-8 &&
         Math.abs((wp.lng ??0) - (other.lng ?? 0)) < 1e-8;
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

  /** Push current waypoints state onto the history stack, truncating any redo branch */
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

  undoWaypointChange() {
    if (this._waypointHistoryIndex <= 0) return;
    this._waypointHistoryIndex--;
    this._restoreWaypointsFromHistory(this._waypointHistory[this._waypointHistoryIndex]);
    this._updateUndoRedoButtons();
  },

  redoWaypointChange() {
    if (this._waypointHistoryIndex >= this._waypointHistory.length - 1) return;
    this._waypointHistoryIndex++;
    this._restoreWaypointsFromHistory(this._waypointHistory[this._waypointHistoryIndex]);
    this._updateUndoRedoButtons();
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

    const landingSeen = (() => {
      try { return localStorage.getItem('ride_landing_seen') === '1'; } catch (_) { return true; }
    })();
    if (!landingSeen && !this.isSharedView && !isEmbed) {
      UI.showLandingGate();
    }

    await this.checkAuth();
    Storage.clearTrips();

    window.addEventListener('ride:auth-expired', () => this.handleAuthExpired());
    window.addEventListener('ride:connection-lost', (e) => this.handleConnectionLost(e?.detail));
    window.addEventListener('beforeunload', (e) => {
      if (this._activeUploads > 0) {
        e.preventDefault();
        e.returnValue = '';
      }
    });

    this.configureLoginLinks();
    if (!this.isSharedView) this.showLoginPromptIfNeeded();

    this.bindUserButton();
    this.bindTripDetails();
    this.bindEvents();
    this.bindSessionRefresh();

    if (authError) this.handleAuthErrorFromUrl(authError, authErrorDesc);

    if (sharedTripId) {
      await this.loadSharedTrip(sharedTripId, isEmbed);
    } else {
      await this.loadInitialTrip();
      UI.switchView('trips');
    }

    this.refreshTripsList();
  },

  /* --- Shared utilities --- */

  handleOnlineChange(online) {
    this.isOnline = online;
    UI.showToast(online ? 'Back online' : 'You are offline', online ? 'success' : 'info');
  },

  ensureEditable(action = 'make changes') {
    if (!this.currentUser || !this.useCloud) {
      UI.showToast(`Sign in to ${action}.`, 'error');
      UI.showAuthGate('Signed out');
      return false;
    }
    if (!this.isOnline) {
      UI.showToast('Offline. Editing is disabled until you reconnect.', 'error');
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

  /** Clear all trip-related UI (used on logout / auth fail) */
  _clearTripUI() {
    this.currentTrip = null;
    this.tripListCache = [];
    MapManager.clear();
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

  async importTrip() {
    try {
      const trip = await Share.importFromFile();
      if (this.useCloud && this.currentUser) {
        const cloudTrip = await API.trips.create({ name: trip.name });
        for (const wp of trip.waypoints) await API.waypoints.add(cloudTrip.id, wp);
        for (const entry of trip.journal) await API.journal.add(cloudTrip.id, entry);
        const fullTrip = await API.trips.get(cloudTrip.id);
        this.loadTripData(fullTrip);
      } else {
        UI.showToast('Login to import trips to your account.', 'error');
        return;
      }
      this.refreshTripsList();
      UI.showToast(`Imported: ${trip.name}`, 'success');
    } catch (err) {
      console.error('Import error:', err);
      UI.showToast('Failed to import trip', 'error');
    }
  },

  async loadSharedTrip(shareId, isEmbed) {
    try {
      let sharedData;
      if (this.useCloud) {
        const res = await API.request(`/s/${shareId}`);
        sharedData = res.trip || res;
      } else {
        sharedData = Share.loadSharedTrip(shareId);
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
