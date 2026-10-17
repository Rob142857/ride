/**
 * Trip Companion's live API: fuel status, last check-in / last known location,
 * saved places for the Accom tab, and the two quick writes ("Add fill-up" and
 * "I'm here"). CORS is limited to exactly https://trip.incitat.io with
 * credentials, and only the owner's Ride session cookie is accepted: any
 * Authorization header is refused, so access tokens never work here.
 */
import { errorResponse, jsonResponse, requireAuth } from './utils.js';
import { verifyTripOwnership } from './handler-utils.js';
import { companionItineraryValidation } from './companion-itinerary.js';
import { fuelStatus, FuelFillsHandler } from './fuel-fills.js';
import { lastKnownLocation, CheckinsHandler } from './checkins.js';
import { SavedPlacesHandler } from './saved-places.js';

export const COMPANION_ORIGIN = 'https://trip.incitat.io';
const { withCompanionCors } = companionItineraryValidation;
const PLACE_FIELDS = ['id', 'name', 'type', 'lat', 'lng', 'address', 'rating', 'notes', 'tags', 'cost_amount', 'cost_note',
  'cost_seen_on', 'facilities', 'best_time', 'avoid', 'last_visited_on', 'source_links', 'updated_at'];

function preflight(context) {
  const { request } = context;
  const origin = request.headers.get('Origin');
  const method = request.headers.get('Access-Control-Request-Method')?.toUpperCase();
  const requested = (request.headers.get('Access-Control-Request-Headers') || '')
    .split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  if (origin !== COMPANION_ORIGIN || !['GET', 'POST'].includes(method) || requested.some(value => value !== 'content-type')) {
    return withCompanionCors(errorResponse('Origin or method not allowed', 403), request);
  }
  const headers = new Headers({
    'Access-Control-Allow-Origin': COMPANION_ORIGIN,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    'Cache-Control': 'no-store',
    Vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers'
  });
  return new Response(null, { status: 204, headers });
}

/** Session cookie only; writes must come from Companion itself as JSON. */
async function companionAuth(context, { write = false } = {}) {
  const { request } = context;
  if (request.headers.get('Authorization')) return errorResponse('Companion uses the Ride session only', 401);
  const authResult = await requireAuth(context);
  if (authResult instanceof Response) return authResult;
  if (write) {
    if (request.headers.get('Origin') !== COMPANION_ORIGIN) return errorResponse('Cross-origin write refused', 403);
    if (!(request.headers.get('Content-Type') || '').toLowerCase().startsWith('application/json')) return errorResponse('JSON body required', 415);
  }
  return null;
}

function wrap(handler, options) {
  return async (context) => {
    const denied = await companionAuth(context, options);
    if (denied) return withCompanionCors(denied, context.request);
    try {
      return withCompanionCors(await handler(context), context.request);
    } catch (error) {
      console.error('Companion live request failed:', error?.message || error);
      return withCompanionCors(errorResponse('Could not reach Ride data. Try again.', 500), context.request);
    }
  };
}

export const CompanionLiveHandler = {
  preflight,

  live: wrap(async (context) => {
    const { env, user, params } = context;
    const trip = await verifyTripOwnership(env, params.tripId, user.id);
    if (!trip) return errorResponse('Trip not found', 404);
    const [fuel, location] = await Promise.all([fuelStatus(env, user.id, trip), lastKnownLocation(env, user.id, params.tripId)]);
    return jsonResponse({ trip_id: params.tripId, generated_at: new Date().toISOString(), fuel, ...location });
  }),

  savedPlaces: wrap(async (context) => {
    const response = await SavedPlacesHandler.list(context);
    if (!response.ok) return response;
    const data = await response.json();
    const places = (data.places || []).map(place => Object.fromEntries(PLACE_FIELDS.map(field => [field, place[field] ?? null])));
    return jsonResponse({ places });
  }),

  addFill: wrap(context => FuelFillsHandler.create(context), { write: true }),

  addCheckin: wrap(context => CheckinsHandler.create(context, { source: 'companion' }), { write: true })
};
