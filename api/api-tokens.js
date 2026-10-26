/**
 * Personal access tokens ("ride_pat_...") for scripted, owner-only access.
 *
 * - Only a signed-in Ride session (cookie) can create, list or revoke tokens.
 *   Any Authorization header on those routes is refused, so a token can never
 *   mint, list or revoke tokens.
 * - A token is 32 CSPRNG bytes, shown once. Only its SHA-256 hash is stored and
 *   tokens are found by hash lookup, so no secret is ever compared byte by byte.
 * - Tokens are accepted only on routes wrapped with scoped(scope, handler), and
 *   only when the token carries that scope. Every other route refuses them.
 * - Token requests are rate limited per token and every token write is audited.
 * - Token responses carry no CORS headers: the Bearer path is for scripts, not
 *   for browsers, and never mixes with cookies.
 */
import { jsonResponse, errorResponse, generateId, parseBody, requireAuth, BASE_URL } from './utils.js';
import { safeJsonParse } from './handler-utils.js';

export const TOKEN_PREFIX = 'ride_pat_';
// Colon scopes are the original REST names. Dot scopes follow the shared MCP
// convention (<area>.<verb>): `account.read` lets an AI app see who the token
// acts for, and `mcp.connect` is the opt-in that lets a token call /mcp at all.
export const TOKEN_SCOPES = ['trips:read', 'itinerary:write', 'waypoints:rw', 'places:rw', 'fuel:rw', 'checkins:rw', 'ridelogs:read', 'journal:write', 'account.read', 'mcp.connect'];
export const MAX_ACTIVE_TOKENS = 20;
export const MAX_EXPIRY_DAYS = 365;
export const DEFAULT_EXPIRY_DAYS = 90;
export const RATE_LIMIT_PER_MINUTE = 60;
const TOKEN_PATTERN = /^ride_pat_[A-Za-z0-9_-]{43}$/;
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const CORS_HEADERS = [
  'Access-Control-Allow-Origin', 'Access-Control-Allow-Credentials', 'Access-Control-Allow-Methods',
  'Access-Control-Allow-Headers', 'Access-Control-Max-Age'
];

const nowIso = () => new Date().toISOString();

function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** A new token: 'ride_pat_' + 43 base64url chars (32 random bytes). */
export function generateTokenSecret() {
  return TOKEN_PREFIX + base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** The bearer value when the request presents a personal access token, else null. */
export function presentedPat(request) {
  const header = request.headers.get('Authorization') || '';
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!match || !match[1].startsWith(TOKEN_PREFIX)) return null;
  return match[1];
}

function timingSafeEqualText(a, b) {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.byteLength !== right.byteLength) return false;
  if (crypto.subtle.timingSafeEqual) return crypto.subtle.timingSafeEqual(left, right);
  let diff = 0;
  for (let i = 0; i < left.byteLength; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

/** Remove every CORS header: Bearer responses are never readable cross-origin. */
export function withoutCors(response) {
  const headers = new Headers(response.headers);
  for (const name of CORS_HEADERS) headers.delete(name);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * Cookie writes must come from Ride itself. Browsers always send Origin on
 * cross-origin POST/PUT/DELETE, so a foreign Origin is refused (CSRF guard,
 * including same-site subdomains that SameSite=Lax would let through).
 */
export function sameOriginWrite(context, allowedOrigins = [BASE_URL]) {
  const { request } = context;
  if (!WRITE_METHODS.has(request.method.toUpperCase())) return null;
  const origin = request.headers.get('Origin');
  if (!origin) return null;
  const own = (context.url || new URL(request.url)).origin;
  if (origin === own || allowedOrigins.includes(origin)) return null;
  return errorResponse('Cross-origin write refused', 403);
}

function publicToken(row) {
  const now = Date.now();
  const status = row.revoked_at ? 'revoked' : (Date.parse(row.expires_at) <= now ? 'expired' : 'active');
  return {
    id: row.id,
    name: row.name,
    hint: `${row.token_hint}…`,
    scopes: safeJsonParse(row.scopes, []),
    created_at: row.created_at,
    last_used_at: row.last_used_at || null,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at || null,
    status
  };
}

export async function audit(env, { tokenId, userId, method, route, status }) {
  try {
    await env.RIDE_TRIP_PLANNER_DB.prepare(
      'INSERT INTO api_token_audit (id, token_id, user_id, method, route, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(generateId(), tokenId, userId, method, route.slice(0, 300), status ?? null, nowIso()).run();
  } catch (error) {
    console.error('Token audit write failed:', error?.message || error);
  }
}

/** Fixed one-minute window counter in D1. Returns the count for this window. */
export async function countRequest(env, tokenId) {
  const windowStart = Math.floor(Date.now() / 60000) * 60;
  const row = await env.RIDE_TRIP_PLANNER_DB.prepare(
    `INSERT INTO api_token_rate (token_id, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT(token_id, window_start) DO UPDATE SET count = count + 1
     RETURNING count`
  ).bind(tokenId, windowStart).first();
  const count = Number(row?.count ?? 1);
  if (count === 1) {
    await env.RIDE_TRIP_PLANNER_DB.prepare(
      'DELETE FROM api_token_rate WHERE token_id = ? AND window_start < ?'
    ).bind(tokenId, windowStart - 3600).run();
  }
  return count;
}

/**
 * Look up a personal access token and its owner, live, on every request.
 * Returns { row, user, scopes } or { status, message } when it must be refused.
 * No rate limiting or scope check here: callers add their own.
 */
export async function verifyPat(env, secret) {
  const invalid = { status: 401, message: 'Invalid or expired token' };
  if (!TOKEN_PATTERN.test(secret)) return invalid;
  const hash = await sha256Hex(secret);
  let row;
  try {
    row = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT id, user_id, token_hash, scopes, expires_at, revoked_at FROM api_tokens WHERE token_hash = ?'
    ).bind(hash).first();
  } catch (error) {
    console.error('Token lookup failed:', error?.message || error);
    return invalid;
  }
  if (!row || !timingSafeEqualText(row.token_hash, hash)) return invalid;
  if (row.revoked_at) return invalid;
  const expires = Date.parse(row.expires_at);
  if (!Number.isFinite(expires) || expires <= Date.now()) return invalid;

  // SELECT * so older databases without a status column still work.
  const user = await env.RIDE_TRIP_PLANNER_DB.prepare('SELECT * FROM users WHERE id = ?').bind(row.user_id).first();
  if (!user) return invalid;
  if (['banned', 'blocked', 'suspended', 'paused'].includes(user.status)) return { status: 403, message: 'Account is not active' };
  const scopes = safeJsonParse(row.scopes, []);
  return { row, user, scopes: Array.isArray(scopes) ? scopes : [] };
}

/** Record that a token was used (non-blocking where the platform allows). */
export async function touchToken(context, tokenId) {
  const touch = context.env.RIDE_TRIP_PLANNER_DB.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?')
    .bind(nowIso(), tokenId).run().catch(error => console.error('Token touch failed:', error?.message || error));
  if (context.ctx?.waitUntil) context.ctx.waitUntil(touch); else await touch;
}

/**
 * Authenticate a personal access token for one scope. Sets context.user and
 * context.apiToken, or returns a 401/403/429 Response.
 */
async function authenticatePat(context, secret, scope) {
  const { env } = context;
  const verified = await verifyPat(env, secret);
  if (verified.status) return errorResponse(verified.message, verified.status);
  const { row, scopes } = verified;

  const count = await countRequest(env, row.id);
  if (count > RATE_LIMIT_PER_MINUTE) {
    const response = errorResponse('Rate limit exceeded. Try again in a minute.', 429);
    response.headers.set('Retry-After', String(60 - (Math.floor(Date.now() / 1000) % 60)));
    return response;
  }

  if (!scopes.includes(scope)) {
    return jsonResponse({ error: 'This token does not have the required scope', required_scope: scope }, 403);
  }

  context.user = { id: row.user_id };
  context.apiToken = { id: row.id, scopes };
  await touchToken(context, row.id);
  return null;
}

/**
 * Wrap a handler so it accepts either the owner's Ride session (all scopes) or
 * a personal access token that carries `scope`.
 */
export function scoped(scope, handler) {
  if (!TOKEN_SCOPES.includes(scope)) throw new Error(`Unknown token scope: ${scope}`);
  return async (context) => {
    const { request, env } = context;
    const secret = presentedPat(request);
    if (!secret) {
      const authResult = await requireAuth(context);
      if (authResult instanceof Response) return authResult;
      const csrf = sameOriginWrite(context);
      if (csrf) return csrf;
      return handler(context);
    }

    const failure = await authenticatePat(context, secret, scope);
    if (failure) return withoutCors(failure);
    let response;
    try {
      response = await handler(context);
    } catch (error) {
      console.error('Token request failed:', error?.message || error);
      response = errorResponse('Internal server error', 500);
    }
    const method = request.method.toUpperCase();
    if (WRITE_METHODS.has(method)) {
      await audit(env, {
        tokenId: context.apiToken.id, userId: context.user.id, method,
        route: (context.url || new URL(request.url)).pathname, status: response.status
      });
    }
    return withoutCors(response);
  };
}

/** Token management is for a signed-in Ride session only: no Authorization header at all. */
async function requireOwnerSession(context) {
  const refused = () => errorResponse('Access tokens can only be managed from a signed-in Ride session', 403);
  if (presentedPat(context.request)) return refused();
  const authResult = await requireAuth(context);
  if (authResult instanceof Response) return authResult;
  // A valid session sent as a Bearer header is still not the browser cookie.
  if (context.request.headers.get('Authorization')) return refused();
  return sameOriginWrite(context);
}

function parseExpiryDays(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_EXPIRY_DAYS;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > MAX_EXPIRY_DAYS) return null;
  return days;
}

export const ApiTokensHandler = {
  async list(context) {
    const denied = await requireOwnerSession(context);
    if (denied) return denied;
    const rows = await context.env.RIDE_TRIP_PLANNER_DB.prepare(
      `SELECT id, name, token_hint, scopes, created_at, last_used_at, expires_at, revoked_at
       FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC LIMIT 200`
    ).bind(context.user.id).all();
    return jsonResponse({ tokens: (rows.results || []).map(publicToken), scopes: TOKEN_SCOPES });
  },

  async create(context) {
    const denied = await requireOwnerSession(context);
    if (denied) return denied;
    const { env, user, request } = context;
    const body = await parseBody(request);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return errorResponse('A JSON object is required');

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 80) return errorResponse('Token name is required (max 80 characters)');
    if (!Array.isArray(body.scopes) || !body.scopes.length || body.scopes.some(scope => !TOKEN_SCOPES.includes(scope))) {
      return errorResponse(`Choose at least one scope from: ${TOKEN_SCOPES.join(', ')}`);
    }
    const scopes = TOKEN_SCOPES.filter(scope => body.scopes.includes(scope));
    const days = parseExpiryDays(body.expires_in_days);
    if (days === null) return errorResponse(`expires_in_days must be a whole number from 1 to ${MAX_EXPIRY_DAYS}`);

    const active = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?'
    ).bind(user.id, nowIso()).first();
    if (Number(active?.n || 0) >= MAX_ACTIVE_TOKENS) return errorResponse(`You can have at most ${MAX_ACTIVE_TOKENS} active tokens. Revoke one first.`, 409);

    const id = generateId();
    const secret = generateTokenSecret();
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + days * 86400000).toISOString();
    await env.RIDE_TRIP_PLANNER_DB.prepare(
      `INSERT INTO api_tokens (id, user_id, name, token_hash, token_hint, scopes, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, user.id, name, await sha256Hex(secret), secret.slice(0, TOKEN_PREFIX.length + 4), JSON.stringify(scopes), createdAt, expiresAt).run();
    await audit(env, { tokenId: id, userId: user.id, method: 'CREATE', route: '/api/tokens', status: 201 });

    const row = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT id, name, token_hint, scopes, created_at, last_used_at, expires_at, revoked_at FROM api_tokens WHERE id = ? AND user_id = ?'
    ).bind(id, user.id).first();
    return jsonResponse({
      token: publicToken(row),
      secret,
      notice: 'Copy this token now. Ride stores only a hash and cannot show it again.'
    }, 201);
  },

  async revoke(context) {
    const denied = await requireOwnerSession(context);
    if (denied) return denied;
    const { env, user, params } = context;
    const row = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT id, revoked_at FROM api_tokens WHERE id = ? AND user_id = ?'
    ).bind(params.id, user.id).first();
    if (!row) return errorResponse('Token not found', 404);
    if (!row.revoked_at) {
      await env.RIDE_TRIP_PLANNER_DB.prepare(
        'UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL'
      ).bind(nowIso(), params.id, user.id).run();
      await audit(env, { tokenId: params.id, userId: user.id, method: 'REVOKE', route: `/api/tokens/${params.id}`, status: 200 });
    }
    const updated = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT id, name, token_hint, scopes, created_at, last_used_at, expires_at, revoked_at FROM api_tokens WHERE id = ? AND user_id = ?'
    ).bind(params.id, user.id).first();
    return jsonResponse({ token: publicToken(updated) });
  }
};
