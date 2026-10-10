/* Focused planning and import regression checks; no production account writes. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { TextEncoder } = require('node:util');

const context = vm.createContext({ window: {}, crypto: webcrypto, TextEncoder, Uint8Array,
  Storage: { generateId: () => 'local-import-id' }, Share: {}, console,
});
for (const path of ['public/js/itinerary.js', 'public/js/trip.js', 'public/js/export-import.js']) {
  vm.runInContext(fs.readFileSync(path, 'utf8'), context, { filename: path });
}
const model = context.window.RideItinerary;
const sourcePlan = {
  version: 1, startDate: '2026-10-11', fuel: { pricePerLitre: 2.8, litresPer100Km: 10.5 },
  stops: [
    { id: 'parkes', name: 'Parkes', waypointId: 'wp1', minNights: 1, plannedNights: 3, maxNights: 5 },
    { id: 'sydney', name: 'Sydney', minNights: 2, plannedNights: 2, maxNights: 2, flexible: false, fixedDate: '2026-10-15', anchorMode: 'withinStay' },
    { id: 'hervey-bay', name: 'Hervey Bay', waypointId: 'wp2', minNights: 7, plannedNights: 14, maxNights: 21, leg: { distanceKm: 100, durationHours: 2 }, camp: { nightlyCost: 12 }, privateJournalRefs: ['j1'] },
    { id: 'return', name: 'Return stop', plannedNights: 1, arrivalDate: '2026-10-30', outreach: [
      { leadDays: 7, targetOffsetDays: 1, targetDate: '2026-10-31', dueDate: '2026-10-23', status: 'published', draftText: 'Visit on 2026-10-31' },
      { leadDays: 21, targetOffsetDays: 1, targetDate: '2026-10-31', date: '2026-10-09', scheduledDate: '2026-10-09T18:30:00+11:00', status: 'draft', textTemplate: 'Visit on {serviceDate}', draftText: 'Visit on 2026-10-31' },
    ], appointments: [{ status: 'confirmed', date: '2026-10-31' }, { status: 'draft', date: '2026-10-31' }, { status: 'draft', fixedDate: true, date: '2026-10-31' }] },
  ],
};
const calculated = model.recalculate(sourcePlan);
assert.equal(calculated.conflicts.length, 0);
assert.equal(calculated.itinerary.stops[1].arrivalDate, '2026-10-14');
assert.equal(calculated.itinerary.stops[2].departureDate, '2026-10-30');
assert.equal(calculated.totals.availableHours, 6);
assert.equal(calculated.totals.fuelCost, 29.4);
assert.equal(calculated.totals.campCost, 168);
assert.equal(model.fuelForDistance(100).litres, 10.5);
const extended = model.previewExtendStay(calculated.itinerary, 'hervey-bay');
assert.equal(extended.itinerary.stops[3].arrivalDate, '2026-10-31');
assert.equal(extended.itinerary.stops[3].outreach[0].dueDate, '2026-10-23');
assert.equal(extended.itinerary.stops[3].outreach[0].suggestedDate, '2026-10-24');
assert.equal(extended.itinerary.stops[3].outreach[0].targetDate, '2026-10-31');
assert.equal(extended.itinerary.stops[3].outreach[0].suggestedTargetDate, '2026-11-01');
assert.equal(extended.itinerary.stops[3].outreach[0].draftText, 'Visit on 2026-10-31');
assert.equal(extended.itinerary.stops[3].outreach[1].dueDate, '2026-10-10');
assert.equal(extended.itinerary.stops[3].outreach[1].date, '2026-10-10');
assert.equal(extended.itinerary.stops[3].outreach[1].scheduledDate, '2026-10-10T18:30:00+11:00');
assert.equal(extended.itinerary.stops[3].outreach[1].draftText, 'Visit on 2026-11-01');
assert.equal(extended.itinerary.stops[3].outreach[0].needsRescheduling, true);
assert.equal(extended.itinerary.stops[3].appointments[0].needsRescheduling, true);
assert.equal(extended.itinerary.stops[3].appointments[0].date, '2026-10-31');
assert.equal(extended.itinerary.stops[3].appointments[1].date, '2026-11-01');
assert.equal(extended.itinerary.stops[3].appointments[2].date, '2026-10-31');
const weeklyPlan = JSON.parse(JSON.stringify(calculated.itinerary));
weeklyPlan.stops[3].appointments.push({ type: 'AA meeting', date: '2026-10-30', weekday: 'Friday', status: 'planned', selectedForItinerary: true });
weeklyPlan.stops[3].aaMeetings = [{ name: 'Weekly venue', weekday: 'Friday', selectedDates: ['2026-10-30'], selectedForItinerary: true }];
const weeklyPreview = model.previewExtendStay(weeklyPlan, 'hervey-bay');
const weeklyAppointment = weeklyPreview.itinerary.stops[3].appointments.at(-1);
assert.equal(weeklyAppointment.date, '2026-10-30', 'Moving a stay must not move the host weekly meeting date');
assert.equal(weeklyAppointment.dateReviewRequired, true);
assert.equal(weeklyAppointment.selectedForItinerary, false);
assert.equal(weeklyPreview.itinerary.stops[3].aaMeetings[0].selectedDates.length, 0);
assert.ok(weeklyPreview.warnings.some(item => item.code === 'meetingDateReview'));
assert.equal(context.window.Trip.uniqueRouteChoices([fileRoute(), fileRoute()], 1).routes.length, 1);
function fileRoute() { return { coordinates: [{ lat: -33, lng: 148 }, { lat: -34, lng: 149 }], distance: 100000, duration: 3600 }; }
let drawnPoints;
const mapContext = vm.createContext({ window: {}, L: { polyline(points) { drawnPoints = points; return { addTo() { return {}; } }; } } });
vm.runInContext(fs.readFileSync('public/js/map.js', 'utf8'), mapContext);
const mapManager = mapContext.window.MapManager;
mapManager.map = { removeLayer() {}, removeControl() {} };
mapManager.addWaypointMarker = () => {};
mapManager._hideRouteSelector = () => {};
mapManager.updateRoute = () => { throw new Error('Loading saved geometry must not reroute or write the trip'); };
mapManager.updateWaypoints([{ id: 'one', lat: -33, lng: 148 }, { id: 'two', lat: -34, lng: 149 }], { route: fileRoute() });
assert.equal(drawnPoints.length, 2);
assert.equal(drawnPoints[0][0], -33);
assert.equal(calculated.itinerary.stops[2].plannedNights, 14, 'Preview must not mutate the saved plan');
assert.ok(model.previewExtendStay(calculated.itinerary, 'parkes', 2).conflicts.some(item => item.code === 'fixedAnchor'));
assert.throws(() => model.previewExtendStay(calculated.itinerary, 'sydney'), /fixed duration/);
assert.equal(model.validate({ ...sourcePlan, startDate: '2026-02-30' }).valid, false);
assert.equal(model.validate({ ...sourcePlan, stops: [{ name: 'Hervey Bay', minNights: 7, plannedNights: 6, maxNights: 14 }] }).valid, false);

const fileData = { name: 'Import fixture', description: 'Owner backup fixture', settings: { itinerary: sourcePlan, customSetting: 'retain' },
  waypoints: [{ id: 'wp1', name: 'Parkes', lat: -33.14, lng: 148.17, type: 'stop' }, { id: 'wp2', name: 'Hervey Bay', lat: -25.29, lng: 152.84, type: 'camp' }],
  journal: [{ id: 'j1', title: 'Private contact note', content: 'Private fixture text', isPrivate: true, waypointId: 'wp2' }],
  route: { distance: 100000, duration: 7200, coordinates: [[148.17, -33.14], [152.84, -25.29]] },
  alternativeRoutes: [{ name: 'Alternate', distance: 110000, duration: 7600, coordinates: [[148.17, -33.14], [152.84, -25.29]] }],
};

function mockApi(failAtWaypoint = false) {
  const trips = [];
  let creates = 0;
  return { get creates() { return creates; }, trips: {
    async list() { return trips; },
    async create(data) { creates++; const trip = { ...data, id: 'cloud-fixture', version: 0, is_public: 0, waypoints: [], journal: [], alternativeRoutes: [] }; trips.push(trip); return trip; },
    async get() { return JSON.parse(JSON.stringify(trips[0])); },
    async update(_id, data, options) {
      const trip = trips[0]; assert.equal(Number(options.headers['If-Match']), trip.version);
      if (data.settings) trip.settings = { ...trip.settings, ...data.settings };
      if (data.route) trip.route = data.route;
      trip.version++; return trip;
    },
    async saveAlternativeRoutes(_id, routes, options) { assert.equal(Number(options.headers['If-Match']), trips[0].version); trips[0].alternativeRoutes = routes; trips[0].version++; },
  }, waypoints: {
    async add(_id, waypoint, options) {
      if (failAtWaypoint === true) { failAtWaypoint = false; throw new Error('fixture connection interrupted'); }
      assert.equal(Number(options.headers['If-Match']), trips[0].version);
      const saved = { ...waypoint, id: `server-wp-${trips[0].waypoints.length}` };
      trips[0].waypoints.push(saved); trips[0].version++;
      if (failAtWaypoint === 'lostResponse') { failAtWaypoint = false; throw new Error('fixture response lost after save'); }
      return { waypoint: saved, trip_version: trips[0].version };
    },
  }, journal: {
    async add(_id, entry) { assert.equal(entry.is_private, true); const saved = { ...entry, id: 'server-j1' }; trips[0].journal.push(saved); trips[0].version++; return saved; },
  } };
}

async function run() {
  const imported = context.Share.importFromJSON(fileData);
  const api = mockApi();
  const saved = await context.Share.importToCloud(imported, api);
  assert.equal(saved.is_public, 0);
  assert.equal(saved.settings.customSetting, 'retain');
  assert.equal(saved.settings.importState.status, 'complete');
  assert.equal(saved.settings.itinerary.stops[0].waypointId, 'server-wp-0');
  assert.equal(saved.settings.itinerary.stops[2].privateJournalRefs[0], 'server-j1');
  assert.equal(saved.journal[0].waypoint_id, 'server-wp-1');
  assert.equal(saved.route.distance, 100000);
  assert.equal(saved.alternativeRoutes.length, 1);
  const backup = context.window.Trip.getOwnerBackupData(imported);
  assert.equal(backup.settings.customSetting, 'retain');
  assert.equal(backup.journal[0].isPrivate, true);
  assert.equal(backup._importSource, undefined);
  await context.Share.importToCloud(context.Share.importFromJSON(fileData), api);
  assert.equal(api.creates, 1, 'Reimporting the same complete file must not create another trip');
  const interruptedApi = mockApi(true);
  await assert.rejects(context.Share.importToCloud(context.Share.importFromJSON(fileData), interruptedApi), error => error.partialTripId === 'cloud-fixture');
  const resumed = await context.Share.importToCloud(context.Share.importFromJSON(fileData), interruptedApi);
  assert.equal(resumed.settings.importState.status, 'complete');
  assert.equal(interruptedApi.creates, 1);
  const lostResponseApi = mockApi('lostResponse');
  await assert.rejects(context.Share.importToCloud(context.Share.importFromJSON(fileData), lostResponseApi), /response lost/);
  const reconciled = await context.Share.importToCloud(context.Share.importFromJSON(fileData), lostResponseApi);
  assert.equal(reconciled.waypoints.length, 2, 'A lost response must not duplicate the saved waypoint');
  assert.equal(lostResponseApi.creates, 1);
  assert.throws(() => context.Share.importFromJSON({ ...fileData, waypoints: [{ name: 'Bad', lat: 100, lng: 0 }] }), /Invalid coordinates/);

  // Exercise a race after the preflight read: the database write must reject it.
  let staleWriteGuarded = false;
  const workerContext = vm.createContext({
    TextEncoder,
    parseBody: async () => ({ settings: { itinerary: calculated.itinerary } }),
    parseIfMatchVersion: () => 4,
    safeJsonParse: (value, fallback) => typeof value === 'string' ? JSON.parse(value) : (value || fallback),
    conflictResponse: data => ({ status: 409, data }), errorResponse: (_message, status) => ({ status }),
    preconditionRequiredResponse: () => ({ status: 428 }),
    jsonResponse: data => ({ status: 200, data }),
  });
  for (const path of ['api/route-codec.js', 'api/itinerary-validation.js']) vm.runInContext(fs.readFileSync(path, 'utf8').replace(/^export /gm, ''), workerContext, { filename: path });
  vm.runInContext(fs.readFileSync('api/trips.js', 'utf8').replace(/^import .*;\r?$/gm, '').replace('export const TripsHandler', 'const TripsHandler') + '\nglobalThis.handler = TripsHandler;', workerContext);
  let reads = 0;
  const db = { prepare(sql) { return { bind() { return {
    async first() { return { id: 'trip', version: ++reads === 1 ? 4 : 5, settings: '{}' }; },
    async run() { staleWriteGuarded = /WHERE id = \? AND user_id = \? AND version = \?/.test(sql); return { meta: { changes: 0 } }; },
  }; } }; } };
  const response = await workerContext.handler.updateTrip({ env: { RIDE_TRIP_PLANNER_DB: db }, user: { id: 'owner' }, params: { id: 'trip' }, request: {} });
  assert.equal(response.status, 409);
  assert.equal(staleWriteGuarded, true);
  workerContext.fixtureRoute = fileData.route;
  const encoded = vm.runInContext('encodeRoute(fixtureRoute)', workerContext);
  assert.equal(JSON.parse(encoded.coordinates)[0][0], 148.17);
  workerContext.storedCoordinates = JSON.parse(encoded.coordinates);
  const expanded = vm.runInContext('expandCoordinates(storedCoordinates)', workerContext);
  assert.equal(expanded[0].lat, -33.14);
  assert.equal(expanded[0].lng, 148.17);
  workerContext.choiceFixture = [fileRoute(), fileRoute()];
  assert.equal(vm.runInContext('uniqueRouteChoices(choiceFixture,1).routes.length', workerContext), 1);
  assert.equal(vm.runInContext('uniqueRouteChoices(choiceFixture,1).activeIndex', workerContext), 0);
  assert.throws(() => vm.runInContext('assertRowSize(["x".repeat(1500000), "y".repeat(500000)])', workerContext), /row size limit/);
  assert.throws(() => vm.runInContext('encodeRoute({coordinates:[{lat:100,lng:0}]})', workerContext), /invalid coordinates/);
  assert.equal(vm.runInContext('validateTripSettings({itinerary:{version:1,startDate:"2026-02-30",stops:[]}})', workerContext), 'A version 1 itinerary with stops is required');
  workerContext.parseIfMatchVersion = () => null;
  reads = 0;
  assert.equal((await workerContext.handler.updateTrip({ env: { RIDE_TRIP_PLANNER_DB: db }, user: { id: 'owner' }, params: { id: 'trip' }, request: {} })).status, 428);
  const otherOwnerDb = { prepare(sql) { assert.match(sql, /user_id = \?/); return { bind() { return { async first() { return null; } }; } }; } };
  assert.equal((await workerContext.handler.updateTrip({ env: { RIDE_TRIP_PLANNER_DB: otherOwnerDb }, user: { id: 'other-owner' }, params: { id: 'trip' }, request: {} })).status, 404);
  if (process.argv[2]) {
    const actual = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    context.Share.importFromJSON(actual);
    workerContext.fixtureRoute = actual.route;
    workerContext.fixtureSettings = actual.settings;
    const compact = vm.runInContext('encodeRoute(fixtureRoute)', workerContext);
    assert.equal(vm.runInContext('validateTripSettings(fixtureSettings)', workerContext), null);
    workerContext.storedCoordinates = JSON.parse(compact.coordinates);
    const restored = vm.runInContext('expandCoordinates(storedCoordinates)', workerContext);
    assert.equal(restored.length, actual.route.coordinates.length);
    assert.ok(restored.every((point, index) => point.lat === actual.route.coordinates[index].lat && point.lng === actual.route.coordinates[index].lng));
    console.log(`Private manifest validation passed: ${restored.length} geometry points preserved; compact geometry ${Buffer.byteLength(compact.coordinates)} bytes; settings ${Buffer.byteLength(JSON.stringify(actual.settings))} bytes.`);
  }
  console.log('Itinerary checks passed: dates, Sydney anchor, Hervey Bay duration, fuel, private import/remapping, reload, duplicate/partial imports, and atomic stale-version rejection.');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
