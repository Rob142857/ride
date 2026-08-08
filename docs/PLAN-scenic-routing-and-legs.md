# Plan: Windy Routing, Safe Reset, Trip Legs & Scenic Suggestions

**For:** the executing agent (Claude Sonnet 5) working in this repo.
**From:** design session with Rob, 2026-08-08. Rob approved all four workstreams.
**Server work (Workstream A)** runs on Rob's Ubuntu VM — he will execute it via a CLI
agent on the box using the instructions in §A. Everything else is app-side work in this repo.

---

## 0. Orientation (read first)

- **App:** "Ride" — trip planning / journaling / sharing PWA. Vanilla JS classic scripts,
  **no build step**, no frameworks. Frontend in `public/`, Cloudflare Worker API in `api/`
  (D1 + KV + R2). Deploy: `npm run deploy` (bumps BUILD_ID, rewrites `?v=` cache-bust
  params across all HTML pages, runs wrangler).
- **Routing today:** self-hosted OSRM (Docker, **MLD algorithm**, Australia-wide Geofabrik
  extract, standard `/opt/car.lua` profile) behind Cloudflare Tunnel at
  `https://maps.incitat.io/route/v1`. Client uses `L.Routing.osrmv1` as a *router only* —
  polylines are app-owned in `public/js/map.js` (no `L.Routing.control`).
- **Brand/design:** every colour/radius/space comes from `public/css/tokens.css`
  (indigo = interactive, gold = route, emerald = ridden track, navy surfaces).
  **Never hardcode colours; never redeclare tokens.**
- **Memory files** (auto-loaded each session): `ride-brand-system.md`,
  `ride-uplift-contracts.md` — read them; they define the standing contracts.

### Standing contracts — do not break
1. Waypoint `type === 'via'` = shaping point (bends route, not a stop; excluded from stop
   counts, arrival toasts, share lists/numbering). This plan adds `type === 'leg-break'`
   with similar special handling (§D).
2. Guest mode: `App.useCloud === false` → `API.trips/waypoints/journal/rideLogs` run on
   localStorage (shim in `api.js`). Cloud-only actions throw `err.code === 'LOGIN_REQUIRED'`
   → callers call `UI.suggestLogin(label)`. **Every new feature must work for guests.**
3. Drive HUD element IDs in `index.html` (rideManeuverIcon, rideSpeedVal, …) and the
   `'ride:ended'` window event on ride exit.
4. `MapManager.drawJournalPhotos/clearJournalPhotos` (map-photos.js).
5. Escape all user content before it reaches HTML (use `UI.escapeHtml` / DOM APIs).
6. **`public/sw.js` STATIC_ASSETS is all-or-nothing**: any NEW css/js/vendor/data file the
   pages reference MUST be added there in the same change, or the service worker refuses to
   install for every user. Highest-blast-radius file in the repo.

### Environment constraints for the executing agent
- The Claude sandbox **cannot reach `maps.incitat.io`** (or any OSRM/GraphHopper endpoint).
  Test routing UI with synthetic route objects injected via the browser pane, exactly like
  `scratchpad/test-route-scroll.js` does. End-to-end routing validation happens on Rob's
  machine or via curl instructions you give Rob.
- Headless-Chrome CDP testing works locally with zero dependencies — reuse the scaffolding
  in `scripts/shoot-screenshots.js` and `scratchpad/test-route-scroll.js` (real touch
  events, mobile emulation, screenshots).
- Static preview: `.claude/launch.json` → `ride-static` serves `public/` on :3000
  (no Worker API — the app boots into guest mode, which is fine for most UI testing).
- Syntax gate after every JS edit: `node --check <file>`. There is no bundler to catch errors.
- **Do not commit or push unless Rob asks.** Deploys: ask Rob, or deploy when he says to.

### Findings log (required)
Create `FINDINGS.md` at repo root on first discovery. Append anything encountered that
needs attention but is out of scope — schema surprises, prod-data risks, bugs in adjacent
code, security smells — as `- [severity] file:line — what + why it matters`. Rob reads
this at the end. Known open items to carry forward are pre-listed in §F; verify rather
than re-discover them.

---

## A. Server workstream — Ubuntu VM (Rob runs via CLI agent on the box)

Current server state (from `infra/docker-compose.yml` + `infra/refresh-osrm.sh`):
Docker Compose with one `osrm` service on `127.0.0.1:5000`, MLD, data dir
`infra/osrm-data/`, weekly refresh cron at 03:00 Sunday, Cloudflare Tunnel terminates
`maps.incitat.io` → localhost:5000. Compose dir on the box is likely `/srv/ride/infra`
(the refresh script header says so) — **verify with `docker compose ls` / `ls /srv/ride`**.

### A1. OS + Docker hygiene (do first)
```bash
sudo apt-get update && sudo apt-get upgrade -y
sudo apt-get autoremove -y
docker system prune -f          # keeps volumes; frees old images
df -h                           # note free disk — need ~15 GB free for GraphHopper import
free -h                         # note RAM — GH import wants 4+ GB heap headroom
sudo reboot                     # if kernel updated; OSRM restarts via compose restart policy
```
After reboot: `curl -s "http://localhost:5000/route/v1/driving/151.2093,-33.8688;151.2153,-33.8568?overview=false" | head -c 200` → JSON with `"code":"Ok"`.

**Record in FINDINGS.md-style notes for Rob:** disk free, RAM, whether reboot was needed.

### A2. Validate `exclude=motorway` on existing OSRM (likely already works)
The standard car profile declares excludable classes (toll, ferry, motorway) and MLD
customize precomputes them. Test:
```bash
curl -s "http://localhost:5000/route/v1/driving/151.2093,-33.8688;150.3000,-33.7000?overview=false&exclude=motorway" | head -c 300
```
- `"code":"Ok"` and a longer duration than the same query without `exclude` → **works; done.**
- `"code":"InvalidQuery"` / error mentioning exclude → rebuild data once:
  `bash /srv/ride/infra/refresh-osrm.sh` (the script's extract+partition+customize with the
  stock image enables it), then re-test.

### A3. GraphHopper service (the "Windy" engine)
GH precomputes a per-edge **curvature** value and accepts a per-request `custom_model` —
this is what OSRM cannot do. Add to `infra/docker-compose.yml` on the box:

```yaml
  graphhopper:
    image: israelhikingmap/graphhopper:latest   # maintained multi-arch GH image; or graphhopper/graphhopper
    container_name: graphhopper
    restart: unless-stopped
    ports:
      - "127.0.0.1:8989:8989"
    volumes:
      - ./gh-data:/graphhopper/data
      - ./gh-config.yml:/graphhopper/config.yml:ro
    command: -Ddw.graphhopper.datareader.file=/graphhopper/data/data.osm.pbf --config /graphhopper/config.yml
    environment:
      - JAVA_OPTS=-Xmx4g -Xms1g
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://localhost:8989/health"]
      interval: 30s
      timeout: 5s
      retries: 3
```

`infra/gh-config.yml` (key parts — agent on the box writes the full file):
```yaml
graphhopper:
  datareader.file: /graphhopper/data/data.osm.pbf
  graph.location: /graphhopper/data/graph-cache
  graph.encoded_values: car_access, car_average_speed, road_class, curvature
  profiles:
    - name: car
      custom_model_files: []
  profiles_lm:
    - profile: car        # landmarks so per-request custom models stay fast
  routing.max_visited_nodes: 5000000
server:
  application_connectors:
    - type: http
      port: 8989
      bind_host: 0.0.0.0
```

Prepare + start:
```bash
cd /srv/ride/infra
mkdir -p gh-data
cp osrm-data/data.osm.pbf gh-data/data.osm.pbf   # reuse the extract OSRM already has
docker compose up -d graphhopper
docker logs -f graphhopper                        # first start imports the graph: Australia ≈ 30-90 min
```
**If the VM has < 8 GB RAM:** the Australia-wide GH import may OOM alongside OSRM's 6G
limit. Fallbacks in order: (1) temporarily `docker compose stop osrm` during import, then
start both; (2) lower `JAVA_OPTS -Xmx3g`; (3) import a smaller extract
(`australia-oceania/new-south-wales-latest.osm.pbf`) to validate the feature first and note
in findings that the full-country graph needs a bigger VM.

Validate windy routing (this is the acceptance test for the whole engine):
```bash
# Fastest (baseline)
curl -s -X POST http://localhost:8989/route -H 'Content-Type: application/json' -d '{
  "profile":"car", "points":[[148.6216,-36.4159],[148.3050,-36.5044]],
  "points_encoded": false }' | head -c 400

# Windy: penalize straight/fast roads so bendy ones win
curl -s -X POST http://localhost:8989/route -H 'Content-Type: application/json' -d '{
  "profile":"car", "points":[[148.6216,-36.4159],[148.3050,-36.5044]],
  "points_encoded": false, "ch.disable": true,
  "custom_model": {
    "priority": [
      { "if": "road_class == MOTORWAY", "multiply_by": "0.1" },
      { "if": "road_class == TRUNK",    "multiply_by": "0.4" },
      { "if": "curvature > 0.9",        "multiply_by": "0.7" }
    ]
  }}' | head -c 400
```
Note: GH `curvature` ≈ beeline/length per edge — **1.0 = dead straight, smaller = bendier**,
so penalizing `curvature > 0.9` demotes straight edges. Tune the three multipliers by
comparing geometries for 3-4 known scenic corridors (Jindabyne→Thredbo, a Putty Rd pair,
a GOR pair). Success = the windy route visibly prefers the scenic road while staying sane
(≤ ~1.6× fastest duration). Record the final tuned model — the Worker will own it (§B2).

### A4. Expose GH through the existing Cloudflare Tunnel
Add a route to the tunnel config (likely `/etc/cloudflared/config.yml`):
```yaml
ingress:
  - hostname: maps.incitat.io
    path: ^/gh/.*
    service: http://localhost:8989
  # existing OSRM rule stays below
  - hostname: maps.incitat.io
    service: http://localhost:5000
```
`sudo systemctl restart cloudflared`, then from anywhere:
`curl -s https://maps.incitat.io/gh/health`. If the tunnel uses the Cloudflare dashboard
(remotely-managed config), add the same two ordered routes there instead. GH strips no
prefix — if `/gh/` prefixing breaks GH's paths, use a tiny nginx/caddy rewrite or a
separate hostname `gh.incitat.io`; note whichever was chosen.

### A5. Ops finishing
- `docker compose ps` — both healthy, both `restart: unless-stopped`.
- Add GH graph rebuild to the weekly refresh script **or** decide GH refreshes monthly
  (graph import is heavy); note the decision.
- `curl` both public endpoints from off-box; confirm CORS: GH sends permissive CORS by
  default; if not, the app will call GH **via the Worker proxy** (§B2) which sidesteps
  CORS entirely — preferred anyway (keeps the custom model server-side).

---

## B. App workstream — Windy mode + avoid motorways

### B1. Route mode state
- `trip.settings.routing = { mode: 'fastest' | 'windy', avoidMotorways: boolean }`
  (settings JSON already round-trips through cloud and the guest shim untouched).
- Default `fastest` + `false`. Persist on change via the existing settings save path.

### B2. Worker proxy for GraphHopper (`api/journey.js` or new `api/gh.js`)
Add `POST /api/gh/route` → forwards `{points, avoidMotorways}` to
`https://maps.incitat.io/gh/route` with the **tuned custom model living server-side**
(client never ships routing policy). Auth not required (guests plan trips), but rate-limit
by IP with the existing `rateLimitByIp` helper (≈60/min). Timeout 12s. On upstream failure
return 502 with a stable `{error:{code:'ROUTING_UNAVAILABLE'}}` shape.
- Why proxy instead of browser→GH direct: no CORS exposure, custom-model policy stays
  private, and the sandbox/dev can stub one origin.

### B3. Client integration (`public/js/map.js`)
- Add a `GH` adapter beside the OSRM path: `_requestRoute` branches on
  `settings.routing.mode`. GH response → the same normalized route object
  (`coordinates` [{lat,lng}], `distance` m, `duration` s, `steps` [{text,distance,time,index}]
  — map GH `instructions[].interval[0]` to `index`). Curviness scoring/badges stay
  client-side and engine-agnostic.
- **Avoid motorways:** for OSRM append `exclude=motorway` (with `L.Routing.osrmv1` pass
  `requestParameters: {exclude:'motorway'}` if the installed LRM version supports it —
  verify in `public/vendor/leaflet/leaflet-routing-machine.min.js`; otherwise skip LRM and
  fetch the OSRM HTTP API directly in the adapter, which we already half-own). For GH the
  proxy folds it into the custom model (`road_class == MOTORWAY → multiply_by 0`).
- **Fallback:** windy request fails → toast "Windy routing unavailable — showing fastest",
  compute via OSRM, do NOT flip the saved mode.
- **UI:** a two-state toggle on the route bar (`route-selector.js` / `route-components.css`):
  `Fastest | Windy`, gold accent on Windy (it's the golden route). 44px touch targets,
  `stopPropagation` on gesture-starts like the rest of the bar (see the fix at
  `route-selector.js` — Leaflet eats gestures otherwise). Alternatives still render for
  whichever engine responded.

### B4. Validation (app side)
- Sandbox: synthetic-route injection — render both modes' pill bars, toggle, verify
  persistence in `trip.settings` for guest (localStorage) and reload-survival.
- CDP script (extend `scratchpad/test-route-scroll.js` pattern): toggle hit-target ≥44px,
  bar still scrolls, mode toggle doesn't pan the map.
- With Rob (real network): plan Jindabyne→Thredbo, flip to Windy, confirm different
  geometry + gold line + sensible duration; kill GH container → confirm graceful fallback.

---

## C. App workstream — "Clear shape points" (safe reset)

- **Button** in the waypoints toolbar (`index.html` + `ui.js` wiring), visible only when
  the trip has ≥1 `type === 'via'` waypoint. Label: "Clear shaping".
- **Behavior:** morph-confirm (first tap → "Clear N shape points?", 3s revert — same
  pattern as delete confirms in `ui-renderers.js`), then: push ONE undo snapshot
  (`App._pushWaypointHistory`), delete all via waypoints through the normal waypoint API
  (works for guest + cloud), reroute. Toast: `"Shape points cleared — Undo"`; if the toast
  system supports an action button, wire it to `App.undoWaypointChange()`; otherwise the
  toolbar Undo button suffices (verify it lights up).
- **Never** touch stops, notes, photos, journal, or the selected alternative.
- When legs land (§D): clearing scopes to the **active leg** if one is selected, whole trip
  otherwise; label adjusts ("Clear shaping — Leg 2").
- Validation: guest trip with 2 stops + 3 vias → clear → 2 stops remain, route recomputes,
  undo restores all 3 vias in one step and they persist after reload (undo persistence was
  fixed in app-core.js `_persistWaypointRestore` — regression-check it).

---

## D. App workstream — Trip legs & stitching

### D1. Data model — zero migration
- New waypoint `type: 'leg-break'` (free-text column; same trick as `via`). A leg-break is
  a divider: waypoints after it (in sort order) belong to the next leg. Name field holds
  the leg title ("Leg 2 — Sydney → Coffs" or user text). No lat/lng semantics; store the
  lat/lng of the *previous* waypoint (harmless, keeps NOT NULL happy) and never render a pin.
- **Prod-DB risk (verify FIRST, it gates everything):** an old CHECK constraint
  `type IN ('stop','scenic','fuel','food','lodging','custom')` may exist on the live
  `waypoints` table (flagged in an earlier pass: `api/schema_v2.sql:134` vs a later
  migration that allowed 'via'). Test on prod: create a `via` waypoint on a real cloud
  trip (Rob's account). If it 500s → SQLite needs a table rebuild migration
  (new table without the CHECK / with the extended list → copy → rename → recreate
  indexes/triggers). Write it as `api/migrations/2026-08-XX_waypoint_types.sql`, have Rob
  run `npx wrangler d1 execute ride-db --file=...` — **with a `--dry-run`-style SELECT
  check first and after**. Log outcome in FINDINGS.md either way.
- Backend allowlist: add `'leg-break'` in `api/waypoints.js`; exclude it (like `via`) from
  `api/journey.js` public serialization waypoint lists and `api/worker.js` OG stop counts.

### D2. Planning UX (`ui-renderers.js`, `waypoint-controller.js`, `app.css`)
- Waypoint list renders leg-breaks as full-width divider rows: leg title, per-leg
  distance/duration, collapse chevron (collapse state in `localStorage`, key
  `ride_leg_collapse_<tripId>`), "+ Add leg" button at list bottom.
- Stop numbering restarts per leg ("2.3" or just restart at 1 — restart at 1, simpler).
- Drag-reorder: dragging a leg-break moves the boundary; dragging a stop across a divider
  moves it between legs. Both fall out of existing sort_order reorder — verify, don't assume.
- Deleting a leg-break merges two legs (confirm-morph, undoable).

### D3. Routing per leg (`map.js`)
- Split ordered waypoints on leg-breaks → route each leg separately (existing debounced
  `_requestRoute` per segment, sequential to avoid hammering OSRM), then:
  `trip.route = { coordinates: concat(all legs), distance: Σ, duration: Σ, steps: concat
  with re-based indexes, legBoundaries: [coordinate index where each leg starts] }`.
  Stitched shape keeps **drive mode, share page, ride logs, stats all working unchanged**.
- Alternatives + windy/fastest mode apply to the **active leg** (the one being edited);
  selecting a leg = tapping its divider or a stop in it. Store per-leg mode in
  `settings.routing.perLeg[legIndex]` if trivially cheap; otherwise one mode per trip (fine
  for v1 — note choice in findings).
- Edits inside leg N only re-route leg N (big perf win for 100-stop trips).

### D4. Stitching existing trips
- Trips panel action "Append to trip…" → picker of destination trip → copies waypoints
  (prefixed by a new leg-break named after the source trip) + journal entries; **copies,
  never moves** — source trip untouched. Works guest+cloud (both APIs support create).
  Attachment copying is cloud-only and non-trivial (R2 object copy) — v1: skip attachments,
  note "photos stay on the source trip" in the confirm dialog; log as a finding.

### D5. Drive mode + share
- Drive mode v1: navigates the stitched route exactly as today. Add a leg picker to the
  pre-ride flow ONLY if trivial (start-at-waypoint already effectively exists via
  reroute-to-first-waypoint); otherwise note as follow-up.
- Share page (`trip.html`): render leg dividers as sections with per-leg stats; map draws
  the whole stitched line. `leg-break` never appears as a numbered stop.

### D6. Validation
- Guest: build 2-leg trip (2+2 stops + a via in each), verify per-leg totals, collapse,
  reorder across boundary, clear-shaping scoped to a leg, reload persistence.
- Cloud (with Rob): same on a real account; **the D1 CHECK-constraint probe from D1 above
  happens before any of this.**
- Share: share a 2-leg trip, verify sections, numbering, no leg-break leakage in OG counts.
- CDP mobile run: divider touch targets, collapse animation, list performance with 60
  synthetic stops (inject via local API).

---

## E. App workstream — Famous-roads suggestion chips

- `public/data/scenic-roads-au.json` (~15-25 curated entries):
  `{ id, name, blurb, region, entry: {lat,lng}, exit: {lat,lng}, shape: [4-8 via points] }`.
  Start with the obvious canon: Oxley Hwy, Putty Rd, Great Ocean Rd, Great Alpine Rd,
  Snowy Mountains Hwy, Bells Line, Macquarie Pass, Jamberoo Mountain Rd, Gillies Range,
  Tarra-Bulga, Targa-country Tasmania (Sideling, Elephant Pass), Adelaide Hills (Gorge Rd),
  Perth hills (Zig Zag / Mundaring Weir Rd). Verify coordinates against OSM before shipping.
- On route computed: cheap corridor test (point-to-polyline distance of each road's entry
  point vs route, threshold ~40 km). Matches → one dismissible chip above the route bar:
  *"Putty Road is near your route — take it?"* Accept = insert its `shape` as via points
  between the nearest stops + reroute (undoable, same snapshot pattern as §C). Dismiss =
  per-trip suppression list in localStorage.
- Max 1 chip at a time; never during ride mode; guests fully supported (pure client feature).
- **SW:** add `data/scenic-roads-au.json` to STATIC_ASSETS (contract #6) and to the deploy
  cache-bust regex? — deploy.js only rewrites `css|js|vendor` URLs; fetch the JSON with
  `fetch('/data/scenic-roads-au.json?v=' + BUILD marker)` or just rely on SW ignoreSearch +
  build purge. Choose one, note it.
- Validation: synthetic route past Putty Rd corridor → chip appears, accept inserts vias +
  reroutes, undo removes them, dismiss persists across reload, no chip in ride mode.

---

## F. Known open items (carry into FINDINGS.md, verify status, do not silently redo)

- Waypoints table CHECK constraint on `type` may reject `via`/`leg-break` in prod (§D1 —
  gate item).
- Share codes are 6-char (~36 bits); lengthening needs coordinated change (DB CHECK,
  trip.html regex, worker regex) — deliberately deferred.
- CSP still allows `unsafe-inline` scripts; nonce work deferred.
- `If-Match` optional on `PUT /api/trips/:id` (several callers omit it) — deferred.
- No offline outbox for notes/photos/waypoints when a **cloud** user is offline (guests are
  fine); deferred feature.
- Route-corridor tile prefetch ("download this route for offline") — SW side ready, needs
  a trigger UI; natural companion to drive mode, could ride along with §B if time allows.
- OSRM/GH unreachable from the Claude sandbox — all engine validation is curl-by-Rob or
  synthetic injection.
- admin.html is intentionally light-themed (dense data); not a brand bug.

## G. Definition of done

1. All four app workstreams implemented, `node --check` clean on every touched JS file,
   no new console noise.
2. CDP validation scripts for §B/§C/§D/§E in `scratchpad/`, all passing; screenshots of the
   new UI (mobile + desktop) captured for Rob.
3. `sw.js` STATIC_ASSETS updated for every new file; guest mode exercised for every feature.
4. `FINDINGS.md` written — including anything discovered mid-work, each with severity and
   a one-line recommendation.
5. Deploy only when Rob says go (`npm run deploy`); server steps (§A) delivered to Rob as
   a copy-pasteable block if he hasn't run them yet.
