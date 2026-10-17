# Trip saves: back-off, single-flight and conflicts

`public/js/save-guard.js` sits between `App.saveCurrentTrip()` and `PUT /api/trips/:id`.

- **Single-flight per trip.** One save is in flight per trip. Calls made meanwhile collapse into one follow-up save, which sends the latest state.
- **Transient errors** (network, 408, 425, 429, 5xx) retry after about 1s, 2s, 4s and so on, with ±25% jitter, up to 60s. `Retry-After` is honoured, up to 10 minutes. After 8 retries the app gives up and says "Save failed. Not saved to cloud." Calls made during back-off send nothing; the scheduled retry carries the latest state.
- **409/412 conflict.** Autosave for that trip pauses, which covers both the trip PUT and the alternative-routes save. The latest trip is fetched once, and the rider sees "Changed on another device" with two choices:
  - **Reload** loads the server copy.
  - **Keep mine** adopts the server version number and saves this device's copy once. If that save conflicts again, the rider is asked again.
  - Nothing retries on its own. Waypoint and itinerary conflicts open the same prompt.

Why: before this change, a persistent 409 ran `handleTripConflict → refreshData → loadTripData → OSRM reroute → routesfound → saveRouteData → PUT` with no pause. The refused save was the one carrying the route, so the reloaded trip had no route, and loading a trip without a route recalculates it on OSRM and saves again. That came to about 1,600 requests in 3 s.

Tests: `node scripts/save-guard-test.js` and `npm run test:mobile` (the `saving` test in `e2e/mobile/smoke.spec.mjs`).

## Verified release

Build `2026-10-17T04` (deployed 18 October 2026, about 04:20 Australia/Sydney), service worker `ride-v15`, deployed from branch `claude/ride-409-backoff` (commit `b44a82a`). Live Worker version: `a91159c5-97c8-4f94-aa48-30c9747826bc`. After the deploy:
- `/api/_build` reported the new build.
- The app shell served `save-guard.js` and the conflict dialog.
- `/api/trips` and `/api/auth/me` returned 401 without a session.
- `npm run smoke` passed.

Rollback target: Worker version `5c8d8006-babf-4ca5-93e0-ca07e5589b71` (build `2026-10-17T03`). To roll back, run `npx wrangler rollback 5c8d8006-babf-4ca5-93e0-ca07e5589b71`. No schema change was made.
