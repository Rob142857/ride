/**
 * Saved places — the owner's private list of places worth revisiting
 * (camp sites, showers, work spots, fuel, food). Places belong to the signed-in
 * account, not to a trip. The server enforces ownership; this module only shows
 * the current user's list and never shares it.
 */
(() => {
  const TYPES = {
    campsite: { label: 'Campsite', icon: '⛺', color: '#16a34a' },
    shower: { label: 'Shower', icon: '🚿', color: '#0ea5e9' },
    work: { label: 'Library / work spot', icon: '💻', color: '#8b5cf6' },
    fuel: { label: 'Fuel', icon: '⛽', color: '#f59e0b' },
    food: { label: 'Food', icon: '🍽️', color: '#f97316' },
    other: { label: 'Other', icon: '⭐', color: '#64748b' }
  };
  const WAYPOINT_TYPE_TO_PLACE = { lodging: 'campsite', camp: 'campsite', hotel: 'campsite', fuel: 'fuel', food: 'food' };
  const MAP_PREF_KEY = 'ride_saved_places_on_map';
  const cacheKey = userId => `ride_saved_places_cache:${userId}`;

  const el = id => document.getElementById(id);
  const node = (tag, text, className) => {
    const n = document.createElement(tag);
    if (text !== undefined && text !== null) n.textContent = text;
    if (className) n.className = className;
    return n;
  };
  const safeStorage = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } },
    remove(key) { try { localStorage.removeItem(key); } catch { /* storage unavailable */ } }
  };
  const splitList = value => String(value || '').split(',').map(s => s.trim()).filter(Boolean);
  const splitLines = value => String(value || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const stars = rating => (rating ? '★'.repeat(rating) + '☆'.repeat(5 - rating) : '');
  const money = value => Number(value).toLocaleString('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 2 });
  const safeHref = url => {
    try {
      const parsed = new URL(url);
      return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : null;
    } catch { return null; }
  };

  /** Pure filtering, kept separate so it can be tested without a DOM. */
  function filterPlaces(places, { type = '', tag = '', query = '', sort = 'recent' } = {}) {
    const q = query.trim().toLowerCase();
    const t = tag.trim().toLowerCase();
    const list = (places || []).filter(place => {
      if (type && place.type !== type) return false;
      if (t && !(place.tags || []).some(x => x.toLowerCase() === t)) return false;
      if (!q) return true;
      const hay = [place.name, place.address, place.notes, place.best_time, place.avoid, place.cost_note,
        ...(place.tags || []), ...(place.facilities || [])].filter(Boolean).join(' ').toLowerCase();
      return q.split(/\s+/).every(word => hay.includes(word));
    });
    if (sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === 'rating') list.sort((a, b) => (b.rating || 0) - (a.rating || 0) || a.name.localeCompare(b.name));
    return list;
  }

  function allTags(places) {
    const seen = new Map();
    for (const place of places || []) {
      for (const tag of place.tags || []) if (!seen.has(tag.toLowerCase())) seen.set(tag.toLowerCase(), tag);
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  }

  const SavedPlaces = {
    places: [],
    loadedFor: null,
    offline: false,
    layer: null,
    showOnMap: false,
    picking: false,
    editing: null,
    filters: { type: '', tag: '', query: '', sort: 'recent' },
    filterPlaces,
    allTags,

    init() {
      this.showOnMap = safeStorage.get(MAP_PREF_KEY) === '1';
      el('placesMenuBtn')?.addEventListener('click', () => {
        UI.closeMenu?.();
        el('sideMenu')?.classList.add('hidden');
        el('menuOverlay')?.classList.add('hidden');
        this.open();
      });
      el('closePlacesBtn')?.addEventListener('click', () => UI.switchView('map'));
      el('refreshPlacesBtn')?.addEventListener('click', () => this.load({ force: true }));
      el('placesAddMapBtn')?.addEventListener('click', () => this.startPick());
      el('placesAddHereBtn')?.addEventListener('click', () => this.addAtMyLocation());
      el('placesMapToggle')?.addEventListener('change', event => this.setShowOnMap(event.target.checked));
      el('placesExportBtn')?.addEventListener('click', () => this.exportFile());
      el('placesImportBtn')?.addEventListener('click', () => el('placesImportFile')?.click());
      el('placesImportFile')?.addEventListener('change', async event => {
        await this.importFile(event.target.files?.[0]);
        event.target.value = '';
      });
      el('placesTypeFilter')?.addEventListener('change', e => { this.filters.type = e.target.value; this.renderList(); });
      el('placesTagFilter')?.addEventListener('change', e => { this.filters.tag = e.target.value; this.renderList(); });
      el('placesSort')?.addEventListener('change', e => { this.filters.sort = e.target.value; this.renderList(); });
      el('placesSearch')?.addEventListener('input', e => { this.filters.query = e.target.value; this.renderList(); });
      el('savedPlaceForm')?.addEventListener('submit', event => { event.preventDefault(); this.saveForm(); });
      el('savedPlaceDeleteBtn')?.addEventListener('click', () => this.confirmDelete(this.editing));
      el('savedPlaceWaypoint')?.addEventListener('change', event => this.fillFromWaypoint(event.target.value));
      el('placesPickCancel')?.addEventListener('click', () => this.stopPick());
      el('waypointSaveAsPlaceBtn')?.addEventListener('click', () => {
        const id = el('waypointDetailId')?.value;
        const waypoint = App.currentTrip?.waypoints?.find(w => String(w.id) === String(id));
        if (!waypoint) return;
        UI.closeModal('waypointDetailsModal');
        this.openForm(null, { fromWaypoint: waypoint });
      });

      const toggle = el('placesMapToggle');
      if (toggle) toggle.checked = this.showOnMap;
      const typeSelect = el('placesTypeFilter');
      const formType = el('savedPlaceType');
      for (const [value, info] of Object.entries(TYPES)) {
        typeSelect?.append(new Option(`${info.icon} ${info.label}`, value));
        formType?.append(new Option(`${info.icon} ${info.label}`, value));
      }

      MapManager.map?.on('click', event => this.handleMapClick(event));
      document.addEventListener('keydown', event => { if (event.key === 'Escape' && this.picking) this.stopPick(); });
      window.addEventListener('ride:auth-expired', () => this.reset());
      window.addEventListener('ride:tripLoaded', () => { if (this.showOnMap) this.load(); });
      if (this.showOnMap) setTimeout(() => this.load(), 1500);
    },

    userId() { return App.currentUser?.id || null; },

    reset() {
      this.places = [];
      this.loadedFor = null;
      this.clearLayer();
      if (!el('placesPanel')?.classList.contains('hidden')) this.renderList();
    },

    open() {
      UI.switchView('places');
      this.renderList();
      this.load();
    },

    async load({ force = false } = {}) {
      const userId = this.userId();
      if (!userId) { this.reset(); this.renderList(); return; }
      if (!force && this.loadedFor === userId && !this.offline) { this.renderMap(); return; }
      this.setStatus('Loading your places…');
      try {
        this.places = await API.savedPlaces.list();
        this.loadedFor = userId;
        this.offline = false;
        safeStorage.set(cacheKey(userId), JSON.stringify(this.places));
        this.setStatus('');
      } catch (error) {
        if (error.status === 0) {
          const cached = safeStorage.get(cacheKey(userId));
          try { this.places = cached ? JSON.parse(cached) : []; } catch { this.places = []; }
          this.loadedFor = userId;
          this.offline = true;
          this.setStatus('Offline: showing the last copy on this device. Changes need a connection.');
        } else {
          this.setStatus(error.status === 401 ? 'Sign in to see your places.' : `Couldn't load places: ${error.message}`);
        }
      }
      this.renderList();
      this.renderMap();
    },

    setStatus(text) {
      const status = el('placesStatus');
      if (status) status.textContent = text;
    },

    renderList() {
      const list = el('placesList');
      if (!list) return;
      const userId = this.userId();
      for (const id of ['placesAddMapBtn', 'placesAddHereBtn', 'placesImportBtn', 'placesExportBtn']) {
        const button = el(id);
        if (button) button.disabled = !userId || (this.offline && id !== 'placesExportBtn');
      }
      if (!userId) {
        const empty = node('div', null, 'places-empty');
        empty.append(node('p', 'Sign in to keep a private list of camps, showers and spots worth coming back to.'));
        const signIn = node('button', 'Sign in', 'primary-btn');
        signIn.type = 'button';
        signIn.addEventListener('click', () => UI.openModal('loginModal'));
        empty.append(signIn);
        list.replaceChildren(empty);
        return;
      }

      const tagSelect = el('placesTagFilter');
      if (tagSelect) {
        const current = this.filters.tag;
        tagSelect.replaceChildren(new Option('All tags', ''), ...allTags(this.places).map(tag => new Option(`#${tag}`, tag)));
        tagSelect.value = allTags(this.places).includes(current) ? current : '';
        this.filters.tag = tagSelect.value;
      }

      const shown = filterPlaces(this.places, this.filters);
      const count = el('placesCount');
      if (count) count.textContent = this.places.length ? `${shown.length} of ${this.places.length}` : '';
      if (!this.places.length) {
        list.replaceChildren(node('p', 'No saved places yet. Add one from a map tap, your location, or a waypoint (open a waypoint and choose "Save to my Places").', 'places-empty'));
        return;
      }
      if (!shown.length) {
        list.replaceChildren(node('p', 'No places match these filters.', 'places-empty'));
        return;
      }
      list.replaceChildren(...shown.map(place => this.renderCard(place)));
    },

    renderCard(place) {
      const info = TYPES[place.type] || TYPES.other;
      const card = node('article', null, 'place-card');
      card.dataset.id = place.id;
      const head = node('div', null, 'place-card-head');
      head.append(node('span', info.icon, 'place-icon'));
      const titles = node('div', null, 'place-titles');
      titles.append(node('h3', place.name));
      const meta = [info.label, place.rating ? stars(place.rating) : null,
        place.cost_amount != null ? `${money(place.cost_amount)}${place.cost_note ? ` ${place.cost_note}` : ''}` : null]
        .filter(Boolean).join(' · ');
      titles.append(node('div', meta, 'place-meta'));
      head.append(titles);
      card.append(head);
      if (place.address) card.append(node('div', place.address, 'place-address'));
      if (place.avoid) card.append(node('div', `Avoid: ${place.avoid}`, 'place-avoid'));
      if (place.notes) card.append(node('p', place.notes, 'place-notes'));
      if (place.tags?.length) card.append(node('div', place.tags.map(t => `#${t}`).join(' '), 'place-tags'));
      const links = (place.source_links || []).map(safeHref).filter(Boolean);
      if (links.length) {
        const sources = node('div', null, 'place-sources');
        links.forEach((href, index) => {
          const link = node('a', links.length > 1 ? `Source ${index + 1}` : 'Source');
          link.href = href;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          sources.append(link);
        });
        card.append(sources);
      }

      const actions = node('div', null, 'place-actions');
      const button = (label, handler, className = 'cancel-btn') => {
        const b = node('button', label, className);
        b.type = 'button';
        b.addEventListener('click', handler);
        actions.append(b);
        return b;
      };
      button('Show on map', () => this.focus(place));
      const directions = node('a', 'Directions', 'cancel-btn');
      directions.href = `https://www.google.com/maps/dir/?api=1&destination=${place.lat},${place.lng}`;
      directions.target = '_blank';
      directions.rel = 'noopener noreferrer';
      actions.append(directions);
      button('Edit', () => this.openForm(place)).disabled = this.offline;
      button('Delete', () => this.confirmDelete(place), 'cancel-btn place-delete').disabled = this.offline;
      card.append(actions);
      return card;
    },

    /* ── Map ─────────────────────────────────────────────────────────── */

    setShowOnMap(on) {
      this.showOnMap = !!on;
      safeStorage.set(MAP_PREF_KEY, on ? '1' : '0');
      if (on) this.load(); else this.clearLayer();
    },

    clearLayer() {
      if (this.layer && MapManager.map) MapManager.map.removeLayer(this.layer);
      this.layer = null;
    },

    icon(type) {
      const info = TYPES[type] || TYPES.other;
      return L.divIcon({
        className: 'saved-place-marker',
        html: `<span style="background:${info.color}">${info.icon}</span>`,
        iconSize: [30, 30],
        iconAnchor: [15, 15],
        popupAnchor: [0, -14]
      });
    },

    popup(place) {
      const box = node('div', null, 'saved-place-popup');
      box.append(node('strong', place.name));
      const info = TYPES[place.type] || TYPES.other;
      box.append(node('div', [info.label, stars(place.rating)].filter(Boolean).join(' · ')));
      if (place.avoid) box.append(node('div', `Avoid: ${place.avoid}`));
      if (place.notes) box.append(node('div', place.notes.length > 160 ? `${place.notes.slice(0, 160)}…` : place.notes));
      if (!this.offline) {
        const edit = node('button', 'Open', 'secondary-btn');
        edit.type = 'button';
        edit.addEventListener('click', () => this.openForm(place));
        box.append(edit);
      }
      return box;
    },

    renderMap() {
      this.clearLayer();
      if (!this.showOnMap || !MapManager.map || !this.places.length) return;
      this.layer = L.layerGroup(this.places.map(place =>
        L.marker([place.lat, place.lng], { icon: this.icon(place.type), title: place.name, keyboard: true })
          .bindPopup(() => this.popup(place))
      )).addTo(MapManager.map);
    },

    focus(place) {
      if (!this.showOnMap) {
        const toggle = el('placesMapToggle');
        if (toggle) toggle.checked = true;
        this.showOnMap = true;
        safeStorage.set(MAP_PREF_KEY, '1');
        this.renderMap();
      }
      UI.switchView('map');
      MapManager.map?.setView([place.lat, place.lng], Math.max(MapManager.map.getZoom() || 0, 14));
    },

    /* ── Adding from the map, GPS or a waypoint ─────────────────────── */

    startPick() {
      if (!this.userId()) return;
      UI.switchView('map');
      MapManager.disableAddWaypointMode?.();
      this.picking = true;
      document.body.classList.add('places-pick-mode');
      el('placesPickBanner')?.classList.remove('hidden');
    },

    stopPick() {
      this.picking = false;
      document.body.classList.remove('places-pick-mode');
      el('placesPickBanner')?.classList.add('hidden');
    },

    handleMapClick(event) {
      if (!this.picking || MapManager.isAddingWaypoint) return;
      this.stopPick();
      this.openForm(null, { lat: event.latlng.lat, lng: event.latlng.lng });
    },

    async addAtMyLocation() {
      try {
        const pos = await MapManager.locateUser({ toast: true });
        this.openForm(null, { lat: pos.lat, lng: pos.lng });
      } catch { /* locateUser already explained the problem */ }
    },

    fillWaypointOptions(selectedId) {
      const select = el('savedPlaceWaypoint');
      const row = el('savedPlaceWaypointRow');
      if (!select) return;
      const waypoints = App.currentTrip?.waypoints || [];
      select.replaceChildren(new Option(waypoints.length ? 'None' : 'No waypoints in this trip', ''),
        ...waypoints.map(w => new Option(w.name || 'Waypoint', String(w.id))));
      select.value = selectedId && waypoints.some(w => String(w.id) === String(selectedId)) ? String(selectedId) : '';
      if (row) row.classList.toggle('hidden', !waypoints.length);
    },

    fillFromWaypoint(waypointId) {
      const waypoint = App.currentTrip?.waypoints?.find(w => String(w.id) === String(waypointId));
      if (!waypoint) return;
      const set = (id, value) => { const input = el(id); if (input && value != null && !input.value) input.value = value; };
      set('savedPlaceName', waypoint.name);
      el('savedPlaceLat').value = Number(waypoint.lat).toFixed(6);
      el('savedPlaceLng').value = Number(waypoint.lng).toFixed(6);
      set('savedPlaceAddress', waypoint.address && waypoint.address !== 'Dropped pin from map' ? waypoint.address : null);
      set('savedPlaceNotes', waypoint.notes);
      const mapped = WAYPOINT_TYPE_TO_PLACE[waypoint.type];
      if (mapped && el('savedPlaceType').value === 'other') el('savedPlaceType').value = mapped;
    },

    /* ── Form ────────────────────────────────────────────────────────── */

    openForm(place, prefill = {}) {
      if (!this.userId()) { UI.openModal('loginModal'); return; }
      this.editing = place || null;
      const p = place || {};
      el('savedPlaceTitle').textContent = place ? 'Edit place' : 'Save a place';
      const values = {
        savedPlaceName: p.name, savedPlaceType: p.type || 'other', savedPlaceRating: p.rating || '',
        savedPlaceLat: p.lat ?? (prefill.lat != null ? Number(prefill.lat).toFixed(6) : ''),
        savedPlaceLng: p.lng ?? (prefill.lng != null ? Number(prefill.lng).toFixed(6) : ''),
        savedPlaceAddress: p.address, savedPlaceNotes: p.notes,
        savedPlaceTags: (p.tags || []).join(', '), savedPlaceFacilities: (p.facilities || []).join(', '),
        savedPlaceCost: p.cost_amount ?? '', savedPlaceCostNote: p.cost_note, savedPlaceCostSeen: p.cost_seen_on,
        savedPlaceBestTime: p.best_time, savedPlaceAvoid: p.avoid, savedPlaceLastVisited: p.last_visited_on,
        savedPlaceLinks: (p.source_links || []).join('\n')
      };
      for (const [id, value] of Object.entries(values)) { const input = el(id); if (input) input.value = value ?? ''; }

      const linkedHere = p.trip_id && String(p.trip_id) === String(App.currentTrip?.id);
      this.fillWaypointOptions(linkedHere ? p.waypoint_id : prefill.fromWaypoint?.id);
      const linkNote = el('savedPlaceLinkNote');
      if (linkNote) linkNote.textContent = p.waypoint_id && !linkedHere ? 'Linked to a waypoint in another trip.' : '';
      if (prefill.fromWaypoint) this.fillFromWaypoint(prefill.fromWaypoint.id);

      el('savedPlaceDeleteBtn')?.classList.toggle('hidden', !place);
      el('savedPlaceMore').open = !!place;
      UI.openModal('savedPlaceModal');
      setTimeout(() => el('savedPlaceName')?.focus(), 50);
    },

    readForm() {
      const value = id => el(id)?.value ?? '';
      const place = {
        name: value('savedPlaceName').trim(),
        type: value('savedPlaceType') || 'other',
        rating: value('savedPlaceRating') ? Number(value('savedPlaceRating')) : null,
        lat: Number(value('savedPlaceLat')),
        lng: Number(value('savedPlaceLng')),
        address: value('savedPlaceAddress'),
        notes: value('savedPlaceNotes'),
        tags: splitList(value('savedPlaceTags')),
        facilities: splitList(value('savedPlaceFacilities')),
        cost_amount: value('savedPlaceCost') === '' ? null : Number(value('savedPlaceCost')),
        cost_note: value('savedPlaceCostNote'),
        cost_seen_on: value('savedPlaceCostSeen') || null,
        best_time: value('savedPlaceBestTime'),
        avoid: value('savedPlaceAvoid'),
        last_visited_on: value('savedPlaceLastVisited') || null,
        source_links: splitLines(value('savedPlaceLinks'))
      };
      const waypointId = value('savedPlaceWaypoint');
      if (waypointId && App.currentTrip?.id) {
        place.trip_id = String(App.currentTrip.id);
        place.waypoint_id = waypointId;
      } else if (!this.editing || String(this.editing.trip_id) === String(App.currentTrip?.id)) {
        // Cleared here, or never linked. A link into another trip is left alone.
        place.trip_id = null;
        place.waypoint_id = null;
      }
      return place;
    },

    async saveForm() {
      const place = this.readForm();
      if (!place.name) { UI.showToast('Give the place a name', 'error'); return; }
      if (!Number.isFinite(place.lat) || !Number.isFinite(place.lng)) { UI.showToast('Add a location (lat and lng)', 'error'); return; }
      const submit = el('savedPlaceForm')?.querySelector('[type="submit"]');
      if (submit) submit.disabled = true;
      try {
        let saved;
        try {
          saved = this.editing ? await API.savedPlaces.update(this.editing.id, place) : await API.savedPlaces.create(place);
        } catch (error) {
          // A local-only trip's waypoint can't be linked on the server; keep the place without the link.
          if (error.status !== 404 || !place.waypoint_id || (this.editing && !this.places.some(p => p.id === this.editing.id))) throw error;
          place.trip_id = null;
          place.waypoint_id = null;
          saved = this.editing ? await API.savedPlaces.update(this.editing.id, place) : await API.savedPlaces.create(place);
          UI.showToast('Saved without the waypoint link', 'info');
        }
        this.places = [saved, ...this.places.filter(p => p.id !== saved.id)];
        this.cache();
        UI.closeModal('savedPlaceModal');
        UI.showToast(this.editing ? 'Place updated' : 'Place saved', 'success');
        this.editing = null;
        this.renderList();
        this.renderMap();
      } catch (error) {
        UI.showToast(error.status === 0 ? 'Offline: place not saved' : `Couldn't save: ${error.message}`, 'error');
      } finally {
        if (submit) submit.disabled = false;
      }
    },

    async confirmDelete(place) {
      if (!place) return;
      if (!window.confirm(`Delete "${place.name}" from your places? This cannot be undone.`)) return;
      try {
        await API.savedPlaces.remove(place.id);
        this.places = this.places.filter(p => p.id !== place.id);
        this.cache();
        if (this.editing?.id === place.id) { UI.closeModal('savedPlaceModal'); this.editing = null; }
        UI.showToast('Place deleted', 'success');
        this.renderList();
        this.renderMap();
      } catch (error) {
        UI.showToast(`Couldn't delete: ${error.message}`, 'error');
      }
    },

    cache() {
      const userId = this.userId();
      if (userId) safeStorage.set(cacheKey(userId), JSON.stringify(this.places));
    },

    /* ── Export / import ─────────────────────────────────────────────── */

    async exportFile() {
      try {
        const data = this.offline
          ? { kind: 'ride-saved-places', schemaVersion: 1, exportedAt: new Date().toISOString(), places: this.places }
          : await API.savedPlaces.exportAll();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `ride-places-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
        UI.showToast(`Exported ${data.places.length} place${data.places.length === 1 ? '' : 's'} (private file)`, 'success');
      } catch (error) {
        UI.showToast(`Couldn't export: ${error.message}`, 'error');
      }
    },

    async importFile(file) {
      if (!file) return;
      let data;
      try {
        data = JSON.parse(await file.text());
      } catch {
        UI.showToast('That file is not valid JSON', 'error');
        return;
      }
      const list = Array.isArray(data) ? data : data?.places;
      if (!Array.isArray(list)) { UI.showToast('No places found in that file', 'error'); return; }
      if (!window.confirm(`Import ${list.length} place${list.length === 1 ? '' : 's'}? Places already in your list (same id) are updated; the rest are added.`)) return;
      try {
        const result = await API.savedPlaces.importAll(Array.isArray(data) ? { places: list } : data);
        UI.showToast(`Imported: ${result.created} added, ${result.updated} updated`, 'success');
        await this.load({ force: true });
      } catch (error) {
        UI.showToast(`Import failed: ${error.message}`, 'error');
      }
    }
  };

  window.SavedPlaces = SavedPlaces;
  if (typeof document !== 'undefined' && document.readyState !== 'loading') {
    setTimeout(() => SavedPlaces.init(), 0);
  } else if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(() => SavedPlaces.init(), 0));
  }
})();
