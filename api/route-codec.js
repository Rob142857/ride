/** Lossless route storage. D1 limits each string/row to 2,000,000 bytes. */
export const D1_ROW_BUDGET = 1950000; // Leave room for row headers and scalar columns.

export function assertRowSize(values, label = 'Trip data') {
  const bytes = values.reduce((total, value) => total + new TextEncoder().encode(value === null || value === undefined ? '' : String(value)).byteLength, 0);
  if (bytes > D1_ROW_BUDGET) throw new Error(`${label} exceeds the database row size limit. Split the data into smaller sections.`);
  return bytes;
}

export function compactCoordinates(coordinates = []) {
  if (!Array.isArray(coordinates)) throw new Error('Route coordinates must be an array.');
  return coordinates.map(point => {
    const lng = Array.isArray(point) ? point[0] : point?.lng;
    const lat = Array.isArray(point) ? point[1] : point?.lat;
    if (!Number.isFinite(lng) || lng < -180 || lng > 180 || !Number.isFinite(lat) || lat < -90 || lat > 90) throw new Error('Route contains invalid coordinates.');
    return [lng, lat];
  });
}

/** Read both legacy object geometry and compact pairs into the map's object shape. */
export function expandCoordinates(coordinates = []) {
  if (!Array.isArray(coordinates)) return [];
  return coordinates.map(point => Array.isArray(point) ? { lng: point[0], lat: point[1] } : point);
}

export function encodeRoute(route) {
  if (!route || typeof route !== 'object' || Array.isArray(route)) throw new Error('Route must be an object.');
  for (const key of ['name', 'summary', 'color']) if (route[key] !== undefined && route[key] !== null && typeof route[key] !== 'string') throw new Error(`Route ${key} must be text.`);
  const distance = route.distance_meters ?? route.distance ?? null;
  const duration = route.duration_seconds ?? route.duration ?? route.time ?? null;
  if ([distance, duration].some(value => value !== null && (!Number.isFinite(value) || value < 0))) throw new Error('Route distance and duration must be non-negative numbers.');
  if (route.steps !== undefined && !Array.isArray(route.steps)) throw new Error('Route steps must be an array.');
  const coordinates = JSON.stringify(compactCoordinates(route.coordinates || []));
  const steps = JSON.stringify(route.steps || []);
  assertRowSize([coordinates, steps, route.name, route.summary, route.color], 'Route geometry and directions');
  return { coordinates, steps, distance, duration };
}

export function uniqueRouteChoices(routes, selectedIndex = 0) {
  const seen = new Map();
  const unique = [];
  let activeIndex = 0;
  routes.forEach((route, index) => {
    const key = route.coordinates?.length ? JSON.stringify(compactCoordinates(route.coordinates)) : JSON.stringify([route.name, route.distance, route.duration]);
    if (!seen.has(key)) { seen.set(key, unique.length); unique.push(route); }
    if (index === selectedIndex) activeIndex = seen.get(key);
  });
  return { routes: unique, activeIndex };
}
