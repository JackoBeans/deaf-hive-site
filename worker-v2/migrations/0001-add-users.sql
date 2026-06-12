-- ════════════════════════════════════════════════════════════════════════
-- Migration 0001 — add `users` table for multi-user admin login.
--
-- Apply with:
--   wrangler d1 execute deafhive --remote \
--     --file=worker-v2/migrations/0001-add-users.sql
--
-- After this, run worker-v2/bootstrap-users.js to seed the two owner
-- users with hashed passwords.
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  -- password_hash format: '<iterations>.<base64url salt>.<base64url hash>'
  -- pbkdf2-sha256, 100k iter, 16-byte salt, 32-byte hash. See auth.js.
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'admin'
                 CHECK (role IN ('owner', 'admin')),
  status        TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'disabled')),
  display_name  TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
