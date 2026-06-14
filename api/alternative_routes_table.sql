CREATE TABLE IF NOT EXISTS alternative_routes (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  route_index INTEGER NOT NULL DEFAULT 0,
  name TEXT,
  summary TEXT,
  color TEXT,
  distance_meters REAL,
  duration_seconds REAL,
  is_selected BOOLEAN NOT NULL DEFAULT 0,
  is_visible BOOLEAN NOT NULL DEFAULT 1,
  coordinates TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(trip_id, route_index)
);
