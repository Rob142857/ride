-- 2026-10-17: Personal access tokens, fuel fill-ups and location check-ins.
-- Additive only: new tables and indexes. No existing table or row changes.
-- Idempotent (IF NOT EXISTS), so it is safe to run twice.
--
-- api_tokens: owner-created tokens for scripted access (for example a trip agent).
--   Only a SHA-256 hash of the token is stored. The token itself is shown once.
-- api_token_audit: one row per write made with a token, plus token create/revoke.
-- api_token_rate: fixed one-minute request counters per token.
-- fuel_fills: actual fuel fill-ups for a trip (the live source of truth for fuel).
-- checkins: single "I'm here" location points for a trip.
-- Timestamps are ISO-8601 UTC strings.

CREATE TABLE IF NOT EXISTS api_tokens (
  id            TEXT PRIMARY KEY CHECK(length(id) > 0),
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL CHECK(length(name) > 0 AND length(name) <= 80),
  token_hash    TEXT NOT NULL UNIQUE CHECK(length(token_hash) = 64),
  token_hint    TEXT NOT NULL,
  scopes        TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at  TEXT,
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS api_token_audit (
  id          TEXT PRIMARY KEY CHECK(length(id) > 0),
  token_id    TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method      TEXT NOT NULL,
  route       TEXT NOT NULL,
  status      INTEGER,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_api_token_audit_token ON api_token_audit(token_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_token_audit_user ON api_token_audit(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS api_token_rate (
  token_id      TEXT NOT NULL,
  window_start  INTEGER NOT NULL,
  count         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (token_id, window_start)
);

CREATE TABLE IF NOT EXISTS fuel_fills (
  id               TEXT PRIMARY KEY CHECK(length(id) > 0),
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trip_id          TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  filled_at        TEXT NOT NULL,
  lat              REAL CHECK(lat IS NULL OR (lat >= -90 AND lat <= 90)),
  lng              REAL CHECK(lng IS NULL OR (lng >= -180 AND lng <= 180)),
  accuracy_m       REAL CHECK(accuracy_m IS NULL OR accuracy_m >= 0),
  station_name     TEXT,
  litres           REAL CHECK(litres IS NULL OR litres > 0),
  price_per_litre  REAL CHECK(price_per_litre IS NULL OR price_per_litre > 0),
  total_cost       REAL CHECK(total_cost IS NULL OR total_cost >= 0),
  full_tank        INTEGER NOT NULL DEFAULT 0 CHECK(full_tank IN (0, 1)),
  jerry_filled     INTEGER NOT NULL DEFAULT 0 CHECK(jerry_filled IN (0, 1)),
  jerry_litres     REAL CHECK(jerry_litres IS NULL OR jerry_litres >= 0),
  odometer_km      REAL CHECK(odometer_km IS NULL OR odometer_km >= 0),
  payment_method   TEXT CHECK(payment_method IS NULL OR payment_method IN ('card', 'afterpay', 'cash', 'other')),
  notes            TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_fuel_fills_trip ON fuel_fills(trip_id, filled_at DESC);
CREATE INDEX IF NOT EXISTS idx_fuel_fills_user ON fuel_fills(user_id, filled_at DESC);

CREATE TABLE IF NOT EXISTS checkins (
  id           TEXT PRIMARY KEY CHECK(length(id) > 0),
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trip_id      TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  lat          REAL NOT NULL CHECK(lat >= -90 AND lat <= 90),
  lng          REAL NOT NULL CHECK(lng >= -180 AND lng <= 180),
  accuracy_m   REAL CHECK(accuracy_m IS NULL OR accuracy_m >= 0),
  recorded_at  TEXT NOT NULL,
  note         TEXT,
  source       TEXT NOT NULL DEFAULT 'api' CHECK(source IN ('ride', 'companion', 'agent', 'api')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_checkins_trip ON checkins(trip_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_checkins_user ON checkins(user_id, recorded_at DESC);
