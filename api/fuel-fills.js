/**
 * Fuel fill-ups: the live record of what was actually bought on a trip.
 * Owner-only. Every query is scoped by user_id and trip_id; another user's
 * trip or fill looks missing (404). The newest fill's price becomes the trip's
 * planning fuel price, and fuel status estimates the range left.
 */
import { jsonResponse, errorResponse, generateId, parseBody } from './utils.js';
import { safeJsonParse, verifyTripOwnership } from './handler-utils.js';

export const PAYMENT_METHODS = ['card', 'afterpay', 'cash', 'other'];
// No default tank size: a wrong guess (the old 110 L) showed a motorbike thousands of km of range.
// A trip says its tank in fuelPlan, fuel.tankLitres or vehicle.tankLitres; until then the range is unknown.
export const DEFAULT_LITRES_PER_100KM = 10.5;
export const PLAN_TIME_ZONE = 'Australia/Brisbane';
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;
const FIELDS = [
  'filled_at', 'lat', 'lng', 'accuracy_m', 'station_name', 'litres', 'price_per_litre', 'total_cost',
  'full_tank', 'jerry_filled', 'jerry_litres', 'odometer_km', 'payment_method', 'notes'
];
const COLUMNS = ['id', 'trip_id', ...FIELDS, 'created_at', 'updated_at'];

const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const round = (value, places = 2) => Math.round(value * 10 ** places) / 10 ** places;

export function validIsoTime(value) {
  return typeof value === 'string' && value.length <= 40 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value));
}

function optionalNumber(input, field, { min = 0, max, exclusiveMin = false } = {}) {
  const raw = input[field];
  if (raw === undefined || raw === null || raw === '') return { value: null };
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || (exclusiveMin && value <= min) || value > max) {
    return { error: `${field} must be a number${exclusiveMin ? ` above ${min}` : ` from ${min}`} up to ${max}` };
  }
  return { value };
}

function optionalText(input, field, max) {
  const raw = input[field];
  if (raw === undefined || raw === null) return { value: null };
  if (typeof raw !== 'string') return { error: `${field} must be text` };
  const value = raw.trim();
  if (value.length > max) return { error: `${field} is too long (max ${max})` };
  return { value: value || null };
}

function bool(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

/** Validate a complete fill record (after merging an update onto the stored row). */
export function validateFill(input, { requirePrice = true } = {}) {
  if (!isPlainObject(input)) return { error: 'Invalid fill-up' };
  const fill = {};
  const filledAt = input.filled_at === undefined || input.filled_at === null || input.filled_at === '' ? new Date().toISOString() : input.filled_at;
  if (!validIsoTime(filledAt)) return { error: 'filled_at must be an ISO date-time with a time zone' };
  if (Date.parse(filledAt) > Date.now() + 86400000) return { error: 'filled_at cannot be in the future' };
  fill.filled_at = new Date(Date.parse(filledAt)).toISOString();

  const numbers = [
    ['lat', { min: -90, max: 90 }], ['lng', { min: -180, max: 180 }], ['accuracy_m', { max: 100000 }],
    ['litres', { max: 1000, exclusiveMin: true }], ['price_per_litre', { max: 20, exclusiveMin: true }],
    ['total_cost', { max: 100000 }], ['jerry_litres', { max: 500 }], ['odometer_km', { max: 5000000 }]
  ];
  for (const [field, limits] of numbers) {
    const result = optionalNumber(input, field, limits);
    if (result.error) return result;
    fill[field] = result.value;
  }
  if ((fill.lat === null) !== (fill.lng === null)) return { error: 'lat and lng must be given together' };
  if (requirePrice && fill.price_per_litre === null) return { error: 'price_per_litre is required' };
  if (fill.price_per_litre !== null) fill.price_per_litre = round(fill.price_per_litre, 3);
  if (fill.total_cost === null && fill.litres !== null && fill.price_per_litre !== null) {
    fill.total_cost = round(fill.litres * fill.price_per_litre);
  }

  for (const [field, max] of [['station_name', 200], ['notes', 2000]]) {
    const result = optionalText(input, field, max);
    if (result.error) return result;
    fill[field] = result.value;
  }

  fill.full_tank = bool(input.full_tank) ? 1 : 0;
  fill.jerry_filled = bool(input.jerry_filled) || (fill.jerry_litres !== null && fill.jerry_litres > 0) ? 1 : 0;

  if (input.payment_method === undefined || input.payment_method === null || input.payment_method === '') {
    fill.payment_method = null;
  } else {
    const method = typeof input.payment_method === 'string' ? input.payment_method.trim().toLowerCase() : '';
    if (!PAYMENT_METHODS.includes(method)) return { error: `payment_method must be one of: ${PAYMENT_METHODS.join(', ')}` };
    fill.payment_method = method;
  }
  return { fill };
}

export function serializeFill(row) {
  if (!row) return null;
  const out = {};
  for (const column of COLUMNS) out[column] = row[column] ?? null;
  out.full_tank = !!row.full_tank;
  out.jerry_filled = !!row.jerry_filled;
  return out;
}

async function loadFill(env, userId, tripId, id) {
  return env.RIDE_TRIP_PLANNER_DB.prepare(
    `SELECT ${COLUMNS.join(', ')} FROM fuel_fills WHERE id = ? AND trip_id = ? AND user_id = ?`
  ).bind(id, tripId, userId).first();
}

/** Local calendar date (YYYY-MM-DD) of an instant in the plan's time zone. */
export function localDate(instant, timeZone = PLAN_TIME_ZONE) {
  const date = instant instanceof Date ? instant : new Date(instant);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = type => parts.find(part => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Tank capacity and consumption from the trip plan, with documented fallbacks. */
export function fuelPlanInputs(plan) {
  const fuelPlan = isPlainObject(plan?.fuelPlan) ? plan.fuelPlan : {};
  const fuel = isPlainObject(plan?.fuel) ? plan.fuel : {};
  const vehicle = isPlainObject(plan?.vehicle) ? plan.vehicle : {};
  const positive = value => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null);
  let capacity = positive(fuelPlan.totalCarriedLitres);
  let capacitySource = 'fuelPlan.totalCarriedLitres';
  if (!capacity && (positive(fuelPlan.tankLitres) || positive(fuelPlan.jerryLitres))) {
    capacity = (positive(fuelPlan.tankLitres) || 0) + (positive(fuelPlan.jerryLitres) || 0);
    capacitySource = 'fuelPlan.tankLitres + jerryLitres';
  }
  if (!capacity && positive(fuel.tankLitres)) { capacity = positive(fuel.tankLitres); capacitySource = 'fuel.tankLitres'; }
  if (!capacity && positive(vehicle.tankLitres)) { capacity = positive(vehicle.tankLitres); capacitySource = 'vehicle.tankLitres'; }
  if (!capacity) { capacity = null; capacitySource = 'none'; }
  const own = positive(fuel.litresPer100Km) || positive(vehicle.litresPer100Km);
  const consumption = own || DEFAULT_LITRES_PER_100KM;
  const reserveRaw = Number(vehicle.reserveLitres);
  const reserve = capacity && Number.isFinite(reserveRaw) && reserveRaw > 0 && reserveRaw < capacity ? reserveRaw : 0;
  return { capacity, capacitySource, consumption, consumptionSource: own ? (positive(fuel.litresPer100Km) ? 'fuel.litresPer100Km' : 'vehicle.litresPer100Km') : 'default', reserve };
}

/** Planned km for travel days after the fill day, up to and including today. */
export function plannedKmSince(plan, fillIso, now = new Date()) {
  if (!Array.isArray(plan?.stops)) return 0;
  const fillDay = localDate(fillIso);
  const today = localDate(now);
  let km = 0;
  for (const stop of plan.stops) {
    const arrival = stop?.arrivalDate;
    const distance = Number(stop?.leg?.distanceKm);
    if (typeof arrival === 'string' && arrival > fillDay && arrival <= today && Number.isFinite(distance) && distance > 0) km += distance;
  }
  return km;
}

/**
 * Estimate fuel left. Distance since the last full fill is the larger of the
 * logged ride distance and the planned legs travelled since (the cautious
 * choice). Part fills after the last full fill add their litres back.
 */
export function estimateRange({ fills, rideLogs, plan, now = new Date() }) {
  const inputs = fuelPlanInputs(plan);
  const sorted = [...(fills || [])].sort((a, b) => Date.parse(b.filled_at) - Date.parse(a.filled_at));
  const lastFull = sorted.find(fill => fill.full_tank);
  if (!inputs.capacity) return { capacity_litres: null, capacity_source: 'none', litres_per_100km: inputs.consumption, consumption_source: inputs.consumptionSource, estimate_only: true, known: false, reason: 'No tank size set for this trip' };
  const base = {
    capacity_litres: inputs.capacity,
    capacity_source: inputs.capacitySource,
    litres_per_100km: inputs.consumption,
    consumption_source: inputs.consumptionSource,
    reserve_litres: inputs.reserve,
    full_range_km: Math.round(inputs.capacity / inputs.consumption * 100),
    estimate_only: true
  };
  if (!lastFull) return { ...base, known: false, reason: 'No full-tank fill recorded yet' };
  const since = Date.parse(lastFull.filled_at);
  const loggedKm = (rideLogs || []).reduce((sum, log) => {
    const start = Date.parse(log.started_at || log.ended_at || '');
    const metres = Number(log.distance_meters);
    return Number.isFinite(start) && start >= since && Number.isFinite(metres) && metres > 0 ? sum + metres / 1000 : sum;
  }, 0);
  const plannedKm = plannedKmSince(plan, lastFull.filled_at, now);
  const kmSince = Math.max(loggedKm, plannedKm);
  const addedLitres = sorted
    .filter(fill => !fill.full_tank && Date.parse(fill.filled_at) > since)
    .reduce((sum, fill) => sum + (Number(fill.litres) || 0) + (Number(fill.jerry_litres) || 0), 0);
  const used = kmSince * inputs.consumption / 100;
  const left = Math.min(inputs.capacity, Math.max(0, inputs.capacity - used + addedLitres));
  return {
    ...base,
    known: true,
    last_full_fill_at: lastFull.filled_at,
    km_since_full: Math.round(kmSince),
    km_logged: Math.round(loggedKm),
    km_planned: Math.round(plannedKm),
    km_source: kmSince === 0 ? 'none' : (loggedKm >= plannedKm ? 'ride-logs' : 'planned-route'),
    litres_added_since: round(addedLitres, 1),
    est_litres_left: Math.round(left),
    est_range_left_km: Math.round(left / inputs.consumption * 100),
    est_litres_to_reserve: round(Math.max(0, left - inputs.reserve), 1),
    est_range_to_reserve_km: Math.round(Math.max(0, left - inputs.reserve) / inputs.consumption * 100)
  };
}

/** Latest fill, last full fill and estimated range for an owned trip row. */
export async function fuelStatus(env, userId, trip) {
  const fills = await env.RIDE_TRIP_PLANNER_DB.prepare(
    `SELECT ${COLUMNS.join(', ')} FROM fuel_fills WHERE trip_id = ? AND user_id = ? ORDER BY filled_at DESC LIMIT 200`
  ).bind(trip.id, userId).all();
  const logs = await env.RIDE_TRIP_PLANNER_DB.prepare(
    'SELECT started_at, ended_at, distance_meters FROM ride_logs WHERE trip_id = ? ORDER BY created_at DESC LIMIT 500'
  ).bind(trip.id).all();
  const rows = (fills.results || []).map(serializeFill);
  const plan = safeJsonParse(trip.settings, {})?.itinerary || null;
  return {
    latest_fill: rows[0] || null,
    last_full_fill: rows.find(fill => fill.full_tank) || null,
    fill_count: rows.length,
    planning_price_per_litre: Number(plan?.fuel?.pricePerLitre) || null,
    range: estimateRange({ fills: rows, rideLogs: logs.results || [], plan })
  };
}

/**
 * Copy the newest fill's price into the trip's planning fuel price. Uses the
 * trip version as a guard and bumps it, so an open editor cannot silently
 * overwrite the new price with an older itinerary.
 */
async function syncPlanningPrice(env, userId, tripId) {
  const newest = await env.RIDE_TRIP_PLANNER_DB.prepare(
    'SELECT price_per_litre FROM fuel_fills WHERE trip_id = ? AND user_id = ? AND price_per_litre IS NOT NULL ORDER BY filled_at DESC, created_at DESC LIMIT 1'
  ).bind(tripId, userId).first();
  if (!newest?.price_per_litre) return false;
  const trip = await env.RIDE_TRIP_PLANNER_DB.prepare(
    'SELECT settings, version FROM trips WHERE id = ? AND user_id = ?'
  ).bind(tripId, userId).first();
  const settings = safeJsonParse(trip?.settings, {});
  const plan = settings?.itinerary;
  if (!isPlainObject(plan)) return false;
  if (Number(plan.fuel?.pricePerLitre) === newest.price_per_litre) return false;
  const next = { ...settings, itinerary: { ...plan, fuel: { ...(isPlainObject(plan.fuel) ? plan.fuel : {}), pricePerLitre: newest.price_per_litre } } };
  const ownUse = Number(next.itinerary.vehicle?.litresPer100Km);
  if ((!Number.isFinite(next.itinerary.fuel.litresPer100Km) || next.itinerary.fuel.litresPer100Km <= 0) && !(ownUse > 0)) {
    next.itinerary.fuel.litresPer100Km = DEFAULT_LITRES_PER_100KM;
  }
  const result = await env.RIDE_TRIP_PLANNER_DB.prepare(
    `UPDATE trips SET settings = ?, version = COALESCE(version, 0) + 1, updated_at = datetime('now')
     WHERE id = ? AND user_id = ? AND COALESCE(version, 0) = ?`
  ).bind(JSON.stringify(next), tripId, userId, Number(trip.version ?? 0)).run();
  if (!Number(result?.meta?.changes || 0)) return false;
  return { version: Number(trip.version ?? 0) + 1, price_per_litre: newest.price_per_litre };
}

export const FuelFillsHandler = {
  async list(context) {
    const { env, user, params } = context;
    const trip = await verifyTripOwnership(env, params.tripId, user.id);
    if (!trip) return errorResponse('Trip not found', 404);
    const url = context.url || new URL(context.request.url);
    const limit = Math.min(500, Math.max(1, Number.parseInt(url.searchParams.get('limit') || '100', 10) || 100));
    const rows = await env.RIDE_TRIP_PLANNER_DB.prepare(
      `SELECT ${COLUMNS.join(', ')} FROM fuel_fills WHERE trip_id = ? AND user_id = ? ORDER BY filled_at DESC LIMIT ?`
    ).bind(params.tripId, user.id, limit).all();
    return jsonResponse({ fills: (rows.results || []).map(serializeFill) });
  },

  async status(context) {
    const { env, user, params } = context;
    const trip = await verifyTripOwnership(env, params.tripId, user.id);
    if (!trip) return errorResponse('Trip not found', 404);
    return jsonResponse(await fuelStatus(env, user.id, trip));
  },

  async get(context) {
    const { env, user, params } = context;
    const row = await loadFill(env, user.id, params.tripId, params.id);
    if (!row) return errorResponse('Fill-up not found', 404);
    return jsonResponse({ fill: serializeFill(row) });
  },

  async create(context) {
    const { env, user, params, request } = context;
    const body = await parseBody(request);
    if (!isPlainObject(body)) return errorResponse('A JSON object is required');
    const trip = await verifyTripOwnership(env, params.tripId, user.id);
    if (!trip) return errorResponse('Trip not found', 404);
    if (body.id != null && (typeof body.id !== 'string' || !CLIENT_ID_PATTERN.test(body.id))) return errorResponse('id must be 8-80 letters, digits, _ or -');
    const { fill, error } = validateFill(body);
    if (error) return errorResponse(error);

    const id = body.id || generateId();
    const existing = await env.RIDE_TRIP_PLANNER_DB.prepare('SELECT id, trip_id, user_id FROM fuel_fills WHERE id = ?').bind(id).first();
    if (existing) {
      if (existing.user_id !== user.id || existing.trip_id !== params.tripId) return errorResponse('Fill-up id conflict', 409);
      return jsonResponse({ fill: serializeFill(await loadFill(env, user.id, params.tripId, id)), duplicate: true });
    }
    const now = new Date().toISOString();
    await env.RIDE_TRIP_PLANNER_DB.prepare(
      `INSERT INTO fuel_fills (id, user_id, trip_id, ${FIELDS.join(', ')}, created_at, updated_at)
       VALUES (?, ?, ?, ${FIELDS.map(() => '?').join(', ')}, ?, ?)`
    ).bind(id, user.id, params.tripId, ...FIELDS.map(field => fill[field]), now, now).run();
    const planningPriceUpdated = await syncPlanningPrice(env, user.id, params.tripId);
    return jsonResponse({ fill: serializeFill(await loadFill(env, user.id, params.tripId, id)), planning_price_updated: !!planningPriceUpdated, trip_version: planningPriceUpdated ? planningPriceUpdated.version : null }, 201);
  },

  async update(context) {
    const { env, user, params, request } = context;
    const body = await parseBody(request);
    if (!isPlainObject(body)) return errorResponse('A JSON object is required');
    const row = await loadFill(env, user.id, params.tripId, params.id);
    if (!row) return errorResponse('Fill-up not found', 404);
    const merged = { ...serializeFill(row) };
    for (const field of FIELDS) if (Object.prototype.hasOwnProperty.call(body, field)) merged[field] = body[field];
    const { fill, error } = validateFill(merged, { requirePrice: false });
    if (error) return errorResponse(error);
    if (fill.price_per_litre === null && row.price_per_litre !== null) return errorResponse('price_per_litre cannot be removed');
    await env.RIDE_TRIP_PLANNER_DB.prepare(
      `UPDATE fuel_fills SET ${FIELDS.map(field => `${field} = ?`).join(', ')}, updated_at = ?
       WHERE id = ? AND trip_id = ? AND user_id = ?`
    ).bind(...FIELDS.map(field => fill[field]), new Date().toISOString(), params.id, params.tripId, user.id).run();
    const planningPriceUpdated = await syncPlanningPrice(env, user.id, params.tripId);
    return jsonResponse({ fill: serializeFill(await loadFill(env, user.id, params.tripId, params.id)), planning_price_updated: !!planningPriceUpdated, trip_version: planningPriceUpdated ? planningPriceUpdated.version : null });
  },

  async remove(context) {
    const { env, user, params } = context;
    const result = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'DELETE FROM fuel_fills WHERE id = ? AND trip_id = ? AND user_id = ?'
    ).bind(params.id, params.tripId, user.id).run();
    if (!Number(result?.meta?.changes || 0)) return errorResponse('Fill-up not found', 404);
    return jsonResponse({ success: true });
  }
};
