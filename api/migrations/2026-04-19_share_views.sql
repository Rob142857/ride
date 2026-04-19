-- Share link view audit trail
CREATE TABLE IF NOT EXISTS share_views (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL,
  short_code TEXT NOT NULL,
  viewer_user_id TEXT,          -- NULL for external/anonymous visitors
  viewer_label TEXT NOT NULL,   -- 'external' or user email
  ip TEXT,
  user_agent TEXT,
  client_hints TEXT,            -- JSON: country, platform, language, cf-ray
  referrer TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_share_views_created ON share_views(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_share_views_trip ON share_views(trip_id);
CREATE INDEX IF NOT EXISTS idx_share_views_short_code ON share_views(short_code);
