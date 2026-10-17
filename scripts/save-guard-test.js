// Unit tests for public/js/save-guard.js and the trip save / 409 path in
// public/js/trip-controller.js. Run: node scripts/save-guard-test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const Guard = require('../public/js/save-guard.js');
const { createSaveGuard, backoffDelay, parseRetryAfter, isTransientStatus } = Guard;

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const flush = async (n = 10) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
const httpError = (status, extra = {}) => Object.assign(new Error(`HTTP ${status}`), { status }, extra);

/** Manual clock: timers only fire when the test advances time. */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) { const id = nextId++; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    pending: () => [...timers.values()].map(t => t.at - now),
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await flush();
      }
      now = target;
    },
  };
}

// --- back-off schedule -------------------------------------------------------

test('back-off doubles from 1s and caps at 60s (no jitter at random=0.5)', () => {
  const mid = () => 0.5;
  const schedule = Array.from({ length: 9 }, (_, i) => backoffDelay(i, { random: mid }));
  assert.deepEqual(schedule, [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
});

test('jitter stays within +/-25% and never exceeds the cap', () => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const exp = Math.min(60000, 1000 * 2 ** attempt);
    const lo = backoffDelay(attempt, { random: () => 0 });
    const hi = backoffDelay(attempt, { random: () => 0.999999 });
    assert.ok(lo >= exp * 0.75 - 1 && lo <= exp, `attempt ${attempt} low ${lo}`);
    assert.ok(hi <= Math.min(60000, exp * 1.25) + 1 && hi >= Math.min(exp, 60000) - 1, `attempt ${attempt} high ${hi}`);
    assert.ok(hi <= 60000);
  }
});

test('Retry-After (seconds or HTTP date) wins when longer than the back-off', () => {
  assert.equal(parseRetryAfter('7'), 7000);
  assert.equal(parseRetryAfter(new Date(90_000).toUTCString(), 30_000), 60_000);
  assert.equal(parseRetryAfter('soon'), null);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(backoffDelay(0, { random: () => 0.5, retryAfterMs: 30000 }), 30000);
  assert.equal(backoffDelay(5, { random: () => 0.5, retryAfterMs: 1000 }), 32000);
  assert.equal(backoffDelay(0, { random: () => 0.5, retryAfterMs: 3_600_000 }), 600_000, 'capped at 10 minutes');
});

test('transient statuses are network, 408, 425, 429 and 5xx only', () => {
  [0, 408, 425, 429, 500, 502, 503, 504].forEach(s => assert.ok(isTransientStatus(s), String(s)));
  [400, 401, 403, 404, 409, 412, 428].forEach(s => assert.ok(!isTransientStatus(s), String(s)));
});

test('transient failures retry on the back-off schedule, then give up after maxRetries', async () => {
  const clock = fakeClock();
  const events = [];
  const guard = createSaveGuard({
    ...clock, random: () => 0.5, maxRetries: 4,
    onRetryScheduled: (k, info) => events.push(['retry', info.delayMs]),
    onGiveUp: () => events.push(['giveup']),
  });
  let calls = 0;
  const first = await guard.run('t1', async () => { calls++; throw httpError(503); });
  assert.equal(first.reason, 'retrying');
  assert.equal(first.delayMs, 1000);
  await clock.advance(120_000);
  assert.equal(calls, 5, '1 try + 4 retries');
  assert.deepEqual(events, [['retry', 1000], ['retry', 2000], ['retry', 4000], ['retry', 8000], ['giveup']]);
  assert.deepEqual(clock.pending(), []);
});

test('a retry that succeeds reports recovery and resets the schedule', async () => {
  const clock = fakeClock();
  let recovered = 0;
  const guard = createSaveGuard({ ...clock, random: () => 0.5, onRecovered: () => recovered++ });
  let calls = 0;
  await guard.run('t1', async () => { calls++; if (calls < 3) throw httpError(0); return true; });
  await clock.advance(2999);
  assert.equal(calls, 2);
  await clock.advance(1);
  assert.equal(calls, 3);
  assert.equal(recovered, 1);
  const again = await guard.run('t1', async () => { calls++; throw httpError(500); });
  assert.equal(again.delayMs, 1000, 'schedule restarts at 1s after a success');
});

test('429 honours Retry-After from the error', async () => {
  const clock = fakeClock();
  const guard = createSaveGuard({ ...clock, random: () => 0.5 });
  const result = await guard.run('t1', async () => { throw httpError(429, { retryAfter: '20' }); });
  assert.equal(result.delayMs, 20000);
  assert.deepEqual(clock.pending(), [20000]);
});

test('calls made while backing off do not send requests', async () => {
  const clock = fakeClock();
  const guard = createSaveGuard({ ...clock, random: () => 0.5 });
  let calls = 0;
  const task = async () => { calls++; throw httpError(502); };
  await guard.run('t1', task);
  for (let i = 0; i < 500; i++) {
    const r = await guard.run('t1', task);
    assert.equal(r.reason, 'retrying');
  }
  assert.equal(calls, 1);
});

test('non-transient errors fail once and do not retry', async () => {
  const clock = fakeClock();
  const guard = createSaveGuard({ ...clock });
  let calls = 0;
  const r = await guard.run('t1', async () => { calls++; throw httpError(403); });
  assert.equal(r.reason, 'failed');
  await clock.advance(600_000);
  assert.equal(calls, 1);
});

// --- single-flight -----------------------------------------------------------

test('single-flight: one request in flight per trip, extra calls coalesce into one follow-up', async () => {
  const guard = createSaveGuard({ ...fakeClock() });
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const releases = [];
  const task = () => new Promise(resolve => {
    calls++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    releases.push(() => { inFlight--; resolve(true); });
  });
  const first = guard.run('t1', task);
  const followers = Array.from({ length: 20 }, () => guard.run('t1', task));
  await flush();
  assert.equal(calls, 1);
  releases.shift()();
  assert.deepEqual(await first, { ok: true, value: true });
  await flush();
  assert.equal(calls, 2, 'exactly one follow-up save');
  releases.shift()();
  const results = await Promise.all(followers);
  results.forEach(r => assert.deepEqual(r, { ok: true, value: true }));
  assert.equal(maxInFlight, 1);
});

test('single-flight is per trip: different trips save in parallel', async () => {
  const guard = createSaveGuard({ ...fakeClock() });
  const started = [];
  const pending = [];
  const task = key => () => new Promise(resolve => { started.push(key); pending.push(resolve); });
  guard.run('a', task('a'));
  guard.run('b', task('b'));
  await flush();
  assert.deepEqual(started, ['a', 'b']);
  pending.forEach(r => r(true));
});

// --- 409 handling ------------------------------------------------------------

test('409 pauses the trip, calls onConflict once and sends nothing more until resume', async () => {
  const clock = fakeClock();
  const conflicts = [];
  const guard = createSaveGuard({ ...clock, onConflict: (k, e) => conflicts.push([k, e.status]) });
  let calls = 0;
  const task = async () => { calls++; throw httpError(409); };
  const r = await guard.run('t1', task);
  assert.equal(r.reason, 'conflict');
  assert.ok(guard.isPaused('t1'));
  for (let i = 0; i < 1000; i++) assert.equal((await guard.run('t1', task)).reason, 'paused');
  await clock.advance(600_000);
  assert.equal(calls, 1);
  assert.deepEqual(conflicts, [['t1', 409]]);
  assert.deepEqual(clock.pending(), [], 'no timer scheduled for a conflict');
  guard.resume('t1');
  await guard.run('t1', task);
  assert.equal(calls, 2);
  assert.equal(conflicts.length, 2, 'a new conflict after resume asks again');
});

test('a 409 while backing off cancels the pending retry', async () => {
  const clock = fakeClock();
  const guard = createSaveGuard({ ...clock, random: () => 0.5 });
  let calls = 0;
  await guard.run('t1', async () => { calls++; throw httpError(503); });
  guard.run('t1', async () => { calls++; throw httpError(409); });
  await clock.advance(1000);
  assert.equal(calls, 2);
  assert.ok(guard.isPaused('t1'));
  await clock.advance(600_000);
  assert.equal(calls, 2);
});

// --- trip-controller integration (vm) -----------------------------------------

function loadTripController({ updateImpl, getImpl }) {
  const calls = { update: [], get: 0, prompts: 0, toasts: [], loaded: [], refresh: 0 };
  let prompt = null;
  const clock = fakeClock();
  const window = { RideSaveGuard: Guard, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout };
  const App = {
    useCloud: true,
    currentUser: { id: 'u1' },
    currentTrip: { id: 'trip-1', name: 'Invented trip', version: 3, route: null, settings: {} },
    normalizeTrip: t => t,
    loadTripData(t) { calls.loaded.push(t); this.currentTrip = t; },
    refreshData() { calls.refresh++; },
    refreshTripsList() {},
    loadInitialTrip() {},
  };
  const context = {
    App,
    window,
    Object,
    Number,
    Math,
    Map,
    Set,
    Promise,
    console: { error() {}, warn() {}, log() {} },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    Date,
    Storage: { getTripOrder: () => [], setTripOrder() {} },
    Trip: {},
    MapManager: {},
    CustomEvent: class {},
    API: {
      trips: {
        async update(id, body, opts) { calls.update.push({ id, body, ifMatch: opts?.headers?.['If-Match'] }); return updateImpl(calls.update.length); },
        async get() { calls.get++; return getImpl(); },
      },
    },
    UI: {
      showToast: (m, t) => calls.toasts.push([t, m]),
      showTripConflictPrompt(handlers) { calls.prompts++; prompt = handlers; },
      hideTripConflictPrompt() {},
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'trip-controller.js'), 'utf8'), context);
  // The controller defines its own map/UI-heavy versions; keep the stubs.
  App.loadTripData = function (t) { calls.loaded.push(t); this.currentTrip = t; };
  App.refreshData = function () { calls.refresh++; };
  App.refreshTripsList = function () {};
  return { App, calls, clock, prompt: () => prompt };
}

test('trip save hitting 409 fetches the latest once, prompts, and stops saving', async () => {
  const { App, calls } = loadTripController({
    updateImpl: () => { throw httpError(409, { body: { trip_version: 9 } }); },
    getImpl: () => ({ id: 'trip-1', name: 'Server copy', version: 9 }),
  });
  assert.equal(await App.saveCurrentTrip(), false);
  await flush();
  for (let i = 0; i < 200; i++) assert.equal(await App.saveCurrentTrip(), false);
  // Other conflict sources (waypoint edits) during the same episode don't refetch.
  await App.handleTripConflict(httpError(409));
  assert.equal(calls.update.length, 1, 'one PUT');
  assert.equal(calls.get, 1, 'latest fetched once');
  assert.equal(calls.prompts, 1, 'prompt shown once');
  assert.equal(calls.refresh, 0, 'no automatic reload (that re-triggered OSRM)');
  assert.ok(App.isTripSavePaused('trip-1'));
});

test('Reload loads the fetched server copy and resumes autosave', async () => {
  const { App, calls, prompt } = loadTripController({
    updateImpl: n => { if (n === 1) throw httpError(409); return { version: 10 }; },
    getImpl: () => ({ id: 'trip-1', name: 'Server copy', version: 9 }),
  });
  await App.saveCurrentTrip();
  await flush();
  await prompt().onReload();
  assert.equal(calls.loaded.length, 1);
  assert.equal(App.currentTrip.name, 'Server copy');
  assert.ok(!App.isTripSavePaused('trip-1'));
  assert.equal(await App.saveCurrentTrip(), true);
  assert.equal(calls.update[1].ifMatch, '9');
});

test('Keep mine adopts the server version and saves this copy once', async () => {
  const { App, calls, prompt } = loadTripController({
    updateImpl: n => { if (n === 1) throw httpError(409); return { version: 10 }; },
    getImpl: () => ({ id: 'trip-1', name: 'Server copy', version: 9 }),
  });
  App.currentTrip.name = 'My edit';
  await App.saveCurrentTrip();
  await flush();
  await prompt().onKeepMine();
  assert.equal(calls.update.length, 2);
  assert.equal(calls.update[1].ifMatch, '9', 'resent with the server version');
  assert.equal(calls.update[1].body.name, 'My edit');
  assert.equal(App.currentTrip.version, 10);
  assert.equal(calls.loaded.length, 0, 'local copy kept');
});

test('Keep mine that conflicts again asks again instead of looping', async () => {
  const { App, calls, prompt } = loadTripController({
    updateImpl: () => { throw httpError(409); },
    getImpl: () => ({ id: 'trip-1', version: 9 }),
  });
  await App.saveCurrentTrip();
  await flush();
  await prompt().onKeepMine();
  await flush();
  assert.equal(calls.update.length, 2);
  assert.equal(calls.prompts, 2);
  assert.ok(App.isTripSavePaused('trip-1'));
});

test('a 503 trip save retries with back-off, not immediately', async () => {
  const { App, calls, clock } = loadTripController({
    updateImpl: n => { if (n < 3) throw httpError(503); return { version: 4 }; },
    getImpl: () => ({}),
  });
  assert.equal(await App.saveCurrentTrip(), false);
  for (let i = 0; i < 50; i++) await App.saveCurrentTrip();
  assert.equal(calls.update.length, 1);
  await clock.advance(800);
  assert.equal(calls.update.length, 1, 'no retry before ~1s');
  await clock.advance(10_000);
  assert.equal(calls.update.length, 3);
  assert.equal(App.currentTrip.version, 4);
  assert.ok(calls.toasts.some(([type, m]) => type === 'success' && /Saved/.test(m)));
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (error) {
      failed++;
      console.error(`not ok - ${name}\n${error.stack}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  if (failed) process.exit(1);
})();
