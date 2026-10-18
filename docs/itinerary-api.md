# Itinerary and waypoint API (access tokens)

For scripts such as a trip agent that update a trip without driving the UI.
Create a token in **Settings > Access tokens**; send it as `Authorization: Bearer ride_pat_...`.
The owner's signed-in Ride session (cookie) can call the same routes. Token responses carry no CORS
headers, every token write (POST/PUT/DELETE) is recorded in `api_token_audit`, and each token is limited
to 60 requests a minute.

All writes use the trip version for optimistic concurrency:

| Situation | Status |
|---|---|
| `If-Match` missing on a write that needs it | `428` `{ "precondition_required": true }` |
| `If-Match` is not the trip's current version | `409` `{ "conflict": true, "trip_version": 12, "trip_updated_at": "..." }` |
| Token lacks the route's scope | `403` `{ "required_scope": "waypoints:rw" }` |
| Trip not found or not yours | `404` |

Ride uses `409` for a stale version (the same as the UI and every other trip write), not `412`.
On `409`, read the trip again (`GET /api/trips/:id`, scope `trips:read`), redo the change and retry.
`If-Match` takes the bare version number; `"12"` (quoted, as sent back in `ETag`) also works.

## Waypoints (`waypoints:rw`)

Waypoints are the map stops. Itinerary stops point at them by `waypointId`.
Every waypoint write bumps the trip version; each response returns the new `trip_version`
for the next `If-Match`.

```http
POST /api/trips/TRIP_ID/waypoints
If-Match: 12
Content-Type: application/json

{ "name": "Example Creek rest area", "lat": -31.25, "lng": 150.75, "type": "stop", "address": "", "notes": "" }
```
`201` `{ "waypoint": { "id": "...", "sort_order": 3, ... }, "trip_version": 13, "trip_updated_at": "..." }`.
New waypoints go to the end of the order. `type` is one of `stop`, `scenic`, `fuel`, `food`, `lodging`, `custom`.

```http
PUT /api/trips/TRIP_ID/waypoints/WAYPOINT_ID
If-Match: 13

{ "name": "Example Creek camp", "notes": "Changed" }
```
`200` `{ "waypoint": {...}, "trip_version": 14 }`. Send only the fields to change
(`name`, `address`, `lat`, `lng`, `type`, `notes`, `sort_order`).

```http
PUT /api/trips/TRIP_ID/waypoints/reorder
If-Match: 14

{ "order": ["WP_3", "WP_1", "WP_2"] }
```
`200` `{ "success": true, "trip_version": 18 }`. The order must list every waypoint of the trip exactly once.

```http
DELETE /api/trips/TRIP_ID/waypoints/WAYPOINT_ID
If-Match: 18
```
`200` `{ "success": true, "trip_version": 19 }`. If an itinerary stop still points at a deleted waypoint,
later itinerary saves refuse it until the plan is updated.

## Itinerary planning update (`itinerary:write`)

The API version of **Trip itinerary > Update this itinerary**. It takes the same mapped planning file,
runs the same guards and builds the same preview as the app (the code is shared:
`public/js/itinerary.js`), and saves only `settings.itinerary`. Route, waypoints, journals,
visibility and other settings are never touched.

### 1. Preview (dry run, never writes)

```http
POST /api/trips/TRIP_ID/itinerary/preview
Content-Type: application/json

{
  "rideTripId": "TRIP_ID",
  "itinerary": {
    "version": 1, "startDate": "2026-03-02",
    "fuel": { "litresPer100Km": 10, "pricePerLitre": 2.5 },
    "stops": [
      { "id": "alpha", "name": "Alpha Creek", "waypointId": "WP_1", "minNights": 1, "plannedNights": 1, "maxNights": 4 },
      { "id": "beta", "name": "Beta Flats", "waypointId": "WP_2", "minNights": 1, "plannedNights": 3, "maxNights": 3,
        "fixedDate": "2026-03-04", "anchorMode": "withinStay", "leg": { "distanceKm": 240, "durationHours": 3 } },
      { "id": "delta", "name": "Delta Rest", "waypointId": "WP_3", "minNights": 0, "plannedNights": 0, "maxNights": 1 }
    ]
  },
  "waypoints": [{ "id": "WP_1" }, { "id": "WP_2" }, { "id": "WP_3" }]
}
```

The body is the planning file: `rideTripId` must equal the trip id; the plan is `itinerary` (or
`settings.itinerary`); optional `waypoints` and `journal` arrays may only name this trip's records.

`200`, with header `ETag: "12"` (the trip version the preview was built on):

```json
{
  "trip_id": "TRIP_ID",
  "trip_version": 12,
  "can_apply": true,
  "summary": { "start_date": "2026-03-02", "end_date": "2026-03-06", "stops": 3, "nights": 4, "distance_km": 240, "fuel_cost": 60 },
  "stop_changes": [
    { "stopId": "alpha", "name": "Alpha Creek", "change": "changed",
      "before": { "arrivalDate": "2026-03-02", "departureDate": "2026-03-04", "plannedNights": 2 },
      "after":  { "arrivalDate": "2026-03-02", "departureDate": "2026-03-03", "plannedNights": 1 } },
    { "stopId": "delta", "name": "Delta Rest", "change": "added", "before": null, "after": { "...": "..." } },
    { "stopId": "gamma", "name": "Gamma Point", "change": "removed", "before": { "...": "..." }, "after": null }
  ],
  "anchor_changes": [
    { "stopId": "beta", "name": "Beta Flats", "before": { "date": "2026-03-05", "mode": "withinStay" },
      "after": { "date": "2026-03-04", "mode": "withinStay" }, "removedStop": false }
  ],
  "draft_changes": [ { "town": "Alpha Creek", "previous": { "...": "..." }, "item": { "...": "..." } } ],
  "conflicts": [],
  "warnings": [],
  "validation_errors": [],
  "itinerary": { "version": 1, "startDate": "2026-03-02", "endDate": "2026-03-06", "stops": [ "..." ] }
}
```

- `stop_changes`: the date list the UI preview shows (added, changed, removed stops).
- `anchor_changes`: fixed-date commitments that change; the UI asks for "Save changes including fixed commitments".
- `draft_changes`: outreach and work drafts that are new, changed or removed.
- `conflicts`, `warnings`, `validation_errors`: as the UI shows them. `can_apply` is false if there are
  conflicts or validation errors (including the server's own save checks).
- `itinerary`: exactly what apply would save (recalculated dates, moved draft deadlines).

If a guard refuses the file (wrong trip, a waypoint or note outside the trip, a fixed date the plan cannot
meet), the response is `400` `{ "error": "<the message the UI shows>", "guard": true }`.

### 2. Apply

Send the same file again with the preview's `ETag` as `If-Match`:

```http
POST /api/trips/TRIP_ID/itinerary/apply
If-Match: "12"
Content-Type: application/json

{ ...same planning file... }
```

`200`, with `ETag: "13"`:

```json
{ "trip": { "id": "TRIP_ID", "version": 13, "updated_at": "2026-10-18 01:02:03" },
  "applied": { "trip_version": 12, "can_apply": true, "stop_changes": [ "..." ], "anchor_changes": [ "..." ], "...": "..." } }
```

- `428` without `If-Match`; `409` if the trip changed since the preview (preview again, check, then apply).
- `400` `{ "error": "...", "preview": {...} }` if the plan has conflicts or validation errors; nothing is saved.
- The server rebuilds the preview from the stored trip at apply time, so the saved plan is the one the
  preview at that version showed.

### Saving a plan as is

`PUT /api/trips/:id/itinerary` with `If-Match` and `{ "itinerary": {...} }` still saves a plan without the
planning-file guards or recalculation (see README).
