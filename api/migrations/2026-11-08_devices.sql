-- 2026-11-08: Bike trackers (devices), their GPS fixes, alerts and speedo calibrations.
-- Additive only: four new tables and their indexes. No existing table or row changes.
-- Idempotent (IF NOT EXISTS), so it is safe to run twice.
--
-- devices: one row per tracker. Only a SHA-256 hash of the device secret
--   ("ride_dev_...") is stored; the secret itself is shown once.
-- device_fixes: GPS fixes posted by a device. t is unix seconds (UTC).
--   The unique (device_id, t) index lets a board resend a batch safely.
-- device_alerts: moved / left zone / silent / low battery (step 2 fills these).
-- speedo_calibrations: speedo reading against GPS speed, per bike (step 3).
-- ISO-8601 UTC strings for created/seen/revoked times.

CREATE TABLE IF NOT EXISTS devices (
  id             TEXT PRIMARY KEY CHECK(length(id) > 0),
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           TEXT NOT NULL CHECK(length(name) > 0 AND length(name) <= 80),
  bike_name      TEXT CHECK(bike_name IS NULL OR length(bike_name) <= 80),
  secret_hash    TEXT NOT NULL UNIQUE CHECK(length(secret_hash) = 64),
  secret_prefix  TEXT NOT NULL,
  armed          INTEGER NOT NULL DEFAULT 0 CHECK(armed IN (0, 1)),
  trip_id        TEXT REFERENCES trips(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at   TEXT,
  last_battery   REAL CHECK(last_battery IS NULL OR (last_battery >= 0 AND last_battery <= 100)),
  revoked_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_devices_trip ON devices(trip_id);

CREATE TABLE IF NOT EXISTS device_fixes (
  id           INTEGER PRIMARY KEY,
  device_id    TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  t            INTEGER NOT NULL,
  lat          REAL NOT NULL CHECK(lat >= -90 AND lat <= 90),
  lng          REAL NOT NULL CHECK(lng >= -180 AND lng <= 180),
  speed_kmh    REAL CHECK(speed_kmh IS NULL OR speed_kmh >= 0),
  heading      REAL CHECK(heading IS NULL OR (heading >= 0 AND heading < 360)),
  accuracy_m   REAL CHECK(accuracy_m IS NULL OR accuracy_m >= 0),
  sats         INTEGER CHECK(sats IS NULL OR sats >= 0),
  battery      REAL CHECK(battery IS NULL OR (battery >= 0 AND battery <= 100)),
  motion       INTEGER CHECK(motion IS NULL OR motion IN (0, 1)),
  received_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_device_fixes_device_t ON device_fixes(device_id, t);

CREATE TABLE IF NOT EXISTS device_alerts (
  id         TEXT PRIMARY KEY CHECK(length(id) > 0),
  device_id  TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK(kind IN ('moved', 'left_zone', 'silent', 'low_battery')),
  at         TEXT NOT NULL,
  detail     TEXT,
  sent_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_device_alerts_device ON device_alerts(device_id, at DESC);

CREATE TABLE IF NOT EXISTS speedo_calibrations (
  id          TEXT PRIMARY KEY CHECK(length(id) > 0),
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id   TEXT REFERENCES devices(id) ON DELETE SET NULL,
  bike_name   TEXT,
  speedo_kmh  REAL NOT NULL CHECK(speedo_kmh > 0),
  gps_kmh     REAL NOT NULL CHECK(gps_kmh >= 0),
  samples     INTEGER NOT NULL DEFAULT 0 CHECK(samples >= 0),
  at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_speedo_calibrations_user ON speedo_calibrations(user_id, at DESC);
