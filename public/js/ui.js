/**
 * UI module — core DOM interactions, navigation, modals, forms, toast
 * Renderers are in ui-renderers.js, place search in ui-place-search.js
 */
const UI = {
  currentView: 'map',
  toastTimeout: null,
  placeSearchBias: null,
  placeSearchResults: [],
  authGateLastStatus: 'Signed out',
  landingGateLastShown: false,

  init() {
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
    const attachmentList = document.getElementById('noteAttachmentList');
    if (attachmentList) attachmentList.innerHTML = '<div class="microcopy">No attachments yet.</div>';
    return this;
  },

  bindLocateButton() {
    const btn = document.getElementById('locateBtn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      try {
        await MapManager.locateUser({ toast: true, animate: true });
      } catch {
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

  // Sample ride shown behind the welcome card only (decorative, not a saved trip):
  // Richmond to Lithgow by the Bells Line of Road, NSW (road-snapped via OSRM, 27 Nov 2026).
  _sampleRideCoords: [[-33.5979,150.7504],[-33.5870,150.7261],[-33.5728,150.7122],[-33.5711,150.7065],[-33.5586,150.7013],[-33.5511,150.6933],[-33.5468,150.6615],[-33.5475,150.6517],[-33.5398,150.6385],[-33.5421,150.6335],[-33.5180,150.6263],[-33.5196,150.6172],[-33.5152,150.6099],[-33.5154,150.5806],[-33.5023,150.5402],[-33.5036,150.5315],[-33.4969,150.5180],[-33.4974,150.5130],[-33.5035,150.5078],[-33.5084,150.4951],[-33.5172,150.4850],[-33.5173,150.4670],[-33.5282,150.4565],[-33.5308,150.4470],[-33.5369,150.4423],[-33.5381,150.4310],[-33.5360,150.4229],[-33.5390,150.4191],[-33.5437,150.4259],[-33.5488,150.4226],[-33.5498,150.4176],[-33.5455,150.4035],[-33.5503,150.3987],[-33.5446,150.3871],[-33.5710,150.3601],[-33.5715,150.3535],[-33.5653,150.3449],[-33.5576,150.3441],[-33.5530,150.3389],[-33.5406,150.3336],[-33.5319,150.3098],[-33.5263,150.3101],[-33.5187,150.3040],[-33.5192,150.2962],[-33.5120,150.2865],[-33.5115,150.2807],[-33.5040,150.2774],[-33.4971,150.2686],[-33.4881,150.2624],[-33.4805,150.2512],[-33.4719,150.2460],[-33.4739,150.2287],[-33.4794,150.2186],[-33.4773,150.2104],[-33.4845,150.2069],[-33.4837,150.2008],[-33.4872,150.1912],[-33.4779,150.1871],[-33.4767,150.1844],[-33.4721,150.1862],[-33.4698,150.1843],[-33.4773,150.1733],[-33.4811,150.1614],[-33.4850,150.1580]
],

  _showSampleRide() {
    try {
      const m = window.MapManager && MapManager.map;
      if (!m || this._sampleRideLayer || !window.L) return;
      this._sampleRideView = { center: m.getCenter(), zoom: m.getZoom(), view: 'trips' }; // the app opens on Trips after the welcome card
      if (this.currentView !== 'map') this.switchView('map'); // map must be visible behind the card
      const line = L.polyline(this._sampleRideCoords, { color: '#e8445f', weight: 5, opacity: 0.9, interactive: false });
      const a = this._sampleRideCoords[0];
      const b = this._sampleRideCoords[this._sampleRideCoords.length - 1];
      const dot = (p) => L.circleMarker(p, { radius: 7, color: '#fff', weight: 2, fillColor: '#e8445f', fillOpacity: 1, interactive: false });
      this._sampleRideLayer = L.layerGroup([line, dot(a), dot(b)]).addTo(m);
      if (new URLSearchParams(location.search).get('embed') === 'true') { m.removeLayer(this._sampleRideLayer); this._sampleRideLayer = null; this._sampleRideView = null; return; }
      // First visit, desktop: close the sidebar so the map is the picture (restored on Begin).
      const desktop = window.innerWidth >= 768;
      const collapse = desktop && !document.body.classList.contains('sidebar-collapsed');
      this._sampleSidebarWasOpen = collapse;
      if (collapse) document.body.classList.add('sidebar-collapsed');
      // The sidebar slides for 0.35 s and moves the map edge: measure and fit after it settles.
      const fit = () => {
        if (!this._sampleRideLayer) return;
        m.invalidateSize(false);
        const card = document.querySelector('#landingGate .landing-gate-card');
        const r = card ? card.getBoundingClientRect() : null;
        const mapBox = m.getContainer().getBoundingClientRect();
        let pad = { paddingTopLeft: [30, 100], paddingBottomRight: [30, 30] };
        if (r && !desktop) {
          pad = { paddingTopLeft: [24, 110], paddingBottomRight: [24, Math.max(30, mapBox.bottom - r.top + 16)] };
        } else if (r) {
          pad = { paddingTopLeft: [Math.max(30, r.right - mapBox.left + 30), 90], paddingBottomRight: [40, 60] };
        }
        m.fitBounds(line.getBounds(), Object.assign({ animate: false }, pad));
        this._sampleFitView = { center: m.getCenter(), zoom: m.getZoom() };
      };
      if (collapse) setTimeout(fit, 380); else fit();
    } catch (_) {}
  },

  _hideSampleRide() {
    try {
      const m = window.MapManager && MapManager.map;
      if (m && this._sampleRideLayer) m.removeLayer(this._sampleRideLayer);
      this._sampleRideLayer = null;
      if (this._sampleSidebarWasOpen) { document.body.classList.remove('sidebar-collapsed'); if (m) setTimeout(() => m.invalidateSize(false), 380); }
      this._sampleSidebarWasOpen = null;
      if (m && this._sampleRideView) {
        // Restore the old view only if nothing else (a loaded trip, a shared link) has moved the map since our fit.
        const fv = this._sampleFitView; const c = m.getCenter();
        const untouched = fv && Math.abs(c.lat - fv.center.lat) < 1e-6 && Math.abs(c.lng - fv.center.lng) < 1e-6 && m.getZoom() === fv.zoom;
        if (untouched) m.setView(this._sampleRideView.center, this._sampleRideView.zoom, { animate: false });
        if (this._sampleRideView.view && this.currentView !== this._sampleRideView.view) this.switchView(this._sampleRideView.view);
      }
      this._sampleRideView = null;
      this._sampleFitView = null;
    } catch (_) {}
  },

  showLandingGate() {
    const gate = document.getElementById('landingGate');
    if (gate) {
      this.landingGateLastShown = true;
      gate.classList.remove('hidden');
      this._showSampleRide();
    }
  },

  hideLandingGate() {
    const gate = document.getElementById('landingGate');
    if (gate) gate.classList.add('hidden');
    this._hideSampleRide();
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
      let startY = 0;
      let pulling = false;
      let triggered = false;
      const threshold = 60;

      const onStart = (e) => {
        if (el.scrollTop > 0) return;
        startY = e.touches?.[0]?.clientY ?? 0;
        pulling = true;
        triggered = false;
      };

      const onMove = (e) => {
        if (!pulling) return;
        const currentY = e.touches?.[0]?.clientY ?? 0;
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
      App.importTrip();
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
        // Sticky modals (the save-conflict choice) need an explicit answer.
        if (e.target === modal && !modal.hasAttribute('data-sticky')) {
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
   * Open modal
   */
  /**
   * "Changed on another device" choice. Autosave for the trip stays paused
   * until one of the buttons is pressed.
   */
  showTripConflictPrompt({ onReload, onKeepMine } = {}) {
    const modal = document.getElementById('tripConflictModal');
    if (!modal) { onReload?.(); return; }
    const reload = document.getElementById('tripConflictReload');
    const keep = document.getElementById('tripConflictKeep');
    if (reload) reload.onclick = () => onReload?.();
    if (keep) keep.onclick = () => onKeepMine?.();
    this.openModal('tripConflictModal');
    reload?.focus?.();
  },

  hideTripConflictPrompt() {
    this.closeModal('tripConflictModal');
  },

  openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
      // Never allow the auth gate overlay to block login.
      if (modalId === 'loginModal') {
        this.hideAuthGate();
        this.hideLandingGate();
      }
      modal.classList.remove('hidden');
    }
    this.syncModalOpenState();
  },

  /** body.modal-open while any dialog is showing (hides the install prompt). */
  syncModalOpenState() {
    try {
      const open = !!document.querySelector?.('.modal:not(.hidden)');
      document.body?.classList?.toggle('modal-open', open);
    } catch { /* Non-browser test hosts have no full DOM. */ }
  },

  /**
   * Close modal
   */
  closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
      modal.classList.add('hidden');

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
        // Drop any deferred ride-mode waypoint if the note was dismissed unsaved.
        if (App && App._pendingRideNoteWaypoint) App._pendingRideNoteWaypoint = null;
      }

      // If user dismisses login modal while still signed out, keep failing closed.
      if (modalId === 'loginModal') {
        try {
          if (!App?.currentUser || !App?.useCloud) {
            this.showAuthGate(this.authGateLastStatus || 'Signed out');
          }
        } catch (_) {
          this.showAuthGate(this.authGateLastStatus || 'Signed out');
        }
      }
    }
    this.syncModalOpenState();
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
    const address = document.getElementById('waypointAddress').value.trim();
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
    if (labelEl) labelEl.textContent = name ? 'Trip loaded' : 'Ride';
  },

  updateTripStats(trip) {
    const el = document.getElementById('tripStats');
    if (!el) return;

    const distance = trip?.route?.distance;
    const time = trip?.route?.time;

    // Header pills stay short so all three fit on a phone; the full values are in the title.
    const parts = [];
    if (typeof distance === 'number') parts.push([this.formatDistanceShort(distance), this.formatDistance(distance)]);
    if (typeof time === 'number') parts.push([this.formatDurationShort(time), this.formatDuration(time)]);

    const fuelCost = this.calcFuelCost(distance, trip);
    if (fuelCost !== null) {
      const n = Number(fuelCost);
      const short = Number.isFinite(n) && n >= 100 ? `$${Math.round(n).toLocaleString('en-AU')}` : `$${fuelCost}`;
      parts.push([short, `$${fuelCost} fuel (estimate)`]);
    }

    el.innerHTML = parts.length
      ? parts.map(([short, full]) => `<span class="trip-stat-pill" title="${full}">${short}</span>`).join('')
      : '';
  },

  // A trip's own itinerary fuel numbers win over the Settings default.
  tripFuel(trip = App.currentTrip) {
    const fuel = trip?.settings?.itinerary?.fuel;
    const rate = Number(fuel?.litresPer100Km);
    const price = Number(fuel?.pricePerLitre);
    return Number.isFinite(rate) && Number.isFinite(price) && rate > 0 && price > 0 ? { rate, price } : null;
  },

  calcFuelCost(distanceMeters, trip = App.currentTrip) {
    if (typeof distanceMeters !== 'number' || distanceMeters <= 0) return null;
    const own = this.tripFuel(trip);
    if (own) return (distanceMeters / 1000 / 100 * own.rate * own.price).toFixed(2);
    const settings = Storage.load(Storage.KEYS.SETTINGS, {});
    if (!settings.fuelEnabled) return null;
    const rate = parseFloat(settings.fuelRate);
    const price = parseFloat(settings.fuelPrice);
    if (!rate || !price || rate <= 0 || price <= 0) return null;
    const km = distanceMeters / 1000;
    return ((km / 100) * rate * price).toFixed(2);
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

    // One fuel form at a time: when the open trip has its own numbers, point to the itinerary instead.
    const own = typeof App !== 'undefined' ? this.tripFuel(App.currentTrip) : null;
    document.getElementById('fuelTripSection').classList.toggle('hidden', !own);
    document.getElementById('fuelDefaultSection').classList.toggle('hidden', !!own);
    if (own) {
      const shared = !!App.isSharedView;
      document.getElementById('fuelTripNote').textContent = `This trip's itinerary sets fuel at ${+own.rate.toFixed(1)} L/100 km and $${own.price.toFixed(2)} a litre. ${shared ? 'The trip owner sets these.' : 'Change them in Trip Itinerary.'}`;
      const editBtn = document.getElementById('fuelTripEditBtn');
      editBtn.classList.toggle('hidden', shared);
      editBtn.onclick = () => {
        modal.classList.add('hidden');
        document.getElementById('itineraryMenuBtn')?.click();
      };
    }

    document.getElementById('settingsSave').onclick = () => {
      settings.fuelEnabled = toggle.checked;
      settings.fuelRate = rateInput.value;
      settings.fuelPrice = priceInput.value;
      Storage.save(Storage.KEYS.SETTINGS, settings);
      modal.classList.add('hidden');
      this.showToast('Settings saved', 'success');
      // Refresh stats if a trip is loaded
      if (typeof App !== 'undefined' && App.currentTrip) {
        this.updateTripStats(App.currentTrip);
      }
    };

    document.getElementById('settingsCancel').onclick = () => {
      modal.classList.add('hidden');
    };

    modal.classList.remove('hidden');
  },

  formatDistance(meters) {
    if (meters === undefined || meters === null) return '';
    if (meters >= 1000) return `${(meters / 1000).toFixed(1)} km`;
    return `${Math.round(meters)} m`;
  },

  /** Header pill: whole km once a trip is 100 km or more, e.g. "7,955 km". */
  formatDistanceShort(meters) {
    if (meters === undefined || meters === null) return '';
    if (meters >= 100000) return `${Math.round(meters / 1000).toLocaleString('en-AU')} km`;
    return this.formatDistance(meters);
  },

  /** Header pill: whole hours once a trip is 10 h or more, e.g. "108 h". */
  formatDurationShort(seconds) {
    if (seconds === undefined || seconds === null) return '';
    if (seconds >= 36000) return `${Math.round(seconds / 3600)} h`;
    return this.formatDuration(seconds);
  },

  formatDuration(seconds) {
    if (seconds === undefined || seconds === null) return '';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  },

  /**
   * Show toast notification
   */
  showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = type;

    // Clear any existing timeout
    if (this.toastTimeout) {
      clearTimeout(this.toastTimeout);
    }

    // Show toast
    setTimeout(() => {
      toast.classList.remove('hidden');
    },10);

    // Hide after delay
    this.toastTimeout = setTimeout(() => {
      toast.classList.add('hidden');
    },3000);
  },

  /**
   * Escape HTML to prevent XSS
   */
  escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },

  /**
   * Format date for display
   */
  formatDate(isoString) {
    const date = new Date(isoString);
    const now = new Date();
    const diff = now - date;

    // Less than24 hours
    if (diff < 86400000) {
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
