/* Ride routing uses LRM 3.2.12's router API, without control/layer lifecycle side effects. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const requests = [], polylines = [], formatted = [];
  let gpsSuccess;
  const map = {
    zoom: 13, removed: [], getZoom() { return this.zoom; },
    on() {}, off() {}, removeLayer(layer) { this.removed.push(layer); },
    removeControl() { throw new Error('Ride navigation must not create or remove routing controls'); }
  };
  const manager = { map, OSRM_SERVICE_URL: 'https://maps.incitat.io/route/v1' };
  const context = vm.createContext({ MapManager: manager, window: {},
    App: { saveRouteData() { throw new Error('Ride guidance must not persist the planned route'); } },
    UI: { showToast() {} }, console,
    document: { addEventListener() {}, removeEventListener() {}, getElementById: () => null },
    navigator: { geolocation: { watchPosition(callback) { gpsSuccess = callback; return 1; }, clearWatch() {} } },
    setTimeout: () => 1, clearTimeout() {},
    L: {
      latLng: (lat, lng) => ({ lat, lng }),
      marker: () => ({ addTo() { return this; }, setLatLng() {}, setIcon() {} }),
      divIcon: options => options,
      polyline(coords, options) {
        const layer = { coords, options, addTo() { return this; }, setLatLngs() {}, setStyle(style) { Object.assign(this.options, style); } };
        polylines.push(layer); return layer;
      },
      Routing: {
        control() { throw new Error('A direct router must replace the temporary Routing.control'); },
        waypoint: latLng => ({ latLng, name: '', options: {} }),
        Formatter: class {
          formatInstruction(instruction, index) {
            formatted.push({ instruction, index });
            if (instruction.type === 'Invalid') throw new Error('Invalid instruction');
            return `Turn onto ${instruction.road}`;
          }
        },
        osrmv1(options) {
          assert.equal(options.serviceUrl, manager.OSRM_SERVICE_URL);
          return { route(waypoints, callback, receiver, routingOptions) {
            // LRM's OSRMv1.route requires Waypoint objects, copies their options,
            // returns an abortable XHR, and invokes callback(error, routes).
            assert.equal(waypoints.length, 2);
            waypoints.forEach(wp => { assert.ok(wp.latLng); assert.ok(wp.options); });
            const request = { waypoints, callback, receiver, routingOptions, aborted: false,
              abort() { this.aborted = true; callback.call(receiver, new Error('aborted')); }
            };
            requests.push(request); return request;
          } };
        }
      }
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/basemaps.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/map-ride.js'), 'utf8'), context);
  const result = { success: [], errors: [] };
  const requestContext = { sessionId: 'synthetic-session', tripId: 'synthetic-trip', requestId: 1 };
  const request = (details = requestContext) => manager.rerouteRideLeg(
    { lat: -33, lng: 151 }, { lat: -33.1, lng: 151.1 }, details,
    (route, received) => result.success.push({ route, context: received }),
    (error, received) => result.errors.push({ error, context: received })
  );
  return { context, manager, map, request, requests, result, requestContext, polylines, formatted, gps: () => gpsSuccess };
}

const route = { summary: { totalDistance: 250, totalTime: 45 },
  coordinates: [{ lat: -33, lng: 151 }, { lat: -33.1, lng: 151.1 }],
  instructions: [
    { text: 'Keep left', index: 0, distance: 50, time: 8 },
    { type: 'Right', road: 'Synthetic Road', index: 1, distance: 200, time: 37 }
  ]
};
let f = fixture();
const prior = { synthetic: 'previous guidance' };
f.manager._rideNavigationLayer = prior;
f.request();
assert.equal(f.manager._rideNavigationLayer, prior, 'Requesting a new leg must retain previous guidance');
assert.equal(f.map.removed.length, 0);
const first = f.requests[0];
assert.equal(first.receiver, f.manager);
assert.equal(first.routingOptions.steps, true);
first.callback.call(first.receiver, null, [route]);
assert.equal(f.result.success.length, 1);
assert.equal(f.result.errors.length, 0);
assert.equal(f.result.success[0].context, f.requestContext);
assert.equal(f.result.success[0].route.steps[0].text, 'Keep left');
assert.equal(f.result.success[0].route.steps[1].text, 'Turn onto Synthetic Road');
assert.equal(f.formatted.length, 1);
assert.equal(f.manager._pendingRideRouteRequest, null);
first.callback.call(first.receiver, new Error('duplicate callback'));
assert.equal(f.result.errors.length, 0, 'Completion must be delivered only once');

f = fixture(); f.request();
const superseded = f.requests[0];
f.request({ ...f.requestContext, requestId: 2 });
assert.equal(superseded.aborted, true);
superseded.callback(null, [route]);
assert.equal(f.result.success.length, 0);
assert.equal(f.result.errors.length, 0, 'Abort and stale callbacks must not change guidance');
const current = f.requests[1];
current.callback(null, [route]);
assert.equal(f.result.success[0].context.requestId, 2);

f = fixture(); f.request();
const exiting = f.requests[0];
f.manager.clearRideNavigationRoute();
assert.equal(exiting.aborted, true);
exiting.callback(null, [route]);
assert.equal(f.result.success.length, 0);
assert.equal(f.result.errors.length, 0);

f = fixture(); f.request();
const changedMap = f.requests[0]; f.manager.map = {};
changedMap.callback(null, [route]);
assert.equal(f.result.success.length, 0, 'A request from a prior map cannot mutate the current map');

for (const response of [{ error: new Error('offline') }, { routes: [] },
  { routes: [{ ...route, instructions: [{ type: 'Invalid' }] }] }]) {
  f = fixture(); f.manager._rideNavigationLayer = prior; f.request();
  f.requests[0].callback(response.error || null, response.routes);
  assert.equal(f.result.success.length, 0);
  assert.equal(f.result.errors.length, 1);
  assert.equal(f.result.errors[0].context, f.requestContext);
  assert.equal(f.manager._rideNavigationLayer, prior, 'Failure must leave previous guidance intact');
}

for (const zoom of [4, 13, 16, 19]) {
  f = fixture(); f.map.zoom = zoom;
  f.manager.startRide(() => {});
  f.manager.setRideNavigationRoute(route);
  const expectedWeight = zoom >= 16 ? 3 : zoom >= 13 ? 2.5 : 3;
  for (const layer of f.polylines) {
    assert.equal(layer.options.weight, expectedWeight);
    assert.equal(layer.options.opacity, 0.65);
    assert.equal(layer.options.pane, 'overlayPane', 'Ride lines stay below the road-label pane');
  }
  f.request(); const stopping = f.requests[0]; f.manager.stopRide();
  assert.equal(stopping.aborted, true, 'Stopping GPS also cancels outstanding navigation');
  stopping.callback(null, [route]);
  assert.equal(f.result.success.length, 0);
}

f = fixture();
let hiddenFixes = 0;
f.manager.startRide(() => hiddenFixes++);
f.context.document.visibilityState = 'hidden';
f.gps()({ timestamp: Date.now(), coords: { latitude: 0, longitude: 0, accuracy: 5 } });
assert.equal(hiddenFixes, 0, 'a hidden page must not advance guidance or draw unrecorded travel');
assert.equal(f.manager._rideTrailSegments[0].length, 0);
assert.equal(f.manager._lastAcceptedRideFix, undefined);

console.log('Ride map checks passed: direct router lifecycle, instruction fallback, prior guidance retained, cancellation/stale callbacks, hidden GPS pause and shared thin line styles.');
