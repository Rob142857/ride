const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { setImmediate } = require('node:timers');

const repo = path.resolve(__dirname, '..');
const source = name => fs.readFileSync(path.join(repo, 'public/js', name), 'utf8');

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
}

class FakeElement {
  constructor(id) {
    this.id = id;
    this.textContent = '';
    this.dataset = {};
    this.style = {};
    this.checked = false;
    this.listeners = new Map();
    const classes = new Set(['hidden']);
    this.classList = {
      add: value => classes.add(value),
      remove: value => classes.delete(value),
      contains: value => classes.has(value)
    };
    this.parentElement = null;
  }
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(callback);
  }
  removeEventListener(name, callback) {
    this.listeners.set(name, (this.listeners.get(name) || []).filter(item => item !== callback));
  }
  click() {
    for (const listener of this.listeners.get('click') || []) listener({ target: this });
    this.onclick?.({ target: this });
  }
}

function makeSession({ offline = false } = {}) {
  const elements = new Map();
  const getElementById = id => {
    if (!elements.has(id)) elements.set(id, new FakeElement(id));
    return elements.get(id);
  };
  const documentListeners = new Map();
  const document = {
    body: getElementById('body'),
    visibilityState: 'visible',
    getElementById,
    addEventListener(name, callback) { documentListeners.set(name, callback); },
    removeEventListener(name, callback) { if (documentListeners.get(name) === callback) documentListeners.delete(name); }
  };
  const localStorage = new MemoryStorage();
  const sessionStorage = new MemoryStorage();
  const pendingRoutes = [];
  const savedLogs = [];
  const mapState = { positions: [], navigationRoute: null, starts: 0, stops: 0, clears: 0 };
  let gpsStatus = null;
  const mapManager = {
    startRide(onPosition, onStatus) { mapState.starts++; this.onPosition = onPosition; gpsStatus = onStatus; },
    stopRide() { mapState.stops++; this.onPosition = null; gpsStatus = null; },
    clearRideNavigationRoute() { mapState.navigationRoute = null; mapState.clears++; },
    setRideNavigationRoute(route) { mapState.navigationRoute = route; },
    rerouteRideLeg(position, waypoint, context, onSuccess, onError) {
      pendingRoutes.push({ position: { ...position }, waypoint, context, onSuccess, onError });
    },
    drawRideLogs() {},
    recenterRide() {}
  };
  const app = {
    currentTrip: null,
    currentUser: { id: 'synthetic-user' },
    useCloud: true
  };
  const ui = {
    messages: [],
    showToast(message) { this.messages.push(message); },
    showAuthGate() {},
    openModal() {},
    renderJournal() {}
  };
  const api = {
    rideLogs: {
      async save(tripId, payload) {
        if (offline) throw new Error('offline');
        savedLogs.push({ tripId, payload });
        return { id: payload.client_log_id, success: true };
      },
      async list() { return []; }
    }
  };
  const context = {
    App: app,
    API: api,
    MapManager: mapManager,
    UI: ui,
    RideUtils: {
      haversine: (a, b) => {
        const rad = value => value * Math.PI / 180;
        const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
        const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
        return 6371000 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
      },
      formatDistance: value => `${Math.round(value)} m`,
      formatDuration: value => `${Math.round(value)} sec`
    },
    document,
    navigator: { geolocation: {} },
    localStorage,
    sessionStorage,
    console: { log() {}, warn() {}, error() {} },
    crypto: globalThis.crypto,
    setTimeout() { return 1; },
    clearTimeout() {},
    addEventListener() {},
    removeEventListener() {},
    Date,
    Math,
    Promise,
    Set,
    Map,
    WeakMap,
    Number,
    String,
    Array,
    JSON,
    Uint8Array,
    encodeURIComponent
  };
  context.window = context;
  vm.createContext(context);
  for (const filename of ['ride-recorder.js', 'ride-navigation.js', 'ride-ride-ui.js', 'ride-controller.js', 'ride-session.js']) {
    vm.runInContext(source(filename), context, { filename });
  }

  const route = {
    coordinates: [0, 0.005, 0.01, 0.015, 0.02].map(lng => ({ lat: 0, lng })),
    steps: [], distance: 2224, duration: 300
  };
  const trip = {
    id: 'trip-synthetic', name: 'Synthetic trip', route,
    waypoints: [
      { id: 'stop-1', name: 'First stop', lat: 0, lng: 0.003, order: 1 },
      { id: 'stop-2', name: 'Next stop', lat: 0, lng: 0.012, order: 2 },
      { id: 'stop-3', name: 'Final stop', lat: 0, lng: 0.018, order: 3 }
    ].map((waypoint, index) => ({ ...waypoint, order: index + 1 }))
  };
  app.currentTrip = trip;
  app.enterRideMode();

  let timestamp = Date.now();
  function fix(lat, lng) {
    timestamp += 5000;
    gpsStatus?.({ type: 'fix' });
    mapManager.onPosition?.({ lat, lng, accuracy: 5, timestamp });
  }
  function triggerOffRoute() {
    fix(0.0015, 0.008);
    fix(0.0015, 0.008);
    fix(0.0015, 0.008);
    fix(0.0015, 0.008);
  }
  function finishReroute() {
    const request = pendingRoutes.at(-1);
    assert.ok(request, 'a reroute request should be pending');
    const routeData = {
      coordinates: [request.position, { lat: request.waypoint.lat, lng: request.waypoint.lng }],
      steps: [], distance: 500, duration: 80
    };
    request.onSuccess(routeData, request.context);
    return { request, routeData };
  }
  return { context, app, api, ui, mapManager, mapState, pendingRoutes, savedLogs, localStorage, trip, fix, triggerOffRoute, finishReroute, getElementById };
}

(async function main() {
const first = makeSession();
const planBefore = JSON.stringify(first.trip.route.coordinates);
first.fix(0, 0.008);
assert.equal(first.app._rideNextWaypoint.id, 'stop-2', 'starting midway should guide to the next ordered stop');
first.triggerOffRoute();
assert.equal(first.pendingRoutes.length, 1, 'four consecutive off-route fixes should start one request');
assert.equal(first.pendingRoutes[0].waypoint.id, 'stop-2', 'reroute should target only the next stop');
first.finishReroute();
assert.equal(first.getElementById('rideDeviationBanner').classList.contains('hidden'), false, 'reroute offer should be visible');
assert.match(first.getElementById('rideDeviationText').textContent, /Taking a different road/);
assert.equal(first.app._rideNavigationRoute._planned, true, 'guidance should wait for the Update choice');
assert.equal(first.mapState.navigationRoute, null, 'a proposed detour must not draw adopted guidance');
assert.equal(JSON.stringify(first.trip.route.coordinates), planBefore, 'off-route navigation must leave the saved plan intact');
first.getElementById('rideDeviationUpdate').click();
assert.equal(first.app._rideNavigationRoute.coordinates.length, 2, 'Update should adopt the new ride guidance');
assert.equal(first.getElementById('rideUndoBanner').classList.contains('hidden'), false, 'adopting guidance should offer Undo');
first.getElementById('rideUndoButton').click();
assert.equal(first.app._rideNavigationRoute._planned, true, 'Undo should restore guidance on the original plan');
assert.equal(JSON.stringify(first.trip.route.coordinates), planBefore, 'Undo must not rewrite the saved plan');

const kept = makeSession();
const keptPlan = JSON.stringify(kept.trip.route.coordinates);
kept.fix(0, 0.008);
kept.triggerOffRoute();
kept.finishReroute();
kept.getElementById('rideDeviationKeep').click();
assert.equal(kept.getElementById('rideDeviationBanner').classList.contains('hidden'), true, 'Keep plan should dismiss the offer');
assert.equal(kept.app._rideNavigationRoute._planned, true, 'Keep plan should retain original guidance');
assert.equal(JSON.stringify(kept.trip.route.coordinates), keptPlan, 'Keep plan must leave the saved route intact');

for (const switchTrip of [false, true]) {
  const stale = makeSession();
  stale.fix(0, 0.008);
  stale.triggerOffRoute();
  const request = stale.pendingRoutes[0];
  if (switchTrip) {
    stale.app.endRideForTripSwitch();
    stale.app.currentTrip = { id: 'different-trip', route: { coordinates: [] }, waypoints: [] };
  } else {
    stale.app.exitRideMode();
  }
  const setCount = stale.mapState.clears;
  request.onSuccess({ coordinates: [request.position, request.waypoint], steps: [] }, request.context);
  assert.equal(stale.getElementById('rideDeviationBanner').classList.contains('hidden'), true, 'a stale reroute must not show a prompt');
  assert.equal(stale.mapState.clears, setCount, 'a stale reroute must not mutate map guidance');
}

const offline = makeSession({ offline: true });
offline.fix(0, 0.004);
offline.fix(0, 0.005);
offline.app._onRideGpsStatus({ type: 'error', reason: 'gps-error' });
await new Promise(resolve => setImmediate(resolve));
const pending = offline.context.RideRecorder.pendingFor('synthetic-user', 'trip-synthetic', offline.localStorage);
assert.equal(pending.length, 1, 'failed sync after GPS loss should leave a durable queued log');
assert.equal(pending[0].track.length, 2, 'the queued log should preserve both GPS fixes');

const hidden = makeSession({ offline: true });
hidden.app.enterRideMode();
hidden.fix(0, 0.008);
hidden.context.document.visibilityState = 'hidden';
hidden.app._onRideVisibilityChange();
assert.equal(hidden.mapManager._rideGapPending, true, 'even a short app switch must split the live trail');
assert.equal(hidden.app._rideRecorder.getStatus().recording, false, 'hidden recording should pause');
hidden.context.document.visibilityState = 'visible';
hidden.app._onRideVisibilityChange();
hidden.fix(0, 0.0082);
hidden.app.exitRideMode();
await Promise.resolve();
const hiddenPending = hidden.context.RideRecorder.pendingFor(hidden.app.currentUser.id, hidden.trip.id, hidden.localStorage);
assert.equal(hiddenPending.length, 2, 'the app-switch gap should remain separate in saved travel');

console.log('Ride session behavior checks passed: midpoint stop, next-stop reroute, plan preservation, Update/Keep/Undo, stale callbacks, and offline GPS recovery.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
