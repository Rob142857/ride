/**
 * Settings-only itinerary update: PUT /api/trips/:id/itinerary.
 * The same change the Ride UI's "Update this itinerary" import saves
 * ({ settings: { itinerary } } with If-Match), with the same guards applied on
 * the server: a valid version 1 plan, a required If-Match version, stops,
 * legs and private note references that belong to this trip. Route,
 * waypoints, journals, visibility and other settings are never touched.
 */
import { jsonResponse, errorResponse, parseBody } from './utils.js';
import { safeJsonParse, parseIfMatchVersion, conflictResponse, preconditionRequiredResponse } from './handler-utils.js';
import { validateTripSettings } from './itinerary-validation.js';
import { assertRowSize } from './route-codec.js';

const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

export const ItineraryWriteHandler = {
  async put(context) {
    const { env, user, params, request } = context;
    const body = await parseBody(request);
    if (!isPlainObject(body) || !isPlainObject(body.itinerary)) return errorResponse('Send { "itinerary": { ... } }');
    const extra = Object.keys(body).filter(key => key !== 'itinerary');
    if (extra.length) return errorResponse(`Only the itinerary can be changed here (unexpected: ${extra.join(', ')})`);
    const settingsError = validateTripSettings({ itinerary: body.itinerary });
    if (settingsError) return errorResponse(settingsError);

    const ifMatch = parseIfMatchVersion(request);
    if (ifMatch === null) return preconditionRequiredResponse();

    const trip = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT id, version, updated_at, settings FROM trips WHERE id = ? AND user_id = ?'
    ).bind(params.id, user.id).first();
    if (!trip) return errorResponse('Trip not found', 404);
    if (Number(trip.version ?? 0) !== ifMatch) return conflictResponse(trip);

    const waypoints = await env.RIDE_TRIP_PLANNER_DB.prepare('SELECT id FROM waypoints WHERE trip_id = ?').bind(params.id).all();
    const journal = await env.RIDE_TRIP_PLANNER_DB.prepare('SELECT id FROM journal_entries WHERE trip_id = ?').bind(params.id).all();
    const waypointIds = new Set((waypoints.results || []).map(row => String(row.id)));
    const journalIds = new Set((journal.results || []).map(row => String(row.id)));
    for (const stop of body.itinerary.stops) {
      if (!stop.waypointId || !waypointIds.has(String(stop.waypointId))) return errorResponse(`${stop.name}: waypoint does not belong to this Ride trip`);
      for (const key of ['fromWaypointId', 'toWaypointId']) {
        if (stop.leg?.[key] && !waypointIds.has(String(stop.leg[key]))) return errorResponse(`${stop.name}: leg waypoint does not belong to this Ride trip`);
      }
      if (stop.privateJournalRefs !== undefined && stop.privateJournalRefs.some(id => !journalIds.has(String(id)))) {
        return errorResponse(`${stop.name}: private note does not belong to this Ride trip`);
      }
    }

    const settings = { ...safeJsonParse(trip.settings || '{}', {}), itinerary: body.itinerary };
    const serialized = JSON.stringify(settings);
    try { assertRowSize([serialized], 'Trip settings'); } catch (error) { return errorResponse(error.message, 413); }

    const result = await env.RIDE_TRIP_PLANNER_DB.prepare(
      `UPDATE trips SET settings = ?, version = COALESCE(version, 0) + 1, updated_at = datetime('now')
       WHERE id = ? AND user_id = ? AND COALESCE(version, 0) = ?`
    ).bind(serialized, params.id, user.id, ifMatch).run();
    if (!Number(result?.meta?.changes || 0)) {
      const current = await env.RIDE_TRIP_PLANNER_DB.prepare('SELECT id, version, updated_at FROM trips WHERE id = ? AND user_id = ?').bind(params.id, user.id).first();
      return current ? conflictResponse(current) : errorResponse('Trip not found', 404);
    }
    const saved = await env.RIDE_TRIP_PLANNER_DB.prepare('SELECT id, version, updated_at FROM trips WHERE id = ? AND user_id = ?').bind(params.id, user.id).first();
    return jsonResponse({ trip: { id: saved.id, version: saved.version, updated_at: saved.updated_at } });
  }
};
