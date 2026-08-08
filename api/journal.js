/**
 * Journal API Handler
 * CRUD operations for trip journal entries
 */

import { jsonResponse, errorResponse, generateId } from './utils.js';
import { verifyTripOwnership, readJsonBody, safeJsonParse } from './handler-utils.js';

export const JournalHandler = {
  /**
   * Add journal entry
   */
  async addJournalEntry(context) {
    const { env, user, params, request } = context;
    const { body, error } = await readJsonBody(request);
    if (error) return error;

    const trip = await verifyTripOwnership(env, params.tripId, user.id);
    if (!trip) return errorResponse('Trip not found', 404);

    if (!body.title) {
      return errorResponse('Title is required');
    }

    const id = generateId();

    await env.RIDE_TRIP_PLANNER_DB.prepare(
      `INSERT INTO journal_entries (id, trip_id, waypoint_id, title, content, is_private, tags, location)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      params.tripId,
      body.waypoint_id || null,
      body.title,
      body.content || '',
      body.is_private ? 1 : 0,
      JSON.stringify(body.tags || []),
      body.location ? JSON.stringify(body.location) : null
    ).run();

    const entry = await env.RIDE_TRIP_PLANNER_DB.prepare('SELECT * FROM journal_entries WHERE id = ?').bind(id).first();

    return jsonResponse({
      entry: {
        ...entry,
        // safeJsonParse, not raw JSON.parse: a malformed stored column must not
        // turn a successful write into a 500.
        tags: safeJsonParse(entry.tags, []),
        location: safeJsonParse(entry.location, null)
      }
    }, 201);
  },

  /**
   * Update journal entry
   */
  async updateJournalEntry(context) {
    const { env, user, params, request } = context;
    const { body, error } = await readJsonBody(request);
    if (error) return error;

    const trip = await verifyTripOwnership(env, params.tripId, user.id);
    if (!trip) return errorResponse('Trip not found', 404);

    const updates = [];
    const values = [];

    if (body.title !== undefined) { updates.push('title = ?'); values.push(body.title); }
    if (body.content !== undefined) { updates.push('content = ?'); values.push(body.content); }
    if (body.is_private !== undefined) { updates.push('is_private = ?'); values.push(body.is_private ? 1 : 0); }
    if (body.tags !== undefined) { updates.push('tags = ?'); values.push(JSON.stringify(body.tags)); }
    if (body.location !== undefined) { updates.push('location = ?'); values.push(JSON.stringify(body.location)); }

    if (updates.length > 0) {
      // updated_at auto-managed by trg_journal_updated trigger
      values.push(params.id, params.tripId);
      await env.RIDE_TRIP_PLANNER_DB.prepare(
        `UPDATE journal_entries SET ${updates.join(', ')} WHERE id = ? AND trip_id = ?`
      ).bind(...values).run();
    }

    // Scope the re-read to the trip: an id belonging to another trip previously
    // returned null here and threw a TypeError on entry.tags (a 500, not a 404).
    const entry = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT * FROM journal_entries WHERE id = ? AND trip_id = ?'
    ).bind(params.id, params.tripId).first();

    if (!entry) return errorResponse('Journal entry not found', 404);

    return jsonResponse({
      entry: {
        ...entry,
        tags: safeJsonParse(entry.tags, []),
        location: safeJsonParse(entry.location, null)
      }
    });
  },

  /**
   * Delete journal entry
   */
  async deleteJournalEntry(context) {
    const { env, user, params } = context;

    const trip = await verifyTripOwnership(env, params.tripId, user.id);
    if (!trip) return errorResponse('Trip not found', 404);

    await env.RIDE_TRIP_PLANNER_DB.prepare(
      'DELETE FROM journal_entries WHERE id = ? AND trip_id = ?'
    ).bind(params.id, params.tripId).run();

    return jsonResponse({ success: true });
  }
};
