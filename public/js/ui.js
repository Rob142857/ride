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
      el.addEventListener('touchcancel', onEnd, { passive: true });
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
        setTimeout(() => MapManager.map?.invalidateSize(), 350);
      } else {
        sideMenu.classList.remove('hidden');
        menuOverlay.classList.remove('hidden');
      }
    };

    const closeMenuFn = () => {
      if (isDesktop()) {
        document.body.classList.add('sidebar-collapsed');
        setTimeout(() => MapManager.map?.invalidateSize(), 350);
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
      // TODO: Open settings modal
      this.showToast('Settings coming soon', 'info');
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
        await MapManager.locateUser({ toast: true, animate: true });
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

    const parts = [];
    if (typeof distance === 'number') parts.push(this.formatDistance(distance));
    if (typeof time === 'number') parts.push(this.formatDuration(time));

    el.innerHTML = parts.length
      ? parts.map((p) => `<span class="trip-stat-pill">${p}</span>`).join('')
      : '';
  },

  formatDistance(meters) {
    if (meters === undefined || meters === null) return '';
    if (meters >= 1000) return `${(meters / 1000).toFixed(1)} km`;
    return `${Math.round(meters)} m`;
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
    }, 10);

    // Hide after delay
    this.toastTimeout = setTimeout(() => {
      toast.classList.add('hidden');
    }, 3000);
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
    
    // Less than 24 hours
    if (diff < 86400000) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    
    // Less than 7 days
    if (diff < 604800000) {
      return date.toLocaleDateString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    }
    
    return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  }
};

// Make available globally
window.UI = UI;
