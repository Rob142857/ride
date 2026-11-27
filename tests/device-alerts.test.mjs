import test from 'node:test';
import assert from 'node:assert/strict';
import {
  distanceM, evaluateFix, evaluateBattery, evaluateSilent,
  ZONE_RADIUS_M, LOW_BATTERY_PCT, COOLDOWN_S
} from '../api/device-alerts.js';

const NOW = 1_800_000_000;
const armed = { id: 'd1', armed: 1, revoked_at: null };
const zone = { lat: -33.0742, lng: 151.6096 };
// 0.001 degrees of latitude is about 111 m.
const near = { lat: -33.0742, lng: 151.6097, accuracy_m: 5, motion: 0 };
const far = { lat: -33.0722, lng: 151.6096, accuracy_m: 5, motion: 0 };

test('distance: 0.001 degree of latitude is about 111 m', () => {
  const d = distanceM({ lat: 0, lng: 0 }, { lat: 0.001, lng: 0 });
  assert.ok(d > 110 && d < 112, String(d));
});

test('armed device inside the zone raises nothing', () => {
  assert.deepEqual(evaluateFix({ device: armed, zone, fix: near, nowS: NOW }), []);
});

test('armed device 220 m away raises left_zone', () => {
  const out = evaluateFix({ device: armed, zone, fix: far, nowS: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'left_zone');
});

test('a poor-accuracy fix cannot prove the bike left the zone', () => {
  const out = evaluateFix({ device: armed, zone, fix: { ...far, accuracy_m: 400 }, nowS: NOW });
  assert.deepEqual(out, []);
});

test('accuracy is subtracted: 120 m away with 30 m accuracy is not clearly outside a 100 m zone', () => {
  const edge = { lat: -33.0742 + 0.00108, lng: 151.6096, accuracy_m: 30, motion: 0 };
  assert.deepEqual(evaluateFix({ device: armed, zone, fix: edge, nowS: NOW }), []);
});

test('motion while armed raises moved, even with no zone centre', () => {
  const out = evaluateFix({ device: armed, zone: null, fix: { ...near, motion: 1 }, nowS: NOW });
  assert.deepEqual(out.map(a => a.kind), ['moved']);
});

test('disarmed or revoked device raises nothing', () => {
  assert.deepEqual(evaluateFix({ device: { ...armed, armed: 0 }, zone, fix: { ...far, motion: 1 }, nowS: NOW }), []);
  assert.deepEqual(evaluateFix({ device: { ...armed, revoked_at: 'x' }, zone, fix: { ...far, motion: 1 }, nowS: NOW }), []);
});

test('cooldown: a repeat inside the window is quiet, after it fires again', () => {
  const last = { left_zone: NOW - 60, moved: NOW - 60 };
  assert.deepEqual(evaluateFix({ device: armed, zone, fix: { ...far, motion: 1 }, nowS: NOW, lastAlertS: last }), []);
  const later = NOW + COOLDOWN_S.left_zone;
  assert.equal(evaluateFix({ device: armed, zone, fix: far, nowS: later, lastAlertS: last }).length, 1);
});

test('zone radius can be set per device and defaults to the constant', () => {
  assert.equal(ZONE_RADIUS_M, 100);
  const small = { ...zone, radius_m: 20 };
  // 0.0004 degrees of longitude at this latitude is about 37 m, so outside a 20 m zone even after 5 m of accuracy.
  assert.equal(evaluateFix({ device: armed, zone: small, fix: { ...near, lng: 151.6100 }, nowS: NOW }).length, 1);
  assert.deepEqual(evaluateFix({ device: armed, zone: small, fix: near, nowS: NOW }), []);
});

test('low battery fires at or below the threshold, once per cooldown', () => {
  assert.equal(evaluateBattery({ device: armed, battery: LOW_BATTERY_PCT, nowS: NOW }).length, 1);
  assert.deepEqual(evaluateBattery({ device: armed, battery: LOW_BATTERY_PCT + 1, nowS: NOW }), []);
  assert.deepEqual(evaluateBattery({ device: armed, battery: 5, nowS: NOW, lastAlertS: { low_battery: NOW - 3600 } }), []);
  assert.deepEqual(evaluateBattery({ device: armed, battery: null, nowS: NOW }), []);
});

test('silent: two missed check-ins plus grace, not before', () => {
  const base = { device: armed, intervalS: 60, nowS: NOW };
  assert.deepEqual(evaluateSilent({ ...base, lastSeenS: NOW - 200 }), []);          // 3 min: still inside 2*60+120 = 240 s
  assert.equal(evaluateSilent({ ...base, lastSeenS: NOW - 300 }).length, 1);         // 5 min: silent
});

test('silent: a device that has never sent, a revoked device and a repeat inside the cooldown raise nothing', () => {
  assert.deepEqual(evaluateSilent({ device: armed, lastSeenS: null, intervalS: 60, nowS: NOW }), []);
  assert.deepEqual(evaluateSilent({ device: { ...armed, revoked_at: 'x' }, lastSeenS: NOW - 9999, intervalS: 60, nowS: NOW }), []);
  assert.deepEqual(evaluateSilent({ device: armed, lastSeenS: NOW - 9999, intervalS: 60, nowS: NOW, lastAlertS: { silent: NOW - 600 } }), []);
});
