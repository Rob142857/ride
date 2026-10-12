const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const repo = path.resolve(__dirname, '..');
const port = Number(process.env.RIDE_PREVIEW_PORT || 3014);

function readPublic(relativePath) {
  return fs.readFileSync(path.join(repo, 'public', relativePath), 'utf8');
}

function previewPage() {
  const index = readPublic('index.html');
  const start = index.indexOf('<!-- Ride Overlay -->');
  const end = index.indexOf('</section>', start) + '</section>'.length;
  if (start < 0 || end < '</section>'.length) throw new Error('Could not find the Ride overlay in public/index.html');
  const overlay = index.slice(start, end);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>Ride session preview</title>
  <link rel="stylesheet" href="/css/global.css">
  <link rel="stylesheet" href="/css/app.css">
  <link rel="stylesheet" href="/css/ride-mode.css">
  <style>
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
    #map { position: fixed; inset: 0; background: linear-gradient(160deg, #d8e6dc, #a8c6c0 55%, #86a9aa); }
    #map::before { content: ""; position: absolute; left: 6%; right: 6%; top: 52%; height: 4px; border-radius: 4px; background: #f8fafc; transform: rotate(-8deg); box-shadow: 0 0 0 1px #80969a; }
    #map::after { content: "Mock map · no GPS or map service"; position: absolute; top: 45%; left: 50%; transform: translateX(-50%); color: #23404a; font: 600 13px/1.4 Inter, sans-serif; }
    #previewControls { position: fixed; z-index: 200; right: 12px; bottom: 14px; width: min(340px, calc(100vw - 24px)); max-height: 44vh; overflow: auto; padding: 12px; border: 1px solid #ffffff55; border-radius: 12px; background: #101827ee; color: #fff; font: 13px/1.4 Inter, sans-serif; box-shadow: 0 8px 24px #0005; }
    #previewControls h1 { margin: 0 0 6px; font-size: 15px; }
    #previewControls p { margin: 0 0 8px; color: #d1d5db; }
    #previewControls .actions { display: flex; flex-wrap: wrap; gap: 6px; }
    #previewControls button { border: 1px solid #ffffff40; border-radius: 7px; background: #ffffff15; color: white; padding: 7px 9px; font: inherit; cursor: pointer; }
    #previewControls button:hover { background: #ffffff2b; }
    #previewLog { margin-top: 8px; white-space: pre-wrap; color: #bfdbfe; }
    @media (max-height: 600px) { #previewControls { max-height: 34vh; } }
  </style>
</head>
<body class="geistsans_47a3c9f1-module__2HyNMa__variable antialiased">
  <div id="map" aria-label="Synthetic route map"></div>
  <main id="previewControls">
    <h1>Ride session preview</h1>
    <p>Uses the real Ride overlay and session scripts with synthetic trip data, mock routing, and mock GPS. No account or API calls.</p>
    <div class="actions">
      <button id="previewStart">Start ride</button>
      <button id="previewOnRoute">GPS fix on route</button>
      <button id="previewOffRoute">GPS fix off route ×4</button>
      <button id="previewComplete">Complete mock reroute</button>
      <button id="previewGpsError">GPS signal lost</button>
      <button id="previewOffline">Toggle API offline</button>
      <button id="previewSwitch">Switch trip</button>
      <button id="previewExit">Exit ride</button>
    </div>
    <div id="previewLog" role="status" aria-live="polite">Ready. Start a synthetic ride.</div>
  </main>
  ${overlay}
  <script>
    (() => {
      const previewId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      const waypoints = [
        { id: 'preview-stop-1', name: 'First stop', lat: 0, lng: 0.003, order: 1 },
        { id: 'preview-stop-2', name: 'Next stop', lat: 0, lng: 0.012, order: 2 },
        { id: 'preview-stop-3', name: 'Final stop', lat: 0, lng: 0.018, order: 3 }
      ];
      const makeTrip = (id, name) => ({ id, name, waypoints: waypoints.map(point => ({ ...point })), route: {
        coordinates: [0, 0.005, 0.01, 0.015, 0.02].map(lng => ({ lat: 0, lng })), steps: [], distance: 2224, duration: 300
      } });
      window.App = { currentUser: { id: 'synthetic-preview-user' }, currentTrip: makeTrip('preview-' + previewId, 'Preview trip'), useCloud: true };
      window.previewOnline = true;
      window.previewPendingRoutes = [];
      window.previewSavedLogs = [];
      window.MapManager = {
        startRide(onPosition, onStatus) { this.onPosition = onPosition; this.onStatus = onStatus; },
        stopRide() { this.onPosition = null; this.onStatus = null; },
        clearRideNavigationRoute() {},
        setRideNavigationRoute(route) { this.navigationRoute = route; },
        rerouteRideLeg(position, waypoint, context, onSuccess, onError) {
          window.previewPendingRoutes.push({ position: { ...position }, waypoint, context, onSuccess, onError });
        },
        drawRideLogs() {}, recenterRide() {}
      };
      window.RideUtils = {
        haversine(a, b) {
          const rad = x => x * Math.PI / 180, dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
          const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
          return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
        },
        formatDistance(value) { return Math.round(value) + ' m'; },
        formatDuration(value) { return Math.round(value) + ' sec'; }
      };
      window.UI = { showToast(message) { window.previewMessage = message; updateLog(); }, showAuthGate() {}, renderJournal() {} };
      window.API = { rideLogs: {
        async save(tripId, payload) {
          if (!window.previewOnline) throw new Error('offline');
          window.previewSavedLogs.push({ tripId, payload });
          return { success: true, id: payload.client_log_id };
        }, async list() { return []; }
      } };
      try { if (!('geolocation' in navigator)) Object.defineProperty(navigator, 'geolocation', { value: {}, configurable: true }); } catch (_) {}
      window.previewFixTime = Date.now();
      window.previewFix = (lat, lng) => {
        window.previewFixTime = Math.max(window.previewFixTime + 5000, Date.now());
        window.MapManager.onStatus?.({ type: 'fix' });
        window.MapManager.onPosition?.({ lat, lng, accuracy: 5, timestamp: window.previewFixTime });
        updateLog();
      };
      window.updateLog = () => {
        const log = document.getElementById('previewLog');
        if (!log) return;
        const target = window.App._rideNextWaypoint?.name || 'none';
        const state = window.App._rideRecorder?.getStatus()?.state || 'not recording';
        const prompt = document.getElementById('rideDeviationBanner')?.classList.contains('hidden') ? 'hidden' : 'visible';
        const undo = document.getElementById('rideUndoBanner')?.classList.contains('hidden') ? 'hidden' : 'visible';
        log.textContent = 'Ride: ' + (window.App.isRiding ? 'active' : 'idle') + ' · next stop: ' + target + ' · recorder: ' + state +
          '\\nOff-route fixes: ' + (window.App.offRouteCounter || 0) + ' · reroute requests: ' + window.previewPendingRoutes.length +
          '\\nDeviation offer: ' + prompt + ' · Undo: ' + undo + ' · fake logs saved: ' + window.previewSavedLogs.length +
          '\\n' + (window.previewMessage || '');
      };
      window.addEventListener('error', event => { document.getElementById('previewLog').textContent = 'Preview error: ' + event.message; });
    })();
  </script>
  <script src="/js/ride-recorder.js"></script>
  <script src="/js/ride-navigation.js"></script>
  <script src="/js/ride-ride-ui.js"></script>
  <script src="/js/ride-controller.js"></script>
  <script src="/js/ride-session.js"></script>
  <script>
    document.getElementById('previewStart').onclick = () => { App.enterRideMode(); updateLog(); };
    document.getElementById('previewOnRoute').onclick = () => previewFix(0, 0.008);
    document.getElementById('previewOffRoute').onclick = () => { for (let i = 0; i < 4; i++) previewFix(0.0015, 0.008); };
    document.getElementById('previewComplete').onclick = () => {
      const request = previewPendingRoutes.at(-1);
      if (!request) { previewMessage = 'No mock reroute request is pending.'; updateLog(); return; }
      request.onSuccess({ coordinates: [request.position, { lat: request.waypoint.lat, lng: request.waypoint.lng }], steps: [], distance: 500, duration: 80 }, request.context);
      previewMessage = 'Mock reroute returned. Choose Update or Keep plan in the Ride banner.';
      updateLog();
    };
    document.getElementById('previewGpsError').onclick = () => { MapManager.onStatus?.({ type: 'error', reason: 'gps-error' }); updateLog(); };
    document.getElementById('previewOffline').onclick = () => { previewOnline = !previewOnline; previewMessage = 'Fake API is ' + (previewOnline ? 'online' : 'offline'); updateLog(); };
    document.getElementById('previewSwitch').onclick = () => {
      App.endRideForTripSwitch();
      App.currentTrip = { id: 'preview-next-' + Date.now().toString(36), name: 'Second preview trip', waypoints: [], route: { coordinates: [], steps: [] } };
      previewMessage = 'Switched to a synthetic second trip; any earlier reroute response is stale.';
      updateLog();
    };
    document.getElementById('previewExit').onclick = () => { App.exitRideMode(); updateLog(); };
    document.getElementById('rideDeviationUpdate').addEventListener('click', () => setTimeout(updateLog, 0));
    document.getElementById('rideDeviationKeep').addEventListener('click', () => setTimeout(updateLog, 0));
    document.getElementById('rideUndoButton').addEventListener('click', () => setTimeout(updateLog, 0));
    updateLog();
  </script>
</body>
</html>`;
}

const assets = new Map([
  ['/css/global.css', ['css/global.css', 'text/css; charset=utf-8']],
  ['/css/app.css', ['css/app.css', 'text/css; charset=utf-8']],
  ['/css/ride-mode.css', ['css/ride-mode.css', 'text/css; charset=utf-8']],
  ['/js/ride-recorder.js', ['js/ride-recorder.js', 'text/javascript; charset=utf-8']],
  ['/js/ride-navigation.js', ['js/ride-navigation.js', 'text/javascript; charset=utf-8']],
  ['/js/ride-ride-ui.js', ['js/ride-ride-ui.js', 'text/javascript; charset=utf-8']],
  ['/js/ride-controller.js', ['js/ride-controller.js', 'text/javascript; charset=utf-8']],
  ['/js/ride-session.js', ['js/ride-session.js', 'text/javascript; charset=utf-8']]
]);

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  if (request.method !== 'GET') {
    response.writeHead(405, { Allow: 'GET' }).end('GET only');
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(previewPage());
    return;
  }
  const asset = assets.get(url.pathname);
  if (!asset) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    return;
  }
  response.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-store' }).end(readPublic(asset[0]));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Ride session preview: http://127.0.0.1:${port}/`);
  console.log('Stop with Ctrl+C. The preview serves only synthetic data and local Ride files.');
});
