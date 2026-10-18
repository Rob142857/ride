/**
 * Settings-only itinerary updates.
 *
 * PUT  /api/trips/:id/itinerary          { itinerary } with If-Match: saves a plan as given.
 * POST /api/trips/:id/itinerary/preview  planning file: the "Update this itinerary" preview, no write.
 * POST /api/trips/:id/itinerary/apply    planning file with If-Match: saves what the preview showed.
 *
 * The same change the Ride UI's "Update this itinerary" import saves
 * ({ settings: { itinerary } } with If-Match), with the same guards applied on
 * the server: a valid version 1 plan, a required If-Match version, stops,
 * legs and private note references that belong to this trip. Route,
 * waypoints, journals, visibility and other settings are never touched.
 * Preview and apply run the UI's own guards and diff (public/js/itinerary.js
 * via ./itinerary-plan.js), so they match what the owner sees in the app.
 */
import { jsonResponse, errorResponse, parseBody } from './utils.js';
import { safeJsonParse, parseIfMatchVersion, conflictResponse, preconditionRequiredResponse } from './handler-utils.js';
import { validateTripSettings } from './itinerary-validation.js';
import { assertRowSize } from './route-codec.js';
import { RideItinerary } from './itinerary-plan.js';

const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const MAX_PLANNING_FILE_BYTES = 15 * 1024 * 1024;

async function loadTripState(env, tripId, userId) {
  const trip = await env.RIDE_TRIP_PLANNER_DB.prepare(
    'SELECT id, version, updated_at, settings FROM trips WHERE id = ? AND user_id = ?'
  ).bind(tripId, userId).first();
  if (!trip) return null;
  const waypoints = await env.RIDE_TRIP_PLANNER_DB.prepare('SELECT id FROM waypoints WHERE trip_id = ?').bind(tripId).all();
  const journal = await env.RIDE_TRIP_PLANNER_DB.prepare('SELECT id FROM journal_entries WHERE trip_id = ?').bind(tripId).all();
  return {
    trip,
    waypointIds: new Set((waypoints.results || []).map(row => String(row.id))),
    journalIds: new Set((journal.results || []).map(row => String(row.id)))
  };
}

/** Server guards for any itinerary write. Returns an error message or null. */
function referenceError(itinerary, { waypointIds, journalIds }) {
  for (const stop of itinerary.stops) {
    if (!stop.waypointId || !waypointIds.has(String(stop.waypointId))) return `${stop.name}: waypoint does not belong to this Ride trip`;
    for (const key of ['fromWaypointId', 'toWaypointId']) {
      if (stop.leg?.[key] && !waypointIds.has(String(stop.leg[key]))) return `${stop.name}: leg waypoint does not belong to this Ride trip`;
    }
    if (stop.privateJournalRefs !== undefined && stop.privateJournalRefs.some(id => !journalIds.has(String(id)))) {
      return `${stop.name}: private note does not belong to this Ride trip`;
    }
  }
  return null;
}

/** Save settings.itinerary only if the trip is still at `ifMatch`. Returns a Response. */
async function saveItinerary(env, user, tripId, itinerary, trip, ifMatch, extra = {}) {
  const settings = { ...safeJsonParse(trip.settings || '{}', {}), itinerary };
  const serialized = JSON.stringify(settings);
  try { assertRowSize([serialized], 'Trip settings'); } catch (error) { return errorResponse(error.message, 413); }

  const result = await env.RIDE_TRIP_PLANNER_DB.prepare(
    `UPDATE trips SET settings = ?, version = COALESCE(version, 0) + 1, updated_at = datetime('now')
     WHERE id = ? AND user_id = ? AND COALESCE(version, 0) = ?`
  ).bind(serialized, tripId, user.id, ifMatch).run();
  if (!Number(result?.meta?.changes || 0)) {
    const current = await env.RIDE_TRIP_PLANNER_DB.prepare('SELECT id, version, updated_at FROM trips WHERE id = ? AND user_id = ?').bind(tripId, user.id).first();
    return current ? conflictResponse(current) : errorResponse('Trip not found', 404);
  }
  const saved = await env.RIDE_TRIP_PLANNER_DB.prepare('SELECT id, version, updated_at FROM trips WHERE id = ? AND user_id = ?').bind(tripId, user.id).first();
  const response = jsonResponse({ trip: { id: saved.id, version: saved.version, updated_at: saved.updated_at }, ...extra });
  response.headers.set('ETag', `"${saved.version}"`);
  return response;
}

async function readPlanningFile(request) {
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > MAX_PLANNING_FILE_BYTES) return { error: errorResponse('Choose a planning file smaller than 15 MB.', 413) };
  const body = await parseBody(request);
  if (!isPlainObject(body)) return { error: errorResponse('Send the planning file as a JSON object') };
  return { body };
}

/**
 * Run the UI's planning-update guards and preview against the trip as stored.
 * Returns { preview } or { error: Response }.
 */
function buildPreview(body, tripId, state) {
  const tripView = {
    id: tripId,
    settings: { itinerary: safeJsonParse(state.trip.settings || '{}', {}).itinerary },
    waypoints: [...state.waypointIds].map(id => ({ id })),
    journal: [...state.journalIds].map(id => ({ id }))
  };
  let preview;
  try {
    preview = RideItinerary.planningUpdatePreview(body, tripView);
  } catch (error) {
    return { error: jsonResponse({ error: error?.message || 'This planning file cannot be used for this trip.', guard: true }, 400) };
  }
  // The server write guard (also applied by the UI's save) decides can_apply too.
  const serverError = validateTripSettings({ itinerary: preview.itinerary }) || referenceError(preview.itinerary, state);
  const validationErrors = [...preview.validationErrors];
  if (serverError) validationErrors.push({ message: serverError, stopId: null, code: 'server' });
  return {
    preview: {
      trip_id: tripId,
      trip_version: Number(state.trip.version ?? 0),
      can_apply: preview.canApply && !serverError,
      summary: {
        start_date: preview.startDate,
        end_date: preview.endDate,
        stops: preview.itinerary.stops.length,
        nights: preview.totals?.nights || 0,
        distance_km: preview.totals?.distanceKm ?? 0,
        fuel_cost: preview.totals?.fuelCost ?? null
      },
      stop_changes: preview.stopChanges,
      anchor_changes: preview.anchorChanges,
      draft_changes: preview.draftChanges,
      conflicts: preview.conflicts,
      warnings: preview.warnings,
      validation_errors: validationErrors,
      itinerary: preview.itinerary
    }
  };
}

export const ItineraryWriteHandler = {
  async put(context) {
    const { env, user, params, request } = context;
    const body = await parseBody(request);
    if (!isPlainObject(body) || !isPlainObject(body.itinerary)) return errorResponse('Send { "itinerary": { ... } }');
    const extra = Object.keys(body).filter(key => key !== 'itinerary');
    if (extra.length) return errorResponse(`Only the itinerary can be changed here (unexpected: ${extra.join(', ')})`);
    const settingsError = validateTripSettings({ itinerary: body.itinerary });
    if (settingsError) return errorResponse(settingsError);

    const ifMatch = parseIfMatchVersion(request);
    if (ifMatch === null) return preconditionRequiredResponse();

    const state = await loadTripState(env, params.id, user.id);
    if (!state) return errorResponse('Trip not found', 404);
    if (Number(state.trip.version ?? 0) !== ifMatch) return conflictResponse(state.trip);

    const refError = referenceError(body.itinerary, state);
    if (refError) return errorResponse(refError);
    return saveItinerary(env, user, params.id, body.itinerary, state.trip, ifMatch);
  },

  /** Dry run of "Update this itinerary": what would change, and whether it can be saved. Never writes. */
  async preview(context) {
    const { env, user, params, request } = context;
    const { body, error } = await readPlanningFile(request);
    if (error) return error;
    const state = await loadTripState(env, params.id, user.id);
    if (!state) return errorResponse('Trip not found', 404);
    const built = buildPreview(body, params.id, state);
    if (built.error) return built.error;
    const response = jsonResponse(built.preview);
    response.headers.set('ETag', `"${built.preview.trip_version}"`);
    return response;
  },

  /** Save the planning file's itinerary, only if the trip is still at the previewed version (If-Match). */
  async apply(context) {
    const { env, user, params, request } = context;
    const { body, error } = await readPlanningFile(request);
    if (error) return error;
    const ifMatch = parseIfMatchVersion(request);
    if (ifMatch === null) return preconditionRequiredResponse();
    const state = await loadTripState(env, params.id, user.id);
    if (!state) return errorResponse('Trip not found', 404);
    if (Number(state.trip.version ?? 0) !== ifMatch) return conflictResponse(state.trip);

    const built = buildPreview(body, params.id, state);
    if (built.error) return built.error;
    if (!built.preview.can_apply) {
      return jsonResponse({ error: 'This itinerary has conflicts or validation errors and was not saved.', preview: built.preview }, 400);
    }
    const { itinerary: _saved, ...applied } = built.preview;
    return saveItinerary(env, user, params.id, built.preview.itinerary, state.trip, ifMatch, { applied });
  }
};
