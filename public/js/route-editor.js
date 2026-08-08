/**
 * Route Editor — visible, accessible controls for reshaping a route.
 *
 * "Take the windy road" is mostly this module. Every leg of the route gets a
 * drag handle placed ON the road (half-way along the actual polyline, not at
 * the straight-line midpoint), plus a wide transparent corridor over the route
 * so a tap anywhere on the line inserts a shaping point exactly where the
 * finger landed.
 *
 * Insertions are reported as `type: 'via'` — route-shaping points, not stops.
 *
 * All state lives in this module; map-level wiring is handled by MapManager.
 */
(function (window) {
  'use strict';

  const HANDLE_CLASS = 'route-midpoint-handle';
  const CLICK_LINE_CLASS = 'route-click-line';
  const EPS = 1e-12;
  const DOUBLE_TAP_GUARD_MS = 350;

  /** Accept [{lat,lng}], [[lng,lat]] or [[lat,lng]] and return L.LatLng[]. */
  function toLatLngs(coords) {
    if (!Array.isArray(coords)) return [];
    const out = [];
    for (const c of coords) {
      if (!c) continue;
      if (Array.isArray(c)) {
        const a = Number(c[0]);
        const b = Number(c[1]);
        if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
        // A value beyond ±90 can only be a longitude — use it to disambiguate.
        out.push(Math.abs(a) <= 90 && Math.abs(b) > 90 ? L.latLng(a, b) : L.latLng(b, a));
      } else if (Number.isFinite(Number(c.lat)) && Number.isFinite(Number(c.lng))) {
        out.push(L.latLng(Number(c.lat), Number(c.lng)));
      }
    }
    return out;
  }

  /** Squared planar distance with longitude scaled by latitude — fast and
   *  monotone-equivalent to true distance over the span of one route. */
  function planarD2(a, b) {
    const dLat = (a.lat || 0) - (b.lat || 0);
    const dLng = ((a.lng || 0) - (b.lng || 0)) * Math.cos(((a.lat || 0) * Math.PI) / 180);
    return dLat * dLat + dLng * dLng;
  }

  function create(map, options = {}) {
    if (!map) throw new Error('RouteEditor requires a Leaflet map instance');

    const config = {
      enabled: true,
      onInsertWaypoint: null,
      ...options,
    };

    const pane = map.createPane('routeEditorPane');
    if (pane) pane.style.zIndex = 450; // between overlayPane and markerPane

    const layerGroup = L.layerGroup({ pane: 'routeEditorPane' }).addTo(map);
    let clickLine = null;
    let handles = [];
    let lastClickTime = 0;

    // Route geometry the handles were built from, and the index in that
    // geometry where each waypoint sits (leg boundaries).
    let _lastWaypoints = [];
    let _routeLatLngs = [];
    let _legIndices = [];

    function isEnabled() {
      return config.enabled !== false;
    }

    function setEnabled(value) {
      config.enabled = !!value;
      if (config.enabled) {
        map.addLayer(layerGroup);
        if (clickLine) map.addLayer(clickLine);
      } else {
        map.removeLayer(layerGroup);
        if (clickLine) map.removeLayer(clickLine);
      }
    }

    function sortWaypoints(waypoints) {
      return (Array.isArray(waypoints) ? waypoints : [])
        .slice()
        .sort((a, b) => (Number.isFinite(a?.order) ? a.order : 0) - (Number.isFinite(b?.order) ? b.order : 0));
    }

    function midpoint(a, b) {
      return L.latLng((a.lat + b.lat) / 2, (a.lng + b.lng) / 2);
    }

    /**
     * Project {lat,lng} onto the segment a-b using planar lat/lng math.
     * Only used as a fallback when no route geometry is available.
     */
    function projectOnSegment(point, a, b) {
      const x = point.lng;
      const y = point.lat;
      const x0 = a.lng;
      const y0 = a.lat;
      const dx = b.lng - x0;
      const dy = b.lat - y0;
      const len2 = dx * dx + dy * dy;
      let t = len2 < EPS ? 0 : ((x - x0) * dx + (y - y0) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      return { lat: y0 + t * dy, lng: x0 + t * dx, t };
    }

    function distanceSq(p1, p2) {
      const dx = (p1.lng || 0) - (p2.lng || 0);
      const dy = (p1.lat || 0) - (p2.lat || 0);
      return dx * dx + dy * dy;
    }

    /**
     * Chord fallback: which straight segment between consecutive waypoints is
     * the point closest to. Returns { startWaypoint, endWaypoint, projected }.
     */
    function findNearestSegment(latlng, orderedWaypoints) {
      let best = null;
      let bestDist = Infinity;
      for (let i = 0; i < orderedWaypoints.length - 1; i++) {
        const a = orderedWaypoints[i];
        const b = orderedWaypoints[i + 1];
        const proj = projectOnSegment(latlng, a, b);
        const d2 = distanceSq(latlng, proj);
        if (d2 < bestDist) {
          bestDist = d2;
          best = { startWaypoint: a, endWaypoint: b, projected: proj, index: i };
        }
      }
      return best;
    }

    /**
     * Shaping points bend the route; they are not stops. MapManager passes the
     * detail straight to App.addWaypointOnRoute.
     */
    function notifyInsert(lat, lng, insertAfterWaypointId) {
      if (typeof config.onInsertWaypoint === 'function') {
        config.onInsertWaypoint({
          lat,
          lng,
          insertAfterWaypointId,
          type: 'via',
          name: 'Shape point',
        });
      }
    }

    /**
     * Locate each waypoint within the route polyline so legs can be walked.
     * OSRM hands back waypointIndices directly; otherwise fall back to a
     * monotonic nearest-vertex scan.
     */
    function computeLegIndices(routeLatLngs, orderedWaypoints, waypointIndices) {
      const n = orderedWaypoints.length;
      const last = routeLatLngs.length - 1;
      if (n < 2 || last < 1) return [];

      if (Array.isArray(waypointIndices) && waypointIndices.length === n) {
        const valid = waypointIndices.every((v, i) =>
          Number.isInteger(v) && v >= 0 && v <= last && (i === 0 || v >= waypointIndices[i - 1]));
        if (valid) return waypointIndices.slice();
      }

      const indices = [];
      let cursor = 0;
      for (let w = 0; w < n; w++) {
        const target = orderedWaypoints[w];
        let best = cursor;
        let bestD = Infinity;
        for (let i = cursor; i <= last; i++) {
          const d = planarD2(target, routeLatLngs[i]);
          if (d < bestD) { bestD = d; best = i; }
        }
        indices.push(best);
        cursor = best;
      }
      indices[0] = 0;
      indices[n - 1] = last;
      return indices;
    }

    /** The point half-way along the route between two vertex indices. */
    function pointAtHalfLength(routeLatLngs, startIdx, endIdx) {
      if (endIdx <= startIdx) return routeLatLngs[startIdx] || null;
      const segments = [];
      let total = 0;
      for (let i = startIdx; i < endIdx; i++) {
        const d = routeLatLngs[i].distanceTo(routeLatLngs[i + 1]);
        segments.push(d);
        total += d;
      }
      if (total <= 0) return routeLatLngs[startIdx];

      const half = total / 2;
      let walked = 0;
      for (let i = 0; i < segments.length; i++) {
        if (walked + segments[i] >= half) {
          const t = segments[i] > 0 ? (half - walked) / segments[i] : 0;
          const a = routeLatLngs[startIdx + i];
          const b = routeLatLngs[startIdx + i + 1];
          return L.latLng(a.lat + (b.lat - a.lat) * t, a.lng + (b.lng - a.lng) * t);
        }
        walked += segments[i];
      }
      return routeLatLngs[endIdx];
    }

    /**
     * Which waypoint should a new shaping point be inserted after? Decided
     * against the real route geometry so a hairpin leg doesn't get attributed
     * to the neighbouring straight-line chord.
     */
    function anchorWaypointIdFor(latlng) {
      const ordered = _lastWaypoints;
      if (ordered.length < 2) return null;

      if (_routeLatLngs.length >= 2 && _legIndices.length === ordered.length) {
        let best = 0;
        let bestD = Infinity;
        for (let i = 0; i < _routeLatLngs.length; i++) {
          const d = planarD2(latlng, _routeLatLngs[i]);
          if (d < bestD) { bestD = d; best = i; }
        }
        for (let leg = 0; leg < _legIndices.length - 1; leg++) {
          if (best <= _legIndices[leg + 1]) return ordered[leg].id;
        }
        return ordered[ordered.length - 2].id;
      }

      const hit = findNearestSegment(latlng, ordered);
      return hit ? hit.startWaypoint.id : null;
    }

    function createHandleMarker(latlng, startWaypoint) {
      const icon = L.divIcon({
        className: HANDLE_CLASS,
        iconSize: [20, 20],
        iconAnchor: [10, 10],
        html: `<div class="${HANDLE_CLASS}-inner" aria-hidden="true"></div>`,
      });

      const marker = L.marker(latlng, {
        icon,
        draggable: true,
        riseOnHover: true,
        autoPan: true,
        keyboard: true,
        title: 'Drag onto the road you want — adds a shaping point',
        pane: 'routeEditorPane',
      });

      let isDragging = false;

      const setDragClass = (on) => {
        const el = marker.getElement();
        if (!el) return;
        // Both names: the stylesheet has used each convention at different times.
        el.classList.toggle('is-dragging', on);
        el.classList.toggle(`${HANDLE_CLASS}--dragging`, on);
      };

      marker.on('dragstart', () => {
        isDragging = false;
        setDragClass(true);
      });

      marker.on('drag', () => {
        isDragging = true;
      });

      marker.on('dragend', () => {
        isDragging = true;
        setDragClass(false);
        const { lat, lng } = marker.getLatLng();
        notifyInsert(lat, lng, startWaypoint.id);
      });

      marker.on('click', (e) => {
        // Stop the click from bubbling to the map and adding a generic waypoint.
        if (e?.originalEvent) L.DomEvent.stopPropagation(e.originalEvent);
        // If a drag happened during this interaction, dragend already handled it.
        if (isDragging) return;
        notifyInsert(latlng.lat, latlng.lng, startWaypoint.id);
      });

      marker.on('keydown', (e) => {
        const key = e?.originalEvent?.key;
        if (key === 'Enter' || key === ' ') {
          if (e.originalEvent) L.DomEvent.stopPropagation(e.originalEvent);
          notifyInsert(latlng.lat, latlng.lng, startWaypoint.id);
        }
      });

      // Leaflet already makes the icon focusable (keyboard: true) — give it a
      // role and label rather than nesting a second focusable element inside.
      marker.on('add', () => {
        const el = marker.getElement();
        if (!el) return;
        el.setAttribute('role', 'button');
        el.setAttribute('aria-label', 'Add a shaping point on this part of the route');
      });

      return marker;
    }

    /**
     * Build an invisible, wide clickable line over the route so users can tap
     * anywhere along it to insert a shaping point at that exact spot.
     */
    function drawClickLine(latlngs) {
      if (!Array.isArray(latlngs) || latlngs.length < 2) return;
      clickLine = L.polyline(latlngs, {
        className: CLICK_LINE_CLASS,
        weight: 28,
        opacity: 0,
        fill: false,
        interactive: true,
        bubblingMouseEvents: false,
        pane: 'routeEditorPane',
      });

      clickLine.on('click', (e) => {
        if (!isEnabled()) return;
        const now = Date.now();
        if (now - lastClickTime < DOUBLE_TAP_GUARD_MS) return; // basic double-click guard
        lastClickTime = now;
        if (_lastWaypoints.length < 2) return;
        const anchorId = anchorWaypointIdFor(e.latlng);
        if (!anchorId) return;
        // Insert exactly where the user tapped: e.latlng is on the route
        // corridor, so it lands on the road rather than on a chord.
        notifyInsert(e.latlng.lat, e.latlng.lng, anchorId);
      });

      clickLine.addTo(map);
      // The corridor is fully transparent, and SVG hit-testing ignores an
      // unpainted stroke — ask for geometry-based hits explicitly so the
      // tap-to-shape affordance never depends on a stylesheet rule.
      const el = clickLine.getElement?.();
      if (el) el.style.pointerEvents = 'stroke';
    }

    /**
     * @param {Array} waypoints        trip waypoints (any order)
     * @param {Array} routeCoordinates the drawn route geometry
     * @param {Array} [waypointIndices] OSRM indices of each waypoint in that geometry
     */
    function update(waypoints, routeCoordinates, waypointIndices) {
      if (!isEnabled()) return;
      clear();

      const ordered = sortWaypoints(waypoints);
      _lastWaypoints = ordered;
      if (ordered.length < 2) return;

      _routeLatLngs = toLatLngs(routeCoordinates);
      _legIndices = _routeLatLngs.length >= 2
        ? computeLegIndices(_routeLatLngs, ordered, waypointIndices)
        : [];

      const onRoute = _legIndices.length === ordered.length;

      for (let i = 0; i < ordered.length - 1; i++) {
        const a = ordered[i];
        const b = ordered[i + 1];
        // Sit the handle on the road itself — on a twisty leg the chord
        // midpoint can be kilometres from the route.
        const position = onRoute
          ? pointAtHalfLength(_routeLatLngs, _legIndices[i], _legIndices[i + 1])
          : midpoint(a, b);
        if (!position) continue;
        const handle = createHandleMarker(position, a);
        handle.addTo(layerGroup);
        handles.push(handle);
      }

      drawClickLine(_routeLatLngs.length >= 2
        ? _routeLatLngs
        : ordered.map((w) => L.latLng(w.lat, w.lng)));
    }

    function clear() {
      if (clickLine) {
        map.removeLayer(clickLine);
        clickLine = null;
      }
      handles.forEach((h) => layerGroup.removeLayer(h));
      handles = [];
      _lastWaypoints = [];
      _routeLatLngs = [];
      _legIndices = [];
    }

    function destroy() {
      clear();
      map.removeLayer(layerGroup);
      const paneEl = map.getPane('routeEditorPane');
      if (paneEl) paneEl.remove();
    }

    return {
      update,
      clear,
      destroy,
      setEnabled,
      isEnabled,
      setReadOnly: (readonly) => setEnabled(!readonly),
      onInsertWaypoint(cb) {
        config.onInsertWaypoint = cb;
      },
    };
  }

  window.RouteEditor = { create };
})(window);
