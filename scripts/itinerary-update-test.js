/* Existing-trip planning updates: synthetic fixtures, no account/network writes. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { TextEncoder } = require('node:util');
const copy = value => JSON.parse(JSON.stringify(value));
const element = () => ({ children: [], disabled: false, append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; }, focus() {}, get childElementCount() { return this.children.length; } });
const nodes = new Map();
const context = vm.createContext({ window: {}, URL, TextEncoder,
  document: { addEventListener() {}, createElement: element, getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); } },
  UI: { openModal() {}, closeModal() {}, showToast() {}, updateTripStats() {} },
  App: { currentUser: { id: 'owner' }, useCloud: true, isSharedView: false,
    ensureEditable() { return !this.isSharedView; }, getTripIfMatchHeaders(trip) { return { 'If-Match': String(trip.version) }; },
    markTripWritten() {}, cacheTripData() {}, async handleTripConflict() { this.conflicts = (this.conflicts || 0) + 1; } },
  API: { trips: {} },
});
for (const path of ['public/js/itinerary.js', 'public/js/itinerary-ui.js']) vm.runInContext(fs.readFileSync(path, 'utf8'), context, { filename: path });
const model = context.window.RideItinerary;
const planner = context.window.RideItineraryUI;
planner.render = () => {};
const plan = model.recalculate({ version: 1, startDate: '2026-10-11', stops: [
  { id: 'river', name: 'River town', waypointId: 'wp-river', plannedNights: 2, minNights: 1, privateJournalRefs: ['private-note'], outreach: [{ id: 'post', title: 'Facebook work post', status: 'draft', leadDays: 7, targetOffsetDays: 1, localTime: '18:30', timeZone: 'Australia/Sydney', textTemplate: 'Available in {town} on {serviceDate}', text: 'Draft' }] },
  { id: 'city', name: 'City stay', waypointId: 'wp-city', plannedNights: 2, fixedDate: '2026-10-14', anchorMode: 'withinStay' },
  { id: 'finish', name: 'Finish', waypointId: 'wp-finish', plannedNights: 0 },
] }).itinerary;
const fixture = () => ({ id: 'owned-trip', version: 7, isPublic: false, settings: { itinerary: copy(plan), untouched: { value: 'retain' }, share: { includeRoute: false } },
  waypoints: ['wp-river', 'wp-city', 'wp-finish'].map(id => ({ id })), journal: [{ id: 'private-note', isPrivate: true }], route: { coordinates: [{ lat: -33, lng: 148 }] },
});
const file = { rideTripId: 'owned-trip', itinerary: copy(plan), waypoints: fixture().waypoints };
file.itinerary.stops[0].plannedNights = 3;
file.itinerary.stops[0].outreach[0].leadDays = 6;
const original = fixture();
const before = JSON.stringify(original);
const prepared = planner.prepareFileUpdate(file, original);
assert.equal(prepared.itinerary.stops[1].arrivalDate, '2026-10-14');
assert.equal(prepared.itinerary.stops[0].outreach[0].dueDate, '2026-10-05');
assert.equal(JSON.stringify(original), before, 'Preparing a file must not mutate the current trip');
assert.equal(planner.draftChanges(plan, prepared.itinerary).length, 1);
assert.throws(() => planner.prepareFileUpdate({ ...file, rideTripId: 'someone-elses-trip' }, original), /trip ID must match/);
const foreignWaypoint = copy(file); foreignWaypoint.itinerary.stops[0].waypointId = 'foreign';
assert.throws(() => planner.prepareFileUpdate(foreignWaypoint, original), /waypoint does not belong/);
assert.throws(() => planner.prepareFileUpdate({ ...file, waypoints: [{ id: 'foreign' }] }, original), /outside the open Ride trip/);
assert.throws(() => planner.prepareFileUpdate({ ...file, journal: [{ id: 'foreign-note' }] }, original), /note outside the open Ride trip/);
const foreignLeg = copy(file); foreignLeg.itinerary.stops[1].leg = { fromWaypointId: 'foreign' };
assert.throws(() => planner.prepareFileUpdate(foreignLeg, original), /leg waypoint/);
const foreignNote = copy(file); foreignNote.itinerary.stops[0].privateJournalRefs = ['foreign-note'];
assert.throws(() => planner.prepareFileUpdate(foreignNote, original), /private note/);
const invalid = copy(file); invalid.itinerary.startDate = '2026-02-30';
assert.throws(() => planner.prepareFileUpdate(invalid, original), /valid departure/);
const conflict = copy(file); conflict.itinerary.stops[0].plannedNights = 5;
assert.throws(() => planner.prepareFileUpdate(conflict, original), /must include/);
const erasedAnchor = copy(file); delete erasedAnchor.itinerary.stops[1].fixedDate;
assert.throws(() => planner.prepareFileUpdate(erasedAnchor, original), /keep the existing fixed-date/);
const gated = copy(plan);
gated.stops[1].outreach = ['blocked', 'suppressed'].map(status => ({ status, leadDays: 7, dueDate: '2026-10-06', publicationGate: 'Do not publish' }));
const shiftedGates = model.previewExtendStay(gated, 'river').itinerary.stops[1].outreach;
assert.deepEqual(Array.from(shiftedGates, item => item.dueDate), ['2026-10-07', '2026-10-07']);
assert.deepEqual(Array.from(shiftedGates, item => item.status), ['blocked', 'suppressed']);
assert.ok(shiftedGates.every(item => item.publicationGate === 'Do not publish'));

async function run() {
  let requests = 0;
  context.App.currentTrip = fixture();
  const retained = ['route', 'waypoints', 'journal', 'isPublic'].map(key => JSON.stringify(context.App.currentTrip[key]));
  context.API.trips.create = () => { throw new Error('A planning update must never create a trip'); };
  context.API.trips.update = async (id, body, options) => {
    requests++;
    assert.equal(id, 'owned-trip');
    assert.deepEqual(Object.keys(body), ['settings']);
    assert.deepEqual(Object.keys(body.settings), ['itinerary']);
    assert.equal(options.headers['If-Match'], '7');
    return { version: 8, settings: { ...context.App.currentTrip.settings, itinerary: body.settings.itinerary } };
  };
  planner.openPreview(prepared, 'Update this itinerary', { planningFileUpdate: true });
  await planner.savePreview();
  assert.equal(requests, 1);
  assert.equal(context.App.currentTrip.version, 8);
  assert.equal(context.App.currentTrip.settings.untouched.value, 'retain');
  assert.equal(context.App.currentTrip.settings.share.includeRoute, false);
  assert.deepEqual(['route', 'waypoints', 'journal', 'isPublic'].map(key => JSON.stringify(context.App.currentTrip[key])), retained);
  assert.equal(context.App.currentTrip.settings.itinerary.stops[0].outreach[0].dueDate, '2026-10-05');

  context.App.currentTrip = fixture();
  planner.openPreview(prepared, 'Update this itinerary', { planningFileUpdate: true });
  context.App.currentTrip.version++;
  await planner.savePreview();
  assert.equal(requests, 1, 'A changed local version must not send a write');
  assert.equal(JSON.stringify(context.App.currentTrip.settings.itinerary), JSON.stringify(plan));
  context.App.currentTrip = fixture();
  context.API.trips.update = async () => { requests++; throw Object.assign(new Error('Version conflict'), { status: 409 }); };
  planner.openPreview(prepared, 'Update this itinerary', { planningFileUpdate: true });
  await planner.savePreview();
  assert.equal(context.App.conflicts, 1);
  assert.equal(planner.pending, null);
  assert.equal(JSON.stringify(context.App.currentTrip.settings.itinerary), JSON.stringify(plan));
  await planner.savePreview();
  assert.equal(requests, 2, 'A conflict must not retry an obsolete planning write');
  context.App.isSharedView = true;
  await planner.previewFileUpdate({ text() { throw new Error('Shared views must not read planning files'); } });
  assert.equal(planner.pending, null);

  // The existing server guard covers the merged trip row before any mutation.
  let writes = 0;
  const oversized = copy(prepared.itinerary); oversized.notes = 'x'.repeat(1950000);
  const worker = vm.createContext({ TextEncoder,
    parseBody: async () => ({ settings: { itinerary: oversized } }), parseIfMatchVersion: () => 7,
    safeJsonParse: value => JSON.parse(value || '{}'), errorResponse: (message, status) => ({ message, status }),
  });
  for (const path of ['api/route-codec.js', 'api/itinerary-validation.js']) vm.runInContext(fs.readFileSync(path, 'utf8').replace(/^export /gm, ''), worker);
  vm.runInContext(fs.readFileSync('api/trips.js', 'utf8').replace(/^import .*;\r?$/gm, '').replace('export const TripsHandler', 'const TripsHandler') + '\nglobalThis.handler = TripsHandler;', worker);
  const db = { prepare(sql) { assert.match(sql, /user_id = \?/); return { bind() { return { async first() { return { ...original, settings: JSON.stringify(original.settings) }; }, async run() { writes++; throw new Error('Oversized settings must not be written'); } }; } }; } };
  const response = await worker.handler.updateTrip({ env: { RIDE_TRIP_PLANNER_DB: db }, user: { id: 'owner' }, params: { id: 'owned-trip' }, request: {} });
  assert.equal(response.status, 413);
  assert.equal(writes, 0);
  if (process.argv[2]) {
    const actual = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    const actualPlan = actual.itinerary || actual.settings?.itinerary;
    const loadedIds = { id: actual.rideTripId, settings: { itinerary: actualPlan }, waypoints: actual.waypoints, journal: actual.journal };
    const validated = planner.prepareFileUpdate(actual, loadedIds);
    for (let index = 0; index < actualPlan.stops.length; index++) {
      const beforeStop = actualPlan.stops[index];
      const afterStop = validated.itinerary.stops[index];
      assert.equal(afterStop.arrivalDate, beforeStop.arrivalDate);
      assert.equal(afterStop.departureDate, beforeStop.departureDate);
      for (let itemIndex = 0; itemIndex < (beforeStop.outreach || []).length; itemIndex++) {
        const beforeItem = beforeStop.outreach[itemIndex];
        const afterItem = afterStop.outreach[itemIndex];
        assert.equal(afterItem.status, beforeItem.status);
        if (beforeItem.dueDate) assert.equal(afterItem.dueDate, beforeItem.dueDate, 'Prepared posting offsets must retain final dates');
        if (beforeItem.targetDate) assert.equal(afterItem.targetDate, beforeItem.targetDate);
      }
    }
    worker.actualSettings = JSON.stringify({ itinerary: validated.itinerary });
    const settingsBytes = vm.runInContext('assertRowSize([actualSettings])', worker);
    console.log(`Private planning file passed against its supplied cloud-ID lists: ${validated.itinerary.stops.length} stops, final posting dates retained, planning settings ${settingsBytes} bytes.`);
  }
  console.log('Planning update checks passed: matching owner trip/links, fixed anchors, preview-only reads, settings-only save, retained trip data, conflicts without retry, and D1 row guard.');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
