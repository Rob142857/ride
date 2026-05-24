/**
 * Share API Handler
 * Generate share links and serve public trip views
 */

import { jsonResponse, errorResponse, generateShortCodeForId, BASE_URL } from './utils.js';
import { verifyTripOwnership, orderWaypointsWithTripSettings } from './handler-utils.js';
import { serializePublicJourney } from './journey.js';

export const ShareHandler = {
  /**
   * Generate share link for trip (uses short code)
   */
  async generateShareLink(context) {
    const { env, user, params } = context;

    const trip = await verifyTripOwnership(env, params.id, user.id, true);
    if (!trip) return errorResponse('Trip not found', 404);

    let shortCode = trip.short_code || generateShortCodeForId(trip.id);
    if (!trip.short_code) {
      let attempts = 0;
      while (attempts < 3) {
        try {
          await env.RIDE_TRIP_PLANNER_DB.prepare(
            'UPDATE trips SET short_code = ?, is_public = 1 WHERE id = ?'
          ).bind(shortCode, params.id).run();
          break;
        } catch (error) {
          if (error.message?.includes('UNIQUE constraint') && attempts < 2) {
            attempts++;
            shortCode = generateShortCodeForId(`${trip.id}:${attempts}`);
            continue;
          }
          throw error;
        }
      }
    } else {
      await env.RIDE_TRIP_PLANNER_DB.prepare(
        'UPDATE trips SET is_public = 1 WHERE id = ?'
      ).bind(params.id).run();
    }

    return jsonResponse({ shareUrl: `${BASE_URL}/${shortCode}`, shortCode });
  },

  /**
   * Get shared trip by short code (public access - no auth required)
   */
  async getSharedTrip(context) {
    const { env, params } = context;

    const trip = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT * FROM trips WHERE short_code = ?'
    ).bind(params.shortCode).first();

    if (!trip) return errorResponse('Trip not found or not shared', 404);
    if (!trip.is_public) return errorResponse('Trip is not public', 403);

    // Get waypoints
    const waypoints = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT id, name, lat, lng, type, sort_order FROM waypoints WHERE trip_id = ? ORDER BY sort_order'
    ).bind(trip.id).all();

    const orderedWaypoints = orderWaypointsWithTripSettings(waypoints.results, trip.settings);

    // Public journal entries only
    const journal = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT id, title, content, tags, created_at FROM journal_entries WHERE trip_id = ? AND is_private = 0 ORDER BY created_at DESC'
    ).bind(trip.id).all();

    // Public attachments only
    const attachments = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT id, filename, original_name, mime_type, caption, is_cover, journal_entry_id, waypoint_id FROM attachments WHERE trip_id = ? AND is_private = 0 ORDER BY is_cover DESC, created_at DESC'
    ).bind(trip.id).all();

    // Route data
    const routeData = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT * FROM route_data WHERE trip_id = ?'
    ).bind(trip.id).first();

    return jsonResponse({
      trip: serializePublicJourney({
        trip,
        waypoints: orderedWaypoints,
        journal: journal.results,
        attachments: attachments.results,
        routeData,
      })
    });
  }
};
