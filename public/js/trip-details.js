/**
 * Trip details modal — open, fill, save, cover picker
 * Extends App object (loaded after trip-controller.js)
 */
Object.assign(App, {
  async openTripDetails(tripId) {
    try {
      if (!this.useCloud || !this.currentUser) {
        UI.showToast('Login to view trip details.', 'error');
        return;
      }
      const trip = await API.trips.get(tripId);
      if (!trip) { UI.showToast('Trip not found', 'error'); return; }
      this.tripDetailId = tripId;
      this.fillTripDetailsForm(trip);
      UI.openModal('tripDetailsModal');
    } catch (err) {
      console.error('Open trip details failed:', err);
      UI.showToast('Failed to load trip details', 'error');
    }
  },

  fillTripDetailsForm(trip) {
    // Clear any stale blob preview from previous file pick
    if (this._coverBlobUrl) { URL.revokeObjectURL(this._coverBlobUrl); this._coverBlobUrl = null; }
    document.getElementById('tripDetailName').value = trip.name || '';
    document.getElementById('tripDetailDescription').value = trip.description || '';
    const coverInput = document.getElementById('tripDetailCover');
    if (coverInput) coverInput.value = trip.coverImageUrl || trip.cover_image_url || '';
    const focusXInput = document.getElementById('tripDetailCoverFocusX');
    const focusYInput = document.getElementById('tripDetailCoverFocusY');
    if (focusXInput) focusXInput.value = Number.isFinite(trip.coverFocusX) ? trip.coverFocusX : (Number.isFinite(trip.cover_focus_x) ? trip.cover_focus_x : 50);
    if (focusYInput) focusYInput.value = Number.isFinite(trip.coverFocusY) ? trip.coverFocusY : (Number.isFinite(trip.cover_focus_y) ? trip.cover_focus_y : 50);
    const coverFileName = document.getElementById('tripDetailCoverFileName');
    if (coverFileName) coverFileName.textContent = '';
    const coverFileInput = document.getElementById('tripDetailCoverFile');
    if (coverFileInput) coverFileInput.value = '';
    document.getElementById('tripDetailPublic').checked = !!(trip.isPublic ?? trip.is_public);
    const linkInput = document.getElementById('tripDetailLink');
    const link = trip.shortUrl || trip.short_url || ((trip.shortCode || trip.short_code) ? `${window.location.origin}/${trip.shortCode || trip.short_code}` : '');
    linkInput.value = link || '';
    document.getElementById('tripDetailsModal').dataset.tripId = trip.id;
    this.populateCoverPicker(trip);
    this.updateCoverFocusUI();
  },

  /**
   * Populate the cover image picker with thumbnails of existing trip images
   */
  populateCoverPicker(trip) {
    const row = document.getElementById('coverPickerRow');
    const grid = document.getElementById('coverPickerGrid');
    if (!row || !grid) return;

    const images = (trip.attachments || []).filter(a => {
      const mime = a.mimeType || a.mime_type || '';
      return mime.startsWith('image/');
    });

    if (!images.length) {
      row.style.display = 'none';
      grid.innerHTML = '';
      return;
    }

    row.style.display = '';
    const currentCoverUrl = trip.coverImageUrl || trip.cover_image_url || '';

    grid.innerHTML = images.map(img => {
      const url = img.url || `/api/attachments/${img.id}`;
      const isCover = img.isCover || img.is_cover || currentCoverUrl.includes(img.id);
      const safeName = (img.originalName || img.original_name || 'Photo').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      return `<div class="cover-picker-thumb${isCover ? ' is-cover' : ''}" data-attachment-id="${img.id}" data-url="${url}" title="${safeName}">
        <img src="${url}" alt="" loading="lazy">
        ${isCover ? '<span class="cover-badge">Cover</span>' : ''}
      </div>`;
    }).join('');

    grid.querySelectorAll('.cover-picker-thumb').forEach(thumb => {
      thumb.addEventListener('click', () => this.setCoverFromAttachment(thumb.dataset.attachmentId, thumb.dataset.url));
    });
  },

  /**
   * Set an existing attachment as the cover image
   */
  async setCoverFromAttachment(attachmentId, url) {
    if (!this.useCloud || !this.currentUser) {
      UI.showToast('Sign in to change the cover', 'error');
      return;
    }
    try {
      await API.attachments.update(attachmentId, { is_cover: true });
      // Update the cover URL input and preview
      const coverInput = document.getElementById('tripDetailCover');
      if (coverInput) coverInput.value = url;
      // Clear any file pick
      if (this._coverBlobUrl) { URL.revokeObjectURL(this._coverBlobUrl); this._coverBlobUrl = null; }
      const coverFileInput = document.getElementById('tripDetailCoverFile');
      if (coverFileInput) coverFileInput.value = '';
      const coverFileName = document.getElementById('tripDetailCoverFileName');
      if (coverFileName) coverFileName.textContent = '';
      // Update highlight in the picker grid
      document.querySelectorAll('.cover-picker-thumb').forEach(t => {
        const isSelected = t.dataset.attachmentId === attachmentId;
        t.classList.toggle('is-cover', isSelected);
        const badge = t.querySelector('.cover-badge');
        if (isSelected && !badge) {
          t.insertAdjacentHTML('beforeend', '<span class="cover-badge">Cover</span>');
        } else if (!isSelected && badge) {
          badge.remove();
        }
      });
      this.updateCoverFocusUI();
      UI.showToast('Cover image updated', 'success');
    } catch (err) {
      console.error('Set cover from attachment failed:', err);
      UI.showToast('Failed to set cover image', 'error');
    }
  },

  async saveTripDetails() {
    const name = document.getElementById('tripDetailName').value.trim();
    const description = document.getElementById('tripDetailDescription').value.trim();
    const coverInput = document.getElementById('tripDetailCover');
    const coverFileInput = document.getElementById('tripDetailCoverFile');
    const coverFile = coverFileInput?.files?.[0];
    let coverImageUrl = coverInput?.value?.trim() || '';
    const focusXRaw = Number(document.getElementById('tripDetailCoverFocusX')?.value);
    const focusYRaw = Number(document.getElementById('tripDetailCoverFocusY')?.value);
    const coverFocusX = Number.isFinite(focusXRaw) ? focusXRaw : 50;
    const coverFocusY = Number.isFinite(focusYRaw) ? focusYRaw : 50;
    const isPublic = document.getElementById('tripDetailPublic').checked;
    const tripId = this.tripDetailId;
    if (!tripId) { UI.showToast('No trip selected', 'error'); return; }
    if (!name) { UI.showToast('Name is required', 'error'); return; }

    try {
      if (coverFile && (!this.useCloud || !this.currentUser)) {
        UI.showToast('Sign in to upload a cover image', 'error'); return;
      }
      if (coverFile) {
        UI.showToast('Uploading cover image...', 'info');
        const attachment = await API.attachments.upload(tripId, coverFile, { is_cover: true });
        coverImageUrl = attachment.url;
        // Clear blob preview now that we have the real URL
        if (this._coverBlobUrl) { URL.revokeObjectURL(this._coverBlobUrl); this._coverBlobUrl = null; }
        if (coverInput) { coverInput.value = coverImageUrl; this.updateCoverFocusUI(); }
      }
      if (!this.useCloud || !this.currentUser) {
        UI.showToast('Login to update trips.', 'error'); return;
      }
      await API.trips.update(tripId, { name, description, is_public: isPublic, cover_image_url: coverImageUrl || null, cover_focus_x: coverFocusX, cover_focus_y: coverFocusY });
      let updatedTrip;
      if (isPublic) {
        const share = await API.trips.share(tripId);
        updatedTrip = await API.trips.get(tripId);
        updatedTrip.shortUrl = share.shareUrl;
        updatedTrip.short_url = share.shareUrl;
        updatedTrip.shortCode = share.shortCode;
        updatedTrip.short_code = share.shortCode;
      } else {
        updatedTrip = await API.trips.get(tripId);
      }
      updatedTrip = this.normalizeTrip(updatedTrip);
      updatedTrip.coverFocusX = coverFocusX;
      updatedTrip.cover_focus_x = coverFocusX;
      updatedTrip.coverFocusY = coverFocusY;
      updatedTrip.cover_focus_y = coverFocusY;
      if (this.currentTrip?.id === updatedTrip.id) {
        this.currentTrip = { ...this.currentTrip, ...updatedTrip };
        this.loadTripData(this.currentTrip);
      }
      this.refreshTripsList();
      this.fillTripDetailsForm(updatedTrip);
      if (coverFileInput) {
        coverFileInput.value = '';
        const fn = document.getElementById('tripDetailCoverFileName');
        if (fn) fn.textContent = '';
      }
      UI.showToast('Trip updated', 'success');
      UI.closeModal('tripDetailsModal');
    } catch (err) {
      console.error('Save trip details failed:', err);
      UI.showToast('Failed to save trip', 'error');
    }
  },
});
