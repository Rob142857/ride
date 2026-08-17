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

/**
 * True when `err` is D1's failure for referencing the not-yet-migrated
 * fuel_stop column (api/migrations/2026-08-17_waypoint_fuel_stop.sql).
 * addWaypoint/updateWaypoint check this specifically so a deploy of this
 * file ahead of that migration retries the write with fuel_stop dropped
 * instead of 500ing the whole request.
 *
 * SQLite phrases the two statements differently and BOTH have to match:
 *   UPDATE waypoints SET fuel_stop = ? → "no such column: fuel_stop"
 *   INSERT INTO waypoints (fuel_stop)  → "table waypoints has no column named fuel_stop"
 * Missing the INSERT wording would 500 every 'Fuel/Rest' waypoint created
 * before the migration runs, since those auto-tick the flag below.
 */
function isMissingFuelStopColumnError(err) {
  const message = `${err?.message || ''} ${err?.cause?.message || ''} ${err || ''}`;
  return /no such column:\s*fuel_stop/i.test(message) || /has no column named\s*fuel_stop/i.test(message);
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

    // fuel_stop: "the tank is refilled here" (window.FuelPlanner, public/js/
    // fuel.js, resets its remaining-range math to fuelTankRangeKm here).
    // Coerced to 0/1 like every other boolean column in this codebase
    // (is_public, is_cover). Pre-ticked by default for a 'Fuel/Rest' stop
    // unless the caller explicitly says otherwise.
    const fuelStop = body.fuelStop !== undefined ? (body.fuelStop ? 1 : 0) : (type === 'fuel' ? 1 : 0);

    const columns = ['id', 'trip_id', 'name', 'address', 'lat', 'lng', 'type', 'notes', 'sort_order'];
    const values = [id, params.tripId, body.name, body.address || '', body.lat, body.lng, type, body.notes || '', sortOrder];
    if (fuelStop) { columns.push('fuel_stop'); values.push(fuelStop); }

    // fuel_stop ships in a migration (api/migrations/2026-08-17_waypoint_fuel_stop.sql)
    // that may not have run on every environment yet. If this INSERT fails
    // specifically because that column doesn't exist, retry without it —
    // including for the type:'fuel' auto-tick above — so plain waypoint
    // creation never 500s ahead of that migration; the flag is just lost
    // until it's applied. DEPLOY ORDER: run the migration before relying on
    // fuel_stop actually persisting.
    try {
      await env.RIDE_TRIP_PLANNER_DB.prepare(
        `INSERT INTO waypoints (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
      ).bind(...values).run();
    } catch (err) {
      if (fuelStop && isMissingFuelStopColumnError(err)) {
        const idx = columns.indexOf('fuel_stop');
        columns.splice(idx, 1);
        values.splice(idx, 1);
        await env.RIDE_TRIP_PLANNER_DB.prepare(
          `INSERT INTO waypoints (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
        ).bind(...values).run();
      } else {
        throw err;
      }
    }

    const waypoint = await env.RIDE_TRIP_PLANNER_DB.prepare('SELECT * FROM waypoints WHERE id = ?').bind(id).first();
    if (waypoint) waypoint.fuelStop = !!waypoint.fuel_stop;
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

    // fuel_stop is special-cased exactly like `type` above: the client field
    // name (fuelStop) differs from the column name, and it needs the same
    // 0/1 coercion as every other boolean column (is_public, is_cover).
    const fuelStopIncluded = body.fuelStop !== undefined;
    if (fuelStopIncluded) {
      updates.push('fuel_stop = ?');
      values.push(body.fuelStop ? 1 : 0);
    }

    if (updates.length > 0) {
      values.push(params.id, params.tripId);
      const sql = `UPDATE waypoints SET ${updates.join(', ')} WHERE id = ? AND trip_id = ?`;
      try {
        await env.RIDE_TRIP_PLANNER_DB.prepare(sql).bind(...values).run();
      } catch (err) {
        // See addWaypoint: fuel_stop's migration may not have run on every
        // environment yet. Retry without it so every other field in this
        // update still saves instead of 500ing the whole request.
        if (fuelStopIncluded && isMissingFuelStopColumnError(err)) {
          const idx = updates.indexOf('fuel_stop = ?');
          updates.splice(idx, 1);
          values.splice(idx, 1);
          if (updates.length > 0) {
            await env.RIDE_TRIP_PLANNER_DB.prepare(
              `UPDATE waypoints SET ${updates.join(', ')} WHERE id = ? AND trip_id = ?`
            ).bind(...values).run();
          }
        } else {
          throw err;
        }
      }
    }

    const waypoint = await env.RIDE_TRIP_PLANNER_DB.prepare('SELECT * FROM waypoints WHERE id = ?').bind(params.id).first();
    if (waypoint) waypoint.fuelStop = !!waypoint.fuel_stop;
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
