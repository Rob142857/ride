# Findings — Scenic Routing & Legs implementation

Running log from executing `docs/PLAN-scenic-routing-and-legs.md`. Format:
`- [severity] file:line — what + why it matters`

## Gate checks (resolved before build started)

- **Waypoint `type` CHECK constraint (§D1 gate item) — ~~CLEARED~~ THIS WAS WRONG, see
  2026-08-17 below.** The original note read: "Probed prod D1 directly
  (`wrangler d1 execute ride-db --remote`): `waypoints.type` is `TEXT DEFAULT 'stop'` with
  **no CHECK constraint**. `via` and `leg-break` write freely. No migration needed." The
  column indeed has no inline CHECK — but the probe only looked at the column definition and
  missed the **BEFORE INSERT/UPDATE triggers** `2026-06-28_hardening.sql` installs, which
  enforce the same thing by `RAISE(ABORT)`. Those triggers WERE live in prod and did NOT
  allow `leg-break`. Cost: every cloud-mode `leg-break`/`lodging`/`custom` waypoint write
  500'd from the day legs shipped until 2026-08-17. Lesson: probing a constraint means
  checking `sqlite_master` for triggers and views too, not just the `CREATE TABLE` text.
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

## Fuel planning feature — 2026-08-17

Built by five parallel agents against a fixed contract, then integrated. Format as above.

### What was built

- **`public/js/fuel.js` (new) — `window.FuelPlanner`**: pure range math, no DOM/Leaflet, own
  haversine, `module.exports`-guarded so it runs under plain `node`. Fixed colour bands on
  *remaining km* — ok >100, warn <=100, low <=50, critical <=20, empty <=0 (`levelForRemaining`,
  non-finite input becomes `'empty'`, the cautious end). `computeProfile({coordinates, waypoints,
  tankRangeKm, startPercent, startAtIdx})` returns `{totalKm, segments, fills, dryPointIdx,
  remainingAtEndKm}`; `getState`/`setPercent`/`tankFilled` over `Storage.KEYS.FUEL_STATE`.
- **Settings** (`public/index.html`, `public/js/ui.js`): `#fuelPlanningToggle` (default OFF),
  `#fuelTankRange`, `#fuelWarnMode` (percent30/km100/km50/km20), `#fuelPercentNow` + Full/three-
  quarter/half/quarter chips, in a new section of the existing settings modal sharing its Save
  button.
- **Fuel state** is device-local (`ride_fuel_state`, `public/js/storage.js`), deliberately not
  trip data — the tank belongs to the bike, not the trip.
- **Waypoint flag** `fuel_stop` / `fuelStop` end to end: D1 migration, `api/waypoints.js`,
  `public/js/api.js` (cloud + guest `LocalDB` parity), a live toggle in the waypoint details
  modal (`public/js/waypoint-controller.js`), a fuel badge in the itinerary
  (`public/js/ui-renderers.js`).
- **Map overlay** (`public/js/map.js` `refreshFuelOverlay`): per-level polylines in a dedicated
  `fuelOverlayPane` (z 420, above the route, below route-editor handles), fill markers, and a
  dismissible "runs dry ~N km before the end" chip.
- **Ride HUD** (`public/js/ride-controller.js`, `public/css/ride-mode.css`): 5th stat
  `#rideFuelVal` with the colour bands, `#tankFilledBtn`, a persistent second banner line for
  the alert, one toast per threshold crossing.
- **Tokens** (`public/css/tokens.css`): `--fuel-warn`, `--fuel-low`, `--fuel-critical:
  var(--danger)`. Red is correct, not an exception: running dry in remote Australia *is* danger.

### Seam bugs found and fixed at integration

- **[critical] `api/waypoints.js:41`** — the pre-migration fallback detector only matched
  `no such column: fuel_stop`. SQLite words the two statements differently (verified with
  `node:sqlite`): `UPDATE` says `no such column: fuel_stop`, but `INSERT` says **`table
  waypoints has no column named fuel_stop`**. Since `addWaypoint` auto-ticks the flag for
  `type: 'fuel'`, deploying ahead of the migration would have **500'd every Fuel/Rest waypoint
  creation** — a regression in existing functionality. Now matches both wordings (plus
  `err.cause`), and is still narrow enough not to swallow unrelated errors.
- **[high] `public/js/map.js:587`** — the overlay never appeared when a trip was simply
  *opened*: it was wired only to `ride:routeComputed`, which fires from `_persistSelected()`
  only, i.e. after an edit forces a reroute. Opening a trip restores the stored route through
  `_restoreStoredRoute`/`drawRoute`/`_adoptStoredRoutes` and fires nothing. Fixed by calling
  `refreshFuelOverlay()` at the end of `_drawRoutes()`, the single funnel every draw path
  (fresh compute, alternative selection, restore) passes through.
- **[high] `public/js/fuel.js:137`** — fuel stops were snapped to the nearest coordinate
  *at index >= startAtIdx*, so mid-ride a station the rider had already ridden past was snapped
  **forward** onto the road ahead and granted a refill that will never happen — the one failure
  mode of this feature that can strand someone. Now snaps over the whole route and skips any
  stop whose nearest coordinate is behind `startAtIdx`. Regression-tested.
- **[high] `public/js/map.js:1024` / `public/js/ride-controller.js:950`** — `_onTankFilled()`
  called `refreshFuelOverlay({startAtIdx, percent:100})` and then dispatched
  `ride:fuelSettingsChanged`, whose listener immediately re-ran `refreshFuelOverlay()` with no
  args, clobbering the rider's position back to the start of the route on a full tank. Added
  `MapManager._liveRideFuel()`: an unqualified refresh now derives `startAtIdx` from
  `App._rideNearIdx` and the percent from `stored - _fuelKmRidden` whenever `App.isRiding`, so
  both call sites agree.
- **[medium] `public/js/map.js:933`** — the "runs dry" chip is `position: fixed` at top centre,
  which in ride mode is the turn-by-turn banner. It would have covered the next manoeuvre while
  riding, duplicating a warning the HUD already gives. Now suppressed while `App.isRiding`;
  `enterRideMode`/`exitRideMode` each trigger one refresh so the transition is clean.
- **[medium] `public/js/ui-renderers.js:45,105`** — `addWaypoint` pre-ticks `fuel_stop` for
  `type: 'fuel'` regardless of the feature flag, so the fuel badge appeared in the itinerary for
  riders who never turned fuel planning on. Badge is now gated on `fuelPlanningEnabled`, and
  saving settings re-renders the waypoint list so the toggle takes effect immediately
  (`public/js/ui.js:898`).
- **[medium] `public/js/map.js:734`** — `_drawFuelSegments` drew `slice(from, to+1)` against a
  **strict** partition from `computeProfile`, leaving a one-edge gap at every band boundary and
  dropping single-coordinate bands entirely. Now `slice(from, to+2)` with a `to < from` guard,
  as `fuel.js`'s own rendering note specifies.
- **[medium] `public/js/map.js:963`** — the chip was never rebuilt once shown, so after a route
  change it kept quoting the old "~N km" figure. Added `_fuelChipShownFor` so a new signature
  rebuilds while an identical one is left alone (dismissal semantics unchanged).
- **[medium] `public/js/map.js:674`** — `_activeRouteCoordinates()` preferred the cached
  planning alternative, but an in-ride reroute replaces `currentTrip.route` *without* touching
  that cache, and `_rideNearIdx` indexes the latter. Mismatched arrays would misplace the rider
  after a reroute. While riding, `currentTrip.route` now wins.
- **[medium] `public/js/ui.js:877`** — settings saved `fuelTankRangeKm` as the raw input
  **string**. `computeProfile` type-checks `tankRangeKm` and returns its inert shape on a
  string; it only worked because both current consumers happened to wrap it in `Number()`.
  Now stored as a real number (or `''` when unset).
- **[medium] `api/schema.sql:75`, `api/schema_v2.sql:140`** — the migration was written but the
  base schemas were not updated, so a **freshly created** database would never have
  `fuel_stop` and the flag would silently never persist there. Added to both (repo convention:
  `cover_focus_x` is carried in both places).
- **[low] `public/js/waypoint-controller.js:213`** — the no-response fallback wrote only
  `fuelStop`, which `API._normalizeWaypoint` re-derives from raw `fuel_stop`; the flag would be
  silently undone on the next normalize. Now writes both shapes.
- **[low] `public/css/ride-mode.css:195,198,326,330,405-407`** — seven `var(--fuel-warn,
  #fb923c)`-style hex fallbacks inside CSS, with no precedent anywhere in `public/css` and
  pointless (tokens.css always loads first). Stripped to bare `var(--...)`. The literal fallbacks
  in `map.js` (`FUEL_COLORS`, `_cssVar`) and the inline chip styles are the sanctioned JS
  pattern and match `scenic-suggest.js` exactly — left alone.
- **[low] `public/js/ui.js:853`** — the new sub-fields were dimmed-but-visible while the
  feature is off, unlike the fuel-cost section directly above it in the same modal. Now hidden
  *and* disabled, matching the neighbour.
- **[low, new behaviour] `public/js/ride-controller.js` `_persistRideFuelBurn`** — nothing wrote
  the ride's fuel consumption back to the stored percent (it only ever moved on a Tank Filled
  tap), so the map would plan tomorrow's ride on a tank emptied today. `exitRideMode` now banks
  the km burned. Erring low is the safe direction: too low warns early, too high strands.

### Migration and deploy order

- `api/migrations/2026-08-17_waypoint_fuel_stop.sql` — `ALTER TABLE waypoints ADD COLUMN
  fuel_stop INTEGER NOT NULL DEFAULT 0;`. **Not applied.** Apply to both:
  `npx wrangler d1 execute ride-db --file=./api/migrations/2026-08-17_waypoint_fuel_stop.sql --remote`
  (and `--local`).
- The API tolerates the column being absent (retries the write with `fuel_stop` stripped), so
  a deploy before the migration will not 500 — but until it runs, ticking "Fuel stop" appears
  to work and then the checkbox reverts on reopen, because the flag was dropped. Run the
  migration before telling anyone the feature exists.
- `api/worker.js` `BUILD_ID` bumped to `2026-08-08T05` and every `?v=` in `index.html` bumped
  to match; `/js/fuel.js` added to `sw.js` `STATIC_ASSETS`.

### Verified here (static + node)

- `node --check` on every touched JS file. `node:sqlite` used to confirm both SQLite
  missing-column wordings. A 9-case `require()`-based smoke test of `fuel.js` passes: bands,
  fill/reset, dry detection, the strict partition, guards (no args, 1 coord, zero/string tank
  range, out-of-range/NaN percent, malformed coordinates), via/leg-break never refuelling even
  when wrongly flagged, passed-stop rejection, off-route flagging, persistence with no
  `Storage`/`window` globals, and that every non-`ok` band is drawable under map.js's slicing.
- Contract joins: all six required IDs exist exactly once in `index.html`; all three event
  names byte-identical across dispatchers and listeners; `fuel.js` loads before `map.js`.
- via/leg-break exclusion logic untouched everywhere; `fuel.js` re-excludes them defensively.

### Still unverified — needs Rob in a browser / on the bike

- **Nothing-appears-when-off**, end to end in a real browser with a fresh profile: settings
  sub-fields hidden, no HUD stat, no FAB, no overlay, no chip, no waypoint tick box, no fuel
  badge, no console errors. Reasoned through statically, never rendered.
- **Guest mode** (`App.useCloud === false`) round trip: tick a fuel stop, reload, confirm it
  persisted through `LocalDB` and that no `LOGIN_REQUIRED` surfaces. Code paths traced, not run.
- **Chip stacking geometry.** `_fuelChipTopOffset()` measures a real `.scenic-chip` when one is
  present, otherwise reserves a flat **92px** for one that may appear later. The scenic chip's
  own `top` is a fixed `calc(header + safe-area + 10px)` and does *not* stack under the
  route-selector bar, so the arithmetic should hold — but a scenic chip taller than 92px (a long
  road name wrapping on a narrow phone) could overlap. Also: the fuel chip's `top` is computed
  once at build, so a rotate/resize while it is showing leaves it slightly stale. Needs eyes.
- **The taller ride banner.** The fuel alert adds a third line inside `.ride-banner-content`,
  growing the banner mid-ride. The manoeuvre icon logic is untouched, but how much map it eats
  on a 360px phone in daylight is a bike question.
- **Unit asymmetry, by design but worth a sanity check**: `#rideFuelVal` is unit-aware via
  `RideUtils.formatDistance` (miles under imperial) while the toast/alert text is literal km
  per the spec's example wording.
- **Alert threshold feel**: `percent30` on a 350 km tank fires at 105 km remaining, which lands
  in the same band as the `warn` colour. Whether that's the right first nudge is a road call.
- **`_updateFuelHud` delta filter** ignores per-tick jumps of 2000 m or more as anchor
  discontinuities. Fine at any legal speed with a normal GPS tick, but unproven against real
  tunnel/dropout behaviour on the bike.
- **Waypoint details**: changing an existing waypoint's type *to* Fuel/Rest does not auto-tick
  `fuelStop` (only creation does). Deliberate — an edit shouldn't silently change fuel
  planning — but confirm that's the wanted behaviour.

## Fuel polish + fuel finder + return leg — 2026-08-17

Built by three parallel agents against a fixed contract (`FuelPlanner.refuelSearchPoints`, the
fuel chip's "Find fuel" button, `ride:fuelStopsChanged`), then integrated. Format as above.

### What was built

- **Overlay legibility (`public/js/map.js`, `public/js/fuel.js`)**: fuel-band polylines were
  nearly as wide and nearly as opaque as the route itself, hiding both the gold route and tile
  street labels. `_fuelWeight()` now floors at half the route's weight; `_fuelOpacity()` caps at
  0.5 (0.62 for the dashed 'empty' stretch). `FuelPlanner.refuelSearchPoints(profile,
  coordinates)` added — one search point per fill-to-fill span that drops below 20% of tank
  range, at the ~80%-consumed mark, clamped before any dry point.
- **Fuel finder (`public/js/fuel-finder.js` new, `api/places.js`, `api/worker.js`,
  `public/js/ui-place-search.js`, `public/index.html`, `public/sw.js`)**: `window.FuelFinder.
  openForRoute()` reads the fuel profile, asks `refuelSearchPoints` where to look, searches up
  to 2 points (15km, widened once to 40km if empty) via a new `GET /api/places/fuel`
  (`PlacesHandler.searchFuel`, Nearby Search by `gas_station`, same auth/quota bucket as
  `search()`), and inserts the chosen station via the canonical `App.addWaypoint` +
  `App.reorderWaypoints` path (fuelStop:true, dispatches `ride:fuelStopsChanged`). Two
  discoverability paths: the fuel chip's new button, and `#findFuelAlongRouteBtn` inside the
  place-search modal.
- **Return leg (`public/js/trip-details.js`)**: "Create return trip..." in Trip Details builds a
  brand-new trip with the source trip's real stops + vias reversed (leg-breaks dropped), via
  the canonical `API.trips.create` + sequential `API.waypoints.add` path (If-Match versioning
  via a local `shell`, mirroring the pre-existing `appendTripAsLeg`). Also fixed two pre-existing
  bugs in `appendTripAsLeg`'s waypoint-copy loop found while building the shared
  `_normalizeCopyWaypointType` helper: `fuelStop` was dropped entirely on copy, and every
  waypoint type except `via` collapsed to `'stop'`.

### Seams found and fixed at integration

- **[critical] `public/js/fuel-finder.js` `_useStation`'s insertion-boundary scan (previously
  ~line 241)** — the loop finding "the first waypoint whose along-route km exceeds the search
  point's km" explicitly `continue`d past `type === 'leg-break'` entries, same as it skips
  `via`. For a multi-leg trip where a leg's own route geometry extends past its last real stop
  (a trailing `via` shape point placed after the last stop but before the leg-break — OSRM
  routes through it, so the leg's coordinates genuinely extend that far), a low-fuel point
  landing in that tail would skip over the leg-break divider (still `> pointKm`-eligible once
  it's not excluded) and land on the first real stop of the next leg instead — silently
  inserting the fuel stop into the leg that didn't need it while leaving the leg that actually
  runs dry exactly as fuel-starved as before. `map.js`'s `_splitIntoLegs` routes each leg
  independently, so this isn't cosmetic — the rider genuinely gets no fuel stop where one was
  computed to be needed. Fixed: leg-break is now a full boundary candidate in the scan (only
  `via` is still skipped), so the fuel stop can never be spliced in past a leg's closing divider.
  Reproduced the bug and confirmed the fix with a standalone harness (leg 1 = stopA-stopB-viaY,
  leg-break anchored to viaY, leg 2 far away; a low point between stopB and viaY: pre-fix
  resolves to the leg-2 stop, post-fix resolves to the leg-break, staying in leg 1).
- **[medium] `public/js/ui-place-search.js` `openPlaceSearchModal` / `public/index.html`'s
  `#findFuelAlongRouteBtn`** — the button was static markup, always visible regardless of the
  `fuelPlanningEnabled` setting (violates the same feature-off invariant
  `waypoint-controller.js`'s fuel-stop toggle already respects). Clicking it with the feature off
  just degraded to a toast, but the button itself shouldn't be discoverable when fuel planning
  is off. Fixed: `openPlaceSearchModal()` now reads `Storage.KEYS.SETTINGS` live and hides the
  button when `fuelPlanningEnabled` is false, same check `waypoint-controller.js` already makes
  for the fuel-stop row.

### Verified, no change needed

- Overlay math: re-ran a copy of the overlay agent's node harness against `fuel.js` directly —
  all scenarios (580km/300km-tank band placement, fuel-stop mid-route reset, 40% start
  percent, slice-seam partition audit, camelCase-only `fuelStop`/via/leg-break exclusion, inert-
  input guards) pass. `_fuelWeight`/`_fuelOpacity`/`interactive:false` apply uniformly to every
  drawn fuel layer including the dashed 'empty' segment and the fill circleMarkers.
  `refreshFuelOverlay` call sites (init's zoomend, the three `ride:fuel*`/`ride:routeComputed`
  listeners, `_drawRoutes`, and ride-controller.js's explicit `_onTankFilled` call with
  `startAtIdx`) are all unchanged/compatible with the new signature.
- Places quota: `openForRoute()` caps at 2 search points, each with at most 1 widening retry
  (max 4 upstream calls, same shared quota bucket as text search); guests short-circuit to
  `UI.suggestLogin` before opening the results modal; a 429 mid-search shows the existing
  rate-limit toast rather than a raw error.
- Registrations: `fuel-finder.js`'s script tag sits after both `fuel.js` and `ui-place-search.js`,
  carries the `?v=2026-08-17T01` convention, and is listed in `sw.js` STATIC_ASSETS.
  `node --check` clean on every touched/created JS file. No hex colours outside tokens.css other
  than `var(--x, #literal)` fallbacks matching the existing inline-chip precedent.
- Return leg: reversed order is correct because `API.trips.get` (cloud `ORDER BY sort_order`,
  guest `LocalDB.getTrip`) already returns waypoints pre-sorted, so `Trip.normalizeWaypointOrder
  (...).reverse()` reverses display order, not insertion order. `order`/`sort_order` in the add
  payload are dead — both `api/waypoints.js addWaypoint` and `LocalDB.addWaypoint` always append
  at `max+1` server/local-side regardless — but harmless, since sequential awaited adds already
  produce the correct final order by construction. Guest parity confirmed by reading
  `LocalDB.createTrip`/`addWaypoint`. `appendTripAsLeg`'s `fuelStop` fix covers a return trip
  later appended as a leg into another trip (the exact interaction the task called out).

### Decisions worth Rob's attention

- Fuel-stop insertion in `fuel-finder.js` is add-then-reorder (two canonical calls, two
  undo/toast steps) rather than one combined step — acceptable since both are independently
  correct, flagged in case a single-undo-step insert is wanted later.
- `/api/places/fuel` is a sibling endpoint to `/api/places/search` rather than a `type=fuel`
  param, to avoid tangling the query-text and lat/lng-radius call shapes; same quota bucket
  either way.
- Not fixed (pre-existing, not part of this batch, ambiguous rather than clear-cut): if both
  trips in `appendTripAsLeg` have zero copyable waypoints it shows an info toast and returns
  without throwing, so the confirm modal closes as if it succeeded. Also: neither
  `createReturnTrip` nor `appendTripAsLeg` roll back or resume a partial failure — retrying
  re-runs from scratch (a second, duplicate-named trip for the return-trip path). Both are
  narrow edge cases inherited from the pre-existing append-leg v1 design, not introduced here.

### Unverified — needs Rob in a browser

- The fuel-finder insertion fix is verified against a standalone harness reproducing the exact
  scan logic, not against a live multi-leg trip with a real OSRM/GraphHopper route and a real
  Google Places result — worth one manual pass: a 2-leg trip, drain the tank inside leg 1 past
  its last real stop, confirm "Find fuel" lands the new waypoint inside leg 1's segment (before
  the leg-break) and the route recompute reflects it.
- `Object.assign(API.places, {...searchFuel})` and the new `/api/places/fuel` route are
  untested against a live Google Places key/quota (no network access in this sandbox) — the
  400/502/429 paths are code-reviewed, not exercised.
- The two-toast (add, then reorder) sequence on a repositioned fuel-stop insert — confirm the UX
  reads fine in practice, not just "acceptable" on paper.
