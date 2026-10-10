/** Shared basemap for the planner and shared trips. No hosted-provider key required. */
/* exported RideBasemaps */
const RideBasemaps = (() => {
  // Bump this revision when data, style, glyphs or rendering settings change.
  const TILE_REVISION = '2026-10-10-2';
  const OWNED_URL = `https://maps.incitat.io/styles/ride-australia/{z}/{x}/{y}.png?v=${TILE_REVISION}`;
  const LABELS_URL = `https://maps.incitat.io/styles/ride-australia-labels/{z}/{x}/{y}.png?v=${TILE_REVISION}`;
  const LABEL_PANE = 'rideLabels';
  const FALLBACK_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  // Mainland Australia and Tasmania. Other countries/territories use normal
  // interactive OSM viewing; there is no country-sized OSM download feature.
  const AUSTRALIA_BOUNDS = [[-44, 112], [-9, 155]];
  // Verified Shortbread archive extent includes territories and ocean margins.
  // It supports Australian route overviews wider than the center-selection box.
  const DATA_BOUNDS = [[-57.07106, 68.13342], [-8.809565, 169.0016]];
  const RETRY_AFTER_MS = 60 * 1000;
  const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  const OWNED_ATTRIBUTION = `${OSM_ATTRIBUTION} · <a href="https://download.geofabrik.de/australia-oceania/australia.html">Geofabrik</a> · <a href="https://github.com/versatiles-org/versatiles-style">VersaTiles</a>`;

  function streets({ onFallback } = {}) {
    const coverage = L.latLngBounds(AUSTRALIA_BOUNDS);
    const dataCoverage = L.latLngBounds(DATA_BOUNDS);
    const ownedLayer = L.tileLayer(OWNED_URL, {
      attribution: OWNED_ATTRIBUTION,
      // TileServer GL renders fresh rasters from the z14 vectors through z19.
      maxNativeZoom: 19,
      maxZoom: 19,
      bounds: DATA_BOUNDS,
      crossOrigin: true,
      updateWhenIdle: true
    });
    // Same raster coordinates/settings as the full base, with transparent
    // ground. Its labels remain readable above routes; the full base still
    // supplies labels if this additional layer cannot load.
    const labelsLayer = L.tileLayer(LABELS_URL, {
      pane: LABEL_PANE,
      maxNativeZoom: 19,
      maxZoom: 19,
      bounds: DATA_BOUNDS,
      crossOrigin: true,
      updateWhenIdle: true
    });
    const fallbackLayer = L.tileLayer(FALLBACK_URL, {
      attribution: OSM_ATTRIBUTION,
      maxZoom: 19,
      crossOrigin: true,
      updateWhenIdle: true
    });
    // Fixed child-layer options let Leaflet reset its native zoom grid and
    // manage attribution when the source changes, including high zoom views.
    const layer = L.layerGroup();
    const tileGenerations = new WeakMap();
    let map = null;
    let activeLayer = null;
    let sourceGeneration = 0;
    let unavailableUntil = 0;
    const updateSource = () => {
      if (!map) return false;
      const offline = navigator.onLine === false;
      let zoom, center, viewport;
      try {
        zoom = map.getZoom();
        const size = map.getSize();
        // Hidden containers and an unfinished initial fit have no usable
        // viewport yet. Re-evaluate on moveend after layout/view recovery.
        if (!Number.isFinite(zoom) || !Number.isFinite(size.x) || !Number.isFinite(size.y) ||
            size.x <= 0 || size.y <= 0) return false;
        center = map.getCenter();
        if (!Number.isFinite(center.lat) || !Number.isFinite(center.lng)) return false;
        if (!offline) viewport = map.getBounds();
      } catch {
        return false;
      }
      const inAustralia = coverage.contains(center);
      // A wide view needs global context. Offline, keep showing any viewed
      // owned tiles for Australia even after an earlier online server failure.
      const useOwned = inAustralia && (offline || (zoom >= 4 &&
        dataCoverage.contains(viewport) && Date.now() >= unavailableUntil));
      const next = useOwned ? ownedLayer : fallbackLayer;
      if (activeLayer === next) return true;
      sourceGeneration++;
      layer.clearLayers();
      activeLayer = next;
      layer.addLayer(next);
      if (useOwned) layer.addLayer(labelsLayer);
      return true;
    };
    const connectionChanged = () => {
      const previous = activeLayer;
      if (navigator.onLine !== false) unavailableUntil = 0;
      if (!updateSource()) return;
      // Reload tiles that failed while offline when connectivity returns.
      if (navigator.onLine !== false && previous === ownedLayer && activeLayer === ownedLayer) {
        ownedLayer.redraw();
        labelsLayer.redraw();
      }
    };
    layer.on('add', () => {
      map = layer._map;
      const labelsPane = map.getPane(LABEL_PANE) || map.createPane(LABEL_PANE);
      // Leaflet paths are at 400, markers at 600 and popups at 700.
      labelsPane.style.zIndex = '450';
      labelsPane.style.pointerEvents = 'none';
      map.on('moveend', updateSource);
      window.addEventListener('online', connectionChanged);
      window.addEventListener('offline', connectionChanged);
      updateSource();
    });
    layer.on('remove', () => {
      map?.off('moveend', updateSource);
      window.removeEventListener('online', connectionChanged);
      window.removeEventListener('offline', connectionChanged);
      map = null;
      activeLayer = null;
      sourceGeneration++;
      layer.clearLayers();
    });
    ownedLayer.on('tileloadstart', ({ tile }) => tileGenerations.set(tile, sourceGeneration));
    ownedLayer.on('tileunload', ({ tile }) => tileGenerations.delete(tile));
    ownedLayer.on('tileerror', ({ tile }) => {
      // A disconnected device should keep the owned tiles it has cached.
      // Ignore late errors from tiles belonging to an earlier source/view.
      if (!map || activeLayer !== ownedLayer || navigator.onLine === false ||
          tileGenerations.get(tile) !== sourceGeneration) return;
      unavailableUntil = Date.now() + RETRY_AFTER_MS;
      updateSource();
      onFallback?.();
    });
    return layer;
  }

  // Shared route appearance for the planner, saved routes and public trips.
  // Keep the underlying road texture visible even at street zoom levels.
  function routeStyle(zoom, { color = '#e94560', selected = true } = {}) {
    const weight = zoom >= 16 ? 3 : zoom >= 13 ? 2.5 : 3;
    return { color, weight, opacity: selected ? 0.65 : 0.35, pane: 'overlayPane' };
  }

  return { streets, routeStyle, OWNED_URL, LABELS_URL };
})();
