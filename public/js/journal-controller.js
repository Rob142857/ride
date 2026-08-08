/**
 * Journal Controller — journal entries, attachments, photo capture
 * Extends App object (loaded after app-core.js)
 */
Object.assign(App, {
  bindJournalAttachmentPicker() {
    const fileInput = document.getElementById('journalAttachmentFile');
    const fileBtn = document.getElementById('journalAttachmentBtn');
    const fileName = document.getElementById('journalAttachmentFileName');
    if (!fileInput || !fileBtn || !fileName) return;
    fileBtn.addEventListener('click', () => {
      fileInput.value = '';
      fileInput.dataset.entryId = document.getElementById('noteEntryId')?.value || '';
      fileName.textContent = '';
      fileInput.click();
    });
    fileInput.addEventListener('change', async () => {
      const entryId = fileInput.dataset.entryId;
      const file = fileInput.files?.[0];
      fileName.textContent = file ? file.name : '';
      if (!file) return;
      if (!entryId) {
        // The note doesn't exist yet. Hold the file and upload it as soon as
        // handleNoteSubmit has an entry id — previously it was dropped.
        this._pendingNoteFile = file;
        fileName.textContent = `${file.name} — uploads when you save`;
        return;
      }
      this._pendingNoteFile = null;
      await this.uploadJournalAttachment(entryId, file);
    });
  },

  startEditJournalEntry(entryId) {
    if (!this.currentTrip) return;
    const entry = (this.currentTrip.journal || []).find(e => e.id === entryId);
    if (!entry) return;
    const titleEl = document.getElementById('noteTitle');
    const contentEl = document.getElementById('noteContent');
    const privateEl = document.getElementById('notePrivate');
    const tagsEl = document.getElementById('noteTags');
    const idEl = document.getElementById('noteEntryId');
    const modalTitle = document.getElementById('noteModalTitle');
    if (titleEl) titleEl.value = entry.title || '';
    if (contentEl) contentEl.value = entry.content || '';
    if (privateEl) privateEl.checked = !!entry.isPrivate;
    if (tagsEl) tagsEl.value = (entry.tags || []).join(', ');
    if (idEl) idEl.value = entry.id;
    if (modalTitle) modalTitle.textContent = 'Edit note';
    this._pendingNoteFile = null;
    this.renderNoteAttachments(entry);
    UI.openModal('noteModal');
  },

  pickJournalAttachment(entryId) {
    const fileInput = document.getElementById('journalAttachmentFile');
    const fileName = document.getElementById('journalAttachmentFileName');
    if (!fileInput) return;
    fileInput.dataset.entryId = entryId;
    fileInput.value = '';
    if (fileName) fileName.textContent = '';
    fileInput.click();
  },

  renderNoteAttachments(entry) {
    const listEl = document.getElementById('noteAttachmentList');
    if (!listEl) return;
    const attachments = entry?.attachments || [];
    if (!attachments.length) {
      listEl.innerHTML = '<div class="microcopy">No attachments yet.</div>';
      return;
    }
    listEl.innerHTML = UI.renderAttachmentsHtml(attachments, { entryId: entry.id });
    UI.bindAttachmentRemovals(listEl, (attachmentId, entryId) => {
      if (attachmentId) this.deleteAttachment(attachmentId, entryId || entry.id);
    });
  },

  async addJournalEntry(data) {
    if (!this.currentTrip || !this.ensureEditable('add notes')) return null;
    let entry;
    try {
      entry = await API.journal.add(this.currentTrip.id, {
        title: data.title, content: data.content,
        is_private: data.isPrivate, tags: data.tags
      });
      if (!this.currentTrip.journal) this.currentTrip.journal = [];
      entry.attachments = [];
      this.currentTrip.journal.push(entry);
    } catch (error) {
      if (error?.code === 'LOGIN_REQUIRED') { UI.suggestLogin('save this note to the cloud'); return null; }
      console.error('Failed to add journal entry:', error);
      UI.showToast('Note not saved to cloud.', 'error');
      return null;
    }
    UI.renderJournal(this.currentTrip.journal);
    return entry;
  },

  async updateJournalEntry(entryId, data) {
    if (!this.currentTrip || !this.ensureEditable('update notes')) return null;
    let updated;
    try {
      updated = await API.journal.update(this.currentTrip.id, entryId, {
        title: data.title, content: data.content,
        is_private: data.isPrivate, tags: data.tags
      });
    } catch (error) {
      console.error('Failed to update journal entry:', error);
      UI.showToast('Note not updated in cloud.', 'error');
      return null;
    }
    if (updated) {
      const idx = this.currentTrip.journal.findIndex(e => e.id === entryId);
      if (idx >= 0) {
        const existing = this.currentTrip.journal[idx];
        this.currentTrip.journal[idx] = { ...updated, attachments: existing?.attachments || [] };
      }
    }
    UI.renderJournal(this.currentTrip.journal);
    return updated;
  },

  async deleteJournalEntry(entryId) {
    if (!this.currentTrip || !this.ensureEditable('delete notes')) return;
    try { await API.journal.delete(this.currentTrip.id, entryId); }
    catch (error) {
      console.error('Failed to delete journal entry:', error);
      UI.showToast('Delete failed on cloud.', 'error');
      return;
    }
    Trip.removeJournalEntry(this.currentTrip, entryId);
    this.saveCurrentTrip();
    UI.renderJournal(this.currentTrip.journal);
    UI.showToast('Note deleted', 'success');
  },

  async uploadJournalAttachment(entryId, file) {
    if (!this.currentTrip || !this.ensureEditable('upload attachments')) return false;
    const tripId = this.currentTrip.id;
    this._activeUploads++;
    try {
      UI.showToast('Uploading photo…', 'info');
      const attachment = await API.attachments.upload(tripId, file, { journal_entry_id: entryId });
      if (this.currentTrip?.id !== tripId) return true; // trip switched mid-upload
      this.addAttachmentToEntry(entryId, attachment, true);
      UI.showToast('Photo added', 'success');
    } catch (err) {
      if (err?.code === 'LOGIN_REQUIRED') { UI.suggestLogin('upload photos'); return false; }
      console.error('Attachment upload failed', err);
      UI.showToast('Photo upload failed', 'error');
      return false;
    } finally {
      this._activeUploads = Math.max(0, this._activeUploads - 1);
    }
    UI.renderJournal(this.currentTrip.journal);
    const entry = (this.currentTrip.journal || []).find(e => e.id === entryId);
    if (entry) this.renderNoteAttachments(entry);
    return true;
  },

  addAttachmentToEntry(entryId, attachment, prepend = false) {
    if (!this.currentTrip) return;
    if (!this.currentTrip.attachments) this.currentTrip.attachments = [];
    if (!this.currentTrip.attachments.some(a => a.id === attachment.id)) {
      if (prepend) this.currentTrip.attachments.unshift(attachment);
      else this.currentTrip.attachments.push(attachment);
    }
    const entry = (this.currentTrip.journal || []).find(e => e.id === entryId);
    if (!entry) return;
    if (!entry.attachments) entry.attachments = [];
    if (!entry.attachments.some(a => a.id === attachment.id)) {
      if (prepend) entry.attachments.unshift(attachment);
      else entry.attachments.push(attachment);
    }
  },

  removeAttachmentFromState(attachmentId) {
    if (!this.currentTrip) return;
    if (Array.isArray(this.currentTrip.attachments)) {
      this.currentTrip.attachments = this.currentTrip.attachments.filter(a => a.id !== attachmentId);
    }
    if (Array.isArray(this.currentTrip.journal)) {
      this.currentTrip.journal.forEach(entry => {
        if (Array.isArray(entry.attachments)) {
          entry.attachments = entry.attachments.filter(a => a.id !== attachmentId);
        }
      });
    }
  },

  async deleteAttachment(attachmentId, entryId) {
    if (!this.currentTrip || !this.ensureEditable('remove attachments')) return;
    try {
      await API.attachments.delete(attachmentId, { headers: this.getTripIfMatchHeaders() });
      this.removeAttachmentFromState(attachmentId);
      UI.showToast('Attachment removed', 'success');
    } catch (err) {
      if (err?.code === 'LOGIN_REQUIRED') { UI.suggestLogin('manage photos'); return; }
      console.error('Failed to delete attachment', err);
      UI.showToast('Could not delete photo', 'error');
      return;
    }
    UI.renderJournal(this.currentTrip.journal || []);
    if (entryId) {
      const entry = (this.currentTrip.journal || []).find(e => e.id === entryId);
      if (entry) this.renderNoteAttachments(entry);
    }
    // Refresh waypoint details if open
    const wpModal = document.getElementById('waypointDetailsModal');
    if (wpModal && !wpModal.classList.contains('hidden')) {
      const waypointId = document.getElementById('waypointDetailId')?.value || '';
      if (waypointId) this.renderWaypointAttachments(waypointId);
    }
  },

  async addPhotoAttachment(file, location = null) {
    if (!this.currentTrip || !this.ensureEditable('save photos')) return;
    const tripId = this.currentTrip.id;
    const title = `Photo ${new Date().toLocaleString()}`;
    let entry;
    try {
      entry = await API.journal.add(tripId, {
        title, content: '', is_private: false, tags: [],
        ...(location && Number.isFinite(location.lat) && Number.isFinite(location.lng)
          ? { location: { lat: location.lat, lng: location.lng } }
          : {})
      });
      if (!this.currentTrip.journal) this.currentTrip.journal = [];
      entry.attachments = [];
      this.currentTrip.journal.push(entry);
    } catch (err) {
      if (err?.code === 'LOGIN_REQUIRED') { UI.suggestLogin('upload photos'); return; }
      console.error('Failed to create photo note', err);
      UI.showToast('Could not create note for photo.', 'error');
      return;
    }
    this._activeUploads++;
    let uploaded = false;
    try {
      UI.showToast('Uploading photo…', 'info');
      const attachment = await API.attachments.upload(tripId, file, { journal_entry_id: entry.id });
      if (this.currentTrip?.id !== tripId) return;
      this.addAttachmentToEntry(entry.id, attachment, true);
      uploaded = true;
      UI.showToast('Photo saved to trip', 'success');
    } catch (err) {
      if (err?.code === 'LOGIN_REQUIRED') UI.suggestLogin('upload photos');
      else console.error('Photo upload failed', err);
      if (err?.code !== 'LOGIN_REQUIRED') UI.showToast('Photo upload failed', 'error');
    } finally {
      this._activeUploads = Math.max(0, this._activeUploads - 1);
    }

    if (!uploaded) {
      // Don't leave an empty "Photo <date>" note behind with nothing in it.
      try { await API.journal.delete(tripId, entry.id); } catch (_) { /* best effort */ }
      if (this.currentTrip?.id === tripId) {
        Trip.removeJournalEntry(this.currentTrip, entry.id);
        UI.renderJournal(this.currentTrip.journal);
      }
      return;
    }

    if (this.currentTrip?.id !== tripId) return;
    UI.renderJournal(this.currentTrip.journal);
    this.renderNoteAttachments(entry);
  },

  async saveRouteData(routeData) {
    if (!this.currentTrip || !this.ensureEditable('save routes')) return;
    const duration = routeData?.duration ?? routeData?.time ?? null;
    this.currentTrip.route = {
      ...routeData, duration, time: duration,
      coordinates: routeData?.coordinates || [],
      _selectedIndex: routeData?._selectedIndex ?? 0,
      _allAlternatives: routeData?._allAlternatives || []
    };
    this.precomputeRouteMetrics();
    this.rideRerouting = false;
    this.offRouteCounter = 0;
    // Route coordinates changed: reset sliding-window cursor so the next
    // GPS tick recomputes nearest-point against the new path.
    this._rideNearIdx = 0;

    // During ride mode, reroutes are ephemeral — update in-memory route for
    // navigation HUD only, but do NOT persist to the API.  This prevents the
    // rider's live GPS position (embedded as the first coordinate of the
    // rerouted path) from being written to the trip and exposed on the public
    // trip page.
    if (this.isRiding) {
      UI.updateTripStats(this.currentTrip);
      return;
    }

    UI.updateTripStats(this.currentTrip);
    const allRoutes = [this.currentTrip.route, ...(this.currentTrip.route?._allAlternatives || [])].filter(Boolean);
    const selectedIdx = this.currentTrip.route?._selectedIndex ?? 0;
    if (allRoutes.length > 1 || this.currentTrip.route?._allAlternatives?.length) {
      await this.saveAlternativeRoutes(allRoutes, selectedIdx);
    }

    const ok = await this.saveCurrentTrip();
    if (ok) {
      this.markTripWritten(this.currentTrip.id);
      UI.showToast('New route saved', 'success');
      await this.refreshTripsList();
    } else {
      UI.showToast('Route not saved', 'error');
    }
  }
});

/**
 * Fallback for the login suggestion hook used by App.ensureEditable and the
 * import flow. Defined only if the core module hasn't provided one, so the
 * canonical implementation always wins.
 */
if (typeof App !== 'undefined' && typeof App._suggestLogin !== 'function') {
  App._suggestLogin = function (actionLabel) {
    if (typeof UI !== 'undefined' && typeof UI.suggestLogin === 'function') {
      UI.suggestLogin(actionLabel || 'sync your trips');
    }
  };
}
