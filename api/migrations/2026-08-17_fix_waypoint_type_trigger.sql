-- 2026-08-17: Fix the waypoint-type CHECK triggers — they reject types the app writes.
--
-- BUG THIS FIXES (was live in prod, caused HTTP 500 on waypoint creation):
-- 2026-06-28_hardening.sql installed BEFORE INSERT/UPDATE triggers on
-- waypoints that RAISE(ABORT) unless `type` is in a hardcoded enum. That enum
-- was written before three types the app now uses existed:
--
--   'lodging'   — user-facing waypoint category (api/waypoints.js WAYPOINT_TYPES)
--   'custom'    — user-facing waypoint category (ditto)
--   'leg-break' — the entire multi-leg trips feature (leg divider rows)
--
-- Any attempt to save one of those returned 'invalid waypoint type' from
-- SQLite, which surfaced as a 500. Confirmed against prod on 2026-08-17:
-- `SELECT type, COUNT(*) FROM waypoints GROUP BY type` returned only
-- stop/via/scenic/food — i.e. no lodging, custom or leg-break waypoint has
-- EVER persisted to the cloud. The legs feature was validated only against
-- the guest (localStorage) path, which has no such constraint, so the cloud
-- failure went unnoticed until a user hit it.
--
-- NOTE: FINDINGS.md previously asserted this hardening migration was not
-- applied to prod. That was wrong — the triggers are live. Corrected there.
--
-- The enum below is the UNION of the old trigger's list and the app's current
-- api/waypoints.js WAYPOINT_TYPES set, so no existing row becomes invalid.
-- Keep it in sync with WAYPOINT_TYPES whenever a type is added.
--
-- Apply (api/migrations/*.sql are applied by hand — nothing tracks which have run):
--   Remote: npx wrangler d1 execute ride-db --file=./api/migrations/2026-08-17_fix_waypoint_type_trigger.sql --remote
--   Local:  npx wrangler d1 execute ride-db --file=./api/migrations/2026-08-17_fix_waypoint_type_trigger.sql --local

DROP TRIGGER IF EXISTS trg_waypoint_type_insert;
DROP TRIGGER IF EXISTS trg_waypoint_type_update;

CREATE TRIGGER trg_waypoint_type_insert
BEFORE INSERT ON waypoints
WHEN NEW.type IS NOT NULL AND NEW.type NOT IN (
  'stop', 'start', 'end', 'via', 'leg-break', 'camp', 'fuel', 'food', 'water',
  'scenic', 'rest', 'border', 'hotel', 'lodging', 'poi', 'custom'
)
BEGIN
  SELECT RAISE(ABORT, 'invalid waypoint type');
END;

CREATE TRIGGER trg_waypoint_type_update
BEFORE UPDATE ON waypoints
WHEN NEW.type IS NOT NULL AND NEW.type NOT IN (
  'stop', 'start', 'end', 'via', 'leg-break', 'camp', 'fuel', 'food', 'water',
  'scenic', 'rest', 'border', 'hotel', 'lodging', 'poi', 'custom'
)
BEGIN
  SELECT RAISE(ABORT, 'invalid waypoint type');
END;
