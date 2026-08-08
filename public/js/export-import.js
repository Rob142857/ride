/**
 * Export/Import module — JSON/GPX export & file import
 * Extends Share object defined in share.js
 */
Object.assign(Share, {
  /** Filesystem-safe basename for the current trip. */
  exportFileBase() {
    const name = (App.currentTrip?.name || 'trip').replace(/[^a-z0-9]/gi, '_').replace(/_+/g, '_');
    return name.replace(/^_|_$/g, '') || 'trip';
  },

  /**
   * Menu "Export Current Trip" — a true backup of the trip you own: every
   * waypoint, the route and its alternatives, and private notes included.
   * The share-modal checkboxes deliberately do NOT apply here.
   */
  exportJSON() {
    if (!App.currentTrip) {
      UI.showToast('No trip to export', 'error');
      return;
    }
    if (App.isSharedView) {
      // Viewing someone else's link: only the public shape is available.
      this.exportSharedJSON();
      return;
    }

    const data = Trip.getBackupData(App.currentTrip);
    this.downloadFile(JSON.stringify(data, null, 2), `${this.exportFileBase()}-backup.json`, 'application/json');
    const privateCount = data.stats?.privateNotesCount || 0;
    UI.showToast(
      `Backup saved — ${data.waypoints.length} waypoints, ${data.journal.length} notes${privateCount ? ` (${privateCount} private)` : ''}`,
      'success'
    );
  },

  /**
   * Share-modal "JSON" — the shaped, shareable version, filtered by whatever
   * the share checkboxes say. This is what a recipient would see.
   */
  exportSharedJSON() {
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

    this.downloadFile(JSON.stringify(data, null, 2), `${this.exportFileBase()}-shared.json`, 'application/json');
    UI.showToast(`Shared version exported — ${data.waypoints.length} waypoints, ${data.journal.length} public notes`, 'success');
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
    const hasGeometry = Trip.getActiveRouteCoordinates(App.currentTrip).length > 0;
    this.downloadFile(gpx, `${this.exportFileBase()}.gpx`, 'application/gpx+xml');
    UI.showToast(
      hasGeometry ? 'GPX exported with route geometry' : 'GPX exported (stops only — no route calculated yet)',
      hasGeometry ? 'success' : 'info'
    );
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
   * Entry point for the menu's "Import Trip". Picks and parses the file
   * first so a cancelled dialog is silent, then hands the parsed trip to
   * App.importTrip (which replays it through the API).
   */
  async startImport() {
    if (this._importing) return;
    let trip;
    try {
      trip = await this.importFromFile();
    } catch (err) {
      if (err?.code === 'CANCELLED') return; // user backed out — say nothing
      console.error('Import read failed:', err);
      UI.showToast('Could not read that file', 'error');
      return;
    }
    this._importing = true;
    this._pendingImport = trip;
    try {
      await App.importTrip();
    } finally {
      this._pendingImport = null;
      this._importing = false;
    }
  },

  importFromFile() {
    // Already picked and parsed by startImport — hand it straight over.
    if (this._pendingImport) return Promise.resolve(this._pendingImport);
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,.gpx';
      input.style.cssText = 'position:fixed;left:-9999px;width:1px;height:1px;opacity:0';
      document.body.appendChild(input);

      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        window.removeEventListener('focus', onWindowFocus);
        input.remove();
        fn(value);
      };

      // Dismissing the OS file dialog fires no change event in most browsers.
      // 'cancel' covers modern ones; the focus fallback covers the rest, so
      // the import promise can never hang forever.
      const onWindowFocus = () => {
        setTimeout(() => {
          if (settled || input.files?.length) return;
          finish(reject, Object.assign(new Error('Import cancelled'), { code: 'CANCELLED' }));
        }, 400);
      };

      input.addEventListener('cancel', () => {
        finish(reject, Object.assign(new Error('Import cancelled'), { code: 'CANCELLED' }));
      });

      input.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) {
          finish(reject, Object.assign(new Error('Import cancelled'), { code: 'CANCELLED' }));
          return;
        }
        try {
          const content = await file.text();
          const trip = /\.gpx$/i.test(file.name)
            ? Trip.fromGPX(content, file.name.replace(/\.gpx$/i, ''))
            : this.importFromJSON(JSON.parse(content));
          finish(resolve, trip);
        } catch (err) {
          finish(reject, err);
        }
      });

      window.addEventListener('focus', onWindowFocus);
      input.click();
    });
  },

  /**
   * Import trip from JSON data. Accepts a full backup, a shareable export or
   * a raw API payload — field case is normalized here so nothing silently
   * loses privacy flags, tags or ordering on the way in.
   */
  importFromJSON(data) {
    const source = data && typeof data === 'object' ? (data.trip || data) : {};
    const trip = Trip.create(source.name || 'Imported Trip');

    if (source.description) trip.description = source.description;

    const rawWaypoints = Array.isArray(source.waypoints) ? source.waypoints : [];
    trip.waypoints = rawWaypoints
      .map((wp, idx) => ({
        id: Storage.generateId(),
        name: wp.name || `Waypoint ${idx + 1}`,
        address: wp.address || '',
        lat: Number(wp.lat ?? wp.latitude),
        lng: Number(wp.lng ?? wp.lon ?? wp.longitude),
        type: wp.type || 'stop',
        notes: wp.notes || wp.description || '',
        order: Number.isFinite(Number(wp.order ?? wp.sort_order)) ? Number(wp.order ?? wp.sort_order) : idx
      }))
      .filter(wp => Number.isFinite(wp.lat) && Number.isFinite(wp.lng))
      .sort((a, b) => a.order - b.order)
      .map((wp, idx) => ({ ...wp, order: idx, sort_order: idx }));

    const rawJournal = Array.isArray(source.journal) ? source.journal : [];
    trip.journal = rawJournal.map(entry => {
      const isPrivate = !!(entry.isPrivate ?? entry.is_private);
      let tags = entry.tags;
      if (typeof tags === 'string') {
        try { tags = JSON.parse(tags); } catch (_) { tags = tags.split(',').map(t => t.trim()).filter(Boolean); }
      }
      return {
        id: Storage.generateId(),
        title: entry.title || '',
        content: entry.content || '',
        isPrivate,
        is_private: isPrivate,
        tags: Array.isArray(tags) ? tags : [],
        location: entry.location || null,
        createdAt: entry.createdAt || entry.created_at || new Date().toISOString()
      };
    });

    if (source.route) trip.route = source.route;

    const alts = source.alternativeRoutes || source.alternative_routes || [];
    if (alts.length) {
      trip.alternativeRoutes = alts;
      trip.alternative_routes = alts;
      const saved = alts.find(r => r.saved || r.is_selected);
      const activeIndex = saved
        ? (saved.alt_idx ?? saved.route_index ?? 0)
        : (source.activeRouteIndex ?? source.active_route_index ?? 0);
      trip.activeRouteIndex = Number.isFinite(Number(activeIndex)) ? Number(activeIndex) : 0;
      trip.active_route_index = trip.activeRouteIndex;
    }

    trip.id = Storage.generateId();
    return trip;
  },
});
