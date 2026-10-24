import { test, expect, TRIP, TRIP_ID } from './fixtures.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Walks every phone surface (planner views, modals, side menu, ride mode, shared
// trip page, static pages) at 360 / 390 / 412 px wide with deliberately awkward
// invented data (long names, many stops) and fails on layout faults: sideways
// scroll, overlapping text, undersized tap targets, clipped text, modals that do
// not fit the screen. Set SURFACE_SHOTS=<dir> to also save a screenshot of each.
//
//   SURFACE_SHOTS=C:\path\to\before npx playwright test e2e/mobile/surfaces.spec.mjs --project=pixel-7
//
// All data below is invented.

const SIZES = [[360, 800], [390, 800], [412, 800], [360, 600]]; // the last is a short phone or one with the keyboard half open
const SHOTS = process.env.SURFACE_SHOTS || '';

const LONG = 'Extraordinarily Long Invented Place Name Crossing The Great Dividing Range Lookout And Caravan Park (invented)';
const TYPES = ['start', 'scenic', 'fuel', 'camp', 'stop', 'end'];
const waypoints = Array.from({ length: 24 }, (_, i) => ({
  id: `wp-${i + 1}`,
  name: i % 3 === 0 ? `${i + 1}. ${LONG}` : i % 3 === 1 ? `Stop ${i + 1}: Yellowbox Roadhouse (invented)` : `S${i + 1}`,
  lat: -33.42 + i * 0.07, lng: 149.58 + i * 0.05,
  type: TYPES[i % TYPES.length], sort_order: i,
  notes: i % 4 === 0 ? 'A long invented note that goes on and on about the unsealed road, the creek crossing and the particularly unremarkable pie. '.repeat(2) : '',
}));
const stops = waypoints.slice(0, 7).map((w, i) => ({ id: `stop-${w.id}`, waypointId: w.id, name: w.name, plannedNights: i === 6 ? 0 : 1 + (i % 2), minNights: 0 }));
const HEAVY = {
  ...TRIP,
  name: `Invented ${LONG}`,
  waypoints,
  journal: Array.from({ length: 10 }, (_, i) => ({
    id: `j-${i}`, title: i % 2 ? `Entry with a very long invented title that would never fit on one line ${i}` : `Day ${i}`,
    content: 'Invented journal text. '.repeat(i % 3 ? 20 : 2), created_at: new Date(Date.UTC(2026, 9, 10 + i)).toISOString(),
    is_private: i % 2, tags: '["fuel","scenic"]', waypoint_id: waypoints[i].id,
  })),
  settings: JSON.stringify({ itinerary: { version: 1, startDate: '2026-11-02', currency: 'AUD', fuel: { litresPer100Km: 10.5, pricePerLitre: 2.8 }, stops } }),
};

// In-page audit. Returns a list of plain-text findings.
function audit(opts) {
  const issues = [];
  const vw = window.innerWidth, vh = window.innerHeight;
  const root = opts.root ? document.querySelector(opts.root) : document.body;
  const label = el => {
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    const txt = (el.textContent || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 24);
    return `${el.tagName.toLowerCase()}${id}${cls}${txt ? ` "${txt}"` : ''}`;
  };
  const visible = el => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  // Shown to the user: not hidden by an ancestor and not covered at its centre.
  const onTop = (el, r) => {
    const x = Math.min(Math.max(r.left + r.width / 2, 0), vw - 1), y = Math.min(Math.max(r.top + r.height / 2, 0), vh - 1);
    const hit = document.elementFromPoint(x, y);
    return !!hit && (el.contains(hit) || hit.contains(el));
  };
  const skip = el => el.closest('.leaflet-tile-pane, .leaflet-control-attribution, .leaflet-marker-pane, .sr-only, [aria-hidden="true"], script, style') || (opts.ignore && el.closest(opts.ignore));

  // 1. Sideways scroll.
  const over = document.documentElement.scrollWidth - document.documentElement.clientWidth;
  if (over > 0) issues.push(`overflow-x: page is ${over}px wider than the screen`);

  // 2. Tap targets.
  root.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button]').forEach(el => {
    if (skip(el) || !visible(el)) return;
    if (el.matches('a') && el.closest('p, li, .crafted-text, .open-source-links, footer, .legal, .about-content, .menu-footer, .modal-subtitle, .field-hint, small')) return; // inline text links
    if (el.matches('input[type=checkbox], input[type=radio]')) return; // sized by their label row
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) return;
    if (!onTop(el, r)) return;
    if (r.width < 43.5 || r.height < 43.5) issues.push(`tap: ${label(el)} is ${Math.round(r.width)}x${Math.round(r.height)}`);
  });

  // 3. Text boxes: overlap and off-screen.
  const boxes = [];
  const walker = document.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.textContent.trim()) continue;
    const el = n.parentElement;
    if (!el || skip(el) || !visible(el) || el.closest('option, textarea')) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    for (const raw of range.getClientRects()) {
      if (raw.width < 2 || raw.height < 4) continue;
      // Clip the text box to every scrolling/overflow-hidden ancestor (ellipsis, scroll lists).
      let r = { left: raw.left, right: raw.right, top: raw.top, bottom: raw.bottom }, gone = false;
      for (let a = el; a && a !== document.body; a = a.parentElement) {
        const st = getComputedStyle(a);
        if (/(hidden|clip|auto|scroll)/.test(st.overflowX + st.overflowY)) {
          const ar = a.getBoundingClientRect();
          r = { left: Math.max(r.left, ar.left), right: Math.min(r.right, ar.right), top: Math.max(r.top, ar.top), bottom: Math.min(r.bottom, ar.bottom) };
          if (r.right - r.left < 1 || r.bottom - r.top < 1) { gone = true; break; }
        }
      }
      if (gone) continue;
      r = { ...r, width: r.right - r.left, height: r.bottom - r.top };
      if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) continue;
      if (!onTop(el, { left: Math.max(r.left, 0), top: Math.max(r.top, 0), width: Math.min(r.width, vw), height: Math.min(r.height, vh), }) ) continue;
      boxes.push({ el, left: r.left, right: r.right, top: r.top, bottom: r.bottom });
      if (r.right > vw + 1 || r.left < -1) issues.push(`offscreen: text of ${label(el)} runs to ${Math.round(r.left)}..${Math.round(r.right)} of ${vw}`);
    }
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (w > 3 && h > 4) issues.push(`overlap: ${label(a.el)} over ${label(b.el)} (${Math.round(w)}x${Math.round(h)})`);
    }
  }

  // 3b. Text squeezed into a sliver (a long name wrapped word by word).
  root.querySelectorAll('*').forEach(el => {
    if (skip(el) || !visible(el)) return;
    const own = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
    if (own.length < 24) return;
    const r = el.getBoundingClientRect();
    if (r.width < 110 && r.width < vw * 0.4) issues.push(`squeezed: ${label(el)} is only ${Math.round(r.width)}px wide`);
  });

  // 4. Clipped text: overflow hidden without an ellipsis (or line clamp).
  root.querySelectorAll('*').forEach(el => {
    if (skip(el) || !visible(el)) return;
    const s = getComputedStyle(el);
    if (!/(hidden|clip)/.test(s.overflowX)) return;
    if (s.textOverflow === 'ellipsis' || s.webkitLineClamp !== 'none' && s.webkitLineClamp) return;
    if (el.matches('.leaflet-container, .leaflet-pane, .leaflet-map-pane, html, body, #app, .map-container')) return;
    if (el.scrollWidth > el.clientWidth + 1 && el.children.length === 0 && el.textContent.trim()) issues.push(`clipped: ${label(el)} content ${el.scrollWidth} > box ${el.clientWidth}`);
    // Flex/grid parents whose text children spill out.
    else if (el.scrollWidth > el.clientWidth + 2 && el.textContent.trim()) issues.push(`spill: ${label(el)} content ${el.scrollWidth} > box ${el.clientWidth}`);
  });

  // 5. Dialogs must fit the screen.
  if (opts.fit) {
    const el = document.querySelector(opts.fit);
    if (el) {
      const r = el.getBoundingClientRect();
      if (r.left < -0.5 || r.right > vw + 0.5 || r.top < -0.5 || r.bottom > vh + 0.5) issues.push(`fit: ${opts.fit} is ${Math.round(r.left)},${Math.round(r.top)} to ${Math.round(r.right)},${Math.round(r.bottom)} on ${vw}x${vh}`);
      const nav = document.getElementById('bottomNav');
      if (nav && visible(nav) && opts.fit !== '#bottomNav') {
        const n = nav.getBoundingClientRect();
        const z = +getComputedStyle(el.closest('.modal, .panel, #sideMenu') || el).zIndex || 0;
        const nz = +getComputedStyle(nav).zIndex || 0;
        if (r.bottom > n.top + 1 && z <= nz && !opts.allowUnderNav) issues.push(`fit: ${opts.fit} bottom ${Math.round(r.bottom)} runs under the bottom nav (top ${Math.round(n.top)})`);
      }
    }
  }
  return issues;
}

const slug = s => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();

async function openHeavy(page, apiState, trip = HEAVY) {
  apiState.trip = structuredClone(trip);
  await page.goto(`/?openTrip=${TRIP_ID}`);
  await expect(page.locator('#authGate')).toBeHidden();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(400);
}

async function view(page, name) {
  await page.locator(`#bottomNav [data-view="${name}"]`).click();
  await page.waitForTimeout(250);
}

// Show a statically declared dialog without clicking through its trigger.
async function showModal(page, id) {
  await page.evaluate(sel => {
    document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
    const el = document.querySelector(sel);
    el.classList.remove('hidden');
    el.removeAttribute('hidden');
  }, `#${id}`);
  await page.waitForTimeout(600);
}

const MODALS = [
  'waypointModal', 'waypointDetailsModal', 'placeSearchModal', 'noteModal', 'shareModal', 'loginModal',
  'tripDetailsModal', 'settingsModal', 'waypointsHelpModal', 'waypointPositionModal', 'tripConflictModal',
  'savedPlaceModal', 'fuelFillModal', 'accessTokensModal', 'itineraryPreviewModal',
];

test.describe('every phone surface is laid out cleanly', () => {
  test.skip(({ browserName, isMobile }) => browserName !== 'chromium' || !isMobile, 'chromium phone only');

  for (const [width, height] of SIZES) {
    test(`surfaces at ${width}x${height}`, async ({ page, apiState }, info) => {
      test.setTimeout(240_000);
      if (info.project.name !== 'pixel-7') test.skip(true, 'one phone project is enough; widths are set explicitly');
      await page.setViewportSize({ width, height });
      const dir = SHOTS ? join(SHOTS, height === 800 ? String(width) : `${width}x${height}`) : '';
      if (dir) mkdirSync(dir, { recursive: true });
      const found = [];
      const check = async (name, opts = {}) => {
        if (dir) await page.screenshot({ path: join(dir, `${slug(name)}.png`) });
        const issues = await page.evaluate(audit, opts);
        for (const issue of new Set(issues)) found.push(`[${width}] ${name}: ${issue}`);
      };

      await openHeavy(page, apiState);
      await check('map-header');
      await page.locator('#menuBtn').click();
      await page.waitForTimeout(300);
      await check('side-menu', { fit: '#sideMenu' });
      await page.locator('#closeMenu').click();
      await page.waitForTimeout(250);

      // Route choice bar, as it looks when alternatives exist.
      await page.evaluate(() => {
        const bar = document.getElementById('routeChoiceBar');
        bar.classList.remove('hidden'); bar.style.display = '';
        document.getElementById('routeChoiceOptions').innerHTML = ['Fastest 4h 20m', 'Scenic 5h 05m', 'Avoid unsealed 6h 40m'].map((t, i) => `<button type="button" class="route-choice-option${i ? '' : ' active'}">${t}</button>`).join('');
      });
      await check('map-route-choice');
      await page.evaluate(() => { const bar = document.getElementById('routeChoiceBar'); bar.classList.add('hidden'); bar.style.display = 'none'; });

      for (const name of ['waypoints', 'journal', 'itinerary', 'trips']) {
        await view(page, name);
        await check(name, { fit: name === 'itinerary' ? '#itineraryPanel' : `#${name}Panel`, allowUnderNav: true });
        await page.evaluate(() => document.querySelectorAll('.panel-content, .waypoints-panel-body').forEach(e => { e.scrollTop = e.scrollHeight; }));
        await page.waitForTimeout(600);
        await check(`${name}-scrolled`, { allowUnderNav: true });
      }

      // Itinerary without dates.
      await openHeavy(page, apiState, { ...HEAVY, settings: '{}' });
      await view(page, 'itinerary');
      await check('itinerary-empty');

      // Empty trip: no waypoints, no journal.
      await openHeavy(page, apiState, { ...HEAVY, name: 'New Trip', waypoints: [], journal: [], settings: '{}' });
      await check('map-empty-trip');
      for (const name of ['waypoints', 'journal', 'itinerary']) { await view(page, name); await check(`${name}-empty`); }
      await view(page, 'map');

      // Dialogs (re-open the heavy trip so lists behind them are full).
      await openHeavy(page, apiState);
      for (const id of MODALS) {
        await showModal(page, id);
        await check(id, { root: `#${id}`, fit: `#${id} .modal-content` });
      }
      await page.evaluate(() => document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden')));

      // Real flows that build their own markup.
      await page.locator('#shareBtn').click();
      await page.waitForTimeout(250);
      await check('share-real', { root: '#shareModal', fit: '#shareModal .modal-content' });
      await page.evaluate(() => document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden')));
      await page.locator('#userBtn').click();
      await page.waitForTimeout(250);
      await check('account-real');
      await page.evaluate(() => document.querySelectorAll('.user-dropdown').forEach(d => d.classList.add('hidden')));
      await page.evaluate(() => document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden')));

      // Places panel and ride mode.
      await page.evaluate(() => { document.getElementById('placesPanel')?.classList.remove('hidden'); });
      await page.waitForTimeout(250);
      await check('places-panel', { root: '#placesPanel', fit: '#placesPanel', allowUnderNav: true });
      await page.evaluate(() => document.getElementById('placesPanel')?.classList.add('hidden'));
      await page.evaluate(() => { document.body.classList.add('ride-mode'); document.getElementById('rideOverlay').classList.remove('hidden'); });
      await page.waitForTimeout(250);
      await check('ride-overlay', { root: '#rideOverlay', fit: '#rideOverlay', allowUnderNav: true });
      await page.evaluate(() => { document.getElementById('rideAddSheet').classList.remove('hidden'); });
      await page.waitForTimeout(250);
      await check('ride-add-sheet', { root: '#rideAddSheet', fit: '#rideAddSheet .ride-action-sheet-content', allowUnderNav: true });

      // Landing and auth gate.
      await page.evaluate(() => { document.body.classList.remove('ride-mode'); document.getElementById('rideOverlay').classList.add('hidden'); document.getElementById('rideAddSheet').classList.add('hidden'); document.getElementById('landingGate').classList.remove('hidden'); });
      await check('landing-gate', { root: '#landingGate', fit: '#landingGate .landing-gate-card' });
      await page.evaluate(() => { document.getElementById('landingGate').classList.add('hidden'); const g = document.getElementById('authGate'); g.classList.remove('hidden'); });
      await check('auth-gate', { root: '#authGate', fit: '#authGate .auth-gate-card' });

      // Shared trip page and static pages.
      const pages = ['/trip.html?test=1', '/about.html', '/privacy.html', '/terms.html', '/deletion.html'];
      for (const path of pages) {
        await page.goto(path);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(500);
        await check(`page-${path}`);
      }
      // Shared trip with long strings, via the public API route.
      await page.route('**/api/s/abc123', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ trip: {
        title: `Invented ${LONG}`, description: 'Invented description. '.repeat(30), short_code: 'abc123', cover_image: null, created_at: '2026-01-15T08:00:00Z',
        share: { includeWaypoints: true, includeRoute: true, includePublicNotes: true, includeGallery: true },
        waypoints, journal: HEAVY.journal.map(j => ({ ...j, is_private: 0 })), attachments: [], route: null,
      } }) }));
      await page.goto('/trip.html?trip=abc123');
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(700);
      await check('page-trip-long-data');
      await page.goto('/trip.html?trip=zzzzzz');
      await page.route('**/api/s/zzzzzz', route => route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
      await page.goto('/trip.html?trip=zzzzzz');
      await page.waitForTimeout(600);
      await check('page-trip-not-found');
      await page.route('**/api/s/privat', route => route.fulfill({ status: 403, contentType: 'application/json', body: '{}' }));
      await page.goto('/trip.html?trip=privat');
      await page.waitForTimeout(600);
      await check('page-trip-private');

      if (dir) writeFileSync(join(dir, 'findings.txt'), found.join(String.fromCharCode(10)));
      expect(found, found.join('\n')).toEqual([]);
    });
  }
});
