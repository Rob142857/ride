# MCP server (phase 1: personal access tokens)

Ride has a Model Context Protocol endpoint at `POST /mcp` in the same Worker as `/api/*`.
In phase 1 it is meant for the owner's own agents (for example Claude Code or a trip agent),
signed in with a Ride personal access token. OAuth sign-in for third-party AI apps is phase 2.

- **Off by default.** It only answers when `MCP_ENABLED = "true"`. Otherwise `/mcp` is not routed and
  returns the same plain 404 as before.
- **Transport:** Streamable HTTP, one `POST` endpoint, JSON responses, no sessions. `GET`, `DELETE` and
  every other method get `405` with `Allow: POST`. `Mcp-Session-Id` and `Last-Event-ID` are ignored.
- **Protocol versions:** `2026-07-28` (stateless, per-request `_meta`, `server/discover`) and the older
  `initialize` lifecycle for `2025-11-25`, `2025-06-18` and `2025-03-26` clients.
- **No database migration.** Tokens, audit rows and rate counters reuse `api_tokens`,
  `api_token_audit` and `api_token_rate`. Itinerary preview handles live in the sessions KV for 15 minutes.

Code: `api/mcp.js` (protocol and auth), `api/mcp-tools.js` (tools), `api/mcp-scopes.js` (scope names),
`api/mcp-schema.js` (argument validation). Tests: `node scripts/mcp-test.js`.

## Turn it on

1. Set the variable in `wrangler.toml` (`[vars] MCP_ENABLED = "true"`), or in the Cloudflare dashboard
   under the Worker's variables, and deploy. Set it back to `"false"` to switch MCP off again; existing
   tokens keep working on `/api/*` either way.
2. In Ride, open **Settings > Access tokens**, create a token, and tick **Allow AI apps to connect (MCP)
   with this token** plus the things the agent may do. Copy the token (it is shown once).
3. Connect your client (below).

A token without `mcp.connect` keeps working on the REST API but is refused on `/mcp`, so older script
tokens never gain MCP access silently. Revoking a token in Settings stops it on the next call.

## Connect Claude Code

Keep the token out of files you commit. Put it in an environment variable, then:

```sh
claude mcp add --transport http ride https://ride.incitat.io/mcp --header "Authorization: Bearer $RIDE_PAT"
```

Or in a project `.mcp.json` (Claude Code expands `${RIDE_PAT}` from the environment):

```json
{
  "mcpServers": {
    "ride": {
      "type": "http",
      "url": "https://ride.incitat.io/mcp",
      "headers": { "Authorization": "Bearer ${RIDE_PAT}" }
    }
  }
}
```

Then run `/mcp` in Claude Code to check the connection and see the tools.

## Auth rules

- Only `Authorization: Bearer ride_pat_...` is accepted. Cookies are never read on `/mcp`, so a signed-in
  browser cannot reach it, and a session token sent as a bearer is refused.
- Every request re-reads the token (revoked, expired), the owner's account status (paused or blocked is
  refused) and the token's scopes. Nothing is cached.
- Tools call Ride's own handlers in-process. No token is passed to any other service.
- `Origin`, when present, must be Ride's own origin (or the same loopback origin in local development).
  A request for any other host is refused with `403` (DNS-rebinding defence).

| Situation | HTTP | JSON-RPC |
|---|---|---|
| No `Authorization` header | 401, `WWW-Authenticate: Bearer realm="ride", scope="mcp.connect trips.read"` | `-31001` |
| Not a Ride token, or invalid, expired or revoked | 401, `WWW-Authenticate: Bearer ... error="invalid_token"` | `-31001` |
| Account paused or blocked | 403 | `-31003` |
| Token lacks `mcp.connect` | 403, `WWW-Authenticate: Bearer ... error="insufficient_scope", scope="<its scopes> mcp.connect"` | `-31003` |
| Tool needs a scope the token lacks | 403, `insufficient_scope` naming every scope the call needs | `-31003` |
| Over 60 requests a minute or 1,000 an hour per token, or 20 writes a minute | 429 with `Retry-After` | `-31029` |

The `-310xx` codes are Ride's own, outside the JSON-RPC reserved range. The 60-a-minute counter is shared
with the token's REST calls.

## Scopes

Shared convention with cmail: `<area>.<verb>`, no combined read/write scope. The original colon scopes
remain valid aliases, so existing tokens keep working.

| Dot scope | Stored PAT scope (alias) | Tools |
|---|---|---|
| `mcp.connect` | `mcp.connect` | required for any `/mcp` call |
| `trips.read` | `trips:read` | `list_trips`, `get_trip`, `list_waypoints` |
| `itinerary.write` | `itinerary:write` | `preview_itinerary_update`, `apply_itinerary_update` |
| `waypoints.read`, `waypoints.write` | `waypoints:rw` | `list_waypoints`; `add_waypoint`, `update_waypoint`, `delete_waypoint`, `reorder_waypoints` |
| `fuel.read`, `fuel.write` | `fuel:rw` | `get_fuel_status`, `list_fuel_fills`; `add_fuel_fill`, `update_fuel_fill`, `delete_fuel_fill` |
| `checkins.read`, `checkins.write` | `checkins:rw` | `get_last_location`, `list_checkins`; `add_checkin`, `delete_checkin` |
| `ridelogs.read` | `ridelogs:read` | `list_ride_logs`, `get_ride_log` |
| `places.read`, `places.write` | `places:rw` | `list_saved_places`, `get_saved_place`; `save_place`, `update_saved_place`, `delete_saved_place` |
| `account.read` | `account.read` | `get_my_account` |

`tools/list` shows only the tools the token's scopes allow, always in the same order.

## Tools

Every tool has an `inputSchema` and `outputSchema`, returns `structuredContent` plus a short text copy,
and carries `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint` (always false).
R = read only, W = write, D = destructive, I = idempotent.

| Tool | Kind | Arguments (required in bold) |
|---|---|---|
| `list_trips` | R | `limit` (1-50), `cursor` |
| `get_trip` | R | **`trip_id`**, `include` (`waypoints`, `itinerary`, `journal`, `route_summary`; default waypoints and itinerary) |
| `preview_itinerary_update` | R | **`trip_id`**, **`planning_file`** (as in `docs/itinerary-api.md`) |
| `apply_itinerary_update` | W, D | **`trip_id`**, **`preview_id`**, **`expected_version`** (the preview's `trip_version`) |
| `list_waypoints` | R | **`trip_id`** |
| `add_waypoint` | W | **`trip_id`**, **`expected_version`**, **`name`**, **`lat`**, **`lng`**, `type`, `address`, `notes` |
| `update_waypoint` | W, I | **`trip_id`**, **`expected_version`**, **`waypoint_id`**, and at least one of `name`, `lat`, `lng`, `type`, `address`, `notes` |
| `delete_waypoint` | W, D, I | **`trip_id`**, **`expected_version`**, **`waypoint_id`** (warns when an itinerary stop points at it) |
| `reorder_waypoints` | W, I | **`trip_id`**, **`expected_version`**, **`order`** (every waypoint id once) |
| `get_fuel_status` | R | **`trip_id`** |
| `list_fuel_fills` | R | **`trip_id`**, `limit` (1-500) |
| `add_fuel_fill` | W | **`trip_id`**, **`price_per_litre`**, `id` (your own, makes retries safe), `litres`, `full_tank`, `jerry_litres`, `payment_method`, `station_name`, `odometer_km`, `filled_at`, ... |
| `update_fuel_fill` | W, I | **`trip_id`**, **`fill_id`**, fields to change |
| `delete_fuel_fill` | W, D, I | **`trip_id`**, **`fill_id`** |
| `get_last_location` | R | **`trip_id`** |
| `list_checkins` | R | **`trip_id`**, `limit` (1-500) |
| `add_checkin` | W | **`trip_id`**, **`lat`**, **`lng`**, `id`, `accuracy_m`, `recorded_at`, `note` (stored with source `agent`) |
| `delete_checkin` | W, D, I | **`trip_id`**, **`checkin_id`** |
| `list_ride_logs` | R | **`trip_id`**, `cursor` (summaries only, no GPS points) |
| `get_ride_log` | R | **`trip_id`**, **`log_id`**, `full` (track simplified to 2,000 points unless true) |
| `list_saved_places` | R | `type`, `tag`, `near` `{lat, lng, radius_m <= 50000}`, `limit`, `cursor` |
| `get_saved_place` | R | **`place_id`** |
| `save_place` | W | **`name`**, **`lat`**, **`lng`**, `type`, `notes`, `tags`, ... (as the saved places API) |
| `update_saved_place` | W, I | **`place_id`**, fields to change |
| `delete_saved_place` | W, D, I | **`place_id`** |
| `get_my_account` | R | none |

Not exposed over MCP (they stay in the app): creating trips or tokens, deleting trips, share links,
journal edits, attachments, places search (Google), places import/export and account purge.

### Concurrency: `expected_version`

Trip writes (waypoints and itinerary apply) need `expected_version`, the trip version you last read
(`trip.version` from `get_trip`, `trip_version` from `list_waypoints` or the last write). It is passed to
the handler as `If-Match`. A stale version is a **tool error** (`isError: true`), not a protocol error, so
the model can recover:

```json
{
  "resultType": "complete",
  "isError": true,
  "content": [{ "type": "text", "text": "Conflict: the trip changed since the version you sent. It is now at version 14 ... Nothing was saved. Read the trip again with get_trip, then redo the change with the new expected_version.\n{\"conflict\":true,\"trip_version\":14,\"trip_updated_at\":\"...\"}" }],
  "_meta": { "io.incitat.ride/conflict": { "conflict": true, "trip_version": 14, "trip_updated_at": "..." } }
}
```

Every successful trip write returns the new `trip_version`, so the next write can chain without a re-read.
Fill-ups, check-ins and places are not versioned in Ride; send your own `id` on `add_fuel_fill` and
`add_checkin` to make retries safe.

Itinerary updates are two steps: `preview_itinerary_update` returns `preview_id` and `trip_version`
(nothing is saved); `apply_itinerary_update` needs both within 15 minutes. The preview is bound to the
same user, token and trip, is used once, and apply rebuilds the preview against the trip as stored. If the
trip changed in between, nothing is saved and the model is told to preview again.

## Examples

Modern (2026-07-28) request. The `MCP-Protocol-Version`, `Mcp-Method` and (for `tools/call`) `Mcp-Name`
headers must match the body, and `_meta` must carry the protocol version and client capabilities:

```sh
curl -s https://ride.incitat.io/mcp \
  -H "Authorization: Bearer $RIDE_PAT" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "MCP-Protocol-Version: 2026-07-28" -H "Mcp-Method: tools/call" -H "Mcp-Name: get_fuel_status" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_fuel_status","arguments":{"trip_id":"TRIP_ID"},
       "_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'
```

Legacy clients start with `initialize` (no `_meta` needed), then send `MCP-Protocol-Version` with the
negotiated version on later requests. Ride mints no session id.

```sh
curl -s https://ride.incitat.io/mcp -H "Authorization: Bearer $RIDE_PAT" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"example","version":"1"}}}'
```

Protocol errors: missing `_meta` fields `-32602` (400), header mismatch `-32020` (400), unsupported
version `-32022` (400, with `supported` and `requested`), unknown method `-32601` (404 on the modern wire;
`initialize` and `ping` count as unknown there), unknown tool `-32602`. Results on the modern wire carry
`resultType: "complete"` and `_meta["io.modelcontextprotocol/serverInfo"]`; `server/discover` and
`tools/list` carry `ttlMs` and `cacheScope`.

## Audit

Every `tools/call` writes one `api_token_audit` row: `method = 'MCP'`, `route = /mcp/tools/call/<tool>?trip=<id>`
and an HTTP-style status (200 ok, 400 invalid, 403 denied, 404 not found, 409 conflict, 429 limited, 500 error).
Arguments, coordinates and free text are never logged.

## Local testing

- Unit and integration: `node scripts/mcp-test.js` (real Worker, in-memory SQLite, invented data).
- Local server: seed a local D1 with invented data and a test token, then
  `npx wrangler dev --local --ip 127.0.0.1 --port 8787 --var MCP_ENABLED:true`.
- Official suite (pinned): `npx @modelcontextprotocol/conformance@0.2.0-alpha.12 server --url http://127.0.0.1:8787/mcp --requirements 2026-07-28`
  and again with `--requirements 2025-11-25`. The CLI cannot send an `Authorization` header, so run it
  through a small local proxy that adds the local test token.
- Inspector: `npx @modelcontextprotocol/inspector@2.11.0 --cli http://127.0.0.1:8787/mcp --transport http --header "Authorization: Bearer <local test token>" --method tools/list`.

Never point these at production with a real token.
