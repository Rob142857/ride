/**
 * Map Tiles — the single source of truth for every basemap the app draws.
 *
 * Both map surfaces (the planner in public/js/map.js and the public share page
 * in public/trip.html) build their layers from here, so a provider swap is one
 * edit in api/tiles.js and nothing in the client. No layer here names an
 * upstream host: every style points at our own cached Worker proxy at
 * /api/tiles/{style}/{z}/{x}/{y} (see api/tiles.js).
 *
 * Contract — window.MapTiles:
 *   MapTiles.STYLES              — ['street', 'dark', 'satellite'], the valid ids.
 *   MapTiles.DEFAULT_STYLE       — 'street'; also the fallback for an unknown id.
 *   MapTiles.createLayer(style, options)
 *                                — a configured L.tileLayer, attribution and
 *                                  maxZoom already set. `options` is merged last
 *                                  so a caller can override (e.g. opacity).
 *   MapTiles.urlTemplate(style)  — the raw Leaflet template string, e.g.
 *                                  '/api/tiles/street/{z}/{x}/{y}'. Exposed for
 *                                  the offline tile download, which precomputes
 *                                  URLs instead of going through a layer.
 *   MapTiles.tileUrl(style, z, x, y)
 *                                — that template with the coordinates filled in.
 *   MapTiles.attribution(style)  — the attribution HTML for a style.
 *   MapTiles.maxZoom(style)      — the deepest zoom a style serves.
 *
 * No {s} subdomain sharding: the proxy is a single origin and HTTP/2 multiplexes
 * the ~20-30 tiles a viewport needs over one connection anyway.
 *
 * Attribution is a licensing obligation, not decoration. Each string below is
 * the one the provider requires; do not trim them.
 */
(function (window) {
  'use strict';

  const PROXY_PATH = '/api/tiles';

  /** Keys MUST match the style allowlist in api/tiles.js. */
  const STYLE_DEFS = {
    street: {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    },
    dark: {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, &copy; <a href="https://carto.com/attributions">CARTO</a>'
    },
    satellite: {
      maxZoom: 19,
      attribution: 'Imagery &copy; <a href="https://www.esri.com/">Esri</a>, Maxar, Earthstar Geographics'
    }
  };

  const STYLES = Object.keys(STYLE_DEFS);
  const DEFAULT_STYLE = 'street';

  /** Unknown ids fall back to the default rather than producing a dead layer. */
  function resolve(style) {
    return STYLE_DEFS[style] ? style : DEFAULT_STYLE;
  }

  function urlTemplate(style) {
    return `${PROXY_PATH}/${resolve(style)}/{z}/{x}/{y}`;
  }

  function tileUrl(style, z, x, y) {
    return `${PROXY_PATH}/${resolve(style)}/${z}/${x}/${y}`;
  }

  function attribution(style) {
    return STYLE_DEFS[resolve(style)].attribution;
  }

  function maxZoom(style) {
    return STYLE_DEFS[resolve(style)].maxZoom;
  }

  function createLayer(style, options) {
    const key = resolve(style);
    return L.tileLayer(urlTemplate(key), Object.assign({
      attribution: STYLE_DEFS[key].attribution,
      maxZoom: STYLE_DEFS[key].maxZoom,
      // Same-origin today, but keeping the CORS attribute on means canvas
      // export (share images) never taints even if the proxy moves hosts.
      crossOrigin: true
    }, options || {}));
  }

  window.MapTiles = {
    STYLES,
    DEFAULT_STYLE,
    createLayer,
    urlTemplate,
    tileUrl,
    attribution,
    maxZoom
  };
})(window);
