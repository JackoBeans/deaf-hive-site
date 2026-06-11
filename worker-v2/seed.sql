-- ════════════════════════════════════════════════════════════════════════
-- Phase 1 fixture data — fictional. DO NOT confuse with real content.
--
-- Apply with:
--   wrangler d1 execute deafhive --remote --file=worker-v2/seed.sql
--
-- Safe to re-run: deletes any existing row with the matching id first.
-- (We use fixed ids 9001+ for fixtures so a future migration of real
-- data — which will get ids 1, 2, 3, … — never collides.)
-- ════════════════════════════════════════════════════════════════════════

-- Wipe any prior fixture rows (idempotent)
DELETE FROM videos          WHERE id IN (9001, 9002, 9003);
DELETE FROM events          WHERE id IN (9001, 9002, 9003);
DELETE FROM organisations   WHERE id IN (9001, 9002, 9003);

-- ── Organisations ──────────────────────────────────────────────────────
INSERT INTO organisations
  (id,   name,                       status,     website,                          email_public,                about,                                                             address,                       logo_r2_key,                        category_types,                       age_categories,                                                  submitted_via, created_at,  updated_at)
VALUES
  (9001, 'Test Org Alpha',           'approved', 'https://alpha.example.org',      'hello@alpha.example.org',   'Fictional org used for Phase 1 testing. **Markdown** allowed.',   '1 Test Lane, Bristol, BS1 1AA','orgs/seed/alpha-logo.jpg',         '["Community","Education"]',          '["Children (0-12)","Young people (13-24)","Adults (25-59)"]',   'admin',       1717977600,  1717977600),
  (9002, 'Test Org Bravo',           'approved', 'https://bravo.example.org',       NULL,                       'Another fixture row. No logo, no email — exercises the null paths.', NULL,                       NULL,                                '["Sports"]',                         '["Adults (25-59)","Seniors (60+)"]',                            'admin',       1717977700,  1717977700),
  (9003, 'Test Org Charlie',         'approved', NULL,                              'contact@charlie.example.org','Third fixture — used by the org-linked event and video below.',   '99 Sample Road, Manchester',  'orgs/seed/charlie-logo.jpg',       '["Community","Faith"]',              '["All ages"]',                                                  'admin',       1717977800,  1717977800);

-- ── Events ─────────────────────────────────────────────────────────────
-- 9001: standalone (no org)
-- 9002: linked to Org Charlie
-- 9003: linked to Org Alpha, with a poster image
INSERT INTO events
  (id,   name,                                status,     organisation_id, event_date,             address,                        details,                                                          poster_r2_key,                     submitted_via, created_at,  updated_at)
VALUES
  (9001, 'Phase 1 Fixture — Standalone Event','approved', NULL,            '2026-07-15T19:00:00Z', 'Online (Zoom)',                'Standalone fixture event. Should render with no organisation name.', NULL,                              'admin',       1717977900,  1717977900),
  (9002, 'Phase 1 Fixture — Charlie Coffee',  'approved', 9003,            '2026-08-02T10:30:00Z', '99 Sample Road, Manchester',   'Linked to Test Org Charlie. Should show that org name on the card.', NULL,                              'admin',       1717978000,  1717978000),
  (9003, 'Phase 1 Fixture — Alpha Launch',    'approved', 9001,            '2026-09-10T18:00:00Z', '1 Test Lane, Bristol',         'Linked to Test Org Alpha + has a fake poster. Tests poster_url.',     'events/seed/alpha-launch.jpg',    'admin',       1717978100,  1717978100);

-- ── Videos ─────────────────────────────────────────────────────────────
-- 9001: YouTube only, standalone, pinned display_order=1
-- 9002: R2-hosted only, linked to Org Alpha, poster override
-- 9003: BOTH youtube_url and video_r2_key set, standalone, no display_order
INSERT INTO videos
  (id,   name,                              status,     organisation_id, youtube_url,                                       video_r2_key,                       poster_r2_key,                        description,                                                    display_order, submitted_via, created_at,  updated_at)
VALUES
  (9001, 'Phase 1 Fixture — Welcome (YT)',  'approved', NULL,            'https://www.youtube.com/watch?v=dQw4w9WgXcQ',     NULL,                               NULL,                                 'YouTube-only fixture. Should fall back to YouTube''s thumbnail.', 1,           'admin',       1717978200,  1717978200),
  (9002, 'Phase 1 Fixture — Alpha Intro',   'approved', 9001,            NULL,                                              'videos/seed/alpha-intro.mp4',       'videos/seed/alpha-intro-poster.jpg', 'R2-hosted fixture linked to Test Org Alpha, with a poster.',     NULL,        'admin',       1717978300,  1717978300),
  (9003, 'Phase 1 Fixture — Dual Source',   'approved', NULL,            'https://www.youtube.com/watch?v=jNQXAC9IVRw',     'videos/seed/dual.mp4',             NULL,                                 'Both sources set — YouTube preferred at render time per the plan.', NULL,    'admin',       1717978400,  1717978400);
