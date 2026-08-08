/**
 * Waypoints API Handler
 * CRUD + reorder operations for trip waypoints
 */

import { jsonResponse, errorResponse, generateId } from './utils.js';
import { verifyTripOwnership, parseIfMatchVersion, conflictResponse, preconditionRequiredResponse, invalidIfMatchResponse, safeJsonParse, readJsonBody } from './handler-utils.js';

/**
 * Waypoint types accepted on write. 'via' is a route-shaping point: it bends
 * the route but is not a stop, so it is excluded from stop counts and from the
 * public share payload (see api/journey.js). 'leg-break' is a divider in the
 * sorted waypoint list marking where the next leg begins (name holds the
 * user-editable leg title; lat/lng mirror the nearest adjacent real stop); it
 * is excluded from stop counts like 'via' but, unlike 'via', it IS included in
 * the public share payload (see api/journey.js). No schema change is needed —
 * the column is free text — but writes are constrained here so a typo can
 * never create a silent third category.
 */
const WAYPOINT_TYPES = new Set(['stop', 'scenic', 'fuel', 'food', 'lodging', 'custom', 'via', 'leg-break']);

function normalizeWaypointType(value, fallback = 'stop') {
  if (value === undefined || value === null || value === '') return fallback;
  const type = String(value).trim().toLowerCase();
  return WAYPOINT_TYPES.has(type) ? type : null;
}

export const WaypointsHandler = {
  /**
   * Add waypoint to trip
   */
  async addWaypoint(context) {
    const { env, user, params, request } = context;
    const { body, error } = await readJsonBody(request);
    if (error) return error;

    const trip = await verifyTripOwnership(env, params.tripId, user.id);
    if (!trip) return errorResponse('Trip not found', 404);

    const ifMatch = parseIfMatchVersion(request);
    if (ifMatch === null) return preconditionRequiredResponse();
    if (Number.isNaN(ifMatch)) return invalidIfMatchResponse();
    if (Number(trip.version ?? 0) !== ifMatch) return conflictResponse(trip);

    if (!body.name || body.lat === undefined || body.lng === undefined) {
      return errorResponse('Name, lat, and lng are required');
    }

    const type = normalizeWaypointType(body.type);
    if (type === null) return errorResponse('Invalid waypoint type', 400);

    const lastWp = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT MAX(sort_order) as max_order FROM waypoints WHERE trip_id = ?'
    ).bind(params.tripId).first();

    const sortOrder = (lastWp?.max_order ?? -1) + 1;
    const id = generateId();

    await env.RIDE_TRIP_PLANNER_DB.prepare(
      'INSERT INTO waypoints (id, trip_id, name, address, lat, lng, type, notes, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, params.tripId, body.name, body.address || '', body.lat, body.lng, type, body.notes || '', sortOrder).run();

    const waypoint = await env.RIDE_TRIP_PLANNER_DB.prepare('SELECT * FROM waypoints WHERE id = ?').bind(id).first();
    const tripState = await env.RIDE_TRIP_PLANNER_DB.prepare('SELECT version, updated_at FROM trips WHERE id = ?').bind(params.tripId).first();

    return jsonResponse({ waypoint, trip_version: tripState?.version ?? 0, trip_updated_at: tripState?.updated_at ?? null }, 201);
  },

  /**
   * Update waypoint
   */
  async updateWaypoint(context) {
    const { env, user, params, request } = context;
    const { body, error } = await readJsonBody(request);
    if (error) return error;

    const trip = await verifyTripOwnership(env, params.tripId, user.id);
    if (!trip) return errorResponse('Trip not found', 404);

    const ifMatch = parseIfMatchVersion(request);
    if (ifMatch === null) return preconditionRequiredResponse();
    if (Number.isNaN(ifMatch)) return invalidIfMatchResponse();
    if (Number(trip.version ?? 0) !== ifMatch) return conflictResponse(trip);

    if (body.type !== undefined && normalizeWaypointType(body.type) === null) {
      return errorResponse('Invalid waypoint type', 400);
    }

    const updates = [];
    const values = [];

    ['name', 'address', 'lat', 'lng', 'type', 'notes', 'sort_order'].forEach(field => {
      if (body[field] !== undefined) {
        updates.push(`${field} = ?`);
        values.push(field === 'type' ? normalizeWaypointType(body.type) : body[field]);
      }
    });

    if (updates.length > 0) {
      values.push(params.id, params.tripId);
      await env.RIDE_TRIP_PLANNER_DB.prepare(
        `UPDATE waypoints SET ${updates.join(', ')} WHERE id = ? AND trip_id = ?`
      ).bind(...values).run();
    }

    const waypoint = await env.RIDE_TRIP_PLANNER_DB.prepare('SELECT * FROM waypoints WHERE id = ?').bind(params.id).first();
    const tripState = await env.RIDE_TRIP_PLANNER_DB.prepare('SELECT version, updated_at FROM trips WHERE id = ?').bind(params.tripId).first();

    return jsonResponse({ waypoint, trip_version: tripState?.version ?? 0, trip_updated_at: tripState?.updated_at ?? null });
  },

  /**
   * Delete waypoint
   */
  async deleteWaypoint(context) {
    const { env, user, params, request } = context;

    const trip = await verifyTripOwnership(env, params.tripId, user.id);
    if (!trip) return errorResponse('Trip not found', 404);

    const ifMatch = parseIfMatchVersion(request);
    if (ifMatch === null) return preconditionRequiredResponse();
    if (Number.isNaN(ifMatch)) return invalidIfMatchResponse();
    if (Number(trip.version ?? 0) !== ifMatch) return conflictResponse(trip);

    await env.RIDE_TRIP_PLANNER_DB.prepare(
      'DELETE FROM waypoints WHERE id = ? AND trip_id = ?'
    ).bind(params.id, params.tripId).run();

    const tripState = await env.RIDE_TRIP_PLANNER_DB.prepare('SELECT version, updated_at FROM trips WHERE id = ?').bind(params.tripId).first();
    return jsonResponse({ success: true, trip_version: tripState?.version ?? 0, trip_updated_at: tripState?.updated_at ?? null });
  },

  /**
   * Reorder waypoints (batched in D1 transaction)
   */
  async reorderWaypoints(context) {
    const { env, user, params, request } = context;
    const { body, error } = await readJsonBody(request);
    if (error) return error;

    if (!Array.isArray(body.order)) {
      return errorResponse('Order array is required');
    }

    const trip = await verifyTripOwnership(env, params.tripId, user.id);
    if (!trip) return errorResponse('Trip not found', 404);

    const ifMatch = parseIfMatchVersion(request);
    if (ifMatch === null) return preconditionRequiredResponse();
    if (Number.isNaN(ifMatch)) return invalidIfMatchResponse();
    if (Number(trip.version ?? 0) !== ifMatch) return conflictResponse(trip);

    // Validate order contains every waypoint exactly once
    const existingWps = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT id FROM waypoints WHERE trip_id = ?'
    ).bind(params.tripId).all();

    const existingIds = (existingWps.results || []).map(r => r.id);
    const desired = body.order.map(id => String(id));
    const uniqueDesired = new Set(desired);

    if (desired.length !== existingIds.length || uniqueDesired.size !== desired.length) {
      return errorResponse('Order must include each waypoint exactly once', 400);
    }

    const existingSet = new Set(existingIds);
    for (const id of uniqueDesired) {
      if (!existingSet.has(id)) {
        return errorResponse('Order contains invalid waypoint id', 400);
      }
    }

    // Batch all reorder updates in a single D1 transaction
    const stmts = desired.map((id, i) =>
      env.RIDE_TRIP_PLANNER_DB.prepare(
        'UPDATE waypoints SET sort_order = ? WHERE id = ? AND trip_id = ?'
      ).bind(i, id, params.tripId)
    );

    // Also persist ordering on the trip settings
    const settings = safeJsonParse(trip.settings || '{}', {});
    settings.waypoint_order = desired;
    stmts.push(
      env.RIDE_TRIP_PLANNER_DB.prepare(
        'UPDATE trips SET settings = ? WHERE id = ?'
      ).bind(JSON.stringify(settings), params.tripId)
    );

    await env.RIDE_TRIP_PLANNER_DB.batch(stmts);

    const tripState = await env.RIDE_TRIP_PLANNER_DB.prepare('SELECT version, updated_at FROM trips WHERE id = ?').bind(params.tripId).first();
    return jsonResponse({ success: true, trip_version: tripState?.version ?? 0, trip_updated_at: tripState?.updated_at ?? null });
  }
};
