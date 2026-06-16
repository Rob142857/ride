/**
 * Route Editor — visible, accessible controls for reshaping a route.
 *
 * Instead of relying on Leaflet Routing Machine's hidden/invisible waypoint
 * insertion, this module draws explicit midpoint drag handles on every segment
 * and a wide transparent click-line along the route. Dragging a handle inserts
 * a new waypoint at the drag location; tapping a handle inserts it at the
 * segment midpoint.
 *
 * All state lives in this module; map-level wiring is handled by MapManager.
 */
(function (window) {
  'use strict';

  const HANDLE_CLASS = 'route-midpoint-handle';
  const CLICK_LINE_CLASS = 'route-click-line';
  const EPS =1e-12;

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
    let handles =[];
    let lastClickTime = 0;

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
     * Good enough for local route editing.
     */
    function projectOnSegment(point, a, b) {
      const x = point.lng;
      const y = point.lat;
      const x0 = a.lng;
      const y0 = a.lat;
      const dx = b.lng - x0;
      const dy = b.lat - y0;
      const len2 = dx * dx + dy * dy;
      let t = len2 < EPS ?0 : ((x - x0) * dx + (y - y0) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      return {
        lat: y0 + t * dy,
        lng: x0 + t * dx,
        t,
      };
    }

    function distanceSq(p1, p2) {
      const dx = (p1.lng || 0) - (p2.lng || 0);
      const dy = (p1.lat || 0) - (p2.lat || 0);
      return dx * dx + dy * dy;
    }

    /**
     * Find which segment between consecutive waypoints the given lat/lng is
     * closest to. Returns { startWaypoint, endWaypoint, projected }.
     */
    function findNearestSegment(latlng, orderedWaypoints) {
      let best =null;
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

    function notifyInsert(lat, lng, insertAfterWaypointId) {
      if (typeof config.onInsertWaypoint === 'function') {
        config.onInsertWaypoint({ lat, lng, insertAfterWaypointId });
      }
    }

    function createHandleMarker(midLatLng, segmentIndex, startWaypoint) {
      const icon = L.divIcon({
        className: HANDLE_CLASS,
        iconSize: [20, 20],
        iconAnchor: [10, 10],
        html: `<div class="${HANDLE_CLASS}-inner" aria-label="Drag to add a waypoint" role="button" tabindex="0"></div>`,
      });

      const marker = L.marker(midLatLng, {
        icon,
        draggable: true,
        riseOnHover: true,
        autoPan: true,
        pane: 'routeEditorPane',
      });

      let isDragging = false;

      marker.on('dragstart', () => {
        isDragging = false;
        const el = marker.getElement();
        if (el) el.classList.add('is-dragging');
      });

      marker.on('drag', () => {
        isDragging = true;
      });

      marker.on('dragend', () => {
        isDragging = true;
        const el = marker.getElement();
        if (el) el.classList.remove('is-dragging');
        const { lat, lng } = marker.getLatLng();
        notifyInsert(lat, lng, startWaypoint.id);
      });

      marker.on('click', (e) => {
        // Stop the click from bubbling to the map and adding a generic waypoint.
        if (e?.originalEvent) L.DomEvent.stopPropagation(e.originalEvent);
        // If a drag happened during this interaction, the dragend already handled it.
        if (isDragging) return;
        const { lat, lng } = midLatLng;
        notifyInsert(lat, lng, startWaypoint.id);
      });

      marker.on('keydown', (e) => {
        if (e?.originalEvent?.key === 'Enter' || e?.originalEvent?.key === ' ') {
          if (e.originalEvent) L.DomEvent.stopPropagation(e.originalEvent);
          const { lat, lng } = midLatLng;
          notifyInsert(lat, lng, startWaypoint.id);
        }
      });

      return marker;
    }

    /**
     * Build an invisible, wide clickable line over the route so users can tap
     * anywhere along a segment to insert a waypoint at the nearest projected
     * point.
     */
    function drawClickLine(latlngs) {
      if (!Array.isArray(latlngs) || latlngs.length < 2) return;
      clickLine = L.polyline(latlngs, {
        className: CLICK_LINE_CLASS,
        weight:28,
        opacity: 0,
        fill: false,
        interactive: true,
        bubblingMouseEvents: false,
        pane: 'routeEditorPane',
      });

      clickLine.on('click', (e) => {
        if (!isEnabled()) return;
        const now = Date.now();
        if (now - lastClickTime <350) return; // basic double-click guard
        lastClickTime = now;
        const ordered = sortWaypoints(_lastWaypoints);
        if (ordered.length < 2) return;
        const hit = findNearestSegment(e.latlng, ordered);
        if (!hit) return;
        const { lat, lng } = hit.projected;
        notifyInsert(lat, lng, hit.startWaypoint.id);
      });

      clickLine.addTo(map);
    }

    let _lastWaypoints = [];

    function update(waypoints, routeCoordinates) {
      if (!isEnabled()) return;
      clear();
      const ordered = sortWaypoints(waypoints);
      _lastWaypoints = ordered;

      if (ordered.length < 2) return;

      // Draw midpoint handles for every segment between consecutive waypoints.
      for (let i = 0; i < ordered.length - 1; i++) {
        const a = ordered[i];
        const b = ordered[i + 1];
        const mid = midpoint(a, b);
        const handle = createHandleMarker(mid, i, a);
        handle.addTo(layerGroup);
        handles.push(handle);
      }

      // Build a clickable line from actual route coordinates if available,
      // otherwise straight chords between waypoints.
      const lineCoords = Array.isArray(routeCoordinates) && routeCoordinates.length >= 2
        ? routeCoordinates.map((p) => (p?.lat !== undefined ? L.latLng(p.lat, p.lng) : L.latLng(p[1], p[0])))
        : ordered.map((w) => L.latLng(w.lat, w.lng));
      drawClickLine(lineCoords);
    }

    function clear() {
      if (clickLine) {
        map.removeLayer(clickLine);
        clickLine = null;
      }
      handles.forEach((h) => layerGroup.removeLayer(h));
      handles = [];
      _lastWaypoints = [];
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
