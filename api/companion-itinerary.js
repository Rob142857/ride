/**
 * Read-only bridge for the owner's full private itinerary in Companion.
 * The publishing CLI writes snapshots directly to R2; this route never writes.
 */
import { errorResponse, jsonResponse, requireAuth } from './utils.js';
import { verifyTripOwnership } from './handler-utils.js';

const COMPANION_ORIGIN = 'https://trip.incitat.io';
const SNAPSHOT_SCHEMA_VERSION = 1;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_STOPS = 500;
const MAX_WAYPOINTS = 10_000;
const MAX_JOURNAL_ENTRIES = 10_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function withCompanionCors(response, request) {
  const headers = new Headers(response.headers);
  headers.delete('Access-Control-Allow-Origin');
  headers.delete('Access-Control-Allow-Credentials');
  headers.delete('Access-Control-Allow-Methods');
  headers.delete('Access-Control-Allow-Headers');
  headers.set('Cache-Control', 'no-store, no-cache, max-age=0, must-revalidate');
  headers.set('Pragma', 'no-cache');
  headers.set('Expires', '0');
  headers.set('X-Content-Type-Options', 'nosniff');
  const vary = new Set((headers.get('Vary') || '').split(',').map(value => value.trim()).filter(Boolean));
  vary.add('Origin');
  headers.set('Vary', [...vary].join(', '));

  if (request.headers.get('Origin') === COMPANION_ORIGIN) {
    headers.set('Access-Control-Allow-Origin', COMPANION_ORIGIN);
    headers.set('Access-Control-Allow-Credentials', 'true');
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function preflight(context) {
  const { request } = context;
  const origin = request.headers.get('Origin');
  const requestedMethod = request.headers.get('Access-Control-Request-Method')?.toUpperCase();
  const requestedHeaders = (request.headers.get('Access-Control-Request-Headers') || '')
    .split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  const allowedHeaders = new Set(['authorization', 'content-type']);
  if (origin !== COMPANION_ORIGIN || requestedMethod !== 'GET' || requestedHeaders.some(value => !allowedHeaders.has(value))) {
    return withCompanionCors(errorResponse('Origin or method not allowed', 403), request);
  }

  const response = new Response(null, { status: 204 });
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', COMPANION_ORIGIN);
  headers.set('Access-Control-Allow-Credentials', 'true');
  headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  headers.set('Access-Control-Max-Age', '600');
  headers.set('Cache-Control', 'no-store');
  headers.set('Vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
  return new Response(null, { status: 204, headers });
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validSnapshot(snapshot, tripId) {
  if (!isPlainObject(snapshot) || snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) return false;
  if (typeof snapshot.sourceSha256 !== 'string' || !SHA256_PATTERN.test(snapshot.sourceSha256)) return false;
  if (typeof snapshot.publishedAt !== 'string' || !ISO_TIMESTAMP_PATTERN.test(snapshot.publishedAt) || !Number.isFinite(Date.parse(snapshot.publishedAt))) return false;

  const source = snapshot.itinerary;
  if (!isPlainObject(source)) return false;
  const idFields = ['id', 'rideTripId', 'cloudTripId'].filter(field => source[field] !== undefined);
  if (!idFields.length || idFields.some(field => source[field] !== tripId)) return false;
  const hasPrivateFlag = source.isPublic === false || source.is_public === false || source.is_public === 0;
  if (!hasPrivateFlag || source.isPublic === true || source.is_public === true || source.is_public === 1) return false;

  if (!isPlainObject(source.settings) || !isPlainObject(source.settings.itinerary)) return false;
  const plan = source.settings.itinerary;
  if (!isPlainObject(plan) || !Array.isArray(plan.stops) || plan.stops.length === 0 || plan.stops.length > MAX_STOPS) return false;
  if (plan.version !== 1) return false;
  if (plan.stops.some(stop => !isPlainObject(stop) || typeof stop.id !== 'string' || !stop.id || typeof stop.name !== 'string' || !stop.name)) return false;
  if (!Array.isArray(source.waypoints) || source.waypoints.length > MAX_WAYPOINTS) return false;
  if (!Array.isArray(source.journal) || source.journal.length > MAX_JOURNAL_ENTRIES) return false;
  return true;
}

function invalidSnapshot(request) {
  return withCompanionCors(errorResponse('The saved Companion itinerary snapshot is invalid. Ask the trip owner to republish it.', 500), request);
}

export const CompanionItineraryHandler = {
  preflight,

  async get(context) {
    const { request, env, params } = context;
    const authResult = await requireAuth(context);
    if (authResult instanceof Response) return withCompanionCors(authResult, request);

    try {
      const trip = await verifyTripOwnership(env, params.id, context.user.id);
      if (!trip) return withCompanionCors(errorResponse('Trip not found', 404), request);

      const bucket = env.RIDE_TRIP_PLANNER_ATTACHMENTS;
      if (!bucket || typeof bucket.get !== 'function') {
        return withCompanionCors(errorResponse('Private itinerary storage is unavailable.', 503), request);
      }
      const key = `private-itineraries/${params.id}/trip-companion-itinerary.json`;
      const object = await bucket.get(key);
      if (!object) return withCompanionCors(errorResponse('No Companion itinerary is available for this trip yet.', 404), request);
      if (Number.isFinite(object.size) && object.size > MAX_SNAPSHOT_BYTES) return invalidSnapshot(request);

      let snapshot;
      try {
        snapshot = typeof object.json === 'function' ? await object.json() : JSON.parse(await object.text());
      } catch (_) {
        return invalidSnapshot(request);
      }
      if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > MAX_SNAPSHOT_BYTES) return invalidSnapshot(request);
      if (!validSnapshot(snapshot, params.id)) return invalidSnapshot(request);

      return withCompanionCors(jsonResponse(snapshot), request);
    } catch (error) {
      console.error('Companion itinerary read failed:', error);
      return withCompanionCors(errorResponse('Could not read the Companion itinerary snapshot.', 500), request);
    }
  },
};

export const companionItineraryValidation = { validSnapshot, withCompanionCors };
