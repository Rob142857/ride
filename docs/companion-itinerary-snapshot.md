# Private Companion itinerary snapshot

Ride exposes a read-only endpoint for an authenticated trip owner to load the full itinerary in Companion:

```text
GET /api/trips/{tripId}/companion-itinerary
```

The handler checks the Ride session and verifies that the signed-in user owns `{tripId}` before reading R2. It reads only `private-itineraries/{tripId}/trip-companion-itinerary.json` from `RIDE_TRIP_PLANNER_ATTACHMENTS`. It does not fall back to public trip sharing and has no HTTP write operation. The publisher writes snapshots directly to R2.

The object is a JSON wrapper with this contract:

```json
{
  "schemaVersion": 1,
  "sourceSha256": "<64 lowercase hexadecimal characters>",
  "publishedAt": "<ISO 8601 timestamp>",
  "itinerary": {
    "rideTripId": "<the same Ride trip ID>",
    "isPublic": false,
    "settings": {
      "itinerary": {
        "version": 1,
        "stops": [{ "id": "<stable stop ID>", "name": "<stop name>" }]
      }
    },
    "waypoints": [],
    "journal": []
  }
}
```

At least one of `id`, `rideTripId`, or `cloudTripId` is required, and every identifier present must match the requested Ride trip. At least one explicit private flag (`isPublic: false`, `is_public: false`, or `is_public: 0`) is required, and any public-true flag causes rejection. `settings.itinerary`, `waypoints`, and `journal` are required so a compact Ride planning update cannot be mistaken for the full Companion export. The reader also rejects unsupported schema versions, invalid hashes or timestamps, malformed plans, more than 500 stops, more than 10,000 waypoint or journal entries, and snapshots over 16 MiB. No itinerary fields are trimmed. An absent object returns 404 with a friendly message; an invalid object returns 500 for the owner to republish.

Only this endpoint grants credentialed CORS to the exact origin `https://trip.incitat.io`. Its success and error responses use `Cache-Control: no-store`, `Pragma: no-cache`, and `Expires: 0`; do not add it to service-worker caching. Existing Ride routes retain their current CORS behavior.
