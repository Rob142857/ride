/**
 * Attachments API Handler
 * Upload, retrieve, update, and delete trip attachments (R2)
 */

import { jsonResponse, errorResponse, generateId, BASE_URL } from './utils.js';
import { verifyTripOwnership, readJsonBody } from './handler-utils.js';

/** Hard ceiling for a single upload. Checked against Content-Length before the
 *  body is buffered, and again against the parsed file. */
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

/**
 * The only MIME types accepted on upload, mapped to the extension we derive the
 * R2 storage key from. Every one of these is a raster format with no scripting
 * surface — notably `image/svg+xml` is absent, because an SVG served from our
 * own origin executes as a document (stored XSS). The client only ever offers
 * `accept="image/*"` pickers, so this is the full set the product needs.
 */
const ALLOWED_IMAGE_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif'
};

/** Types we are willing to render inline from the app origin. */
const INLINE_SAFE_TYPES = new Set(Object.keys(ALLOWED_IMAGE_TYPES));

/** Leading magic bytes, so a client that lies about `file.type` is still caught. */
const MAGIC_BYTES = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  'image/gif': (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38,
  // RIFF....WEBP
  'image/webp': (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  // ISO-BMFF box: ....ftyp
  'image/avif': (b) => b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70
};

function normalizeMime(raw) {
  return String(raw || '').split(';')[0].trim().toLowerCase();
}

export const AttachmentsHandler = {
  /**
   * Upload attachment to trip
   */
  async uploadAttachment(context) {
    const { env, user, params, request } = context;

    const trip = await verifyTripOwnership(env, params.tripId, user.id);
    if (!trip) return errorResponse('Trip not found', 404);

    // Reject oversized bodies before request.formData() buffers them into
    // Worker memory. Content-Length includes multipart framing, so allow a
    // little slack and rely on the exact file.size check below.
    const declaredLength = Number(request.headers.get('content-length') || 0);
    if (declaredLength && declaredLength > MAX_UPLOAD_BYTES + 1024 * 1024) {
      return errorResponse(`File too large. Maximum size is ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.`, 413);
    }

    let formData;
    try {
      formData = await request.formData();
    } catch (_) {
      return errorResponse('Invalid multipart form body', 400);
    }

    const file = formData.get('file');
    // A plain string field named "file" has no .stream()/.size — guard before use.
    if (!file || typeof file.stream !== 'function') {
      return errorResponse('No file provided');
    }

    if (typeof file.size === 'number' && file.size > MAX_UPLOAD_BYTES) {
      return errorResponse(`File too large. Maximum size is ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.`, 413);
    }
    if (file.size === 0) return errorResponse('File is empty');

    const mimeType = normalizeMime(file.type);
    const ext = ALLOWED_IMAGE_TYPES[mimeType];
    if (!ext) {
      return errorResponse('Unsupported file type. Upload a JPEG, PNG, WEBP, GIF or AVIF image.', 415);
    }

    // Defence in depth: verify the declared type against the leading bytes so a
    // crafted client cannot smuggle another format in under an allowed label.
    const verifyMagic = MAGIC_BYTES[mimeType];
    if (verifyMagic) {
      try {
        const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
        if (head.length < 12 || !verifyMagic(head)) {
          return errorResponse('File content does not match its declared image type.', 415);
        }
      } catch (_) {
        return errorResponse('Could not read uploaded file', 400);
      }
    }

    const id = generateId();
    // Extension comes from the validated MIME type, never from the client's
    // filename — a crafted name could otherwise inject slashes into the R2 key.
    const storageKey = `trips/${params.tripId}/${id}.${ext}`;
    const originalName = String(file.name || `upload.${ext}`).slice(0, 255);

    const isPrivate = formData.get('is_private') === 'true' || formData.get('is_private') === '1';
    const isCover = formData.get('is_cover') === 'true' || formData.get('is_cover') === '1';
    const caption = String(formData.get('caption') || '').slice(0, 500);
    const journalEntryId = formData.get('journal_entry_id') || null;
    const waypointId = formData.get('waypoint_id') || null;

    // Application-level scope check. The v2 schema triggers enforce this too,
    // but they are the only control today and a half-applied migration would
    // silently disable it — so verify cross-trip references here as well.
    if (journalEntryId) {
      const owned = await env.RIDE_TRIP_PLANNER_DB.prepare(
        'SELECT id FROM journal_entries WHERE id = ? AND trip_id = ?'
      ).bind(journalEntryId, params.tripId).first();
      if (!owned) return errorResponse('journal_entry_id does not belong to this trip', 400);
    }
    if (waypointId) {
      const owned = await env.RIDE_TRIP_PLANNER_DB.prepare(
        'SELECT id FROM waypoints WHERE id = ? AND trip_id = ?'
      ).bind(waypointId, params.tripId).first();
      if (!owned) return errorResponse('waypoint_id does not belong to this trip', 400);
    }

    // Upload to R2 then insert DB; cleanup R2 on DB failure
    // Note: cover image management (unsetting other covers) is enforced by
    // v2 schema triggers.
    let objectPutSucceeded = false;
    try {
      await env.RIDE_TRIP_PLANNER_ATTACHMENTS.put(storageKey, file.stream(), {
        httpMetadata: { contentType: mimeType },
        customMetadata: { originalName, tripId: params.tripId }
      });
      objectPutSucceeded = true;

      // Cover image management handled by v2 schema triggers
      await env.RIDE_TRIP_PLANNER_DB.prepare(
        `INSERT INTO attachments (id, trip_id, journal_entry_id, waypoint_id, filename, original_name, mime_type, size_bytes, storage_key, is_private, is_cover, caption)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id, params.tripId, journalEntryId, waypointId,
        `${id}.${ext}`, originalName, mimeType, file.size,
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
      `SELECT a.*, t.user_id, t.is_public AS trip_is_public,
              je.is_private AS entry_is_private
         FROM attachments a
         JOIN trips t ON a.trip_id = t.id
         LEFT JOIN journal_entries je ON je.id = a.journal_entry_id
        WHERE a.id = ?`
    ).bind(params.id).first();

    if (!attachment) return errorResponse('Attachment not found', 404);

    const isOwner = user && user.id === attachment.user_id;
    // Journal privacy cascades: a photo attached to a private entry is private,
    // even if the attachment row itself was never flagged. An attachment that
    // points at an entry we cannot resolve fails closed.
    const parentEntryIsPrivate = attachment.journal_entry_id
      ? (attachment.entry_is_private === null || attachment.entry_is_private === undefined || !!attachment.entry_is_private)
      : false;
    const isPubliclyAccessible = !!attachment.trip_is_public
      && !attachment.is_private
      && !parentEntryIsPrivate;

    if (!isOwner && !isPubliclyAccessible) {
      return errorResponse('Attachment not found', 404);
    }

    const object = await env.RIDE_TRIP_PLANNER_ATTACHMENTS.get(attachment.storage_key);
    if (!object) return errorResponse('File not found', 404);

    // Sanitize filename for Content-Disposition header (strip control chars and quotes)
    const safeName = (attachment.original_name || 'file').replace(/["\\\x00-\x1f]/g, '_');
    const storedMime = normalizeMime(attachment.mime_type);
    const inlineSafe = INLINE_SAFE_TYPES.has(storedMime);

    const headers = new Headers();
    // Only a known-safe raster type is ever served under its own MIME type and
    // rendered inline. Everything else — including SVG rows predating the upload
    // allowlist — is forced to an opaque download so it can never execute as a
    // document on the app origin.
    if (inlineSafe) {
      headers.set('Content-Type', storedMime);
      headers.set('Content-Disposition', `inline; filename="${safeName}"`);
    } else {
      headers.set('Content-Type', 'application/octet-stream');
      headers.set('Content-Disposition', `attachment; filename="${safeName}"`);
    }

    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
    headers.set('X-Frame-Options', 'DENY');
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('Cross-Origin-Resource-Policy', 'same-site');

    // Authoritative size/etag from the stored object, not the DB row — a
    // truncated upload or an edited row would otherwise hang or clip the client.
    if (typeof object.size === 'number') headers.set('Content-Length', String(object.size));
    if (object.httpEtag) headers.set('ETag', object.httpEtag);

    // Access to a private attachment depends on the request's session cookie,
    // so it must never land in a shared cache under a cookie-independent URL.
    if (isPubliclyAccessible) {
      headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      headers.set('Cache-Control', 'private, max-age=0, no-store');
    }
    headers.set('Vary', 'Cookie');

    return new Response(object.body, { headers });
  },

  /**
   * Update attachment metadata
   */
  async updateAttachment(context) {
    const { env, user, params, request } = context;
    const { body, error } = await readJsonBody(request);
    if (error) return error;

    const attachment = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT a.*, t.user_id FROM attachments a JOIN trips t ON a.trip_id = t.id WHERE a.id = ?'
    ).bind(params.id).first();

    if (!attachment || attachment.user_id !== user.id) {
      return errorResponse('Attachment not found', 404);
    }

    const updates = [];
    const values = [];

    if (body.caption !== undefined) { updates.push('caption = ?'); values.push(String(body.caption ?? '').slice(0, 500)); }
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
