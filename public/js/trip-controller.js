/**
 * Trip Controller — trip CRUD, loading, caching, ordering
 * Trip details modal is in trip-details.js
 * Extends App object (loaded after app-core.js)
 */
Object.assign(App, {
  /* --- Trip caching & versioning --- */

  markTripWritten(tripId) {
    if (!tripId) return;
    if (!this.tripWriteClock) this.tripWriteClock = {};
    this.tripWriteClock[tripId] = Date.now();
  },

  cacheTripData(trip) {
    if (!trip?.id) return;
    if (!this.tripDataCache) this.tripDataCache = {};
    this.tripDataCache[trip.id] = trip;
  },

  getCachedTrip(tripId) {
    return this.tripDataCache?.[tripId] || null;
  },

  getTripIfMatchHeaders(trip = this.currentTrip) {
    const version = Number(trip?.version);
    if (!Number.isFinite(version)) return {};
    return { 'If-Match': String(version) };
  },

  applyTripMetaFromResponse(trip, meta) {
    if (!trip || !meta) return;
    if (meta.trip_version !== undefined) {
      const v = Number(meta.trip_version);
      if (Number.isFinite(v)) trip.version = v;
    }
    if (meta.trip_updated_at) {
      trip.updated_at = meta.trip_updated_at;
      trip.updatedAt = meta.trip_updated_at;
    }
  },

  /* --- Save guard: single-flight, back-off, conflict pause --- */

  _getSaveGuard() {
    if (this._tripSaveGuard) return this._tripSaveGuard;
    const isCurrent = tripId => this.currentTrip?.id === tripId;
    this._tripSaveGuard = window.RideSaveGuard.createSaveGuard({
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: id => clearTimeout(id),
      onConflict: (tripId, err) => { this.handleTripConflict(err, { tripId }); },
      onRetryScheduled: (tripId, { delayMs }) => {
        if (isCurrent(tripId)) UI.showToast(`Save failed. Retrying in ${Math.max(1, Math.round(delayMs / 1000))}s…`, 'info');
      },
      onRecovered: (tripId, result) => {
        if (isCurrent(tripId) && result?.value === true) UI.showToast('Saved to cloud', 'success');
      },
      onGiveUp: (tripId, err) => {
        console.error('Save abandoned after retries:', err);
        if (isCurrent(tripId)) UI.showToast('Save failed. Not saved to cloud.', 'error');
      },
    });
    return this._tripSaveGuard;
  },

  isTripSavePaused(tripId = this.currentTrip?.id) {
    return !!tripId && !!this._tripSaveGuard?.isPaused(tripId);
  },

  /**
   * A save was refused because the trip changed elsewhere (409/412).
   * Autosave for the trip pauses, the latest server copy is fetched once, and
   * the rider chooses Reload or Keep mine. Nothing retries on its own, so a
   * persistent conflict can't turn into a request loop (it used to reload,
   * recalculate the route on OSRM and save again, endlessly).
   */
  async handleTripConflict(err, { tripId } = {}) {
    const id = tripId || this.currentTrip?.id;
    if (!id) return;
    this._getSaveGuard().pause(id);
    clearTimeout(this._altSaveTimer);
    this._pendingAltSave = false;
    if (this._conflict?.tripId === id) return; // already fetching or asking
    const conflict = { tripId: id, latest: null, serverVersion: Number(err?.body?.trip_version) };
    this._conflict = conflict;
    try {
      conflict.latest = this.normalizeTrip(await API.trips.get(id));
    } catch (error) {
      console.warn('Could not fetch the latest trip after a conflict:', error);
    }
    if (this._conflict !== conflict) return;
    if (this.currentTrip?.id !== id) { this._clearTripConflict(id); return; }
    UI.showTripConflictPrompt({
      onReload: () => this.resolveTripConflict('reload'),
      onKeepMine: () => this.resolveTripConflict('keep'),
    });
  },

  _clearTripConflict(tripId) {
    this._conflict = null;
    this._tripSaveGuard?.resume(tripId);
  },

  async resolveTripConflict(choice) {
    const conflict = this._conflict;
    if (!conflict) return;
    UI.hideTripConflictPrompt();
    this._clearTripConflict(conflict.tripId);
    if (this.currentTrip?.id !== conflict.tripId) return;
    if (choice === 'reload') {
      if (conflict.latest) {
        this.loadTripData(conflict.latest);
        UI.showToast('Latest version loaded', 'success');
      } else {
        await this.refreshData('conflict');
      }
      return;
    }
    // Keep mine: adopt the server's version number, then save this device's copy once.
    const version = Number(conflict.latest?.version ?? conflict.serverVersion);
    if (Number.isFinite(version)) this.currentTrip.version = version;
    const ok = await this.saveCurrentTrip();
    if (ok) {
      UI.showToast('Your version saved', 'success');
      this.refreshTripsList();
    }
  },

  /* --- Trip ordering --- */

  applyTripOrder(trips) {
    const normalizedTrips = trips.map(t => this.normalizeTrip(t));
    const order = Storage.getTripOrder() || [];
    const byId = new Map(normalizedTrips.map(t => [t.id, t]));
    const seen = new Set();
    const ordered = [];
    order.forEach(id => {
      const trip = byId.get(id);
      if (trip) { ordered.push(trip); seen.add(id); }
    });
    const remaining = normalizedTrips
      .filter(t => !seen.has(t.id))
      .sort((a, b) => this.getTripSortTimestamp(b) - this.getTripSortTimestamp(a));
    const finalList = [...ordered, ...remaining];
    Storage.setTripOrder(finalList.map(t => t.id));
    return finalList;
  },

  bumpTripToTop(tripId) {
    const order = Storage.getTripOrder().filter(id => id !== tripId);
    Storage.setTripOrder([tripId, ...order]);
  },

  reorderTrips(tripId, direction) {
    if (!this.tripListCache?.length) return;
    const trips = [...this.tripListCache];
    const index = trips.findIndex(t => t.id === tripId);
    if (index === -1) return;
    const target = index + (direction === 'up' ? -1 : 1);
    if (target < 0 || target >= trips.length) return;
    [trips[index], trips[target]] = [trips[target], trips[index]];
    Storage.setTripOrder(trips.map(t => t.id));
    this.tripListCache = trips;
    UI.renderTrips(trips, this.currentTrip?.id);
  },

  /* --- Trip loading & saving --- */

  async loadInitialTrip() {
    if (this.useCloud && this.currentUser) {
      try {
        const trips = await API.trips.list();
        const pendingImportedId = localStorage.getItem('ride_imported_trip_id');
        if (trips.length > 0) {
          const targetId = (pendingImportedId && trips.some(t => t.id === pendingImportedId))
            ? pendingImportedId : trips[0].id;
          const trip = await API.trips.get(targetId);
          if (pendingImportedId) {
            localStorage.removeItem('ride_imported_trip_id');
            this.bumpTripToTop(targetId);
          }
          this.loadTripData(trip);
        } else {
          this.createNewTrip();
        }
      } catch (error) {
        console.error('Failed to load cloud trips:', error);
        UI.showToast('Unable to load trips from server. Please retry online.', 'error');
        this._clearTripUI();
      }
    } else {
      this._clearTripUI();
    }
  },

  loadTripData(trip) {
    // A background refresh must not tear down a live GPS session.
    if (this.isRiding && this._rideTripId === trip.id) return;
    this.endRideForTripSwitch?.();
    if (this._conflict && this._conflict.tripId !== trip.id) {
      // The conflict prompt belongs to the trip we are leaving.
      UI.hideTripConflictPrompt?.();
      this._clearTripConflict(this._conflict.tripId);
    }
    window.RideInsights?.track('trip_open');
    if (trip.waypoints) trip.waypoints = Trip.normalizeWaypointOrder(trip.waypoints);
    trip = this.normalizeTrip(trip);
    if (!Number.isFinite(Number(trip.version))) trip.version = 0;
    else trip.version = Number(trip.version);
    this.attachJournalAttachments(trip);
    // Preserve undo/redo stack when refreshing data if waypoints haven't changed.
    const preservedHistory = this._preserveWaypointHistoryIfUnchanged(trip);
    this.currentTrip = trip;
    this.cacheTripData(trip);
    this._resetWaypointHistory();
    if (preservedHistory) this._restoreWaypointHistory(preservedHistory);
    UI.updateTripTitle(trip.name);
    UI.updateTripStats(trip);
    UI.renderWaypoints(trip.waypoints || []);
    UI.renderJournal(trip.journal || []);
    MapManager.clear();
    MapManager.updateWaypoints(trip.waypoints || [], { route: trip.route });
    this.restoreAlternativesToMap(trip);
    if (trip.waypoints?.length > 0) MapManager.fitToWaypoints(trip.waypoints);

    // Load and draw historical ride tracks for this trip (async, non-blocking)
    if (this.useCloud && this.currentUser && trip.id) {
      this.flushPendingRides?.().finally(() => this.refreshRideTracks?.());
    }
    // Render route-alternatives panel (SPA) if module available
    if (typeof window.RouteAlternatives !== 'undefined') {
      const panel = window.RouteAlternatives.renderPanel(trip);
      if (panel) {
        const mapEl = document.getElementById('map');
        if (mapEl && mapEl.parentNode) {
          mapEl.parentNode.insertBefore(panel, mapEl.nextSibling);
        }
        // One-time listener for route selection
        if (!this._routeAltListenerSet) {
          this._routeAltListenerSet = true;
          window.addEventListener('ride:routeSelected', (ev) => {
            const { routeIndex } = ev.detail || {};
            if (routeIndex == null || !this.currentTrip) return;
            if (this.isRiding) {
              UI.showToast('Exit Ride to change the planned route.', 'info');
              return;
            }
            const alternatives = this.currentTrip.alternativeRoutes || this.currentTrip.alternative_routes || [];
            const allOptions = alternatives.length ? alternatives : [this.currentTrip.route];
            const selected = allOptions[routeIndex];
            if (!selected?.coordinates?.length) return;
            this.currentTrip.activeRouteIndex = routeIndex;
            this.currentTrip.active_route_index = routeIndex;
            this.currentTrip.route = { ...selected, time: selected.duration ?? selected.time };
            if (typeof MapManager.clear === 'function') MapManager.clear();
            if (typeof MapManager.updateWaypoints === 'function') MapManager.updateWaypoints(this.currentTrip.waypoints || [], { route: selected });
            this.currentTrip.distance = selected.distance;
            this.currentTrip.duration = selected.duration;
            UI.updateTripStats(this.currentTrip);
            this.saveAlternativeRoutes(allOptions, routeIndex);
          });
        }
      }
    }
    window.dispatchEvent(new CustomEvent('ride:tripLoaded', { detail: { tripId: trip.id } }));
  },

  /* --- Alternative routes persistence --- */

  /**
   * Save alternative routes to backend.
   * @param {Array|Object} alternatives - Array of route objects, or legacy { roots, activeId }
   * @param {number} [selectedIndex] - Index of currently selected route
   */
  saveAlternativeRoutes(alternatives, selectedIndex) {
    if (!this.currentTrip) return;
    let routesArray = alternatives;
    let activeIdx = selectedIndex ?? this.currentTrip.activeRouteIndex ?? 0;
    if (alternatives && !Array.isArray(alternatives) && Array.isArray(alternatives.roots)) {
      routesArray = alternatives.roots;
      activeIdx = alternatives.activeId ?? activeIdx;
    }
    if (!Array.isArray(routesArray)) return;
    const choices = Trip.uniqueRouteChoices(routesArray, activeIdx);
    routesArray = choices.routes;
    activeIdx = choices.activeIndex;
    const backendRoutes = routesArray.map((r, i) => ({
      name: r.name || r.label || `Route ${i + 1}`,
      summary: r.summary || '',
      color: r.color || null,
      coordinates: r.coordinates || r.inputWaypoints?.map(w => [w.lng, w.lat]) || [],
      steps: Array.isArray(r.steps) ? r.steps : [],
      distance_meters: typeof r.distance === 'number' ? r.distance : (typeof r.distance_meters === 'number' ? r.distance_meters : null),
      duration_seconds: typeof r.duration === 'number' ? r.duration : (typeof r.time === 'number' ? r.time : (typeof r.duration_seconds === 'number' ? r.duration_seconds : null)),
      is_selected: i === activeIdx,
      is_visible: true,
    }));
    this.currentTrip.activeRouteIndex = activeIdx;
    this.currentTrip.active_route_index = activeIdx;
    this.currentTrip.alternativeRoutes = routesArray;
    this.currentTrip.alternative_routes = routesArray;
    this.currentTrip.alternatives = routesArray;
    this.currentTrip._allAlternatives = routesArray;
    if (this.useCloud && this.currentUser) {
      const savedTrip = this.currentTrip;
      clearTimeout(this._altSaveTimer);
      this._pendingAltSave = true;
      this._altSaveTimer = setTimeout(async () => {
        // Autosave is paused while the rider resolves a conflict.
        if (this.isTripSavePaused(savedTrip.id)) { this._pendingAltSave = false; return; }
        try {
          await API.trips.saveAlternativeRoutes(savedTrip.id, backendRoutes);
          const updated = await API.trips.update(savedTrip.id, { active_route_index: activeIdx, route: routesArray[activeIdx] });
          savedTrip.version = Number(updated.version);
        } catch (err) {
          console.error('Failed to save alternative routes:', err);
          if (err?.status === 409 || err?.status === 412) this.handleTripConflict(err, { tripId: savedTrip.id });
        }
        this._pendingAltSave = false;
      }, 1500);
    }
  },

  restoreAlternativesToMap(trip) {
    const altRoutes = trip?.alternativeRoutes || trip?.alternative_routes || trip?.alternatives?.roots;
    if (!Array.isArray(altRoutes) || !altRoutes.length) return;
    const allRoutes = altRoutes;
    if (!allRoutes.length) return;
    if (typeof MapManager.setAlternativeRoots === 'function') {
      MapManager.setAlternativeRoots(allRoutes.map((r, i) => ({ id: i, ...r })));
    }
    if (typeof MapManager.onAlternativesChange === 'function') {
      MapManager.onAlternativesChange(allRoutes.map((r, i) => ({ id: i, ...r })));
    }
    if (typeof MapManager.showAlternativeRoute === 'function') {
      const activeIdx = trip?.activeRouteIndex ?? trip?.active_route_index ?? 0;
      allRoutes.forEach((r, i) => {
        if (i !== activeIdx) MapManager.showAlternativeRoute({ id: i, ...r }, false);
      });
      const active = allRoutes[activeIdx];
      if (active) MapManager.showAlternativeRoute({ id: activeIdx, ...active }, true);
    }
  },

  attachJournalAttachments(trip) {
    if (!trip) return;
    const attachments = Array.isArray(trip.attachments) ? trip.attachments : [];
    const byEntry = new Map();
    attachments.forEach(att => {
      const entryId = att.journal_entry_id || att.journalEntryId;
      if (!entryId) return;
      if (!byEntry.has(entryId)) byEntry.set(entryId, []);
      byEntry.get(entryId).push(att);
    });
    trip.journal = (trip.journal || []).map(entry => ({
      ...entry,
      attachments: byEntry.get(entry.id) || entry.attachments || []
    }));
    trip.attachments = attachments;
  },

  /**
   * Load a trip by ID. Simplified stale-read guard: trust version numbers.
   */
  async loadTrip(tripId) {
    if (!this.useCloud || !this.currentUser) return;
    if (this._activeUploads > 0) {
      UI.showToast('Upload in progress — please wait', 'warning');
      return;
    }
    try {
      const trip = this.normalizeTrip(await API.trips.get(tripId));
      const cached = this.getCachedTrip(tripId);
      const serverV = Number(trip?.version);
      const cachedV = Number(cached?.version);

      // If server returned an older version than what we have cached, keep cache and retry once
      if (cached && Number.isFinite(serverV) && Number.isFinite(cachedV) && serverV < cachedV) {
        console.warn('loadTrip: stale read detected, keeping cache', { tripId, serverV, cachedV });
        this.loadTripData(cached);
        this.refreshTripsList();
        UI.switchView('map');
        UI.showToast(`Loaded: ${cached.name}`, 'success');
        setTimeout(async () => {
          try {
            if (!this.useCloud || !this.currentUser || this.currentTrip?.id !== tripId) return;
            const retry = this.normalizeTrip(await API.trips.get(tripId));
            if (Number(retry?.version) >= cachedV) this.loadTripData(retry);
          } catch (_) {}
        }, 1500);
        return;
      }

      this.loadTripData(trip);
      this.refreshTripsList();
      UI.switchView('map');
      UI.showToast(`Loaded: ${trip.name}`, 'success');
    } catch (error) {
      console.error('Failed to load cloud trip:', error);
      UI.showToast('Unable to load trip from server.', 'error');
    }
  },

  async createNewTrip(name = 'New Trip') {
    if (this._activeUploads > 0) {
      UI.showToast('Upload in progress — please wait', 'warning');
      return;
    }
    if (this.useCloud && this.currentUser) {
      try {
        const trip = await API.trips.create({ name });
        const fullTrip = await API.trips.get(trip.id);
        this.currentTrip = fullTrip;
        this.loadTripData(fullTrip);
        this.bumpTripToTop(fullTrip.id);
        this.refreshTripsList();
        UI.showToast('New trip created', 'success');
        window.RideInsights?.track('trip_create');
        return;
      } catch (error) {
        console.error('Failed to create cloud trip:', error);
        UI.showToast('Login required to create trips.', 'error');
        return;
      }
    }
    UI.showToast('Login to create and save trips.', 'error');
  },

  /**
   * Save the current trip. Goes through the save guard: one PUT in flight per
   * trip, back-off retries for transient errors, and a pause on conflict.
   * Resolves true only when this call's save reached the server.
   */
  async saveCurrentTrip() {
    if (!this.currentTrip) return false;
    if (!this.useCloud || !this.currentUser) return false;
    const tripId = this.currentTrip.id;
    const result = await this._getSaveGuard().run(tripId, () => this._putCurrentTrip(tripId));
    if (result.ok) return result.value === true;
    if (result.reason === 'failed') {
      const error = result.error;
      console.error('Failed to save to cloud:', error);
      if (error?.status === 404) {
        UI.showToast('Trip missing on server. Reloading your trips…', 'error');
        await this.loadInitialTrip();
      } else {
        UI.showToast('Save failed. Not saved to cloud.', 'error');
      }
    }
    // 'conflict' opens the prompt, 'retrying' and 'gave-up' toast from the
    // guard hooks, 'paused' waits for the rider's choice.
    return false;
  },

  /** One PUT of the current trip. Reads state at call time, so retries send the latest copy. */
  async _putCurrentTrip(tripId) {
    const trip = this.currentTrip;
    // Trip switched or signed out since the save was queued: nothing to send.
    if (!trip || trip.id !== tripId || !this.useCloud || !this.currentUser) return false;
    const route = trip.route
      ? {
          coordinates: trip.route.coordinates || [],
          distance: trip.route.distance ?? null,
          duration: trip.route.duration ?? trip.route.time ?? null,
          steps: trip.route.steps || [],
          travelMode: trip.route.travelMode || 'drive'
        }
      : null;
    const updated = await API.trips.update(trip.id, {
      name: trip.name,
      description: trip.description,
      settings: trip.settings,
      route,
      active_route_index: trip.activeRouteIndex ?? trip.active_route_index ?? 0,
      cover_image_url: trip.coverImageUrl || trip.cover_image_url,
      cover_focus_x: trip.coverFocusX ?? trip.cover_focus_x,
      cover_focus_y: trip.coverFocusY ?? trip.cover_focus_y
    }, { headers: this.getTripIfMatchHeaders(trip) });
    if (updated) {
      if (updated.updated_at) {
        trip.updated_at = updated.updated_at;
        trip.updatedAt = updated.updated_at;
      }
      if (updated.version !== undefined) {
        const v = Number(updated.version);
        if (Number.isFinite(v)) trip.version = v;
      }
    }
    this.markTripWritten(trip.id);
    return true;
  },

  async deleteTrip(tripId) {
    if (this.useCloud && this.currentUser) {
      try { await API.trips.delete(tripId); } catch (error) { console.error('Failed to delete trip:', error); }
    }
    Storage.setTripOrder(Storage.getTripOrder().filter(id => id !== tripId));
    this.tripListCache = (this.tripListCache || []).filter(t => t.id !== tripId);
    if (this.currentTrip?.id === tripId) await this.loadInitialTrip();
    this.refreshTripsList();
    UI.showToast('Trip deleted', 'success');
  },

  /* --- Refresh (simplified stale-read) --- */

  _refreshTripsTimer: null,
  _refreshTripsResolvers: [],

  /**
   * Debounced refreshTripsList — coalesces rapid successive calls
   * into a single API request after 400ms of quiet.
   */
  refreshTripsList() {
    return new Promise((resolve) => {
      this._refreshTripsResolvers.push(resolve);
      clearTimeout(this._refreshTripsTimer);
      this._refreshTripsTimer = setTimeout(() => this._doRefreshTripsList(), 400);
    });
  },

  async _doRefreshTripsList() {
    const resolvers = this._refreshTripsResolvers.splice(0);
    const finish = () => resolvers.forEach(r => r());
    if (!this.useCloud || !this.currentUser) {
      Storage.setTripOrder([]);
      this.tripListCache = [];
      UI.renderTrips([], this.currentTrip?.id);
      finish(); return;
    }
    try {
      const trips = await API.trips.list();
      const currentId = this.currentTrip?.id;
      if (!trips.length) {
        Storage.setTripOrder([]);
        this.tripListCache = [];
        UI.renderTrips([], currentId);
        finish(); return;
      }
      const orderedTrips = this.applyTripOrder(trips);
      this.tripListCache = orderedTrips;
      UI.renderTrips(orderedTrips, currentId);
    } catch (error) {
      console.error('Failed to load trips list:', error);
      UI.showToast('Unable to load trips from server.', 'error');
    }
    finish();
  },

  /**
   * Refresh current trip and list. Simplified: trust version numbers only.
   */
  async refreshData(source = 'manual') {
    if (this.isRefreshing) return;
    if (!this.useCloud || !this.currentUser) {
      UI.showToast('Login to refresh from cloud.', 'error');
      return;
    }
    this.isRefreshing = true;
    try {
      const trips = await API.trips.list();
      const orderedTrips = this.applyTripOrder(trips);
      this.tripListCache = orderedTrips;

      const currentId = this.currentTrip?.id;
      const currentExists = currentId ? orderedTrips.some(t => t.id === currentId) : false;
      const fallbackId = orderedTrips[0]?.id ?? null;
      const targetId = currentExists ? currentId : fallbackId;
      UI.renderTrips(orderedTrips, targetId);

      if (!targetId) {
        this._clearTripUI();
        UI.showToast('No trips available to refresh.', 'info');
        return;
      }

      const loadFresh = async (id) => {
        try { return this.normalizeTrip(await API.trips.get(id)); }
        catch (err) { if (err.status === 404) return null; throw err; }
      };

      let fresh = await loadFresh(targetId);
      if (!fresh && fallbackId && fallbackId !== targetId) fresh = await loadFresh(fallbackId);
      if (!fresh) {
        this._clearTripUI();
        UI.showToast('Trip not found. Please try again.', 'error');
        return;
      }

      // Simple stale-read guard: if server version < local version, retry once
      const serverV = Number(fresh.version);
      const localV = Number(this.currentTrip?.version);
      if (source === 'visibility' && Number.isFinite(serverV) && Number.isFinite(localV) && serverV < localV) {
        console.warn('refreshData: stale read, retrying', { serverV, localV });
        setTimeout(async () => {
          try {
            if (!this.useCloud || !this.currentUser || this.currentTrip?.id !== fresh.id) return;
            const retry = await loadFresh(fresh.id);
            if (!retry) return;
            if (Number(retry.version) >= Number(this.currentTrip?.version)) this.loadTripData(retry);
          } catch (_) {}
        }, 1500);
        return;
      }

      this.loadTripData(fresh);
      UI.showToast('Latest data loaded', 'success');
    } catch (error) {
      console.error('Refresh failed:', error);
      UI.showToast('Refresh failed. Please try again.', 'error');
    } finally {
      this.isRefreshing = false;
    }
  },

});
