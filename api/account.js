/**
 * Account API Handler
 * User data management (purge all data)
 */

import { jsonResponse } from './utils.js';

export const AccountHandler = {
  /**
   * Delete all user-owned trips and related data.
   * Cleans up R2 attachment binaries before wiping DB rows.
   */
  async deleteAllUserData(context) {
    const { env, user } = context;

    // Collect attachment storage keys
    const attachments = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT a.storage_key FROM attachments a JOIN trips t ON a.trip_id = t.id WHERE t.user_id = ?'
    ).bind(user.id).all();

    // Best-effort R2 cleanup
    for (const row of attachments.results || []) {
      try {
        await env.RIDE_TRIP_PLANNER_ATTACHMENTS.delete(row.storage_key);
      } catch (err) {
        console.error('R2 delete failed', row.storage_key, err);
      }
    }

    // Remove the user's private saved places (not tied to any trip)
    await env.RIDE_TRIP_PLANNER_DB.prepare('DELETE FROM saved_places WHERE user_id = ?').bind(user.id).run();

    // Remove fuel fill-ups and check-ins (they also cascade with trips) and
    // revoke every personal access token, so no script keeps access.
    await env.RIDE_TRIP_PLANNER_DB.prepare('DELETE FROM fuel_fills WHERE user_id = ?').bind(user.id).run();
    await env.RIDE_TRIP_PLANNER_DB.prepare('DELETE FROM checkins WHERE user_id = ?').bind(user.id).run();
    await env.RIDE_TRIP_PLANNER_DB.prepare('UPDATE api_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').bind(new Date().toISOString(), user.id).run();

    // Remove all trips (cascades to child tables via FK)
    await env.RIDE_TRIP_PLANNER_DB.prepare('DELETE FROM trips WHERE user_id = ?').bind(user.id).run();

    return jsonResponse({ success: true, deleted_objects: attachments.results?.length || 0 });
  }
};
