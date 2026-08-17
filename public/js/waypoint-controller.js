/**
 * Waypoint Controller — add, move, delete, reorder waypoints
 * Extends App object (loaded after app-core.js)
 */
Object.assign(App, {
  bindWaypointDetails() {
    this._ensureWaypointDetailsExtraFields();
    const form = document.getElementById('waypointDetailsForm');
    const fileInput = document.getElementById('waypointAttachmentFile');
    const fileBtn = document.getElementById('waypointAttachmentBtn');
    const fileName = document.getElementById('waypointAttachmentFileName');
    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = document.getElementById('waypointDetailId')?.value || '';
        const name = document.getElementById('waypointDetailName')?.value?.trim() || '';
        const notes = document.getElementById('waypointDetailNotes')?.value?.trim() || '';
        const type = document.getElementById('waypointDetailType')?.value || 'stop';
        const address = document.getElementById('waypointDetailAddress')?.value?.trim() || '';
        if (!id) return;
        await this.updateWaypointDetails(id, { name, notes, type, address });
      });
    }
    if (fileBtn && fileInput) {
      fileBtn.addEventListener('click', () => {
        const id = document.getElementById('waypointDetailId')?.value || '';
        if (!id) { UI.showToast('Open a waypoint first', 'info'); return; }
        fileInput.value = '';
        fileInput.dataset.waypointId = id;
        if (fileName) fileName.textContent = '';
        fileInput.click();
      });
    }
    if (fileInput) {
      fileInput.addEventListener('change', async () => {
        const waypointId = fileInput.dataset.waypointId;
        const file = fileInput.files?.[0];
        if (fileName) fileName.textContent = file ? file.name : '';
        if (!file || !waypointId) return;
        await this.uploadWaypointAttachment(waypointId, file);
      });
    }
    // Undo / redo waypoint changes
    const undoBtn = document.getElementById('undoWaypointBtn');
    const redoBtn = document.getElementById('redoWaypointBtn');
    if (undoBtn) undoBtn.addEventListener('click', () => this.undoWaypointChange());
    if (redoBtn) redoBtn.addEventListener('click', () => this.redoWaypointChange());
  },

  openWaypointDetails(waypointId) {
    if (!this.currentTrip) return;
    const wp = (this.currentTrip.waypoints || []).find(w => w.id === waypointId);
    if (!wp) return;
    // Leg dividers are renamed inline in the list (click the title) — this
    // modal has no leg-break option in its Type select.
    if (wp.type === 'leg-break') return;
    this._ensureWaypointDetailsExtraFields();
    const idEl = document.getElementById('waypointDetailId');
    const nameEl = document.getElementById('waypointDetailName');
    const notesEl = document.getElementById('waypointDetailNotes');
    const typeEl = document.getElementById('waypointDetailType');
    const addressEl = document.getElementById('waypointDetailAddress');
    if (idEl) idEl.value = wp.id;
    if (nameEl) nameEl.value = wp.name || '';
    if (notesEl) notesEl.value = wp.notes || '';
    if (typeEl) typeEl.value = wp.type && wp.type !== 'via' && wp.type !== 'leg-break' ? wp.type : 'stop';
    if (addressEl) addressEl.value = wp.address || '';
    // Fuel stop is meaningful only on real stops (never via/leg-break — the
    // latter can't reach this modal anyway, see the early return above) and
    // only while the fuel range planner is switched on in Settings.
    const fuelStopRow = document.getElementById('waypointDetailFuelStopRow');
    const fuelStopEl = document.getElementById('waypointDetailFuelStop');
    const fuelPlanningEnabled = !!(Storage.load(Storage.KEYS.SETTINGS, {}) || {}).fuelPlanningEnabled;
    const showFuelStop = fuelPlanningEnabled && wp.type !== 'via' && wp.type !== 'leg-break';
    if (fuelStopRow) fuelStopRow.style.display = showFuelStop ? '' : 'none';
    if (fuelStopEl) fuelStopEl.checked = !!wp.fuelStop;
    this.setWaypointDetailsReadOnly(UI.isReadOnlyTrip());
    this.renderWaypointAttachments(wp.id);
    UI.openModal('waypointDetailsModal');
  },

  /**
   * The details modal only ships Title/Notes in index.html; Type and Address
   * are injected once here so a mis-typed waypoint (wrong map icon forever)
   * or a placeholder address can actually be corrected after creation.
   */
  _ensureWaypointDetailsExtraFields() {
    if (document.getElementById('waypointDetailType')) return;
    const nameInput = document.getElementById('waypointDetailName');
    if (!nameInput) return;
    nameInput.insertAdjacentHTML('afterend', `
      <label class="field-label" for="waypointDetailAddress">Address</label>
      <input type="text" id="waypointDetailAddress" placeholder="Address (optional)">
      <label class="field-label" for="waypointDetailType">Type</label>
      <select id="waypointDetailType">
        <option value="stop">Regular Stop</option>
        <option value="scenic">Scenic Point</option>
        <option value="fuel">Fuel/Rest</option>
        <option value="food">Food/Drinks</option>
        <option value="lodging">Lodging</option>
        <option value="custom">Custom</option>
      </select>
      <div class="form-section" id="waypointDetailFuelStopRow" style="display:none">
        <label class="toggle-switch">
          <input type="checkbox" id="waypointDetailFuelStop">
          <span class="toggle-track"></span>
          <span class="toggle-label-text">Fuel stop — tank is refilled here</span>
        </label>
      </div>
    `);
    // Live toggle, not part of the form submit: persists immediately so the
    // fuel planner (and anyone else listening for ride:fuelStopsChanged)
    // reacts right away, the same way leg renames commit on blur rather
    // than waiting for a save button.
    const fuelStopEl = document.getElementById('waypointDetailFuelStop');
    if (fuelStopEl) {
      fuelStopEl.addEventListener('change', () => {
        const id = document.getElementById('waypointDetailId')?.value || '';
        if (!id) return;
        this.toggleWaypointFuelStop(id, fuelStopEl.checked);
      });
    }
  },

  /**
   * Shared-link viewers can read a waypoint's notes; they just can't change
   * anything. Reading should never raise a "sign in to edit" wall.
   */
  setWaypointDetailsReadOnly(readOnly) {
    const modal = document.getElementById('waypointDetailsModal');
    if (!modal) return;
    modal.classList.toggle('is-readonly', !!readOnly);
    ['waypointDetailName', 'waypointDetailNotes', 'waypointDetailAddress'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.readOnly = !!readOnly;
    });
    const typeEl = document.getElementById('waypointDetailType');
    if (typeEl) typeEl.disabled = !!readOnly;
    const fuelStopEl = document.getElementById('waypointDetailFuelStop');
    if (fuelStopEl) fuelStopEl.disabled = !!readOnly;
    const hide = (el, hidden) => { if (el) el.classList.toggle('hidden', !!hidden); };
    hide(document.getElementById('waypointAttachmentBtn')?.closest('.field-row'), readOnly);
    hide(modal.querySelector('.modal-actions .primary-btn'), readOnly);
    const cancel = modal.querySelector('.modal-actions .cancel-btn');
    if (cancel) cancel.textContent = readOnly ? 'Close' : 'Cancel';
  },

  renderWaypointAttachments(waypointId) {
    const listEl = document.getElementById('waypointAttachmentList');
    if (!listEl) return;
    const all = Array.isArray(this.currentTrip?.attachments) ? this.currentTrip.attachments : [];
    const attachments = all.filter(a => a && (a.waypointId === waypointId || a.waypoint_id === waypointId));
    if (!attachments.length) {
      listEl.innerHTML = '<div class="microcopy">No photos yet.</div>';
      return;
    }
    listEl.innerHTML = UI.renderAttachmentsHtml(attachments, {});
    UI.bindAttachmentRemovals(listEl, (attachmentId) => {
      if (attachmentId) this.deleteAttachment(attachmentId);
    });
  },

  async updateWaypointDetails(waypointId, data) {
    if (!this.currentTrip) return;
    if (!this.ensureEditable('update waypoints')) return;
    const payload = { name: data.name, notes: data.notes };
    if (data.type !== undefined) payload.type = data.type;
    if (data.address !== undefined) payload.address = data.address;
    try {
      const res = await API.waypoints.update(this.currentTrip.id, waypointId, payload, { headers: this.getTripIfMatchHeaders() });
      this.applyTripMetaFromResponse(this.currentTrip, res);
      if (res?.waypoint) {
        Trip.updateWaypoint(this.currentTrip, waypointId, res.waypoint);
        this.currentTrip.waypoints = Trip.normalizeWaypointOrder(this.currentTrip.waypoints);
      } else {
        Trip.updateWaypoint(this.currentTrip, waypointId, payload);
      }
      this.markTripWritten(this.currentTrip.id);
      UI.renderWaypoints(this.currentTrip.waypoints);
      MapManager.updateWaypoints(this.currentTrip.waypoints);
      UI.showToast('Waypoint saved', 'success');
      // Every other form in the app closes on save — this one used to sit
      // there looking unsaved, which produced duplicate PUTs.
      UI.closeModal('waypointDetailsModal');
      await this.refreshTripsList();
    } catch (error) {
      console.error('Failed to update waypoint details:', error);
      if (error.status === 409 || error.status === 428) { await this.handleTripConflict(error); return; }
      UI.showToast('Waypoint update failed. Not saved.', 'error');
    }
  },

  /**
   * Fuel stop is a live toggle (see _ensureWaypointDetailsExtraFields), not
   * part of the Title/Notes/Type/Address form submit: it persists the
   * moment the rider flips it, then tells the fuel planner / map overlay
   * to recompute via ride:fuelStopsChanged.
   */
  async toggleWaypointFuelStop(waypointId, fuelStop) {
    const revert = () => {
      const cb = document.getElementById('waypointDetailFuelStop');
      if (cb) cb.checked = !fuelStop;
    };
    if (!this.currentTrip) { revert(); return; }
    if (!this.ensureEditable('update waypoints')) { revert(); return; }
    try {
      const res = await API.waypoints.update(this.currentTrip.id, waypointId, { fuelStop: !!fuelStop }, { headers: this.getTripIfMatchHeaders() });
      this.applyTripMetaFromResponse(this.currentTrip, res);
      // Keep BOTH shapes in step: API._normalizeWaypoint derives fuelStop from
      // the raw fuel_stop column, so writing only the camelCase field here
      // would be silently undone the next time this trip is re-normalized.
      if (res?.waypoint) Trip.updateWaypoint(this.currentTrip, waypointId, res.waypoint);
      else Trip.updateWaypoint(this.currentTrip, waypointId, { fuelStop: !!fuelStop, fuel_stop: fuelStop ? 1 : 0 });
      this.markTripWritten(this.currentTrip.id);
      UI.renderWaypoints(this.currentTrip.waypoints);
      window.dispatchEvent(new CustomEvent('ride:fuelStopsChanged', { detail: { waypointId, fuelStop: !!fuelStop } }));
      await this.refreshTripsList();
    } catch (error) {
      console.error('Failed to update fuel stop flag:', error);
      if (error.status === 409 || error.status === 428) { await this.handleTripConflict(error); return; }
      revert();
      UI.showToast('Could not update fuel stop. Not saved.', 'error');
    }
  },

  async uploadWaypointAttachment(waypointId, file) {
    if (!this.currentTrip || !this.ensureEditable('upload attachments')) return;
    const tripId = this.currentTrip.id;
    this._activeUploads++;
    try {
      UI.showToast('Uploading photo…', 'info');
      const attachment = await API.attachments.upload(tripId, file, {
        waypoint_id: waypointId, is_private: false, headers: this.getTripIfMatchHeaders()
      });
      // The user may have switched trips while the upload was in flight.
      if (this.currentTrip?.id !== tripId) {
        UI.showToast('Photo uploaded to the previous trip', 'info');
        return;
      }
      if (!this.currentTrip.attachments) this.currentTrip.attachments = [];
      if (!this.currentTrip.attachments.some(a => a.id === attachment.id)) {
        this.currentTrip.attachments.unshift(attachment);
      }
      UI.showToast('Photo added', 'success');
      this.renderWaypointAttachments(waypointId);
    } catch (err) {
      if (err?.code === 'LOGIN_REQUIRED') { UI.suggestLogin('upload photos'); return; }
      console.error('Waypoint attachment upload failed', err);
      if (err.status === 409 || err.status === 428) { await this.handleTripConflict(err); return; }
      UI.showToast('Photo upload failed', 'error');
    } finally {
      this._activeUploads = Math.max(0, this._activeUploads - 1);
    }
   },

   /**
    * Insert a waypoint at a location chosen from the route line (midpoint drag or
    * click-to-insert). Places the new waypoint immediately after the anchor
    * segment so the route reshapes in a predictable way. This keeps route editing
    * as one undoable action.
    */
   async addWaypointOnRoute({ lat, lng, insertAfterWaypointId }) {
     if (!this.currentTrip || !this.ensureEditable('edit route')) return null;
     this._pushWaypointHistory();

     const ordered = (this.currentTrip.waypoints || []).slice().sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
     let insertIndex = ordered.length;
     if (insertAfterWaypointId) {
       const idx = ordered.findIndex(w => w.id === insertAfterWaypointId);
       if (idx >= 0) insertIndex = idx +1;
     }

     // Shaping points are 'via' — they bend the route but are not stops, so
     // they stay out of stop counts, arrival toasts and share pages.
     const payload = {
       lat,
       lng,
       name: 'Shape point',
       type: 'via',
       order: insertIndex,
       sort_order: insertIndex
     };

     let serverWaypoint = null;
     try {
       const res = await API.waypoints.add(this.currentTrip.id, payload, { headers: this.getTripIfMatchHeaders() });
       this.applyTripMetaFromResponse(this.currentTrip, res);
       serverWaypoint = res?.waypoint;
     } catch (error) {
       console.error('Failed to insert waypoint on route:', error);
       if (error.status ===409 || error.status === 428) {
         await this.handleTripConflict(error);
       } else {
         UI.showToast('Could not insert route waypoint (not saved)', 'error');
       }
       return null;
     }

     if (!serverWaypoint) {
       UI.showToast('Could not insert route waypoint (no response)', 'error');
       return null;
     }

     // Build target order: existing waypoints with the new one placed
     // immediately after its anchor segment.
     const targetIds = [...ordered.map(w => w.id)];
     targetIds.splice(insertIndex,0, serverWaypoint.id);

     this.currentTrip.waypoints.push(serverWaypoint);
     this.currentTrip.waypoints = Trip.normalizeWaypointOrder(this.currentTrip.waypoints);

     // If server didn't honour the requested position, explicitly reorder.
     const currentIds = (this.currentTrip.waypoints || []).map(w => w.id);
     let reordered = false;
     if (JSON.stringify(currentIds) !== JSON.stringify(targetIds)) {
       try {
         const reorderRes = await API.waypoints.reorder(this.currentTrip.id, targetIds, { headers: this.getTripIfMatchHeaders() });
         this.applyTripMetaFromResponse(this.currentTrip, reorderRes);
         Trip.reorderWaypoints(this.currentTrip, targetIds);
         reordered = true;
       } catch (error) {
         console.error('Failed to place inserted waypoint in order:', error);
         if (error.status === 409 || error.status === 428) { await this.handleTripConflict(error); return null; }
       }
     }

     this.currentTrip.waypoints = Trip.normalizeWaypointOrder(this.currentTrip.waypoints);
     if (!this.currentTrip.settings || typeof this.currentTrip.settings !== 'object') this.currentTrip.settings ={};
     this.currentTrip.settings.waypoint_order = this.currentTrip.waypoints.map(w => w.id);
     this.markTripWritten(this.currentTrip.id);

     UI.renderWaypoints(this.currentTrip.waypoints);
     MapManager.updateWaypoints(this.currentTrip.waypoints);
     UI.showToast(reordered ? 'Shape point added and reordered' : 'Shape point added', 'success');
     await this.refreshTripsList();
     return serverWaypoint;
   },

   async addWaypoint(data) {
    if (!this.currentTrip || !this.ensureEditable('add waypoints')) return null;
    this._pushWaypointHistory(); // snapshot before mutation
    let waypoint;
    try {
      const res = await API.waypoints.add(this.currentTrip.id, data, { headers: this.getTripIfMatchHeaders() });
      waypoint = res.waypoint;
      this.applyTripMetaFromResponse(this.currentTrip, res);
      if (!this.currentTrip.waypoints) this.currentTrip.waypoints = [];
      this.currentTrip.waypoints.push(waypoint);
      this.currentTrip.waypoints = Trip.normalizeWaypointOrder(this.currentTrip.waypoints);
      if (!this.currentTrip.settings || typeof this.currentTrip.settings !== 'object') this.currentTrip.settings = {};
      this.currentTrip.settings.waypoint_order = this.currentTrip.waypoints.map(w => w.id);
      this.markTripWritten(this.currentTrip.id);
    } catch (error) {
      console.error('Failed to add waypoint to cloud:', error);
      if (error.status === 409 || error.status === 428) { await this.handleTripConflict(error); return null; }
      UI.showToast('Could not add waypoint (not saved)', 'error');
      return null;
    }
    UI.renderWaypoints(this.currentTrip.waypoints);
    MapManager.addWaypointMarker(waypoint);
    await this.refreshTripsList();
    UI.showToast(waypoint.type === 'leg-break' ? 'Leg added' : 'Waypoint saved', 'success');
    if (this.currentTrip.waypoints.length >= 2) MapManager.updateRoute(this.currentTrip.waypoints);
    return waypoint;
  },

  async updateWaypointPosition(waypointId, lat, lng) {
    if (!this.currentTrip || !this.ensureEditable('move waypoints')) return;
    const wp = (this.currentTrip.waypoints || []).find(w => w.id === waypointId);
    if (!wp) return;
    const prevLat = wp.lat;
    const prevLng = wp.lng;
    this._pushWaypointHistory(); // snapshot before mutation

    // Optimistic: redraw the marker and route from the dropped position
    // immediately and persist in the background. Waiting a full round-trip
    // before the route line moves makes drags feel broken on a slow link.
    Trip.updateWaypoint(this.currentTrip, waypointId, { lat, lng });
    UI.renderWaypoints(this.currentTrip.waypoints);
    MapManager.updateWaypoints(this.currentTrip.waypoints);

    try {
      const res = await API.waypoints.update(this.currentTrip.id, waypointId, { lat, lng }, { headers: this.getTripIfMatchHeaders() });
      this.applyTripMetaFromResponse(this.currentTrip, res);
      if (res?.waypoint) {
        Trip.updateWaypoint(this.currentTrip, waypointId, res.waypoint);
        this.currentTrip.waypoints = Trip.normalizeWaypointOrder(this.currentTrip.waypoints);
      }
    } catch (error) {
      console.error('Failed to update waypoint:', error);
      if (error.status === 409 || error.status === 428) { await this.handleTripConflict(error); return; }
      // The server never saw the move — put the marker and route back.
      Trip.updateWaypoint(this.currentTrip, waypointId, { lat: prevLat, lng: prevLng });
      UI.renderWaypoints(this.currentTrip.waypoints);
      MapManager.updateWaypoints(this.currentTrip.waypoints);
      UI.showToast('Move failed. Not saved to cloud.', 'error');
      return;
    }
    this.markTripWritten(this.currentTrip.id);
    const now = Date.now();
    if (now - (this.waypointSaveToastAt || 0) > 2500) {
      this.waypointSaveToastAt = now;
      UI.showToast('Waypoint saved', 'success');
    }
    UI.renderWaypoints(this.currentTrip.waypoints);
    await this.refreshTripsList();
  },

  async deleteWaypoint(waypointId) {
    if (!this.currentTrip || !this.ensureEditable('delete waypoints')) return;
    const wpType = (this.currentTrip.waypoints || []).find(w => w.id === waypointId)?.type || '';
    const isVia = wpType === 'via';
    const isLegBreak = wpType === 'leg-break';
    this._pushWaypointHistory(); // snapshot before mutation
    try {
      const res = await API.waypoints.delete(this.currentTrip.id, waypointId, { headers: this.getTripIfMatchHeaders() });
      this.applyTripMetaFromResponse(this.currentTrip, res);
    } catch (error) {
      console.error('Failed to delete waypoint:', error);
      if (error.status === 409 || error.status === 428) { await this.handleTripConflict(error); return; }
      // Never claim success on a failed write — the waypoint is still there.
      UI.showToast('Delete failed. Not saved.', 'error');
      return;
    }
    Trip.removeWaypoint(this.currentTrip, waypointId);
    if (!this.currentTrip.settings || typeof this.currentTrip.settings !== 'object') this.currentTrip.settings = {};
    this.currentTrip.settings.waypoint_order = (this.currentTrip.waypoints || []).map(w => w.id);
    this.markTripWritten(this.currentTrip.id);
    MapManager.removeWaypointMarker(waypointId);
    UI.renderWaypoints(this.currentTrip.waypoints);
    if (this.currentTrip.waypoints.length >= 2) MapManager.updateRoute(this.currentTrip.waypoints);
    else MapManager.clearRoute();
    UI.showToast(isLegBreak ? 'Leg removed — legs merged' : (isVia ? 'Shape point removed' : 'Waypoint deleted'), 'success');
    await this.refreshTripsList();
  },

  async reorderWaypoints(orderIds) {
    if (!this.currentTrip || !this.ensureEditable('reorder waypoints')) return;
    // Guard first: a re-entrant call must not pollute the undo history.
    if (this.isReorderingWaypoints) return;
    this.isReorderingWaypoints = true;
    this._pushWaypointHistory(); // snapshot before mutation
    const preDragOrder = this._cloneWaypoints(this.currentTrip.waypoints);
    this.setWaypointsSaving(true);
    try {
      Trip.reorderWaypoints(this.currentTrip, orderIds);
      const res = await API.waypoints.reorder(this.currentTrip.id, orderIds, { headers: this.getTripIfMatchHeaders() });
      this.applyTripMetaFromResponse(this.currentTrip, res);
      if (!this.currentTrip.settings || typeof this.currentTrip.settings !== 'object') this.currentTrip.settings = {};
      this.currentTrip.settings.waypoint_order = Array.isArray(orderIds) ? orderIds.slice() : [];
      this.markTripWritten(this.currentTrip.id);
      UI.renderWaypoints(this.currentTrip.waypoints);
      MapManager.updateWaypoints(this.currentTrip.waypoints);
      await this.refreshTripsList();
      UI.showToast('Waypoint order saved', 'success');
    } catch (error) {
      console.error('Failed to reorder waypoints:', error);
      if (error.status === 409 || error.status === 428) { await this.handleTripConflict(error); return; }
      // Roll the list, the model and the route back to the pre-drag order so
      // the screen never shows an order the server doesn't have.
      this.currentTrip.waypoints = preDragOrder;
      if (this.currentTrip.settings && typeof this.currentTrip.settings === 'object') {
        this.currentTrip.settings.waypoint_order = preDragOrder.map(w => w.id);
      }
      UI.renderWaypoints(this.currentTrip.waypoints);
      MapManager.updateWaypoints(this.currentTrip.waypoints);
      UI.showToast('Reorder failed — order restored.', 'error');
    } finally {
      this.setWaypointsSaving(false);
      this.isReorderingWaypoints = false;
    }
  },

  setWaypointsSaving(isSaving) {
    const list = document.getElementById('waypointsList');
    if (!list) return;
    list.classList.toggle('is-saving', !!isSaving);
    list.setAttribute('aria-busy', isSaving ? 'true' : 'false');
    list.classList.add('waypoints-list');
  },

  /* --- Clear shaping (safe reset) --- */

  bindClearShapingBtn() {
    const btn = document.getElementById('clearShapingBtn');
    if (!btn) return;
    btn.addEventListener('click', () => {
      if (!this.currentTrip) return;
      const viaCount = (this.currentTrip.waypoints || []).filter(wp => UI.isViaWaypoint(wp)).length;
      if (!viaCount) return;
      UI.confirmInline(btn, () => this.clearShapingPoints(), {
        label: `Clear ${viaCount} shape point${viaCount === 1 ? '' : 's'}?`
      });
    });
  },

  /**
   * Remove every 'via' shaping point in one undoable step. Stops, notes,
   * photos and the selected route/alternative index are never touched.
   * Deliberately bypasses App.deleteWaypoint's per-call history push/reroute
   * (that would create one undo step per shape point) — a single
   * _pushWaypointHistory() call up front makes the whole clear one undo step.
   */
  async clearShapingPoints() {
    if (!this.currentTrip || !this.ensureEditable('clear shape points')) return;
    const trip = this.currentTrip;
    const vias = (trip.waypoints || []).filter(wp => UI.isViaWaypoint(wp));
    if (!vias.length) return;
    this._pushWaypointHistory(); // single undo step for the whole clear

    let removed = 0;
    let conflictError = null;
    let hardError = null;
    for (const wp of vias) {
      try {
        const res = await API.waypoints.delete(trip.id, wp.id, { headers: this.getTripIfMatchHeaders() });
        this.applyTripMetaFromResponse(trip, res);
        Trip.removeWaypoint(trip, wp.id);
        MapManager.removeWaypointMarker(wp.id);
        removed++;
      } catch (error) {
        console.error('Failed to clear a shape point:', error);
        if (error.status === 409 || error.status === 428) conflictError = error;
        else hardError = error;
        break; // stop at the first failure rather than hammering a broken connection
      }
    }

    if (!trip.settings || typeof trip.settings !== 'object') trip.settings = {};
    trip.settings.waypoint_order = (trip.waypoints || []).map(w => w.id);
    if (removed) this.markTripWritten(trip.id);
    UI.renderWaypoints(trip.waypoints);
    if (trip.waypoints.length >= 2) MapManager.updateRoute(trip.waypoints);
    else MapManager.clearRoute();

    if (conflictError) { await this.handleTripConflict(conflictError); return; }
    if (hardError) {
      UI.showToast(removed
        ? `Cleared ${removed} of ${vias.length} shape points — the rest failed. Not fully saved.`
        : 'Could not clear shape points. Not saved.', 'error');
      await this.refreshTripsList();
      return;
    }
    UI.showToast('Shape points cleared — Undo available', 'success');
    await this.refreshTripsList();
  },

  /* --- Trip legs --- */

  /**
   * Insert a new leg-break divider at the end of the current waypoint list.
   * lat/lng store the nearest adjacent real waypoint's coordinates per the
   * shared contract (a leg-break is never rendered as a map pin and is never
   * used for routing math beyond being a divider marker).
   */
  async addLegBreak(name) {
    if (!this.currentTrip || !this.ensureEditable('add a leg')) return null;
    const ordered = (this.currentTrip.waypoints || []).slice()
      .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
    if (!ordered.length) { UI.showToast('Add a stop before creating a leg', 'info'); return null; }
    const anchor = ordered[ordered.length - 1];
    return this.addWaypoint({
      name: name || 'Leg',
      type: 'leg-break',
      lat: anchor.lat,
      lng: anchor.lng
    });
  },

  /** Inline rename of a leg divider's title (click-to-edit in the list). */
  async renameLegBreak(waypointId, name) {
    if (!this.currentTrip || !this.ensureEditable('rename this leg')) return;
    const trip = this.currentTrip;
    const wp = (trip.waypoints || []).find(w => w.id === waypointId);
    if (!wp || wp.type !== 'leg-break') return;
    const trimmed = (name || '').trim() || 'Untitled leg';
    if (trimmed === wp.name) return;
    try {
      const res = await API.waypoints.update(trip.id, waypointId, { name: trimmed }, { headers: this.getTripIfMatchHeaders() });
      this.applyTripMetaFromResponse(trip, res);
      if (res?.waypoint) Trip.updateWaypoint(trip, waypointId, res.waypoint);
      else Trip.updateWaypoint(trip, waypointId, { name: trimmed });
      this.markTripWritten(trip.id);
      UI.renderWaypoints(trip.waypoints);
      await this.refreshTripsList();
    } catch (error) {
      console.error('Failed to rename leg:', error);
      if (error.status === 409 || error.status === 428) { await this.handleTripConflict(error); return; }
      UI.showToast('Could not rename leg. Not saved.', 'error');
      UI.renderWaypoints(trip.waypoints); // revert the displayed title to last-known-good
    }
  }
});
