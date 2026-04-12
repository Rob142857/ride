/**
 * UI Renderers — waypoint list, journal list, trips list rendering
 * Extracted from ui.js for clarity.
 * Extends UI object.
 */
Object.assign(UI, {
  renderWaypoints(waypoints) {
    const container = document.getElementById('waypointsList');
    
    if (waypoints.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <svg viewBox="0 0 24 24"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>
          <h3>No waypoints yet</h3>
          <p>Add your first waypoint to start planning your trip</p>
        </div>
      `;
      return;
    }

    const orderedWaypoints = (Array.isArray(waypoints) ? waypoints : [])
      .slice()
      .sort((a, b) => {
        const ao = Number.isFinite(a?.order) ? a.order : 0;
        const bo = Number.isFinite(b?.order) ? b.order : 0;
        return ao - bo;
      });

    container.innerHTML = orderedWaypoints
      .map((wp, index) => `
        <div class="waypoint-item" data-id="${wp.id}" draggable="true">
          <div class="waypoint-handle" title="Drag to reorder">
            <svg viewBox="0 0 24 24"><path d="M10 4h2v2h-2V4zm0 4h2v2h-2V8zm0 4h2v2h-2v-2zm0 4h2v2h-2v-2zm4-12h2v2h-2V4zm0 4h2v2h-2V8zm0 4h2v2h-2v-2zm0 4h2v2h-2v-2z"/></svg>
          </div>
          <div class="waypoint-icon">
            <span style="font-size: 20px;">${MapManager.waypointIcons[wp.type]?.icon || '📍'}</span>
          </div>
          <div class="waypoint-info">
            <div class="waypoint-name">${index + 1}. ${this.escapeHtml(wp.name)}</div>
            ${wp.address ? `<div class="waypoint-address">${this.escapeHtml(wp.address)}</div>` : ''}
            ${wp.notes ? `<div class="waypoint-notes">${this.escapeHtml(wp.notes)}</div>` : ''}
          </div>
          <div class="waypoint-actions">
            <button class="icon-btn" onclick="MapManager.centerOnWaypoint(App.currentTrip.waypoints.find(w => w.id === '${wp.id}')); event.stopPropagation();" aria-label="Center on map">
              <svg viewBox="0 0 24 24"><path d="M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3c-.46-4.17-3.77-7.48-7.94-7.94V1h-2v2.06C6.83 3.52 3.52 6.83 3.06 11H1v2h2.06c.46 4.17 3.77 7.48 7.94 7.94V23h2v-2.06c4.17-.46 7.48-3.77 7.94-7.94H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z"/></svg>
            </button>
            <button class="icon-btn" onclick="App.deleteWaypoint('${wp.id}'); event.stopPropagation();" aria-label="Delete waypoint">
              <svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
            </button>
          </div>
        </div>
      `).join('');

    // Click to open waypoint details
    container.querySelectorAll('.waypoint-item').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (container.classList.contains('is-reordering')) return;
        if (e.target?.closest?.('.waypoint-actions')) return;
        if (e.target?.closest?.('.waypoint-handle')) return;
        const id = el.dataset.id;
        if (!id) return;
        const waypoint = orderedWaypoints.find((wp) => wp.id === id);
        if (waypoint) MapManager.centerOnWaypoint(waypoint);
        if (!App.ensureEditable('edit waypoints')) return;
        App.openWaypointDetails(id);
      });
    });

    // Drag & drop reordering
    if (container.dataset.reorderBound !== '1') {
      container.dataset.reorderBound = '1';
      this._bindWaypointReorder(container);
    }
  },

  /** Bind drag-and-drop + touch reordering to waypoint list container */
  _bindWaypointReorder(container) {
    const state = {
      draggingEl: null,
      draggingId: null,
      dropping: false,
      lastOverEl: null,
      touchActive: false,
      touchId: null
    };

    const clearOver = () => {
      if (state.lastOverEl) {
        state.lastOverEl.classList.remove('drop-before');
        state.lastOverEl.classList.remove('drop-after');
        state.lastOverEl = null;
      }
    };

    const getAfterElement = (y) => {
      const items = Array.from(container.querySelectorAll('.waypoint-item:not(.dragging)'));
      let closest = { offset: Number.NEGATIVE_INFINITY, element: null };
      for (const child of items) {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        if (offset < 0 && offset > closest.offset) {
          closest = { offset, element: child };
        }
      }
      return closest.element;
    };

    const getOrderIdsFromDom = () => Array.from(container.querySelectorAll('.waypoint-item')).map((el) => el.dataset.id);

    const persistCurrentOrder = async () => {
      if (state.dropping) return;
      const orderIds = getOrderIdsFromDom().filter(Boolean);
      if (!orderIds.length) return;
      state.dropping = true;
      try { await App.reorderWaypoints(orderIds); } finally { state.dropping = false; }
    };

    // Desktop HTML5 DnD
    container.addEventListener('dragstart', (e) => {
      const item = e.target?.closest?.('.waypoint-item');
      if (!item) return;
      state.draggingEl = item;
      state.draggingId = item.dataset.id;
      item.classList.add('dragging');
      try {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', state.draggingId || '');
      } catch (_) {}
    });

    container.addEventListener('dragover', (e) => {
      if (!state.draggingEl) return;
      e.preventDefault();
      const afterEl = getAfterElement(e.clientY);
      if (!afterEl) container.appendChild(state.draggingEl);
      else container.insertBefore(state.draggingEl, afterEl);
    });

    container.addEventListener('dragenter', (e) => {
      const overItem = e.target?.closest?.('.waypoint-item');
      if (!state.draggingEl || !overItem || overItem === state.draggingEl) return;
      e.preventDefault();
      clearOver();
      const box = overItem.getBoundingClientRect();
      const isAfter = (e.clientY - box.top) > (box.height / 2);
      overItem.classList.add(isAfter ? 'drop-after' : 'drop-before');
      state.lastOverEl = overItem;
    });

    container.addEventListener('dragleave', (e) => {
      const overItem = e.target?.closest?.('.waypoint-item');
      if (!overItem) return;
      overItem.classList.remove('drop-before', 'drop-after');
      if (state.lastOverEl === overItem) state.lastOverEl = null;
    });

    container.addEventListener('drop', async (e) => {
      if (!state.draggingEl) return;
      e.preventDefault();
      clearOver();
      await persistCurrentOrder();
    });

    container.addEventListener('dragend', () => {
      clearOver();
      if (state.draggingEl) state.draggingEl.classList.remove('dragging');
      state.draggingEl = null;
      state.draggingId = null;
    });

    // Touch reorder (mobile)
    const findHandleItem = (target) => {
      const handle = target?.closest?.('.waypoint-handle');
      if (!handle) return null;
      return handle.closest('.waypoint-item');
    };

    container.addEventListener('touchstart', (e) => {
      const item = findHandleItem(e.target);
      if (!item) return;
      const touch = e.changedTouches?.[0];
      if (!touch) return;
      state.touchActive = true;
      state.touchId = touch.identifier;
      state.draggingEl = item;
      state.draggingId = item.dataset.id;
      item.classList.add('dragging');
      container.classList.add('is-reordering');
    }, { passive: true });

    container.addEventListener('touchmove', (e) => {
      if (!state.touchActive || !state.draggingEl) return;
      const touch = Array.from(e.touches || []).find((t) => t.identifier === state.touchId);
      if (!touch) return;
      e.preventDefault();
      const elAtPoint = document.elementFromPoint(touch.clientX, touch.clientY);
      const overItem = elAtPoint?.closest?.('.waypoint-item');
      if (!overItem || overItem === state.draggingEl) { clearOver(); return; }
      clearOver();
      const box = overItem.getBoundingClientRect();
      const isAfter = (touch.clientY - box.top) > (box.height / 2);
      overItem.classList.add(isAfter ? 'drop-after' : 'drop-before');
      state.lastOverEl = overItem;
      if (isAfter) overItem.after(state.draggingEl);
      else overItem.before(state.draggingEl);
    }, { passive: false });

    const endTouch = async () => {
      if (!state.touchActive) return;
      state.touchActive = false;
      state.touchId = null;
      clearOver();
      container.classList.remove('is-reordering');
      if (state.draggingEl) state.draggingEl.classList.remove('dragging');
      state.draggingEl = null;
      state.draggingId = null;
      await persistCurrentOrder();
    };

    container.addEventListener('touchend', endTouch, { passive: true });
    container.addEventListener('touchcancel', endTouch, { passive: true });
  },

  renderJournal(entries) {
    const container = document.getElementById('journalList');
    
    if (entries.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <svg viewBox="0 0 24 24"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/></svg>
          <h3>No journal entries yet</h3>
          <p>Add notes about your trip experiences</p>
        </div>
      `;
      return;
    }

    container.innerHTML = entries
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map(entry => `
        <div class="journal-entry ${entry.isPrivate ? 'private' : ''}" data-id="${entry.id}">
          <div class="journal-header">
            <div class="journal-title">
              ${entry.isPrivate ? '🔒 ' : ''}${this.escapeHtml(entry.title)}
            </div>
            <div class="journal-date">${this.formatDate(entry.createdAt)}</div>
          </div>
          <div class="journal-content">${this.escapeHtml(entry.content)}</div>
          ${entry.attachments?.length ? `
            <div class="journal-attachments">
              ${entry.attachments.map(att => `
                <div class="attachment-pill" data-attachment-id="${att.id}">
                  <a href="${att.url}" target="_blank" rel="noopener">${this.escapeHtml(att.original_name || att.filename || att.name || 'Attachment')}</a>
                  <button class="attachment-remove" data-attachment-id="${att.id}" data-entry-id="${entry.id}" aria-label="Remove attachment">×</button>
                </div>
              `).join('')}
            </div>
          ` : ''}
          ${entry.tags?.length > 0 ? `
            <div class="journal-tags">
              ${entry.tags.map(tag => `<span class="tag">${this.escapeHtml(tag)}</span>`).join('')}
            </div>
          ` : ''}
          <div class="journal-actions">
            <button class="icon-btn" onclick="App.pickJournalAttachment('${entry.id}'); event.stopPropagation();" aria-label="Attach file">
              📎
            </button>
            <button class="icon-btn" onclick="App.deleteJournalEntry('${entry.id}'); event.stopPropagation();" aria-label="Delete entry">
              <svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
            </button>
          </div>
        </div>
      `).join('');
    
    container.querySelectorAll('.journal-entry').forEach((el) => {
      el.addEventListener('click', () => {
        const id = el.dataset.id;
        if (!id) return;
        App.startEditJournalEntry(id);
      });
    });

    container.querySelectorAll('.attachment-remove').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const attachmentId = btn.dataset.attachmentId;
        const entryId = btn.dataset.entryId;
        if (attachmentId && entryId) App.deleteAttachment(attachmentId, entryId);
      });
    });
  },

  renderTrips(trips, currentTripId) {
    const container = document.getElementById('tripsList');
    
    if (trips.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <svg viewBox="0 0 24 24"><path d="M4 10.5c-.83 0-1.5.67-1.5 1.5s.67 1.5 1.5 1.5 1.5-.67 1.5-1.5-.67-1.5-1.5-1.5zm0-6c-.83 0-1.5.67-1.5 1.5S3.17 7.5 4 7.5 5.5 6.83 5.5 6 4.83 4.5 4 4.5zm0 12c-.83 0-1.5.68-1.5 1.5s.68 1.5 1.5 1.5 1.5-.68 1.5-1.5-.67-1.5-1.5-1.5zM7 19h14v-2H7v2zm0-6h14v-2H7v2zm0-8v2h14V5H7z"/></svg>
          <h3>No saved trips</h3>
          <p>Your trips will appear here</p>
        </div>
      `;
      return;
    }

    container.innerHTML = '';
    const template = document.getElementById('tripItemTemplate');
    const normalizedTrips = trips.map((trip) => ({
      ...trip,
      waypoints: Array.isArray(trip.waypoints) ? trip.waypoints : [],
      journal: Array.isArray(trip.journal) ? trip.journal : [],
    }));

    const total = normalizedTrips.length;

    normalizedTrips.forEach((trip, index) => {
      const stats = Trip.getStats(trip);
      const waypointCount = Number.isFinite(trip.waypoint_count) ? trip.waypoint_count : stats.waypointCount;
      const journalCount = Number.isFinite(trip.journal_count) ? trip.journal_count : stats.journalCount;
      const node = template.content.cloneNode(true);
      const item = node.querySelector('.trip-item');
      item.dataset.id = trip.id;
      if (trip.id === currentTripId) item.classList.add('active');
      item.tabIndex = 0;
      node.querySelector('.trip-name').textContent = this.escapeHtml(trip.name);
      node.querySelector('.trip-meta').innerHTML = `<span>📍 ${waypointCount} waypoints</span> <span>📝 ${journalCount} notes</span>`;
      const statusPill = node.querySelector('.trip-status-pill');
      const copyBtn = node.querySelector('.trip-copy-link');
      const makePublicBtn = node.querySelector('.trip-make-public');

      const link = trip.short_url || (trip.short_code ? `${window.location.origin}/${trip.short_code}` : '');
      if (trip.is_public) {
        statusPill.textContent = 'Public';
        statusPill.className = 'trip-status-pill public';
        copyBtn.style.display = 'inline-flex';
        makePublicBtn.style.display = 'none';
        copyBtn.onclick = async (e) => {
          e.stopPropagation();
          if (!link) { UI.showToast('No link yet', 'info'); return; }
          try {
            await navigator.clipboard.writeText(link);
            UI.showToast('Link copied', 'success');
          } catch (err) {
            console.error(err);
            UI.showToast('Copy failed', 'error');
          }
        };
      } else {
        statusPill.textContent = 'Private';
        statusPill.className = 'trip-status-pill private';
        copyBtn.style.display = 'none';
        makePublicBtn.style.display = 'inline-flex';
        makePublicBtn.onclick = (e) => {
          e.stopPropagation();
          App.openTripDetails(trip.id);
        };
      }
      const detailsBtn = node.querySelector('.trip-details-btn');
      if (detailsBtn) {
        detailsBtn.onclick = (e) => { e.stopPropagation(); App.openTripDetails(trip.id); };
      }

      const deleteBtn = node.querySelector('.trip-delete-btn');
      if (deleteBtn) {
        deleteBtn.onclick = (e) => { e.stopPropagation(); this.showDeleteTripConfirm(trip); };
      }

      const moveUp = node.querySelector('.trip-move-up');
      const moveDown = node.querySelector('.trip-move-down');
      if (moveUp) {
        moveUp.disabled = index === 0;
        moveUp.onclick = (e) => { e.stopPropagation(); this.requestTripReorder(trip.id, 'up'); };
      }
      if (moveDown) {
        moveDown.disabled = index === total - 1;
        moveDown.onclick = (e) => { e.stopPropagation(); this.requestTripReorder(trip.id, 'down'); };
      }

      item.addEventListener('click', () => App.loadTrip(trip.id));
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          App.loadTrip(trip.id);
        }
      });
      container.appendChild(node);
    });
  },

  showDeleteTripConfirm(trip) {
    const name = trip.name || 'this trip';
    const ok = window.confirm(`Delete ${name}? This cannot be undone.`);
    if (ok) App.deleteTrip(trip.id);
  },

  requestTripReorder(tripId, direction) {
    App.reorderTrips(tripId, direction);
  },
});
