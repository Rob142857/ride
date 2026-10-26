/**
 * Scope names for Ride's MCP server.
 *
 * Shared convention with cmail: dots, `<area>.<verb>`, admin scopes as
 * `admin.<area>.<verb>`, and no combined read/write scope. The personal access
 * token scopes Ride shipped first use colons (`fuel:rw`); they stay valid as
 * aliases, so every existing token keeps working:
 *   trips:read      -> trips.read
 *   itinerary:write -> itinerary.write
 *   waypoints:rw    -> waypoints.read + waypoints.write
 *   places:rw       -> places.read + places.write
 *   fuel:rw         -> fuel.read + fuel.write
 *   checkins:rw     -> checkins.read + checkins.write
 *   ridelogs:read   -> ridelogs.read
 *   journal:write   -> journal.write
 * Dot names pass through unchanged. Unknown names are dropped.
 */

export const MCP_CONNECT_SCOPE = 'mcp.connect';

/** Every dot scope Ride understands, in a fixed order (used for challenges and docs). */
export const DOT_SCOPES = [
  'trips.read', 'itinerary.write', 'waypoints.read', 'waypoints.write',
  'places.read', 'places.write', 'fuel.read', 'fuel.write',
  'checkins.read', 'checkins.write', 'ridelogs.read', 'journal.write', 'account.read', MCP_CONNECT_SCOPE
];

export const SCOPE_ALIASES = Object.freeze({
  'trips:read': ['trips.read'],
  'itinerary:write': ['itinerary.write'],
  'waypoints:rw': ['waypoints.read', 'waypoints.write'],
  'places:rw': ['places.read', 'places.write'],
  'fuel:rw': ['fuel.read', 'fuel.write'],
  'checkins:rw': ['checkins.read', 'checkins.write'],
  'ridelogs:read': ['ridelogs.read'],
  'journal:write': ['journal.write']
});

/** Expand a stored scope list (colon aliases and/or dot names) into a set of dot scopes. */
export function normalizeScopes(scopes) {
  const out = new Set();
  if (!Array.isArray(scopes)) return out;
  for (const scope of scopes) {
    if (typeof scope !== 'string') continue;
    if (SCOPE_ALIASES[scope]) for (const dot of SCOPE_ALIASES[scope]) out.add(dot);
    else if (DOT_SCOPES.includes(scope)) out.add(scope);
  }
  return out;
}

/** Dot scopes from a set, in canonical order. */
export function orderedScopes(set) {
  return DOT_SCOPES.filter(scope => set.has(scope));
}
