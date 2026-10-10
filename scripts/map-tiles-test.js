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
  const panes = {
    overlayPane: { style: { zIndex: '400' } },
    markerPane: { style: { zIndex: '600' } },
    popupPane: { style: { zIndex: '700' } }
  };
  const map = {
    center, zoom, bounds: [[-34, 151], [-33, 152]], size: { x: 1024, y: 768 },
    getCenter() { return this.center; }, getZoom() { return this.zoom; },
    getSize() { return this.size; },
    getPane(name) { return panes[name]; },
    createPane(name) { panes[name] = { style: {} }; return panes[name]; },
    getBounds() { if (this.boundsError) throw new Error('Invalid LatLng object: (NaN, NaN)'); return this.bounds; },
    on(name, fn) { mapEvents[name] = fn; }, off(name) { delete mapEvents[name]; },
    addLayer(layer) {
      layer._map = this;
      if (layer.options.pane) assert.ok(panes[layer.options.pane], 'Label pane must exist before tiles are added');
      const value = layer.options.attribution;
      if (value) attributions.set(value, (attributions.get(value) || 0) + 1);
    },
    removeLayer(layer) {
      layer._map = null;
      const value = layer.options.attribution;
      if (!value) return;
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
  return { layer, owned: layers[0], labels: layers[1], fallback: layers[2], map, navigator, mapEvents, windowEvents, attributions, panes,
    routeStyle(zoom, options = {}) { context.styleOptions = options; return vm.runInContext(`RideBasemaps.routeStyle(${zoom}, styleOptions)`, context); },
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
        return { fitBounds() {}, setView() {}, on() {} };
      },
      tileLayer: () => ({}), latLngBounds: points => points,
      circleMarker: (_coords, options) => {
        assert.equal(options.pane, 'markerPane', 'Shared waypoints must appear above the road labels');
        return { addTo() { return this; }, bindPopup() {} };
      }
    }
  });
  vm.runInContext(`${render}\n${init}\nrenderTrip({ title: 'Fixture journey', waypoints: [{ lat: -33.86, lng: 151.2, name: 'Fixture stop' }] });`, context);
}

function routeVisibilityTest() {
  const basemap = basemapFixture();
  let zoom = 19;
  const makePath = (role) => ({ options: { _rideRouteRole: role, weight: 9, opacity: 0.9 }, updates: 0,
    setStyle(style) { Object.assign(this.options, style); this.updates++; },
    bringToFront() { this.front = true; }
  });
  // LRM 3.2.12 Line extends LayerGroup; its child paths handle interaction.
  const makeLine = index => ({ _route: { routesIndex: index }, paths: [makePath('hit'), makePath('line'), makePath()],
    eachLayer(fn) { this.paths.forEach(fn); }
  });
  const primary = makeLine(2), alternative = makeLine(0), selected = makeLine(1);
  const created = [];
  let options;
  const context = vm.createContext({
    RideBasemaps: { routeStyle: (z, o) => basemap.routeStyle(z, o) },
    window: {}, L: {
      latLng: (lat, lng) => ({ lat, lng }),
      Routing: {
        line(route, lineOptions) { created.push({ route, options: lineOptions }); return {}; },
        control(controlOptions) { options = controlOptions; return { getRouter: () => ({ route() {} }), addTo() { return this; }, on() {} }; }
      },
      polyline(_coords, style) { return { options: style, addTo() { return this; } }; }
    }
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'public/js/map.js'), 'utf8'), context);
  context.fixture = { getZoom: () => zoom };
  context.lines = { _line: primary, _alternatives: [alternative, selected] };
  vm.runInContext('MapManager.map = fixture; MapManager.routingControl = lines; MapManager._selectedRouteIndex = 1; MapManager._updateRouteLineStyles()', context);
  for (const line of [primary, alternative, selected]) {
    assert.equal(line.paths[0].options.weight, 12);
    assert.equal(line.paths[0].options.opacity, 0, 'The interaction path must remain invisible');
    assert.equal(line.paths[1].options.weight, 3, 'Street-zoom routes must leave room for the road texture');
    assert.equal(line.paths[1].options.opacity, line === selected ? 0.65 : 0.35);
    assert.equal(line.paths[2].updates, 0, 'Waypoint connectors must retain their own styles');
  }
  assert.equal(selected.paths[1].front, true);
  assert.equal(primary.paths[1].front, undefined);
  zoom = 13;
  vm.runInContext('MapManager._updateRouteLineStyles()', context);
  assert.equal(selected.paths[1].options.weight, 2.5);
  assert.equal(selected.paths[0].options.weight, 12);
  vm.runInContext('MapManager.routingControl = null; MapManager.clearRoute = () => {}; MapManager._hideRouteSelector = () => {}; MapManager.updateRoute([{lat: -33.86, lng: 151.2, order: 0}, {lat: -33.87, lng: 151.21, order: 1}])', context);
  options.routeLine({ routesIndex: 0 }, { addWaypoints: false });
  options.routeLine({ routesIndex: 1 }, { isAlternative: true });
  assert.equal(created[0].options.addWaypoints, false);
  assert.equal(created[0].options.styles[0].weight, 12);
  assert.equal(created[0].options.styles[0].opacity, 0);
  assert.equal(created[0].options.styles[1].opacity, 0.65);
  assert.equal(created[1].options.isAlternative, true);
  assert.equal(created[1].options.styles[1].opacity, 0.35);
  vm.runInContext('MapManager.drawRoute([{lat: -33.86, lng: 151.2}, {lat: -33.87, lng: 151.21}])', context);
  assert.equal(vm.runInContext('MapManager.savedRouteLayer.options.weight', context), 2.5);
  assert.equal(vm.runInContext('MapManager.savedRouteLayer.options.opacity', context), 0.65);

  const html = fs.readFileSync(path.join(root, 'public/trip.html'), 'utf8');
  const draw = html.slice(html.indexOf('    function drawRouteForIndex'), html.indexOf('    function renderRouteSelector'));
  const publicMap = { getZoom: () => zoom, hasLayer: () => false };
  context.map = publicMap; context.routePolylines = [];
  vm.runInContext(`${draw}\ndrawRouteForIndex({route: {coordinates: [[-33.86, 151.2], [-33.87, 151.21]]}}, 0);`, context);
  assert.equal(context.routePolylines[0].options.weight, 2.5);
  assert.equal(context.routePolylines[0].options.opacity, 0.65);
  assert.equal(context.routePolylines[0].options.pane, 'overlayPane');
}

function routingDetailRefreshTest() {
  const basemap = basemapFixture();
  for (const selectedIndex of [0, 1]) {
    const handlers = {};
    let zoom = 13, pending, controlOptions, callbackContext, saved;
    const request = { abort() {} };
    const router = {
      route(waypoints, callback, context, options) {
        assert.equal(this, router, 'The router method must keep its receiver');
        pending = { waypoints, callback, context, options };
        return request;
      }
    };
    const routeLine = (route, options) => ({ _route: route,
      paths: options.styles.map(style => ({ options: { ...style }, setStyle(value) { Object.assign(this.options, value); }, bringToFront() {} })),
      eachLayer(fn) { this.paths.forEach(fn); }
    });
    const control = {
      getRouter: () => router, addTo() { return this; },
      on(name, fn) { handlers[name] = fn; },
      fire(name, event) {
        // Pinned LRM's internal routeselected listener runs before app listeners.
        this._selectedRoute = event.route;
        this.updateLines(event.route, event.alternatives);
        handlers[name]?.(event);
      },
      updateLines(selected, alternatives) {
        this._line = controlOptions.routeLine(selected, { addWaypoints: false });
        this._alternatives = alternatives.map(route => controlOptions.routeLine(route, { isAlternative: true }));
      }
    };
    const context = vm.createContext({
      RideBasemaps: { routeStyle: (z, o) => basemap.routeStyle(z, o) }, window: {},
      App: { saveRouteData(data) { saved = data; } },
      L: { latLng: (lat, lng) => ({ lat, lng }), Routing: {
        control(options) { controlOptions = options; return control; }, line: routeLine
      } }
    });
    vm.runInContext(fs.readFileSync(path.join(root, 'public/js/map.js'), 'utf8'), context);
    context.fixture = { getZoom: () => zoom };
    vm.runInContext('MapManager.map = fixture; MapManager.clearRoute = () => {}; MapManager._hideRouteSelector = () => {}; MapManager.updateRoute([{lat: -33.86, lng: 151.2, order: 0}, {lat: -33.87, lng: 151.21, order: 1}])', context);
    const originals = [0, 1].map(index => ({ routesIndex: index, coordinates: [], instructions: [],
      summary: { totalDistance: 100 + index, totalTime: 20 + index } }));
    control._selectedRoute = originals[0]; control.updateLines(originals[0], [originals[1]]);
    context.originals = originals;
    vm.runInContext(`MapManager._cachedAlternatives = originals; MapManager._selectRoute(${selectedIndex});`, context);
    assert.equal(control._selectedRoute.routesIndex, selectedIndex, 'Card selection must update the native detail-refresh selection');
    if (selectedIndex === 1) assert.equal(saved._selectedIndex, 1);

    const callbackOptions = { geometryOnly: true, simplifyGeometry: false };
    const callbackReceiver = {};
    const handle = router.route(['fixture waypoint'], function(error, routes) {
      callbackContext = this;
      assert.equal(error, null);
      assert.deepEqual(routes.map(route => route.routesIndex), [0, 1]);
      // Same selection operation as LRM 3.2.12 _updateLineCallback: select
      // the response entry using the old selected route's original index.
      const refreshed = routes.slice();
      const selected = refreshed.splice(control._selectedRoute.routesIndex, 1)[0];
      control.updateLines(selected, refreshed);
    }, callbackReceiver, callbackOptions);
    assert.equal(handle, request, 'The abortable request must pass through unchanged');
    assert.equal(pending.options, callbackOptions);
    assert.equal(pending.context, callbackReceiver);
    const fresh = [{ coordinates: [] }, { coordinates: [] }];
    assert.equal(fresh[0].routesIndex, undefined); assert.equal(fresh[1].routesIndex, undefined);
    pending.callback.call(pending.context, null, fresh);
    assert.equal(callbackContext, callbackReceiver);
    assert.equal(control._line._route.routesIndex, selectedIndex);
    assert.equal(control._line.paths[1].options.opacity, 0.65);
    assert.equal(control._alternatives[0].paths[1].options.opacity, 0.35);
    zoom = 19;
    vm.runInContext('MapManager._updateRouteLineStyles()', context);
    assert.equal(control._line.paths[0].options.weight, 12);
    assert.equal(control._line.paths[0].options.opacity, 0);
    assert.equal(control._line.paths[1].options.weight, 3);
    assert.equal(control._line.paths[1].options.opacity, 0.65);
    assert.equal(control._alternatives[0].paths[1].options.opacity, 0.35);

    const failure = new Error('fixture routing failure');
    let receivedError;
    router.route([], error => { receivedError = error; });
    pending.callback(failure);
    assert.equal(receivedError, failure, 'Routing errors must pass through unchanged');
  }
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
  routeVisibilityTest();
  routingDetailRefreshTest();
  let b = basemapFixture();
  b.layer.addTo();
  assert.equal(b.active(), b.owned);
  assert.deepEqual(b.layer.children, [b.owned, b.labels]);
  const labelPane = b.panes[b.labels.options.pane];
  assert.equal(labelPane.style.pointerEvents, 'none', 'Labels must not intercept route/marker interaction');
  assert.ok(+labelPane.style.zIndex > +b.panes.overlayPane.style.zIndex);
  assert.ok(+labelPane.style.zIndex < +b.panes.markerPane.style.zIndex);
  assert.ok(+labelPane.style.zIndex < +b.panes.popupPane.style.zIndex);
  for (const option of ['maxNativeZoom', 'maxZoom', 'crossOrigin', 'updateWhenIdle', 'bounds']) {
    assert.equal(JSON.stringify(b.labels.options[option]), JSON.stringify(b.owned.options[option]), 'Labels must align with the full base');
  }
  assert.equal(new URL(b.labels.url).search, new URL(b.owned.url).search);
  assert.equal(b.labels.events.tileerror, undefined, 'Optional label failures must not fail over the full base');
  assert.equal(b.attributions.size, 1);
  const oldTile = b.startTile();
  b.map.center = { lat: 51.5, lng: -0.1 }; b.mapEvents.moveend();
  assert.equal(b.active(), b.fallback);
  assert.deepEqual(b.layer.children, [b.fallback]); // No Australia labels over another source.
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
  assert.equal(b.labels.redraws, 1);
  b.fail(b.startTile()); b.advance(60 * 1000); b.mapEvents.moveend();
  assert.equal(b.active(), b.owned); // A later interaction retries a recovered host.
  b.layer.remove();
  assert.equal(b.mapEvents.moveend, undefined);
  assert.equal(Object.keys(b.windowEvents).length, 0);
  assert.equal(b.attributions.size, 0);
  assert.equal(b.layer.children.length, 0); // Satellite/removal clears both base and label children.
  assert.equal(b.labels._map, null);
  b.layer.addTo(); assert.equal(b.active(), b.owned);
  assert.equal(b.panes[b.labels.options.pane], labelPane); // Reuse one pane after Streets/Satellite toggles.
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
  const labels = b.labels.url.replace('{z}', '12').replace('{x}', '3769').replace('{y}', '2457');
  assert.equal(new URL(owned).searchParams.get('v'), '2026-10-10-2');
  let t = await tileFixture(); await t.request(owned);
  assert.equal(t.storage.size, 1);
  t.options.offline = true;
  assert.equal(await (await t.request(owned)).text(), 'tile');
  const differentRevision = new URL(owned); differentRevision.searchParams.set('v', 'different-rendering');
  assert.equal((await t.request(differentRevision.href)).type, 'error'); // Never reuse another rendering revision offline.
  t = await tileFixture(); await t.request(labels);
  assert.equal(t.storage.size, 1);
  t.options.offline = true;
  assert.equal(await (await t.request(labels)).text(), 'tile');
  for (const options of [{ type: 'text/html' }, { redirected: true }, { status: 403 }]) {
    t = await tileFixture(options); await t.request(owned); await t.request(labels); assert.equal(t.storage.size, 0);
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
  await Promise.all(Array.from({ length: 805 }, (_, x) => t.request(`https://maps.incitat.io/styles/ride-australia${x % 2 ? '-labels' : ''}/12/${x}/2457.png`)));
  assert.equal(t.storage.size, 800);
  t = await tileFixture();
  for (const url of ['https://maps.incitat.io/styles/another-style/12/3769/2457.png', 'https://maps.incitat.io/styles/ride-australia-labels-extra/12/3769/2457.png', 'https://maps.incitat.io/styles/ride-australia-labels/12/3769/2457.jpg']) {
    await t.request(url);
  }
  assert.equal(t.storage.size, 0, 'Tile caching must stay restricted to the two exact PNG style paths');
  t = await tileFixture();
  for (const url of ['https://tile.openstreetmap.org/12/3769/2457.png', 'https://a.tile.openstreetmap.org/12/3769/2457.png', 'https://a.basemaps.cartocdn.com/rastertiles/voyager/12/3769/2457.png', 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/12/2457/3769']) {
    assert.equal(await t.request(url), undefined);
  }
  assert.equal(t.storage.size, 0);
  console.log('Map tile tests passed: labels above routes/below markers, overlay cleanup, thin route styling with intact hit areas, viewport coverage, source swaps, attribution, stale-error rejection, failover/recovery, offline revisit, bounded base/labels PNG cache, versioned offline shell and external-provider bypass.');
})().catch(error => { console.error(error); process.exitCode = 1; });
