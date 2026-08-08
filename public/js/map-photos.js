/**
 * Map photos module — renders journal photos on the planning map. Extends
 * MapManager (loaded after map.js).
 *
 * Contract:
 *   MapManager.drawJournalPhotos(journalEntries) — draw photo markers for
 *     entries that carry at least one image attachment and a position: either
 *     the entry's structured `location` {lat, lng}, or the waypoint the entry
 *     is attached to. Tapping a marker opens a popup; tapping the photo opens
 *     the full-screen lightbox (UI.openLightbox).
 *   MapManager.clearJournalPhotos() — remove all photo markers.
 */
Object.assign(MapManager, {
  _photoMarkers: [],

  /** Position for an entry: explicit location wins, else its waypoint. */
  _photoEntryLatLng(entry) {
    const loc = entry?.location;
    const lat = Number(loc?.lat);
    const lng = Number(loc?.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };

    const waypointId = entry?.waypointId ?? entry?.waypoint_id;
    if (!waypointId) return null;
    const waypoints = (typeof App !== 'undefined' && App.currentTrip?.waypoints) || [];
    const wp = waypoints.find(w => w.id === waypointId);
    const wlat = Number(wp?.lat);
    const wlng = Number(wp?.lng);
    if (Number.isFinite(wlat) && Number.isFinite(wlng)) return { lat: wlat, lng: wlng };
    return null;
  },

  _photoAttachments(entry) {
    return (entry?.attachments || []).filter((a) => {
      if (typeof UI !== 'undefined' && typeof UI.isImageAttachment === 'function') {
        return UI.isImageAttachment(a);
      }
      const mime = a?.mimeType || a?.mime_type || '';
      return String(mime).startsWith('image/');
    });
  },

  drawJournalPhotos(entries) {
    this.clearJournalPhotos();
    if (!Array.isArray(entries) || !this.map) return;

    entries.forEach((entry) => {
      const pos = this._photoEntryLatLng(entry);
      if (!pos) return;
      const photos = this._photoAttachments(entry);
      if (!photos.length) return;

      const marker = L.marker([pos.lat, pos.lng], {
        icon: L.divIcon({
          className: 'photo-marker',
          html: '<div class="photo-marker-inner" aria-hidden="true">' +
                '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 15.2a3.2 3.2 0 100-6.4 3.2 3.2 0 000 6.4zM9 3L7.17 5H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V7a2 2 0 00-2-2h-3.17L15 3H9z"/></svg>' +
                '</div>',
          iconSize: [30, 30],
          iconAnchor: [15, 15],
          popupAnchor: [0, -18]
        }),
        title: entry.title || 'Trip photo',
        keyboard: true,
        alt: entry.title || 'Trip photo'
      }).addTo(this.map);

      const first = photos[0];
      const url = (typeof UI !== 'undefined' && UI.attachmentUrl)
        ? UI.attachmentUrl(first)
        : (first.url || `/api/attachments/${first.id}`);

      // Built with DOM APIs — user text never reaches an HTML parser.
      const wrap = document.createElement('div');
      wrap.className = 'photo-popup';

      const title = document.createElement('strong');
      title.textContent = entry.title || 'Photo';
      wrap.appendChild(title);

      const img = document.createElement('img');
      img.src = url;
      img.alt = entry.title || 'Trip photo';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.dataset.lightboxSrc = url;
      img.dataset.lightboxAlt = entry.title || 'Trip photo';
      img.setAttribute('role', 'button');
      img.setAttribute('aria-label', 'View photo full size');
      img.style.cssText = 'width:180px;max-height:140px;object-fit:cover;border-radius:8px;display:block;margin-top:6px;cursor:zoom-in;';
      wrap.appendChild(img);

      if (photos.length > 1) {
        const more = document.createElement('div');
        more.textContent = `+${photos.length - 1} more photo${photos.length > 2 ? 's' : ''}`;
        more.style.cssText = 'margin-top:6px;font-size:0.75rem;opacity:0.75;';
        wrap.appendChild(more);
      }

      if (entry.content) {
        const note = document.createElement('div');
        note.textContent = entry.content;
        note.style.cssText = 'margin-top:6px;font-size:0.8rem;white-space:pre-wrap;max-width:180px;';
        wrap.appendChild(note);
      }

      marker.bindPopup(wrap, { minWidth: 180 });
      this._photoMarkers.push(marker);
    });
  },

  clearJournalPhotos() {
    (this._photoMarkers || []).forEach((m) => {
      try { this.map.removeLayer(m); } catch (_) { /* already detached */ }
    });
    this._photoMarkers = [];
  }
});
