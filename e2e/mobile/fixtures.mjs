import { test as base, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// 10:00 AEDT, Sunday 18 Oct 2026.
export const FIXED_NOW = new Date('2026-10-17T23:00:00Z');
export const TEST_GEO = { latitude: -33.42, longitude: 149.58 };
export const TRIP_ID = 'e2e-trip-0001';

// Everything below is invented test data. Never paste a real trip here.
export const USER = { id: 'e2e-user-0001', name: 'Test Rider', email: 'rider@example.invalid' };

const iso = minutesAgo => new Date(FIXED_NOW.getTime() - minutesAgo * 60_000).toISOString();

export const TRIP = {
  id: TRIP_ID,
  name: 'Invented Tablelands Loop',
  description: 'Test fixture trip.',
  created_at: iso(60 * 24 * 10),
  updated_at: iso(90),
  is_public: 0,
  settings: '{}',
  version: 3,
  waypoints: [
    { id: 'wp-1', name: 'Start: Kurrajong Gap (invented)', lat: -33.42, lng: 149.58, type: 'start', sort_order: 0, notes: '' },
    { id: 'wp-2', name: 'Lookout: Granite Bluff (invented)', lat: -33.1, lng: 149.9, type: 'scenic', sort_order: 1, notes: 'Short walk to the edge.' },
    { id: 'wp-3', name: 'Fuel: Yellowbox Roadhouse (invented)', lat: -32.85, lng: 150.2, type: 'fuel', sort_order: 2, notes: '' },
    { id: 'wp-4', name: 'Camp: Stringybark Creek (invented)', lat: -32.6, lng: 150.55, type: 'camp', sort_order: 3, notes: 'Unpowered sites.' },
  ],
  journal: [
    { id: 'j-1', title: 'Morning at the gap', content: 'Invented entry for tests.', created_at: iso(180), is_private: 0, tags: '[]', waypoint_id: 'wp-1' },
    { id: 'j-2', title: 'Packed the night before', content: 'Another invented entry.', created_at: iso(60 * 24 * 3), is_private: 1, tags: '[]' },
  ],
  attachments: [],
  route: null,
};

const PLACES = Array.from({ length: 8 }, (_, i) => ({
  name: `Invented Bakery ${i + 1}`,
  address: `${i + 10} Example Road, Test Town NSW`,
  rating: 4 + (i % 10) / 10,
  location: { lat: -33.42 + i * 0.01, lng: 149.58 + i * 0.01 },
}));

// 1x1 light grey PNG for every map tile, so screenshots are stable offline.
const BLANK_TILE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN4+P/tfwAJYAPqGpgyNgAAAABJRU5ErkJggg==', 'base64');

const LEAFLET = {
  'leaflet@1.9.4/dist/leaflet.js': 'leaflet/dist/leaflet.js',
  'leaflet@1.9.4/dist/leaflet.css': 'leaflet/dist/leaflet.css',
  'leaflet-routing-machine@3.2.12/dist/leaflet-routing-machine.min.js': 'leaflet-routing-machine/dist/leaflet-routing-machine.min.js',
  'leaflet-routing-machine@3.2.12/dist/leaflet-routing-machine.css': 'leaflet-routing-machine/dist/leaflet-routing-machine.css',
};

/** Google polyline encoding (precision 5), as OSRM returns it. */
function encodePolyline(points) {
  let out = '', lastLat = 0, lastLng = 0;
  const enc = value => { let v = value < 0 ? ~(value << 1) : value << 1, s = ''; while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
  for (const [lat, lng] of points) {
    const la = Math.round(lat * 1e5), ln = Math.round(lng * 1e5);
    out += enc(la - lastLat) + enc(ln - lastLng);
    lastLat = la; lastLng = ln;
  }
  return out;
}

/** A straight-line OSRM v1 answer between the requested points, so routing works offline. */
function osrmAnswer(route) {
  const url = new URL(route.request().url());
  const coords = decodeURIComponent(url.pathname.split('/').pop()).split(';').map(pair => pair.split(',').map(Number)); // [lng, lat]
  const legs = coords.slice(1).map((to, i) => {
    const from = coords[i];
    const km = Math.hypot(to[0] - from[0], to[1] - from[1]) * 100;
    const distance = Math.round(km * 1000), duration = Math.round(km * 45);
    const step = (type, a, b, d, t) => ({ maneuver: { type, modifier: 'straight', location: a, bearing_before: 0, bearing_after: 0 }, name: 'Example Road', mode: 'driving', distance: d, duration: t, weight: t, geometry: encodePolyline([[a[1], a[0]], [b[1], b[0]]]), intersections: [] });
    return { summary: 'Example Road', distance, duration, weight: duration, steps: [step('depart', from, to, distance, duration), step('arrive', to, to, 0, 0)] };
  });
  const distance = legs.reduce((sum, leg) => sum + leg.distance, 0), duration = legs.reduce((sum, leg) => sum + leg.duration, 0);
  return route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ code: 'Ok', routes: [{ legs, distance, duration, weight: duration, weight_name: 'routability' }], waypoints: coords.map(location => ({ location, name: '' })) }),
  });
}

function apiAnswer(route, { signedIn, apiCalls, state }) {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname.replace(/^\/api/, '');
  const method = request.method();
  apiCalls.push({ method, path, search: url.search });
  const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

  if (path === '/auth/me') return signedIn ? json(200, { user: USER }) : json(401, { error: 'Not signed in (test stub)' });
  if (!signedIn) return json(401, { error: 'Not signed in (test stub)' });
  if (path === '/trips' && method === 'GET') {
    const { waypoints: _w, journal: _j, attachments: _a, ...summary } = TRIP;
    return json(200, { trips: [{ ...summary, waypoint_count: TRIP.waypoints.length }] });
  }
  if (path === `/trips/${TRIP_ID}` && method === 'GET') return json(200, { trip: state.trip });
  if (path === `/trips/${TRIP_ID}` && method === 'PUT') {
    if (state.failSaves === 409) return json(409, { error: 'Conflict: trip has changed on another device.', conflict: true, trip_version: state.trip.version, trip_updated_at: state.trip.updated_at });
    if (state.failSaves) return json(state.failSaves, { error: 'Save refused (test stub)' });
    const body = request.postDataJSON() || {};
    state.trip = { ...state.trip, ...body, waypoints: state.trip.waypoints, journal: state.trip.journal, version: state.trip.version + 1, updated_at: FIXED_NOW.toISOString() };
    return json(200, { trip: state.trip });
  }
  if (path.endsWith('/alternatives')) return json(200, { ok: true });
  if (path.endsWith('/ride-logs')) return json(200, { logs: [], next_offset: null });
  if (path.endsWith('/fuel-status')) return json(200, { range: { known: false }, latest_fill: null });
  if (path.endsWith('/fuel-fills')) return json(200, { fills: [] });
  if (path.endsWith('/last-location')) return json(200, { last_location: null });
  if (path === '/saved-places') return json(200, { places: [] });
  if (path === '/tokens') return json(200, { tokens: [] });
  if (path === '/places/search') return json(200, { results: PLACES });
  return json(404, { error: `No test stub for ${method} ${path}` });
}

async function isolateNetwork(page, ctx) {
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
      if (url.pathname.startsWith('/api/')) return apiAnswer(route, ctx);
      return route.continue();
    }
    if (url.hostname === 'unpkg.com') {
      const local = LEAFLET[url.pathname.slice(1)];
      if (local) {
        const body = await readFile(require.resolve(local));
        return route.fulfill({ status: 200, contentType: local.endsWith('.css') ? 'text/css' : 'text/javascript', body });
      }
    }
    if (url.hostname === 'maps.incitat.io' && url.pathname.startsWith('/route/v1/')) return osrmAnswer(route);
    if (/maps\.incitat\.io|tile\.openstreetmap\.org/.test(url.hostname) && /\.png/.test(url.pathname)) {
      return route.fulfill({ status: 200, contentType: 'image/png', body: BLANK_TILE });
    }
    if (url.hostname === 'fonts.googleapis.com') return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    ctx.blockedHosts.push(url.host);
    return route.abort('blockedbyclient');
  });
}

export const test = base.extend({
  // Set `test.use({ signedIn: false })` for the signed-out gate.
  signedIn: [true, { option: true }],
  blockedHosts: async ({}, use) => { await use([]); },
  apiCalls: async ({}, use) => { await use([]); },
  // Server-side copy of the invented trip; set failSaves to an HTTP status to refuse PUTs.
  apiState: async ({}, use) => { await use({ trip: structuredClone(TRIP), failSaves: 0 }); },
  consoleErrors: [async ({ page, signedIn, blockedHosts, apiCalls, apiState, browserName }, use) => {
    const errors = [];
    page.on('console', msg => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      if (/ERR_BLOCKED_BY_CLIENT|blockedbyclient/i.test(text)) return;
      // Playwright's WebKit logs this on any page with a strict style-src,
      // even a blank one (checked 18 Oct 2026, Playwright 1.64.1).
      if (browserName === 'webkit' && /^Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline'/.test(text)) return;
      // The signed-out stub answers 401 on purpose.
      if (!signedIn && /status of 401/.test(text)) return;
      errors.push(text);
    });
    page.on('pageerror', err => errors.push(`pageerror: ${err.message}`));
    // Skip the first-visit landing overlay and the one-off Waypoints help.
    await page.addInitScript(() => {
      try { localStorage.setItem('ride_landing_seen', '1'); localStorage.setItem('ride_waypoints_help_seen', '1'); } catch (_) { /* ignore */ }
    });
    await page.clock.setFixedTime(FIXED_NOW);
    await isolateNetwork(page, { signedIn, blockedHosts, apiCalls, state: apiState });
    await use(errors);
  }, { auto: true }],
});

export { expect };

/** Opens the planner on the invented trip (owner deep link). */
export async function openTrip(page) {
  await page.goto(`/?openTrip=${TRIP_ID}`);
  await expect(page.locator('#tripTitle')).toHaveText(TRIP.name);
  await expect(page.locator('#authGate')).toBeHidden();
}

/** Planner -> Waypoints -> Search (opens the Google Places search modal). */
export async function openPlaceSearch(page) {
  await openTrip(page);
  await showView(page, 'waypoints');
  await page.locator('#searchWaypointPlaceBtn').click();
  await expect(page.locator('#placeSearchModal')).toBeVisible();
  await expect(page.locator('#placeSearchInput')).toBeFocused();
}

export async function showView(page, view) {
  await page.locator(`#bottomNav [data-view="${view}"]`).click();
}

export async function horizontalOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

export async function smallTapTargets(page, selector, min = 44) {
  return page.$$eval(selector, (els, min) => els
    .filter(el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; })
    .map(el => { const r = el.getBoundingClientRect(); return { el, w: Math.round(r.width), h: Math.round(r.height) }; })
    .filter(({ w, h }) => w < min || h < min)
    .map(({ el, w, h }) => `${el.tagName.toLowerCase()}#${el.id || String(el.className).split(' ')[0]} "${(el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30)}" ${w}x${h}`), min);
}

export async function openVirtualKeyboard(page, fraction = 0.55) {
  const vp = page.viewportSize();
  const shrunk = { width: vp.width, height: Math.round(vp.height * fraction) };
  await page.setViewportSize(shrunk);
  return shrunk;
}

export async function isInViewport(page, selector, minVisiblePx = 24) {
  return page.$eval(selector, (el, minVisiblePx) => {
    const r = el.getBoundingClientRect();
    const vv = window.visualViewport;
    const top = vv ? vv.offsetTop : 0;
    const bottom = top + (vv ? vv.height : window.innerHeight);
    return Math.min(r.bottom, bottom) - Math.max(r.top, top) >= Math.min(minVisiblePx, r.height);
  }, minVisiblePx);
}
