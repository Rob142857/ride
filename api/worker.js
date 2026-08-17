/**
 * Ride Trip Planner - Cloudflare Worker API
 * Handles authentication, trip data CRUD, and file attachments
 * Domain: ride.incitat.io
 */

import { Router } from './router.js';
import { AuthHandler } from './auth.js';
import { TripsHandler } from './trips.js';
import { WaypointsHandler } from './waypoints.js';
import { JournalHandler } from './journal.js';
import { AttachmentsHandler } from './attachments.js';
import { ShareHandler } from './share.js';
import { AccountHandler } from './account.js';
import { PlacesHandler } from './places.js';
import { RideLogsHandler } from './ride-logs.js';
import { GhHandler } from './gh.js';
import { TilesHandler } from './tiles.js';
import { cors, jsonResponse, errorResponse, requireAuth, requireAdminUser, optionalAuth, rateLimitByIp, rateLimitByUser, checkRateLimit, BASE_URL } from './utils.js';

// Build fingerprint — changes on every deploy. Used by service worker and client
// to detect code updates and trigger cache invalidation + seamless reload.
// Updated automatically by deploy script, or manually before shipping.
const BUILD_ID = '2026-08-17T01';

const router = new Router();

// CORS preflight
router.options('*', () => cors());

// Auth routes (rate limited per IP — cheap KV counters, fail open)
router.get('/api/auth/login/:provider', rateLimitByIp('auth', 20), AuthHandler.initiateLogin);
router.get('/api/auth/callback/:provider', rateLimitByIp('auth', 20), AuthHandler.handleCallback);
router.get('/api/auth/me', requireAuth, AuthHandler.getCurrentUser);
router.post('/api/auth/logout', AuthHandler.logout);
router.get('/api/admin/stats', requireAdminUser, AuthHandler.adminStats);
router.get('/api/admin/users', requireAdminUser, AuthHandler.listUsersAdmin);
router.get('/api/admin/logins', requireAdminUser, AuthHandler.listLoginsAdmin);
router.get('/api/admin/share-views', requireAdminUser, AuthHandler.listShareViewsAdmin);
router.get('/api/admin/users/:id/audit', requireAdminUser, AuthHandler.auditUser);
router.post('/api/admin/users/:id/status', requireAdminUser, AuthHandler.setUserStatus);
router.post('/api/admin/users/:id/notes', requireAdminUser, AuthHandler.addAdminNote);
router.put('/api/admin/users/:id/notes/:noteId', requireAdminUser, AuthHandler.updateAdminNote);
router.get('/api/admin/places-usage', requireAdminUser, PlacesHandler.usageStats);

// Trip routes (protected)
// NOTE: literal routes MUST be registered before parameterized ones — the
// router matches in registration order and `:id` happily matches literals
// like "versions" (that shadowing bug made /api/trips/versions a permanent 404).
router.get('/api/trips', requireAuth, TripsHandler.listTrips);
router.post('/api/trips', requireAuth, TripsHandler.createTrip);

// Trip version check — returns just id+version for the current user's trips.
// Used by the client to poll for stale data without fetching full trip payloads.
router.get('/api/trips/versions', requireAuth, async (context) => {
  const { env, user } = context;
  const rows = await env.RIDE_TRIP_PLANNER_DB.prepare(
    'SELECT id, version, updated_at FROM trips WHERE user_id = ?'
  ).bind(user.id).all();
  return jsonResponse({ trips: rows.results });
});

router.get('/api/trips/:id', requireAuth, TripsHandler.getTrip);
router.put('/api/trips/:id', requireAuth, TripsHandler.updateTrip);
router.delete('/api/trips/:id', requireAuth, TripsHandler.deleteTrip);

// Alternative routes for a trip (protected)
router.get('/api/trips/:id/alternatives', requireAuth, TripsHandler.listAlternativeRoutes);
router.put('/api/trips/:id/alternatives', requireAuth, TripsHandler.saveAlternativeRoutes);

// Ride logs (actual GPS tracks) for a trip (protected)
router.post('/api/trips/:tripId/ride-logs', requireAuth, RideLogsHandler.saveRideLog);
router.get('/api/trips/:tripId/ride-logs', requireAuth, RideLogsHandler.listRideLogs);

// Waypoint routes (protected)
// "reorder" is registered before ":id" so the literal route is reachable.
router.post('/api/trips/:tripId/waypoints', requireAuth, WaypointsHandler.addWaypoint);
router.put('/api/trips/:tripId/waypoints/reorder', requireAuth, WaypointsHandler.reorderWaypoints);
router.put('/api/trips/:tripId/waypoints/:id', requireAuth, WaypointsHandler.updateWaypoint);
router.delete('/api/trips/:tripId/waypoints/:id', requireAuth, WaypointsHandler.deleteWaypoint);

// Places search (protected to limit API key exposure)
router.get('/api/places/search', requireAuth, PlacesHandler.search);

// GraphHopper routing proxy ("windy" engine) — guests plan trips too, so this
// is NOT behind requireAuth; IP rate-limited instead. See api/gh.js.
router.post('/api/gh/route', rateLimitByIp('gh-route', 60), GhHandler.planRoute);

// Map tile proxy + edge cache — same reasoning as gh/route: guests and
// anonymous share-link viewers both need maps, so no requireAuth, IP rate limit
// instead. The ceiling is far higher than any other bucket because one viewport
// is ~20-30 tiles and a pan/zoom burst is several viewports; 600/min leaves a
// real user (or a NAT'd household) untouched while capping a scraper. Most
// requests are answered from caches.default, so the limiter is the expensive
// part of a cache hit — see api/tiles.js.
router.get('/api/tiles/:style/:z/:x/:y', rateLimitByIp('tiles', 600), TilesHandler.getTile);

// Journal routes (protected)
router.post('/api/trips/:tripId/journal', requireAuth, JournalHandler.addJournalEntry);
router.put('/api/trips/:tripId/journal/:id', requireAuth, JournalHandler.updateJournalEntry);
router.delete('/api/trips/:tripId/journal/:id', requireAuth, JournalHandler.deleteJournalEntry);

// Attachment routes (protected for upload/modify, public for viewing public attachments)
// Upload is the one endpoint that writes billable bytes to R2 — throttle it.
router.post('/api/trips/:tripId/attachments', requireAuth, rateLimitByUser('upload', 30), AttachmentsHandler.uploadAttachment);
router.get('/api/attachments/:id', optionalAuth, AttachmentsHandler.getAttachment);
router.put('/api/attachments/:id', requireAuth, AttachmentsHandler.updateAttachment);
router.delete('/api/attachments/:id', requireAuth, AttachmentsHandler.deleteAttachment);

// Account/data routes — maximally destructive, so tightly throttled.
router.post('/api/user/purge', requireAuth, rateLimitByUser('purge', 3), AccountHandler.deleteAllUserData);

// Share routes 
router.post('/api/trips/:id/share', requireAuth, ShareHandler.generateShareLink);

// Short URL public trip API: /api/s/abc123 -> trip JSON data
// Rate limited per IP — this is the one unauthenticated read of user content,
// so it is also the surface an enumerator would hammer.
router.get('/api/s/:shortCode', rateLimitByIp('share', 60), ShareHandler.getSharedTrip);

// Deploy sanity-check endpoint (no auth)
// Bump DEPLOY_MARKER when you want to verify a new deploy via curl.
router.get('/api/_deploy', () => {
  const DEPLOY_MARKER = 'deploy-marker:2025-12-27T00:00Z:waypoint-precondition-v1';
  return jsonResponse({ ok: true, marker: DEPLOY_MARKER, now: new Date().toISOString() });
});

// Build version endpoint — lightweight, no auth.
// Clients and service workers poll this to detect code updates. Same-origin
// only: jsonResponse pins Access-Control-Allow-Origin to BASE_URL (the previous
// wildcard let any site fingerprint our deploy cadence) and sets no-store.
router.get('/api/_build', () => jsonResponse({ build: BUILD_ID }));

// 404 for unmatched API routes
router.all('/api/*', () => errorResponse('Not found', 404));

// Regex for valid 6-char short codes (alphanumeric only)
const SHORT_CODE_REGEX = /^\/([a-zA-Z0-9]{6})$/;

/**
 * Escape a string for safe inclusion in an HTML attribute value.
 * Also escapes ' and ` so the result is safe inside single-quoted and
 * (legacy IE) backtick-delimited attributes, not just double-quoted ones.
 *
 * NOTE: `$` deliberately is NOT escaped here. Every consumer passes the result
 * through the *function* form of String.replace (`replace(re, () => value)`),
 * which treats the returned string literally — so `$&`, `$1`, `` $` `` in a
 * trip title can never be re-interpreted as a replacement pattern. Escaping `$`
 * to `$$` here would instead surface a literal double dollar sign in the page.
 */
function escapeAttr(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/`/g, '&#96;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Accept only absolute http(s) URLs for image metadata.
 * `cover_image_url` is free text written by any authenticated user, so it is
 * parsed and re-serialized (which percent-encodes quotes and angle brackets)
 * before it is ever escaped into the page. Anything that is not a plain
 * http(s) URL — javascript:, data:, or a tag-breakout string — is dropped.
 */
function sanitizeImageUrl(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Fetch lightweight trip metadata for OG tag injection (title, description, cover image).
 * Runs a single cheap query — no waypoints/journal/route.
 */
async function getTripMeta(env, shortCode) {
  try {
    const trip = await env.RIDE_TRIP_PLANNER_DB.prepare(
      `SELECT t.id, t.name, t.description, t.public_title, t.public_description,
              t.cover_image_url, t.cover_focus_x, t.cover_focus_y,
              -- 'via' waypoints are route-shaping points and 'leg-break' waypoints are
              -- leg dividers — neither is a stop, so both are excluded from the count.
              (SELECT COUNT(*) FROM waypoints WHERE trip_id = t.id AND COALESCE(type, 'stop') NOT IN ('via', 'leg-break')) AS waypoint_count,
              (SELECT a.id FROM attachments a WHERE a.trip_id = t.id AND a.is_private = 0
                AND a.mime_type LIKE 'image/%'
                ORDER BY a.is_cover DESC, a.created_at DESC LIMIT 1) AS cover_attachment_id,
              rd.distance
       FROM trips t
       LEFT JOIN route_data rd ON rd.trip_id = t.id
       WHERE t.short_code = ? AND t.is_public = 1`
    ).bind(shortCode).first();
    if (!trip) return null;

    const title = trip.public_title || trip.name || 'Trip';
    const description = trip.public_description || trip.description || '';
    const coverUrl = sanitizeImageUrl(trip.cover_image_url)
      || (trip.cover_attachment_id ? `${BASE_URL}/api/attachments/${encodeURIComponent(trip.cover_attachment_id)}` : null);

    // Build a short summary line for OG description
    const parts = [];
    if (trip.waypoint_count > 0) parts.push(`${trip.waypoint_count} stops`);
    if (trip.distance > 0) {
      const km = (trip.distance / 1000).toFixed(0);
      parts.push(`${km} km`);
    }
    const summary = parts.length ? parts.join(' · ') : '';
    const ogDescription = description
      ? (summary ? `${description.slice(0, 200)} — ${summary}` : description.slice(0, 300))
      : (summary || 'Explore this trip on Ride');

    return { tripId: trip.id, title, ogDescription, coverUrl };
  } catch (err) {
    console.error('getTripMeta error:', err);
    return null;
  }
}

/**
 * Log a share link view to the share_views audit table.
 * Fire-and-forget — errors are swallowed so they never block the page render.
 */
function logShareView(env, ctx, request, shortCode, tripId) {
  // Attacker-controlled headers are truncated before they reach D1 — share_views
  // has no length CHECK, so an unthrottled request could otherwise persist
  // several KB of arbitrary text per view.
  const cap = (value, max) => (value || '').slice(0, max);
  const ip = cap(request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for'), 64);
  const userAgent = cap(request.headers.get('user-agent'), 512);
  const referrer = cap(request.headers.get('referer') || request.headers.get('referrer'), 1024);
  const clientHints = JSON.stringify({
    cfCountry: request.headers.get('cf-ipcountry') || undefined,
    uaPlatform: request.headers.get('sec-ch-ua-platform') || undefined,
    uaMobile: request.headers.get('sec-ch-ua-mobile') || undefined,
    acceptLanguage: request.headers.get('accept-language') || undefined,
    cfRay: request.headers.get('cf-ray') || undefined,
  });

  ctx.waitUntil(
    env.RIDE_TRIP_PLANNER_DB.prepare(
      'INSERT INTO share_views (id, trip_id, short_code, viewer_user_id, viewer_label, ip, user_agent, client_hints, referrer) VALUES (?, ?, ?, NULL, \'external\', ?, ?, ?, ?)'
    ).bind(crypto.randomUUID(), tripId, shortCode, ip, userAgent, clientHints, referrer)
      .run()
      .catch(err => console.error('share_views insert error:', err))
  );
}

/**
 * Inject trip-specific OG/Twitter meta tags into the static trip.html so social
 * crawlers (which don't execute JS) see the real title, description, and cover image.
 */
function injectMetaTags(html, meta, shortCode) {
  // Every injected value is HTML-attribute-escaped, and every replacement uses
  // the function form of String.replace so a `$` in user text is never treated
  // as a replacement pattern.
  const title = escapeAttr(meta.title);
  const desc = escapeAttr(meta.ogDescription);
  const image = escapeAttr(meta.coverUrl || `${BASE_URL}/icons/og-ride.png`);
  const pageUrl = escapeAttr(`${BASE_URL}/${encodeURIComponent(shortCode)}`);

  const setAttr = (source, re, value) => source.replace(re, (_m, prefix, suffix) => `${prefix}${value}${suffix}`);

  html = html.replace(/<title>[^<]*<\/title>/, () => `<title>${title} | Ride</title>`);
  html = setAttr(html, /(<meta\s+name="description"\s+content=")[^"]*(")/, desc);
  html = setAttr(html, /(<meta\s+property="og:title"\s+content=")[^"]*(")/, title);
  html = setAttr(html, /(<meta\s+property="og:description"\s+content=")[^"]*(")/, desc);
  html = setAttr(html, /(<meta\s+property="og:image"\s+content=")[^"]*(")/, image);
  html = setAttr(html, /(<meta\s+property="og:url"\s+content=")[^"]*(")/, pageUrl);
  html = setAttr(html, /(<meta\s+name="twitter:title"\s+content=")[^"]*(")/, title);
  html = setAttr(html, /(<meta\s+name="twitter:description"\s+content=")[^"]*(")/, desc);
  html = setAttr(html, /(<meta\s+name="twitter:image"\s+content=")[^"]*(")/, image);

  return html;
}

// Content Security Policy for HTML responses
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://unpkg.com https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline' https://unpkg.com https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  // Basemap tiles are now same-origin (/api/tiles/... — see api/tiles.js), which
  // 'self' already covers. The tile provider hosts stay listed: the proxy fetches
  // them server-side, but ride-test-page.html still loads them directly.
  "img-src 'self' data: blob: https: https://*.basemaps.cartocdn.com https://*.tile.openstreetmap.org https://server.arcgisonline.com https://ride.incitat.io https://lh3.googleusercontent.com https://*.microsoft.com",
  "connect-src 'self' https://ride.incitat.io https://maps.incitat.io https://unpkg.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self' https://accounts.google.com https://login.microsoftonline.com"
].join('; ');

/**
 * Add security headers to HTML responses
 */
function addSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy', CSP);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(self), geolocation=(self), microphone=()');
  headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  // Build fingerprint lets clients detect code updates
  headers.set('X-Build-ID', BUILD_ID);
  headers.set('ETag', `"${BUILD_ID}"`);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Handle API routes first
    if (url.pathname.startsWith('/api/')) {
      try {
        return await router.handle(request, env, ctx);
      } catch (error) {
        console.error('Worker error:', error);
        return errorResponse('Internal server error', 500);
      }
    }
    
    // Check for root-level short code: ride.incitat.io/abc123
    // Must be exactly 6 alphanumeric characters, no extension
    const shortCodeMatch = url.pathname.match(SHORT_CODE_REGEX);
    if (shortCodeMatch) {
      const shortCode = shortCodeMatch[1];

      // This path runs a DB query and logs a share view, so only the methods
      // that can legitimately render a page are allowed through. Previously a
      // POST to /abc123 ran the full query, inserted a share_views row, and
      // forwarded its method and body into the static asset fetch.
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method Not Allowed', {
          status: 405,
          headers: { Allow: 'GET, HEAD' }
        });
      }

      // Per-IP throttle: share codes are the one unauthenticated surface that
      // both reads user content and writes an audit row. Its own bucket, so a
      // page view (HTML + the client's /api/s call) doesn't spend two tokens.
      const ip = request.headers.get('cf-connecting-ip') || 'unknown';
      if (!(await checkRateLimit(env, 'sharepage', ip, 60))) {
        return new Response('Too many requests', {
          status: 429,
          headers: { 'Retry-After': '60', 'Cache-Control': 'no-store' }
        });
      }

      // Fetch trip metadata for OG tags + existence check in one query
      try {
        const meta = await getTripMeta(env, shortCode);

        if (meta) {
          // Log the share link view (fire-and-forget)
          logShareView(env, ctx, request, shortCode, meta.tripId);

          // Valid short code - serve the trip page with injected OG meta tags
          // Use /trip not /trip.html — Cloudflare assets redirects .html to pretty URLs
          // Always fetch the asset as a plain GET: the incoming method/body must
          // never be forwarded into the asset pipeline.
          const newUrl = new URL('/trip', url.origin);
          newUrl.searchParams.set('trip', shortCode);
          const resp = await env.ASSETS.fetch(new Request(newUrl.toString(), { method: 'GET' }));
          let html = await resp.text();
          html = injectMetaTags(html, meta, shortCode);
          return addSecurityHeaders(new Response(request.method === 'HEAD' ? null : html, {
            status: resp.status,
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
          }));
        }
      } catch (error) {
        console.error('Short code lookup error:', error);
      }

      // Invalid short code - fall through to 404 or static assets
    }
    
    // Legacy support: /t/abc123 redirects to /abc123
    if (url.pathname.match(/^\/t\/[a-zA-Z0-9]{6}$/)) {
      const shortCode = url.pathname.split('/')[2];
      return Response.redirect(`${BASE_URL}/${shortCode}`, 301);
    }
    
    // Legacy support: /trip/abc123 redirects to /abc123
    if (url.pathname.match(/^\/trip\/[a-zA-Z0-9]{6}$/)) {
      const shortCode = url.pathname.split('/')[2];
      return Response.redirect(`${BASE_URL}/${shortCode}`, 301);
    }
    
    // For all other routes, let Pages handle static files (add security headers to HTML)
    const response = await env.ASSETS.fetch(request);
    const ct = response.headers.get('content-type') || '';
    if (ct.includes('text/html')) {
      return addSecurityHeaders(response);
    }
    return response;
  }
};
