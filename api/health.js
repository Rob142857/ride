/* global setTimeout, clearTimeout */
/**
 * Public health route for uptime watchers (Argus). GET/HEAD /health, no login.
 * Returns only {app, ok, version, db}: no counts, ids, trip or user data, no error text.
 * One D1 `SELECT 1` per call, cut off after HEALTH_DB_TIMEOUT_MS so a slow database
 * answers 503 "down" instead of hanging. The limiter is per Worker instance and
 * in memory: it cannot fail the request (any limiter error is ignored: fail open).
 */
export const HEALTH_DB_TIMEOUT_MS = 2000;
export const HEALTH_RATE_PER_MINUTE = 60;
const WINDOW_MS = 60_000;
const MAX_TRACKED_CLIENTS = 500;

const hits = new Map();

/** True when this client has used up its calls in the current minute. Never throws. */
export function healthRateLimited(clientKey, now = Date.now(), store = hits) {
  try {
    const entry = store.get(clientKey);
    if (!entry || now - entry.start >= WINDOW_MS) {
      if (store.size >= MAX_TRACKED_CLIENTS) {
        for (const [key, value] of store) if (now - value.start >= WINDOW_MS) store.delete(key);
        if (store.size >= MAX_TRACKED_CLIENTS) store.clear();
      }
      store.set(clientKey, { start: now, count: 1 });
      return false;
    }
    entry.count += 1;
    return entry.count > HEALTH_RATE_PER_MINUTE;
  } catch {
    return false;
  }
}

function reply(request, status, body, extra = {}) {
  return new Response(request.method === 'HEAD' ? null : JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extra
    }
  });
}

async function databaseUp(env, timeoutMs) {
  let timer;
  try {
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); });
    const row = await Promise.race([env.RIDE_TRIP_PLANNER_DB.prepare('SELECT 1 AS ok').first(), timeout]);
    return !!row && Number(row.ok) === 1;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function handleHealth(request, env, { version, timeoutMs = HEALTH_DB_TIMEOUT_MS, now = Date.now(), store = hits } = {}) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return reply(request, 405, { ok: false }, { Allow: 'GET, HEAD' });
  }
  const client = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (healthRateLimited(client, now, store)) {
    return reply(request, 429, { ok: false }, { 'Retry-After': '60' });
  }
  const up = await databaseUp(env, timeoutMs);
  return reply(request, up ? 200 : 503, { app: 'ride', ok: up, version, db: up ? 'ok' : 'down' });
}
