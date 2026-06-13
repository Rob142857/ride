-- Alternative routes support: store optional route variants per trip
-- Each alternative has coordinates, distance, duration, and an optional label.

CREATE TABLE IF NOT EXISTS alternative_routes (
  id          TEXT PRIMARY KEY CHECK(length(id) > 0),
  trip_id     TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  label       TEXT DEFAULT 'Alternative',
  coordinates TEXT NOT NULL DEFAULT '[]',          -- JSON array of [lng, lat]
  distance    REAL,                                 -- metres
  duration    REAL,                                 -- seconds
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_alt_route_trip ON alternative_routes(trip_id);

-- Auto-update updated_at on alternative_routes
CREATE TRIGGER IF NOT EXISTS trg_alt_route_updated
AFTER UPDATE ON alternative_routes
FOR EACH ROW
WHEN OLD.updated_at = NEW.updated_at
BEGIN
  UPDATE alternative_routes SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- Bump parent trip version when alternative routes are inserted/updated/deleted
CREATE TRIGGER IF NOT EXISTS trg_alt_route_insert_bump
AFTER INSERT ON alternative_routes
FOR EACH ROW
BEGIN
  UPDATE trips SET updated_at = datetime('now'), version = version + 1
  WHERE id = NEW.trip_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_alt_route_update_bump
AFTER UPDATE ON alternative_routes
FOR EACH ROW
BEGIN
  UPDATE trips SET updated_at = datetime('now'), version = version + 1
  WHERE id = NEW.trip_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_alt_route_delete_bump
AFTER DELETE ON alternative_routes
FOR EACH ROW
BEGIN
  UPDATE trips SET updated_at = datetime('now'), version = version + 1
  WHERE id = OLD.trip_id;
END;