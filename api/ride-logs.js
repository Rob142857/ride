/** Private, idempotent GPS track storage for ride mode. */
import { jsonResponse, errorResponse, generateId, parseBody } from './utils.js';
import { safeJsonParse } from './handler-utils.js';

// Historical app versions submitted a whole ride in one request, up to 3000 fixes.
const MAX_POINTS = 3000;
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

function validPoint(point) {
  if (!point || typeof point !== 'object' || Array.isArray(point) ||
      typeof point.lat !== 'number' || typeof point.lng !== 'number') return false;
  const lat = point.lat;
  const lng = point.lng;
  const time = typeof point.t === 'number' ? point.t : (typeof point.t === 'string' ? Date.parse(point.t) : NaN);
  return Number.isFinite(lat) && lat >= -90 && lat <= 90 &&
    Number.isFinite(lng) && lng >= -180 && lng <= 180 && Number.isFinite(time) && Math.abs(time) <= 8.64e15;
}

function normalizeTrack(track) {
  const normalized = [];
  let previousTime = -Infinity;
  for (const point of track) {
    if (!validPoint(point)) return null;
    const time = typeof point.t === 'number' ? point.t : Date.parse(point.t);
    if (time < previousTime) return null;
    previousTime = time;
    normalized.push({ lat: point.lat, lng: point.lng, t: point.t });
  }
  return normalized;
}

export const RideLogsHandler = {
  async saveRideLog(context) {
    const { env, user, params, request } = context;
    const body = await parseBody(request);
    if (!body || typeof body !== 'object') return errorResponse('Invalid ride log', 400);

    const trip = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT id FROM trips WHERE id = ? AND user_id = ?'
    ).bind(params.tripId, user.id).first();
    if (!trip) return errorResponse('Trip not found', 404);

    const rawTrack = body.track;
    if (!Array.isArray(rawTrack) || rawTrack.length < 1 || rawTrack.length > MAX_POINTS) {
      return errorResponse(`Track must contain 1 to ${MAX_POINTS} valid points`, 400);
    }
    const track = normalizeTrack(rawTrack);
    if (!track) return errorResponse('Track points must be valid and ordered by time', 400);
    if ((body.started_at != null && !validTime(body.started_at)) ||
        (body.ended_at != null && !validTime(body.ended_at))) {
      return errorResponse('Invalid ride log timestamp', 400);
    }
    if (body.started_at != null && body.ended_at != null && Date.parse(body.ended_at) < Date.parse(body.started_at)) {
      return errorResponse('Ride log end precedes its start', 400);
    }
    const nonNegative = value => value == null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
    if (!nonNegative(body.distance_meters) || !nonNegative(body.duration_seconds)) {
      return errorResponse('Invalid ride log metrics', 400);
    }
    if (body.journal_entry_id) {
      const entry = await env.RIDE_TRIP_PLANNER_DB.prepare(
        'SELECT id FROM journal_entries WHERE id = ? AND trip_id = ?'
      ).bind(body.journal_entry_id, params.tripId).first();
      if (!entry) return errorResponse('Journal entry not found', 404);
    }

    if (body.client_log_id != null && (typeof body.client_log_id !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,80}$/.test(body.client_log_id))) return errorResponse('Invalid ride log id', 400);
    const id = body.client_log_id || generateId();

    // Stable client IDs make retries safe. A conflicting ID belonging to a different
    // trip is rejected and never overwritten.
    const existing = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT id, trip_id FROM ride_logs WHERE id = ?'
    ).bind(id).first();
    if (existing) {
      if (existing.trip_id !== params.tripId) return errorResponse('Ride log id conflict', 409);
      return jsonResponse({ id, success: true, duplicate: true });
    }

    await env.RIDE_TRIP_PLANNER_DB.prepare(
      `INSERT OR IGNORE INTO ride_logs
         (id, trip_id, journal_entry_id, started_at, ended_at, distance_meters, duration_seconds, track)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, params.tripId, body.journal_entry_id || null,
      body.started_at || null, body.ended_at || null,
      body.distance_meters ?? null, body.duration_seconds ?? null, JSON.stringify(track)
    ).run();

    const saved = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT id, trip_id FROM ride_logs WHERE id = ?'
    ).bind(id).first();
    if (!saved || saved.trip_id !== params.tripId) return errorResponse('Ride log id conflict', 409);

    return jsonResponse({ id, success: true });
  },

  async listRideLogs(context) {
    const { env, user, params } = context;
    const trip = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT id FROM trips WHERE id = ? AND user_id = ?'
    ).bind(params.tripId, user.id).first();
    if (!trip) return errorResponse('Trip not found', 404);

    // Bound each response while allowing the client to retrieve the whole trip.
    const url = context.url || new URL(context.request?.url || 'https://ride.invalid/');
    const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0);
    const rows = await env.RIDE_TRIP_PLANNER_DB.prepare(
      `SELECT id, started_at, ended_at, distance_meters, duration_seconds,
              journal_entry_id, track
       FROM ride_logs WHERE trip_id = ? ORDER BY created_at ASC, id ASC LIMIT 101 OFFSET ?`
    ).bind(params.tripId, offset).all();

    const results = rows.results || [];
    return jsonResponse({ next_offset: results.length > 100 ? offset + 100 : null,
      logs: results.slice(0, 100).map(r => ({
      id: r.id,
      started_at: r.started_at,
      ended_at: r.ended_at,
      distance_meters: r.distance_meters,
      duration_seconds: r.duration_seconds,
      journal_entry_id: r.journal_entry_id,
      track: safeJsonParse(r.track, [])
    })) });
  }
};
