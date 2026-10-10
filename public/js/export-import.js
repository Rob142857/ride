/**
 * Export/Import module — JSON/GPX export & file import
 * Extends Share object defined in share.js
 */
Object.assign(Share, {
  exportOwnerJSON() {
    if (!App.currentTrip) { UI.showToast('No trip to back up', 'error'); return; }
    const data = Trip.getOwnerBackupData(App.currentTrip);
    this.downloadFile(JSON.stringify(data, null, 2), `${App.currentTrip.name.replace(/[^a-z0-9]/gi, '_')}_private_backup.json`, 'application/json');
    UI.showToast('Private backup downloaded. Keep it private; media files remain in your account.', 'success');
  },

  /**
   * Export trip as JSON
   */
  exportJSON() {
    if (!App.currentTrip) {
      UI.showToast('No trip to export', 'error');
      return;
    }

    const includeWaypoints = document.getElementById('shareWaypoints')?.checked ?? true;
    const includeRoute = document.getElementById('shareRoute')?.checked ?? true;
    const includeNotes = document.getElementById('sharePublicNotes')?.checked ?? true;
    const includeGallery = document.getElementById('shareGallery')?.checked ?? true;

    const data = Trip.getShareableData(App.currentTrip, {
      includeWaypoints,
      includeRoute,
      includePublicNotes: includeNotes,
      includeGallery
    });

    const json = JSON.stringify(data, null, 2);
    this.downloadFile(json, `${App.currentTrip.name.replace(/[^a-z0-9]/gi, '_')}.json`, 'application/json');
    UI.showToast('Trip exported as JSON', 'success');
  },

  /**
   * Export trip as GPX
   */
  exportGPX() {
    if (!App.currentTrip) {
      UI.showToast('No trip to export', 'error');
      return;
    }

    const gpx = Trip.toGPX(App.currentTrip);
    this.downloadFile(gpx, `${App.currentTrip.name.replace(/[^a-z0-9]/gi, '_')}.gpx`, 'application/gpx+xml');
    UI.showToast('Trip exported as GPX', 'success');
  },

  /**
   * Download file
   */
  downloadFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  /**
   * Import trip from file
   */
  importFromFile() {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,.gpx';

      input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) {
          reject(new Error('No file selected'));
          return;
        }

        try {
          const content = await file.text();
          let trip;

          if (file.name.endsWith('.gpx')) {
            trip = Trip.fromGPX(content, file.name.replace('.gpx', ''));
          } else {
            const data = JSON.parse(content);
            trip = this.importFromJSON(data);
          }

          trip._importSource = content;

          resolve(trip);
        } catch (err) {
          reject(err);
        }
      };

      input.click();
    });
  },

  /**
   * Import trip from JSON data
   */
  importFromJSON(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Trip JSON must contain an object.');
    // Handle both full trip export and shareable export
    const trip = Trip.create(data.name || 'Imported Trip');

    if (data.description) trip.description = data.description;
    if (data.waypoints && !Array.isArray(data.waypoints)) throw new Error('Waypoints must be an array.');
    if (data.journal && !Array.isArray(data.journal)) throw new Error('Journal entries must be an array.');
    const sourceSettings = typeof data.settings === 'string' ? JSON.parse(data.settings) : (data.settings || trip.settings);
    if (!sourceSettings || typeof sourceSettings !== 'object' || Array.isArray(sourceSettings)) throw new Error('Trip settings must contain an object.');
    trip.settings = { ...sourceSettings };
    delete trip.settings.importState;
    if (data.waypoints) trip.waypoints = data.waypoints.map((wp, index) => ({ ...wp, id: wp.id || `source-waypoint-${index}`, order: index }));
    if (data.route) trip.route = { ...data.route, duration: data.route.duration ?? data.route.time ?? null };
    if (data.journal) trip.journal = data.journal.map((entry, index) => ({ ...entry, id: entry.id || `source-journal-${index}`, isPrivate: !!(entry.is_private ?? entry.isPrivate ?? true), waypointId: entry.waypoint_id ?? entry.waypointId ?? null }));
    if (data.alternativeRoutes?.length || data.alternative_routes?.length) {
      const alts = data.alternativeRoutes || data.alternative_routes || [];
      // Distinguish selected route on import
      const saved = alts.find(r => r.saved || r.is_selected) || alts[0];
      trip.alternativeRoutes = alts;
      trip.alternative_routes = alts;
      if (saved && saved.coordinates?.length) {
        trip.activeRouteIndex = data.activeRouteIndex ?? data.active_route_index ?? saved.alt_idx ?? saved.route_index ?? 0;
        trip.active_route_index = trip.activeRouteIndex;
      }
    }

    // Keep source IDs until cloud import can remap every reference to fresh server IDs.
    const choices = Trip.uniqueRouteChoices(trip.alternativeRoutes || [], trip.activeRouteIndex);
    trip.alternativeRoutes = choices.routes;
    trip.alternative_routes = choices.routes;
    trip.activeRouteIndex = choices.activeIndex;
    trip.active_route_index = choices.activeIndex;
    trip._importSource = JSON.stringify(data);
    this.validateImport(trip);
    return trip;
  },

  validateImport(trip) {
    const ids = new Set();
    const types = new Set(['stop', 'start', 'end', 'via', 'camp', 'fuel', 'food', 'water', 'scenic', 'rest', 'border', 'hotel', 'poi']);
    for (const wp of trip.waypoints || []) {
      if (!wp.name || typeof wp.name !== 'string') throw new Error('Every waypoint needs a name.');
      if (!Number.isFinite(wp.lat) || wp.lat < -90 || wp.lat > 90 || !Number.isFinite(wp.lng) || wp.lng < -180 || wp.lng > 180) throw new Error(`Invalid coordinates for ${wp.name}.`);
      if (ids.has(wp.id)) throw new Error('Waypoint IDs must be unique.');
      if (wp.type && !types.has(wp.type)) throw new Error(`Unknown waypoint type for ${wp.name}.`);
      ids.add(wp.id);
    }
    for (const entry of trip.journal || []) {
      if (!entry.title) throw new Error('Every journal entry needs a title.');
      const waypointId = entry.waypointId ?? entry.waypoint_id;
      if (waypointId && !ids.has(waypointId)) throw new Error('A journal entry refers to a missing waypoint.');
    }
    for (const route of [trip.route, ...(trip.alternativeRoutes || [])].filter(Boolean)) {
      if (!Array.isArray(route.coordinates || [])) throw new Error('Route coordinates must be an array.');
      for (const point of route.coordinates || []) {
        const lat = point.lat ?? point[1];
        const lng = point.lng ?? point[0];
        if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) throw new Error('Route contains invalid coordinates.');
      }
    }
    if (trip.settings?.itinerary) {
      const result = window.RideItinerary.recalculate(trip.settings.itinerary);
      if (result.conflicts.length) throw new Error(result.conflicts[0].message);
      for (const stop of result.itinerary.stops) {
        if (stop.waypointId && !ids.has(stop.waypointId)) throw new Error(`${stop.name} refers to a missing waypoint.`);
      }
      trip.settings.itinerary = result.itinerary;
    }
    return trip;
  },

  async importToCloud(trip, api = API) {
    this.validateImport(trip);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(trip._importSource || JSON.stringify(trip)));
    const fingerprint = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
    const prior = (await api.trips.list()).find(item => item.settings?.importState?.fingerprint === fingerprint);
    if (prior?.settings.importState.status === 'complete') return api.trips.get(prior.id);
    let cloudTrip = null;
    try {
      const settings = JSON.parse(JSON.stringify(trip.settings || {}));
      const itinerary = settings.itinerary;
      delete settings.itinerary;
      delete settings.waypoint_order;
      settings.importState = { fingerprint, status: 'partial', journalIds: {} };
      cloudTrip = prior ? await api.trips.get(prior.id) : await api.trips.create({ name: trip.name, description: trip.description || '', settings });
      const loaded = await api.trips.get(cloudTrip.id);
      let version = Number(loaded.version || 0);
      const waypointIds = new Map();
      const journalIds = new Map(Object.entries(loaded.settings?.importState?.journalIds || {}));
      const savedWaypoints = loaded.waypoints || [];
      if (savedWaypoints.length > trip.waypoints.length) throw new Error('The partial trip was edited; it cannot be resumed automatically');
      for (let index = 0; index < savedWaypoints.length; index++) {
        const original = trip.waypoints[index];
        const saved = savedWaypoints[index];
        if (saved.name !== original.name || saved.lat !== original.lat || saved.lng !== original.lng || (saved.type || 'stop') !== (original.type || 'stop')) throw new Error('The partial trip stops changed; review it before retrying');
        waypointIds.set(original.id, saved.id);
      }
      const checkpoint = async () => {
        const state = { fingerprint, status: 'partial', completedWaypoints: waypointIds.size, journalIds: Object.fromEntries(journalIds) };
        const updated = await api.trips.update(cloudTrip.id, { settings: { importState: state } }, { headers: { 'If-Match': String(version) } });
        version = Number(updated.version);
        settings.importState = state;
      };
      // Reconcile a response lost after a successful server write using the stored
      // waypoint prefix, then continue at the first missing source waypoint.
      for (let index = savedWaypoints.length; index < trip.waypoints.length; index++) {
        const wp = trip.waypoints[index];
        const response = await api.waypoints.add(cloudTrip.id, wp, { headers: { 'If-Match': String(version) } });
        waypointIds.set(wp.id, response.waypoint.id);
        version = Number(response.trip_version);
        if (!Number.isFinite(version)) version = Number((await api.trips.get(cloudTrip.id)).version);
        await checkpoint();
      }
      const existingJournal = [...(loaded.journal || [])];
      const acknowledgedIds = new Set(journalIds.values());
      const unacknowledged = existingJournal.filter(entry => !acknowledgedIds.has(entry.id));
      for (const entry of trip.journal) {
        const sourceWaypointId = entry.waypointId ?? entry.waypoint_id;
        const payload = {
          title: entry.title, content: entry.content || '',
          waypoint_id: sourceWaypointId ? waypointIds.get(sourceWaypointId) : null,
          is_private: !!(entry.is_private ?? entry.isPrivate ?? true),
          tags: Array.isArray(entry.tags) ? entry.tags : [], location: entry.location || null,
        };
        if (journalIds.has(entry.id)) {
          const saved = existingJournal.find(note => note.id === journalIds.get(entry.id));
          if (!saved || saved.title !== payload.title || saved.content !== payload.content ||
              (saved.waypoint_id ?? saved.waypointId ?? null) !== payload.waypoint_id || !!(saved.is_private ?? saved.isPrivate) !== payload.is_private) {
            throw new Error('A journal note changed in the partial trip; review it before retrying');
          }
          continue;
        }
        const matchIndex = unacknowledged.findIndex(saved => saved.title === payload.title && saved.content === payload.content &&
          (saved.waypoint_id ?? saved.waypointId ?? null) === payload.waypoint_id && !!(saved.is_private ?? saved.isPrivate) === payload.is_private);
        const saved = matchIndex >= 0 ? unacknowledged.splice(matchIndex, 1)[0] : await api.journal.add(cloudTrip.id, payload);
        journalIds.set(entry.id, saved.id);
        version = Number((await api.trips.get(cloudTrip.id)).version);
        await checkpoint();
      }
      if (unacknowledged.length) throw new Error('Extra notes were added to the partial trip; review it before retrying');
      // Journal writes bump the trip version too; refetch before the guarded final save.
      version = Number((await api.trips.get(cloudTrip.id)).version);
      settings.waypoint_order = trip.waypoints.map(wp => waypointIds.get(wp.id));
      if (itinerary) {
        settings.itinerary = itinerary;
        settings.itinerary.stops = itinerary.stops.map(stop => ({ ...stop,
          waypointId: stop.waypointId ? waypointIds.get(stop.waypointId) : null,
          privateJournalRefs: (stop.privateJournalRefs || []).map(id => journalIds.get(id)).filter(Boolean),
          leg: stop.leg ? { ...stop.leg,
            fromWaypointId: stop.leg.fromWaypointId ? waypointIds.get(stop.leg.fromWaypointId) : null,
            toWaypointId: stop.leg.toWaypointId ? waypointIds.get(stop.leg.toWaypointId) : null,
          } : undefined,
        }));
      }
      const updated = await api.trips.update(cloudTrip.id, { settings, route: trip.route, active_route_index: trip.activeRouteIndex || 0 }, { headers: { 'If-Match': String(version) } });
      version = Number(updated.version);
      if (trip.alternativeRoutes?.length) {
        const routes = trip.alternativeRoutes.map((route, index) => ({ ...route,
          distance_meters: route.distance_meters ?? route.distance ?? null,
          duration_seconds: route.duration_seconds ?? route.duration ?? route.time ?? null,
          is_selected: index === (trip.activeRouteIndex || 0), is_visible: route.is_visible !== false,
        }));
        await api.trips.saveAlternativeRoutes(cloudTrip.id, routes, { headers: { 'If-Match': String(version) } });
      }
      const fullTrip = await api.trips.get(cloudTrip.id);
      if (fullTrip.waypoints.length !== trip.waypoints.length || fullTrip.journal.length !== trip.journal.length ||
          !!(fullTrip.is_public ?? fullTrip.isPublic) ||
          (trip.route && !fullTrip.route) || (itinerary && !fullTrip.settings.itinerary) ||
          (trip.alternativeRoutes?.length && fullTrip.alternativeRoutes.length !== trip.alternativeRoutes.length)) {
        throw new Error('Imported data did not pass the server reload check.');
      }
      for (const original of trip.journal) {
        const saved = fullTrip.journal.find(entry => entry.id === journalIds.get(original.id));
        const originalWaypointId = original.waypoint_id ?? original.waypointId;
        if (!saved || !!(saved.is_private ?? saved.isPrivate) !== !!(original.is_private ?? original.isPrivate ?? true) ||
            (saved.waypoint_id ?? saved.waypointId ?? null) !== (originalWaypointId ? waypointIds.get(originalWaypointId) : null)) {
          throw new Error('Private note permissions or waypoint links did not survive the server reload');
        }
      }
      await api.trips.update(cloudTrip.id, { settings: { importState: { fingerprint, status: 'complete' } } }, { headers: { 'If-Match': String(fullTrip.version) } });
      return await api.trips.get(cloudTrip.id);
    } catch (cause) {
      if (!cloudTrip) throw cause;
      const error = new Error(`Import stopped: ${cause.message}. A partial private trip named “${trip.name}” was saved. Import the same file again to resume it.`);
      error.partialTripId = cloudTrip.id;
      throw error;
    }
  },
});
