/**
 * Settings > Devices: add a bike tracker (secret shown once, with copy), list
 * devices (name, bike, last seen, battery, armed), rename, set the bike, link a
 * trip, arm/disarm and revoke. The server enforces ownership and refuses any
 * Authorization header on these routes; this module only shows the signed-in
 * user's own devices.
 */
(() => {
  const el = id => (typeof document !== 'undefined' ? document.getElementById(id) : null);
  const node = (tag, text, className) => {
    const n = document.createElement(tag);
    if (text !== undefined && text !== null) n.textContent = text;
    if (className) n.className = className;
    return n;
  };
  const button = (text, className, onClick) => {
    const b = node('button', text, className);
    b.type = 'button';
    b.addEventListener('click', () => onClick(b));
    return b;
  };

  /** One line about a device (pure, testable). */
  function describeDevice(device, ago) {
    const parts = [];
    if (device.bike_name) parts.push(device.bike_name);
    parts.push(device.last_seen_at ? `last seen ${ago(device.last_seen_at)}` : 'not seen yet');
    if (device.last_battery !== null && device.last_battery !== undefined) parts.push(`battery ${Math.round(device.last_battery)}%`);
    if (device.status === 'active') parts.push(device.armed ? 'armed' : 'not armed');
    return parts.join(' · ');
  }

  const devices = {
    trips: [],

    init() {
      el('devicesBtn')?.addEventListener('click', () => this.open());
      el('deviceForm')?.addEventListener('submit', event => { event.preventDefault(); this.create(); });
      el('deviceSecretCopy')?.addEventListener('click', () => this.copySecret());
      el('deviceSecretDone')?.addEventListener('click', () => this.clearSecret());
      document.querySelector('#devicesModal [data-close]')?.addEventListener('click', () => this.clearSecret());
      el('devicesModal')?.addEventListener('click', event => { if (event.target === el('devicesModal')) this.clearSecret(); });
    },

    async open() {
      if (typeof App === 'undefined' || !App.currentUser) {
        UI.showToast?.('Sign in to manage devices', 'warning');
        return;
      }
      el('settingsModal')?.classList.add('hidden');
      this.clearSecret();
      UI.openModal('devicesModal');
      await this.load();
    },

    status(text) {
      const box = el('deviceStatus');
      if (box) box.textContent = text;
    },

    async load() {
      this.status('Loading…');
      try {
        const [data, trips] = await Promise.all([
          API.devices.list(),
          API.trips.list().catch(error => { console.warn('Trip list for device linking failed:', error?.message || error); return []; })
        ]);
        this.trips = trips;
        this.status(data.devices.length ? '' : 'No devices yet.');
        el('deviceList').replaceChildren(...data.devices.map(device => this.row(device)));
      } catch (error) {
        this.status(error.message || 'Could not load devices.');
      }
    },

    async change(action, failure) {
      try { await action(); await this.load(); }
      catch (error) { this.status(error.message || failure); }
    },

    tripSelect(device) {
      const select = node('select', null, 'device-trip');
      select.setAttribute('aria-label', `Trip for ${device.name}`);
      select.append(new Option('No trip linked', ''));
      for (const trip of this.trips) select.append(new Option(trip.name || 'Untitled trip', trip.id));
      if (device.trip_id && !this.trips.some(trip => trip.id === device.trip_id)) select.append(new Option('Linked trip', device.trip_id));
      select.value = device.trip_id || '';
      select.addEventListener('change', () => this.change(() => API.devices.update(device.id, { trip_id: select.value || null }), 'Could not link the trip.'));
      return select;
    },

    row(device) {
      const ago = window.RideLive?.formatAgo || (iso => new Date(iso).toLocaleString('en-AU'));
      const row = node('div', null, `token-row token-${device.status}`);
      const head = node('div', null, 'token-row-head');
      head.append(node('strong', device.name), node('span', device.status === 'revoked' ? 'revoked' : (device.armed ? 'armed' : 'active'), 'token-badge'));
      row.append(head, node('p', `${device.hint} · ${describeDevice(device, ago)}`, 'token-meta'));
      if (device.status !== 'active') return row;

      row.append(this.tripSelect(device));
      const actions = node('div', null, 'device-actions');
      actions.append(
        button('Rename', 'secondary-btn', () => {
          const name = prompt('Device name', device.name);
          if (name === null || !name.trim()) return;
          this.change(() => API.devices.update(device.id, { name: name.trim() }), 'Could not rename.');
        }),
        button('Bike', 'secondary-btn', () => {
          const bike = prompt('Bike name (leave empty to clear)', device.bike_name || '');
          if (bike === null) return;
          this.change(() => API.devices.update(device.id, { bike_name: bike.trim() || null }), 'Could not set the bike.');
        }),
        button(device.armed ? 'Disarm' : 'Arm', 'secondary-btn', b => {
          b.disabled = true;
          this.change(() => API.devices.setArmed(device.id, !device.armed), 'Could not change arming.');
        }),
        button('Revoke', 'cancel-btn token-revoke', b => {
          if (!confirm(`Revoke "${device.name}"? It stops sending positions straight away.`)) return;
          b.disabled = true;
          this.change(() => API.devices.revoke(device.id), 'Could not revoke.');
        })
      );
      row.append(actions);
      return row;
    },

    async create() {
      const name = el('deviceName').value.trim();
      if (!name) { this.status('Give the device a name.'); return; }
      el('deviceCreate').disabled = true;
      try {
        const data = await API.devices.create({ name, bikeName: el('deviceBike').value.trim() });
        el('deviceSecret').value = data.secret;
        el('deviceSecretBox').classList.remove('hidden');
        el('deviceSecretBox').scrollIntoView?.({ block: 'nearest' });
        el('deviceForm').reset();
        el('deviceSecret').select();
        await this.load();
      } catch (error) {
        this.status(error.message || 'Could not add the device.');
      } finally {
        el('deviceCreate').disabled = false;
      }
    },

    async copySecret() {
      const input = el('deviceSecret');
      try {
        await navigator.clipboard.writeText(input.value);
        el('deviceSecretCopy').textContent = 'Copied';
      } catch (error) {
        console.warn('Clipboard write failed; asking the user to copy by hand:', error?.message || error);
        input.select();
        el('deviceSecretCopy').textContent = 'Select and copy';
      }
    },

    clearSecret() {
      const input = el('deviceSecret');
      if (input) input.value = '';
      el('deviceSecretBox')?.classList.add('hidden');
      if (el('deviceSecretCopy')) el('deviceSecretCopy').textContent = 'Copy';
    }
  };

  window.RideDevices = { devices, describeDevice };
  if (typeof document !== 'undefined' && document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => devices.init());
  } else if (typeof document !== 'undefined' && document.getElementById) {
    devices.init();
  }
})();
