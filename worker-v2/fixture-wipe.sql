-- ════════════════════════════════════════════════════════════════════════
-- Phase 6 prep — wipe Phase 1 fixture rows.
--
-- Apply with:
--   wrangler d1 execute deafhive --remote --file=worker-v2/fixture-wipe.sql
--
-- Real Airtable-migrated data lives at ids 1..N (see migrate.js).
-- Fixtures were intentionally placed at 9001+ so they can be removed in
-- one shot without touching anything important. The id ranges below are
-- the same ones the seed.sql file used.
-- ════════════════════════════════════════════════════════════════════════

DELETE FROM events        WHERE id BETWEEN 9001 AND 9999;
DELETE FROM organisations WHERE id BETWEEN 9001 AND 9999;
DELETE FROM videos        WHERE id BETWEEN 9001 AND 9999;
