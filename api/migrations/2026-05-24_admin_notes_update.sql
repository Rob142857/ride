-- Admin note editing support and scalable admin filters

ALTER TABLE admin_notes ADD COLUMN updated_at TEXT;

CREATE INDEX IF NOT EXISTS idx_users_status_created ON users(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_login_events_email_created ON login_events(email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_share_views_ip_created ON share_views(ip, created_at DESC);
