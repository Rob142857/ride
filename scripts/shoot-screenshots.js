#!/usr/bin/env node
/**
 * shoot-screenshots.js — regenerate the About-page product screenshots.
 *
 * Drives headless Chrome over the DevTools Protocol (Node 22+ built-in
 * WebSocket, no npm dependencies). Seeds a demo trip into localStorage so the
 * shots show a real planned route, then captures each surface.
 *
 * Usage:  npm start          (serve public/ on :3000, in another terminal)
 *         node scripts/shoot-screenshots.js [baseUrl]
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const BASE = process.argv[2] || 'http://localhost:3000';
const OUT_DIR = path.resolve(__dirname, '..', 'public', 'images', 'product');
const PORT = 9333;

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

const DESKTOP = { width: 1440, height: 900, scale: 2, mobile: false };
const MOBILE = { width: 390, height: 844, scale: 3, mobile: true };

/** Demo trip seeded into guest storage — a real scenic loop with a shape point. */
const DEMO = {
  name: 'Snowy Mountains Loop',
  waypoints: [
    { name: 'Jindabyne', lat: -36.4159, lng: 148.6216, type: 'stop', address: 'Jindabyne NSW' },
    { name: 'Kosciuszko Rd', lat: -36.4300, lng: 148.5200, type: 'via', address: '' },
    { name: 'Perisher Valley', lat: -36.4058, lng: 148.4103, type: 'scenic', address: 'Perisher Valley NSW' },
    { name: 'Thredbo Village', lat: -36.5044, lng: 148.3050, type: 'lodging', address: 'Thredbo NSW' },
  ],
};

const SHOTS = [
  { file: 'newTripMapView.png', vp: DESKTOP, setup: 'map' },
  { file: 'addWaypointView.png', vp: DESKTOP, setup: 'addWaypoint' },
  { file: 'googleMapsHelperForWaypoints.png', vp: DESKTOP, setup: 'placeSearch' },
  { file: 'journalEntryView.png', vp: DESKTOP, setup: 'journalEntry' },
  { file: 'tripdetailsmodal.png', vp: DESKTOP, setup: 'tripDetails' },
  { file: 'navigationTurnbyTurnView.png', vp: DESKTOP, setup: 'driveMode' },
  { file: 'mobileNavigationView.png', vp: MOBILE, setup: 'driveMode' },
];

function findChrome() {
  const found = CHROME_CANDIDATES.find(p => fs.existsSync(p));
  if (!found) throw new Error('No Chrome/Edge binary found. Set one in CHROME_CANDIDATES.');
  return found;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForDevtools() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch (_) { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('Chrome DevTools endpoint never came up');
}

/** Minimal CDP client over the built-in WebSocket. */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.sessionId = null;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    return new CDP(ws);
  }

  send(method, params = {}) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (this.sessionId) payload.sessionId = this.sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || 'evaluate failed');
    }
    return r.result.value;
  }
}

/** Browser-side setup routines, one per screenshot. */
/**
 * Close every modal (first-run help can auto-open and stack over the target),
 * dismiss the install banner, and collapse the desktop-persistent side menu so
 * shots show the product rather than transient chrome.
 */
const CLOSE_ALL = `
  document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
  document.getElementById('installBanner')?.classList.add('hidden');
  document.getElementById('sideMenu')?.classList.add('hidden');
  document.getElementById('menuOverlay')?.classList.add('hidden');
  document.body.classList.remove('menu-open');
`;

const SETUP = {
  map: `UI.switchView('map'); ${CLOSE_ALL} 800`,
  addWaypoint: `UI.switchView('waypoints'); ${CLOSE_ALL} UI.openModal('waypointModal');
    document.getElementById('waypointName').value = 'Charlotte Pass Lookout';
    document.getElementById('waypointAddress').value = 'Kosciuszko National Park NSW';
    document.getElementById('waypointNotes').value = 'Best photo stop on the climb — pull in on the left.';
    document.getElementById('waypointType').value = 'scenic'; 500`,
  placeSearch: `${CLOSE_ALL} UI.openModal('placeSearchModal');
    document.getElementById('placeSearchInput').value = 'cafe in Jindabyne';
    document.getElementById('placeSearchStatus').textContent = 'Type a search to begin.'; 500`,
  journalEntry: `UI.switchView('journal'); ${CLOSE_ALL} UI.openModal('noteModal');
    document.getElementById('noteTitle').value = 'Day 1 — over the range';
    document.getElementById('noteContent').value = 'Left Jindabyne just after sunrise. Fog sitting in the valley, then clear all the way up the pass. Stopped twice for photos.';
    document.getElementById('noteTags').value = 'day1, scenic'; 500`,
  tripDetails: `${CLOSE_ALL} UI.openModal('tripDetailsModal');
    document.getElementById('tripDetailName').value = 'Snowy Mountains Loop';
    document.getElementById('tripDetailDescription').value = 'Three days through Kosciuszko — alpine passes, long sweepers, no hurry.'; 500`,
  driveMode: `${CLOSE_ALL} UI.switchView('map');
    document.getElementById('rideOverlay').classList.remove('hidden');
    document.body.classList.add('ride-mode');
    MapManager.map.invalidateSize();
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    set('rideNextInstruction', 'Turn left onto Kosciuszko Road');
    set('rideNextMeta', 'then continue 12 km on Kosciuszko Rd');
    set('rideManeuverDist', '450 m');
    set('rideSpeedVal', '78'); set('rideSpeedUnit', 'km/h');
    set('rideDistanceRemaining', '46.2 km');
    set('rideStops', '3'); set('rideEta', '10:42');
    const ic = document.getElementById('rideManeuverIcon');
    if (ic) ic.innerHTML = '<path d="M9 20V10a4 4 0 014-4h5M18 6l-4-4M18 6l-4 4"/>';
    MapManager.map.setView([-36.4300, 148.5200], 14); 900`,
};

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ride-shots-'));
  const chrome = spawn(findChrome(), [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--hide-scrollbars',
    '--disable-gpu',
    '--no-first-run',
    '--force-device-scale-factor=1',
    'about:blank',
  ], { stdio: 'ignore' });

  let client;
  try {
    const wsUrl = await waitForDevtools();
    const browser = await CDP.connect(wsUrl);
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
    client = browser;
    client.sessionId = sessionId;

    await client.send('Page.enable');
    await client.send('Runtime.enable');

    for (const shot of SHOTS) {
      const { width, height, scale, mobile } = shot.vp;
      await client.send('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: scale, mobile,
      });

      await client.send('Page.navigate', { url: BASE });
      await sleep(1200);

      // Seed guest storage on the first pass, then reload so the app picks it up.
      const seeded = await client.evaluate(`!!localStorage.getItem('ride_shot_seeded')`);
      if (!seeded) {
        await client.evaluate(`(async () => {
          localStorage.setItem('ride_shot_seeded', '1');
          const t = await API.trips.create({ name: ${JSON.stringify(DEMO.name)} });
          for (const wp of ${JSON.stringify(DEMO.waypoints)}) await API.waypoints.add(t.id, wp);
          return true;
        })()`);
        await client.send('Page.navigate', { url: BASE });
        await sleep(1400);
      }

      // Load the demo trip, then run this shot's setup.
      await client.evaluate(`(async () => {
        const list = await API.trips.list();
        const t = list.find(x => x.name === ${JSON.stringify(DEMO.name)});
        if (t) await App.loadTrip(t.id);
        return true;
      })()`);
      await sleep(1500);

      const settle = await client.evaluate(`(() => { ${SETUP[shot.setup]} })()`);
      await sleep(Number(settle) || 600);
      // Transient toasts / banners must not appear in product shots. Suppress
      // showToast outright so a late async failure can't pop one mid-capture.
      await client.evaluate(`
        UI.showToast = () => {};
        ['toast','toastSecondary','installBanner'].forEach(
          id => document.getElementById(id)?.classList.add('hidden')
        );
        true
      `);

      const { data } = await client.send('Page.captureScreenshot', { format: 'png' });
      const dest = path.join(OUT_DIR, shot.file);
      fs.writeFileSync(dest, Buffer.from(data, 'base64'));
      const kb = (fs.statSync(dest).size / 1024).toFixed(0);
      console.log(`  ✓ ${shot.file}  ${width}x${height}@${scale}x  ${kb} KB`);
    }
    console.log(`\nWrote ${SHOTS.length} screenshots to public/images/product/\n`);
  } finally {
    try { client?.ws.close(); } catch (_) { /* already closed */ }
    chrome.kill();
  }
}

main().catch(err => {
  console.error('Screenshot run failed:', err.message);
  process.exit(1);
});
