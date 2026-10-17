# Saved places

A private, per-user list of places worth revisiting (camp sites, showers, library/work spots, fuel, food). Places belong to the signed-in account, not a trip, so they carry across trips. They are never public or shared.

Open it from the side menu: **My Places**. Add a place from a map tap, your current location, or a waypoint (waypoint details: **Save to my Places**). Filter by type and tag, search, show places on the map, edit, delete (with confirmation), and export or import JSON.

## Storage

Table `saved_places`, created by `api/migrations/2026-10-17_saved_places.sql` (additive: one table, two indexes). List fields (`tags`, `facilities`, `source_links`) are JSON arrays. The optional `trip_id`/`waypoint_id` link is a soft reference with no foreign key, so editing or deleting trips never removes a place; the API only stores a link to a waypoint the same user owns.

Apply the migration:

```sh
npx wrangler d1 execute ride-db --local  --file=api/migrations/2026-10-17_saved_places.sql
npx wrangler d1 execute ride-db --remote --file=api/migrations/2026-10-17_saved_places.sql
```

## API (all require a Ride session)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/saved-places` | The caller's places |
| POST | `/api/saved-places` | Create |
| GET | `/api/saved-places/:id` | Read one |
| PUT | `/api/saved-places/:id` | Partial update |
| DELETE | `/api/saved-places/:id` | Delete |
| GET | `/api/saved-places/export` | `{ kind: "ride-saved-places", schemaVersion: 1, exportedAt, places }` |
| POST | `/api/saved-places/import` | Same shape (or `{ places }`). Ids the caller owns are updated; anything else is created with a new id. The whole file is validated before any write. |

No session returns 401, a blocked account 403, and another user's place 404 (indistinguishable from a missing one). Account purge (`POST /api/user/purge`) also deletes the caller's saved places.

## Checks

```sh
node scripts/saved-places-test.js
```

Runs the real Worker router against in-memory SQLite built from the migration. Fixtures are invented.

## Verified release

Build `2026-10-17T01` (17 October 2026, Australia/Sydney), service worker `ride-v13`, deployed from merge `7013953`. Live Worker version: `5f954135-58d5-45dd-85e3-0bcc3fef7021`. The migration was applied to production D1 before the deploy. After deployment, every saved-places route returned 401 without a session, `/api/_build` reported the new build and the app shell loaded with the new assets.

Rollback target: Worker version `f4b233b3-0e5f-4319-b2ea-962ebad96c62` (build `2026-10-15T01`): `npx wrangler rollback f4b233b3-0e5f-4319-b2ea-962ebad96c62`. The `saved_places` table can stay; the older Worker ignores it.
