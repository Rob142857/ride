/**
 * UI module — core DOM interactions, navigation, modals, forms, toast
 * Renderers are in ui-renderers.js, place search in ui-place-search.js
 */
const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

const UI = {
  currentView: 'map',
  toastTimeout: null,
  placeSearchBias: null,
  placeSearchResults: [],
  authGateLastStatus: 'Signed out',
  landingGateLastShown: false,
  _modalStack: [],
  _modalTriggers: {},
  _defaultLoginSubtitle: '',
  _authGateWasVisible: false,

  init() {
    this._injectRuntimeStyles();
    this.bindNavigation();
    this.bindRefreshButtons();
    this.bindMenu();
    this.bindModals();
    this.bindForms();
    this.bindPullToRefresh();
    this.bindPlaceSearch();
    this.bindFullscreen();
    this.bindLocateButton();
    this.bindAuthGate();
    this.bindLandingGate();
    this._initToastA11y();
    this._bindGlobalKeys();
    this._bindLightboxDelegate();
    const loginSub = document.getElementById('loginModalSubtitle');
    this._defaultLoginSubtitle = loginSub ? loginSub.textContent : '';
    const attachmentList = document.getElementById('noteAttachmentList');
    if (attachmentList) attachmentList.innerHTML = '<div class="microcopy">No attachments yet.</div>';
    return this;
  },

  /**
   * Suggest signing in when an action genuinely needs the cloud
   * (photo upload, share links, sync). Guests keep planning locally.
   */
  suggestLogin(actionLabel = 'sync your trips') {
    const sub = document.getElementById('loginModalSubtitle');
    if (sub) {
      if (!this._defaultLoginSubtitle) this._defaultLoginSubtitle = sub.textContent;
      sub.textContent = `Sign in to ${actionLabel} — your local trips stay on this device until you sync.`;
    }
    this.openModal('loginModal');
  },

  bindLocateButton() {
    const btn = document.getElementById('locateBtn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      try {
        await MapManager.locateUser({ toast: true, animate: true });
      } catch (err) {
        // MapManager handles messaging
      }
    });

    // Initial visibility: map view only
    btn.classList.toggle('hidden', !['map', 'waypoints'].includes(this.currentView));
  },

  setWaypointPlannerState(state = 'idle', message = '') {
    const panel = document.getElementById('waypointsPanel');
    const status = document.getElementById('waypointPlannerStatus');
    if (panel) {
      panel.dataset.mode = state;
    }
    if (!status) return;

    if (message) {
      status.textContent = message;
      return;
    }

    if (state === 'pick') {
      status.textContent = 'Tap anywhere on the map to position the next waypoint.';
      return;
    }
    if (state === 'selected') {
      status.textContent = 'Pinned on the map. Add any details, then save the waypoint.';
      return;
    }
    status.textContent = 'Ready. Choose a waypoint source to begin.';
  },

  openWaypointPlaceSearch() {
    if (this.currentView !== 'waypoints') this.switchView('waypoints');
    this.openPlaceSearchModal();
    this.setWaypointPlannerState('search', 'Search for a place, preview it on the map, then apply it to the waypoint form.');
  },

  startWaypointMapPick() {
    if (!App.ensureEditable('add waypoints')) return;
    if (this.currentView !== 'map') this.switchView('map');
    MapManager.enableAddWaypointMode();
  },

  bindAuthGate() {
    const btn = document.getElementById('beginBtn');
    if (!btn) return;
    btn.addEventListener('click', () => {
      // Single entrypoint: open sign-in window (provider selection modal)
      this.hideAuthGate();
      this.openModal('loginModal');
    });
  },

  bindLandingGate() {
    const btn = document.getElementById('landingBeginBtn');
    if (!btn) return;
    btn.addEventListener('click', () => {
      try {
        localStorage.setItem('ride_landing_seen', '1');
      } catch (_) {}
      this.hideLandingGate();
      // Hand off into auth flow if needed.
      try {
        if (!App?.currentUser || !App?.useCloud) {
          this.openModal('loginModal');
        }
      } catch (_) {
        this.openModal('loginModal');
      }
    });
  },

  showLandingGate() {
    const gate = document.getElementById('landingGate');
    if (gate) {
      this.landingGateLastShown = true;
      gate.classList.remove('hidden');
    }
  },

  hideLandingGate() {
    const gate = document.getElementById('landingGate');
    if (gate) gate.classList.add('hidden');
  },

  isLandingGateVisible() {
    const gate = document.getElementById('landingGate');
    return !!gate && !gate.classList.contains('hidden');
  },

  showAuthGate(statusText = 'Signed out') {
    const gate = document.getElementById('authGate');
    const status = document.getElementById('authGateStatus');
    this.authGateLastStatus = statusText || 'Signed out';
    if (status) status.textContent = statusText;
    if (gate) gate.classList.remove('hidden');
  },

  hideAuthGate() {
    const gate = document.getElementById('authGate');
    if (gate) gate.classList.add('hidden');
  },

  isAuthGateVisible() {
    const gate = document.getElementById('authGate');
    return !!gate && !gate.classList.contains('hidden');
  },

  bindRefreshButtons() {
    const attach = (id, view) => {
      const btn = document.getElementById(id);
      if (!btn) return;
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await App.refreshData(view);
        } finally {
          btn.disabled = false;
        }
      });
    };

    attach('refreshWaypointsBtn', 'waypoints');
    attach('refreshJournalBtn', 'journal');
    attach('refreshTripsBtn', 'trips');
  },

  bindPullToRefresh() {
    const addPTR = (elementId, view) => {
      const el = document.getElementById(elementId);
      if (!el) return;
      let startY =0;
      let pulling = false;
      let triggered = false;
      const threshold =60;

      const onStart = (e) => {
        if (el.scrollTop >0) return;
        startY = e.touches?.[0]?.clientY ??0;
        pulling = true;
        triggered = false;
      };

      const onMove = (e) => {
        if (!pulling) return;
        const currentY = e.touches?.[0]?.clientY ??0;
        const delta = currentY - startY;
        if (delta > 10 && el.scrollTop <= 0) {
          // Prevent native overscroll bounce while pulling
          e.preventDefault();
        }
        if (delta > threshold && !triggered) {
          if (App.isRefreshing) return;
          triggered = true;
          App.refreshData(view);
        }
      };

      const onEnd = () => {
        pulling = false;
        triggered = false;
      };

      el.addEventListener('touchstart', onStart, { passive: true });
      el.addEventListener('touchmove', onMove, { passive: false });
      el.addEventListener('touchend', onEnd, { passive: true });
      el.addEventListener('touchcancel', onEnd, { passive:true });
    };

    addPTR('waypointsList', 'waypoints');
    addPTR('journalList', 'journal');
    addPTR('tripsList', 'trips');
  },

  /**
   * Bind bottom navigation
   */
  bindNavigation() {
    const navBtns = document.querySelectorAll('.nav-btn');
    navBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const view = btn.dataset.view;
        this.switchView(view);
      });
    });
  },

  /**
   * Switch between views
   */
  switchView(view) {
    this.currentView = view;

    // Update nav buttons
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === view);
    });

    // Hide all panels
    document.querySelectorAll('.panel').forEach(panel => {
      panel.classList.add('hidden');
    });

    // Show selected panel (except map which is always visible)
    if (view !== 'map') {
      const panel = document.getElementById(`${view}Panel`);
      if (panel) {
        panel.classList.remove('hidden');
      }
    }

    if (view !== 'waypoints') {
      MapManager.disableAddWaypointMode();
    } else {
      this.setWaypointPlannerState(MapManager.isAddingWaypoint ? 'pick' : 'idle');
      this._showWaypointsHelpIfNew();
    }

    // Trigger map resize when switching to map view
    if ((view === 'map' || view === 'waypoints') && MapManager.map) {
      setTimeout(() => MapManager.map.invalidateSize(), 100);
    }

    // Floating controls: keep them for map-backed waypoint planning too
    const locateBtn = document.getElementById('locateBtn');
    if (locateBtn) {
      locateBtn.classList.toggle('hidden', !['map', 'waypoints'].includes(view));
    }
  },

  /**
   * Show the waypoints help modal once per browser/device.
   */
  _showWaypointsHelpIfNew() {
    let seen = false;
    try {
      seen = localStorage.getItem('ride_waypoints_help_seen') === '1';
    } catch (_) {}
    if (!seen) {
      this.openModal('waypointsHelpModal');
      try {
        localStorage.setItem('ride_waypoints_help_seen', '1');
      } catch (_) {}
    }
  },

  /**
   * Bind side menu
   */
  bindMenu() {
    const menuBtn = document.getElementById('menuBtn');
    const closeMenu = document.getElementById('closeMenu');
    const menuOverlay = document.getElementById('menuOverlay');
    const sideMenu = document.getElementById('sideMenu');

    const isDesktop = () => window.innerWidth >= 768;

    const openMenu = () => {
      if (isDesktop()) {
        document.body.classList.remove('sidebar-collapsed');
        setTimeout(() => MapManager.map?.invalidateSize(),350);
      } else {
        sideMenu.classList.remove('hidden');
        menuOverlay.classList.remove('hidden');
      }
    };

    const closeMenuFn = () => {
      if (isDesktop()) {
        document.body.classList.add('sidebar-collapsed');
        setTimeout(() => MapManager.map?.invalidateSize(),350);
      } else {
        sideMenu.classList.add('hidden');
        menuOverlay.classList.add('hidden');
      }
    };

    menuBtn.addEventListener('click', openMenu);
    closeMenu.addEventListener('click', closeMenuFn);
    menuOverlay.addEventListener('click', closeMenuFn);

    // Menu actions
    document.getElementById('newTripBtn').addEventListener('click', () => {
      closeMenuFn();
      App.createNewTrip();
    });

    document.getElementById('importBtn').addEventListener('click', () => {
      closeMenuFn();
      Share.startImport();
    });

    document.getElementById('exportBtn').addEventListener('click', () => {
      closeMenuFn();
      Share.exportJSON();
    });

    document.getElementById('settingsBtn').addEventListener('click', () => {
      closeMenuFn();
      this.openSettingsModal();
    });

    document.getElementById('aboutBtn').addEventListener('click', () => {
      closeMenuFn();
      window.open('/about.html', '_blank');
    });
  },

  /**
   * Bind modals
   */
  bindModals() {
    // Close buttons
    document.querySelectorAll('[data-close]').forEach(btn => {
      btn.addEventListener('click', () => {
        const modal = btn.closest('.modal');
        if (modal) {
          this.closeModal(modal.id);
        }
      });
    });

    // Close on backdrop click
    document.querySelectorAll('.modal').forEach(modal => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          this.closeModal(modal.id);
        }
      });
    });

    // Waypoints help button
    document.getElementById('waypointsHelpBtn')?.addEventListener('click', () => {
      this.openModal('waypointsHelpModal');
    });

    // Add waypoint button
    document.getElementById('addWaypointBtn').addEventListener('click', () => {
      this.startWaypointMapPick();
    });

    document.getElementById('pickWaypointOnMapBtn')?.addEventListener('click', () => {
      this.startWaypointMapPick();
    });

    document.getElementById('searchWaypointPlaceBtn')?.addEventListener('click', () => {
      if (!App.ensureEditable('add waypoints')) return;
      this.openWaypointPlaceSearch();
    });

    document.getElementById('fitWaypointsBtn')?.addEventListener('click', async () => {
      const waypoints = App.currentTrip?.waypoints || [];
      if (waypoints.length) {
        MapManager.fitToWaypoints(waypoints);
        this.setWaypointPlannerState('idle', `Showing all ${waypoints.length} waypoint${waypoints.length === 1 ? '' : 's'} on the map.`);
        return;
      }
      try {
        await MapManager.locateUser({ toast:true, animate: true });
      } catch (_) {}
    });

    // Add note button
    document.getElementById('addNoteBtn').addEventListener('click', () => {
      if (!App.ensureEditable('add notes')) return;
      const title = document.getElementById('noteModalTitle');
      if (title) title.textContent = 'Add note';
      this.openModal('noteModal');
    });

    // Share button
    document.getElementById('shareBtn').addEventListener('click', () => {
      Share.openShareModal();
    });

    // Ride button
    document.getElementById('rideBtn').addEventListener('click', () => {
      App.enterRideMode();
    });

    // Ride overlay controls moved to App.bindRideControls()
  },

  /**
   * Open modal — tracks the open stack, moves focus into the dialog.
   */
  openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    // Never allow the auth gate overlay to block login.
    if (modalId === 'loginModal') {
      this._authGateWasVisible = this.isAuthGateVisible();
      this.hideAuthGate();
      this.hideLandingGate();
    }
    if (!this._modalStack.includes(modalId)) {
      this._modalTriggers[modalId] = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      this._modalStack.push(modalId);
    }
    modal.classList.remove('hidden');
    // Move focus to the first meaningful control inside the dialog.
    setTimeout(() => {
      if (modal.classList.contains('hidden')) return;
      const content = modal.querySelector('.modal-content') || modal;
      if (content.contains(document.activeElement)) return; // something already focused it
      const focusables = this._getFocusable(content).filter(el => !el.classList.contains('modal-close'));
      const target = focusables[0];
      if (target) {
        target.focus({ preventScroll: true });
      } else {
        content.setAttribute('tabindex', '-1');
        content.focus({ preventScroll: true });
      }
    }, 30);
  },

  /**
   * Close modal — restores focus to the element that opened it.
   */
  closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
      modal.classList.add('hidden');

      const stackIdx = this._modalStack.lastIndexOf(modalId);
      if (stackIdx >= 0) this._modalStack.splice(stackIdx, 1);

      // Reset forms
      const form = modal.querySelector('form');
      if (form) form.reset();

      // Disable waypoint mode if it was the waypoint modal
      if (modalId === 'waypointModal') {
        MapManager.disableAddWaypointMode();
      }
      if (modalId === 'noteModal') {
        const attachmentList = document.getElementById('noteAttachmentList');
        if (attachmentList) attachmentList.innerHTML = '<div class="microcopy">No attachments yet.</div>';
        const title = document.getElementById('noteModalTitle');
        if (title) title.textContent = 'Add note';
        const fileName = document.getElementById('journalAttachmentFileName');
        if (fileName) fileName.textContent = '';
        // Drop any deferred ride-mode waypoint / pending photo if dismissed unsaved.
        if (typeof App !== 'undefined') {
          if (App._pendingRideNoteWaypoint) App._pendingRideNoteWaypoint = null;
          App._pendingNoteFile = null;
        }
      }

      if (modalId === 'loginModal') {
        // Restore the default subtitle after a contextual login suggestion.
        const sub = document.getElementById('loginModalSubtitle');
        if (sub && this._defaultLoginSubtitle) sub.textContent = this._defaultLoginSubtitle;
        // Only re-show the auth gate if it was covering the app before the
        // modal opened (expired session flow). Guests just keep planning.
        try {
          if (this._authGateWasVisible && (!App?.currentUser || !App?.useCloud)) {
            this.showAuthGate(this.authGateLastStatus || 'Signed out');
          }
        } catch (_) {}
        this._authGateWasVisible = false;
      }

      // Return focus to whatever opened the dialog.
      const trigger = this._modalTriggers[modalId];
      delete this._modalTriggers[modalId];
      if (this._modalStack.length === 0 && trigger && document.contains(trigger)) {
        try { trigger.focus({ preventScroll: true }); } catch (_) {}
      }
    }
  },

  /** Focusable elements within a container (visible only). */
  _getFocusable(root) {
    if (!root) return [];
    return Array.from(root.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter(el => el.offsetParent !== null || el === document.activeElement);
  },

  /** Global keyboard handling: Escape closes topmost layer; Tab is trapped in modals. */
  _bindGlobalKeys() {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (this._lightboxEl && this._lightboxEl.style.display !== 'none') {
          e.preventDefault();
          this.closeLightbox();
          return;
        }
        const top = this._modalStack[this._modalStack.length - 1];
        if (top) {
          e.preventDefault();
          this.closeModal(top);
          return;
        }
        if (typeof MapManager !== 'undefined' && MapManager.isAddingWaypoint) {
          MapManager.disableAddWaypointMode();
          this.setWaypointPlannerState('idle');
        }
        return;
      }
      if (e.key === 'Tab') {
        const top = this._modalStack[this._modalStack.length - 1];
        if (!top) return;
        const modal = document.getElementById(top);
        if (!modal || modal.classList.contains('hidden')) return;
        const content = modal.querySelector('.modal-content') || modal;
        const focusables = this._getFocusable(content);
        if (!focusables.length) { e.preventDefault(); return; }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        if (e.shiftKey) {
          if (active === first || !content.contains(active)) { e.preventDefault(); last.focus(); }
        } else if (active === last || !content.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    });
  },

  /* ── Photo lightbox (tap-to-zoom) ─────────────────────────────── */

  /** Capture-phase delegate: any element with data-lightbox-src opens the viewer. */
  _bindLightboxDelegate() {
    document.addEventListener('click', (e) => {
      const el = e.target?.closest?.('[data-lightbox-src]');
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      this.openLightbox(el.dataset.lightboxSrc, el.dataset.lightboxAlt || '');
    }, true);
  },

  openLightbox(src, alt = '') {
    if (!src) return;
    if (!this._lightboxEl) {
      const overlay = document.createElement('div');
      overlay.id = 'photoLightbox';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-label', 'Photo viewer');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:5000;display:none;align-items:center;justify-content:center;background:rgba(7,9,20,0.94);cursor:zoom-out;padding:16px;';
      const img = document.createElement('img');
      img.style.cssText = 'max-width:94vw;max-height:88vh;object-fit:contain;border-radius:10px;box-shadow:var(--shadow-3);';
      const close = document.createElement('button');
      close.type = 'button';
      close.setAttribute('aria-label', 'Close photo');
      close.textContent = '×';
      close.style.cssText = 'position:absolute;top:calc(var(--safe-area-top, 0px) + 14px);right:18px;width:44px;height:44px;border-radius:999px;border:1px solid var(--border-elegant);background:var(--bg-glass);color:var(--text-primary);font-size:26px;line-height:1;cursor:pointer;';
      overlay.appendChild(img);
      overlay.appendChild(close);
      overlay.addEventListener('click', () => this.closeLightbox());
      document.body.appendChild(overlay);
      this._lightboxEl = overlay;
      this._lightboxImg = img;
      this._lightboxClose = close;
    }
    this._lightboxImg.src = src;
    this._lightboxImg.alt = alt || 'Photo';
    this._lightboxReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this._lightboxEl.style.display = 'flex';
    setTimeout(() => { try { this._lightboxClose.focus({ preventScroll: true }); } catch (_) {} }, 30);
  },

  closeLightbox() {
    if (!this._lightboxEl) return;
    this._lightboxEl.style.display = 'none';
    this._lightboxImg.removeAttribute('src');
    if (this._lightboxReturnFocus && document.contains(this._lightboxReturnFocus)) {
      try { this._lightboxReturnFocus.focus({ preventScroll: true }); } catch (_) {}
    }
    this._lightboxReturnFocus = null;
  },

  /**
   * Bind forms
   */
  bindForms() {
    // Waypoint form
    document.getElementById('waypointForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      await this.handleWaypointSubmit();
    });

    // Note form
    document.getElementById('noteForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      await this.handleNoteSubmit();
    });
  },

  /**
   * Handle waypoint form submit
   */
  async handleWaypointSubmit() {
    if (!App.ensureEditable('add waypoints')) return;
    const name = document.getElementById('waypointName').value.trim();
    let address = document.getElementById('waypointAddress').value.trim();
    // Never persist the map-pick placeholder as a real address.
    if (/^dropped pin from map$/i.test(address)) address = '';
    const lat = parseFloat(document.getElementById('waypointLat').value);
    const lng = parseFloat(document.getElementById('waypointLng').value);
    const type = document.getElementById('waypointType').value;
    const notes = document.getElementById('waypointNotes').value.trim();

    // Validate coordinates
    if (isNaN(lat) || isNaN(lng)) {
      this.showToast('Please set location by tapping the map or entering coordinates', 'error');
      return;
    }

    const waypoint = await App.addWaypoint({ name, address, lat, lng, type, notes });
    if (waypoint) {
      this.setWaypointPlannerState('idle', `Saved ${waypoint.name || 'waypoint'} to your route.`);
      MapManager.centerOnWaypoint(waypoint);
      this.closeModal('waypointModal');
    }
  },

  /**
   * Handle note form submit
   */
  async handleNoteSubmit() {
    const title = document.getElementById('noteTitle').value.trim();
    const content = document.getElementById('noteContent').value.trim();
    const isPrivate = document.getElementById('notePrivate').checked;
    const tagsStr = document.getElementById('noteTags').value.trim();
    const entryId = document.getElementById('noteEntryId').value.trim();
    const tags = tagsStr ? tagsStr.split(',').map(t => t.trim()).filter(t => t) : [];

    const allowed = App.ensureEditable(entryId ? 'update notes' : 'add a note');
    if (!allowed) return;

    const result = entryId
      ? await App.updateJournalEntry(entryId, { title, content, isPrivate, tags })
      : await App.addJournalEntry({ title, content, isPrivate, tags });

    if (result) {
      // A photo chosen before the note existed is uploaded now that we
      // have the new entry's id (see bindJournalAttachmentPicker).
      if (!entryId && App._pendingNoteFile && result.id) {
        const pending = App._pendingNoteFile;
        App._pendingNoteFile = null;
        await App.uploadJournalAttachment(result.id, pending);
      }
      // If a ride-mode waypoint creation was deferred until note save,
      // commit it now and tag the note's title with the GPS coords.
      if (!entryId && App.isRiding && App._pendingRideNoteWaypoint) {
        const pos = App._pendingRideNoteWaypoint;
        App._pendingRideNoteWaypoint = null;
        try { await App._insertWaypointAtPosition(pos); } catch (_) {}
      }
      this.closeModal('noteModal');
      this.showToast(entryId ? 'Note updated' : 'Note added', 'success');
    }
  },

  /**
   * Bind fullscreen toggle
   */
  bindFullscreen() {
    const btn = document.getElementById('fullscreenBtn');
    btn.addEventListener('click', () => {
      this.toggleFullscreen();
    });

    // Update button icon based on fullscreen state
    document.addEventListener('fullscreenchange', () => {
      this.updateFullscreenButton();
    });
  },

  /**
   * Toggle fullscreen mode
   */
  toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(err => {
        console.log('Fullscreen error:', err);
      });
    } else {
      document.exitFullscreen();
    }
  },

  /**
   * Update fullscreen button icon
   */
  updateFullscreenButton() {
    const btn = document.getElementById('fullscreenBtn');
    if (document.fullscreenElement) {
      btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>';
    } else {
      btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>';
    }
  },

  /**
   * Update trip title and label
   */
  updateTripTitle(name) {
    const titleEl = document.getElementById('tripTitle');
    const labelEl = document.getElementById('tripLabel');
    if (titleEl) titleEl.textContent = name || 'New Trip';
    // The eyebrow only earns its line when there's no trip to name. "Trip
    // loaded" sitting above the trip's own name said nothing, and on a phone
    // it wrapped to two lines and collided with the stats row — the stats now
    // own that second line instead (see .trip-stats in css/app.css).
    if (labelEl) {
      labelEl.textContent = 'Ride';
      labelEl.classList.toggle('hidden', !!name);
    }
  },

  updateTripStats(trip) {
    const el = document.getElementById('tripStats');
    if (!el) return;

    const distance = trip?.route?.distance;
    const time = trip?.route?.time;

    const parts =[];
    if (typeof distance === 'number') parts.push(this.formatDistance(distance));
    if (typeof time === 'number') parts.push(this.formatDuration(time));

    const fuelCost = this.calcFuelCost(distance);
    if (fuelCost !== null) parts.push(`$${fuelCost}`);

    el.innerHTML = parts.length
      ? parts.map((p) => `<span class="trip-stat-pill">${p}</span>`).join('')
      : '';
  },

  calcFuelCost(distanceMeters) {
    if (typeof distanceMeters !== 'number' || distanceMeters <= 0) return null;
    const settings = Storage.load(Storage.KEYS.SETTINGS, {});
    if (!settings.fuelEnabled) return null;
    const rate = parseFloat(settings.fuelRate);
    const price = parseFloat(settings.fuelPrice);
    if (!rate || !price || rate <= 0 || price <= 0) return null;
    const km = distanceMeters / 1000;
    return ((km /100) * rate * price).toFixed(2);
  },

  openSettingsModal() {
    const modal = document.getElementById('settingsModal');
    const settings = Storage.load(Storage.KEYS.SETTINGS, {});

    const toggle = document.getElementById('fuelToggle');
    const fields = document.getElementById('fuelFields');
    const rateInput = document.getElementById('fuelRate');
    const priceInput = document.getElementById('fuelPrice');

    toggle.checked = !!settings.fuelEnabled;
    rateInput.value = settings.fuelRate || '';
    priceInput.value = settings.fuelPrice || '';
    fields.style.display = toggle.checked ? '' : 'none';

    toggle.onchange = () => { fields.style.display = toggle.checked ? '' : 'none'; };

    // --- Fuel range planning (separate global toggle; shares this modal/save button) ---
    const planToggle = document.getElementById('fuelPlanningToggle');
    const planFields = document.getElementById('fuelPlanningFields');
    const tankRangeInput = document.getElementById('fuelTankRange');
    const warnModeSelect = document.getElementById('fuelWarnMode');
    const percentNowInput = document.getElementById('fuelPercentNow');
    const percentChips = Array.from(document.querySelectorAll('#fuelPlanningFields [data-fuel-pct]'));

    planToggle.checked = !!settings.fuelPlanningEnabled;
    tankRangeInput.value = settings.fuelTankRangeKm || '';
    warnModeSelect.value = settings.fuelWarnMode || 'percent30';

    // Fuel percent lives in device-local fuel state (the bike's tank), not trip settings.
    // FuelPlanner should already be loaded (fuel.js loads before ui.js), but guard anyway.
    if (typeof FuelPlanner !== 'undefined' && FuelPlanner.getState) {
      // Rounded down for display: the stored value can be fractional (ride
      // mode banks the km burned on exit), and this input is step="1".
      // Rounding down keeps a saved value from ever inflating the tank.
      percentNowInput.value = Math.floor(FuelPlanner.getState().percent);
    } else {
      const fuelState = Storage.load(Storage.KEYS.FUEL_STATE || 'ride_fuel_state', { percent: 100 });
      percentNowInput.value = (fuelState && typeof fuelState.percent === 'number') ? fuelState.percent : 100;
    }

    // Same treatment the fuel-cost section above gets: the sub-fields are
    // hidden outright while the feature is off (a dimmed-but-visible block
    // would be the only control in this modal that behaved differently), and
    // disabled as well so nothing hidden is still focusable.
    const setPlanningDisabled = (disabled) => {
      [tankRangeInput, warnModeSelect, percentNowInput, ...percentChips].forEach((el) => { el.disabled = disabled; });
      planFields.style.display = disabled ? 'none' : '';
    };
    setPlanningDisabled(!planToggle.checked);

    planToggle.onchange = () => { setPlanningDisabled(!planToggle.checked); };

    percentChips.forEach((chip) => {
      chip.onclick = () => {
        if (chip.disabled) return;
        percentNowInput.value = chip.getAttribute('data-fuel-pct');
      };
    });

    document.getElementById('settingsSave').onclick = () => {
      settings.fuelEnabled = toggle.checked;
      settings.fuelRate = rateInput.value;
      settings.fuelPrice = priceInput.value;

      settings.fuelPlanningEnabled = planToggle.checked;
      // Stored as a real number (or '' for unset) — FuelPlanner.computeProfile
      // type-checks tankRangeKm and goes inert on a string, so the "e.g. 350"
      // the input hands back must be converted here, not by each consumer.
      const tankRangeKm = parseFloat(tankRangeInput.value);
      settings.fuelTankRangeKm = Number.isFinite(tankRangeKm) && tankRangeKm > 0 ? tankRangeKm : '';
      settings.fuelWarnMode = warnModeSelect.value || 'percent30';
      Storage.save(Storage.KEYS.SETTINGS, settings);

      const pctRaw = parseFloat(percentNowInput.value);
      const pct = isNaN(pctRaw) ? 100 : Math.max(0, Math.min(100, pctRaw));
      if (typeof FuelPlanner !== 'undefined' && FuelPlanner.setPercent) {
        FuelPlanner.setPercent(pct);
      } else {
        Storage.save(Storage.KEYS.FUEL_STATE || 'ride_fuel_state', { percent: pct, updatedAt: new Date().toISOString() });
      }
      window.dispatchEvent(new CustomEvent('ride:fuelSettingsChanged'));

      this.closeModal('settingsModal');
      this.showToast('Settings saved', 'success');
      // Refresh stats if a trip is loaded
      if (typeof App !== 'undefined' && App.currentTrip) {
        this.updateTripStats(App.currentTrip);
        // The ⛽ badges in the itinerary are gated on fuelPlanningEnabled
        // (ui-renderers.js), so flipping that toggle has to re-render the list.
        this.renderWaypoints(App.currentTrip.waypoints || []);
      }
    };

    document.getElementById('settingsCancel').onclick = () => {
      this.closeModal('settingsModal');
    };

    this.openModal('settingsModal');
  },

  formatDistance(meters) {
    if (meters === undefined || meters === null) return '';
    if (meters >= 1000) return `${(meters / 1000).toFixed(1)} km`;
    return `${Math.round(meters)} m`;
  },

  formatDuration(seconds) {
    if (seconds === undefined || seconds === null) return '';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) /60);
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  },

  /** Make toast announcements reach assistive tech. */
  _initToastA11y() {
    const toast = document.getElementById('toast');
    if (toast) {
      toast.setAttribute('role', 'status');
      toast.setAttribute('aria-live', 'polite');
    }
  },

  /**
   * Show toast notification. If one is already visible with a different
   * message, it is bumped up into a secondary slot instead of being lost
   * (so "Uploading photo…" survives a concurrent "Waypoint saved").
   */
  showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    if (!toast) return;

    if (!toast.classList.contains('hidden') && toast.textContent && toast.textContent !== message) {
      this._showSecondaryToast(toast.textContent);
    }

    toast.textContent = message;
    toast.className = `${type} hidden`;

    if (this.toastTimeout) clearTimeout(this.toastTimeout);

    // Force a reflow so the reveal transition actually plays.
    void toast.offsetHeight;
    toast.classList.remove('hidden');

    this.toastTimeout = setTimeout(() => {
      toast.classList.add('hidden');
    }, 3000);
  },

  /** Second toast slot, stacked above the primary one (max 2 visible). */
  _showSecondaryToast(message) {
    let el = document.getElementById('toastSecondary');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toastSecondary';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      el.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);' +
        'bottom:calc(var(--nav-height, 64px) + var(--safe-area-bottom, 0px) + 76px);' +
        'background:var(--bg-glass, rgba(18,22,46,0.85));color:var(--text-secondary,#aab1d0);' +
        'padding:9px 18px;border-radius:12px;border:1px solid var(--border-subtle, rgba(255,255,255,0.06));' +
        'box-shadow:var(--shadow-2);z-index:var(--z-toast, 3000);font-size:0.8rem;font-weight:500;' +
        'white-space:nowrap;max-width:92vw;overflow:hidden;text-overflow:ellipsis;';
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.style.display = 'block';
    clearTimeout(this._toastSecondaryTimer);
    this._toastSecondaryTimer = setTimeout(() => { el.style.display = 'none'; }, 2200);
  },

  /**
   * Escape HTML to prevent XSS. Quotes are escaped too, so the same helper is
   * safe inside attribute values (see escapeAttr alias).
   */
  escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>"']/g, (c) => ESCAPE_MAP[c]);
  },

  /** Alias — use at call sites that build attribute values, for intent. */
  escapeAttr(str) {
    return this.escapeHtml(str);
  },

  /** Reject javascript:/data: URLs before they reach href/src. */
  safeUrl(url) {
    const raw = String(url || '').trim();
    if (!raw) return '';
    if (/^(javascript|vbscript|data):/i.test(raw.replace(/\s/g, ''))) return '';
    return raw;
  },

  /* ── Read-only / attachment helpers (shared by all list renderers) ── */

  /** True when the loaded trip may not be mutated (shared-link viewers). */
  isReadOnlyTrip() {
    return typeof App !== 'undefined' && !!App.isSharedView;
  },

  attachmentUrl(att) {
    return this.safeUrl(att?.url || (att?.id ? `/api/attachments/${att.id}` : ''));
  },

  attachmentName(att) {
    return att?.originalName || att?.original_name || att?.filename || att?.name || 'Attachment';
  },

  isImageAttachment(att) {
    const mime = att?.mimeType || att?.mime_type || att?.contentType || att?.content_type || '';
    if (mime) return String(mime).startsWith('image/');
    return /\.(jpe?g|png|gif|webp|avif|heic|heif|bmp)$/i.test(this.attachmentName(att));
  },

  /**
   * Attachment markup shared by the journal list, the note modal and the
   * waypoint details modal: images become tappable thumbnails (lightbox via
   * the global [data-lightbox-src] delegate), other files stay as pills.
   */
  renderAttachmentsHtml(attachments, options = {}) {
    const list = (Array.isArray(attachments) ? attachments : []).filter(Boolean);
    if (!list.length) return '';
    const canRemove = options.canRemove !== false && !this.isReadOnlyTrip();
    const entryAttr = options.entryId ? ` data-entry-id="${this.escapeAttr(options.entryId)}"` : '';
    const images = list.filter((a) => this.isImageAttachment(a));
    const files = list.filter((a) => !this.isImageAttachment(a));
    let html = '';

    if (images.length) {
      html += '<div class="attachment-thumbs">' + images.map((att) => {
        const url = this.escapeAttr(this.attachmentUrl(att));
        const name = this.escapeAttr(this.attachmentName(att));
        const id = this.escapeAttr(att.id);
        return `<div class="attachment-thumb" data-attachment-id="${id}"${entryAttr}>
            <img src="${url}" alt="${name}" loading="lazy" decoding="async"
                 data-lightbox-src="${url}" data-lightbox-alt="${name}"
                 role="button" tabindex="0" aria-label="View ${name} full size">
            ${canRemove ? `<button type="button" class="attachment-thumb-remove" data-attachment-id="${id}"${entryAttr} aria-label="Remove ${name}">×</button>` : ''}
          </div>`;
      }).join('') + '</div>';
    }

    if (files.length) {
      html += files.map((att) => {
        const url = this.escapeAttr(this.attachmentUrl(att));
        const name = this.escapeHtml(this.attachmentName(att));
        const id = this.escapeAttr(att.id);
        return `<div class="attachment-pill" data-attachment-id="${id}"${entryAttr}>
            <a href="${url}" target="_blank" rel="noopener">${name}</a>
            ${canRemove ? `<button type="button" class="attachment-remove" data-attachment-id="${id}"${entryAttr} aria-label="Remove ${name}">×</button>` : ''}
          </div>`;
      }).join('');
    }

    return html;
  },

  /**
   * Wire remove buttons produced by renderAttachmentsHtml. Removal is
   * destructive, so the button arms itself first (see confirmInline).
   */
  bindAttachmentRemovals(container, onRemove) {
    if (!container || typeof onRemove !== 'function') return;
    container.querySelectorAll('.attachment-thumb-remove, .attachment-remove').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.confirmInline(btn, () => onRemove(btn.dataset.attachmentId, btn.dataset.entryId || ''), { label: 'Remove?' });
      });
    });
    container.querySelectorAll('img[data-lightbox-src]').forEach((img) => {
      img.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.openLightbox(img.dataset.lightboxSrc, img.dataset.lightboxAlt || '');
        }
      });
    });
  },

  /**
   * Two-tap delete without a blocking dialog: the button morphs into
   * "Delete?" and only the second tap within 3s commits. Nothing is
   * destroyed by a stray tap, and nothing steals focus on mobile.
   */
  confirmInline(btn, onConfirm, options = {}) {
    if (!btn || typeof onConfirm !== 'function') return;
    if (btn.dataset.confirmArmed === '1') {
      this._disarmConfirm(btn);
      onConfirm();
      return;
    }
    if (this._armedConfirmBtn && this._armedConfirmBtn !== btn) {
      this._disarmConfirm(this._armedConfirmBtn);
    }
    btn.dataset.confirmArmed = '1';
    btn.dataset.confirmHtml = btn.innerHTML;
    btn.dataset.confirmAria = btn.getAttribute('aria-label') || '';
    btn.textContent = options.label || 'Delete?';
    btn.setAttribute('aria-label', `${options.label || 'Delete?'} Activate again to confirm.`);
    btn.classList.add('is-confirming');
    this._armedConfirmBtn = btn;
    clearTimeout(this._confirmTimer);
    this._confirmTimer = setTimeout(() => this._disarmConfirm(btn), options.timeout || 3000);
  },

  _disarmConfirm(btn) {
    if (!btn || btn.dataset.confirmArmed !== '1') return;
    clearTimeout(this._confirmTimer);
    btn.innerHTML = btn.dataset.confirmHtml || '';
    if (btn.dataset.confirmAria) btn.setAttribute('aria-label', btn.dataset.confirmAria);
    btn.classList.remove('is-confirming');
    delete btn.dataset.confirmArmed;
    delete btn.dataset.confirmHtml;
    delete btn.dataset.confirmAria;
    if (this._armedConfirmBtn === btn) this._armedConfirmBtn = null;
  },

  /**
   * Styling for markup this module generates and the stylesheets don't know
   * about. Rules for classes that already exist in app.css use `:where()`
   * (zero specificity) so the stylesheet always wins; rules for classes
   * introduced here carry normal specificity so they actually apply.
   */
  _injectRuntimeStyles() {
    if (document.getElementById('rideUiRuntimeStyles')) return;
    const style = document.createElement('style');
    style.id = 'rideUiRuntimeStyles';
    style.textContent = [
      '.attachment-thumbs{display:flex;flex-wrap:wrap;gap:var(--space-2,8px);margin-top:var(--space-2,8px)}',
      '.attachment-thumb{position:relative;width:76px;height:76px;border-radius:var(--radius-sm,6px);overflow:hidden;border:1px solid var(--border-subtle,rgba(255,255,255,.06));background:var(--surface-2,#1a1f3d)}',
      '.attachment-thumb img{width:100%;height:100%;object-fit:cover;display:block;cursor:zoom-in}',
      '.attachment-thumb .attachment-thumb-remove{position:absolute;top:2px;right:2px;min-width:26px;height:26px;padding:0 6px;border:0;border-radius:var(--radius-full,999px);background:rgba(7,9,20,.74);color:var(--text-primary,#f4f5fb);font-size:15px;line-height:1;cursor:pointer}',
      '.waypoint-via-label{font-size:var(--text-xs,.75rem);color:var(--text-muted,#7e86ad);text-transform:uppercase;letter-spacing:.05em}',
      '.icon-btn.is-confirming,.link-btn.is-confirming,button.is-confirming{color:var(--danger,#ef4444);font-size:var(--text-xs,.75rem);font-weight:600;width:auto;min-width:var(--touch-target,44px);padding:0 8px;white-space:nowrap}',
      '.journal-entry-readonly .journal-actions{display:none}',
      ':where(.journal-content,.waypoint-notes){white-space:pre-wrap;overflow-wrap:anywhere}',
      ':where(.waypoint-item.is-via){opacity:.75}',
      ':where(.photo-marker-inner){display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:var(--radius-full,999px);background:var(--wp-photo,#fbbf24);color:var(--text-on-gold,#211a04);border:2px solid var(--surface-0,#0b0e1f);box-shadow:var(--shadow-1,0 1px 3px rgba(0,0,0,.28))}'
    ].join('\n');
    // Prepended so every linked stylesheet still wins a specificity tie —
    // this block is a fallback, never an override.
    document.head.insertBefore(style, document.head.firstChild);
  },

  /**
   * Format date for display
   */
  formatDate(isoString) {
    const date = new Date(isoString);
    const now = new Date();
    const diff = now - date;

    // Less than24 hours
    if (diff <86400000) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    // Less than7 days
    if (diff < 604800000) {
      return date.toLocaleDateString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    }

    return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  }
};

// Make available globally
window.UI = UI;
