/**
 * Share module — sharing UI, native share, link copy
 * Export/import functionality is in export-import.js
 */
const Share = {
  /**
   * Open share modal and generate link
   */
  async openShareModal() {
    // Set public toggle state
    const publicToggle = document.getElementById('sharePublicToggle');
    publicToggle.checked = !!(App.currentTrip?.isPublic ?? App.currentTrip?.is_public);
    publicToggle.onchange = async (e) => {
      try {
        await API.trips.update(App.currentTrip.id, { is_public: e.target.checked });
        App.currentTrip.isPublic = e.target.checked;
        App.currentTrip.is_public = e.target.checked ? 1 : 0;
        UI.showToast(e.target.checked ? 'Trip is now public' : 'Trip is now private', 'success');
      } catch {
        UI.showToast('Failed to update sharing', 'error');
        publicToggle.checked = !e.target.checked;
      }
    };
    if (!App.currentTrip) {
      UI.showToast('No trip to share', 'error');
      return;
    }

    // Start with any server-provided link already on the trip (DB source)
    let shareUrl = (App.currentTrip?.shortUrl || App.currentTrip?.short_url) && (App.currentTrip.isPublic || App.currentTrip.is_public)
      ? (App.currentTrip.shortUrl || App.currentTrip.short_url)
      : '';

    // Cloud mode: only hit API if we need to create/refresh (no short code yet or not public)
    if (App.useCloud && App.currentUser && (!(App.currentTrip.shortCode || App.currentTrip.short_code) || !(App.currentTrip.isPublic || App.currentTrip.is_public))) {
      try {
        const result = await API.trips.share(App.currentTrip.id);
        if (result?.shortCode) {
          App.currentTrip.shortCode = result.shortCode;
          App.currentTrip.short_code = result.shortCode;
          const url = result.shareUrl || `${window.location.origin.replace(/\/$/, '')}/${result.shortCode}`;
          App.currentTrip.shortUrl = url;
          App.currentTrip.short_url = url;
          App.currentTrip.isPublic = true;
          App.currentTrip.is_public = 1;
          shareUrl = url;
        }
      } catch (err) {
        console.error('Share link generation failed', err);
        // If a short code already exists, fall back to it; otherwise fail loudly (no offline fallback in cloud mode)
        if (App.currentTrip?.shortCode || App.currentTrip?.short_code) {
          shareUrl = `${window.location.origin.replace(/\/$/, '')}/${App.currentTrip.shortCode || App.currentTrip.short_code}`;
        } else {
          UI.showToast('Failed to generate share link. Check you are online and signed in.', 'error');
          return;
        }
      }
    }

    // Local/offline fallback
    if (!shareUrl && App.currentTrip?.shortCode) {
      const baseUrl = window.location.origin.replace(/\/$/, '');
      shareUrl = `${baseUrl}/${App.currentTrip.shortCode}`;
    }
    if (!shareUrl) {
      UI.showToast('Unable to generate share link', 'error');
      return;
    }

    document.getElementById('shareLink').value = shareUrl;
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
