-- Ride logs: actual GPS tracks recorded when navigation (ride mode) is active.
-- Each log is linked to a trip and optionally to a private journal entry that
-- captures a human-readable summary (distance, duration, avg speed).

CREATE TABLE IF NOT EXISTS ride_logs (
  id                TEXT PRIMARY KEY CHECK(length(id) > 0),
  trip_id           TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  journal_entry_id  TEXT REFERENCES journal_entries(id) ON DELETE SET NULL,
  started_at        TEXT,                        -- ISO-8601 timestamp
  ended_at          TEXT,                        -- ISO-8601 timestamp
  distance_meters   REAL CHECK(distance_meters IS NULL OR distance_meters >= 0),
  duration_seconds  REAL CHECK(duration_seconds IS NULL OR duration_seconds >= 0),
  track             TEXT NOT NULL DEFAULT '[]',  -- JSON [{lat, lng, t}] breadcrumb
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ride_logs_trip ON ride_logs(trip_id, started_at DESC);
