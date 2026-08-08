/**
 * Map tile proxy + edge cache.
 *
 * Every basemap tile the app draws — planner and public share page alike —
 * comes through here. Two reasons:
 *
 *   1. The upstream URL templates live in exactly one place (below). Swapping
 *      a provider is a change to this file, not a hunt through the client.
 *   2. Tiles are cached in Cloudflare's edge cache (caches.default) with a long
 *      TTL, so the overwhelming majority of requests never reach upstream. That
 *      matters: the OSM Foundation tile policy explicitly discourages sending
 *      growing app traffic straight at their volunteer-funded servers.
 *
 * Not behind requireAuth — guests and anonymous share-link viewers both need
 * maps — but IP rate-limited by the router (see api/worker.js:
 * rateLimitByIp('tiles', ...)).
 *
 * The z/x/y/style validation below is the security boundary. Coordinates are
 * parsed to integers and substituted into a server-side template, so there is
 * no input path that can make this handler fetch an arbitrary URL.
 */

import { jsonResponse } from './utils.js';

const FETCH_TIMEOUT_MS = 8000;

/** Web-Mercator zoom ceiling. Also the maxZoom the client layers advertise. */
const MAX_ZOOM = 19;

/** 30 days. Used for both the upstream cf.cacheTtl and our own Cache-Control. */
const CACHE_TTL_SECONDS = 2592000;

/**
 * The OSM tile policy requires a User-Agent that identifies the application
 * and offers a way to contact whoever runs it. Sent upstream only.
 */
const UPSTREAM_USER_AGENT = 'Ride/1.0 (+https://ride.incitat.io)';

/**
 * Style allowlist -> upstream template. These three strings are the only place
 * in the codebase that names a tile provider; the client asks for a style name
 * and never learns the upstream URL.
 *
 * Templates use {z}/{x}/{y} placeholders in whatever order the provider wants
 * (ArcGIS is z/y/x) — substitution is by placeholder name, not position.
 */
const TILE_STYLES = {
  street: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  dark: 'https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
  satellite: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
};

/**
 * 1x1 fully transparent PNG, returned as the body of the 502 when upstream
 * fails. Decoded once at module load rather than per error.
 */
const BLANK_TILE_BYTES = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII='),
  (ch) => ch.charCodeAt(0)
);

function badRequest(message) {
  return jsonResponse({ error: { code: 'INVALID_TILE_REQUEST', message } }, 400);
}

/**
 * Upstream failure -> a transparent tile with a 502 status.
 *
 * The PNG body is what stops Leaflet from painting a broken-image glyph over
 * the map: the <img> decodes successfully, so the tile just reads as a gap in
 * the basemap. The 502 status is what stops that gap from sticking around —
 * no-store keeps it out of the browser cache, the service worker's tile cache
 * only stores status 200 (public/sw.js: tilesStaleWhileRevalidate), and we
 * never write it to caches.default. The next pan or zoom retries upstream.
 */
function blankTile() {
  return new Response(BLANK_TILE_BYTES, {
    status: 502,
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

/**
 * Strict non-negative integer, canonical form only ('7' yes, '07' and '1e2'
 * no) so one tile can never occupy two cache entries.
 */
function parseCoord(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,6})$/.test(value)) return null;
  return Number(value);
}

/**
 * The street provider is overridable with a single Worker var,
 * TILE_UPSTREAM_STREET, so the light basemap can move to a commercial provider
 * (MapTiler, Stadia, Thunderforest, ...) with no code change and no redeploy —
 * set it to that provider's template including any API key, e.g.
 * `https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}.png?key=XXXX`.
 * Must be https; anything else is ignored rather than trusted.
 */
function streetTemplate(env) {
  const override = env && env.TILE_UPSTREAM_STREET;
  if (typeof override === 'string' && override.startsWith('https://')) return override;
  if (override) console.error('tiles: ignoring TILE_UPSTREAM_STREET — must be an https:// template.');
  return TILE_STYLES.street;
}

function upstreamTileUrl(env, style, z, x, y) {
  const template = style === 'street' ? streetTemplate(env) : TILE_STYLES[style];
  return template
    .replace(/\{z\}/g, String(z))
    .replace(/\{x\}/g, String(x))
    .replace(/\{y\}/g, String(y));
}

export const TilesHandler = {
  /**
   * GET /api/tiles/:style/:z/:x/:y — one basemap tile.
   *
   * 200 image/* on success (edge-cached), 400 JSON for a malformed request,
   * 502 transparent PNG when upstream can't be reached or answers with
   * something that isn't an image. Never throws — every branch returns a
   * Response.
   */
  async getTile(context) {
    const { env, ctx, params, url } = context;

    // Object.prototype.hasOwnProperty, not a bare `TILE_STYLES[style]` truthy
    // check: a style of 'constructor', 'toString', '__proto__', etc. resolves
    // to an inherited Object.prototype value (truthy) rather than undefined,
    // which would let those strings slip past what is supposed to be a strict
    // allowlist (they'd still 502 rather than fetch anything, since the
    // inherited value has no .replace method for upstreamTileUrl to call — but
    // the allowlist check itself must not be foolable).
    const requestedStyle = params?.style;
    const style = typeof requestedStyle === 'string' && Object.prototype.hasOwnProperty.call(TILE_STYLES, requestedStyle)
      ? requestedStyle
      : null;
    if (!style) return badRequest('Unknown tile style.');

    const z = parseCoord(params?.z);
    const x = parseCoord(params?.x);
    const y = parseCoord(params?.y);
    if (z === null || x === null || y === null) {
      return badRequest('z, x and y must be non-negative integers.');
    }
    if (z > MAX_ZOOM) return badRequest(`z must be between 0 and ${MAX_ZOOM}.`);
    const axisTiles = 2 ** z; // the Web-Mercator grid is 2^z tiles per axis
    if (x >= axisTiles || y >= axisTiles) {
      return badRequest('x and y are out of range for this zoom level.');
    }

    // Cache key is the canonical validated path and nothing else — no query
    // string, no cookies, no Vary — so every viewer of a tile shares one entry.
    const cacheKey = new Request(`${url.origin}/api/tiles/${style}/${z}/${x}/${y}`, { method: 'GET' });

    let cached = null;
    try {
      cached = await caches.default.match(cacheKey);
    } catch (err) {
      // Cache trouble must never cost us the tile — fall through to upstream.
      console.error('tiles: cache lookup failed:', err?.message || err);
    }
    if (cached) return cached;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let upstream;
    try {
      upstream = await fetch(upstreamTileUrl(env, style, z, x, y), {
        headers: {
          'User-Agent': UPSTREAM_USER_AGENT,
          Accept: 'image/avif,image/webp,image/png,image/jpeg,*/*'
        },
        signal: controller.signal,
        // Second cache layer: Cloudflare also caches the subrequest itself, so
        // a colo that missed caches.default still usually avoids upstream.
        cf: { cacheEverything: true, cacheTtl: CACHE_TTL_SECONDS }
      });
    } catch (err) {
      console.error(`tiles: upstream fetch failed for ${style}/${z}/${x}/${y}:`, err?.message || err);
      return blankTile();
    } finally {
      clearTimeout(timer);
    }

    // A provider that answers 200 with an HTML error page must not get cached
    // as a tile, so the content type is checked as well as the status.
    const contentType = upstream.headers.get('content-type') || '';
    if (!upstream.ok || !contentType.startsWith('image/')) {
      console.error(`tiles: upstream returned ${upstream.status} (${contentType || 'no content-type'}) for ${style}/${z}/${x}/${y}`);
      return blankTile();
    }

    // Fresh headers rather than upstream's — no Set-Cookie, no Vary, no
    // provider-specific caching directives leaking into our cache entry.
    const response = new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        // Tiles are effectively immutable. A month of immutable caching is the
        // whole point of the proxy; OSM re-renders land in the next window.
        'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}, s-maxage=${CACHE_TTL_SECONDS}, immutable`,
        'X-Content-Type-Options': 'nosniff'
      }
    });

    try {
      const put = caches.default.put(cacheKey, response.clone()).catch((err) => {
        console.error('tiles: cache put failed:', err?.message || err);
      });
      if (ctx?.waitUntil) ctx.waitUntil(put); else await put;
    } catch (err) {
      console.error('tiles: cache put failed:', err?.message || err);
    }

    return response;
  }
};
