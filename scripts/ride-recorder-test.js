const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const Request = globalThis.Request;

class MemoryStorage {
  data = new Map();
  get length() { return this.data.size; }
  key(i) { return [...this.data.keys()][i] ?? null; }
  getItem(k) { return this.data.get(k) ?? null; }
  setItem(k, v) { this.data.set(k, String(v)); }
  removeItem(k) { this.data.delete(k); }
}

class QuotaStorage extends MemoryStorage {
  failData = false;
  setItem(k, v) {
    if (this.failData && k.endsWith('ownerA:quota')) throw new Error('quota exceeded');
    super.setItem(k, v);
  }
}

const intervalCallbacks = new Set();
function tickIntervals() { for (const callback of [...intervalCallbacks]) callback(); }

function recorder(storage, _clock) {
  const window = { localStorage: storage, crypto: globalThis.crypto, console };
  window.setInterval = callback => { intervalCallbacks.add(callback); return callback; };
  window.clearInterval = callback => intervalCallbacks.delete(callback);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'ride-recorder.js'), 'utf8'), { window, console, Date, Uint8Array, encodeURIComponent, Promise, Math, Number, String, Array, JSON });
  return window.RideRecorder;
}

function dbFor(ownerByTrip = { tripA: 'ownerA', tripB: 'ownerB' }, journalTrip = { journalMine: 'tripA', journalOther: 'tripB' }) {
  const logs = new Map();
  return {
    logs,
    prepare(sql) {
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async first() {
          if (sql.includes('FROM trips')) return ownerByTrip[args[0]] === args[1] ? { id: args[0] } : null;
          if (sql.includes('FROM ride_logs WHERE id')) {
            const row = logs.get(args[0]);
            return row ? { id: row.id, trip_id: row.trip_id } : null;
          }
          if (sql.includes('FROM journal_entries')) return journalTrip[args[0]] === args[1] ? { id: args[0] } : null;
          return null;
        },
        async run() {
          logs.set(args[0], { id: args[0], trip_id: args[1], started_at: args[3], ended_at: args[4], distance_meters: args[5], duration_seconds: args[6], track: args[7] });
          return {};
        },
        async all() { return { results: [...logs.values()].filter(row => row.trip_id === args[0]) }; }
      };
    }
  };
}

async function apiCall(handler, db, { owner, trip, body }) {
  const response = await handler({ env: { RIDE_TRIP_PLANNER_DB: db }, user: { id: owner }, params: { tripId: trip }, request: new Request('https://ride.test/api', { method: 'POST', body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}

async function main() {
const { RideLogsHandler } = await import(pathToFileURL(path.join(__dirname, '..', 'api', 'ride-logs.js')).href);

const storage = new MemoryStorage();
let clock = Date.parse('2026-10-13T00:00:00Z');
const now = () => clock;
const RideRecorder = recorder(storage, now);
const sent = [];

// Persist every accepted fix, survive reload as a paused session, then retry offline data.
let failing = true;
let rr = RideRecorder.create({ userId: 'ownerA', tripId: 'tripA', storage, now, saveLog: async payload => {
  sent.push(payload);
  if (failing) throw new Error('offline');
} });
assert.equal(rr.record({ lat: -25, lng: 151, accuracy: 8, t: clock }), true);
clock += 5000;
assert.equal(rr.record({ lat: -25.0001, lng: 151, accuracy: 8, t: clock }), true);
// A concurrent tab cannot acquire or overwrite the active recorder's lease.
const blocked = RideRecorder.create({ userId: 'ownerA', tripId: 'tripA', storage, now, saveLog: async payload => { sent.push(payload); throw new Error('offline'); } });
assert.equal(blocked.getStatus().reason, 'another-tab');
assert.equal(blocked.record({ lat: -25, lng: 151, accuracy: 5, t: clock + 10_000 }), false);
rr.pause('hidden');
assert.equal(rr.getStatus().pendingLogs, 1);
assert.equal(blocked.resume(), true, 'hidden-tab handoff allows the waiting tab to take ownership');
await blocked.stop(); // fail the first sync attempt, then release its lease
rr = RideRecorder.create({ userId: 'ownerA', tripId: 'tripA', storage, now, saveLog: async payload => sent.push(payload) });
assert.equal(rr.getStatus().paused, true);
assert.equal(rr.getStatus().syncPending, true);
assert.equal(RideRecorder.pendingFor('ownerB', 'tripA', storage).length, 0);
failing = false;
const concurrent = await Promise.all([rr.flush(), rr.flush()]);
assert.equal(concurrent[0].pendingLogs, 0);
assert.equal(concurrent[1].pendingLogs, 0);
assert.equal(sent.filter(p => p.client_log_id === sent[0].client_log_id).length, 2, 'a retry must retain its stable id');

// Gaps split tracks; long rides roll into overlapping chunks at the point cap.
rr.resume();
clock += 60_000;
assert.equal(rr.record({ lat: -25, lng: 151, accuracy: 5, t: clock }), true);
clock += 5000;
assert.equal(rr.record({ lat: -25.0001, lng: 151, accuracy: 5, t: clock }), true);
rr.pause('gps unavailable');
const afterGap = RideRecorder.pendingFor('ownerA', 'tripA', storage);
assert.equal(afterGap.length, 1);
assert.equal(afterGap[0].track.length, 2);
rr.resume();
for (let i = 0; i < 1001; i++) {
  clock += 1000;
  rr.record({ lat: -25 + i * 0.00001, lng: 151, accuracy: 5, t: clock });
}
rr.pause('test complete');
assert.ok(RideRecorder.pendingFor('ownerA', 'tripA', storage).every(p => p.track.length <= 1000));

const stationaryStorage = new MemoryStorage();
const stationaryLogs = [];
const stationaryRecorder = recorder(stationaryStorage, now).create({ userId: 'ownerA', tripId: 'stationary', storage: stationaryStorage, now, saveLog: async payload => stationaryLogs.push(payload) });
clock += 1000;
const idleStart = clock;
stationaryRecorder.record({ lat: -25, lng: 151, accuracy: 5, t: clock });
for (let i = 1; i <= 10; i++) {
  clock = idleStart + i * 30_000;
  stationaryRecorder.resume(); // mirrors the controller's resume call on each GPS fix
  const noise = i % 2 ? 0.00005 : -0.00005;
  stationaryRecorder.record({ lat: -25 + noise, lng: 151, accuracy: 8, t: clock });
}
assert.equal(stationaryRecorder.getStatus().reason, 'stationary', 'a five-minute coffee stop enters idle pause');
assert.equal(stationaryRecorder.getStatus().paused, true);
clock += 30_000;
stationaryRecorder.resume();
assert.equal(stationaryRecorder.getStatus().reason, 'stationary', 'resume without a fix preserves idle monitoring');
assert.equal(stationaryRecorder.record({ lat: -25, lng: 151, accuracy: 8, t: clock }), false, 'stationary GPS noise is ignored while idle');
clock += 30_000;
const movementFix = { lat: -24.9995, lng: 151, accuracy: 5, t: clock };
stationaryRecorder.resume();
assert.equal(stationaryRecorder.record(movementFix), true, 'a reliable fix beyond 35m resumes recording');
assert.equal(stationaryRecorder.getStatus().recording, true);
await stationaryRecorder.stop();
const resumedLog = stationaryLogs.find(log => log.track[0].t === new Date(movementFix.t).toISOString());
assert.ok(resumedLog, 'movement after idle starts a new segment');
assert.equal(resumedLog.track.length, 1, 'the idle gap is not drawn into the resumed segment');

const movingStorage = new MemoryStorage();
const movingRecorder = recorder(movingStorage, now).create({ userId: 'ownerA', tripId: 'moving', storage: movingStorage, now, saveLog: async () => {} });
clock += 1000;
const movingStart = clock;
movingRecorder.record({ lat: -25, lng: 151, accuracy: 5, t: clock });
for (let i = 1; i <= 12; i++) {
  clock = movingStart + i * 30_000;
  movingRecorder.resume();
  movingRecorder.record({ lat: -25 + i * 0.000216, lng: 151, accuracy: 5, t: clock });
}
assert.equal(movingRecorder.getStatus().recording, true, 'steady 24m-per-fix movement never triggers idle pause');

const pagehideStorage = new MemoryStorage();
let pagehideSaved = 0;
const pagehideRecorder = recorder(pagehideStorage, now).create({ userId: 'ownerA', tripId: 'pagehide', storage: pagehideStorage, now, saveLog: async () => { pagehideSaved++; } });
clock += 1000;
pagehideRecorder.record({ lat: -25, lng: 151, accuracy: 5, t: clock });
clock += 1000;
pagehideRecorder.record({ lat: -25.0001, lng: 151, accuracy: 5, t: clock });
pagehideRecorder.pause('pagehide');
assert.equal(pagehideSaved, 0, 'pagehide persists synchronously without starting a new request');
const pagehideRecovery = await recorder(pagehideStorage, now).recover({ userId: 'ownerA', tripId: 'pagehide', storage: pagehideStorage, now, saveLog: async () => { pagehideSaved++; } });
assert.equal(pagehideRecovery.synced, 1, 'a new document can recover immediately after pagehide');
assert.equal(pagehideRecovery.pendingLogs, 0);

const handoffStorage = new MemoryStorage();
let resolveOldSave;
let markOldSaveStarted;
const oldSaveStarted = new Promise(resolve => { markOldSaveStarted = resolve; });
const oldRecorder = recorder(handoffStorage, now).create({ userId: 'ownerA', tripId: 'handoff', storage: handoffStorage, now, saveLog: async () => {
  markOldSaveStarted();
  await new Promise(resolve => { resolveOldSave = resolve; });
} });
clock += 1000;
oldRecorder.record({ lat: -25, lng: 151, accuracy: 5, t: clock });
clock += 60_000;
oldRecorder.record({ lat: -25.0001, lng: 151, accuracy: 5, t: clock }); // checkpoint starts the held request
await oldSaveStarted;
oldRecorder.pause('hidden'); // releases the lease while the old request remains in flight
const handoffRecovery = await recorder(handoffStorage, now).recover({ userId: 'ownerA', tripId: 'handoff', storage: handoffStorage, now, saveLog: async () => {} });
assert.ok(handoffRecovery.synced >= 1, 'the visible tab can take over without waiting for the stale lease');
const handoffOwner = recorder(handoffStorage, now).create({ userId: 'ownerA', tripId: 'handoff', storage: handoffStorage, now, saveLog: async () => {} });
assert.equal(handoffOwner.resume(), true);
clock += 1000;
const newerFix = { lat: -24.999, lng: 151, accuracy: 5, t: clock };
assert.equal(handoffOwner.record(newerFix), true);
resolveOldSave();
await oldRecorder.flush();
assert.equal(recorder(handoffStorage, now).pendingFor('ownerA', 'handoff', handoffStorage).length, 0, 'a late acknowledgement from the old tab cannot restore or delete newer storage');
const handedOffState = JSON.parse(handoffStorage.getItem('ride-recorder:v1:ownerA:handoff'));
assert.equal(handedOffState.active[0].lat, newerFix.lat, 'a late old-tab acknowledgement preserves the new owner’s active fix');

// Quota errors pause capture and report an error while retaining the point in memory.
const quotaStorage = new QuotaStorage();
const quotaRecorder = recorder(quotaStorage, now).create({ userId: 'ownerA', tripId: 'quota', storage: quotaStorage, now, saveLog: async () => {} });
quotaStorage.failData = true;
clock += 1000;
assert.equal(quotaRecorder.record({ lat: -25, lng: 151, accuracy: 5, t: clock }), false);
assert.equal(quotaRecorder.getStatus().state, 'storage-error');
assert.equal(quotaRecorder.getStatus().points, 1);
assert.equal(quotaRecorder.getStatus().unsavedPoints, 1, 'failed local writes identify the retained in-memory points');
quotaStorage.failData = false;
assert.equal(quotaRecorder.resume(), true, 'capture can resume after storage writes recover');

const recoveryStorage = new MemoryStorage();
const crashRecorder = recorder(recoveryStorage, now).create({ userId: 'ownerA', tripId: 'recover', storage: recoveryStorage, now, saveLog: async () => { throw new Error('offline'); } });
clock += 1000;
crashRecorder.record({ lat: -25, lng: 151, accuracy: 5, t: clock });
clock += 1000;
crashRecorder.record({ lat: -25.0001, lng: 151, accuracy: 5, t: clock });
crashRecorder.pause('offline');
clock += 2 * 60_000 + 1;
const recovered = await recorder(recoveryStorage, now).recover({ userId: 'ownerA', tripId: 'recover', storage: recoveryStorage, now, saveLog: async () => { clock += 3 * 60_000; tickIntervals(); } });
assert.equal(recovered.synced, 1, 'recovery sends and removes a durable pending chunk');
assert.equal(recovered.pendingLogs, 0);

const checkpointStorage = new MemoryStorage();
const checkpoints = [];
const checkpointRecorder = recorder(checkpointStorage, now).create({ userId: 'ownerA', tripId: 'checkpoint', storage: checkpointStorage, now, saveLog: async payload => checkpoints.push(payload) });
clock += 1000;
checkpointRecorder.record({ lat: -25, lng: 151, accuracy: 5, t: clock });
clock += 30_000;
checkpointRecorder.record({ lat: -25.0001, lng: 151, accuracy: 5, t: clock });
clock += 30_000;
checkpointRecorder.record({ lat: -25.0002, lng: 151, accuracy: 5, t: clock });
await checkpointRecorder.flush();
assert.equal(checkpoints.length, 1, 'active rides checkpoint on the first fix after 60 seconds');
assert.equal(checkpoints[0].track.length, 2);
const checkpointEnd = checkpoints[0].track.at(-1).t;
await checkpointRecorder.stop();
assert.equal(checkpoints[1].track[0].t, checkpointEnd, 'the checkpoint boundary point is retained in the following segment');

// API ownership, retry idempotency, cross-trip collision, input bounds and legacy IDs.
const db = dbFor();
const first = sent[0];
let result = await apiCall(RideLogsHandler.saveRideLog, db, { owner: 'ownerA', trip: 'tripA', body: first });
assert.equal(result.status, 200);
result = await apiCall(RideLogsHandler.saveRideLog, db, { owner: 'ownerA', trip: 'tripA', body: first });
assert.equal(result.body.duplicate, true);
result = await apiCall(RideLogsHandler.saveRideLog, db, { owner: 'ownerB', trip: 'tripB', body: first });
assert.equal(result.status, 409);
result = await apiCall(RideLogsHandler.saveRideLog, db, { owner: 'ownerB', trip: 'tripA', body: first });
assert.equal(result.status, 404);
const legacyTrack = Array(3000).fill(first.track[0]);
result = await apiCall(RideLogsHandler.saveRideLog, db, { owner: 'ownerA', trip: 'tripA', body: { ...first, track: legacyTrack } });
assert.equal(result.status, 200, 'legacy requests with 3000 points remain accepted');
result = await apiCall(RideLogsHandler.saveRideLog, db, { owner: 'ownerA', trip: 'tripA', body: { ...first, client_log_id: 'too-large', track: [...legacyTrack, first.track[0]] } });
assert.equal(result.status, 400);
result = await apiCall(RideLogsHandler.saveRideLog, db, { owner: 'ownerA', trip: 'tripA', body: { ...first, client_log_id: 'null-coercion', track: [{ lat: null, lng: 151, t: clock }] } });
assert.equal(result.status, 400, 'null coordinates are not numerically coerced');
result = await apiCall(RideLogsHandler.saveRideLog, db, { owner: 'ownerA', trip: 'tripA', body: { ...first, client_log_id: 'string-coordinate', track: [{ lat: '-25', lng: 151, t: clock }] } });
assert.equal(result.status, 400, 'coordinate fields must already be numbers');
result = await apiCall(RideLogsHandler.saveRideLog, db, { owner: 'ownerA', trip: 'tripA', body: { ...first, client_log_id: 'out-of-order', track: [{ lat: -25, lng: 151, t: clock + 1000 }, { lat: -25, lng: 151, t: clock }] } });
assert.equal(result.status, 400, 'out-of-order fixes are rejected');
result = await apiCall(RideLogsHandler.saveRideLog, db, { owner: 'ownerA', trip: 'tripA', body: { ...first, client_log_id: 'end-before-start', started_at: '2026-10-13T01:00:00Z', ended_at: '2026-10-13T00:59:59Z' } });
assert.equal(result.status, 400, 'a log cannot end before it starts');
result = await apiCall(RideLogsHandler.saveRideLog, db, { owner: 'ownerA', trip: 'tripA', body: { ...first, client_log_id: 'normalized', track: [{ lat: -25, lng: 151, t: clock, extra: 'discarded' }] } });
assert.equal(result.status, 200);
assert.deepEqual(Object.keys(JSON.parse(db.logs.get('normalized').track)[0]).sort(), ['lat', 'lng', 't'], 'arbitrary client fields are not stored');
result = await apiCall(RideLogsHandler.saveRideLog, db, { owner: 'ownerA', trip: 'tripA', body: { ...first, client_log_id: 'journal-mine', journal_entry_id: 'journalMine' } });
assert.equal(result.status, 200);
result = await apiCall(RideLogsHandler.saveRideLog, db, { owner: 'ownerA', trip: 'tripA', body: { ...first, client_log_id: 'journal-other', journal_entry_id: 'journalOther' } });
assert.equal(result.status, 404, 'a journal entry from another trip is rejected');
result = await apiCall(RideLogsHandler.saveRideLog, db, { owner: 'ownerA', trip: 'tripA', body: { ...first, client_log_id: undefined } });
assert.equal(result.status, 200, 'legacy request without a stable ID remains supported');

// All private history remains listable and is scoped to an owned trip.
for (let i = 0; i < 55; i++) {
  const body = { ...first, client_log_id: `legacy-${i}` };
  await apiCall(RideLogsHandler.saveRideLog, db, { owner: 'ownerA', trip: 'tripA', body });
}
const listing = await RideLogsHandler.listRideLogs({ env: { RIDE_TRIP_PLANNER_DB: db }, user: { id: 'ownerA' }, params: { tripId: 'tripA' } });
assert.ok((await listing.json()).logs.length > 50);

console.log('Ride recorder durability, splitting, retry, ownership, and API validation checks passed.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
