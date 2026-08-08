/**
 * GraphHopper routing proxy — the "windy" engine (scenic-routing plan §B2/#3).
 *
 * GraphHopper itself IS the windy engine: there is no separate "windy via
 * OSRM" mode. Fastest always means OSRM (called straight from the client via
 * L.Routing.osrmv1, see public/js/map.js); this endpoint is only reached when
 * trip.settings.routing.mode === 'windy'.
 *
 * Not behind requireAuth — guests plan trips too — but IP rate-limited by the
 * router (see api/worker.js: rateLimitByIp('gh-route', 60)). The tuned
 * custom_model lives here, server-side, so the routing policy never ships to
 * the client.
 *
 * GraphHopper is live now (v12.0, self-hosted — see infra/gh-config.yml and
 * infra/docker-compose.yml), but it can still be down, slow or refuse a model,
 * so every branch here must resolve to the clean 502 shape below, never throw
 * or 500: the client turns a 502 into "showing fastest" plus a toast
 * (public/js/map.js), while a 500 or a throw surfaces as a broken experience.
 */

import { readJsonBody } from './handler-utils.js';
import { jsonResponse } from './utils.js';

/** Fallback if env.GH_SERVICE_URL isn't configured yet — works either way. */
const DEFAULT_GH_BASE_URL = 'https://gh.incitat.io';

/**
 * Upstream budget for one windy route. Windy runs flexible + landmarks
 * (ch.disable plus a per-request custom_model), not CH, and penalizing the
 * motorway/trunk corridor widens the search well past the ~78k nodes a plain
 * fastest Sydney->Melbourne visits, so the original 12s was optimistic for
 * interstate trips. 25s is the ceiling worth honouring: awaiting a subrequest
 * is I/O, not CPU, so the Worker CPU limit is not the binding one — Cloudflare's
 * 100s edge timeout (524) is, and we stay far inside it. It doubles as the UX
 * ceiling, since the client sets no timeout of its own and just waits for us
 * (public/js/map.js _routeSegmentGH) before the fastest-route fallback.
 */
const FETCH_TIMEOUT_MS = 25000;

/**
 * Mean absolute bearing change per kilometre over the geometry — identical
 * formula to public/js/map.js's MapManager._curviness, kept in sync
 * deliberately so the "Windiest" badge reads the same regardless of which
 * engine answered (the client always recomputes this itself too; this value
 * is informational / for future server-side use, per contract #3).
 */
function haversineMeters(a, b) {
  const toRad = (v) => (v * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function bearingDegrees(a, b) {
  const toRad = (v) => (v * Math.PI) / 180;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function computeCurviness(coords) {
  if (!Array.isArray(coords) || coords.length < 3) return 0;
  const SAMPLE_M = 25; // ignore sub-25 m jitter between polyline vertices
  let anchor = coords[0];
  let prevBearing = null;
  let turned = 0;
  let distance = 0;

  for (let i = 1; i < coords.length; i++) {
    const seg = haversineMeters(anchor, coords[i]);
    if (seg < SAMPLE_M && i < coords.length - 1) continue;
    const b = bearingDegrees(anchor, coords[i]);
    distance += seg;
    if (prevBearing !== null) {
      let delta = Math.abs(b - prevBearing) % 360;
      if (delta > 180) delta = 360 - delta;
      turned += delta;
    }
    prevBearing = b;
    anchor = coords[i];
  }

  if (distance < 100) return 0;
  return turned / (distance / 1000);
}

/**
 * Custom model biasing GraphHopper toward bendy roads, per
 * docs/PLAN-scenic-routing-and-legs.md §A3. GH merges this onto the profile's
 * own model (infra/gh-config.yml: profiles[car].custom_model_files = [car.json])
 * by appending our statements to that model's, so a priority-only block is
 * valid: car.json keeps supplying access and speed.
 *
 * Two constraints come from the graph being prepared with landmarks and not CH
 * (profiles_lm) — a per-request model may only make edges *heavier* than the
 * prepared weights, so every multiply_by must sit in [0, 1] (we can demote a
 * road, never promote one) and distance_influence may not go below the base
 * model's. Both are hard 400s upstream if broken.
 *
 * Curvature direction (verified against GH's docs — do not flip it): curvature
 * is beeline-distance / way-distance, so 1.0 is dead straight and lower is
 * bendier, and `curvature > 0.9` therefore demotes near-straight edges, which
 * is exactly the intent. It is a 4-bit value over [0.25, 1.0], i.e. 0.05
 * buckets, so this threshold bites on the top two buckets only — retune in
 * 0.05 steps, and never below 0.30 or it would penalize everything.
 *
 * No distance_influence on purpose: car.json already sets 90 (seconds per km of
 * detour), the landmark rule means we could only raise it, and raising it makes
 * raw distance dominate the priority preference — it would flatten the scenic
 * bias rather than tame it. If windy routes ever wander absurdly far, the knob
 * to reach for is car.json's own value (a server change + reprepare), not this.
 */
function buildCustomModel(avoidMotorways) {
  return {
    priority: [
      // 0.01, never 0: priority 0 makes an edge unroutable *and* excludes it
      // from point snapping, so a trip that starts on an on-ramp, or crosses a
      // stretch where the motorway/trunk road is the only road (the
      // Nullarbor), would fail outright — no route, or point-not-found — and
      // drop the whole request to the fastest-route fallback, avoidance
      // included. At 0.01 an edge costs 100x its time: a near-absolute
      // deterrent that still degrades gracefully to "used it because there
      // was nothing else". The toggle reads "Avoid highways and arterials",
      // so MOTORWAY and TRUNK get the same treatment when it's on — both are
      // the high-speed arterial roads the toggle promises to avoid.
      { if: 'road_class == MOTORWAY', multiply_by: avoidMotorways ? '0.01' : '0.1' },
      { if: 'road_class == TRUNK', multiply_by: avoidMotorways ? '0.01' : '0.4' },
      { if: 'curvature > 0.9', multiply_by: '0.7' }
    ]
  };
}

function ghBaseUrl(env) {
  return (env && env.GH_SERVICE_URL) || DEFAULT_GH_BASE_URL;
}

function badRequest(message) {
  return jsonResponse({ error: { code: 'INVALID_REQUEST', message } }, 400);
}

function unavailable(message) {
  return jsonResponse({
    error: { code: 'ROUTING_UNAVAILABLE', message: message || 'Windy routing is temporarily unavailable.' }
  }, 502);
}

/** GH `points.coordinates` ([lng,lat] pairs) -> the client's [{lat,lng}] shape. */
function normalizeCoordinates(coords) {
  if (!Array.isArray(coords)) return [];
  const out = [];
  for (const c of coords) {
    if (!Array.isArray(c) || c.length < 2) continue;
    const lng = Number(c[0]);
    const lat = Number(c[1]);
    if (Number.isFinite(lat) && Number.isFinite(lng)) out.push({ lat, lng });
  }
  return out;
}

/**
 * GH's numeric `instr.sign` -> the {type, modifier} vocabulary OSRM/LRM
 * routes already carry (consumed by public/js/ride-controller.js's
 * _maneuverKeyFor for the ride-mode turn glyph). Without this, windy routes
 * only had `text`, and the glyph fell back to parsing that text — which
 * mostly works but is fragile against phrasing GH doesn't happen to use.
 * Sign constants per GraphHopper's own Instruction.java (stable/documented).
 * 'destination'/'waypoint' (not OSRM's real 'arrive') are used deliberately
 * for FINISH/REACHED_VIA — that's the exact vocabulary _maneuverKeyFor's
 * structural check recognizes, so those two resolve without needing the
 * text-fallback path at all.
 */
function signToManeuver(sign, isFirst) {
  if (isFirst) return { type: 'depart' };
  switch (sign) {
    case -98: case -8: case 8: return { type: 'turn', modifier: 'uturn' };
    case -7: return { type: 'fork', modifier: 'slight left' };
    case 7: return { type: 'fork', modifier: 'slight right' };
    case -6: return { type: 'exit roundabout' };
    case -3: return { type: 'turn', modifier: 'sharp left' };
    case -2: return { type: 'turn', modifier: 'left' };
    case -1: return { type: 'turn', modifier: 'slight left' };
    case 0: return { type: 'continue', modifier: 'straight' };
    case 1: return { type: 'turn', modifier: 'slight right' };
    case 2: return { type: 'turn', modifier: 'right' };
    case 3: return { type: 'turn', modifier: 'sharp right' };
    case 4: return { type: 'destination' };
    case 5: return { type: 'waypoint' };
    case 6: return { type: 'roundabout' };
    default: return { type: 'turn' }; // unknown/IGNORE — text fallback still applies
  }
}

/** GH `instructions[]` -> the client's {text, distance, time, index, type, modifier} steps shape. */
function normalizeSteps(instructions, coordCount) {
  if (!Array.isArray(instructions)) return [];
  const maxIndex = Math.max(coordCount - 1, 0);
  return instructions.map((instr, i) => {
    const rawIndex = Array.isArray(instr?.interval) ? Number(instr.interval[0]) : 0;
    const index = Number.isFinite(rawIndex) ? Math.min(Math.max(rawIndex, 0), maxIndex) : 0;
    const maneuver = signToManeuver(Number(instr?.sign), i === 0);
    return {
      text: typeof instr?.text === 'string' ? instr.text : '',
      distance: Number(instr?.distance) || 0,
      time: Math.round((Number(instr?.time) || 0) / 1000),
      index,
      type: maneuver.type,
      modifier: maneuver.modifier
    };
  });
}

/** One GH `paths[]` entry -> the normalized OSRM-shape route object (contract #3). */
function normalizePath(path) {
  const coordinates = normalizeCoordinates(path?.points?.coordinates);
  return {
    distance: Number(path?.distance) || 0,
    duration: Math.round((Number(path?.time) || 0) / 1000), // GH time is milliseconds
    coordinates,
    steps: normalizeSteps(path?.instructions, coordinates.length),
    curviness: Math.round(computeCurviness(coordinates))
  };
}

export const GhHandler = {
  /**
   * POST /api/gh/route — { points: [[lng,lat], ...], avoidMotorways } ->
   * { code: 'Ok', routes: [...] } on success, or a 502
   * { error: { code: 'ROUTING_UNAVAILABLE', message } } on any upstream
   * failure. Never throws — every branch resolves to a Response.
   */
  async planRoute(context) {
    const { request, env } = context;

    let body, error;
    try {
      ({ body, error } = await readJsonBody(request));
    } catch (err) {
      console.error('gh/route: failed to read request body:', err);
      return badRequest('Could not read request body.');
    }
    if (error) return error;

    const points = Array.isArray(body?.points) ? body.points : null;
    if (!points || points.length < 2) {
      return badRequest('points must be an array of at least two [lng, lat] pairs.');
    }
    for (const p of points) {
      if (!Array.isArray(p) || p.length < 2 || !Number.isFinite(Number(p[0])) || !Number.isFinite(Number(p[1]))) {
        return badRequest('Each point must be a [lng, lat] pair of finite numbers.');
      }
    }
    // GH rejects absurdly long point lists too, but capping here keeps a
    // malformed/abusive client from making us build a huge upstream payload.
    if (points.length > 200) {
      return badRequest('Too many points.');
    }

    const avoidMotorways = !!body?.avoidMotorways;
    const ghRequestBody = {
      profile: 'car',
      points: points.map((p) => [Number(p[0]), Number(p[1])]),
      points_encoded: false,
      // Required, not incidental: GH refuses a per-request custom_model in speed
      // (CH) mode. It is also free here — only landmarks are prepared upstream.
      'ch.disable': true,
      custom_model: buildCustomModel(avoidMotorways)
    };

    // One abort budget for the whole upstream exchange. The timer is cleared in
    // the outer finally rather than straight after fetch() so it still covers
    // reading the body — a long windy route with points_encoded: false is a
    // multi-megabyte response, and headers arriving quickly proves nothing.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      let upstream;
      try {
        upstream = await fetch(`${ghBaseUrl(env)}/route`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(ghRequestBody),
          signal: controller.signal
        });
      } catch (err) {
        // Connection refused / DNS failure / our own abort. Clean 502, never an
        // uncaught throw / 500.
        console.error('gh/route: upstream fetch failed:', err?.message || err);
        return unavailable('Could not reach the routing service.');
      }

      if (!upstream.ok) {
        // GH's own 400s land here too — a rejected custom model, an
        // unroutable/unsnappable point, max_visited_nodes exhausted. The detail
        // is logged, never forwarded: the client only needs the fallback signal.
        let detail = '';
        try { detail = (await upstream.text()).slice(0, 500); } catch (_) { /* ignore */ }
        console.error(`gh/route: upstream responded ${upstream.status}:`, detail);
        return unavailable('The routing service returned an error.');
      }

      let data;
      try {
        data = await upstream.json();
      } catch (err) {
        console.error('gh/route: upstream response was not JSON:', err);
        return unavailable('The routing service returned an unexpected response.');
      }

      const paths = Array.isArray(data?.paths) ? data.paths : [];
      if (!paths.length) {
        return unavailable('No route found.');
      }

      let routes;
      try {
        routes = paths.map((path) => normalizePath(path));
      } catch (err) {
        console.error('gh/route: failed to normalize upstream response:', err);
        return unavailable('The routing service returned an unexpected response.');
      }

      return jsonResponse({ code: 'Ok', routes });
    } finally {
      clearTimeout(timer);
    }
  }
};
