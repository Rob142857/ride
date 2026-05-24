/**
 * Share module — sharing UI, native share, link copy
 * Export/import functionality is in export-import.js
 */
const Share = {
  getShareSettings() {
    const settings = App.currentTrip?.settings || {};
    const share = App.currentTrip?.share || settings.share || {};
    return {
      includeWaypoints: share.includeWaypoints !== false,
      includeRoute: share.includeRoute !== false,
      includePublicNotes: share.includePublicNotes !== false,
      includeGallery: share.includeGallery !== false,
    };
  },

  getCurrentShareUrl() {
    const code = App.currentTrip?.shortCode || App.currentTrip?.short_code;
    return App.currentTrip?.shortUrl || App.currentTrip?.short_url || (code ? `${window.location.origin.replace(/\/$/, '')}/${code}` : '');
  },

  setShareStatus(message, tone = 'muted') {
    const status = document.getElementById('shareLinkStatus');
    if (!status) return;
    status.textContent = message || '';
    status.dataset.tone = tone;
  },

  updateShareLinkUI() {
    const input = document.getElementById('shareLink');
    const copyBtn = document.getElementById('copyLinkBtn');
    const nativeBtn = document.getElementById('shareNativeBtn');
    const isPublic = !!(App.currentTrip?.isPublic ?? App.currentTrip?.is_public);
    const shareUrl = isPublic ? this.getCurrentShareUrl() : '';

    if (input) {
      input.value = shareUrl;
      input.placeholder = isPublic ? 'Generating share link...' : 'Turn on public access to activate a link';
    }
    if (copyBtn) copyBtn.disabled = !shareUrl;
    if (nativeBtn) nativeBtn.disabled = !shareUrl;

    if (isPublic) {
      this.setShareStatus(shareUrl ? 'Public link is active.' : 'Generating public link...', shareUrl ? 'success' : 'muted');
    } else {
      this.setShareStatus('Private. Existing links are disabled until public access is turned on.', 'muted');
    }
  },

  applyShareSettingsToInputs() {
    const share = this.getShareSettings();
    const mapping = {
      shareWaypoints: 'includeWaypoints',
      shareRoute: 'includeRoute',
      sharePublicNotes: 'includePublicNotes',
      shareGallery: 'includeGallery',
    };

    Object.entries(mapping).forEach(([id, key]) => {
      const input = document.getElementById(id);
      if (input) input.checked = share[key] !== false;
    });
  },

  readShareSettingsFromInputs() {
    return {
      includeWaypoints: document.getElementById('shareWaypoints')?.checked ?? true,
      includeRoute: document.getElementById('shareRoute')?.checked ?? true,
      includePublicNotes: document.getElementById('sharePublicNotes')?.checked ?? true,
      includeGallery: document.getElementById('shareGallery')?.checked ?? true,
    };
  },

  async saveShareSettings() {
    if (!App.currentTrip) return;
    const previousShare = this.getShareSettings();
    const share = this.readShareSettingsFromInputs();
    App.currentTrip.settings = { ...(App.currentTrip.settings || {}), share };
    App.currentTrip.share = share;

    if (!App.useCloud || !App.currentUser) return;

    try {
      const updatedTrip = await API.trips.update(App.currentTrip.id, { settings: { share } });
      App.currentTrip = { ...App.currentTrip, ...updatedTrip };
      this.setShareStatus('Shared page sections saved.', 'success');
    } catch (err) {
      console.error('Failed to save share settings', err);
      UI.showToast('Failed to save shared page sections', 'error');
      App.currentTrip.settings = { ...(App.currentTrip.settings || {}), share: previousShare };
      App.currentTrip.share = previousShare;
      this.applyShareSettingsToInputs();
    }
  },

  async publishCurrentTrip(publicToggle) {
    if (!App.currentTrip) return;
    if (!App.useCloud || !App.currentUser) {
      if (publicToggle) publicToggle.checked = false;
      UI.showToast('Sign in to publish trips', 'error');
      this.updateShareLinkUI();
      return;
    }

    try {
      this.setShareStatus('Generating public link...', 'muted');
      const result = await API.trips.share(App.currentTrip.id);
      if (result?.shortCode) {
        App.currentTrip.shortCode = result.shortCode;
        App.currentTrip.short_code = result.shortCode;
        App.currentTrip.shortUrl = result.shareUrl || `${window.location.origin.replace(/\/$/, '')}/${result.shortCode}`;
        App.currentTrip.short_url = App.currentTrip.shortUrl;
      }
      App.currentTrip.isPublic = true;
      App.currentTrip.is_public = 1;
      if (publicToggle) publicToggle.checked = true;
      this.updateShareLinkUI();
      UI.showToast('Trip is now public', 'success');
    } catch (err) {
      console.error('Share link generation failed', err);
      if (publicToggle) publicToggle.checked = false;
      App.currentTrip.isPublic = false;
      App.currentTrip.is_public = 0;
      this.updateShareLinkUI();
      UI.showToast('Failed to generate share link. Check you are online and signed in.', 'error');
    }
  },

  async unpublishCurrentTrip(publicToggle) {
    if (!App.currentTrip) return;
    if (!App.useCloud || !App.currentUser) {
      if (publicToggle) publicToggle.checked = true;
      UI.showToast('Sign in to update sharing', 'error');
      this.updateShareLinkUI();
      return;
    }

    try {
      await API.trips.update(App.currentTrip.id, { is_public: false });
      App.currentTrip.isPublic = false;
      App.currentTrip.is_public = 0;
      if (publicToggle) publicToggle.checked = false;
      this.updateShareLinkUI();
      UI.showToast('Trip is now private', 'success');
    } catch (err) {
      console.error('Failed to unpublish trip', err);
      if (publicToggle) publicToggle.checked = true;
      App.currentTrip.isPublic = true;
      App.currentTrip.is_public = 1;
      this.updateShareLinkUI();
      UI.showToast('Failed to update sharing', 'error');
    }
  },

  /**
   * Open share modal and generate link
   */
  async openShareModal() {
    if (!App.currentTrip) {
      UI.showToast('No trip to share', 'error');
      return;
    }
    this.applyShareSettingsToInputs();

    const publicToggle = document.getElementById('sharePublicToggle');
    if (publicToggle) {
      publicToggle.checked = !!(App.currentTrip?.isPublic ?? App.currentTrip?.is_public);
      publicToggle.onchange = async (e) => {
        if (!App.currentTrip) { e.target.checked = !e.target.checked; return; }
        if (e.target.checked) await this.publishCurrentTrip(publicToggle);
        else await this.unpublishCurrentTrip(publicToggle);
      };
    }

    if ((App.currentTrip.isPublic || App.currentTrip.is_public) && !(App.currentTrip.shortCode || App.currentTrip.short_code)) {
      await this.publishCurrentTrip(publicToggle);
    }

    this.updateShareLinkUI();
    UI.openModal('shareModal');

    this.bindShareModalEvents();
  },

  /**
   * Bind share modal events
   */
  bindShareModalEvents() {
    // Copy link button
    document.getElementById('copyLinkBtn').onclick = () => {
      this.copyToClipboard(document.getElementById('shareLink').value);
    };

    // Native share
    document.getElementById('shareNativeBtn').onclick = () => {
      this.nativeShare();
    };

    // Export buttons
    document.getElementById('exportJsonBtn').onclick = () => {
      this.exportJSON();
    };

    document.getElementById('exportGpxBtn').onclick = () => {
      this.exportGPX();
    };

    ['shareWaypoints', 'shareRoute', 'sharePublicNotes', 'shareGallery'].forEach(id => {
      const input = document.getElementById(id);
      if (input) input.onchange = () => this.saveShareSettings();
    });
  },

  /**
   * Copy text to clipboard
   */
  async copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      UI.showToast('Link copied to clipboard', 'success');
    } catch (err) {
      // Fallback for older browsers
      const input = document.createElement('input');
      input.value = text;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
      UI.showToast('Link copied to clipboard', 'success');
    }
  },

  /**
   * Use native share API
   */
  async nativeShare() {
    if (!navigator.share) {
      UI.showToast('Share not supported on this device', 'error');
      return;
    }

    const trip = App.currentTrip;
    const shareUrl = document.getElementById('shareLink').value;
    
    const includeWaypoints = document.getElementById('shareWaypoints').checked;
    const includeRoute = document.getElementById('shareRoute').checked;
    const includeNotes = document.getElementById('sharePublicNotes').checked;

    // Create share data
    const shareData = Trip.getShareableData(trip, {
      includeWaypoints,
      includeRoute,
      includePublicNotes: includeNotes
    });

    let shareText = `Check out my trip: ${trip.name}`;
    if (shareData.stats.waypointCount > 0) {
      shareText += `\n📍 ${shareData.stats.waypointCount} waypoints`;
    }
    if (shareData.stats.publicNotesCount > 0) {
      shareText += `\n📝 ${shareData.stats.publicNotesCount} notes`;
    }

    try {
      await navigator.share({
        title: trip.name,
        text: shareText,
        url: shareUrl
      });
      UI.showToast('Shared successfully', 'success');
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('Share failed:', err);
      }
    }
  },

  /**
   * Load shared trip from URL
   */
  loadSharedTrip(shareId) {
    // Cloud trips are loaded via API in app-core.js loadSharedTrip()
    // This local fallback checks localStorage for any trip with this share ID
    const trips = Storage.getTrips();
    const trip = trips.find(t => (t.shareId || t.shortCode || t.share_id || t.short_code) === shareId);
    
    if (trip) {
      return Trip.getShareableData(trip, {
        includeWaypoints: true,
        includeRoute: true,
        includePublicNotes: true
      });
    }
    
    return null;
  },

};

// Make available globally
window.Share = Share;
