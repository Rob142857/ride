/** Pure geometry and request-lifecycle helpers for ride navigation. */
(function exposeRideNavigation(root) {
  const EARTH_RADIUS_M = 6371000;
  const metricsCache = new WeakMap();
  const waypointAnchorCache = new WeakMap();

  function point(value) {
    // Route codec and OSRM geometry use GeoJSON order: [longitude, latitude].
    if (Array.isArray(value)) return { lat: Number(value[1]), lng: Number(value[0]) };
    return { lat: Number(value?.lat), lng: Number(value?.lng) };
  }

  function validPoint(value) {
    const p = point(value);
    return Number.isFinite(p.lat) && Number.isFinite(p.lng) && p.lat >= -90 && p.lat <= 90 && p.lng >= -180 && p.lng <= 180;
  }

  function isUsableNavigationFix(pos, now = Date.now()) {
    if (!validPoint(pos)) return false;
    const accuracy = Number(pos.accuracy);
    const timestamp = Number(pos.timestamp);
    return Number.isFinite(accuracy) && accuracy >= 0 && accuracy <= 50 &&
      Number.isFinite(timestamp) && timestamp <= now + 120000 && now - timestamp <= 30000;
  }

  function distance(a, b) {
    const p = point(a), q = point(b);
    const rad = Math.PI / 180;
    const dLat = (q.lat - p.lat) * rad;
    const dLng = (q.lng - p.lng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(p.lat * rad) * Math.cos(q.lat * rad) * Math.sin(dLng / 2) ** 2;
    return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  function routeMetrics(route) {
    if (route && typeof route === 'object' && metricsCache.has(route)) return metricsCache.get(route);
    const coordinates = (route?.coordinates || []).map(point).filter(p => validPoint(p));
    const cumulative = [0];
    for (let i = 1; i < coordinates.length; i++) cumulative.push(cumulative[i - 1] + distance(coordinates[i - 1], coordinates[i]));
    const metrics = { coordinates, cumulative, total: cumulative[cumulative.length - 1] || 0 };
    if (route && typeof route === 'object') metricsCache.set(route, metrics);
    return metrics;
  }

  // Project in a local tangent plane. It works well for the short segments in
  // road geometry and gives both a perpendicular distance and along-route m.
  function projectOnSegment(pos, a, b, startMeters) {
    const p = point(pos), p1 = point(a), p2 = point(b);
    const rad = Math.PI / 180;
    const scaleX = Math.cos(p.lat * rad) * EARTH_RADIUS_M * rad;
    const scaleY = EARTH_RADIUS_M * rad;
    const ax = (p1.lng - p.lng) * scaleX, ay = (p1.lat - p.lat) * scaleY;
    const bx = (p2.lng - p.lng) * scaleX, by = (p2.lat - p.lat) * scaleY;
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    const t = lenSq ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lenSq)) : 0;
    const length = Math.sqrt(lenSq);
    return { distance: Math.hypot(ax + t * dx, ay + t * dy), progress: startMeters + length * t, segmentIndex: 0, fraction: t };
  }

  function projectCandidates(route, pos) {
    const { coordinates, cumulative } = routeMetrics(route);
    if (!validPoint(pos) || coordinates.length < 2) return [];
    return coordinates.slice(1).map((p, index) => {
      const projected = projectOnSegment(pos, coordinates[index], p, cumulative[index]);
      projected.segmentIndex = index;
      return projected;
    }).sort((a, b) => a.distance - b.distance || a.progress - b.progress);
  }

  function nearestCandidate(route, pos, predicate = () => true, startIndex = 0, endIndex = Infinity) {
    const { coordinates, cumulative } = routeMetrics(route);
    if (!validPoint(pos) || coordinates.length < 2) return null;
    let best = null;
    const first = Math.max(0, Math.min(coordinates.length - 2, Math.floor(startIndex)));
    const last = Math.max(first, Math.min(coordinates.length - 2, Math.floor(endIndex)));
    let segmentsScanned = 0;
    for (let index = first; index <= last; index++) {
      segmentsScanned++;
      const candidate = projectOnSegment(pos, coordinates[index], coordinates[index + 1], cumulative[index]);
      candidate.segmentIndex = index;
      if (predicate(candidate) && (!best || candidate.distance < best.distance ||
          (candidate.distance === best.distance && candidate.progress < best.progress))) best = candidate;
    }
    if (best) best.segmentsScanned = segmentsScanned;
    return best;
  }

  function segmentAtProgress(cumulative, progress) {
    let low = 0, high = cumulative.length - 1;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (cumulative[mid] < progress) low = mid + 1;
      else high = mid;
    }
    return Math.max(0, Math.min(cumulative.length - 2, low - (cumulative[low] > progress ? 1 : 0)));
  }

  function projectProgress(route, pos, previousProgress = null, options = {}) {
    const { cumulative, coordinates } = routeMetrics(route);
    const hasPrevious = Number.isFinite(previousProgress);
    const gap = !!options.gpsGap;
    let nearest;
    if (hasPrevious && !gap && coordinates.length >= 2) {
      const requestedWindow = Number(options.maxForwardMeters);
      const maxForward = Math.max(100, Number.isFinite(requestedWindow) ? requestedWindow : 250);
      const floorProgress = Math.max(0, previousProgress - 120);
      const ceilingProgress = Math.min(cumulative[cumulative.length - 1], previousProgress + maxForward);
      const first = Math.max(0, segmentAtProgress(cumulative, floorProgress) - 2);
      const last = Math.min(coordinates.length - 2, segmentAtProgress(cumulative, ceilingProgress) + 2);
      const localWindow = nearestCandidate(route, pos, candidate => candidate.distance <= Math.max(100, (Number(pos?.accuracy) || 0) * 2) &&
        candidate.progress >= floorProgress && candidate.progress <= ceilingProgress, first, last);
      if (localWindow) return { ...localWindow, ambiguous: false, usedLocalWindow: true };
    }
    if (!nearest) nearest = nearestCandidate(route, pos);
    if (!nearest) return null;
    const accuracyValue = Number(pos?.accuracy);
    const accuracy = Number.isFinite(accuracyValue) ? Math.max(0, accuracyValue) : 0;
    if (!Number.isFinite(previousProgress)) {
      const tolerance = Math.max(12, Math.min(accuracy * 0.5, 60));
      const other = nearestCandidate(route, pos, candidate => Math.abs(candidate.progress - nearest.progress) > 250 && candidate.distance <= nearest.distance + tolerance);
      return { ...nearest, ambiguous: !!other };
    }

    const requestedWindow = Number(options.maxForwardMeters);
    const maxForward = gap ? 5000 : Math.max(100, Number.isFinite(requestedWindow) ? requestedWindow : 250);
    const floor = Math.max(0, previousProgress - 35);
    const ceiling = previousProgress + maxForward;
    const local = gap ? nearestCandidate(route, pos, candidate => candidate.progress >= floor && candidate.progress <= ceiling &&
      candidate.distance <= Math.max(100, accuracy * 2)) : null;
    // Full-route recovery is reserved for joining, a long GPS gap, or fixes
    // that do not plausibly match the ordinary local window.
    if (local) return { ...local, ambiguous: false, usedGlobalFallback: true };
    return { ...nearest, ambiguous: false, usedGlobalFallback: true };
  }

  function orderedWaypoints(waypoints) {
    return (waypoints || []).filter(validPoint).slice().sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
  }

  function locateWaypointOnRoute(route, waypoint, minimumProgress = 0) {
    return nearestCandidate(route, waypoint, candidate => candidate.progress >= minimumProgress);
  }

  function waypointAnchors(route, waypoints) {
    const ordered = orderedWaypoints(waypoints);
    const key = ordered.map(wp => `${wp.id ?? ''}:${Number(wp.order) || 0}:${Number(wp.lat).toFixed(6)}:${Number(wp.lng).toFixed(6)}`).join('|');
    let cache = waypointAnchorCache.get(route);
    if (!cache) { cache = new Map(); waypointAnchorCache.set(route, cache); }
    if (cache.has(key)) return cache.get(key);
    let lastPosition = -1;
    const anchors = ordered.map(waypoint => {
      const occurrence = locateWaypointOnRoute(route, waypoint, lastPosition < 0 ? 0 : lastPosition + 1);
      if (occurrence) lastPosition = occurrence.progress;
      return { waypoint, occurrence };
    });
    cache.set(key, anchors);
    return anchors;
  }

  function inferNextStop(route, waypoints, position, previousProgress = null, visitedIds = null, options = {}) {
    const { total } = routeMetrics(route);
    const current = options.projection || projectProgress(route, position, previousProgress, options);
    if (!current) return { progress: null, nextWaypoint: orderedWaypoints(waypoints)[0] || null, distance: Infinity, ambiguous: false };
    const progress = Number.isFinite(previousProgress) ? Math.max(previousProgress, current.progress) : current.progress;
    const visited = visitedIds instanceof Set ? visitedIds : new Set(visitedIds || []);
    const inferredVisitedIds = [];
    for (const { waypoint, occurrence } of waypointAnchors(route, waypoints)) {
      if (!occurrence || visited.has(waypoint.id)) continue;
      if (occurrence.progress > progress + 35) return { progress: Math.min(progress, total), nextWaypoint: waypoint, distance: occurrence.progress - progress, waypointProgress: occurrence.progress, ambiguous: current.ambiguous, inferredVisitedIds };
      if (distance(position, waypoint) <= 45 || occurrence.progress >= progress - 35) {
        return { progress: Math.min(progress, total), nextWaypoint: waypoint, distance: Math.max(0, occurrence.progress - progress), waypointProgress: occurrence.progress, ambiguous: current.ambiguous, inferredVisitedIds };
      }
      inferredVisitedIds.push(waypoint.id);
    }
    return { progress: Math.min(progress, total), nextWaypoint: null, distance: Math.max(0, total - progress), waypointProgress: total, ambiguous: current.ambiguous, inferredVisitedIds };
  }

  function sliceRoute(route, startProgress, endProgress) {
    const metrics = routeMetrics(route);
    if (metrics.coordinates.length < 2) return [];
    const start = Math.max(0, Math.min(metrics.total, Number(startProgress) || 0));
    const end = Math.max(start, Math.min(metrics.total, Number.isFinite(endProgress) ? endProgress : metrics.total));
    const startCandidate = interpolateAt(metrics, start);
    const endCandidate = interpolateAt(metrics, end);
    const result = [startCandidate];
    metrics.coordinates.forEach((coordinate, index) => {
      if (metrics.cumulative[index] > start && metrics.cumulative[index] < end) result.push(coordinate);
    });
    if (end - start > 0.5) result.push(endCandidate);
    return result;
  }

  function interpolateAt(metrics, progress) {
    let index = 0;
    while (index < metrics.cumulative.length - 2 && metrics.cumulative[index + 1] < progress) index++;
    const a = metrics.coordinates[index], b = metrics.coordinates[index + 1];
    const segmentLength = metrics.cumulative[index + 1] - metrics.cumulative[index];
    const t = segmentLength ? Math.max(0, Math.min(1, (progress - metrics.cumulative[index]) / segmentLength)) : 0;
    return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
  }

  function pointAtProgress(route, progress) {
    const metrics = routeMetrics(route);
    if (metrics.coordinates.length < 2 || !Number.isFinite(progress)) return null;
    return interpolateAt(metrics, Math.max(0, Math.min(metrics.total, progress)));
  }

  function mapStepsToLeg(route, startProgress, endProgress) {
    const metrics = routeMetrics(route);
    const start = Math.max(0, Number(startProgress) || 0);
    const end = Math.max(start, Number.isFinite(endProgress) ? Number(endProgress) : metrics.total);
    const steps = (route?.steps || []).map(step => {
      const sourceIndex = Math.max(0, Math.min(metrics.cumulative.length - 1, Number(step.index) || 0));
      const progress = metrics.cumulative[sourceIndex];
      if (progress < start - 1 || progress > end + 1) return null;
      const index = Math.max(0, segmentAtProgress(metrics.cumulative, Math.max(start, progress)) - segmentAtProgress(metrics.cumulative, start));
      return { ...step, index, _routeProgress: progress };
    }).filter(Boolean);
    return steps;
  }

  function routeFingerprint(route) {
    let hash = 2166136261;
    for (const coordinate of routeMetrics(route).coordinates) {
      const value = `${coordinate.lat.toFixed(6)},${coordinate.lng.toFixed(6)};`;
      for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
    }
    return (hash >>> 0).toString(16);
  }

  function requestContext(sessionId, tripId, requestId) { return { sessionId, tripId, requestId }; }
  function isCurrentRequest(context, current) {
    return !!context && !!current && context.sessionId === current.sessionId && context.tripId === current.tripId && context.requestId === current.requestId;
  }

  const api = { distance, routeMetrics, projectCandidates, projectProgress, inferNextStop, sliceRoute, mapStepsToLeg, segmentAtProgress, pointAtProgress, routeFingerprint, isUsableNavigationFix, requestContext, isCurrentRequest };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.RideNavigation = api;
})(typeof window !== 'undefined' ? window : globalThis);
