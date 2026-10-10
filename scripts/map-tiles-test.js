/* Basemap failover/coverage and service-worker tile response checks (node >=18). */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Request, Response } = globalThis;
const root = path.join(__dirname, '..');

function basemapFixture({ center = { lat: -33.86, lng: 151.2 }, zoom = 12 } = {}) {
  const mapEvents = {};
  const windowEvents = {};
  const layers = [];
  const attributions = new Map();
  const map = {
    center, zoom, bounds: [[-34, 151], [-33, 152]], size: { x: 1024, y: 768 },
    getCenter() { return this.center; }, getZoom() { return this.zoom; },
    getSize() { return this.size; },
    getBounds() { if (this.boundsError) throw new Error('Invalid LatLng object: (NaN, NaN)'); return this.bounds; },
    on(name, fn) { mapEvents[name] = fn; }, off(name) { delete mapEvents[name]; },
    addLayer(layer) {
      layer._map = this;
      const value = layer.options.attribution;
      attributions.set(value, (attributions.get(value) || 0) + 1);
    },
    removeLayer(layer) {
      layer._map = null;
      const value = layer.options.attribution;
      const count = attributions.get(value) - 1;
      if (count) attributions.set(value, count); else attributions.delete(value);
    }
  };
  const navigator = { onLine: true };
  let fallbackCount = 0;
  let now = 0;
  const context = vm.createContext({ navigator, WeakMap, Date: { now: () => now }, window: {
    addEventListener(name, fn) { windowEvents[name] = fn; },
    removeEventListener(name) { delete windowEvents[name]; }
  }, L: {
    latLngBounds: (b) => ({ contains: p => {
      if (Array.isArray(p)) {
        return p[0][0] >= b[0][0] && p[1][0] <= b[1][0] &&
          p[0][1] >= b[0][1] && p[1][1] <= b[1][1];
      }
      return p.lat >= b[0][0] && p.lat <= b[1][0] && p.lng >= b[0][1] && p.lng <= b[1][1];
    } }),
    tileLayer: (url, options) => {
      const layer = { url, options, events: {}, redraws: 0,
        on(name, fn) { this.events[name] = fn; return this; },
        redraw() { this.redraws++; }
      };
      layers.push(layer);
      return layer;
    },
    layerGroup: () => ({ events: {}, children: [],
      on(name, fn) { this.events[name] = fn; return this; },
      clearLayers() {
        if (this._map) this.children.forEach(child => map.removeLayer(child));
        this.children = [];
      },
      addLayer(child) { this.children.push(child); if (this._map) map.addLayer(child); },
      addTo() { this._map = map; this.events.add(); return this; },
      remove() { this.clearLayers(); this.events.remove(); this._map = null; }
    })
  } });
  vm.runInContext(fs.readFileSync(path.join(root, 'public/js/basemaps.js'), 'utf8'), context);
  context.fallback = () => fallbackCount++;
  const layer = vm.runInContext('RideBasemaps.streets({ onFallback: () => fallback() })', context);
  return { layer, owned: layers[0], fallback: layers[1], map, navigator, mapEvents, windowEvents, attributions,
    fallbackCount: () => fallbackCount, advance: ms => now += ms,
    startTile() { const tile = {}; layers[0].events.tileloadstart({ tile }); return tile; },
    fail(tile) { layers[0].events.tileerror({ tile }); },
    active() { return layer.children[0]; }
  };
}

function sharedTripInitializationTest() {
  const html = fs.readFileSync(path.join(root, 'public/trip.html'), 'utf8');
  const render = html.slice(html.indexOf('    function renderTrip(trip) {'), html.indexOf('    function initMap(trip) {'));
  const init = html.slice(html.indexOf('    function initMap(trip) {'), html.indexOf('    function drawRouteForIndex'));
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { style: {}, closest: () => ({ style: {} }) });
    return nodes.get(id);
  };
  node('content').style.display = 'none';
  const context = vm.createContext({
    document: { getElementById: node, querySelector: () => ({ style: {} }), querySelectorAll: () => [] },
    window: { location: { href: 'https://ride.incitat.io/s/fixture' } },
    setTimeout() {}, escapeHtml: value => value, updateMeta() {}, setHeroPlaceholder() {},
    drawRouteForIndex() {}, setBasemap() {}, wireBasemapButtons() {},
    RideBasemaps: { streets: () => ({}) },
    L: {
      map(_id, options) {
        assert.equal(node('content').style.display, 'block', 'Shared content must be visible before Leaflet measures it');
        assert.equal(options.maxZoom, 19, 'A single-point fit must be finite before child tile-layer zoom limits exist');
        return { fitBounds() {}, setView() {} };
      },
      tileLayer: () => ({}), latLngBounds: points => points,
      circleMarker: () => ({ addTo() { return this; }, bindPopup() {} })
    }
  });
  vm.runInContext(`${render}\n${init}\nrenderTrip({ title: 'Fixture journey', waypoints: [{ lat: -33.86, lng: 151.2, name: 'Fixture stop' }] });`, context);
}

async function tileFixture(options = {}) {
  const handlers = {};
  const storage = new Map();
  const cache = {
    async match(request, matchOptions = {}) {
      const key = new URL(typeof request === 'string' ? request : request.url, 'https://ride.incitat.io').href;
      if (!matchOptions.ignoreSearch) return storage.get(key)?.clone();
      const withoutSearch = value => { const url = new URL(value); url.search = ''; return url.href; };
      for (const [url, response] of storage) {
        if (withoutSearch(url) === withoutSearch(key)) return response.clone();
      }
    },
    async put(request, response) {
      if (options.cacheFailure) throw new Error('quota exceeded');
      storage.set(request.url, response);
    },
    async keys() { return [...storage.keys()].map(url => new Request(url)); },
    async delete(request) { return storage.delete(request.url); }
  };
  const context = vm.createContext({ URL, Request, Response, Promise,
    self: { location: { origin: 'https://ride.incitat.io' }, addEventListener(name, fn) { handlers[name] = fn; } },
    caches: { async open() { return cache; } },
    setInterval() {},
    fetch: async () => {
      if (options.offline) throw new Error('offline');
      const response = new Response(options.body || 'tile', {
        status: options.status || 200, headers: { 'Content-Type': options.type || 'image/png' }
      });
      Object.defineProperty(response, 'redirected', { value: options.redirected || false });
      return response;
    }
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8'), context);
  async function request(url, requestOptions = {}) {
    let response;
    const pending = [];
    const incoming = new Request(url);
    // Navigation mode is assigned by the browser and cannot be set through
    // Request's constructor; simulate its observed value on the real object.
    if (requestOptions.navigate) Object.defineProperty(incoming, 'mode', { value: 'navigate' });
    handlers.fetch({ request: incoming, respondWith(result) { response = result; }, waitUntil(result) { pending.push(result); } });
    const answer = await response;
    await Promise.all(pending);
    return answer;
  }
  return { storage, request, options };
}

(async () => {
  sharedTripInitializationTest();
  let b = basemapFixture();
  b.layer.addTo();
  assert.equal(b.active(), b.owned);
  assert.equal(b.attributions.size, 1);
  const oldTile = b.startTile();
  b.map.center = { lat: 51.5, lng: -0.1 }; b.mapEvents.moveend();
  assert.equal(b.active(), b.fallback);
  assert.equal(b.active().options.bounds, undefined);
  b.map.center = { lat: -33.86, lng: 151.2 }; b.map.zoom = 18; b.mapEvents.moveend();
  assert.equal(b.active(), b.owned);
  assert.equal(b.active().options.maxNativeZoom, 19); // Request display-zoom rasters; do not enlarge z14 labels.
  b.map.zoom = 19; b.mapEvents.moveend();
  assert.equal(b.active(), b.owned);
  assert.equal(Math.min(b.map.zoom, b.active().options.maxNativeZoom), 19);
  b.fail(oldTile); // A delayed error from before the source switch is ignored.
  assert.equal(b.active(), b.owned);
  assert.equal(JSON.stringify(b.owned.options.bounds), JSON.stringify([[-57.07106, 68.13342], [-8.809565, 169.0016]]));
  b.map.zoom = 5;
  b.map.bounds = [[-37.5794, 128.8037], [-22.4313, 166.2012]]; b.mapEvents.moveend();
  assert.equal(b.active(), b.owned); // Default public overview includes ocean beyond the region box.
  b.map.bounds = [[-58, 128], [-20, 166]]; b.mapEvents.moveend();
  assert.equal(b.active(), b.fallback); // Southern archive edge must not clip the view.
  b.map.bounds = [[-40, 110], [-20, 170]]; b.mapEvents.moveend();
  assert.equal(b.active(), b.fallback); // A viewport beyond coverage needs global context.
  b.map.bounds = [[-34, 151], [-33, 152]]; b.mapEvents.moveend();
  b.map.zoom = 2; b.mapEvents.moveend();
  assert.equal(b.active(), b.fallback);
  b.map.zoom = 12; b.mapEvents.moveend();
  const removedTile = b.startTile(); b.owned.events.tileunload({ tile: removedTile }); b.fail(removedTile);
  assert.equal(b.active(), b.owned);
  const failedTile = b.startTile(); b.fail(failedTile); b.fail(failedTile);
  assert.equal(b.fallbackCount(), 1);
  assert.equal(b.active(), b.fallback);
  assert.equal(b.attributions.size, 1);
  b.navigator.onLine = false; b.windowEvents.offline();
  assert.equal(b.active(), b.owned); // Restore cached owned tiles after online failover.
  b.fail(b.startTile()); assert.equal(b.active(), b.owned);
  b.navigator.onLine = true; b.windowEvents.online();
  assert.equal(b.active(), b.owned);
  assert.equal(b.owned.redraws, 1);
  b.fail(b.startTile()); b.advance(60 * 1000); b.mapEvents.moveend();
  assert.equal(b.active(), b.owned); // A later interaction retries a recovered host.
  b.layer.remove();
  assert.equal(b.mapEvents.moveend, undefined);
  assert.equal(Object.keys(b.windowEvents).length, 0);
  assert.equal(b.attributions.size, 0);
  b.layer.addTo(); assert.equal(b.active(), b.owned);
  b = basemapFixture({ center: { lat: 51.5, lng: -0.1 } }); b.layer.addTo();
  assert.equal(b.active(), b.fallback);
  assert.equal([...b.attributions.values()][0], 1); // Initial fallback attribution is counted once.
  b = basemapFixture({ center: { lat: -12.15, lng: 96.82 } });
  b.map.bounds = [[-12.3, 96.6], [-12, 97]]; b.layer.addTo();
  assert.equal(b.active(), b.fallback); // A center outside mainland/Tasmania stays global even inside the archive.
  for (const geometry of [
    { zoom: Infinity }, { zoom: NaN }, { size: { x: 0, y: 0 } }, { center: { lat: NaN, lng: 151 } }, { boundsError: true }
  ]) {
    b = basemapFixture(); Object.assign(b.map, geometry);
    assert.doesNotThrow(() => b.layer.addTo());
    assert.equal(b.active(), undefined); // Initial hidden or unfinished maps defer source creation.
    Object.assign(b.map, { zoom: 12, size: { x: 1024, y: 768 }, center: { lat: -33.86, lng: 151.2 }, boundsError: false });
    b.mapEvents.moveend(); assert.equal(b.active(), b.owned); // The next valid view completes initialization.
  }
  b.map.size = { x: 0, y: 0 }; b.windowEvents.online();
  assert.equal(b.owned.redraws, 0); // Reconnection must not redraw an unusable viewport.

  const owned = b.owned.url.replace('{z}', '12').replace('{x}', '3769').replace('{y}', '2457');
  assert.ok(new URL(owned).searchParams.get('v')); // App requests carry a stable rendering revision.
  let t = await tileFixture(); await t.request(owned);
  assert.equal(t.storage.size, 1);
  t.options.offline = true;
  assert.equal(await (await t.request(owned)).text(), 'tile');
  const differentRevision = new URL(owned); differentRevision.searchParams.set('v', 'different-rendering');
  assert.equal((await t.request(differentRevision.href)).type, 'error'); // Never reuse another rendering revision offline.
  for (const options of [{ type: 'text/html' }, { redirected: true }, { status: 403 }]) {
    t = await tileFixture(options); await t.request(owned); assert.equal(t.storage.size, 0);
  }
  t = await tileFixture({ offline: true });
  assert.equal((await t.request(owned)).type, 'error');
  t = await tileFixture({ cacheFailure: true });
  assert.equal(await (await t.request(owned)).text(), 'tile');
  t = await tileFixture({ offline: true });
  t.storage.set('https://ride.incitat.io/js/basemaps.js', new Response('precached script'));
  assert.equal(await (await t.request('https://ride.incitat.io/js/basemaps.js?v=new-build')).text(), 'precached script');
  t.storage.set('https://ride.incitat.io/css/app.css', new Response('precached style'));
  assert.equal(await (await t.request('https://ride.incitat.io/css/app.css?v=new-build')).text(), 'precached style');
  const publicPage = 'https://ride.incitat.io/s/fixture';
  t = await tileFixture({ body: 'fresh trip HTML', type: 'text/html' });
  t.storage.set(publicPage, new Response('previous trip HTML'));
  assert.equal(await (await t.request(publicPage, { navigate: true })).text(), 'fresh trip HTML');
  t.options.offline = true;
  assert.equal(await (await t.request(publicPage, { navigate: true })).text(), 'fresh trip HTML');
  t.storage.set('https://ride.incitat.io/index.html', new Response('offline shell'));
  assert.equal(await (await t.request('https://ride.incitat.io/s/uncached-fixture', { navigate: true })).text(), 'offline shell');
  t = await tileFixture();
  await Promise.all(Array.from({ length: 805 }, (_, x) => t.request(`https://maps.incitat.io/styles/ride-australia/12/${x}/2457.png`)));
  assert.equal(t.storage.size, 800);
  t = await tileFixture();
  for (const url of ['https://tile.openstreetmap.org/12/3769/2457.png', 'https://a.tile.openstreetmap.org/12/3769/2457.png', 'https://a.basemaps.cartocdn.com/rastertiles/voyager/12/3769/2457.png', 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/12/2457/3769']) {
    assert.equal(await t.request(url), undefined);
  }
  assert.equal(t.storage.size, 0);
  console.log('Map tile tests passed: viewport coverage, high-zoom source swaps, attribution, stale-error rejection, failover/recovery, offline revisit, bounded PNG cache, cache quota tolerance, versioned offline shell and external-provider bypass.');
})().catch(error => { console.error(error); process.exitCode = 1; });
