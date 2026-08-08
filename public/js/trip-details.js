/**
 * Trip details modal — open, fill, save, cover picker
 * Extends App object (loaded after trip-controller.js)
 */
Object.assign(App, {
  async openTripDetails(tripId) {
    try {
      // Guests edit their local trips freely — API.trips.get resolves from
      // localStorage when signed out.
      const trip = await API.trips.get(tripId);
      if (!trip) { UI.showToast('Trip not found', 'error'); return; }
      this.tripDetailId = tripId;
      this.fillTripDetailsForm(trip);
      this._ensureAppendLegButton();
      this._ensureOfflineSection();
      const appendSection = document.getElementById('tripDetailAppendLegSection');
      if (appendSection) appendSection.classList.toggle('hidden', UI.isReadOnlyTrip());
      UI.openModal('tripDetailsModal');
      // Not awaited: the modal opens now, the offline state fills in behind it.
      this.renderOfflineSection(trip);
    } catch (err) {
      if (err?.code === 'LOGIN_REQUIRED') { UI.suggestLogin('open this trip'); return; }
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
      const url = UI.escapeAttr(UI.attachmentUrl(img));
      const isCover = img.isCover || img.is_cover || (!!img.id && currentCoverUrl.includes(img.id));
      const safeName = UI.escapeAttr(UI.attachmentName(img));
      return `<div class="cover-picker-thumb${isCover ? ' is-cover' : ''}" data-attachment-id="${UI.escapeAttr(img.id)}" data-url="${url}" title="${safeName}" role="button" tabindex="0" aria-label="Use ${safeName} as cover">
        <img src="${url}" alt="" loading="lazy" decoding="async">
        ${isCover ? '<span class="cover-badge">Cover</span>' : ''}
      </div>`;
    }).join('');

    grid.querySelectorAll('.cover-picker-thumb').forEach(thumb => {
      const choose = () => this.setCoverFromAttachment(thumb.dataset.attachmentId, thumb.dataset.url);
      thumb.addEventListener('click', choose);
      thumb.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); }
      });
    });
  },

  /**
   * Set an existing attachment as the cover image
   */
  async setCoverFromAttachment(attachmentId, url) {
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
      if (err?.code === 'LOGIN_REQUIRED') { UI.suggestLogin('manage photos'); return; }
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
      if (coverFile) {
        UI.showToast('Uploading cover image…', 'info');
        this._activeUploads++;
        try {
          const attachment = await API.attachments.upload(tripId, coverFile, { is_cover: true });
          coverImageUrl = attachment.url;
          // Clear blob preview now that we have the real URL
          if (this._coverBlobUrl) { URL.revokeObjectURL(this._coverBlobUrl); this._coverBlobUrl = null; }
          if (coverInput) { coverInput.value = coverImageUrl; this.updateCoverFocusUI(); }
        } finally {
          this._activeUploads = Math.max(0, this._activeUploads - 1);
        }
      }
      if (isPublic && (!this.useCloud || !this.currentUser)) {
        UI.suggestLogin('publish this trip'); return;
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
      if (err?.code === 'LOGIN_REQUIRED') {
        UI.suggestLogin(err.action === 'photo upload' ? 'upload a cover photo' : 'publish this trip');
        return;
      }
      console.error('Save trip details failed:', err);
      UI.showToast('Failed to save trip', 'error');
    }
  },

  /* --- Append another trip as a leg (D4) ---
   * Injected into the Trip Details modal on first open — the modal only
   * ships name/cover/sharing fields in index.html, same pattern as
   * waypoint-controller.js's _ensureWaypointDetailsExtraFields. */

  _ensureAppendLegButton() {
    if (document.getElementById('tripDetailAppendLegBtn')) return;
    const modalActions = document.querySelector('#tripDetailsModal .modal-actions');
    if (!modalActions) return;
    modalActions.insertAdjacentHTML('beforebegin', `
      <div class="form-section" id="tripDetailAppendLegSection">
        <label class="field-label">Combine trips</label>
        <button type="button" class="secondary-btn" id="tripDetailAppendLegBtn">Append another trip as a leg&hellip;</button>
        <p class="microcopy">Copy another trip's stops and shape points into this one as a new leg.</p>
      </div>
    `);
    document.getElementById('tripDetailAppendLegBtn')?.addEventListener('click', () => this.openAppendLegPicker());
  },

  _ensureAppendLegModal() {
    if (document.getElementById('appendLegModal')) return;
    const modal = document.createElement('div');
    modal.id = 'appendLegModal';
    modal.className = 'modal hidden';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'appendLegModalTitle');
    modal.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h3 id="appendLegModalTitle">Append a trip as a leg</h3>
          <button type="button" class="modal-close" data-close aria-label="Close">×</button>
        </div>
        <p class="modal-subtitle" id="appendLegModalSubtitle"></p>
        <div id="appendLegModalBody"></div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.querySelector('[data-close]')?.addEventListener('click', () => UI.closeModal('appendLegModal'));
    modal.addEventListener('click', (e) => { if (e.target === modal) UI.closeModal('appendLegModal'); });
  },

  /** Step 1: list the user's other trips (guest+cloud — API.trips.list works for both). */
  async openAppendLegPicker() {
    const destTripId = this.tripDetailId;
    if (!destTripId) return;
    this._ensureAppendLegModal();
    const bodyEl = document.getElementById('appendLegModalBody');
    const subtitleEl = document.getElementById('appendLegModalSubtitle');
    if (subtitleEl) subtitleEl.textContent = 'Loading your trips…';
    if (bodyEl) bodyEl.innerHTML = '<div class="microcopy">Loading…</div>';
    UI.openModal('appendLegModal');

    let trips = [];
    let destTrip = null;
    try {
      [trips, destTrip] = await Promise.all([API.trips.list(), API.trips.get(destTripId)]);
    } catch (err) {
      console.error('Append leg: failed to load trip list', err);
      if (subtitleEl) subtitleEl.textContent = 'Could not load your trips.';
      if (bodyEl) bodyEl.innerHTML = '<div class="microcopy">Could not load your trips. Try again.</div>';
      return;
    }

    const destName = destTrip?.name || 'this trip';
    if (subtitleEl) {
      subtitleEl.textContent = `Copy another trip's stops into "${destName}" as a new leg. Notes and stops will be copied; photos stay on the original trip.`;
    }
    const options = (Array.isArray(trips) ? trips : []).filter(t => t?.id && t.id !== destTripId);
    if (!options.length) {
      if (bodyEl) bodyEl.innerHTML = '<div class="microcopy">No other trips to append.</div>';
      return;
    }
    if (!bodyEl) return;
    bodyEl.innerHTML = options.map(t => {
      const stopCount = Number.isFinite(t.waypoint_count) ? t.waypoint_count : 0;
      return `<button type="button" class="secondary-btn append-leg-option" style="display:block;width:100%;text-align:left;margin-bottom:8px;"
          data-trip-id="${UI.escapeAttr(t.id)}" data-trip-name="${UI.escapeAttr(t.name || 'Untitled trip')}">
        ${UI.escapeHtml(t.name || 'Untitled trip')}
        <span class="microcopy">${stopCount} ${stopCount === 1 ? 'stop' : 'stops'}</span>
      </button>`;
    }).join('');
    bodyEl.querySelectorAll('.append-leg-option').forEach(btn => {
      btn.addEventListener('click', () => {
        this._confirmAppendLeg(destTripId, destName, btn.dataset.tripId, btn.dataset.tripName || 'that trip');
      });
    });
  },

  /** Step 2: explicit confirm — this is a destructive-ish write on the destination trip. */
  _confirmAppendLeg(destTripId, destName, sourceTripId, sourceName) {
    const bodyEl = document.getElementById('appendLegModalBody');
    if (!bodyEl) return;
    bodyEl.innerHTML = `
      <p>Append <strong>${UI.escapeHtml(sourceName)}</strong> to <strong>${UI.escapeHtml(destName)}</strong> as a new leg?</p>
      <p class="microcopy">Stops and shape points are copied — "${UI.escapeHtml(sourceName)}" is never changed or moved. Notes are copied too. Photos stay on the original trip.</p>
      <div class="modal-actions">
        <button type="button" class="cancel-btn" id="appendLegCancelBtn">Cancel</button>
        <button type="button" class="primary-btn" id="appendLegConfirmBtn">Append trip</button>
      </div>
    `;
    document.getElementById('appendLegCancelBtn')?.addEventListener('click', () => this.openAppendLegPicker());
    const confirmBtn = document.getElementById('appendLegConfirmBtn');
    confirmBtn?.addEventListener('click', async () => {
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Appending…';
      try {
        await this.appendTripAsLeg(destTripId, sourceTripId);
        UI.closeModal('appendLegModal');
      } catch (_) {
        // appendTripAsLeg already toasted the specific failure.
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Append trip';
      }
    });
  },

  /**
   * Copies (never moves) a source trip's real stops + shape points into the
   * destination trip as a new leg: one leg-break divider named after the
   * source, then each of its stops/vias in order. The source's own
   * leg-break dividers are flattened (skipped) — an appended multi-leg trip
   * becomes one leg in the destination, not several. Works for any
   * guest/cloud combination on either side: every write goes through the
   * normal waypoint/journal API, which has identical guest+cloud shapes.
   */
  async appendTripAsLeg(destTripId, sourceTripId) {
    let destTrip;
    let sourceTrip;
    try {
      [destTrip, sourceTrip] = await Promise.all([API.trips.get(destTripId), API.trips.get(sourceTripId)]);
    } catch (err) {
      console.error('Append leg: failed to load trips', err);
      UI.showToast('Could not load one of the trips', 'error');
      throw err;
    }

    const shell = { version: destTrip.version };
    const destWaypoints = Trip.normalizeWaypointOrder(destTrip.waypoints || []);
    // Flatten: only the source's own stops/vias travel over, never its dividers.
    const sourceWaypoints = Trip.normalizeWaypointOrder(sourceTrip.waypoints || [])
      .filter(w => !UI.isLegBreakWaypoint(w));

    // Nearest adjacent real stop for the new divider's lat/lng (never rendered
    // as a pin, never used for routing math beyond being a divider marker).
    const anchor = destWaypoints[destWaypoints.length - 1] || sourceWaypoints[0];
    if (!anchor || !Number.isFinite(Number(anchor.lat)) || !Number.isFinite(Number(anchor.lng))) {
      UI.showToast('That trip has no waypoints to copy', 'info');
      return;
    }

    let addedCount = 0;
    try {
      const dividerRes = await API.waypoints.add(destTripId, {
        name: sourceTrip.name || 'Imported leg',
        type: 'leg-break',
        lat: anchor.lat,
        lng: anchor.lng,
        order: destWaypoints.length,
        sort_order: destWaypoints.length
      }, { headers: this.getTripIfMatchHeaders(shell) });
      this.applyTripMetaFromResponse(shell, dividerRes);

      let nextOrder = destWaypoints.length + 1;
      for (const wp of sourceWaypoints) {
        if (!Number.isFinite(Number(wp.lat)) || !Number.isFinite(Number(wp.lng))) continue;
        const res = await API.waypoints.add(destTripId, {
          lat: Number(wp.lat),
          lng: Number(wp.lng),
          name: wp.name || 'Waypoint',
          type: wp.type === 'via' ? 'via' : 'stop',
          notes: wp.notes || '',
          address: wp.address || '',
          order: nextOrder,
          sort_order: nextOrder
        }, { headers: this.getTripIfMatchHeaders(shell) });
        this.applyTripMetaFromResponse(shell, res);
        nextOrder++;
        addedCount++;
      }
    } catch (err) {
      console.error('Append leg: waypoint copy failed partway through', err);
      UI.showToast(addedCount
        ? `Copied part of "${sourceTrip.name}" before an error — check the destination trip.`
        : 'Could not append that trip.', 'error');
      throw err;
    }

    // Journal entries: cheap best-effort copy, not remapped to any waypoint
    // (v1 — see FINDINGS.md). A failed entry doesn't roll back the waypoints
    // that already landed.
    let journalCopied = 0;
    for (const entry of (sourceTrip.journal || [])) {
      try {
        await API.journal.add(destTripId, {
          title: entry.title || '',
          content: entry.content || '',
          is_private: !!(entry.is_private ?? entry.isPrivate),
          tags: Array.isArray(entry.tags) ? entry.tags : []
        });
        journalCopied++;
      } catch (err) {
        console.error('Append leg: a journal entry failed to copy', err);
      }
    }

    UI.showToast(
      `Appended "${sourceTrip.name}" as a new leg (${addedCount} waypoint${addedCount === 1 ? '' : 's'}` +
      `${journalCopied ? `, ${journalCopied} note${journalCopied === 1 ? '' : 's'}` : ''})`,
      'success'
    );

    // If the destination is the trip currently open on the map, reload it —
    // this repaints the waypoints list/markers and reroutes for free
    // (loadTripData -> MapManager.updateWaypoints -> updateRoute). If it's a
    // different trip, the same recompute happens next time it's opened.
    if (this.currentTrip?.id === destTripId) {
      const fresh = this.normalizeTrip(await API.trips.get(destTripId));
      this.loadTripData(fresh);
    }
    await this.refreshTripsList();
  },

  /* --- Offline maps ---
   * Download the basemap along this trip so it still draws with no phone
   * signal. Injected into the Trip Details modal on first open, same pattern as
   * the append-leg section above. All the maths and messaging lives in
   * public/js/offline-maps.js; this is the four-state surface over it:
   * choose a detail level → live progress with cancel → downloaded → delete.
   *
   * Works signed out: a guest trip already lives in localStorage, so only its
   * tiles need downloading and nothing here is gated on login. */

  _ensureOfflineSection() {
    if (document.getElementById('tripDetailOfflineSection')) return;
    const modalActions = document.querySelector('#tripDetailsModal .modal-actions');
    if (!modalActions) return;
    modalActions.insertAdjacentHTML('beforebegin', `
      <div class="form-section" id="tripDetailOfflineSection">
        <label class="field-label">Offline maps</label>
        <div id="tripDetailOfflineBody"></div>
      </div>
    `);
    // One subscription for the life of the page. The service worker broadcasts
    // progress to every tab, so this keeps working across a reload mid-download.
    if (!this._offlineProgressBound && window.OfflineMaps) {
      this._offlineProgressBound = true;
      OfflineMaps.onProgress((job) => this._onOfflineProgress(job));
    }
  },

  _offlineBody() {
    return document.getElementById('tripDetailOfflineBody');
  },

  /** Pick the state to show: downloading, downloaded, or offering a download. */
  async renderOfflineSection(trip) {
    const body = this._offlineBody();
    if (!body) return;
    this._offlineTrip = trip;
    this._offlineEstimate = null;

    if (!window.OfflineMaps || !OfflineMaps.isSupported()) {
      body.innerHTML = '<p class="microcopy">This browser can\'t store offline maps.</p>';
      return;
    }

    body.innerHTML = '<p class="microcopy">Checking…</p>';
    let state;
    try {
      state = await OfflineMaps.statusFor(trip.id);
    } catch (err) {
      console.error('Offline maps: status check failed', err);
      if (this._offlineTrip?.id !== trip.id) return;
      body.innerHTML = '<p class="microcopy">Offline downloads aren\'t ready yet — reopen this trip in a moment.</p>';
      return;
    }
    if (this._offlineTrip?.id !== trip.id) return;

    if (state.job && state.job.state !== 'done') { this._renderOfflineProgress(state.job); return; }
    if (state.entry?.partial) { this._renderOfflinePartial(state.entry); return; }
    if (state.entry) { this._renderOfflineDone(state.entry); return; }
    this._renderOfflineChooser(trip);
  },

  /**
   * A download the browser cut short — the phone slept, or the OS reclaimed the
   * service worker. Whatever landed is real and still on disk, so say so and
   * offer the only two useful moves: clear it, or clear it and start again.
   */
  _renderOfflinePartial(entry) {
    const body = this._offlineBody();
    if (!body) return;
    body.innerHTML = `
      <p class="offline-warn">This download was interrupted, so the map along this trip is incomplete. Delete it and download again while you have coverage.</p>
      <div class="offline-actions">
        <button type="button" class="primary-btn" id="tripDetailOfflinePartialRetry">Delete and download again</button>
        <button type="button" class="secondary-btn offline-delete-btn" id="tripDetailOfflinePartialDelete">Just delete it</button>
      </div>
    `;
    const clear = async (thenChooser) => {
      try {
        await OfflineMaps.remove(entry.tripId);
        const trip = this._offlineTrip;
        if (trip && thenChooser) this._renderOfflineChooser(trip);
        else if (trip) this.renderOfflineSection(trip);
      } catch (err) {
        console.error('Offline maps: clearing a partial download failed', err);
        UI.showToast('Could not clear the incomplete download', 'error');
      }
    };
    document.getElementById('tripDetailOfflinePartialRetry')?.addEventListener('click', (e) => {
      e.currentTarget.disabled = true;
      clear(true);
    });
    document.getElementById('tripDetailOfflinePartialDelete')?.addEventListener('click', (e) => {
      e.currentTarget.disabled = true;
      clear(false);
    });
  },

  /** Step 1 — detail levels with a real size against each one. */
  _renderOfflineChooser(trip) {
    const body = this._offlineBody();
    if (!body) return;
    body.innerHTML = '<p class="microcopy">Measuring the route…</p>';

    // Walking a long route's tiles is tens of milliseconds of arithmetic —
    // yield first so the modal paints before it runs.
    setTimeout(() => {
      if (this._offlineTrip?.id !== trip.id) return;
      const target = this._offlineBody();
      if (!target) return;

      let est;
      try {
        est = OfflineMaps.estimate(trip);
      } catch (err) {
        console.error('Offline maps: estimate failed', err);
        target.innerHTML = '<p class="microcopy">Couldn\'t work out a download size for this trip.</p>';
        return;
      }
      this._offlineEstimate = est;

      if (!est.points.length) {
        target.innerHTML = '<p class="microcopy">Add some stops first — there\'s no route to download a map along yet.</p>';
        return;
      }

      // Deepest level that fits is the sensible default.
      const usable = est.presets.filter(p => !p.overCap);
      const chosen = usable.length ? usable[usable.length - 1].id : '';

      const choices = est.presets.map((p) => {
        // A preset whose count we stopped short of only knows a floor, so it
        // reads "over N"; one we counted fully states the number it reached.
        const size = p.overCap
          ? `${p.partial ? 'over ' : ''}${OfflineMaps.formatCount(p.tiles)} tiles — too large`
          : `${OfflineMaps.formatCount(p.tiles)} tiles · ${OfflineMaps.formatBytes(p.bytes)}`;
        const selected = p.id === chosen;
        return `<button type="button" class="offline-choice${selected ? ' is-selected' : ''}"
            data-preset="${UI.escapeAttr(p.id)}" role="radio" aria-checked="${selected ? 'true' : 'false'}"
            ${p.overCap ? 'disabled' : ''}>
          <span class="offline-choice-head">
            <span class="offline-choice-label">${UI.escapeHtml(p.label)}</span>
            <span class="offline-choice-size${p.overCap ? ' is-over' : ''}">${UI.escapeHtml(size)}</span>
          </span>
          <span class="offline-choice-blurb">${UI.escapeHtml(p.blurb)}</span>
        </button>`;
      }).join('');

      const overCapNote = usable.length < est.presets.length
        ? `<p class="offline-warn">Some levels are over the ${OfflineMaps.formatCount(OfflineMaps.MAX_TILES)} tile limit for one download. Split the trip into legs and download a leg at a time to get more detail.</p>`
        : '';
      const routeNote = est.hasRoute
        ? ''
        : '<p class="offline-warn">This trip has no calculated route yet, so sizes follow straight lines between stops. Open it on the map first for an accurate corridor.</p>';

      target.innerHTML = `
        ${routeNote}
        <div class="offline-choices" role="radiogroup" aria-label="Map detail level">${choices}</div>
        ${overCapNote}
        <p class="microcopy">Sizes are estimates at ${Math.round(OfflineMaps.BYTES_PER_TILE / 1024)} KB a tile, covering a corridor either side of the route so you can pan off it. Download on wi-fi where you can.</p>
        <div class="offline-actions">
          <button type="button" class="primary-btn" id="tripDetailOfflineStart" ${chosen ? '' : 'disabled'}>Download map</button>
        </div>
      `;

      target.querySelectorAll('.offline-choice').forEach((btn) => {
        btn.addEventListener('click', () => {
          target.querySelectorAll('.offline-choice').forEach((other) => {
            const isThis = other === btn;
            other.classList.toggle('is-selected', isThis);
            other.setAttribute('aria-checked', isThis ? 'true' : 'false');
          });
        });
      });

      document.getElementById('tripDetailOfflineStart')?.addEventListener('click', () => {
        const selected = target.querySelector('.offline-choice.is-selected');
        if (selected) this._startOfflineDownload(trip, selected.dataset.preset);
      });
    }, 0);
  },

  /**
   * Step 2 — kick it off. The promise settles when the last tile lands, which
   * is minutes away; the bar in between is driven by service worker broadcasts.
   */
  async _startOfflineDownload(trip, presetId) {
    const startBtn = document.getElementById('tripDetailOfflineStart');
    if (startBtn) { startBtn.disabled = true; startBtn.textContent = 'Starting…'; }

    try {
      const entry = await OfflineMaps.download(trip, presetId, this._offlineEstimate);
      if (this._offlineTrip?.id === trip.id) this._renderOfflineDone(entry);
      const failedNote = entry?.failed ? `, ${entry.failed} tile${entry.failed === 1 ? '' : 's'} missed` : '';
      UI.showToast(`Map downloaded for offline use (${OfflineMaps.formatBytes(entry?.bytes || 0)}${failedNote})`, 'success');
    } catch (err) {
      if (err?.code === 'CANCELLED') {
        UI.showToast('Download cancelled — no space used', 'info');
      } else {
        console.error('Offline maps: download failed', err);
        UI.showToast(err?.message || 'The map download failed', 'error');
      }
      if (this._offlineTrip?.id === trip.id) this._renderOfflineChooser(trip);
    }
  },

  /** Step 3 — honest progress: tiles done of tiles total, and a real bar. */
  _renderOfflineProgress(job) {
    const body = this._offlineBody();
    if (!body) return;
    body.innerHTML = `
      <div class="offline-progress" id="tripDetailOfflineProgress">
        <div class="offline-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100"
             aria-valuenow="0" aria-label="Offline map download" id="tripDetailOfflineTrack">
          <div class="offline-progress-fill" id="tripDetailOfflineFill"></div>
        </div>
        <p class="offline-progress-meta" id="tripDetailOfflineMeta" role="status" aria-live="polite"></p>
        <p class="microcopy">The download keeps going if you switch apps, but closing Ride may stop it. Anything already saved stays saved.</p>
        <div class="offline-actions">
          <button type="button" class="cancel-btn" id="tripDetailOfflineCancel">Cancel download</button>
        </div>
      </div>
    `;
    document.getElementById('tripDetailOfflineCancel')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = 'Cancelling…';
      let stopped = false;
      try { stopped = await OfflineMaps.cancel(job.tripId); } catch (_) { /* fall through */ }
      // No live job to stop means it finished, or the browser shut the worker
      // down mid-download. Either way the manifest is the truth, so re-read it
      // rather than leaving a dead progress bar on screen.
      if (!stopped && this._offlineTrip) this.renderOfflineSection(this._offlineTrip);
    });
    this._updateOfflineProgress(job);
  },

  _updateOfflineProgress(job) {
    const fill = document.getElementById('tripDetailOfflineFill');
    const track = document.getElementById('tripDetailOfflineTrack');
    const meta = document.getElementById('tripDetailOfflineMeta');
    if (!fill || !meta) return;
    const pct = job.total ? Math.min(100, Math.round((job.done / job.total) * 100)) : 0;
    fill.style.width = `${pct}%`;
    if (track) track.setAttribute('aria-valuenow', String(pct));
    const failed = job.failed ? ` · ${OfflineMaps.formatCount(job.failed)} missed` : '';
    const label = job.state === 'cancelling' ? 'Cancelling… ' : '';
    meta.textContent = `${label}${pct}% — ${OfflineMaps.formatCount(job.done)} of ${OfflineMaps.formatCount(job.total)} tiles · ${OfflineMaps.formatBytes(job.bytes)}${failed}`;
  },

  /** Step 4 — downloaded. Says what it cost and offers the space back. */
  _renderOfflineDone(entry) {
    const body = this._offlineBody();
    if (!body) return;
    const when = entry?.updatedAt ? new Date(entry.updatedAt) : null;
    const dateText = when && !isNaN(when) ? when.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    const parts = [
      entry?.detail || 'Downloaded',
      `${OfflineMaps.formatCount(entry?.tiles || 0)} tiles`,
      `${OfflineMaps.formatBytes(entry?.bytes || 0)} on disk`
    ];
    if (dateText) parts.push(dateText);
    if (entry?.failed) parts.push(`${OfflineMaps.formatCount(entry.failed)} tiles missed`);

    const dataNote = OfflineMaps.isGuest()
      ? 'This trip is stored on your device already, so only the map needed downloading.'
      : (entry?.dataPinned
        ? 'The trip itself is saved too, so it opens with no signal at all.'
        : 'The map is saved, but the trip data couldn\'t be saved with it — open this trip once while online before you set off.');

    body.innerHTML = `
      <div class="offline-status">
        <span class="offline-status-dot" aria-hidden="true"></span>
        <div class="offline-status-text">
          <strong>Downloaded for offline use</strong>
          <span class="microcopy">${UI.escapeHtml(parts.join(' · '))}</span>
        </div>
      </div>
      <p class="microcopy">${UI.escapeHtml(dataNote)}</p>
      <div class="offline-actions">
        <button type="button" class="secondary-btn" id="tripDetailOfflineChange">Change detail level</button>
        <button type="button" class="secondary-btn offline-delete-btn" id="tripDetailOfflineDelete">Delete download</button>
      </div>
    `;
    document.getElementById('tripDetailOfflineChange')?.addEventListener('click', () => this._confirmOfflineDelete(entry, true));
    document.getElementById('tripDetailOfflineDelete')?.addEventListener('click', () => this._confirmOfflineDelete(entry, false));
  },

  /**
   * Deleting is cheap to undo on wi-fi and expensive to undo in the desert, so
   * it gets an explicit confirm. Changing detail level goes through here too —
   * there is no in-place upgrade, the old tiles have to go first.
   */
  _confirmOfflineDelete(entry, thenChooser) {
    const body = this._offlineBody();
    if (!body) return;
    body.innerHTML = `
      <p>${thenChooser ? 'Changing detail level deletes' : 'Delete'} the ${UI.escapeHtml(OfflineMaps.formatBytes(entry?.bytes || 0))} map saved for this trip?</p>
      <p class="microcopy">You'll need coverage to download it again.</p>
      <div class="offline-actions">
        <button type="button" class="cancel-btn" id="tripDetailOfflineDeleteCancel">Keep it</button>
        <button type="button" class="primary-btn" id="tripDetailOfflineDeleteConfirm">${thenChooser ? 'Delete and choose again' : 'Delete download'}</button>
      </div>
    `;
    document.getElementById('tripDetailOfflineDeleteCancel')?.addEventListener('click', () => this._renderOfflineDone(entry));
    const confirmBtn = document.getElementById('tripDetailOfflineDeleteConfirm');
    confirmBtn?.addEventListener('click', async () => {
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Deleting…';
      try {
        await OfflineMaps.remove(entry.tripId);
        UI.showToast('Offline map deleted', 'success');
        const trip = this._offlineTrip;
        if (trip && thenChooser) this._renderOfflineChooser(trip);
        else if (trip) this.renderOfflineSection(trip);
      } catch (err) {
        console.error('Offline maps: delete failed', err);
        UI.showToast('Could not delete the offline map', 'error');
        this._renderOfflineDone(entry);
      }
    });
  },

  /** Service worker progress broadcast — only paint if this trip is on screen. */
  _onOfflineProgress(job) {
    if (!job || !this._offlineTrip || String(this._offlineTrip.id) !== job.tripId) return;
    if (job.state === 'running' || job.state === 'cancelling') {
      if (document.getElementById('tripDetailOfflineProgress')) this._updateOfflineProgress(job);
      else this._renderOfflineProgress(job);
      return;
    }
    // 'done', 'cancelled' or 'error' — re-read the manifest and show the truth.
    this.renderOfflineSection(this._offlineTrip);
  },
});
