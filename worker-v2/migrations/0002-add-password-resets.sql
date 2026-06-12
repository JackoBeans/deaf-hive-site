-- ════════════════════════════════════════════════════════════════════════
-- Migration 0002 — password_resets table.
--
-- Apply with:
--   wrangler d1 execute deafhive --remote \
--     --file=worker-v2/migrations/0002-add-password-resets.sql
--
-- Stores the SHA-256 hash of each issued reset token (never the raw
-- value). On reset, the worker hashes the token from the URL and looks
-- it up by hash. Single-use: used_at is set on consumption.
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS password_resets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- SHA-256 hex of the raw token. Indexed UNIQUE so token lookup is O(1).
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  -- NULL until consumed; once set, the token cannot be re-used.
  used_at     INTEGER,
  -- Where the token came from. forgot_password = self-service from
  -- login. owner_created = owner generated it from the Users tab to
  -- share out-of-band with the user.
  source      TEXT NOT NULL DEFAULT 'forgot_password'
               CHECK (source IN ('forgot_password', 'owner_created'))
);

CREATE INDEX IF NOT EXISTS idx_resets_user    ON password_resets(user_id);
CREATE INDEX IF NOT EXISTS idx_resets_expires ON password_resets(expires_at);
