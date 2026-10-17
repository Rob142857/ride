/**
 * Location check-ins ("I'm here"): one point saved on demand, so the owner
 * does not have to start drive mode just to say where they are. Owner-only and
 * scoped by user_id and trip_id. Last known location is the newest of the
 * latest check-in and the last point of the latest ride log.
 */
import { jsonResponse, errorResponse, generateId, parseBody } from './utils.js';
import { safeJsonParse, verifyTripOwnership } from './handler-utils.js';
import { validIsoTime } from './fuel-fills.js';

export const CHECKIN_SOURCES = ['ride', 'companion', 'agent', 'api'];
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;
const COLUMNS = ['id', 'trip_id', 'lat', 'lng', 'accuracy_m', 'recorded_at', 'note', 'source', 'created_at'];
const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

export function validateCheckin(input, { forceSource } = {}) {
  if (!isPlainObject(input)) return { error: 'Invalid check-in' };
  const lat = typeof input.lat === 'string' && input.lat.trim() !== '' ? Number(input.lat) : input.lat;
  const lng = typeof input.lng === 'string' && input.lng.trim() !== '' ? Number(input.lng) : input.lng;
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90 ||
      typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    return { error: 'A valid lat and lng are required' };
  }
  let accuracy = null;
  if (input.accuracy_m !== undefined && input.accuracy_m !== null && input.accuracy_m !== '') {
    accuracy = Number(input.accuracy_m);
    if (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 100000) return { error: 'accuracy_m must be a number from 0 up to 100000' };
    accuracy = Math.round(accuracy * 10) / 10;
  }
  const recordedAt = input.recorded_at === undefined || input.recorded_at === null || input.recorded_at === '' ? new Date().toISOString() : input.recorded_at;
  if (!validIsoTime(recordedAt)) return { error: 'recorded_at must be an ISO date-time with a time zone' };
  if (Date.parse(recordedAt) > Date.now() + 3600000) return { error: 'recorded_at cannot be in the future' };
  let note = null;
  if (input.note !== undefined && input.note !== null) {
    if (typeof input.note !== 'string') return { error: 'note must be text' };
    note = input.note.trim().slice(0, 501) || null;
    if (note && note.length > 500) return { error: 'note is too long (max 500)' };
  }
  const source = forceSource || (input.source === undefined || input.source === null || input.source === '' ? 'api' : input.source);
  if (!CHECKIN_SOURCES.includes(source)) return { error: `source must be one of: ${CHECKIN_SOURCES.join(', ')}` };
  return { checkin: { lat, lng, accuracy_m: accuracy, recorded_at: new Date(Date.parse(recordedAt)).toISOString(), note, source } };
}

export function serializeCheckin(row) {
  if (!row) return null;
  const out = {};
  for (const column of COLUMNS) out[column] = row[column] ?? null;
  return out;
}

function pointTime(point) {
  if (typeof point?.t === 'number') return point.t;
  if (typeof point?.t === 'string') return Date.parse(point.t);
  return NaN;
}

/** Newest of the latest check-in and the last fix of the newest ride logs. */
export async function lastKnownLocation(env, userId, tripId) {
  const checkin = await env.RIDE_TRIP_PLANNER_DB.prepare(
    `SELECT ${COLUMNS.join(', ')} FROM checkins WHERE trip_id = ? AND user_id = ? ORDER BY recorded_at DESC LIMIT 1`
  ).bind(tripId, userId).first();
  const logs = await env.RIDE_TRIP_PLANNER_DB.prepare(
    `SELECT id, started_at, ended_at, track FROM ride_logs WHERE trip_id = ?
     ORDER BY COALESCE(ended_at, started_at, created_at) DESC LIMIT 5`
  ).bind(tripId).all();

  let best = null;
  if (checkin) {
    best = {
      source: 'checkin', lat: checkin.lat, lng: checkin.lng, accuracy_m: checkin.accuracy_m,
      at: checkin.recorded_at, note: checkin.note, checkin_id: checkin.id, checkin_source: checkin.source
    };
  }
  for (const log of logs.results || []) {
    const track = safeJsonParse(log.track, []);
    if (!Array.isArray(track) || !track.length) continue;
    const point = track[track.length - 1];
    const time = pointTime(point);
    if (!Number.isFinite(time) || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) continue;
    if (!best || time > Date.parse(best.at)) {
      best = { source: 'ride-log', lat: point.lat, lng: point.lng, accuracy_m: null, at: new Date(time).toISOString(), note: null, ride_log_id: log.id };
    }
  }
  return { last_location: best, last_checkin: serializeCheckin(checkin) };
}

export const CheckinsHandler = {
  async list(context) {
    const { env, user, params } = context;
    const trip = await verifyTripOwnership(env, params.tripId, user.id);
    if (!trip) return errorResponse('Trip not found', 404);
    const url = context.url || new URL(context.request.url);
    const limit = Math.min(500, Math.max(1, Number.parseInt(url.searchParams.get('limit') || '50', 10) || 50));
    const rows = await env.RIDE_TRIP_PLANNER_DB.prepare(
      `SELECT ${COLUMNS.join(', ')} FROM checkins WHERE trip_id = ? AND user_id = ? ORDER BY recorded_at DESC LIMIT ?`
    ).bind(params.tripId, user.id, limit).all();
    return jsonResponse({ checkins: (rows.results || []).map(serializeCheckin) });
  },

  async create(context, options = {}) {
    const { env, user, params, request } = context;
    const body = await parseBody(request);
    if (!isPlainObject(body)) return errorResponse('A JSON object is required');
    const trip = await verifyTripOwnership(env, params.tripId, user.id);
    if (!trip) return errorResponse('Trip not found', 404);
    if (body.id != null && (typeof body.id !== 'string' || !CLIENT_ID_PATTERN.test(body.id))) return errorResponse('id must be 8-80 letters, digits, _ or -');
    const forceSource = options.source || (context.apiToken ? (body.source === 'agent' ? 'agent' : 'api') : null);
    const { checkin, error } = validateCheckin(body, { forceSource });
    if (error) return errorResponse(error);

    const id = body.id || generateId();
    const existing = await env.RIDE_TRIP_PLANNER_DB.prepare('SELECT id, trip_id, user_id FROM checkins WHERE id = ?').bind(id).first();
    if (existing) {
      if (existing.user_id !== user.id || existing.trip_id !== params.tripId) return errorResponse('Check-in id conflict', 409);
      const row = await env.RIDE_TRIP_PLANNER_DB.prepare(`SELECT ${COLUMNS.join(', ')} FROM checkins WHERE id = ?`).bind(id).first();
      return jsonResponse({ checkin: serializeCheckin(row), duplicate: true });
    }
    await env.RIDE_TRIP_PLANNER_DB.prepare(
      `INSERT INTO checkins (id, user_id, trip_id, lat, lng, accuracy_m, recorded_at, note, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, user.id, params.tripId, checkin.lat, checkin.lng, checkin.accuracy_m, checkin.recorded_at, checkin.note, checkin.source, new Date().toISOString()).run();
    const row = await env.RIDE_TRIP_PLANNER_DB.prepare(
      `SELECT ${COLUMNS.join(', ')} FROM checkins WHERE id = ? AND user_id = ?`
    ).bind(id, user.id).first();
    return jsonResponse({ checkin: serializeCheckin(row) }, 201);
  },

  async remove(context) {
    const { env, user, params } = context;
    const result = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'DELETE FROM checkins WHERE id = ? AND trip_id = ? AND user_id = ?'
    ).bind(params.id, params.tripId, user.id).run();
    if (!Number(result?.meta?.changes || 0)) return errorResponse('Check-in not found', 404);
    return jsonResponse({ success: true });
  },

  async lastLocation(context) {
    const { env, user, params } = context;
    const trip = await verifyTripOwnership(env, params.tripId, user.id);
    if (!trip) return errorResponse('Trip not found', 404);
    return jsonResponse(await lastKnownLocation(env, user.id, params.tripId));
  }
};
