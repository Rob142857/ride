/**
 * Export/Import module — JSON/GPX export & file import
 * Extends Share object defined in share.js
 */
Object.assign(Share, {
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

    const data = Trip.getShareableData(App.currentTrip, {
      includeWaypoints,
      includeRoute,
      includePublicNotes: includeNotes
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
    // Handle both full trip export and shareable export
    const trip = Trip.create(data.name || 'Imported Trip');

    if (data.description) trip.description = data.description;
    if (data.waypoints) trip.waypoints = data.waypoints;
    if (data.route) trip.route = data.route;
    if (data.journal) trip.journal = data.journal;

    // Generate new IDs to avoid conflicts
    trip.id = Storage.generateId();
    trip.waypoints.forEach(wp => wp.id = Storage.generateId());
    trip.journal.forEach(entry => entry.id = Storage.generateId());

    return trip;
  },
});
