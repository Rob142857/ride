/**
 * UI Renderers — waypoint list, journal list, trips list rendering
 * Extracted from ui.js for clarity.
 * Extends UI object.
 */
Object.assign(UI, {
  renderWaypoints(waypoints) {
    const container = document.getElementById('waypointsList');
    if (!container) return;
    const all = Array.isArray(waypoints) ? waypoints : [];

    this._syncClearShapingVisibility(all);

    const tripId = (typeof App !== 'undefined' && App.currentTrip?.id) || '';
    const readOnly = this.isReadOnlyTrip();
    const legBreakCount = all.filter((wp) => this.isLegBreakWaypoint(wp)).length;
    const addLegHtml = (all.length > 0 && !readOnly)
      ? `<button type="button" class="add-leg-btn" id="addLegBtn" data-default-name="${this.escapeAttr(`Leg ${legBreakCount + 2}`)}">+ Add leg</button>`
      : '';

    if (all.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <svg viewBox="0 0 24 24"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>
          <h3>No waypoints yet</h3>
          <p>Add your first waypoint to start planning your trip</p>
        </div>
      `;
      return;
    }

    const orderedWaypoints = all
      .slice()
      .sort((a, b) => {
        const ao = Number.isFinite(a?.order) ? a.order : 0;
        const bo = Number.isFinite(b?.order) ? b.order : 0;
        return ao - bo;
      });

    const deleteIcon = '<svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';
    const dragHandleIcon = '<svg viewBox="0 0 24 24"><path d="M10 4h2v2h-2V4zm0 4h2v2h-2V8zm0 4h2v2h-2v-2zm0 4h2v2h-2v-2zm4-12h2v2h-2V4zm0 4h2v2h-2V8zm0 4h2v2h-2v-2zm0 4h2v2h-2v-2z"/></svg>';
    // Mirrors the existing --select-chevron path already used for dropdowns
    // (app.css) so the collapse toggle reads as the same control language.
    const chevronIcon = '<svg class="chevron-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';

    // Shaping points ("via") bend the route but are not stops, and leg-break
    // dividers are section headers, not stops either: neither ever takes a
    // number in the itinerary. Stop numbering restarts at 1 after each divider.
    let stopNumber = 0;
    let currentLegId = 'root'; // waypoints before the first divider belong to the implicit leg 1
    container.innerHTML = orderedWaypoints
      .map((wp) => {
        const id = this.escapeAttr(wp.id);

        if (this.isLegBreakWaypoint(wp)) {
          currentLegId = wp.id;
          stopNumber = 0;
          const title = wp.name || 'Leg';
          const collapsed = Storage.getLegCollapsed(tripId, wp.id);
          const titleAttr = this.escapeAttr(title);
          return `
        <div class="leg-divider${collapsed ? ' is-collapsed' : ''}" data-id="${id}" data-leg-break="1" draggable="true">
          <div class="waypoint-handle" title="Drag to reorder leg" aria-hidden="true">${dragHandleIcon}</div>
          <button type="button" class="leg-divider-toggle" data-action="toggle-leg" data-id="${id}" draggable="false" aria-expanded="${collapsed ? 'false' : 'true'}" aria-label="${collapsed ? 'Expand' : 'Collapse'} ${titleAttr}">${chevronIcon}</button>
          <div class="leg-divider-title" data-id="${id}" data-original-name="${titleAttr}"${readOnly ? '' : ' contenteditable="true"'} draggable="false" spellcheck="false" role="${readOnly ? 'text' : 'textbox'}" aria-label="Leg name">${this.escapeHtml(title)}</div>
          <span class="leg-divider-stats" aria-hidden="true">—</span>
          <div class="waypoint-actions">
            ${readOnly ? '' : `<button type="button" class="icon-btn" data-action="delete" data-id="${id}" aria-label="Delete this leg divider (merges the two legs)">${deleteIcon}</button>`}
          </div>
        </div>`;
        }

        const legAttr = ` data-leg-id="${this.escapeAttr(currentLegId)}"`;
        const collapsedClass = currentLegId !== 'root' && Storage.getLegCollapsed(tripId, currentLegId) ? ' is-collapsed' : '';

        if (this.isViaWaypoint(wp)) {
          return `
        <div class="waypoint-item is-via${collapsedClass}" data-id="${id}" data-via="1" draggable="true"${legAttr}>
          <div class="waypoint-handle" title="Drag to reshape order" aria-hidden="true">${dragHandleIcon}</div>
          <div class="waypoint-icon"><span aria-hidden="true" style="font-size:12px;opacity:.85">◆</span></div>
          <div class="waypoint-info">
            <div class="waypoint-via-label">Shape point</div>
          </div>
          <div class="waypoint-actions">
            ${readOnly ? '' : `<button type="button" class="icon-btn" data-action="delete" data-id="${id}" aria-label="Remove shape point">${deleteIcon}</button>`}
          </div>
        </div>`;
        }

        stopNumber += 1;
        return `
        <div class="waypoint-item${collapsedClass}" data-id="${id}" draggable="true"${legAttr}>
          <div class="waypoint-handle" title="Drag to reorder" aria-hidden="true">${dragHandleIcon}</div>
          <div class="waypoint-icon">
            <span style="font-size: 20px;">${this.escapeHtml(MapManager.waypointIcons[wp.type]?.icon || '📍')}</span>
          </div>
          <div class="waypoint-info">
            <div class="waypoint-name">${stopNumber}. ${this.escapeHtml(wp.name)}</div>
            ${wp.address ? `<div class="waypoint-address">${this.escapeHtml(wp.address)}</div>` : ''}
            ${wp.notes ? `<div class="waypoint-notes">${this.escapeHtml(wp.notes)}</div>` : ''}
          </div>
          <div class="waypoint-actions">
            <button type="button" class="icon-btn" data-action="center" data-id="${id}" aria-label="Center on map">
              <svg viewBox="0 0 24 24"><path d="M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3c-.46-4.17-3.77-7.48-7.94-7.94V1h-2v2.06C6.83 3.52 3.52 6.83 3.06 11H1v2h2.06c.46 4.17 3.77 7.48 7.94 7.94V23h2v-2.06c4.17-.46 7.48-3.77 7.94-7.94H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z"/></svg>
            </button>
            ${readOnly ? '' : `<button type="button" class="icon-btn" data-action="delete" data-id="${id}" aria-label="Delete waypoint">${deleteIcon}</button>`}
          </div>
        </div>`;
      }).join('') + addLegHtml;

    // Row actions (no inline handlers — keeps a strict CSP viable)
    container.querySelectorAll('.waypoint-actions [data-action]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        if (!id) return;
        if (btn.dataset.action === 'center') {
          const wp = orderedWaypoints.find((w) => w.id === id);
          if (wp) MapManager.centerOnWaypoint(wp);
          return;
        }
        this.confirmInline(btn, () => App.deleteWaypoint(id));
      });
    });

    // Leg collapse toggle
    container.querySelectorAll('.leg-divider-toggle').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        if (id) this.toggleLegCollapse(id);
      });
    });

    // Leg rename (click-to-edit inline; contentEditable is only present when !readOnly)
    container.querySelectorAll('.leg-divider-title[contenteditable="true"]').forEach((el) => {
      const commit = () => {
        const id = el.dataset.id;
        const value = (el.textContent || '').trim();
        if (!id) return;
        if (value === (el.dataset.originalName || '')) return; // no change
        App.renameLegBreak(id, value);
      };
      el.addEventListener('blur', commit);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
        else if (e.key === 'Escape') { e.preventDefault(); el.textContent = el.dataset.originalName || ''; el.blur(); }
      });
    });

    // Add-leg button
    const addLegBtn = document.getElementById('addLegBtn');
    if (addLegBtn) {
      addLegBtn.addEventListener('click', () => {
        App.addLegBreak(addLegBtn.dataset.defaultName || 'Leg');
      });
    }

    // Click to open waypoint details (read-only viewers may still read them)
    container.querySelectorAll('.waypoint-item').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (container.classList.contains('is-reordering')) return;
        if (e.target?.closest?.('.waypoint-actions')) return;
        if (e.target?.closest?.('.waypoint-handle')) return;
        const id = el.dataset.id;
        if (!id) return;
        const waypoint = orderedWaypoints.find((wp) => wp.id === id);
        if (waypoint) MapManager.centerOnWaypoint(waypoint);
        if (el.dataset.via === '1') return; // shaping points have no details
        App.openWaypointDetails(id);
      });
    });

    // Drag & drop reordering
    if (container.dataset.reorderBound !== '1') {
      container.dataset.reorderBound = '1';
      this._bindWaypointReorder(container);
    }
  },

  /** Shaping point, not a stop (shared contract: waypoint.type === 'via'). */
  isViaWaypoint(wp) {
    return (wp?.type || '') === 'via';
  },

  /** Leg divider, not a stop (shared contract: waypoint.type === 'leg-break'). */
  isLegBreakWaypoint(wp) {
    return (wp?.type || '') === 'leg-break';
  },

  /** A real, numbered stop — everything that isn't a shaping point or a leg divider. */
  isStopWaypoint(wp) {
    return !this.isViaWaypoint(wp) && !this.isLegBreakWaypoint(wp);
  },

  /** Number of real stops — shaping points and leg dividers never count. */
  countStops(waypoints) {
    return (Array.isArray(waypoints) ? waypoints : []).filter((wp) => this.isStopWaypoint(wp)).length;
  },

  /** Show #clearShapingBtn only when the trip actually has shape points to clear. */
  _syncClearShapingVisibility(waypoints) {
    const btn = document.getElementById('clearShapingBtn');
    if (!btn) return;
    const hasVia = (Array.isArray(waypoints) ? waypoints : []).some((wp) => this.isViaWaypoint(wp));
    btn.classList.toggle('hidden', !hasVia);
  },

  /**
   * Toggle a leg's collapsed state: persist to localStorage, flip the
   * divider's own class/aria state, and patch just the rows tagged
   * data-leg-id="<legId>" — no full re-render needed.
   */
  toggleLegCollapse(legId) {
    const container = document.getElementById('waypointsList');
    if (!container || !legId) return;
    const tripId = (typeof App !== 'undefined' && App.currentTrip?.id) || '';
    const escapedId = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(legId) : legId;
    const divider = container.querySelector(`.leg-divider[data-id="${escapedId}"]`);
    const nextCollapsed = !(divider && divider.classList.contains('is-collapsed'));
    Storage.setLegCollapsed(tripId, legId, nextCollapsed);
    if (divider) {
      divider.classList.toggle('is-collapsed', nextCollapsed);
      const toggleBtn = divider.querySelector('.leg-divider-toggle');
      const title = divider.querySelector('.leg-divider-title')?.textContent?.trim() || 'leg';
      if (toggleBtn) {
        toggleBtn.setAttribute('aria-expanded', nextCollapsed ? 'false' : 'true');
        toggleBtn.setAttribute('aria-label', `${nextCollapsed ? 'Expand' : 'Collapse'} ${title}`);
      }
    }
    container.querySelectorAll(`[data-leg-id="${escapedId}"]`).forEach((row) => {
      row.classList.toggle('is-collapsed', nextCollapsed);
    });
  },

  /** Bind drag-and-drop + touch reordering to waypoint list container */
  _bindWaypointReorder(container) {
    // Leg dividers are full list rows too — they must drag and be dragged-past
    // exactly like stop/via rows. sort_order is a flat list across the whole
    // trip, so leaving dividers out of these selectors would silently reset
    // their position (and drop them from persistCurrentOrder's payload)
    // every time an unrelated stop was reordered elsewhere in the list.
    const ROW_SELECTOR = '.waypoint-item, .leg-divider';
    const ROW_SELECTOR_NOT_DRAGGING = '.waypoint-item:not(.dragging), .leg-divider:not(.dragging)';

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
      const items = Array.from(container.querySelectorAll(ROW_SELECTOR_NOT_DRAGGING));
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

    const getOrderIdsFromDom = () => Array.from(container.querySelectorAll(ROW_SELECTOR)).map((el) => el.dataset.id);

    const persistCurrentOrder = async () => {
      if (state.dropping) return;
      const orderIds = getOrderIdsFromDom().filter(Boolean);
      if (!orderIds.length) return;
      state.dropping = true;
      try { await App.reorderWaypoints(orderIds); } finally { state.dropping = false; }
    };

    // Desktop HTML5 DnD
    container.addEventListener('dragstart', (e) => {
      const item = e.target?.closest?.(ROW_SELECTOR);
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
      const overItem = e.target?.closest?.(ROW_SELECTOR);
      if (!state.draggingEl || !overItem || overItem === state.draggingEl) return;
      e.preventDefault();
      clearOver();
      const box = overItem.getBoundingClientRect();
      const isAfter = (e.clientY - box.top) > (box.height / 2);
      overItem.classList.add(isAfter ? 'drop-after' : 'drop-before');
      state.lastOverEl = overItem;
    });

    container.addEventListener('dragleave', (e) => {
      const overItem = e.target?.closest?.(ROW_SELECTOR);
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
      return handle.closest(ROW_SELECTOR);
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
      const overItem = elAtPoint?.closest?.(ROW_SELECTOR);
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
    const list = Array.isArray(entries) ? entries : [];

    // Keep photo markers on the planning map in step with the journal.
    this.refreshJournalPhotoMarkers(list);

    if (!container) return;
    if (list.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <svg viewBox="0 0 24 24"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/></svg>
          <h3>No journal entries yet</h3>
          <p>Add notes about your trip experiences</p>
        </div>
      `;
      return;
    }

    const readOnly = this.isReadOnlyTrip();

    container.innerHTML = list
      .slice()
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map(entry => {
        const id = this.escapeAttr(entry.id);
        const attachments = this.renderAttachmentsHtml(entry.attachments, { entryId: entry.id });
        return `
        <div class="journal-entry ${entry.isPrivate ? 'private' : ''}${readOnly ? ' journal-entry-readonly' : ''}" data-id="${id}">
          <div class="journal-header">
            <div class="journal-title">
              ${entry.isPrivate ? '🔒 ' : ''}${this.escapeHtml(entry.title)}
            </div>
            <div class="journal-date">${this.escapeHtml(this.formatDate(entry.createdAt))}</div>
          </div>
          <div class="journal-content">${this.escapeHtml(entry.content)}</div>
          ${attachments ? `<div class="journal-attachments">${attachments}</div>` : ''}
          ${entry.tags?.length > 0 ? `
            <div class="journal-tags">
              ${entry.tags.map(tag => `<span class="tag">${this.escapeHtml(tag)}</span>`).join('')}
            </div>
          ` : ''}
          ${readOnly ? '' : `
          <div class="journal-actions">
            <button type="button" class="icon-btn" data-action="edit" data-id="${id}" aria-label="Edit entry">
              <svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
            </button>
            <button type="button" class="icon-btn" data-action="attach" data-id="${id}" aria-label="Attach photo">📎</button>
            <button type="button" class="icon-btn" data-action="delete" data-id="${id}" aria-label="Delete entry">
              <svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
            </button>
          </div>`}
        </div>`;
      }).join('');

    container.querySelectorAll('.journal-entry').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.target?.closest?.('.journal-actions')) return;
        if (e.target?.closest?.('.attachment-thumb')) return;
        if (e.target?.closest?.('.attachment-pill')) return;
        if (readOnly) return;
        const id = el.dataset.id;
        if (id) App.startEditJournalEntry(id);
      });
    });

    container.querySelectorAll('.journal-actions [data-action]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        if (!id) return;
        if (btn.dataset.action === 'edit') { App.startEditJournalEntry(id); return; }
        if (btn.dataset.action === 'attach') { App.pickJournalAttachment(id); return; }
        this.confirmInline(btn, () => App.deleteJournalEntry(id));
      });
    });

    this.bindAttachmentRemovals(container, (attachmentId, entryId) => {
      if (attachmentId) App.deleteAttachment(attachmentId, entryId || undefined);
    });
  },

  /** Draw/refresh photo markers for the journal on the planning map. */
  refreshJournalPhotoMarkers(entries) {
    if (typeof MapManager === 'undefined' || typeof MapManager.drawJournalPhotos !== 'function') return;
    try {
      MapManager.drawJournalPhotos(Array.isArray(entries) ? entries : []);
    } catch (_) {
      // Map may not be initialised yet — markers redraw on the next render.
    }
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
      // Prefer the local count (excludes shaping points AND leg dividers via
      // this.countStops — Trip.getStats only excludes 'via'); the summary
      // endpoint only knows the raw waypoint row count.
      const stopCount = trip.waypoints.length
        ? this.countStops(trip.waypoints)
        : (Number.isFinite(trip.waypoint_count) ? trip.waypoint_count : 0);
      const journalCount = Number.isFinite(trip.journal_count) ? trip.journal_count : stats.journalCount;
      const node = template.content.cloneNode(true);
      const item = node.querySelector('.trip-item');
      item.dataset.id = trip.id;
      if (trip.id === currentTripId) item.classList.add('active');
      item.tabIndex = 0;
      // textContent takes raw text — escaping here would show the entities.
      node.querySelector('.trip-name').textContent = trip.name || 'Untitled trip';
      node.querySelector('.trip-meta').innerHTML =
        `<span>📍 ${stopCount} ${stopCount === 1 ? 'stop' : 'stops'}</span><span>📝 ${journalCount} ${journalCount === 1 ? 'note' : 'notes'}</span>`;
      const statusPill = node.querySelector('.trip-status-pill');
      const copyBtn = node.querySelector('.trip-copy-link');
      const makePublicBtn = node.querySelector('.trip-make-public');

      const link = trip.short_url || (trip.short_code ? `${window.location.origin}/${trip.short_code}` : '');
      if (trip.is_public) {
        statusPill.textContent = 'Public';
        statusPill.className = 'trip-status-pill public';
        if (copyBtn) {
          copyBtn.style.display = 'inline-flex';
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
        }
        if (makePublicBtn) makePublicBtn.style.display = 'none';
      } else {
        statusPill.textContent = 'Private';
        statusPill.className = 'trip-status-pill private';
        if (copyBtn) copyBtn.style.display = 'none';
        if (makePublicBtn) {
          makePublicBtn.style.display = 'inline-flex';
          makePublicBtn.onclick = (e) => {
            e.stopPropagation();
            App.openTripDetails(trip.id);
          };
        }
      }
      const detailsBtn = node.querySelector('.trip-details-btn');
      if (detailsBtn) {
        detailsBtn.onclick = (e) => { e.stopPropagation(); App.openTripDetails(trip.id); };
      }

      const deleteBtn = node.querySelector('.trip-delete-btn');
      if (deleteBtn) {
        deleteBtn.onclick = (e) => {
          e.stopPropagation();
          this.confirmInline(deleteBtn, () => App.deleteTrip(trip.id), { label: 'Delete?' });
        };
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

  requestTripReorder(tripId, direction) {
    App.reorderTrips(tripId, direction);
  },
});
