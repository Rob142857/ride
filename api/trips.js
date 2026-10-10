/**
 * Trips API Handler
 * Core CRUD operations for trips (trip-level only)
 */

import { jsonResponse, errorResponse, generateId, generateShortCodeForId, parseBody, BASE_URL } from './utils.js';
import { safeJsonParse, orderWaypointsWithTripSettings, parseIfMatchVersion, conflictResponse, preconditionRequiredResponse } from './handler-utils.js';
import { serializeOwnedJourney } from './journey.js';
import { expandCoordinates, encodeRoute, assertRowSize } from './route-codec.js';
import { validateTripSettings } from './itinerary-validation.js';

export const TripsHandler = {
  /**
   * List all trips for current user
   */
  async listTrips(context) {
    const { env, user } = context;

    const trips = await env.RIDE_TRIP_PLANNER_DB.prepare(
      `SELECT t.*, 
        (SELECT COUNT(*) FROM waypoints WHERE trip_id = t.id) as waypoint_count,
        (SELECT COUNT(*) FROM journal_entries WHERE trip_id = t.id) as journal_count,
        (SELECT COUNT(*) FROM attachments WHERE trip_id = t.id) as attachment_count
       FROM trips t 
       WHERE t.user_id = ? 
       ORDER BY t.updated_at DESC`
    ).bind(user.id).all();

    const results = (trips.results || []).map(t => ({
      ...t,
      short_url: t.short_code ? `${BASE_URL}/${t.short_code}` : null
    }));

    return jsonResponse({ trips: results });
  },

  /**
   * Create a new trip with collision-proof short code
   */
  async createTrip(context) {
    const { env, user, request } = context;
    const body = await parseBody(request);

    if (!body?.name) {
      return errorResponse('Trip name is required');
    }

    if (typeof body.name !== 'string' || (body.description !== undefined && typeof body.description !== 'string')) return errorResponse('Trip name and description must be text');
    const settingsError = validateTripSettings(body.settings || {});
    if (settingsError) return errorResponse(settingsError);

    const id = generateId();
    const settings = JSON.stringify(body.settings || {});
    try { assertRowSize([settings, body.name, body.description], 'Trip settings and description'); } catch (error) { return errorResponse(error.message, 413); }

    let shortCode = generateShortCodeForId(id);
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      try {
        await env.RIDE_TRIP_PLANNER_DB.prepare(
          `INSERT INTO trips (id, user_id, name, description, settings, short_code) 
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(id, user.id, body.name, body.description || '', settings, shortCode).run();
        break;
      } catch (error) {
        if (error.message?.includes('UNIQUE constraint') && attempts < maxAttempts - 1) {
          attempts++;
          shortCode = generateShortCodeForId(`${id}:${attempts}`);
          continue;
        }
        throw error;
      }
    }

    const trip = await env.RIDE_TRIP_PLANNER_DB.prepare('SELECT * FROM trips WHERE id = ?').bind(id).first();
    trip.short_url = `${BASE_URL}/${shortCode}`;

    return jsonResponse({ trip }, 201);
  },

  /**
   * Get a single trip with all data
   */
  async getTrip(context) {
    const { env, user, params } = context;

    const trip = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT * FROM trips WHERE id = ? AND user_id = ?'
    ).bind(params.id, user.id).first();

    if (!trip) return errorResponse('Trip not found', 404);

    const waypoints = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT * FROM waypoints WHERE trip_id = ? ORDER BY sort_order'
    ).bind(params.id).all();

    const orderedWaypoints = orderWaypointsWithTripSettings(waypoints.results, trip.settings);

    const journal = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT * FROM journal_entries WHERE trip_id = ? ORDER BY created_at DESC'
    ).bind(params.id).all();

    const attachments = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT * FROM attachments WHERE trip_id = ? ORDER BY created_at DESC'
    ).bind(params.id).all();

    const routeData = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT * FROM route_data WHERE trip_id = ?'
    ).bind(params.id).first();

    const altRoutes = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT id, route_index, name, summary, color, distance_meters, duration_seconds, is_selected, is_visible, coordinates, steps, created_at FROM alternative_routes WHERE trip_id = ? ORDER BY route_index ASC'
    ).bind(params.id).all();

    return jsonResponse({
      trip: serializeOwnedJourney({
        trip,
        waypoints: orderedWaypoints,
        journal: journal.results,
        attachments: attachments.results,
        routeData,
        alternativeRoutes: altRoutes.results || [],
      })
    });
  },

  /**
   * Update a trip
   */
  async updateTrip(context) {
    const { env, user, params, request } = context;
    const body = await parseBody(request);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return errorResponse('A JSON object is required');
    if (body.settings !== undefined) {
      const settingsError = validateTripSettings(body.settings);
      if (settingsError) return errorResponse(settingsError);
    }
    if (body.name !== undefined && (typeof body.name !== 'string' || !body.name)) return errorResponse('Trip name must be non-empty text');
    for (const key of ['description', 'public_title', 'public_description', 'public_contact', 'cover_image_url']) if (body[key] !== undefined && body[key] !== null && typeof body[key] !== 'string') return errorResponse(`${key} must be text`);
    let encodedRoute = null;
    if (body.route) {
      try { encodedRoute = encodeRoute(body.route); } catch (error) { return errorResponse(error.message, error.message.includes('row size') ? 413 : 400); }
    }

    const existing = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT * FROM trips WHERE id = ? AND user_id = ?'
    ).bind(params.id, user.id).first();

    if (!existing) return errorResponse('Trip not found', 404);

    const projected = { ...existing, ...body, settings: body.settings === undefined ? existing.settings : JSON.stringify({ ...safeJsonParse(existing.settings || '{}', {}), ...body.settings }) };
    try { assertRowSize(['settings', 'name', 'description', 'public_title', 'public_description', 'public_contact', 'cover_image_url'].map(key => projected[key]), 'Trip settings and description'); } catch (error) { return errorResponse(error.message, 413); }

    const ifMatch = parseIfMatchVersion(request);
    if (body.settings?.itinerary && ifMatch === null) return preconditionRequiredResponse();
    if (ifMatch !== null && Number(existing.version ?? 0) !== ifMatch) {
      return conflictResponse(existing);
    }

    const updates = [];
    const values = [];

    if (body.name !== undefined) { updates.push('name = ?'); values.push(body.name); }
    if (body.description !== undefined) { updates.push('description = ?'); values.push(body.description); }
    if (body.settings !== undefined) {
      const existingSettings = safeJsonParse(existing.settings || '{}', {});
      let mergedSettings = body.settings;
      if (body.settings && typeof body.settings === 'object' && !Array.isArray(body.settings)) {
        mergedSettings = { ...existingSettings, ...body.settings };
        if (Object.prototype.hasOwnProperty.call(body.settings, 'waypoint_order') && body.settings.waypoint_order === null) {
          delete mergedSettings.waypoint_order;
        }
      }
      updates.push('settings = ?');
      values.push(JSON.stringify(mergedSettings));
    }
    if (body.is_public !== undefined) { updates.push('is_public = ?'); values.push(body.is_public ? 1 : 0); }
    if (body.public_title !== undefined) { updates.push('public_title = ?'); values.push(body.public_title); }
    if (body.public_description !== undefined) { updates.push('public_description = ?'); values.push(body.public_description); }
    if (body.public_contact !== undefined) { updates.push('public_contact = ?'); values.push(body.public_contact); }
    if (body.cover_image_url !== undefined) { updates.push('cover_image_url = ?'); values.push(body.cover_image_url); }
    if (body.cover_focus_x !== undefined) { updates.push('cover_focus_x = ?'); values.push(body.cover_focus_x); }
    if (body.cover_focus_y !== undefined) { updates.push('cover_focus_y = ?'); values.push(body.cover_focus_y); }
    if (body.active_route_index !== undefined) { updates.push('active_route_index = ?'); values.push(Math.floor(Number(body.active_route_index))); }

    if (updates.length > 0) {
      // The version predicate belongs in the write itself, so another tab cannot
      // change the itinerary between the preflight read and this UPDATE.
      values.push(params.id, user.id);
      if (ifMatch !== null) values.push(ifMatch);
      const result = await env.RIDE_TRIP_PLANNER_DB.prepare(
        `UPDATE trips SET ${updates.join(', ')} WHERE id = ? AND user_id = ?${ifMatch !== null ? ' AND version = ?' : ''}`
      ).bind(...values).run();
      if (ifMatch !== null && result.meta?.changes === 0) {
        const current = await env.RIDE_TRIP_PLANNER_DB.prepare('SELECT id, version, updated_at FROM trips WHERE id = ? AND user_id = ?').bind(params.id, user.id).first();
        return current ? conflictResponse(current) : errorResponse('Trip not found', 404);
      }
    }

    // Update route data if provided (triggers auto-bump trip version)
    if (body.route) {
      await env.RIDE_TRIP_PLANNER_DB.prepare(
        `INSERT OR REPLACE INTO route_data (id, trip_id, coordinates, steps, distance, duration)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(
        generateId(), params.id,
        encodedRoute.coordinates,
        encodedRoute.steps,
        encodedRoute.distance,
        encodedRoute.duration
      ).run();
    }

    const trip = await env.RIDE_TRIP_PLANNER_DB.prepare('SELECT * FROM trips WHERE id = ? AND user_id = ?').bind(params.id, user.id).first();
    return jsonResponse({ trip });
  },

  /**
   * Delete a trip
   */
  async deleteTrip(context) {
    const { env, user, params } = context;

    const result = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'DELETE FROM trips WHERE id = ? AND user_id = ?'
    ).bind(params.id, user.id).run();

    if (result.meta.changes === 0) {
      return errorResponse('Trip not found', 404);
    }

    return jsonResponse({ success: true });
  },

  // ---------------------------------------------------------------------------
  // ALTERNATIVE ROUTES
  // ---------------------------------------------------------------------------

  /**
   * List alternative routes for a trip (owned).
   */
  async listAlternativeRoutes(context) {
    const { env, user, params } = context;

    const trip = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT id FROM trips WHERE id = ? AND user_id = ?'
    ).bind(params.id, user.id).first();
    if (!trip) return errorResponse('Trip not found', 404);

    const rows = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT id, route_index, name, summary, color, distance_meters, duration_seconds, is_selected, is_visible, coordinates, steps, created_at FROM alternative_routes WHERE trip_id = ? ORDER BY route_index ASC'
    ).bind(params.id).all();

    return jsonResponse({
      routes: (rows.results || []).map(r => ({
        id: r.id,
        route_index: r.route_index,
        name: r.name,
        summary: r.summary,
        color: r.color,
        distance_meters: r.distance_meters,
        duration_seconds: r.duration_seconds,
        is_selected: !!r.is_selected,
        is_visible: !!r.is_visible,
        coordinates: expandCoordinates(safeJsonParse(r.coordinates, [])),
        steps: safeJsonParse(r.steps, []),
        created_at: r.created_at,
      })),
    });
  },

  /**
   * Save (replace) alternative routes for a trip.
   * Accepts body.routes = [{ name, summary, color, coordinates, distance_meters, duration_seconds, is_selected, is_visible }, ...]
   */
  async saveAlternativeRoutes(context) {
    const { env, user, params, request } = context;
    const body = await parseBody(request);
    if (!body || !Array.isArray(body.routes)) return errorResponse('Routes must be an array');
    let encodedRoutes;
    try { encodedRoutes = body.routes.map(encodeRoute); } catch (error) { return errorResponse(error.message, error.message.includes('row size') ? 413 : 400); }

    const trip = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT id, version, updated_at FROM trips WHERE id = ? AND user_id = ?'
    ).bind(params.id, user.id).first();
    if (!trip) return errorResponse('Trip not found', 404);

    const ifMatch = parseIfMatchVersion(request);
    if (ifMatch !== null && Number(trip.version ?? 0) !== ifMatch) return conflictResponse(trip);

    const routes = Array.isArray(body.routes) ? body.routes : [];

    const statements = [env.RIDE_TRIP_PLANNER_DB.prepare(
      'DELETE FROM alternative_routes WHERE trip_id = ?'
    ).bind(params.id)];

    for (let i = 0; i < routes.length; i++) {
      const r = routes[i];
      statements.push(env.RIDE_TRIP_PLANNER_DB.prepare(
        `INSERT INTO alternative_routes (id, trip_id, route_index, name, summary, color, distance_meters, duration_seconds, is_selected, is_visible, coordinates, steps)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        generateId(),
        params.id,
        i,
        r.name || r.label || `Route ${i + 1}`,
        r.summary || '',
        r.color || null,
        encodedRoutes[i].distance,
        encodedRoutes[i].duration,
        r.is_selected ? 1 : 0,
        r.is_visible !== false ? 1 : 0,
        encodedRoutes[i].coordinates,
        encodedRoutes[i].steps
      ));
    }

    // Replace alternatives together; a failed row must not erase the saved set.
    await env.RIDE_TRIP_PLANNER_DB.batch(statements);

    return jsonResponse({ success: true, count: routes.length });
  },
};
