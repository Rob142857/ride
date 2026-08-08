/**
 * Route Alternatives — retired.
 *
 * This module used to render a SECOND alternatives picker (a card panel
 * injected next to #map) alongside the RouteSelector pill bar that sits on the
 * map. Two pickers competed for the same state, and this one's selection path
 * cleared the map and forced a fresh OSRM recompute — which reset the choice
 * the rider had just made. Its badge fields (is_fastest, is_fewer_turns) were
 * never produced by anything either.
 *
 * The pill bar (js/route-selector.js) is now the single selection surface: it
 * shows time, distance, a twistiness meter and a Windiest / Fastest badge, and
 * it stays in sync when an alternative is tapped directly on the map.
 *
 * The API surface is kept because trip-controller.js calls renderPanel() and
 * only wires its listener when a panel comes back. Returning null keeps that
 * whole path inert. Delete this file (and its <script> tag) once the call site
 * in trip-controller.js goes.
 */
(function () {
  'use strict';

  window.RouteAlternatives = {
    /** @returns {null} always — the pill bar owns route selection. */
    renderPanel() {
      return null;
    },

    activateRoute() {
      return false;
    },

    clear() {},

    onRouteSelected() {},
  };
})();
