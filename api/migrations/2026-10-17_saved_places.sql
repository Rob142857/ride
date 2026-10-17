-- 2026-10-17: Saved places — a private, per-user "places worth revisiting" store.
-- Additive only: one new table and its indexes. No existing table or row changes.
--
-- Places belong to a user, not a trip, so they carry across trips. The optional
-- trip/waypoint link is a soft reference (no FK): trips and waypoints can be edited,
-- re-created or deleted without touching saved places. The API checks that a linked
-- waypoint belongs to the same user before storing the link.
-- List fields (tags, facilities, source_links) hold JSON arrays.

CREATE TABLE IF NOT EXISTS saved_places (
  id              TEXT PRIMARY KEY CHECK(length(id) > 0),
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL CHECK(length(name) > 0),
  type            TEXT NOT NULL DEFAULT 'other'
                    CHECK(type IN ('campsite', 'shower', 'work', 'fuel', 'food', 'other')),
  lat             REAL NOT NULL CHECK(lat >= -90 AND lat <= 90),
  lng             REAL NOT NULL CHECK(lng >= -180 AND lng <= 180),
  address         TEXT,
  rating          INTEGER CHECK(rating IS NULL OR (rating >= 1 AND rating <= 5)),
  notes           TEXT,
  tags            TEXT NOT NULL DEFAULT '[]',
  cost_amount     REAL CHECK(cost_amount IS NULL OR cost_amount >= 0),
  cost_note       TEXT,
  cost_seen_on    TEXT,
  facilities      TEXT NOT NULL DEFAULT '[]',
  best_time       TEXT,
  avoid           TEXT,
  last_visited_on TEXT,
  source_links    TEXT NOT NULL DEFAULT '[]',
  trip_id         TEXT,
  waypoint_id     TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_saved_places_user ON saved_places(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_saved_places_user_type ON saved_places(user_id, type);
