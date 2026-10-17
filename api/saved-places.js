/**
 * Saved places — a private, per-user list of places worth revisiting
 * (camp sites, showers, work spots, fuel, food). Places belong to the signed-in
 * user, not to a trip. Every query is scoped by user_id; another user's place
 * looks exactly like a missing one (404). Nothing here is ever public.
 */
import { jsonResponse, errorResponse, generateId, parseBody } from './utils.js';
import { safeJsonParse } from './handler-utils.js';

export const PLACE_TYPES = ['campsite', 'shower', 'work', 'fuel', 'food', 'other'];
export const MAX_PLACES_PER_USER = 5000;
export const MAX_IMPORT = 1000;
export const EXPORT_KIND = 'ride-saved-places';
export const EXPORT_SCHEMA_VERSION = 1;

const TEXT_LIMITS = {
  name: 200,
  address: 500,
  notes: 10000,
  cost_note: 200,
  best_time: 1000,
  avoid: 1000,
  trip_id: 100,
  waypoint_id: 100
};
const LIST_LIMITS = {
  tags: { items: 30, length: 40 },
  facilities: { items: 40, length: 80 },
  source_links: { items: 20, length: 2000 }
};
const DATE_FIELDS = ['cost_seen_on', 'last_visited_on'];
const FIELDS = [
  'name', 'type', 'lat', 'lng', 'address', 'rating', 'notes', 'tags',
  'cost_amount', 'cost_note', 'cost_seen_on', 'facilities', 'best_time', 'avoid',
  'last_visited_on', 'source_links', 'trip_id', 'waypoint_id'
];
const COLUMNS = ['id', 'user_id', ...FIELDS, 'created_at', 'updated_at'];

const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

function cleanText(value, field) {
  if (value === undefined || value === null) return { value: null };
  if (typeof value !== 'string') return { error: `${field} must be text` };
  const trimmed = value.trim();
  if (trimmed.length > TEXT_LIMITS[field]) return { error: `${field} is too long (max ${TEXT_LIMITS[field]})` };
  return { value: trimmed || null };
}

function cleanList(value, field) {
  if (value === undefined || value === null) return { value: [] };
  // Accept a comma-separated string as a convenience for tags and facilities.
  const raw = typeof value === 'string' && field !== 'source_links' ? value.split(',') : value;
  if (!Array.isArray(raw)) return { error: `${field} must be a list` };
  const { items, length } = LIST_LIMITS[field];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (typeof item !== 'string') return { error: `${field} entries must be text` };
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (trimmed.length > length) return { error: `${field} entry is too long (max ${length})` };
    if (field === 'source_links') {
      let parsed;
      try { parsed = new URL(trimmed); } catch { return { error: 'source_links must be http(s) URLs' }; }
      if (!['http:', 'https:'].includes(parsed.protocol)) return { error: 'source_links must be http(s) URLs' };
    }
    const key = field === 'source_links' ? trimmed : trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  if (out.length > items) return { error: `${field} has too many entries (max ${items})` };
  return { value: out };
}

/**
 * Validate a full place record (after merging an update onto the stored row).
 * Returns { place } with normalized values, or { error }.
 */
export function validatePlace(input) {
  if (!isPlainObject(input)) return { error: 'Invalid place' };
  const place = {};

  for (const field of ['name', 'address', 'notes', 'cost_note', 'best_time', 'avoid', 'trip_id', 'waypoint_id']) {
    const result = cleanText(input[field], field);
    if (result.error) return result;
    place[field] = result.value;
  }
  if (!place.name) return { error: 'Place name is required' };

  const type = input.type === undefined || input.type === null || input.type === '' ? 'other' : input.type;
  if (!PLACE_TYPES.includes(type)) return { error: `type must be one of: ${PLACE_TYPES.join(', ')}` };
  place.type = type;

  const lat = typeof input.lat === 'string' && input.lat.trim() !== '' ? Number(input.lat) : input.lat;
  const lng = typeof input.lng === 'string' && input.lng.trim() !== '' ? Number(input.lng) : input.lng;
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90 ||
      typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    return { error: 'A valid lat and lng are required' };
  }
  place.lat = lat;
  place.lng = lng;

  if (input.rating === undefined || input.rating === null || input.rating === '') {
    place.rating = null;
  } else {
    const rating = Number(input.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return { error: 'rating must be a whole number from 1 to 5' };
    place.rating = rating;
  }

  if (input.cost_amount === undefined || input.cost_amount === null || input.cost_amount === '') {
    place.cost_amount = null;
  } else {
    const cost = Number(input.cost_amount);
    if (!Number.isFinite(cost) || cost < 0 || cost > 1000000) return { error: 'cost_amount must be a positive number' };
    place.cost_amount = Math.round(cost * 100) / 100;
  }

  for (const field of DATE_FIELDS) {
    const value = input[field];
    if (value === undefined || value === null || value === '') { place[field] = null; continue; }
    if (!validDate(value)) return { error: `${field} must be a date (YYYY-MM-DD)` };
    place[field] = value;
  }

  for (const field of Object.keys(LIST_LIMITS)) {
    const result = cleanList(input[field], field);
    if (result.error) return result;
    place[field] = result.value;
  }

  if (place.waypoint_id && !place.trip_id) return { error: 'waypoint_id needs its trip_id' };
  return { place };
}

/** Shape a DB row for the client: JSON lists parsed, internal user_id dropped. */
export function serializePlace(row) {
  if (!row) return row;
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    lat: row.lat,
    lng: row.lng,
    address: row.address,
    rating: row.rating,
    notes: row.notes,
    tags: safeJsonParse(row.tags, []),
    cost_amount: row.cost_amount,
    cost_note: row.cost_note,
    cost_seen_on: row.cost_seen_on,
    facilities: safeJsonParse(row.facilities, []),
    best_time: row.best_time,
    avoid: row.avoid,
    last_visited_on: row.last_visited_on,
    source_links: safeJsonParse(row.source_links, []),
    trip_id: row.trip_id,
    waypoint_id: row.waypoint_id,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function rowValues(id, userId, place) {
  return [
    id, userId, place.name, place.type, place.lat, place.lng, place.address, place.rating, place.notes,
    JSON.stringify(place.tags), place.cost_amount, place.cost_note, place.cost_seen_on,
    JSON.stringify(place.facilities), place.best_time, place.avoid, place.last_visited_on,
    JSON.stringify(place.source_links), place.trip_id, place.waypoint_id
  ];
}

const INSERT_SQL = `INSERT INTO saved_places (${COLUMNS.slice(0, -2).join(', ')})
  VALUES (${COLUMNS.slice(0, -2).map(() => '?').join(', ')})`;
const UPDATE_SQL = `UPDATE saved_places SET ${FIELDS.map(f => `${f} = ?`).join(', ')},
  updated_at = datetime('now') WHERE id = ? AND user_id = ?`;

function updateValues(id, userId, place) {
  return [...rowValues(id, userId, place).slice(2), id, userId];
}

/** A link is kept only when the trip (and waypoint, if given) belongs to this user. */
async function linkIsOwned(db, userId, place) {
  if (!place.trip_id) return true;
  const trip = await db.prepare('SELECT id FROM trips WHERE id = ? AND user_id = ?')
    .bind(place.trip_id, userId).first();
  if (!trip) return false;
  if (!place.waypoint_id) return true;
  const waypoint = await db.prepare('SELECT id FROM waypoints WHERE id = ? AND trip_id = ?')
    .bind(place.waypoint_id, place.trip_id).first();
  return !!waypoint;
}

async function getOwned(db, id, userId) {
  return db.prepare(`SELECT * FROM saved_places WHERE id = ? AND user_id = ?`).bind(id, userId).first();
}

async function countOwned(db, userId) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM saved_places WHERE user_id = ?').bind(userId).first();
  return Number(row?.n || 0);
}

async function listOwned(db, userId) {
  const rows = await db.prepare(
    'SELECT * FROM saved_places WHERE user_id = ? ORDER BY updated_at DESC, id ASC'
  ).bind(userId).all();
  return (rows.results || []).map(serializePlace);
}

export const SavedPlacesHandler = {
  async list(context) {
    const { env, user } = context;
    return jsonResponse({ places: await listOwned(env.RIDE_TRIP_PLANNER_DB, user.id) });
  },

  async exportAll(context) {
    const { env, user } = context;
    return jsonResponse({
      kind: EXPORT_KIND,
      schemaVersion: EXPORT_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      places: await listOwned(env.RIDE_TRIP_PLANNER_DB, user.id)
    });
  },

  async get(context) {
    const { env, user, params } = context;
    const row = await getOwned(env.RIDE_TRIP_PLANNER_DB, params.id, user.id);
    if (!row) return errorResponse('Place not found', 404);
    return jsonResponse({ place: serializePlace(row) });
  },

  async create(context) {
    const { env, user, request } = context;
    const db = env.RIDE_TRIP_PLANNER_DB;
    const body = await parseBody(request);
    const { place, error } = validatePlace(body?.place ?? body);
    if (error) return errorResponse(error, 400);
    if (!(await linkIsOwned(db, user.id, place))) return errorResponse('Linked waypoint not found', 404);
    if (await countOwned(db, user.id) >= MAX_PLACES_PER_USER) {
      return errorResponse(`Saved place limit reached (${MAX_PLACES_PER_USER})`, 409);
    }
    const id = generateId();
    await db.prepare(INSERT_SQL).bind(...rowValues(id, user.id, place)).run();
    return jsonResponse({ place: serializePlace(await getOwned(db, id, user.id)) }, 201);
  },

  async update(context) {
    const { env, user, params, request } = context;
    const db = env.RIDE_TRIP_PLANNER_DB;
    const existing = await getOwned(db, params.id, user.id);
    if (!existing) return errorResponse('Place not found', 404);
    const body = await parseBody(request);
    const patch = body?.place ?? body;
    if (!isPlainObject(patch)) return errorResponse('Invalid place', 400);
    const merged = { ...serializePlace(existing) };
    for (const field of FIELDS) if (Object.prototype.hasOwnProperty.call(patch, field)) merged[field] = patch[field];
    const { place, error } = validatePlace(merged);
    if (error) return errorResponse(error, 400);
    const linkChanged = place.trip_id !== existing.trip_id || place.waypoint_id !== existing.waypoint_id;
    if (linkChanged && !(await linkIsOwned(db, user.id, place))) return errorResponse('Linked waypoint not found', 404);
    const result = await db.prepare(UPDATE_SQL).bind(...updateValues(params.id, user.id, place)).run();
    if (result?.meta && result.meta.changes === 0) return errorResponse('Place not found', 404);
    return jsonResponse({ place: serializePlace(await getOwned(db, params.id, user.id)) });
  },

  async remove(context) {
    const { env, user, params } = context;
    const result = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'DELETE FROM saved_places WHERE id = ? AND user_id = ?'
    ).bind(params.id, user.id).run();
    if (!result?.meta || result.meta.changes === 0) return errorResponse('Place not found', 404);
    return jsonResponse({ success: true, id: params.id });
  },

  /**
   * Import an export file (or a bare array). A record whose id is one of this
   * user's places updates it; anything else becomes a new place with a new id,
   * so an import can never touch another user's rows. Links that don't belong
   * to this user are dropped. The whole file is validated before any write.
   */
  async importAll(context) {
    const { env, user, request } = context;
    const db = env.RIDE_TRIP_PLANNER_DB;
    const body = await parseBody(request);
    const list = Array.isArray(body) ? body : body?.places;
    if (!Array.isArray(list)) return errorResponse('Expected { places: [...] }', 400);
    if (body && !Array.isArray(body) && body.kind !== undefined && body.kind !== EXPORT_KIND) {
      return errorResponse('This file is not a Ride saved places export', 400);
    }
    if (list.length > MAX_IMPORT) return errorResponse(`Import at most ${MAX_IMPORT} places at a time`, 413);

    const prepared = [];
    for (let index = 0; index < list.length; index++) {
      const { place, error } = validatePlace(list[index]);
      if (error) return errorResponse(`Place ${index + 1}: ${error}`, 400);
      const incomingId = typeof list[index]?.id === 'string' ? list[index].id : null;
      prepared.push({ incomingId, place });
    }

    const owned = new Set((await db.prepare('SELECT id FROM saved_places WHERE user_id = ?').bind(user.id).all())
      .results?.map(row => row.id) || []);
    const newCount = prepared.filter(item => !(item.incomingId && owned.has(item.incomingId))).length;
    if (owned.size + newCount > MAX_PLACES_PER_USER) {
      return errorResponse(`Saved place limit reached (${MAX_PLACES_PER_USER})`, 409);
    }

    const statements = [];
    let created = 0;
    let updated = 0;
    let unlinked = 0;
    for (const { incomingId, place } of prepared) {
      if (!(await linkIsOwned(db, user.id, place))) {
        place.trip_id = null;
        place.waypoint_id = null;
        unlinked++;
      }
      if (incomingId && owned.has(incomingId)) {
        statements.push(db.prepare(UPDATE_SQL).bind(...updateValues(incomingId, user.id, place)));
        updated++;
      } else {
        statements.push(db.prepare(INSERT_SQL).bind(...rowValues(generateId(), user.id, place)));
        created++;
      }
    }
    if (statements.length) await db.batch(statements);
    return jsonResponse({ success: true, created, updated, unlinked });
  }
};
