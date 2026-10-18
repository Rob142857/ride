/**
 * Live trip actuals in Ride: quick "Add fill-up", one-tap "I'm here",
 * estimated range and last check-in (shown at the top of the itinerary panel),
 * plus Settings > Access tokens (create, copy once, list, revoke).
 * The server enforces ownership; this module only shows the signed-in user's data.
 */
(() => {
  const SCOPE_LABELS = {
    'trips:read': 'Read trips',
    'itinerary:write': 'Update the itinerary (planning only)',
    'waypoints:rw': 'Add, edit, reorder and delete map waypoints',
    'places:rw': 'Read and edit My Places',
    'fuel:rw': 'Read and add fuel fill-ups',
    'checkins:rw': 'Read and add check-ins and last location',
    'ridelogs:read': 'Read ride logs'
  };
  const DEFAULT_SCOPES = ['trips:read', 'fuel:rw', 'checkins:rw', 'places:rw', 'ridelogs:read'];

  const el = id => (typeof document !== 'undefined' ? document.getElementById(id) : null);
  const node = (tag, text, className) => {
    const n = document.createElement(tag);
    if (text !== undefined && text !== null) n.textContent = text;
    if (className) n.className = className;
    return n;
  };
  const money = value => '$' + Number(value).toFixed(3).replace(/0$/, '');

  /** "5 min ago", "3 h ago", "2 days ago" (pure, testable). */
  function formatAgo(iso, now = Date.now()) {
    const then = Date.parse(iso);
    if (!Number.isFinite(then)) return '';
    const minutes = Math.max(0, Math.round((now - then) / 60000));
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 36) return `${hours} h ago`;
    const days = Math.round(hours / 24);
    return `${days} day${days === 1 ? '' : 's'} ago`;
  }

  /** One line for fuel: estimated range and the latest fill. */
  function summarizeFuel(status, now = Date.now()) {
    if (!status) return 'Fuel: not loaded yet.';
    const parts = [];
    const range = status.range || {};
    if (range.known) parts.push(`About ${Number(range.est_range_left_km).toLocaleString('en-AU')} km left (~${range.est_litres_left} L, estimate)`);
    else parts.push('Range: add a full-tank fill to start the estimate');
    if (status.latest_fill) {
      const fill = status.latest_fill;
      parts.push(`last fill ${money(fill.price_per_litre)}/L${fill.full_tank ? ', full' : ''} ${formatAgo(fill.filled_at, now)}`);
    }
    return parts.join(' · ');
  }

  /** One line for location: last known location and its source. */
  function summarizeLocation(data, now = Date.now()) {
    const last = data?.last_location;
    if (!last) return "Location: no check-in yet. Tap I'm here.";
    const where = `${Number(last.lat).toFixed(3)}, ${Number(last.lng).toFixed(3)}`;
    const how = last.source === 'checkin' ? 'check-in' : 'drive mode';
    return `Last seen ${formatAgo(last.at, now)} by ${how} (${where})${last.note ? ` · ${last.note}` : ''}`;
  }

  /** Build the POST body from the form values. Returns { body } or { error }. */
  function buildFillPayload(values, position) {
    const price = Number(values.price);
    if (!Number.isFinite(price) || price <= 0 || price > 20) return { error: 'Enter the price per litre.' };
    const body = { price_per_litre: price, full_tank: !!values.full };
    const optional = { litres: values.litres, jerry_litres: values.jerryLitres, odometer_km: values.odometer };
    for (const [key, raw] of Object.entries(optional)) {
      if (raw === undefined || raw === null || String(raw).trim() === '') continue;
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) return { error: `Check the ${key.replace('_', ' ')} value.` };
      body[key] = value;
    }
    if (values.jerry) body.jerry_filled = true;
    if (values.station && values.station.trim()) body.station_name = values.station.trim();
    if (values.payment) body.payment_method = values.payment;
    if (values.notes && values.notes.trim()) body.notes = values.notes.trim();
    if (position && Number.isFinite(position.lat) && Number.isFinite(position.lng)) {
      body.lat = position.lat;
      body.lng = position.lng;
      if (Number.isFinite(position.accuracy)) body.accuracy_m = Math.round(position.accuracy);
    }
    body.id = values.clientId;
    return { body };
  }

  function clientId(prefix) {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return `${prefix}-${Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')}`;
  }

  function locate(timeout = 10000) {
    return new Promise(resolve => {
      if (typeof navigator === 'undefined' || !navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
        () => resolve(null),
        { enableHighAccuracy: true, timeout, maximumAge: 60000 }
      );
    });
  }

  const live = {
    status: null,
    location: null,
    fillPosition: null,
    fillClientId: null,
    busy: false,

    tripReady() {
      const trip = typeof App !== 'undefined' ? App.currentTrip : null;
      return trip?.id && App.currentUser && App.useCloud && !App.isSharedView ? trip : null;
    },

    init() {
      el('liveAddFillBtn')?.addEventListener('click', () => this.openFill());
      el('liveCheckinBtn')?.addEventListener('click', () => this.checkIn());
      el('fuelFillForm')?.addEventListener('submit', event => { event.preventDefault(); this.saveFill(); });
      el('accessTokensBtn')?.addEventListener('click', () => this.openTokens());
      el('accessTokenForm')?.addEventListener('submit', event => { event.preventDefault(); this.createToken(); });
      el('accessTokenCopy')?.addEventListener('click', () => this.copySecret());
      el('accessTokenDone')?.addEventListener('click', () => this.clearSecret());
      document.querySelector('#accessTokensModal [data-close]')?.addEventListener('click', () => this.clearSecret());
      el('accessTokensModal')?.addEventListener('click', event => { if (event.target === el('accessTokensModal')) this.clearSecret(); });
      document.querySelector('[data-view="itinerary"]')?.addEventListener('click', () => this.refresh());
      el('itineraryMenuBtn')?.addEventListener('click', () => this.refresh());
      window.addEventListener('ride:tripLoaded', () => this.refresh());
      window.addEventListener('ride:auth-expired', () => this.render());
      this.renderScopes();
      this.refresh();
    },

    async refresh() {
      const trip = this.tripReady();
      this.render();
      if (!trip) return;
      const [status, location] = await Promise.all([
        API.fuel.status(trip.id).catch(() => null),
        API.checkins.lastLocation(trip.id).catch(() => null)
      ]);
      if (this.tripReady()?.id !== trip.id) return;
      this.status = status;
      this.location = location;
      this.render();
    },

    render() {
      const card = el('tripLiveCard');
      if (!card) return;
      const trip = this.tripReady();
      card.classList.toggle('hidden', !trip);
      if (!trip) return;
      el('liveFuelLine').textContent = summarizeFuel(this.status);
      el('liveLocationLine').textContent = summarizeLocation(this.location);
    },

    setStatus(text) {
      const status = el('liveStatus');
      if (status) status.textContent = text || '';
    },

    async checkIn() {
      const trip = this.tripReady();
      if (!trip || this.busy) return;
      this.busy = true;
      const button = el('liveCheckinBtn');
      button.disabled = true;
      this.setStatus('Finding your location…');
      try {
        const position = await locate();
        if (!position) throw new Error('Location is off or unavailable. Allow location for Ride and try again.');
        await API.checkins.add(trip.id, { lat: position.lat, lng: position.lng, accuracy_m: Math.round(position.accuracy || 0), source: 'ride', id: clientId('ride-checkin') });
        this.setStatus(`Checked in (±${Math.round(position.accuracy || 0)} m).`);
        UI.showToast?.('Checked in', 'success');
        await this.refresh();
      } catch (error) {
        this.setStatus(error.message || 'Could not check in. Try again online.');
      } finally {
        this.busy = false;
        button.disabled = false;
      }
    },

    openFill() {
      const trip = this.tripReady();
      if (!trip) return;
      el('fuelFillForm').reset();
      el('fuelFillFull').checked = true;
      const lastPrice = this.status?.latest_fill?.price_per_litre || this.status?.planning_price_per_litre;
      if (lastPrice) el('fuelFillPrice').value = lastPrice;
      this.fillClientId = clientId('ride-fill');
      this.fillPosition = null;
      el('fuelFillLocation').textContent = 'Getting location for this fill…';
      locate(15000).then(position => {
        this.fillPosition = position;
        el('fuelFillLocation').textContent = position ? `Location attached (±${Math.round(position.accuracy || 0)} m).` : 'No location. The fill saves without one.';
      });
      UI.openModal('fuelFillModal');
      el('fuelFillPrice').focus();
    },

    async saveFill() {
      const trip = this.tripReady();
      if (!trip || this.busy) return;
      const { body, error } = buildFillPayload({
        price: el('fuelFillPrice').value, full: el('fuelFillFull').checked, litres: el('fuelFillLitres').value,
        station: el('fuelFillStation').value, jerry: el('fuelFillJerry').checked, jerryLitres: el('fuelFillJerryLitres').value,
        odometer: el('fuelFillOdometer').value, payment: el('fuelFillPayment').value, notes: el('fuelFillNotes').value,
        clientId: this.fillClientId
      }, this.fillPosition);
      if (error) { el('fuelFillLocation').textContent = error; return; }
      this.busy = true;
      el('fuelFillSave').disabled = true;
      try {
        const result = await API.fuel.add(trip.id, body);
        UI.closeModal('fuelFillModal');
        UI.showToast?.(result.planning_price_updated ? 'Fill-up saved. Planning price updated.' : 'Fill-up saved', 'success');
        if (result.planning_price_updated && Number.isFinite(result.trip_version) && App.currentTrip?.id === trip.id) {
          // Ride copied the new price into the plan and bumped the trip version: mirror it
          // here so the next itinerary edit does not hit a version conflict.
          const plan = trip.settings?.itinerary;
          if (plan) plan.fuel = { ...(plan.fuel || {}), pricePerLitre: result.fill.price_per_litre };
          trip.version = result.trip_version;
          App.cacheTripData?.(trip);
          window.RideItineraryUI?.render?.();
        }
        await this.refresh();
      } catch (err) {
        el('fuelFillLocation').textContent = err.message || 'Could not save. Try again online.';
      } finally {
        this.busy = false;
        el('fuelFillSave').disabled = false;
      }
    },

    // ---- Access tokens ----
    renderScopes() {
      const box = el('accessTokenScopes');
      if (!box) return;
      box.replaceChildren();
      for (const [scope, label] of Object.entries(SCOPE_LABELS)) {
        const row = node('label', null, 'live-check');
        const input = node('input');
        input.type = 'checkbox';
        input.value = scope;
        input.checked = DEFAULT_SCOPES.includes(scope);
        row.append(input, document.createTextNode(` ${label}`));
        box.append(row);
      }
    },

    async openTokens() {
      if (typeof App === 'undefined' || !App.currentUser) {
        UI.showToast?.('Sign in to manage access tokens', 'warning');
        return;
      }
      el('settingsModal')?.classList.add('hidden');
      this.clearSecret();
      UI.openModal('accessTokensModal');
      await this.loadTokens();
    },

    async loadTokens() {
      const list = el('accessTokenList');
      el('accessTokenStatus').textContent = 'Loading…';
      try {
        const data = await API.tokens.list();
        el('accessTokenStatus').textContent = data.tokens.length ? '' : 'No tokens yet.';
        list.replaceChildren(...data.tokens.map(token => this.tokenRow(token)));
      } catch (error) {
        el('accessTokenStatus').textContent = error.message || 'Could not load tokens.';
      }
    },

    tokenRow(token) {
      const row = node('div', null, `token-row token-${token.status}`);
      const head = node('div', null, 'token-row-head');
      head.append(node('strong', token.name), node('span', token.status, 'token-badge'));
      row.append(head);
      row.append(node('p', `${token.hint} · ${token.scopes.join(', ')}`, 'token-meta'));
      const date = iso => (iso ? new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : 'never');
      row.append(node('p', `Created ${date(token.created_at)} · last used ${date(token.last_used_at)} · ${token.status === 'revoked' ? `revoked ${date(token.revoked_at)}` : `expires ${date(token.expires_at)}`}`, 'token-meta'));
      if (token.status === 'active') {
        const revoke = node('button', 'Revoke', 'cancel-btn token-revoke');
        revoke.type = 'button';
        revoke.addEventListener('click', async () => {
          if (!confirm(`Revoke "${token.name}"? Anything using it stops working straight away.`)) return;
          revoke.disabled = true;
          try { await API.tokens.revoke(token.id); await this.loadTokens(); }
          catch (error) { el('accessTokenStatus').textContent = error.message || 'Could not revoke.'; revoke.disabled = false; }
        });
        row.append(revoke);
      }
      return row;
    },

    async createToken() {
      const name = el('accessTokenName').value.trim();
      const scopes = Array.from(document.querySelectorAll('#accessTokenScopes input:checked'), input => input.value);
      if (!name) { el('accessTokenStatus').textContent = 'Give the token a name.'; return; }
      if (!scopes.length) { el('accessTokenStatus').textContent = 'Choose at least one thing it can do.'; return; }
      el('accessTokenCreate').disabled = true;
      try {
        const data = await API.tokens.create({ name, scopes, expiresInDays: Number(el('accessTokenExpiry').value) });
        el('accessTokenSecret').value = data.secret;
        el('accessTokenSecretBox').classList.remove('hidden');
        el('accessTokenSecretBox').scrollIntoView?.({ block: 'nearest' });
        el('accessTokenForm').reset();
        this.renderScopes();
        el('accessTokenSecret').select();
        await this.loadTokens();
      } catch (error) {
        el('accessTokenStatus').textContent = error.message || 'Could not create the token.';
      } finally {
        el('accessTokenCreate').disabled = false;
      }
    },

    async copySecret() {
      const input = el('accessTokenSecret');
      try {
        await navigator.clipboard.writeText(input.value);
        el('accessTokenCopy').textContent = 'Copied';
      } catch {
        input.select();
        el('accessTokenCopy').textContent = 'Select and copy';
      }
    },

    clearSecret() {
      const input = el('accessTokenSecret');
      if (input) input.value = '';
      el('accessTokenSecretBox')?.classList.add('hidden');
      if (el('accessTokenCopy')) el('accessTokenCopy').textContent = 'Copy';
    }
  };

  window.RideLive = { live, formatAgo, summarizeFuel, summarizeLocation, buildFillPayload, SCOPE_LABELS };
  if (typeof document !== 'undefined' && document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => live.init());
  } else if (typeof document !== 'undefined' && document.getElementById) {
    live.init();
  }
})();
