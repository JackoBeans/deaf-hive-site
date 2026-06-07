-- ════════════════════════════════════════════════════════════════════════
-- DeafHive D1 schema — Phase 0 baseline
--
-- Apply with:
--   wrangler d1 execute deafhive --remote --file=worker-v2/schema.sql
--
-- For local dev (against a local SQLite snapshot):
--   wrangler d1 execute deafhive --local  --file=worker-v2/schema.sql
--
-- Future schema changes go in worker-v2/migrations/NNNN-description.sql
-- and are applied with the same `wrangler d1 execute` command.
-- ════════════════════════════════════════════════════════════════════════

-- ── Organisations ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS organisations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'approved', 'rejected', 'draft')),
  website         TEXT,
  email_public    TEXT,
  email_admin     TEXT,
  about           TEXT,         -- long text (was "Organisation / Service - Description")
  address         TEXT,
  logo_r2_key     TEXT,         -- e.g. 'orgs/2026/05/abc123.jpg'
  category_types  TEXT NOT NULL DEFAULT '[]',  -- JSON array of strings
  age_categories  TEXT NOT NULL DEFAULT '[]',  -- JSON array of strings
  submitted_via   TEXT NOT NULL DEFAULT 'admin'
                   CHECK (submitted_via IN ('admin', 'public')),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orgs_status ON organisations(status);
CREATE INDEX IF NOT EXISTS idx_orgs_name   ON organisations(name);

-- ── Events ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'approved', 'rejected', 'draft')),
  organisation_id INTEGER REFERENCES organisations(id) ON DELETE SET NULL,
  event_date      TEXT NOT NULL,    -- ISO 8601 datetime
  address         TEXT,
  details         TEXT,
  poster_r2_key   TEXT,
  submitted_via   TEXT NOT NULL DEFAULT 'admin'
                   CHECK (submitted_via IN ('admin', 'public')),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
CREATE INDEX IF NOT EXISTS idx_events_date   ON events(event_date);
CREATE INDEX IF NOT EXISTS idx_events_org    ON events(organisation_id);

-- ── Videos ─────────────────────────────────────────────────────────────
-- A video has EITHER a youtube_url OR a video_r2_key (or both — youtube
-- preferred for embed if both are set). poster_r2_key is an optional
-- thumbnail override; absent rows fall back to YouTube's thumbnail (for
-- youtube_url rows) or a placeholder (for R2-only rows).
-- organisation_id is nullable: standalone videos appear in the "Videos"
-- section; videos with an org also appear in that org's modal.
CREATE TABLE IF NOT EXISTS videos (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'approved', 'rejected', 'draft')),
  organisation_id   INTEGER REFERENCES organisations(id) ON DELETE SET NULL,
  youtube_url       TEXT,
  video_r2_key      TEXT,      -- e.g. 'videos/2026/05/intro.mp4'
  poster_r2_key     TEXT,      -- optional poster/thumbnail override
  description       TEXT,
  display_order     INTEGER,   -- admin pin order; NULL => sort by created_at DESC
  submitted_via     TEXT NOT NULL DEFAULT 'admin'
                     CHECK (submitted_via IN ('admin', 'public')),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  -- A video MUST have at least one playable source
  CHECK (youtube_url IS NOT NULL OR video_r2_key IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(status);
CREATE INDEX IF NOT EXISTS idx_videos_org    ON videos(organisation_id);
CREATE INDEX IF NOT EXISTS idx_videos_order  ON videos(display_order, created_at DESC);

-- ── Submission rate limiting ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS submission_quota (
  ip_hash      TEXT PRIMARY KEY,    -- SHA-256 of client IP (no PII stored)
  count        INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL     -- unix epoch seconds
);

-- ── Audit log ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         INTEGER NOT NULL,           -- unix epoch
  actor      TEXT NOT NULL,              -- 'admin' or 'public' or specific user
  action     TEXT NOT NULL,              -- 'create', 'update', 'delete', 'approve', 'reject'
  entity     TEXT NOT NULL,              -- 'organisation' | 'event' | 'video' | 'image'
  entity_id  INTEGER,
  diff_json  TEXT                        -- optional JSON of changed fields
);

CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);
