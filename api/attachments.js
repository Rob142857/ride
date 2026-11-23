/**
 * Attachments API Handler
 * Upload, retrieve, update, and delete trip attachments (R2)
 */

import { jsonResponse, errorResponse, generateId, parseBody, BASE_URL } from './utils.js';
import { verifyTripOwnership } from './handler-utils.js';

// Allowed upload types and their file extensions.
export const ATTACHMENT_TYPES = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'image/gif': 'gif', 'image/heic': 'heic', 'image/heif': 'heic', 'image/jpg': 'jpg', 'application/pdf': 'pdf'
};
const INLINE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif']);
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

export function cleanCaption(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 300);
}

export function bytesMatchType(b, type) {
  const at = (i, ...v) => v.every((x, k) => b[i + k] === x);
  switch (type) {
    case 'image/jpg': case 'image/jpeg': return at(0, 0xff, 0xd8, 0xff);
    case 'image/png': return at(0, 0x89, 0x50, 0x4e, 0x47);
    case 'image/gif': return at(0, 0x47, 0x49, 0x46, 0x38);
    case 'image/webp': return at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50);
    case 'image/heif': case 'image/heic': return at(4, 0x66, 0x74, 0x79, 0x70); // 'ftyp'
    case 'application/pdf': return at(0, 0x25, 0x50, 0x44, 0x46);
    default: return false;
  }
}


export const AttachmentsHandler = {
  /**
   * Upload attachment to trip
   */
  async uploadAttachment(context) {
    const { env, user, params, request } = context;

    const trip = await verifyTripOwnership(env, params.tripId, user.id);
    if (!trip) return errorResponse('Trip not found', 404);

    const formData = await request.formData();
    const file = formData.get('file');
    if (!file) return errorResponse('No file provided');

    // Upload rules (security fix, 23 Nov 2026): fixed type list, size cap, extension from the type.
    if (file.size > MAX_ATTACHMENT_BYTES) return errorResponse('File too large (15 MB limit)', 413);
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    let claimedType = String(file.type || '').toLowerCase();
    if (claimedType === 'image/heic-sequence') claimedType = 'image/heic';
    if (claimedType === 'image/heif-sequence') claimedType = 'image/heif';
    // Some cameras send no type: infer it from the first bytes, never from the filename.
    if (!claimedType || claimedType === 'application/octet-stream') {
      claimedType = Object.keys(ATTACHMENT_TYPES).find((t) => bytesMatchType(head, t)) || '';
    }
    const ext = ATTACHMENT_TYPES[claimedType];
    if (!ext) return errorResponse('This file type is not allowed. Use JPEG, PNG, WebP, GIF, HEIC or PDF.', 415);
    if (!bytesMatchType(head, claimedType)) return errorResponse('File contents do not match its type', 415);
    const id = generateId();
    const storageKey = `trips/${params.tripId}/${id}.${ext}`;

    const isPrivate = formData.get('is_private') === 'true' || formData.get('is_private') === '1';
    const isCover = formData.get('is_cover') === 'true' || formData.get('is_cover') === '1';
    const caption = cleanCaption(formData.get('caption'));
    const journalEntryId = formData.get('journal_entry_id') || null;
    const waypointId = formData.get('waypoint_id') || null;

    // Upload to R2 then insert DB; cleanup R2 on DB failure
    // Note: scope validation (journal/waypoint belong to trip) and cover image
    // management (unsetting other covers) are enforced by v2 schema triggers.
    let objectPutSucceeded = false;
    try {
      await env.RIDE_TRIP_PLANNER_ATTACHMENTS.put(storageKey, file.stream(), {
        httpMetadata: { contentType: claimedType },
        customMetadata: { originalName: file.name, tripId: params.tripId }
      });
      objectPutSucceeded = true;

      // Cover image management handled by v2 schema triggers
      await env.RIDE_TRIP_PLANNER_DB.prepare(
        `INSERT INTO attachments (id, trip_id, journal_entry_id, waypoint_id, filename, original_name, mime_type, size_bytes, storage_key, is_private, is_cover, caption)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id, params.tripId, journalEntryId, waypointId,
        `${id}.${ext}`, file.name, claimedType, file.size,
        storageKey, isPrivate ? 1 : 0, isCover ? 1 : 0, caption
      ).run();

      const attachment = await env.RIDE_TRIP_PLANNER_DB.prepare('SELECT * FROM attachments WHERE id = ?').bind(id).first();

      return jsonResponse({
        attachment: { ...attachment, url: `${BASE_URL}/api/attachments/${id}` }
      }, 201);
    } catch (err) {
      if (objectPutSucceeded) {
        try { await env.RIDE_TRIP_PLANNER_ATTACHMENTS.delete(storageKey); } catch (_) {}
      }
      throw err;
    }
  },

  /**
   * Get attachment file (supports public access for public attachments)
   */
  async getAttachment(context) {
    const { env, params, user } = context;

    const attachment = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT a.*, t.user_id, t.is_public as trip_is_public FROM attachments a JOIN trips t ON a.trip_id = t.id WHERE a.id = ?'
    ).bind(params.id).first();

    if (!attachment) return errorResponse('Attachment not found', 404);

    const isOwner = user && user.id === attachment.user_id;
    const isPubliclyAccessible = attachment.trip_is_public && !attachment.is_private;

    if (!isOwner && !isPubliclyAccessible) {
      return errorResponse('Attachment not found', 404);
    }

    const object = await env.RIDE_TRIP_PLANNER_ATTACHMENTS.get(attachment.storage_key);
    if (!object) return errorResponse('File not found', 404);

    // Sanitize filename for Content-Disposition header (strip control chars and quotes)
    const safeName = (attachment.original_name || 'file').replace(/["\\\x00-\x1f]/g, '_');

    const headers = new Headers();
    headers.set('Content-Type', attachment.mime_type);
    headers.set('Content-Length', attachment.size_bytes);
    headers.set('Cache-Control', attachment.is_private ? 'private, no-store' : 'public, max-age=86400');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
    headers.set('Cross-Origin-Resource-Policy', 'same-site');

    if (INLINE_TYPES.has(attachment.mime_type)) {
      headers.set('Content-Disposition', `inline; filename="${safeName}"`);
    } else {
      headers.set('Content-Disposition', `attachment; filename="${safeName}"`);
    }

    return new Response(object.body, { headers });
  },

  /**
   * Update attachment metadata
   */
  async updateAttachment(context) {
    const { env, user, params, request } = context;
    const body = await parseBody(request);

    const attachment = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT a.*, t.user_id FROM attachments a JOIN trips t ON a.trip_id = t.id WHERE a.id = ?'
    ).bind(params.id).first();

    if (!attachment || attachment.user_id !== user.id) {
      return errorResponse('Attachment not found', 404);
    }

    const updates = [];
    const values = [];

    if (body.caption !== undefined) { updates.push('caption = ?'); values.push(cleanCaption(body.caption)); }
    if (body.is_private !== undefined) { updates.push('is_private = ?'); values.push(body.is_private ? 1 : 0); }
    if (body.is_cover !== undefined) {
      // Cover image management (unsetting others) handled by v2 schema triggers
      updates.push('is_cover = ?');
      values.push(body.is_cover ? 1 : 0);
    }

    if (updates.length > 0) {
      values.push(params.id);
      await env.RIDE_TRIP_PLANNER_DB.prepare(`UPDATE attachments SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run();
    }

    const updated = await env.RIDE_TRIP_PLANNER_DB.prepare('SELECT * FROM attachments WHERE id = ?').bind(params.id).first();
    return jsonResponse({
      attachment: { ...updated, url: `${BASE_URL}/api/attachments/${params.id}` }
    });
  },

  /**
   * Delete attachment
   */
  async deleteAttachment(context) {
    const { env, user, params } = context;

    const attachment = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT a.*, t.user_id FROM attachments a JOIN trips t ON a.trip_id = t.id WHERE a.id = ?'
    ).bind(params.id).first();

    if (!attachment || attachment.user_id !== user.id) {
      return errorResponse('Attachment not found', 404);
    }

    // Delete from R2 then DB
    await env.RIDE_TRIP_PLANNER_ATTACHMENTS.delete(attachment.storage_key);
    await env.RIDE_TRIP_PLANNER_DB.prepare('DELETE FROM attachments WHERE id = ?').bind(params.id).run();

    return jsonResponse({ success: true });
  }
};
