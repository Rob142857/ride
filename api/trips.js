/**
 * Trips API Handler
 * Core CRUD operations for trips (trip-level only)
 */

import { jsonResponse, errorResponse, generateId, generateShortCodeForId, BASE_URL } from './utils.js';
import { safeJsonParse, orderWaypointsWithTripSettings, parseIfMatchVersion, conflictResponse, invalidIfMatchResponse, readJsonBody } from './handler-utils.js';
import { serializeOwnedJourney } from './journey.js';

/** Alternatives are a picker, not an archive — keep the payload bounded. */
const MAX_ALTERNATIVE_ROUTES = 5;
const MAX_ROUTE_COORDINATES = 5000;
const MAX_ROUTE_STEPS = 2000;

/**
 * Cover images are rendered into the public share page's OG tags, so only a
 * plain absolute http(s) URL is storable. Returns '' to clear, or null when the
 * value is unusable.
 */
function normalizeCoverImageUrl(value) {
  if (value === null || value === '') return '';
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.length > 2048) return null;
  // A pasted "images.example.com/a.jpg" or "//cdn/a.jpg" is treated as https.
  // Anything with an explicit non-http(s) scheme (javascript:, data:) is not.
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith('//')
    ? trimmed.replace(/^\/\//, 'https://')
    : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

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
    const { body, error } = await readJsonBody(request);
    if (error) return error;

    if (!body.name) {
      return errorResponse('Trip name is required');
    }

    const id = generateId();
    const settings = JSON.stringify(body.settings || {});

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
    const { body, error } = await readJsonBody(request);
    if (error) return error;

    const existing = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT id, version, updated_at, settings FROM trips WHERE id = ? AND user_id = ?'
    ).bind(params.id, user.id).first();

    if (!existing) return errorResponse('Trip not found', 404);

    // If-Match stays optional here (older/other callers don't always send it —
    // see api/waypoints.js for the endpoint family where it's mandatory), but a
    // header that IS present must be a real version: silently ignoring garbage
    // like a weak ETag used to turn concurrency control off without a trace.
    const ifMatch = parseIfMatchVersion(request);
    if (Number.isNaN(ifMatch)) return invalidIfMatchResponse();
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
    if (body.cover_image_url !== undefined) {
      const coverUrl = normalizeCoverImageUrl(body.cover_image_url);
      if (coverUrl === null) return errorResponse('cover_image_url must be an absolute http(s) URL', 400);
      updates.push('cover_image_url = ?');
      values.push(coverUrl);
    }
    if (body.cover_focus_x !== undefined) { updates.push('cover_focus_x = ?'); values.push(body.cover_focus_x); }
    if (body.cover_focus_y !== undefined) { updates.push('cover_focus_y = ?'); values.push(body.cover_focus_y); }
    if (body.active_route_index !== undefined) { updates.push('active_route_index = ?'); values.push(Math.floor(Number(body.active_route_index))); }

    if (updates.length > 0) {
      values.push(params.id);
      await env.RIDE_TRIP_PLANNER_DB.prepare(
        `UPDATE trips SET ${updates.join(', ')} WHERE id = ?`
      ).bind(...values).run();
    }

    // Update route data if provided (triggers auto-bump trip version)
    if (body.route) {
      await env.RIDE_TRIP_PLANNER_DB.prepare(
        `INSERT OR REPLACE INTO route_data (id, trip_id, coordinates, steps, distance, duration)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(
        generateId(), params.id,
        JSON.stringify(body.route.coordinates || []),
        JSON.stringify(body.route.steps || []),
        body.route.distance || null,
        body.route.duration || null
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
        coordinates: safeJsonParse(r.coordinates, []),
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
    const { body, error } = await readJsonBody(request);
    if (error) return error;

    const trip = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT id FROM trips WHERE id = ? AND user_id = ?'
    ).bind(params.id, user.id).first();
    if (!trip) return errorResponse('Trip not found', 404);

    if (body.routes !== undefined && !Array.isArray(body.routes)) {
      return errorResponse('routes must be an array', 400);
    }

    const routes = (Array.isArray(body.routes) ? body.routes : [])
      .filter(r => r && typeof r === 'object' && !Array.isArray(r))
      .slice(0, MAX_ALTERNATIVE_ROUTES);

    const num = (...candidates) => {
      for (const c of candidates) {
        if (typeof c === 'number' && Number.isFinite(c)) return c;
      }
      return null;
    };
    const text = (value, fallback, max) => {
      const s = typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value));
      return (s || fallback).slice(0, max);
    };

    // DELETE + all INSERTs go out as one batch: the previous delete-then-loop
    // could fail partway and leave the trip with an empty or mixed route set,
    // and it cost one D1 round trip per route.
    const stmts = [
      env.RIDE_TRIP_PLANNER_DB.prepare('DELETE FROM alternative_routes WHERE trip_id = ?').bind(params.id)
    ];

    routes.forEach((r, i) => {
      const coordinates = Array.isArray(r.coordinates) ? r.coordinates.slice(0, MAX_ROUTE_COORDINATES) : [];
      const steps = Array.isArray(r.steps) ? r.steps.slice(0, MAX_ROUTE_STEPS) : [];

      stmts.push(env.RIDE_TRIP_PLANNER_DB.prepare(
        `INSERT INTO alternative_routes (id, trip_id, route_index, name, summary, color, distance_meters, duration_seconds, is_selected, is_visible, coordinates, steps)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        generateId(),
        params.id,
        i,
        text(r.name || r.label, `Route ${i + 1}`, 120),
        text(r.summary, '', 500),
        r.color ? text(r.color, '', 32) : null,
        num(r.distance_meters, r.distance),
        num(r.duration_seconds, r.duration),
        r.is_selected ? 1 : 0,
        r.is_visible !== false ? 1 : 0,
        JSON.stringify(coordinates),
        JSON.stringify(steps)
      ));
    });

    await env.RIDE_TRIP_PLANNER_DB.batch(stmts);

    return jsonResponse({ success: true, count: routes.length });
  },
};
