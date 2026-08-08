# Findings — Scenic Routing & Legs implementation

Running log from executing `docs/PLAN-scenic-routing-and-legs.md`. Format:
`- [severity] file:line — what + why it matters`

## Gate checks (resolved before build started)

- **Waypoint `type` CHECK constraint (§D1 gate item) — CLEARED.** Probed prod D1 directly
  (`wrangler d1 execute ride-db --remote`): `waypoints.type` is `TEXT DEFAULT 'stop'` with
  **no CHECK constraint**. `via` and `leg-break` write freely. No migration needed — the
  schema_v2.sql CHECK referenced in earlier review notes is not what's actually live.
- **LRM `requestParameters` support (§B3) — CLEARED.** Confirmed in the vendored
  `leaflet-routing-machine.min.js`: `buildRouteUrl` appends `this.options.requestParameters`
  via `L.Util.getParamString`. `requestParameters: {exclude: 'motorway'}` will work as
  designed against the OSRM adapter.

## Section A (Ubuntu VM / GraphHopper) — NOT executed

This session has no network access to `maps.incitat.io` or any VM/SSH capability (confirmed:
sandbox cannot reach the OSRM host). Section A remains entirely Rob's to run via his own CLI
agent on the box, per his stated intent. The app-side GraphHopper integration (§B) is built
against the documented GH REST contract and the Worker proxy shape specified in the plan, but
is **untested against a live GraphHopper instance** — first real-network validation happens
once Rob stands up the GH container and gives the go-ahead to point the Worker proxy at it.

## Sections B–E (app side) — implemented, integrated, browser-verified

Built by 6 parallel agents on disjoint files (windy engine + avoid-motorways + leg-based
route splitting; backend allowlist; leg UI + clear-shaping + trip-stitching; share-page legs;
CSS for both new surfaces; famous-roads chips), then integrated and verified live in a browser
against the guest (localStorage) path. Confirmed working end-to-end:

- A 5-waypoint trip (2 stops → via → leg-break → stop) renders exactly 4 map markers (the
  leg-break gets none), stop numbering restarts at 1 after the divider, and `Clear shaping`
  removes only the via point (1→0), leaves all stops and the leg-break untouched, and a single
  `App.undoWaypointChange()` restores it.
- Leg collapse: toggling a divider's chevron hides exactly the rows sharing its `data-leg-id`
  and nothing else.
- The Fastest/Windy toggle persists to `trip.settings.routing.mode`, the Windy button renders
  gold (`--route` token, confirmed `rgb(245,158,11)` computed), and a GH failure falls back to
  fastest for that render only without mutating the saved preference — verified via a real
  network failure (this sandbox cannot reach any routing host, so the failure path itself was
  the test).
- `node --check` clean on every touched/created JS file; new files
  (`public/js/scenic-suggest.js`, `public/data/scenic-roads-au.json`) load 200 OK and are
  registered in `public/sw.js` STATIC_ASSETS and `public/index.html`'s script list.

### Integrator fixes applied after the parallel pass

Cross-agent seams don't get caught by any single agent's tests — these were found and fixed
during integration, all re-verified live afterward:

- **[fixed, was major]** `public/js/map.js` `addWaypointMarker`/`createIcon` had no
  `type === 'leg-break'` case, so every leg divider showed a default 📍 pin stacked on its
  anchor stop. Added an early return, matching the existing `'via'` special-case. Confirmed:
  0 markers for leg-break waypoints.
- **[fixed, was CSS/JS mismatch]** The waypoints-ux agent's leg-collapse implementation toggles
  `.is-collapsed` directly on `.waypoint-item` rows sharing a `data-leg-id`; the CSS agent
  (working in parallel, unable to see that choice) had written `.is-leg-collapsed` — a
  different class name — plus an unused wrapper-element fallback. Replaced with the one rule
  that actually matches: `.waypoints-list .waypoint-item.is-collapsed { display: none; }`.
  Confirmed: collapsing a leg hides exactly its rows.
- **[fixed, was minor]** `public/js/trip.js` (`getStops`/`getStats`) and
  `public/js/ride-controller.js` (4 call sites: ride-start stop count, along-route
  precompute, arrival detection, remaining-waypoints) only excluded `type === 'via'`, not
  `'leg-break'` — GPX export, trip stats, and drive-mode arrival/stop logic would have
  double-counted or falsely "arrived at" a leg divider. Added `'leg-break'` to all five
  exclusion checks.
- **Not fixed, deliberately deferred:** `route.legBoundaries` (the per-leg coordinate-index
  array map.js computes for multi-leg trips) is silently dropped on save — both
  `api/trips.js`'s `route_data` INSERT and the guest localStorage shim in `public/js/api.js`
  whitelist only `{coordinates, steps, distance, duration}`, and the D1 `route_data` table has
  no column for it. Nothing consumes `legBoundaries` yet (the share page explicitly won't per
  the plan), so this is inert today. Fixing it needs a D1 schema migration
  (`ALTER TABLE route_data ADD COLUMN leg_boundaries TEXT`) — deliberately not done without
  discussing it with Rob first, per the "no schema changes without discussion" posture. Revisit
  when something actually needs to read leg boundaries back after a reload (e.g. per-leg
  Polyline splitting on the map, or share-page per-leg stats).

### Known gaps carried forward (all [minor]/[note], none block shipping)

- `route-editor.js`'s on-map drag handles receive `waypointIndices: null` for multi-leg
  concatenated routes (no single index mapping crosses a leg boundary) — tolerated by existing
  code for other null cases, not spot-checked end-to-end for the multi-leg case specifically.
- Multi-leg routes draw as one continuous Polyline across the concatenated coordinates, so the
  geographic gap between two disconnected legs renders as a connecting line rather than a
  visible break. `route.legBoundaries` exists precisely to fix this in a follow-up pass;
  out of scope for v1 per the plan.
- The scenic-chip and the route-selector pill bar are both independently top-positioned over
  the map with no shared coordination — they can visually overlap on narrow screens if both are
  visible simultaneously (a scenic-road match *and* multiple route alternatives at once).
  Low-frequency overlap, cosmetic only.
- Share-page leg sections show only the leg title (no per-leg distance/duration) — the public
  payload doesn't carry per-leg boundary data (see the deferred `legBoundaries` persistence
  above); would need `api/journey.js`'s `serializePublicJourney` widened once that lands.
- `public/js/trip.html`'s `downloadGpx()` fallback path (used only when a trip has no computed
  route yet) still includes `via`/`leg-break` waypoints as raw track points — pre-existing
  minor quirk (via already did this), not touched.
- `ride_scenic_dismissed_<tripId>` and `ride_leg_collapse_<tripId>_<legId>` are used as raw
  localStorage keys, not yet added to `storage.js`'s documented `Storage.KEYS` keyspace —
  cosmetic/documentation debt only, both keys work correctly today.

## Section A (Ubuntu VM / GraphHopper) — infra incident + partial completion, 2026-08-08

While validating OSRM ahead of adding GraphHopper, `mjw-vm` (which hosts OSRM for Ride,
alongside unrelated projects: a Fedora Commons archive, TigerBeetle, Grafana, Prometheus,
Postgres) turned out to be chronically OOM-crash-looping — 21,000+ restarts on the `osrm`
container, traced live via `dmesg`.

- **[critical, resolved] Root cause**: `infra/docker-compose.yml`'s `deploy.resources.limits.memory: 6G`
  on the `osrm` service was silently ignored — that key only applies under Docker Swarm, not
  plain `docker compose up`. OSRM's container therefore had **no** memory ceiling and was
  free to compete for the whole host's RAM. On the same host, **TigerBeetle** (a separate,
  currently-unused project, running raw via systemd — not Docker) needed ~3.45GB to
  complete its startup/recovery and had no memory reservation of its own either. The two
  repeatedly starved each other and the kernel's OOM killer, causing cascading kills —
  confirmed via `dmesg`: `Out of memory: Killed process ... (osrm-routed)` immediately
  followed by `Out of memory: Killed process ... (tigerbeetle)` in the same event. At one
  point this OOM cascade was severe enough during boot to prevent Azure Bastion/SSH from
  ever stabilizing, requiring Azure Serial Console + a VM-level stop/start to recover.
- **Fix applied**: VM resized `Standard_B1ms` (1 vCPU/2GB) → `Standard_B2ms` (2 vCPU/8GB,
  via an intermediate B2s/4GB step). `tigerbeetle` and `veritas-gateway` systemd services
  stopped + disabled (confirmed by Rob as not currently needed; fully reversible via
  `systemctl enable --now tigerbeetle veritas-gateway` — data disk and unit files
  untouched). `infra/docker-compose.yml` fixed to use `mem_limit` (the key actually
  enforced by classic Compose) instead of the dead `deploy.resources.limits` block, with
  OSRM capped at 3g. Confirmed stable afterward: `RestartCount=0` sustained over a
  90s+ watch window, steady-state memory 1.56GB (well under the 4.1GB on-disk dataset size
  — MLD doesn't need the whole file resident). **OSRM's whole-of-Australia dataset does
  NOT need to be shrunk** — the memory problem was TigerBeetle contention + the unenforced
  limit, not OSRM's own footprint.
- **GraphHopper (§A3/A4)**: `infra/docker-compose.yml` and `infra/gh-config.yml` now define
  the `graphhopper` service (image `israelhikingmap/graphhopper:latest`, `mem_limit: 3.5g`,
  `-Xmx3g`), sized to fit alongside OSRM's 3g cap within the box's 8GB total. **Not yet
  run** — pending confirmation that the raw `data.osm.pbf` survived OSRM's extract step (to
  avoid a redundant Geofabrik download), then the one-time import (recommended with `osrm`
  stopped, since import needs more peak memory than steady serving), then the Cloudflare
  Tunnel route for `/gh/` (§A4), then curvature-model tuning against real scenic roads
  (§A3's suggested test corridors) before `GH_SERVICE_URL` in `wrangler.toml` is truly live
  end-to-end. Until that lands, the app's windy-mode fallback (tested and confirmed working
  during app-side validation: clean 502 → toast → fastest-for-this-render, saved preference
  untouched) is what users actually experience when selecting "Windy."

## GraphHopper live end-to-end + tiles/offline batch, 2026-08-08 (later same day)

GraphHopper's import completed (whole-of-Australia, ~15 min wall clock once config was
correct — see below), and it was wired fully live: Cloudflare Tunnel route `gh.incitat.io` →
`localhost:8989` added, a stale `*.incitat.io` wildcard A record (pointing at an old,
unrelated Vercel deployment) was identified as the reason `gh.incitat.io` initially 404'd
through to Vercel, and `wrangler.toml`'s `GH_SERVICE_URL` was updated from the never-live
`https://maps.incitat.io/gh` path to `https://gh.incitat.io` and deployed to production
(`wrangler deploy`, BUILD_ID `2026-08-08T03`). **The "Known gaps" list above (lines 80-101)
is now stale** — items 1-3 (GPX via/leg-break export, undocumented storage keys, scenic-chip/
route-selector overlap) were all found already resolved in the working tree during a
verification pass and needed no further work; leaving the old text above for history but
treat it as closed.

- **[note] GraphHopper's stock config needed 4 rounds of trial-and-error against its actual
  startup validation** before it would run: (1) command syntax is `-i/-c/-o` flags, not
  Dropwizard `-D` properties; (2) GH 12.0 requires `custom_model_files: [car.json]` on the
  `car` profile (an empty `[]` produces a profile with zero speed statements and fails); (3)
  `import.osm.ignored_highways` must be set explicitly for a car-only profile; (4) a car
  profile needs `road_environment`, `ferry_speed`, `max_speed` added to `graph.encoded_values`
  alongside `car_access`/`car_average_speed`/`road_class`/`curvature`. Final working
  `infra/gh-config.yml` is in the repo. Flagging because `israelhikingmap/graphhopper:latest`
  resolved to a `12.0-SNAPSHOT` build — a nightly, not a pinned release — so this config may
  drift again on a future `docker compose pull`. Consider pinning a numbered tag.
- **[resolved] Cloudflare DNS**: the tunnel's origin cert (`cert.pem`) is scoped to the
  `michaeljwright.com.au` zone, so `cloudflared tunnel route dns` cannot create records in the
  `incitat.io` zone — it silently created a useless `gh.incitat.io.michaeljwright.com.au`
  record instead of erroring. The real `gh.incitat.io` CNAME (→
  `0fbed2f4-5a58-4cab-9a5a-28d5d73fdcbc.cfargotunnel.com`, Proxied) had to be added by hand in
  the Cloudflare dashboard, matching how `maps.incitat.io` was set up originally. The stray
  `.michaeljwright.com.au` record is harmless dead weight, not yet cleaned up.
- **[verified] Live windy routing end-to-end**: `POST https://gh.incitat.io/route` with the
  exact custom_model `api/gh.js` sends returns `200` with a real route (Jindabyne↔Thredbo:
  35,693m). **Caveat**: this test pair returned the identical distance/time/road as the
  plain-fastest baseline (only the internal `weight` differed, 54412 vs 48453) — there is
  likely only one sane paved road between those two points, so this proves the custom_model
  is *accepted* but does not yet prove GraphHopper picks a visibly different, bendier road
  over a faster alternative when one actually exists. Needs a re-test with a corridor that has
  a genuine motorway-vs-backroad choice before calling curvature-bias fully validated. Not
  done here per "no copious validation."
- **[fixed, was a real allowlist bypass]** `api/tiles.js`'s new tile-style validation checked
  `TILE_STYLES[style]` truthiness directly — a style value of `"constructor"`, `"toString"`,
  etc. resolves to an inherited `Object.prototype` value (truthy), passing the check it
  shouldn't. Did not reach an actual SSRF (the next step throws on a non-string and 502s
  safely), but defeated the documented "strict allowlist is the security boundary" contract
  and mis-reported malformed requests as 502 instead of 400. Fixed with
  `Object.prototype.hasOwnProperty.call(...)` + a `typeof` guard.
- **[fixed]** Two new marker styles introduced this batch hardcoded `border: 2px solid #fff`
  instead of a design token: `route-components.css:610,623` (`.via-marker`) and
  `ride-mode.css:371` (`.photo-marker`). Fixed to `var(--text-on-accent)`. Pre-existing hex
  debt elsewhere in `ride-mode.css`/`route-components.css`/`trip.css` (not introduced this
  batch) was left alone to avoid scope creep — still present, still worth a cleanup pass.
- **[needs Rob's call, not a bug]** `buildCustomModel()` in `api/gh.js` scales the `MOTORWAY`
  multiplier down when `avoidMotorways` is on (`0.1` → `0.01`) but the `TRUNK` multiplier stays
  a flat `0.4` regardless. May be intentional (windy mode always deprioritizes trunk roads a
  bit; the toggle only sharpens the motorway penalty specifically) — confirm.
- **[accepted tradeoff, not a bug]** GraphHopper responses only carry `{text, distance, time,
  index}` per step (`api/gh.js normalizeSteps`); OSRM additionally provides a `modifier` field
  that `public/js/map-ride.js:367` uses for turn-icon rendering. Windy-engine turn-by-turn will
  show degraded/generic turn icons versus OSRM's fastest mode. Not fixed — flagging as a v1
  scope decision to confirm, not an oversight.
- **New self-hosted-tiles plan written**: `docs/PLAN-self-hosted-tiles.md` — vector PMTiles
  (Australia extract) hosted in R2, read through the existing `/api/tiles/` Worker proxy, no
  new service on the shared VM. Not started; not urgent (current free-OSM-behind-a-cache setup
  is fine at present traffic). Rob's explicit preference: self-host over any paid tile
  provider.
- **Still genuinely unverified (needs a browser/device, not just static review)**: the offline
  download's real `postMessage` progress/cancel round-trip; live tile-proxy 502→blank-tile
  fallback and cache-hit behavior against real upstreams; whether the missing turn-`modifier`
  gap above is acceptable in the real ride-mode HUD.

