/**
 * Ride Logs handler — save and list actual GPS tracks recorded during ride mode.
 * Each log links to a trip and optionally a private journal entry.
 */
import { jsonResponse, errorResponse, generateId, parseBody } from './utils.js';
import { safeJsonParse } from './handler-utils.js';

export const RideLogsHandler = {
  /**
   * POST /api/trips/:tripId/ride-logs
   * Save a GPS track recorded during ride mode.
   */
  async saveRideLog(context) {
    const { env, user, params, request } = context;
    const body = await parseBody(request);

    const trip = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT id FROM trips WHERE id = ? AND user_id = ?'
    ).bind(params.tripId, user.id).first();
    if (!trip) return errorResponse('Trip not found', 404);

    const track = Array.isArray(body.track) ? body.track : [];
    if (track.length < 2) return errorResponse('Track must have at least 2 points', 400);

    const distanceMeters = typeof body.distance_meters === 'number' && body.distance_meters >= 0
      ? body.distance_meters : null;
    const durationSeconds = typeof body.duration_seconds === 'number' && body.duration_seconds >= 0
      ? body.duration_seconds : null;

    // Limit track size to 3000 points to keep storage reasonable
    const trimmedTrack = track.length > 3000 ? track.slice(-3000) : track;

    const id = generateId();
    await env.RIDE_TRIP_PLANNER_DB.prepare(
      `INSERT INTO ride_logs
         (id, trip_id, journal_entry_id, started_at, ended_at, distance_meters, duration_seconds, track)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      params.tripId,
      body.journal_entry_id || null,
      body.started_at || null,
      body.ended_at || null,
      distanceMeters,
      durationSeconds,
      JSON.stringify(trimmedTrack)
    ).run();

    return jsonResponse({ id, success: true });
  },

  /**
   * GET /api/trips/:tripId/ride-logs
   * List all ride logs for a trip (without full track for list view).
   */
  async listRideLogs(context) {
    const { env, user, params } = context;

    const trip = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT id FROM trips WHERE id = ? AND user_id = ?'
    ).bind(params.tripId, user.id).first();
    if (!trip) return errorResponse('Trip not found', 404);

    const rows = await env.RIDE_TRIP_PLANNER_DB.prepare(
      `SELECT id, started_at, ended_at, distance_meters, duration_seconds,
              journal_entry_id, track
       FROM ride_logs
       WHERE trip_id = ?
       ORDER BY started_at DESC
       LIMIT 50`
    ).bind(params.tripId).all();

    return jsonResponse({
      logs: (rows.results || []).map(r => ({
        id: r.id,
        started_at: r.started_at,
        ended_at: r.ended_at,
        distance_meters: r.distance_meters,
        duration_seconds: r.duration_seconds,
        journal_entry_id: r.journal_entry_id,
        track: safeJsonParse(r.track, [])
      }))
    });
  }
};
