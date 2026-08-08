/**
 * Shared utility functions — used by multiple controllers and modules.
 * Loaded before all controllers so functions are globally available.
 */
const RideUtils = {
  /**
   * Display units for distance/speed — 'metric' or 'imperial'. Defaults from
   * the browser locale (en-US/en-GB ride in miles); a caller can override by
   * assigning RideUtils.units before the next format call.
   */
  units: (() => {
    try {
      const lang = (navigator.language || '').toLowerCase();
      return (lang.startsWith('en-us') || lang.startsWith('en-gb')) ? 'imperial' : 'metric';
    } catch (_) {
      return 'metric';
    }
  })(),

  /** Normalize a point given as {lat, lng} or [lat, lng] into {lat, lng}. */
  _pt(v) {
    return { lat: v?.lat ?? v?.[0] ?? 0, lng: v?.lng ?? v?.[1] ?? 0 };
  },

  /**
   * Haversine distance (meters) between two points.
   * Accepts {lat, lng}, [lat, lng], or any object with lat/lng properties.
   */
  haversine(a, b) {
    const toRad = (v) => v * Math.PI / 180;
    const R = 6371000;
    const A = this._pt(a);
    const B = this._pt(b);
    const dLat = toRad(B.lat - A.lat);
    const dLng = toRad(B.lng - A.lng);
    const lat1 = toRad(A.lat);
    const lat2 = toRad(B.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  },

  /**
   * Distance (meters) from point p to the segment a→b, computed in a local
   * equirectangular frame centred on `a` — plenty accurate for the short
   * segments of a route polyline. Returns:
   *   { dist, t, point }
   * where t is the clamped projection parameter (0 = at a, 1 = at b) and
   * point is the closest {lat, lng} on the segment.
   */
  pointToSegmentDistance(p, a, b) {
    const toRad = (v) => v * Math.PI / 180;
    const R = 6371000;
    const P = this._pt(p);
    const A = this._pt(a);
    const B = this._pt(b);
    const mPerDeg = Math.PI * R / 180;
    const cosLat = Math.cos(toRad(A.lat));
    const px = (P.lng - A.lng) * cosLat * mPerDeg;
    const py = (P.lat - A.lat) * mPerDeg;
    const bx = (B.lng - A.lng) * cosLat * mPerDeg;
    const by = (B.lat - A.lat) * mPerDeg;
    const segLenSq = bx * bx + by * by;
    let t = segLenSq > 0 ? (px * bx + py * by) / segLenSq : 0;
    t = Math.max(0, Math.min(1, t));
    const dx = px - t * bx;
    const dy = py - t * by;
    return {
      dist: Math.sqrt(dx * dx + dy * dy),
      t,
      point: { lat: A.lat + (B.lat - A.lat) * t, lng: A.lng + (B.lng - A.lng) * t }
    };
  },

  /** Initial great-circle bearing from a to b, degrees clockwise from north (0–360). */
  bearing(a, b) {
    const toRad = (v) => v * Math.PI / 180;
    const A = this._pt(a);
    const B = this._pt(b);
    const lat1 = toRad(A.lat);
    const lat2 = toRad(B.lat);
    const dLng = toRad(B.lng - A.lng);
    const y = Math.sin(dLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  },

  /** Format distance in meters to a human-readable string, honoring RideUtils.units. */
  formatDistance(meters) {
    if (!meters && meters !== 0) return '—';
    if (this.units === 'imperial') {
      const feet = meters * 3.28084;
      if (feet < 528) return Math.round(feet) + ' ft'; // < 0.1 mi
      return (meters / 1609.344).toFixed(1) + ' mi';
    }
    if (meters >= 1000) return (meters / 1000).toFixed(1) + ' km';
    return Math.round(meters) + ' m';
  },

  /** Format duration in seconds to human-readable string */
  formatDuration(seconds) {
    if (!seconds && seconds !== 0) return '—';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes} min`;
  },

  /** Unit label for the live speed readout ('mph' or 'km/h'). */
  speedUnitLabel() { return this.units === 'imperial' ? 'mph' : 'km/h'; },

  /** Convert a speed in m/s to the current display unit (mph or km/h). */
  speedFromMps(mps) { return this.units === 'imperial' ? mps * 2.23694 : mps * 3.6; }
};

window.RideUtils = RideUtils;
