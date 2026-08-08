/**
 * Utility functions for the API
 */
export function cors(response = new Response(null, { status: 204 })) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', BASE_URL);
  headers.set('Access-Control-Allow-Credentials', 'true');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, If-Match');
  headers.set('Access-Control-Max-Age', '86400');
  headers.append('Vary', 'Origin');
  
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

/**
 * JSON response helper
 */
export function jsonResponse(data, status = 200) {
  return cors(new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // Never cache API JSON. Prevents stale reads after writes (e.g. waypoint reorder).
      'Cache-Control': 'no-store, no-cache, max-age=0, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
      // Baseline security headers on every API response (HTML responses get the
      // fuller CSP/frame-options set in api/worker.js's addSecurityHeaders)
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload'
    }
  }));
}

/**
 * Error response helper
 */
export function errorResponse(message, status = 400) {
  return jsonResponse({ error: message }, status);
}

/**
 * Generate unique ID (CSPRNG)
 */
export function generateId() {
  return crypto.randomUUID();
}

/**
 * Generate deterministic short code from a stable ID (base62, default length 6).
 * Uses a 64-bit rolling hash to keep the same code for the same ID and keep
 * regeneration consistent across environments. Collisions are extremely rare
 * but still handled by callers.
 */
const BASE62_CHARS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function generateShortCodeForId(id, length = 6) {
  if (!id) return generateShortCode(length);
  const prime = 1099511628211n; // FNV-like prime
  const modMask = (1n << 64n) - 1n; // Keep hash bounded
  let hash = 14695981039346656037n; // FNV offset basis

  for (let i = 0; i < id.length; i++) {
    hash = (hash ^ BigInt(id.charCodeAt(i))) * prime & modMask;
  }

  const base = BigInt(BASE62_CHARS.length);
  let code = '';
  let value = hash;
  for (let i = 0; i < length; i++) {
    code += BASE62_CHARS[Number(value % base)];
    value = value / base;
  }
  return code;
}

/**
 * Generate short URL code (base62). Uses characters: 0-9, a-z, A-Z.
 */
export function generateShortCode(length = 6) {
  let code = '';
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  for (let i = 0; i < length; i++) {
    code += BASE62_CHARS[array[i] % 62];
  }
  return code;
}

/**
 * Base URL for the application
 */
export const BASE_URL = 'https://ride.incitat.io';

/**
 * Extract the session token from the Authorization header or session cookie.
 * Accepts the new __Host- prefixed cookie and, during the transition window,
 * the legacy cookie name. The regex is anchored to the cookie-name boundary so
 * an unrelated cookie whose name merely ends in "ride_session" can never match.
 */
export function getSessionToken(request) {
  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return readCookie(request, '__Host-ride_session') || readCookie(request, 'ride_session');
}

/**
 * Read a single cookie by exact name.
 * Anchored to the cookie-name boundary so a cookie called `x_ride_session`
 * can never satisfy a lookup for `ride_session`.
 */
export function readCookie(request, name) {
  const cookies = request.headers.get('Cookie') || '';
  if (!cookies) return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = cookies.match(new RegExp(`(?:^|;\\s*)${escaped}=([^;\\s]*)`));
  return match ? match[1] : null;
}

/**
 * Cheap sliding 1-minute rate limiter backed by KV.
 * Non-atomic read-modify-write — good enough to blunt abuse, not a hard cap.
 * Fails open on KV errors so an outage never blocks legitimate traffic.
 */
export async function checkRateLimit(env, bucket, id, limit) {
  try {
    const minute = Math.floor(Date.now() / 60000);
    const key = `rl:${bucket}:${id}:${minute}`;
    const count = Number.parseInt(await env.RIDE_TRIP_PLANNER_SESSIONS.get(key) || '0', 10);
    if (count >= limit) return false;
    await env.RIDE_TRIP_PLANNER_SESSIONS.put(key, String(count + 1), { expirationTtl: 120 });
    return true;
  } catch (_) {
    return true; // fail open
  }
}

/**
 * Router middleware factory: per-IP rate limit for a named bucket.
 */
export function rateLimitByIp(bucket, limit) {
  return async (context) => {
    const ip = context.request.headers.get('cf-connecting-ip') || 'unknown';
    if (!(await checkRateLimit(context.env, bucket, ip, limit))) {
      return errorResponse('Too many requests. Please slow down.', 429);
    }
  };
}

/**
 * Router middleware factory: per-user rate limit, falling back to IP for
 * anonymous callers. Register it AFTER requireAuth so context.user is set.
 */
export function rateLimitByUser(bucket, limit) {
  return async (context) => {
    const id = context.user?.id || context.request.headers.get('cf-connecting-ip') || 'unknown';
    if (!(await checkRateLimit(context.env, bucket, id, limit))) {
      return errorResponse('Too many requests. Please slow down.', 429);
    }
  };
}

/**
 * Authentication middleware
 */
export async function requireAuth(context) {
  const { request, env } = context;

  const token = getSessionToken(request);
  if (!token) {
    return errorResponse('Unauthorized', 401);
  }

  // Verify token from KV store
  try {
    const sessionData = await env.RIDE_TRIP_PLANNER_SESSIONS.get(token, 'json');
    if (!sessionData) {
      return errorResponse('Session expired', 401);
    }

    // Check expiry
    if (sessionData.expiresAt && Date.now() > sessionData.expiresAt) {
      await env.RIDE_TRIP_PLANNER_SESSIONS.delete(token);
      return errorResponse('Session expired', 401);
    }

    // Attach user to context
    context.user = sessionData.user;

    // Check if user is banned or suspended. setUserStatus already revokes every
    // KV session the instant an admin bans someone, so a D1 query on every
    // single request was pure latency for no extra safety on top of that — it
    // only matters for sessions the revocation registry missed. The result is
    // cached on the session record itself and only re-verified periodically.
    let status = sessionData.status ?? null;
    const statusStale = !sessionData.statusCheckedAt
      || (Date.now() - sessionData.statusCheckedAt) > BAN_CHECK_INTERVAL_MS;
    let statusRefreshed = false;
    if (statusStale) {
      try {
        const row = await env.RIDE_TRIP_PLANNER_DB.prepare(
          'SELECT status FROM users WHERE id = ?'
        ).bind(sessionData.user.id).first();
        status = row?.status ?? null;
        statusRefreshed = true;
      } catch (_) { /* status column may not exist yet — fail open, keep prior cached value */ }
    }

    if (status === 'banned' || status === 'blocked') {
      return errorResponse('Account has been blocked. Contact support.', 403);
    }
    if (status === 'suspended' || status === 'paused') {
      return errorResponse('Account temporarily paused. Contact support.', 403);
    }

    // Sliding renewal: once past 50% of the session TTL, extend the KV record
    // and reissue the cookie so active users are never silently logged out.
    // Piggybacks the freshly-checked ban status onto the same write when there
    // is one, instead of writing to KV twice.
    const needsRenewal = sessionData.expiresAt && (sessionData.expiresAt - Date.now()) < (SESSION_TTL_SECONDS * 1000) / 2;
    if (needsRenewal || statusRefreshed) {
      try {
        const renewedExpiresAt = needsRenewal ? Date.now() + SESSION_TTL_SECONDS * 1000 : sessionData.expiresAt;
        const ttlSeconds = needsRenewal
          ? SESSION_TTL_SECONDS
          : Math.max(60, Math.floor((renewedExpiresAt - Date.now()) / 1000));

        await env.RIDE_TRIP_PLANNER_SESSIONS.put(token, JSON.stringify({
          user: sessionData.user,
          expiresAt: renewedExpiresAt,
          status,
          statusCheckedAt: statusRefreshed ? Date.now() : (sessionData.statusCheckedAt || null)
        }), { expirationTtl: ttlSeconds });

        if (needsRenewal) {
          // Keep the per-user registry in sync so revoke-all still covers this token
          const registryKey = `sessions:${sessionData.user.id}`;
          const raw = await env.RIDE_TRIP_PLANNER_SESSIONS.get(registryKey, 'json');
          if (Array.isArray(raw)) {
            const entry = raw.find(s => s.token === token);
            if (entry) {
              entry.expiresAt = renewedExpiresAt;
              await env.RIDE_TRIP_PLANNER_SESSIONS.put(registryKey, JSON.stringify(raw), {
                expirationTtl: SESSION_TTL_SECONDS
              });
            }
          }

          // The router applies this to the final response (fresh Set-Cookie)
          context.decorateResponse = (resp) => setSessionCookie(resp, token, renewedExpiresAt);
        }
      } catch (_) { /* renewal/cache write is best-effort */ }
    }

    // Continue to next handler (return nothing)
    return;
  } catch (error) {
    console.error('Auth error:', error);
    return errorResponse('Authentication failed', 401);
  }
}

/**
 * Optional authentication middleware - doesn't fail if not logged in
 */
export async function optionalAuth(context) {
  const { request, env } = context;

  const token = getSessionToken(request);
  if (!token) {
    context.user = null;
    return; // Continue without auth
  }
  
  try {
    const sessionData = await env.RIDE_TRIP_PLANNER_SESSIONS.get(token, 'json');
    if (sessionData && (!sessionData.expiresAt || Date.now() <= sessionData.expiresAt)) {
      context.user = sessionData.user;
    } else {
      context.user = null;
    }
  } catch {
    context.user = null;
  }
  
  return; // Always continue
}

/**
 * Max concurrent sessions per user. When exceeded, the oldest session is evicted.
 * Cloudflare KV TTL handles cleanup of expired entries automatically.
 */
const MAX_SESSIONS_PER_USER = 10;
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

/** How often requireAuth re-verifies ban/pause status against D1, per session. */
const BAN_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Create session token, store in KV, and register it in the per-user session list.
 * Multiple sessions (e.g. desktop + mobile) are fully supported; the list is
 * capped at MAX_SESSIONS_PER_USER to prevent unbounded KV growth.
 */
export async function createSession(env, user) {
  // 256-bit CSPRNG session token
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
  const expiresAt = Date.now() + (SESSION_TTL_SECONDS * 1000);
  
  await env.RIDE_TRIP_PLANNER_SESSIONS.put(token, JSON.stringify({
    user,
    expiresAt
  }), {
    expirationTtl: SESSION_TTL_SECONDS
  });

  // Track active sessions per user (KV key: sessions:{userId})
  // This allows us to cap sessions and provides a "revoke all" path.
  const registryKey = `sessions:${user.id}`;
  try {
    const raw = await env.RIDE_TRIP_PLANNER_SESSIONS.get(registryKey, 'json');
    let sessions = Array.isArray(raw) ? raw : [];

    // Prune expired entries
    const now = Date.now();
    sessions = sessions.filter(s => s.expiresAt > now);

    // Add the new session
    sessions.push({ token, expiresAt });

    // If over the cap, evict the oldest sessions
    if (sessions.length > MAX_SESSIONS_PER_USER) {
      const evicted = sessions.splice(0, sessions.length - MAX_SESSIONS_PER_USER);
      // Delete the evicted session tokens from KV (fire-and-forget)
      await Promise.allSettled(evicted.map(s => env.RIDE_TRIP_PLANNER_SESSIONS.delete(s.token)));
    }

    await env.RIDE_TRIP_PLANNER_SESSIONS.put(registryKey, JSON.stringify(sessions), {
      expirationTtl: SESSION_TTL_SECONDS
    });
  } catch (_) {
    // Non-critical — session still works, just no registry tracking
  }

  return { token, expiresAt };
}

/**
 * Set session cookie.
 * Uses the __Host- prefix (requires Secure + Path=/ + no Domain) so sibling
 * subdomains can never plant or override the session cookie. The legacy
 * unprefixed cookie is cleared in the same response so old and new copies
 * can never disagree.
 */
export function setSessionCookie(response, token, expiresAt) {
  const headers = new Headers(response.headers);
  const expires = new Date(expiresAt).toUTCString();
  headers.append('Set-Cookie', `__Host-ride_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${expires}`);
  headers.append('Set-Cookie', 'ride_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');

  return new Response(response.body, {
    status: response.status,
    headers
  });
}

/**
 * Admin authentication middleware - requires ADMIN_KEY env var
 */
export async function requireAdmin(context) {
  const { env, request } = context;

  if (!env.ADMIN_KEY) {
    return errorResponse('Admin access not configured', 403);
  }

  const provided = request.headers.get('x-admin-key');
  if (!provided) return errorResponse('Unauthorized', 401);

  // Constant-time comparison to prevent timing side-channel attacks
  const enc = new TextEncoder();
  const a = enc.encode(provided);
  const b = enc.encode(env.ADMIN_KEY);
  if (a.byteLength !== b.byteLength || !crypto.subtle.timingSafeEqual(a, b)) {
    return errorResponse('Unauthorized', 401);
  }

  // Continue to next handler
  return;
}

export function getAdminEmailSet(env) {
  const raw = env.ADMIN_EMAILS || env.ADMIN_EMAIL || '';
  return new Set(raw.split(/[\s,;]+/).map(email => email.trim().toLowerCase()).filter(Boolean));
}

/**
 * Browser admin middleware - requires a valid Ride session whose email is allowlisted.
 */
export async function requireAdminUser(context) {
  const authResult = await requireAuth(context);
  if (authResult) return authResult;

  const adminEmails = getAdminEmailSet(context.env);
  if (!adminEmails.size) return errorResponse('Admin access not configured', 403);

  const email = (context.user?.email || '').trim().toLowerCase();
  if (!email || !adminEmails.has(email)) return errorResponse('Forbidden', 403);

  return;
}

/**
 * Clear session cookie (both current and legacy names)
 */
export function clearSessionCookie(response) {
  const headers = new Headers(response.headers);
  headers.append('Set-Cookie', '__Host-ride_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
  headers.append('Set-Cookie', 'ride_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');

  return new Response(response.body, {
    status: response.status,
    headers
  });
}
