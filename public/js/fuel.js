/**
 * FuelPlanner — pure fuel-range math for the fuel-planning feature.
 *
 * No DOM, no Leaflet: this file only does arithmetic over route coordinates
 * and waypoints, plus a thin persistence layer over Storage.KEYS.FUEL_STATE.
 * It is deliberately dependency-free (its own haversine, no RideUtils) so it
 * can be `require()`d and smoke-tested under plain node — see the export
 * guard at the bottom.
 *
 * Range model: the rider has `tankRangeKm` km of range on a full tank.
 * Remaining range depletes 1:1 with distance travelled along the route and
 * is reset to a full tank at any waypoint flagged `fuelStop` (never on
 * via/leg-break — those are route-shaping points, not stops, per the
 * waypoint contract enforced elsewhere in the app). Colour bands are fixed
 * thresholds on *remaining km* — they do not scale with tank size and are
 * independent of the rider's `fuelWarnMode` alert preference, which is a
 * separate concern layered on top of these bands elsewhere.
 */

/**
 * Haversine distance in meters. Same formula/style as RideUtils.haversine
 * (public/js/utils.js) and haversineMeters (api/gh.js), duplicated locally
 * on purpose so this file has zero runtime dependencies.
 */
function _haversineMeters(a, b) {
  const A = _pt(a);
  const B = _pt(b);
  const toRad = (v) => (v * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(B.lat - A.lat);
  const dLng = toRad(B.lng - A.lng);
  const lat1 = toRad(A.lat);
  const lat2 = toRad(B.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Normalize a point given as {lat,lng} or [lat,lng] into {lat,lng}. Mirrors RideUtils._pt. */
function _pt(v) {
  if (!v) return { lat: 0, lng: 0 };
  const lat = v.lat ?? v[0] ?? 0;
  const lng = v.lng ?? v[1] ?? 0;
  return { lat, lng };
}

const FuelPlanner = {
  /**
   * Fixed colour bands by remaining range (km): ok >100, warn <=100,
   * low <=50, critical <=20, empty <=0. Never throws, never returns NaN —
   * any non-finite input is treated as the most cautious state ('empty').
   */
  levelForRemaining(km) {
    if (!Number.isFinite(km) || km <= 0) return 'empty';
    if (km <= 20) return 'critical';
    if (km <= 50) return 'low';
    if (km <= 100) return 'warn';
    return 'ok';
  },

  /**
   * Build a fuel-range profile over a route from `startAtIdx` to the end.
   *
   * @param {object} opts
   * @param {Array}  opts.coordinates   Route points, [{lat,lng}] or [[lat,lng]].
   * @param {Array}  [opts.waypoints]   Trip waypoints; only entries with
   *                                    `fuelStop === true` (never via/leg-break)
   *                                    act as tank refills. A stop whose
   *                                    nearest route coordinate is behind
   *                                    `startAtIdx` is already passed and is
   *                                    ignored, never snapped forward.
   * @param {number} opts.tankRangeKm   Km of range on a full tank. Must be > 0.
   * @param {number} opts.startPercent  Fuel percent (0-100) at startAtIdx.
   * @param {number} [opts.startAtIdx=0] Coordinate index the profile starts
   *                                     from (e.g. the rider's live position).
   *
   * @returns {{
   *   totalKm: number,            // full route distance, independent of startAtIdx
   *   segments: Array<{from:number,to:number,level:string}>, // a strict,
   *              // non-overlapping partition of [startAtIdx, coordinates.length-1]
   *              // (each index belongs to exactly one segment; adjacent
   *              // same-level runs merged) so the 'empty' segment's `from`
   *              // is always exactly dryPointIdx. A caller drawing this as
   *              // a multi-colour polyline should extend each slice by one
   *              // coordinate at its shared boundary (e.g. coordinates.slice(from, to+2))
   *              // to avoid a one-edge gap between adjacent segments.
   *   fills: Array<{coordIdx:number, waypointId?:*, offRouteKm?:number}>,
   *   dryPointIdx: number|null,  // first coordinate index where remaining <=0, or null
   *   remainingAtEndKm: number,  // remaining range at the last coordinate
   *   tankRangeKm: number,       // echoes opts.tankRangeKm
   *   startPercent: number,      // echoes opts.startPercent
   *   startAtIdx: number         // the clamped startAtIdx actually used (== segments[0].from)
   * }}
   *
   * The last three fields exist so refuelSearchPoints() (below) can rebuild
   * per-span remaining-range math from just {profile, coordinates} without
   * this function having to also return a whole `remaining[]` array. No
   * other caller needs them — map.js's overlay only reads the five fields
   * documented above them.
   *
   * Guards: fewer than 2 coordinates, a missing/non-positive tankRangeKm, or
   * a startPercent outside 0-100 all return an inert
   * { totalKm:0, segments:[], fills:[], dryPointIdx:null, remainingAtEndKm:0 }
   * shape (deliberately WITHOUT the three echoed fields — there is no valid
   * value to put in them, and refuelSearchPoints treats their absence as
   * "inert input", same as everything else here). Never throws, never
   * returns NaN anywhere in the result.
   */
  computeProfile(opts) {
    const o = opts || {};
    const coordinates = o.coordinates;
    const waypoints = o.waypoints;
    const tankRangeKm = o.tankRangeKm;
    const startPercent = o.startPercent;

    const inert = () => ({ totalKm: 0, segments: [], fills: [], dryPointIdx: null, remainingAtEndKm: 0 });

    if (!Array.isArray(coordinates) || coordinates.length < 2) return inert();
    if (typeof tankRangeKm !== 'number' || !Number.isFinite(tankRangeKm) || tankRangeKm <= 0) return inert();
    if (typeof startPercent !== 'number' || !Number.isFinite(startPercent) || startPercent < 0 || startPercent > 100) return inert();

    const n = coordinates.length;
    let startAtIdx = Number.isFinite(o.startAtIdx) ? Math.floor(o.startAtIdx) : 0;
    if (startAtIdx < 0) startAtIdx = 0;
    if (startAtIdx > n - 1) startAtIdx = n - 1;

    // Per-edge distance (km) across the WHOLE route, sanitized so one
    // malformed coordinate can never poison the cumulative sum with NaN.
    const segKm = new Array(n).fill(0);
    let totalKm = 0;
    for (let i = 1; i < n; i++) {
      const m = _haversineMeters(coordinates[i - 1], coordinates[i]);
      const d = Number.isFinite(m) ? m / 1000 : 0;
      segKm[i] = d;
      totalKm += d;
    }

    // Fuel-stop waypoints -> fill points, snapped to the nearest coordinate
    // at index >= startAtIdx. via/leg-break are excluded defensively (same
    // exclusion used for _wpAlong in ride-controller.js) even though the UI
    // should never set fuelStop on them.
    const fills = [];
    if (Array.isArray(waypoints)) {
      for (const wp of waypoints) {
        if (!wp || wp.fuelStop !== true) continue;
        if (wp.type === 'via' || wp.type === 'leg-break') continue;
        if (typeof wp.lat !== 'number' || typeof wp.lng !== 'number' ||
            !Number.isFinite(wp.lat) || !Number.isFinite(wp.lng)) continue;

        // Snap over the WHOLE route, then drop anything that lands behind
        // startAtIdx. Searching only i >= startAtIdx instead would snap a
        // stop the rider has already ridden past onto some coordinate ahead
        // of them and hand out a refill that is never going to happen — the
        // one failure mode of this feature that could strand someone.
        let bestIdx = -1;
        let bestM = Infinity;
        for (let i = 0; i < n; i++) {
          const d = _haversineMeters(wp, coordinates[i]);
          if (Number.isFinite(d) && d < bestM) {
            bestM = d;
            bestIdx = i;
          }
        }
        if (bestIdx === -1 || bestIdx < startAtIdx) continue;

        const fill = { coordIdx: bestIdx };
        if (wp.id !== undefined) fill.waypointId = wp.id;
        const offRouteKm = bestM / 1000;
        if (offRouteKm > 5) fill.offRouteKm = Math.round(offRouteKm * 10) / 10;
        fills.push(fill);
      }
    }
    fills.sort((a, b) => a.coordIdx - b.coordIdx);
    const fillIdx = new Set(fills.map((f) => f.coordIdx));

    // Simulate remaining range at every coordinate from startAtIdx forward.
    const remaining = new Array(n);
    let cur = tankRangeKm * (startPercent / 100);
    if (fillIdx.has(startAtIdx)) cur = tankRangeKm;
    remaining[startAtIdx] = cur;
    let dryPointIdx = cur <= 0 ? startAtIdx : null;

    for (let i = startAtIdx + 1; i < n; i++) {
      cur -= segKm[i];
      if (fillIdx.has(i)) {
        cur = tankRangeKm; // refuel overrides any dip (even to <=0) at this exact point
      } else if (dryPointIdx === null && cur <= 0) {
        dryPointIdx = i;
      }
      remaining[i] = cur;
    }

    // Run-length encode into contiguous same-level segments — a strict
    // partition (no shared indices) so 'empty' always begins exactly at
    // dryPointIdx, as promised above.
    const segments = [];
    let segStart = startAtIdx;
    let segLevel = this.levelForRemaining(remaining[startAtIdx]);
    for (let i = startAtIdx + 1; i < n; i++) {
      const lvl = this.levelForRemaining(remaining[i]);
      if (lvl !== segLevel) {
        segments.push({ from: segStart, to: i - 1, level: segLevel });
        segStart = i;
        segLevel = lvl;
      }
    }
    segments.push({ from: segStart, to: n - 1, level: segLevel });

    const endRemaining = remaining[n - 1];

    return {
      totalKm: Number.isFinite(totalKm) ? Math.round(totalKm * 100) / 100 : 0,
      segments,
      fills,
      dryPointIdx,
      remainingAtEndKm: Number.isFinite(endRemaining) ? Math.round(endRemaining * 100) / 100 : 0,
      tankRangeKm,
      startPercent,
      startAtIdx
    };
  },

  /**
   * Along-route points where a rider running this profile's tank should
   * start looking for fuel — one per fill-to-fill span (including the
   * implicit "start of profile" and "end of route" as span boundaries)
   * whose remaining range dips below 20% of tankRangeKm before the next
   * fill or the route ends. Contract §1 (cross-agent): consumed by
   * public/js/fuel-finder.js's "Find fuel" flow.
   *
   * Takes computeProfile()'s OWN return value plus the same `coordinates`
   * array that was passed to it — deliberately not raw options, so a caller
   * that already has a profile on hand (map.js's refreshFuelOverlay) never
   * has to recompute one just to get search points out of it. Distances are
   * re-derived from `coordinates` here rather than threading computeProfile's
   * internal per-coordinate `remaining[]` through, which is why
   * computeProfile echoes tankRangeKm/startPercent/startAtIdx on its result
   * (see the doc above) — those three plus `fills`/`dryPointIdx` are enough
   * to rebuild every span's starting range exactly.
   *
   * For each qualifying span the point sits where ~80% of that span's
   * starting range has been consumed (i.e. ~20% remaining) — clamped to
   * strictly before the span's dry point, though that clamp is never
   * actually reachable by construction (80% consumed always precedes the
   * 100%-consumed dry point for any positive range).
   *
   * @param {object} profile      Return value of computeProfile().
   * @param {Array}  coordinates  The SAME coordinates array passed to the
   *                               computeProfile() call that produced `profile`.
   * @returns {Array<{lat:number, lng:number, coordIdx:number,
   *                   kmFromStart:number, remainingKmAtPoint:number}>}
   *          Empty when nothing qualifies or the inputs are inert. Never
   *          throws, never returns NaN in any entry.
   */
  refuelSearchPoints(profile, coordinates) {
    if (!profile || !Array.isArray(profile.segments) || !profile.segments.length) return [];
    if (!Array.isArray(profile.fills)) return [];
    if (!Array.isArray(coordinates) || coordinates.length < 2) return [];

    const tankRangeKm = profile.tankRangeKm;
    if (typeof tankRangeKm !== 'number' || !Number.isFinite(tankRangeKm) || tankRangeKm <= 0) return [];

    const n = coordinates.length;
    const startAtIdx = Number.isFinite(profile.startAtIdx) ? profile.startAtIdx : profile.segments[0].from;
    if (!Number.isFinite(startAtIdx) || startAtIdx < 0 || startAtIdx > n - 1) return [];
    const startPercent = Number.isFinite(profile.startPercent) ? profile.startPercent : 100;

    // Cumulative km from coordinates[0] — recomputed here (not shared with
    // computeProfile's internal segKm, which isn't part of its return value
    // by design) but the same sanitize-per-edge approach.
    const cum = new Array(n).fill(0);
    for (let i = 1; i < n; i++) {
      const m = _haversineMeters(coordinates[i - 1], coordinates[i]);
      cum[i] = cum[i - 1] + (Number.isFinite(m) ? m / 1000 : 0);
    }

    const startedFull = profile.fills.some((f) => f && f.coordIdx === startAtIdx);
    const startRangeKm = startedFull ? tankRangeKm : tankRangeKm * (startPercent / 100);

    const sortedFills = profile.fills
      .filter((f) => f && Number.isFinite(f.coordIdx) && f.coordIdx >= startAtIdx && f.coordIdx <= n - 1)
      .slice()
      .sort((a, b) => a.coordIdx - b.coordIdx);

    // Fill-to-fill spans: [startAtIdx→fill1], [fill1→fill2], …, [lastFill→end].
    // Every fill resets the span's starting range to a full tank, mirroring
    // computeProfile's own "refuel overrides any dip" rule.
    const spans = [];
    let spanStart = startAtIdx;
    let rangeAvailable = startRangeKm;
    for (const f of sortedFills) {
      if (f.coordIdx > spanStart) spans.push({ start: spanStart, end: f.coordIdx, rangeAvailable });
      spanStart = f.coordIdx;
      rangeAvailable = tankRangeKm;
    }
    if (n - 1 > spanStart) spans.push({ start: spanStart, end: n - 1, rangeAvailable });

    const threshold = 0.2 * tankRangeKm;
    const points = [];

    spans.forEach((span) => {
      const spanStartKm = cum[span.start];
      const remainingAt = (i) => span.rangeAvailable - (cum[i] - spanStartKm);

      let qualifies = false;
      for (let i = span.start; i <= span.end; i++) {
        if (remainingAt(i) < threshold) { qualifies = true; break; }
      }
      if (!qualifies || !(span.rangeAvailable > 0)) return;

      const targetConsumed = 0.8 * span.rangeAvailable;
      // First coordinate at/after 80% of this span's range has been burned.
      let foundIdx = span.end;
      for (let i = span.start; i <= span.end; i++) {
        if (cum[i] - spanStartKm >= targetConsumed) { foundIdx = i; break; }
      }

      // Clamp strictly before this span's dry point, if one exists inside it
      // — structurally unreachable (80% consumed < 100% consumed = dry) but
      // kept as the defensive guard the contract calls for.
      const dryIdx = profile.dryPointIdx;
      if (Number.isFinite(dryIdx) && dryIdx >= span.start && dryIdx <= span.end && foundIdx >= dryIdx) {
        foundIdx = Math.max(span.start, dryIdx - 1);
      }

      const coord = _pt(coordinates[foundIdx]);
      const remainingKmAtPoint = Math.round(remainingAt(foundIdx) * 100) / 100;
      points.push({
        lat: coord.lat,
        lng: coord.lng,
        coordIdx: foundIdx,
        kmFromStart: Math.round(cum[foundIdx] * 100) / 100,
        remainingKmAtPoint: Number.isFinite(remainingKmAtPoint) ? remainingKmAtPoint : 0
      });
    });

    return points;
  },

  /**
   * Current device-local fuel-tank state, { percent, updatedAt }. Defaults
   * to a full tank so a rider who has never touched fuel settings isn't
   * warned about fuel they haven't told the app anything about. Falls back
   * to the same default if Storage isn't loaded (e.g. under plain node).
   */
  getState() {
    if (typeof Storage !== 'undefined' && typeof Storage.getFuelState === 'function') {
      return Storage.getFuelState();
    }
    return { percent: 100, updatedAt: null };
  },

  /** Set the tank's fuel percent (clamped 0-100) and persist it. */
  setPercent(p) {
    const num = Number(p);
    const percent = Number.isFinite(num) ? Math.max(0, Math.min(100, num)) : 0;
    const state = { percent, updatedAt: new Date().toISOString() };
    if (typeof Storage !== 'undefined' && typeof Storage.saveFuelState === 'function') {
      Storage.saveFuelState(state);
    }
    return state;
  },

  /** Refill the tank to 100%. */
  tankFilled() {
    return this.setPercent(100);
  }
};

// Classic script in the browser (window.FuelPlanner, per this codebase's
// convention); also CommonJS-exported so this pure module can be
// `require()`d and smoke-tested under plain node with no browser globals.
if (typeof window !== 'undefined') {
  window.FuelPlanner = FuelPlanner;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = FuelPlanner;
}
