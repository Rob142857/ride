/**
 * Bike trackers ("devices") and their GPS fixes.
 *
 * - Each device has its own secret ("ride_dev_" + 43 base64url chars), shown
 *   once. Only its SHA-256 hash is stored and devices are found by hash lookup,
 *   the same way as personal access tokens (api-tokens.js).
 * - Management (/api/devices...) is for a signed-in Ride session only: any
 *   Authorization header is refused, so a device secret or a token can never
 *   create, list, change or revoke devices.
 * - Ingest (/api/device/fixes, /api/device/osmand) takes the device secret only.
 *   A device can post fixes for itself and nothing else. Bad or revoked secret
 *   is a bare 401. Ingest responses carry no CORS headers.
 * - Ingest is rate limited per device in the api_token_rate table, keyed
 *   "dev:<device id>" so it never collides with a token id.
 */
import { jsonResponse, errorResponse, generateId, parseBody, requireAuth } from './utils.js';
import { verifyTripOwnership } from './handler-utils.js';
import { generateSecret, sha256Hex, timingSafeEqualText, withoutCors, sameOriginWrite, countRequest } from './api-tokens.js';

export const DEVICE_PREFIX = 'ride_dev_';
export const MAX_FIXES_PER_POST = 120;
export const MAX_ACTIVE_DEVICES = 10;
export const DEVICE_RATE_LIMIT_PER_MINUTE = 60;
export const DEFAULT_INTERVAL_S = 60;
export const MAX_FIX_AGE_S = 7 * 86400;
export const MAX_FIX_AHEAD_S = 300;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_HISTORY_FIXES = 5000;
const DEVICE_PATTERN = /^ride_dev_[A-Za-z0-9_-]{43}$/;
const KNOTS_TO_KMH = 1.852;
const MPS_TO_KMH = 3.6;
const DEVICE_COLUMNS = 'id, name, bike_name, secret_prefix, armed, trip_id, created_at, last_seen_at, last_battery, revoked_at';

const nowIso = () => new Date().toISOString();
const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const round1 = value => Math.round(value * 10) / 10;

/** A new device secret: 'ride_dev_' + 43 base64url chars (32 random bytes). */
export function generateDeviceSecret() {
  return generateSecret(DEVICE_PREFIX);
}

function publicDevice(row) {
  return {
    id: row.id,
    name: row.name,
    bike_name: row.bike_name || null,
    hint: `${row.secret_prefix}…`,
    armed: !!row.armed,
    trip_id: row.trip_id || null,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at || null,
    last_battery: row.last_battery ?? null,
    revoked_at: row.revoked_at || null,
    status: row.revoked_at ? 'revoked' : 'active'
  };
}

// ---------------------------------------------------------------------------
// Fix validation
// ---------------------------------------------------------------------------

/** Optional number in [min, max]; undefined/null means "not sent". Returns NaN when bad. */
function optionalNumber(value, min, max) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) return NaN;
  return value;
}

/**
 * One fix [t, lat, lng, speed_kmh, heading, accuracy_m, sats, battery, motion].
 * t is unix seconds; only t, lat and lng are required. Returns the fix or null.
 */
export function parseFix(input, nowS = Math.floor(Date.now() / 1000)) {
  if (!Array.isArray(input) || input.length < 3 || input.length > 9) return null;
  const [t, lat, lng, speed, heading, accuracy, sats, battery, motion] = input;
  if (!Number.isInteger(t) || t < nowS - MAX_FIX_AGE_S || t > nowS + MAX_FIX_AHEAD_S) return null;
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) return null;
  if (typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180) return null;
  if (lat === 0 && lng === 0) return null; // a receiver with no fix often reports 0,0
  const fix = {
    t, lat, lng,
    speed_kmh: optionalNumber(speed, 0, 400),
    heading: optionalNumber(heading, 0, 360),
    accuracy_m: optionalNumber(accuracy, 0, 100000),
    sats: optionalNumber(sats, 0, 64),
    battery: optionalNumber(battery, 0, 100),
    motion: motion === true ? 1 : motion === false ? 0 : optionalNumber(motion, 0, 1)
  };
  for (const key of ['speed_kmh', 'heading', 'accuracy_m', 'sats', 'battery', 'motion']) {
    if (Number.isNaN(fix[key])) return null;
  }
  if (fix.sats !== null && !Number.isInteger(fix.sats)) return null;
  if (fix.motion !== null && !Number.isInteger(fix.motion)) return null;
  if (fix.speed_kmh !== null) fix.speed_kmh = round1(fix.speed_kmh);
  if (fix.heading !== null) fix.heading = round1(fix.heading) % 360;
  if (fix.accuracy_m !== null) fix.accuracy_m = round1(fix.accuracy_m);
  if (fix.battery !== null) fix.battery = round1(fix.battery);
  return fix;
}

// ---------------------------------------------------------------------------
// OsmAnd / Traccar Client protocol
//
// Mirrors Traccar's own decoder, OsmAndProtocolDecoder.java
// (https://github.com/traccar/traccar/blob/master/src/main/java/org/traccar/protocol/OsmAndProtocolDecoder.java):
// - Query form (Traccar Client before v9, OsmAnd "online tracking"):
//   id|deviceid, lat, lon, timestamp, speed, bearing|heading, accuracy, batt.
//   "speed" is in knots: convertSpeed(Double.parseDouble(value), "kn").
//   "timestamp" is unix seconds, or ms when >= Integer.MAX_VALUE, or a date
//   ("...T..." ISO, else "yyyy-MM-dd HH:mm:ss", UTC).
// - JSON form (Traccar Client v9+): device_id, location.timestamp (ISO),
//   location.coords.{latitude, longitude, speed (m/s), heading, accuracy},
//   location.battery.level (0-1), location.is_moving. Negative speed or
//   heading means "unknown".
// The id is the device secret here, so it is hashed and looked up.
// ---------------------------------------------------------------------------

const toNumber = value => (value === undefined || value === null || value === '' ? null : Number(value));

/** OsmAnd timestamp to unix seconds (null when missing, NaN when bad). */
export function osmandSeconds(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    return n < 2147483647 ? n : Math.floor(n / 1000);
  }
  const iso = text.includes('T') ? text : `${text.replace(' ', 'T')}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : NaN;
}

/** Query/form parameters to { secret, fix } (fix is the raw array for parseFix). */
export function osmandQueryToFix(params, nowS = Math.floor(Date.now() / 1000)) {
  const get = (...names) => { for (const name of names) { const v = params.get(name); if (v !== null) return v; } return null; };
  const t = osmandSeconds(get('timestamp'));
  const knots = toNumber(get('speed'));
  const heading = toNumber(get('bearing', 'heading'));
  const fix = [
    t === null ? nowS : t,
    toNumber(get('lat')), toNumber(get('lon')),
    knots === null ? null : knots * KNOTS_TO_KMH,
    heading, toNumber(get('accuracy')), null, toNumber(get('batt')), null
  ];
  return { secret: get('id', 'deviceid') || '', fix };
}

/** Traccar Client v9 JSON body to { secret, fix }. */
export function osmandJsonToFix(body, nowS = Math.floor(Date.now() / 1000)) {
  const location = isPlainObject(body?.location) ? body.location : {};
  const coords = isPlainObject(location.coords) ? location.coords : {};
  const known = value => (typeof value === 'number' && value >= 0 ? value : null);
  const t = osmandSeconds(location.timestamp);
  const speed = known(coords.speed);
  const level = known(location.battery?.level);
  const fix = [
    t === null ? nowS : t,
    coords.latitude, coords.longitude,
    speed === null ? null : speed * MPS_TO_KMH,
    known(coords.heading), known(coords.accuracy), null,
    level === null ? null : Math.min(100, level * 100),
    typeof location.is_moving === 'boolean' ? location.is_moving : null
  ];
  return { secret: typeof body?.device_id === 'string' ? body.device_id : '', fix };
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

const deviceReply = (data, status = 200) => withoutCors(jsonResponse(data, status));
const unauthorized = () => deviceReply({ error: 'Unauthorized' }, 401);

/** The device row for a secret, or null (bad format, unknown or revoked). */
export async function verifyDevice(env, secret) {
  if (typeof secret !== 'string' || !DEVICE_PATTERN.test(secret)) return null;
  const hash = await sha256Hex(secret);
  const row = await env.RIDE_TRIP_PLANNER_DB.prepare(
    'SELECT id, user_id, secret_hash, armed, revoked_at FROM devices WHERE secret_hash = ?'
  ).bind(hash).first();
  if (!row || !timingSafeEqualText(row.secret_hash, hash) || row.revoked_at) return null;
  return row;
}

async function rateLimited(env, deviceId) {
  const count = await countRequest(env, `dev:${deviceId}`);
  if (count <= DEVICE_RATE_LIMIT_PER_MINUTE) return null;
  const response = deviceReply({ error: 'Rate limit exceeded' }, 429);
  response.headers.set('Retry-After', String(60 - (Math.floor(Date.now() / 1000) % 60)));
  return response;
}

/** Insert valid fixes (resends are ignored), then touch the device. */
async function storeFixes(env, device, rawFixes) {
  const nowS = Math.floor(Date.now() / 1000);
  const receivedAt = nowIso();
  const fixes = [];
  let rejected = 0;
  for (const raw of rawFixes) {
    const fix = parseFix(raw, nowS);
    if (fix) fixes.push(fix); else rejected += 1;
  }
  let accepted = 0;
  if (fixes.length) {
    const statements = fixes.map(fix => env.RIDE_TRIP_PLANNER_DB.prepare(
      `INSERT OR IGNORE INTO device_fixes (device_id, t, lat, lng, speed_kmh, heading, accuracy_m, sats, battery, motion, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(device.id, fix.t, fix.lat, fix.lng, fix.speed_kmh, fix.heading, fix.accuracy_m, fix.sats, fix.battery, fix.motion, receivedAt));
    const results = await env.RIDE_TRIP_PLANNER_DB.batch(statements);
    accepted = results.reduce((sum, result) => sum + Number(result?.meta?.changes || 0), 0);
  }
  const newestWithBattery = fixes.filter(fix => fix.battery !== null).sort((a, b) => b.t - a.t)[0];
  await env.RIDE_TRIP_PLANNER_DB.prepare(
    'UPDATE devices SET last_seen_at = ?, last_battery = COALESCE(?, last_battery) WHERE id = ?'
  ).bind(receivedAt, newestWithBattery ? newestWithBattery.battery : null, device.id).run();
  return {
    ok: true,
    accepted,
    duplicates: fixes.length - accepted,
    rejected,
    config: { interval_s: DEFAULT_INTERVAL_S, armed: !!device.armed, calibrate: false }
  };
}

/** Read a small request body as text, or null when it is too big. */
async function boundedText(request) {
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > MAX_BODY_BYTES) return null;
  const text = await request.text();
  return text.length > MAX_BODY_BYTES ? null : text;
}

function presentedDeviceSecret(request) {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get('Authorization') || '');
  return match ? match[1] : '';
}

export const DeviceIngestHandler = {
  /** OPTIONS on ingest: no CORS, so browsers can never call these routes. */
  preflight() {
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  },

  /** POST /api/device/fixes with Authorization: Bearer ride_dev_... */
  async fixes(context) {
    const { env, request } = context;
    const device = await verifyDevice(env, presentedDeviceSecret(request));
    if (!device) return unauthorized();
    const limited = await rateLimited(env, device.id);
    if (limited) return limited;

    const text = await boundedText(request);
    if (text === null) return deviceReply({ error: 'Body too large' }, 413);
    let body;
    try { body = JSON.parse(text); } catch (_) { body = null; }
    if (!isPlainObject(body) || !Array.isArray(body.fixes) || !body.fixes.length) {
      return deviceReply({ error: 'Body must be {"fixes": [[t, lat, lng, ...], ...]}' }, 400);
    }
    if (body.fixes.length > MAX_FIXES_PER_POST) return deviceReply({ error: `At most ${MAX_FIXES_PER_POST} fixes per post` }, 400);
    return deviceReply(await storeFixes(env, device, body.fixes));
  },

  /** GET or POST /api/device/osmand (OsmAnd / Traccar Client). */
  async osmand(context) {
    const { env, request } = context;
    const url = context.url || new URL(request.url);
    let parsed = osmandQueryToFix(url.searchParams);
    if (request.method.toUpperCase() === 'POST') {
      const text = await boundedText(request);
      if (text === null) return deviceReply({ error: 'Body too large' }, 413);
      const type = (request.headers.get('Content-Type') || '').toLowerCase();
      if (type.includes('application/json') && text) {
        let body;
        try { body = JSON.parse(text); } catch (_) { body = null; }
        if (!isPlainObject(body)) return deviceReply({ error: 'Invalid JSON' }, 400);
        parsed = osmandJsonToFix(body);
      } else if (type.includes('application/x-www-form-urlencoded') && text) {
        const merged = new URLSearchParams(url.searchParams);
        for (const [key, value] of new URLSearchParams(text)) merged.set(key, value);
        parsed = osmandQueryToFix(merged);
      }
    }
    const device = await verifyDevice(env, parsed.secret);
    if (!device) return unauthorized();
    const limited = await rateLimited(env, device.id);
    if (limited) return limited;
    const result = await storeFixes(env, device, [parsed.fix]);
    if (!result.accepted && !result.duplicates) return deviceReply({ error: 'Invalid position' }, 400);
    return deviceReply(result);
  }
};

// ---------------------------------------------------------------------------
// Management (signed-in Ride session only)
// ---------------------------------------------------------------------------

async function requireDeviceOwnerSession(context) {
  if (context.request.headers.get('Authorization')) {
    return errorResponse('Devices can only be managed from a signed-in Ride session', 403);
  }
  const authResult = await requireAuth(context);
  if (authResult instanceof Response) return authResult;
  return sameOriginWrite(context);
}

function optionalName(value, label) {
  if (value === undefined) return { skip: true };
  if (value === null || value === '') return { value: null };
  if (typeof value !== 'string') return { error: `${label} must be text` };
  const trimmed = value.trim();
  if (trimmed.length > 80) return { error: `${label} is too long (max 80)` };
  return { value: trimmed || null };
}

async function ownedDevice(env, userId, id) {
  return env.RIDE_TRIP_PLANNER_DB.prepare(`SELECT ${DEVICE_COLUMNS} FROM devices WHERE id = ? AND user_id = ?`).bind(id, userId).first();
}

async function setArmed(context, armed) {
  const denied = await requireDeviceOwnerSession(context);
  if (denied) return denied;
  const { env, user, params } = context;
  const device = await ownedDevice(env, user.id, params.id);
  if (!device) return errorResponse('Device not found', 404);
  if (device.revoked_at) return errorResponse('This device is revoked', 409);
  await env.RIDE_TRIP_PLANNER_DB.prepare('UPDATE devices SET armed = ? WHERE id = ? AND user_id = ?').bind(armed ? 1 : 0, params.id, user.id).run();
  return jsonResponse({ device: publicDevice(await ownedDevice(env, user.id, params.id)) });
}

export const DevicesHandler = {
  async list(context) {
    const denied = await requireDeviceOwnerSession(context);
    if (denied) return denied;
    const rows = await context.env.RIDE_TRIP_PLANNER_DB.prepare(
      `SELECT ${DEVICE_COLUMNS} FROM devices WHERE user_id = ? ORDER BY revoked_at IS NOT NULL, created_at DESC LIMIT 100`
    ).bind(context.user.id).all();
    return jsonResponse({ devices: (rows.results || []).map(publicDevice) });
  },

  async create(context) {
    const denied = await requireDeviceOwnerSession(context);
    if (denied) return denied;
    const { env, user, request } = context;
    const body = await parseBody(request);
    if (!isPlainObject(body)) return errorResponse('A JSON object is required');
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 80) return errorResponse('Device name is required (max 80 characters)');
    const bike = optionalName(body.bike_name, 'bike_name');
    if (bike.error) return errorResponse(bike.error);
    let tripId = null;
    if (body.trip_id !== undefined && body.trip_id !== null && body.trip_id !== '') {
      if (typeof body.trip_id !== 'string' || !(await verifyTripOwnership(env, body.trip_id, user.id))) return errorResponse('Trip not found', 404);
      tripId = body.trip_id;
    }
    const active = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT COUNT(*) AS n FROM devices WHERE user_id = ? AND revoked_at IS NULL'
    ).bind(user.id).first();
    if (Number(active?.n || 0) >= MAX_ACTIVE_DEVICES) return errorResponse(`You can have at most ${MAX_ACTIVE_DEVICES} active devices. Revoke one first.`, 409);

    const id = generateId();
    const secret = generateDeviceSecret();
    await env.RIDE_TRIP_PLANNER_DB.prepare(
      `INSERT INTO devices (id, user_id, name, bike_name, secret_hash, secret_prefix, armed, trip_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
    ).bind(id, user.id, name, bike.value ?? null, await sha256Hex(secret), secret.slice(0, DEVICE_PREFIX.length + 4), tripId, nowIso()).run();
    return jsonResponse({
      device: publicDevice(await ownedDevice(env, user.id, id)),
      secret,
      notice: 'Copy this device secret now. Ride stores only a hash and cannot show it again.'
    }, 201);
  },

  /** PUT /api/devices/:id { name?, bike_name?, trip_id? (null unlinks) } */
  async update(context) {
    const denied = await requireDeviceOwnerSession(context);
    if (denied) return denied;
    const { env, user, params, request } = context;
    const device = await ownedDevice(env, user.id, params.id);
    if (!device) return errorResponse('Device not found', 404);
    if (device.revoked_at) return errorResponse('This device is revoked', 409);
    const body = await parseBody(request);
    if (!isPlainObject(body)) return errorResponse('A JSON object is required');

    const sets = [];
    const values = [];
    if (body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > 80) return errorResponse('Device name is required (max 80 characters)');
      sets.push('name = ?'); values.push(name);
    }
    const bike = optionalName(body.bike_name, 'bike_name');
    if (bike.error) return errorResponse(bike.error);
    if (!bike.skip) { sets.push('bike_name = ?'); values.push(bike.value); }
    if (body.trip_id !== undefined) {
      if (body.trip_id === null || body.trip_id === '') {
        sets.push('trip_id = ?'); values.push(null);
      } else {
        if (typeof body.trip_id !== 'string' || !(await verifyTripOwnership(env, body.trip_id, user.id))) return errorResponse('Trip not found', 404);
        sets.push('trip_id = ?'); values.push(body.trip_id);
      }
    }
    if (!sets.length) return errorResponse('Nothing to change: send name, bike_name or trip_id');
    await env.RIDE_TRIP_PLANNER_DB.prepare(`UPDATE devices SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`)
      .bind(...values, params.id, user.id).run();
    return jsonResponse({ device: publicDevice(await ownedDevice(env, user.id, params.id)) });
  },

  arm(context) { return setArmed(context, true); },
  disarm(context) { return setArmed(context, false); },

  async revoke(context) {
    const denied = await requireDeviceOwnerSession(context);
    if (denied) return denied;
    const { env, user, params } = context;
    const device = await ownedDevice(env, user.id, params.id);
    if (!device) return errorResponse('Device not found', 404);
    if (!device.revoked_at) {
      await env.RIDE_TRIP_PLANNER_DB.prepare(
        'UPDATE devices SET revoked_at = ?, armed = 0 WHERE id = ? AND user_id = ? AND revoked_at IS NULL'
      ).bind(nowIso(), params.id, user.id).run();
    }
    return jsonResponse({ device: publicDevice(await ownedDevice(env, user.id, params.id)) });
  },

  /** GET /api/devices/:id/fixes?from=<unix s>&to=<unix s>&limit= : the track, oldest first. */
  async history(context) {
    const denied = await requireDeviceOwnerSession(context);
    if (denied) return denied;
    const { env, user, params } = context;
    const device = await ownedDevice(env, user.id, params.id);
    if (!device) return errorResponse('Device not found', 404);
    const url = context.url || new URL(context.request.url);
    const nowS = Math.floor(Date.now() / 1000);
    const parseSeconds = (name, fallback) => {
      const raw = url.searchParams.get(name);
      if (raw === null || raw === '') return fallback;
      return /^\d{1,12}$/.test(raw) ? Number(raw) : NaN;
    };
    const from = parseSeconds('from', nowS - 86400);
    const to = parseSeconds('to', nowS + MAX_FIX_AHEAD_S);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return errorResponse('from and to must be unix seconds, from <= to');
    const limit = Math.min(MAX_HISTORY_FIXES, Math.max(1, Number.parseInt(url.searchParams.get('limit') || '2000', 10) || 2000));
    const rows = await env.RIDE_TRIP_PLANNER_DB.prepare(
      `SELECT t, lat, lng, speed_kmh, heading, accuracy_m, sats, battery, motion FROM device_fixes
       WHERE device_id = ? AND t >= ? AND t <= ? ORDER BY t ASC LIMIT ?`
    ).bind(params.id, from, to, limit).all();
    return jsonResponse({ device_id: params.id, from, to, fixes: rows.results || [] });
  }
};

/**
 * Newest fix from the user's live (non-revoked) devices linked to a trip, or
 * null. One indexed lookup per linked device.
 */
export async function newestDeviceFix(env, userId, tripId) {
  return env.RIDE_TRIP_PLANNER_DB.prepare(
    `SELECT f.device_id, f.t, f.lat, f.lng, f.accuracy_m FROM devices d
     JOIN device_fixes f ON f.id = (SELECT id FROM device_fixes WHERE device_id = d.id ORDER BY t DESC LIMIT 1)
     WHERE d.user_id = ? AND d.trip_id = ? AND d.revoked_at IS NULL
     ORDER BY f.t DESC LIMIT 1`
  ).bind(userId, tripId).first();
}
