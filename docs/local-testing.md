# Running Ride locally with the real Worker (tested 28 Nov 2026)

Goal: exercise the real Worker, CSP and sign-in cookie without touching production. Use invented data only.

1. `wrangler dev --local --persist-to <scratch dir>` with a copy of wrangler.toml whose `main` is a tiny wrapper (`export { default } from '<repo>/api/worker.js';`) and whose `[assets] directory` points at `public/`. Remove `routes`.
2. Build the local D1: `wrangler d1 execute ride-db --local --persist-to <dir> --file ...` with `api/schema_v2.sql` (delete its `PRAGMA` lines first), then `ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`, then the migrations in order: 2026-06-13, 06-14, 06-18_ride_logs, 10-17_saved_places, 10-17_tokens_fuel_checkins, 11-08_devices, 04-19_share_views, 06-28_hardening, then `ALTER TABLE alternative_routes ADD COLUMN steps TEXT DEFAULT '[]'`.
3. Seed a test user, a trip and waypoints; put a session in local KV (`wrangler kv key put <token> --binding RIDE_TRIP_PLANNER_SESSIONS --local --persist-to <dir> --path session.json`, value `{"user":{"id":...,"email":...},"expiresAt":<ms>}`); send it as the `ride_session` cookie. Create a test token with `POST /api/tokens` while signed in, then call `/mcp` with it.

Traps (all local-only):
- **`export const CSP` / `CSP_ADMIN` in api/worker.js:** the local runtime (workerd) rejects named non-function exports as entrypoints ("Incorrect type for map entry 'CSP'"); production accepts them. That is why step 1 uses a wrapper that re-exports only the default. Fixed for good when the CSP becomes a function in its own file.
- **`trips.short_code` CHECK uses a long GLOB:** the local SQLite says "LIKE or GLOB pattern too complex" on any insert, so a share code cannot be created. Local workaround: in your scratch copy of the schema only, drop `AND short_code GLOB '...'` from that CHECK, then `POST /api/trips/<id>/share` gives a code and `/<code>` shows the public page.
- Waypoint `type` must satisfy both the table CHECK and the hardening trigger: use `stop`, `food`, `scenic` or `fuel`.
- Run the unit tests with `node --test tests/*.test.mjs` (in PowerShell: pass the file list); plain `node --test tests/` fails.
