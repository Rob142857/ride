const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function accountSession() {
  const data = new Map([['ride_last_user_id', 'owner-a']]);
  const state = { clears: 0, ended: 0, nextUser: { id: 'owner-a' }, failure: null };
  const app = {
    currentUser: { id: 'owner-a' }, currentTrip: { id: 'private-a' }, useCloud: true,
    _clearTripUI() { state.clears++; this.currentTrip = null; },
    endRideForTripSwitch() { state.ended++; }
  };
  const context = {
    App: app, window: {},
    localStorage: { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) },
    Storage: { clearTrips() {}, setTripOrder() {} },
    UI: { hideAuthGate() {}, closeModal() {}, showToast() {}, isLandingGateVisible: () => false, showAuthGate() {} },
    API: { auth: { async getUser() { if (state.failure) throw state.failure; return state.nextUser; } } },
    console
  };
  vm.runInNewContext(fs.readFileSync('public/js/auth-controller.js', 'utf8'), context);
  app.updateUserUI = () => {};
  app._authState = 'AUTHENTICATED';
  return { app, state };
}

(async () => {
  const expired = accountSession();
  expired.state.nextUser = null;
  assert.equal(await expired.app.checkAuth(), false);
  assert.equal(expired.app.currentUser, null);
  assert.equal(expired.app.currentTrip, null, 'an expired recheck clears private trip data after CHECKING');
  assert.equal(expired.state.clears, 1);

  const changed = accountSession();
  changed.state.nextUser = { id: 'owner-b' };
  await changed.app.checkAuth();
  assert.equal(changed.app.currentUser.id, 'owner-b');
  assert.equal(changed.app.currentTrip, null, 'account switches remove the former owner’s map');

  const offline = accountSession();
  offline.app.isRiding = true;
  offline.state.failure = Object.assign(new Error('offline'), { status: 0 });
  assert.equal(await offline.app.checkAuth(), false);
  assert.equal(offline.app.currentUser.id, 'owner-a');
  assert.equal(offline.app.currentTrip.id, 'private-a');
  assert.equal(offline.state.clears, 0);
  offline.app.handleConnectionLost({ kind: 'network' });
  assert.equal(offline.app.currentTrip.id, 'private-a', 'offline recording keeps its captured owner');
  console.log('Ride account checks passed: expired sessions, account switches, and offline rides.');
})().catch(error => { console.error(error); process.exitCode = 1; });
