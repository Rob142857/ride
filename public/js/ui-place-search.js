/**
 * UI Place Search — Google Places proxy search modal
 * Extracted from ui.js for clarity.
 * Extends UI object.
 */
Object.assign(UI, {
  bindPlaceSearch() {
    const openBtn = document.getElementById('searchPlaceBtn');
    const input = document.getElementById('placeSearchInput');
    const submit = document.getElementById('placeSearchSubmit');
    const resultsEl = document.getElementById('placeSearchResults');
    const statusEl = document.getElementById('placeSearchStatus');
    const useLocationBtn = document.getElementById('placeUseCurrentLocation');

    if (!openBtn || !input || !submit || !resultsEl || !statusEl) return;

    openBtn.addEventListener('click', () => {
      const address = document.getElementById('waypointAddress')?.value || '';
      input.value = address;
      this.placeSearchBias = null;
      this.placeSearchResults = [];
      statusEl.textContent = 'Type a search to begin.';
      resultsEl.innerHTML = '<div class="microcopy">Search returns up to 12 places.</div>';
      this.openModal('placeSearchModal');
      setTimeout(() => input.focus(), 80);
    });

    submit.addEventListener('click', () => this.performPlaceSearch());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.performPlaceSearch();
      }
    });

    if (useLocationBtn) {
      useLocationBtn.addEventListener('click', async () => {
        useLocationBtn.disabled = true;
        statusEl.textContent = 'Getting your location…';
        try {
          const coords = await this.getBrowserLocation();
          this.placeSearchBias = coords;
          statusEl.textContent = 'Location set. Searches will be biased near you.';
        } catch (err) {
          console.error('Geolocation failed', err);
          statusEl.textContent = 'Could not get location. Try again or search without it.';
        } finally {
          useLocationBtn.disabled = false;
        }
      });
    }
  },

  async performPlaceSearch() {
    const input = document.getElementById('placeSearchInput');
    const resultsEl = document.getElementById('placeSearchResults');
    const statusEl = document.getElementById('placeSearchStatus');
    if (!input || !resultsEl || !statusEl) return;

    const query = (input.value || '').trim();
    if (!query) {
      statusEl.textContent = 'Enter a business or landmark name.';
      return;
    }

    const bias = this.placeSearchBias || MapManager.map?.getCenter() || null;
    const options = bias ? { lat: bias.lat, lng: bias.lng } : {};

    statusEl.textContent = 'Searching Google Places…';
    resultsEl.innerHTML = '<div class="microcopy">Searching…</div>';

    try {
      const results = await API.places.search(query, options);
      this.placeSearchResults = results;
      if (!results || results.length === 0) {
        statusEl.textContent = 'No results found. Try another term.';
        resultsEl.innerHTML = '<div class="microcopy">Nothing matched that search.</div>';
        return;
      }
      statusEl.textContent = `Found ${results.length} place${results.length === 1 ? '' : 's'}.`;
      this.renderPlaceResults(results);
    } catch (err) {
      console.error('Place search failed', err);
      const msg = err.status === 429
        ? err.message || 'Weekly search limit reached. Resets Monday.'
        : 'Search failed. Please try again.';
      statusEl.textContent = msg;
      resultsEl.innerHTML = `<div class="microcopy error">${this.escapeHtml(msg)}</div>`;
    }
  },

  renderPlaceResults(results) {
    const resultsEl = document.getElementById('placeSearchResults');
    if (!resultsEl) return;

    resultsEl.innerHTML = results.map((place, index) => `
      <div class="place-result">
        <div class="place-result-main">
          <div class="place-name">${this.escapeHtml(place.name || 'Unnamed place')}</div>
          ${place.rating ? `<div class="place-rating">★ ${Number(place.rating).toFixed(1)}</div>` : ''}
        </div>
        <div class="place-address">${this.escapeHtml(place.address || '')}</div>
        <div class="place-actions">
          <button type="button" class="secondary-btn" data-use-place="${index}">Use for waypoint</button>
          <button type="button" class="link-btn" data-preview-place="${index}">Show on map</button>
        </div>
      </div>
    `).join('');

    resultsEl.querySelectorAll('[data-use-place]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.usePlace);
        const place = this.placeSearchResults[idx];
        if (place) this.applyPlaceToWaypoint(place);
      });
    });

    resultsEl.querySelectorAll('[data-preview-place]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.previewPlace);
        const place = this.placeSearchResults[idx];
        if (place) this.previewPlaceOnMap(place);
      });
    });
  },

  previewPlaceOnMap(place) {
    if (!place?.location) return;
    const { lat, lng } = place.location;
    MapManager.map?.setView([lat, lng], Math.max(MapManager.map.getZoom() || 12, 14));
    MapManager.showTempLocation(lat, lng);
  },

  applyPlaceToWaypoint(place) {
    if (!place?.location) return;
    const { lat, lng } = place.location;
    const nameEl = document.getElementById('waypointName');
    const addressEl = document.getElementById('waypointAddress');
    const latEl = document.getElementById('waypointLat');
    const lngEl = document.getElementById('waypointLng');

    if (nameEl) nameEl.value = place.name || 'Waypoint';
    if (addressEl) addressEl.value = place.address || '';
    if (latEl) latEl.value = lat;
    if (lngEl) lngEl.value = lng;

    this.closeModal('placeSearchModal');
    this.openModal('waypointModal');
    this.previewPlaceOnMap(place);
    UI.showToast('Place added to waypoint form', 'success');
  },

  getBrowserLocation() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('Geolocation not available'));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        (err) => reject(err),
        { enableHighAccuracy: true, timeout: 8000 }
      );
    });
  },
});
