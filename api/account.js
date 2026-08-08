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

    const keys = (attachments.results || []).map(row => row.storage_key).filter(Boolean);

    // Delete the DB rows FIRST. A Worker invocation is capped at 1000
    // subrequests: the old order (one awaited R2 delete per attachment, then
    // the DELETE) meant a user with many photos blew the budget mid-loop and
    // the DELETE never ran — nothing was erased and they had no way to tell.
    // Now the user's data is gone even if the storage sweep is cut short.
    await env.RIDE_TRIP_PLANNER_DB.prepare('DELETE FROM trips WHERE user_id = ?').bind(user.id).run();

    // Best-effort R2 cleanup. R2 accepts up to 1000 keys per delete call, so
    // this is a handful of round trips rather than one per object.
    let deletedObjects = 0;
    for (let i = 0; i < keys.length; i += 1000) {
      const chunk = keys.slice(i, i + 1000);
      try {
        await env.RIDE_TRIP_PLANNER_ATTACHMENTS.delete(chunk);
        deletedObjects += chunk.length;
      } catch (err) {
        console.error('R2 batch delete failed', err);
      }
    }

    return jsonResponse({ success: true, deleted_objects: deletedObjects });
  }
};
