// Bike tracker step 2: pure alert rules (no database, no network, no clock of its own).
// Nothing in the Worker calls this yet. The wiring (arm zone column, ingest hook, silent
// cron, Telegram send) needs a D1 migration and a bot, both Rob's yes: see
// _work/engineering-2/2026-11-27-tracker-step2-runbook.md.
//
// Kinds match device_alerts.kind: moved, left_zone, silent, low_battery.

export const ZONE_RADIUS_M = 100;
export const MAX_USEFUL_ACCURACY_M = 50;     // a fix worse than this cannot prove the bike left the zone
export const MISSED_CHECKINS_FOR_SILENT = 2;
export const SILENT_GRACE_S = 120;           // allow for a slow cell connect
export const LOW_BATTERY_PCT = 15;
export const COOLDOWN_S = { moved: 600, left_zone: 600, silent: 3600, low_battery: 12 * 3600 };

const EARTH_RADIUS_M = 6371008.8;

/** Great-circle distance in metres between two {lat, lng} points. */
export function distanceM(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function isPoint(p) {
  return !!p && Number.isFinite(p.lat) && Number.isFinite(p.lng);
}

/** True when this kind of alert for this device was already raised inside its cooldown. */
function coolingDown(kind, nowS, lastAlertS) {
  const last = lastAlertS && lastAlertS[kind];
  return Number.isFinite(last) && nowS - last < COOLDOWN_S[kind];
}

/**
 * Alerts for one newly received fix of an ARMED device.
 *  - moved: the board's motion sensor woke it (fix.motion === 1).
 *  - left_zone: the fix is further than the zone radius from the armed position, and its own
 *    accuracy is good enough that the gap is real (distance minus accuracy still outside).
 * A disarmed device, or one with no zone centre, raises nothing.
 */
export function evaluateFix({ device, zone, fix, nowS, lastAlertS }) {
  const alerts = [];
  if (!device || !device.armed || device.revoked_at || !fix) return alerts;
  if (fix.motion === 1 && !coolingDown('moved', nowS, lastAlertS)) {
    alerts.push({ kind: 'moved', detail: 'Motion sensor woke the tracker while armed' });
  }
  if (isPoint(zone) && isPoint(fix) && !coolingDown('left_zone', nowS, lastAlertS)) {
    const radius = Number.isFinite(zone.radius_m) ? zone.radius_m : ZONE_RADIUS_M;
    const accuracy = Number.isFinite(fix.accuracy_m) ? fix.accuracy_m : 0;
    const d = distanceM(zone, fix);
    if (accuracy <= MAX_USEFUL_ACCURACY_M && d - accuracy > radius) {
      alerts.push({ kind: 'left_zone', detail: `About ${Math.round(d)} m from where it was armed (zone ${radius} m)` });
    }
  }
  return alerts;
}

/** Low battery for the newest reading of any active device. */
export function evaluateBattery({ device, battery, nowS, lastAlertS }) {
  if (!device || device.revoked_at || !Number.isFinite(battery)) return [];
  if (battery > LOW_BATTERY_PCT || coolingDown('low_battery', nowS, lastAlertS)) return [];
  return [{ kind: 'low_battery', detail: `Battery ${Math.round(battery)}%` }];
}

/**
 * Silent: an active device that has sent before has missed two check-ins (plus a grace for a
 * slow connection). `lastSeenS` is the newest fix time in unix seconds; `intervalS` the device's
 * current send interval. A device that has never sent is not "silent", it is new.
 */
export function evaluateSilent({ device, lastSeenS, intervalS, nowS, lastAlertS }) {
  if (!device || device.revoked_at || !Number.isFinite(lastSeenS) || !(intervalS > 0)) return [];
  if (coolingDown('silent', nowS, lastAlertS)) return [];
  const quietFor = nowS - lastSeenS;
  if (quietFor <= MISSED_CHECKINS_FOR_SILENT * intervalS + SILENT_GRACE_S) return [];
  return [{ kind: 'silent', detail: `No fix for about ${Math.round(quietFor / 60)} min` }];
}
