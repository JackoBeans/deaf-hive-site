#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════════
   migrate.js — one-shot Airtable → D1 + R2 migration.

   What it does:
     1. Pulls all Organisations + Events from the DeafHive Airtable base
     2. Downloads each attachment (logos, posters) to /tmp, uploads to R2
        via `wrangler r2 object put` (uses your existing wrangler auth —
        no separate Cloudflare API token needed)
     3. Resolves event → organisation foreign keys by matching the Lookup
        "Name (from Organisation)" against imported org names
     4. Seeds the 6 hard-coded YouTube videos from index.html into the
        videos table
     5. Generates a single .migration-data.sql file with DELETE-first
        idempotency, then applies it via `wrangler d1 execute --remote`

   Stable IDs:
     orgs   → 1..N
     events → 1..M
     videos → 1..6
     (fixture rows at 9001+ keep coexisting until Phase 6 wipes them)

   Usage:
     export AIRTABLE_TOKEN='patXXXXXXXXXXXXXXXX'   # your Airtable PAT
     node worker-v2/migrate.js                     # run for real
     node worker-v2/migrate.js --dry-run           # build SQL, don't apply

   Re-runnable: DELETE-first on the same id ranges means it can be
   re-run after a failure. Old R2 objects from a previous run will be
   orphaned in the bucket — clean them up with `wrangler r2 object list`
   or just leave them (R2 free tier is 10 GB).

   Requires:
     Node 18+ (native fetch, randomUUID)
     wrangler on PATH (logged in)
     AIRTABLE_TOKEN env var (or paste at prompt)
   ════════════════════════════════════════════════════════════════════════ */

import { mkdtempSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

// ── Configuration ──────────────────────────────────────────────────────

const AIRTABLE_BASE_ID = 'app0JwQ5lgCrRJ00M';
const ORG_TABLE_ID     = 'tblvtUmdlXXHGDj0l';
const EVENTS_TABLE_ID  = 'tblffh6BKb8ZO3QGg';

const R2_BUCKET   = 'deafhive-images';
const D1_DATABASE = 'deafhive';
const WORKER_CONFIG = 'worker-v2/wrangler.toml';

const SQL_OUT_PATH = 'worker-v2/.migration-data.sql';

// Field NAMES (not IDs) — Airtable returns these when we don't pass
// returnFieldsByFieldId. Using names keeps this script's intent
// readable; field IDs would scatter `fldXXX` opacity through the code.
// If Mark has renamed a field in Airtable, edit one constant here.
const ORG = {
  status:        'Status',
  name:          'Name',
  logo:          'Image(s)',
  website:       'Website',
  emailPublic:   'Contact (public)',
  about:         'Description',
  address:       'Organisation Address',
  categoryTypes: 'Category Type',
  ageCategories: 'Age Category',
};

const EVT = {
  status:           'Status',
  name:             'Event Name',
  date:             'Date',
  details:          'Event Details',
  address:          'Event Address',
  poster:           'Event Poster/Picture',
  organisationName: 'Name (from Organisation)',  // Airtable Lookup field
};

// Map Airtable Status → D1 status enum. Anything we don't recognise
// becomes 'draft' so admins can decide.
function mapStatus(airtableStatus) {
  switch ((airtableStatus || '').toLowerCase()) {
    case 'approved': return 'approved';
    case 'pending':  return 'pending';
    case 'rejected': return 'rejected';
    case 'draft':    return 'draft';
    default:         return 'draft';
  }
}

// The 6 hardcoded YouTube videos from index.html (David's story in the
// Role Models card is out of scope per the rebuild plan).
const SEED_VIDEOS = [
  { id: 1, youtube_id: '_raNeUTdE6Q', name: 'Welcome to DeafHive',            display_order: 1 },
  { id: 2, youtube_id: 'TAG5JM7zhTU', name: 'What is DeafHive?',               display_order: 2 },
  { id: 3, youtube_id: 'c29KSuD2iQc', name: 'Why we created DeafHive?',        display_order: 3 },
  { id: 4, youtube_id: 'IcThM_Jx8bY', name: 'What you will find on DeafHive?', display_order: 4 },
  { id: 5, youtube_id: 'G2zSuR0IxWA', name: 'See It. Believe It. Be It.',      display_order: 5 },
  { id: 6, youtube_id: 'rBCV5m3_C9U', name: 'Help Us Build DeafHive',          display_order: 6 },
];

const DRY_RUN = process.argv.includes('--dry-run');

// ── Helpers ────────────────────────────────────────────────────────────

function log(msg)  { console.log(msg); }
function warn(msg) { console.warn('  ⚠ ' + msg); }
function fail(msg) { console.error('  ✘ ' + msg); }

function sqlString(v) {
  if (v == null) return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}
function sqlJson(arr) {
  return sqlString(JSON.stringify(Array.isArray(arr) ? arr : []));
}
function sqlInt(v) {
  if (v == null) return 'NULL';
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? String(n) : 'NULL';
}
function isoNow() { return Math.floor(Date.now() / 1000); }

// Airtable can return values in shapes that aren't plain strings:
//   - Long text / single-line text → string
//   - AI-generated text field → { value: '...', state: '...', isStale: bool }
//   - Empty cell → key not present (handled by caller)
// This helper coerces all known shapes to a trimmed string-or-null so
// caller code doesn't have to special-case every field.
function stringOrNull(v) {
  if (v == null) return null;
  if (typeof v === 'string') {
    const t = v.trim();
    return t === '' ? null : t;
  }
  if (typeof v === 'object') {
    // AI text field shape
    if (typeof v.value === 'string') return stringOrNull(v.value);
    // Unknown object — log + skip (will surface in admin as null)
    return null;
  }
  return String(v);
}

function extFromMime(mime) {
  switch ((mime || '').toLowerCase()) {
    case 'image/jpeg': return 'jpg';
    case 'image/png':  return 'png';
    case 'image/webp': return 'webp';
    case 'image/gif':  return 'gif';
    case 'image/svg+xml': return 'svg';
    default:           return 'bin';
  }
}

async function fetchAirtableAll(token, tableId) {
  const records = [];
  let offset = null;
  do {
    const params = new URLSearchParams({ pageSize: '100' });
    if (offset) params.set('offset', offset);
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${tableId}?${params}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Airtable ${tableId} HTTP ${res.status}: ${body.slice(0, 240)}`);
    }
    const data = await res.json();
    records.push(...(data.records || []));
    offset = data.offset || null;
  } while (offset);
  return records;
}

function logUniqueFieldNames(label, records) {
  const all = new Set();
  for (const r of records) for (const k of Object.keys(r.fields || {})) all.add(k);
  log(`  Field names seen across ${records.length} ${label}: ${[...all].sort().join(', ')}`);
}

function pickFirstAttachment(fields, fieldName) {
  const v = fields[fieldName];
  if (!Array.isArray(v) || v.length === 0) return null;
  return v[0];
}

async function downloadToTemp(url, mime) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = extFromMime(mime);
  const path = join(tmpdir(), `dhmigrate-${randomUUID()}.${ext}`);
  writeFileSync(path, buf);
  return path;
}

function uploadToR2(localFile, r2Key, mime) {
  const args = [
    'r2', 'object', 'put', `${R2_BUCKET}/${r2Key}`,
    '--file', localFile,
    '--remote',
  ];
  if (mime) {
    args.push('--content-type', mime);
  }
  const result = spawnSync('wrangler', args, { stdio: 'pipe', encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`wrangler r2 put failed: ${(result.stderr || result.stdout || '').slice(0, 400)}`);
  }
}

function ymPrefix() {
  const d = new Date();
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function r2KeyFor(folder, mime) {
  return `${folder}/${ymPrefix()}/${randomUUID()}.${extFromMime(mime)}`;
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  // Pre-flight: Node version
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < 18) {
    fail(`Node 18+ required for native fetch / randomUUID. Got ${process.versions.node}.`);
    process.exit(1);
  }

  // Pre-flight: wrangler
  const wr = spawnSync('wrangler', ['--version'], { stdio: 'pipe', encoding: 'utf-8' });
  if (wr.status !== 0) {
    fail('wrangler CLI not found on PATH. Install: npm i -g wrangler');
    process.exit(1);
  }
  log(`✓ wrangler: ${(wr.stdout || '').trim().split('\n').pop()}`);

  // Pre-flight: AIRTABLE_TOKEN
  let token = process.env.AIRTABLE_TOKEN;
  if (!token) {
    const rl = readline.createInterface({ input, output });
    token = (await rl.question('Airtable Personal Access Token: ')).trim();
    rl.close();
    if (!token) {
      fail('AIRTABLE_TOKEN required.');
      process.exit(1);
    }
  }
  if (!token.startsWith('pat')) {
    warn(`AIRTABLE_TOKEN doesn't start with 'pat' — proceeding anyway.`);
  }

  log(DRY_RUN ? '\n=== DRY RUN — will build SQL but not apply ===\n' : '\n=== Live migration ===\n');

  // ── Phase 1: organisations ──────────────────────────────────────────
  log('▶ Fetching organisations from Airtable…');
  const orgRecords = await fetchAirtableAll(token, ORG_TABLE_ID);
  log(`  Got ${orgRecords.length} orgs.`);

  if (orgRecords.length === 0) {
    fail('No organisations found. Check the table ID and your PAT.');
    process.exit(1);
  }

  // Print the UNION of every field name across every org record. Airtable
  // omits empty fields per record, so first-record-only inspection misses
  // fields like address/logo that the first record happens not to fill.
  logUniqueFieldNames('orgs', orgRecords);

  const orgs = [];                  // {d1Id, atRecId, atName, fields..., logo_r2_key}
  const orgIdByAtRecId = new Map(); // for events FK resolution by record ID
  const orgIdByName    = new Map(); // fallback FK resolution by name

  let nextOrgId = 1;
  for (const rec of orgRecords) {
    const f = rec.fields;
    const name = stringOrNull(f[ORG.name]);
    if (!name) {
      warn(`Org record ${rec.id} has no Name — skipping.`);
      continue;
    }
    const d1Id = nextOrgId++;

    let logoKey = null;
    const att = pickFirstAttachment(f, ORG.logo);
    if (att && att.url) {
      try {
        const tmp = await downloadToTemp(att.url, att.type);
        const key = r2KeyFor('orgs', att.type);
        uploadToR2(tmp, key, att.type);
        unlinkSync(tmp);
        logoKey = key;
        log(`  ↑ org #${d1Id} ${name}: logo → ${key}`);
      } catch (err) {
        warn(`org #${d1Id} ${name}: logo upload failed (${err.message}) — leaving null`);
      }
    }

    const entry = {
      d1Id,
      atRecId: rec.id,
      name,
      status:        mapStatus(f[ORG.status]),
      website:       stringOrNull(f[ORG.website]),
      email_public:  stringOrNull(f[ORG.emailPublic]),
      about:         stringOrNull(f[ORG.about]),
      address:       stringOrNull(f[ORG.address]),
      category_types: Array.isArray(f[ORG.categoryTypes]) ? f[ORG.categoryTypes] : [],
      age_categories: Array.isArray(f[ORG.ageCategories]) ? f[ORG.ageCategories] : [],
      logo_r2_key:   logoKey,
    };
    orgs.push(entry);
    orgIdByAtRecId.set(rec.id, d1Id);
    orgIdByName.set(name, d1Id);
  }
  log(`✓ Prepared ${orgs.length} orgs for import.`);

  // ── Phase 2: events ─────────────────────────────────────────────────
  log('\n▶ Fetching events from Airtable…');
  const eventRecords = await fetchAirtableAll(token, EVENTS_TABLE_ID);
  log(`  Got ${eventRecords.length} events.`);
  logUniqueFieldNames('events', eventRecords);

  const events = [];
  let nextEventId = 1;
  let unmatchedOrgRefs = 0;
  for (const rec of eventRecords) {
    const f = rec.fields;
    const name = stringOrNull(f[EVT.name]);
    if (!name) {
      warn(`Event record ${rec.id} has no Name — skipping.`);
      continue;
    }
    const date = stringOrNull(f[EVT.date]);
    if (!date) {
      warn(`Event "${name}" has no Date — skipping.`);
      continue;
    }
    const d1Id = nextEventId++;

    // Resolve linked organisation. Airtable's Lookup returns an array of
    // names (one per linked record). We use the first.
    let organisationId = null;
    const lookupNames = f[EVT.organisationName];
    if (Array.isArray(lookupNames) && lookupNames.length > 0) {
      const lookupName = String(lookupNames[0]).trim();
      const matchId = orgIdByName.get(lookupName);
      if (matchId) {
        organisationId = matchId;
      } else {
        unmatchedOrgRefs++;
        warn(`event #${d1Id} ${name}: linked org "${lookupName}" not found among imported orgs`);
      }
    }

    let posterKey = null;
    const att = pickFirstAttachment(f, EVT.poster);
    if (att && att.url) {
      try {
        const tmp = await downloadToTemp(att.url, att.type);
        const key = r2KeyFor('events', att.type);
        uploadToR2(tmp, key, att.type);
        unlinkSync(tmp);
        posterKey = key;
        log(`  ↑ event #${d1Id} ${name}: poster → ${key}`);
      } catch (err) {
        warn(`event #${d1Id} ${name}: poster upload failed (${err.message}) — leaving null`);
      }
    }

    events.push({
      d1Id,
      name,
      status:          mapStatus(f[EVT.status]),
      organisation_id: organisationId,
      event_date:      date,
      address:         stringOrNull(f[EVT.address]),
      details:         stringOrNull(f[EVT.details]),
      poster_r2_key:   posterKey,
    });
  }
  log(`✓ Prepared ${events.length} events (${unmatchedOrgRefs} with unmatched org refs).`);

  // ── Phase 3: build SQL ──────────────────────────────────────────────
  const t = isoNow();
  const lines = [
    '-- ════════════════════════════════════════════════════════════════',
    `-- Generated by worker-v2/migrate.js at ${new Date().toISOString()}`,
    `-- Orgs: ${orgs.length}  Events: ${events.length}  Videos: ${SEED_VIDEOS.length}`,
    '-- ════════════════════════════════════════════════════════════════',
    '',
    '-- Idempotent: clear the id ranges this script controls first.',
    `DELETE FROM events WHERE id BETWEEN 1 AND 999;`,
    `DELETE FROM organisations WHERE id BETWEEN 1 AND 999;`,
    `DELETE FROM videos WHERE id BETWEEN 1 AND 999;`,
    '',
    '-- ── Organisations ────────────────────────────────────────────────',
  ];

  for (const o of orgs) {
    lines.push(
      `INSERT INTO organisations (id, name, status, website, email_public, email_admin, about, address, logo_r2_key, category_types, age_categories, submitted_via, created_at, updated_at) VALUES (` +
      [
        o.d1Id,
        sqlString(o.name),
        sqlString(o.status),
        sqlString(o.website),
        sqlString(o.email_public),
        'NULL',
        sqlString(o.about),
        sqlString(o.address),
        sqlString(o.logo_r2_key),
        sqlJson(o.category_types),
        sqlJson(o.age_categories),
        `'admin'`,
        t, t,
      ].join(', ') + ');',
    );
  }

  lines.push('', '-- ── Events ───────────────────────────────────────────────────────');
  for (const e of events) {
    lines.push(
      `INSERT INTO events (id, name, status, organisation_id, event_date, address, details, poster_r2_key, submitted_via, created_at, updated_at) VALUES (` +
      [
        e.d1Id,
        sqlString(e.name),
        sqlString(e.status),
        sqlInt(e.organisation_id),
        sqlString(e.event_date),
        sqlString(e.address),
        sqlString(e.details),
        sqlString(e.poster_r2_key),
        `'admin'`,
        t, t,
      ].join(', ') + ');',
    );
  }

  lines.push('', '-- ── Videos (seeded from index.html) ──────────────────────────────');
  for (const v of SEED_VIDEOS) {
    lines.push(
      `INSERT INTO videos (id, name, status, youtube_url, description, display_order, submitted_via, created_at, updated_at) VALUES (` +
      [
        v.id,
        sqlString(v.name),
        `'approved'`,
        sqlString(`https://www.youtube.com/watch?v=${v.youtube_id}`),
        sqlString('Migrated from the static homepage.'),
        v.display_order,
        `'admin'`,
        t, t,
      ].join(', ') + ');',
    );
  }
  lines.push('');

  writeFileSync(SQL_OUT_PATH, lines.join('\n'), 'utf-8');
  log(`\n✓ Wrote SQL to ${SQL_OUT_PATH} (${lines.length} lines)`);

  if (DRY_RUN) {
    log('\n=== Dry run complete. Review the SQL, then re-run without --dry-run to apply. ===');
    return;
  }

  // ── Phase 4: apply ──────────────────────────────────────────────────
  log('\n▶ Applying SQL via wrangler d1 execute…');
  const exec = spawnSync(
    'wrangler',
    ['d1', 'execute', D1_DATABASE, '--remote', `--file=${SQL_OUT_PATH}`, `--config=${WORKER_CONFIG}`],
    { stdio: 'inherit' },
  );
  if (exec.status !== 0) {
    fail(`wrangler d1 execute returned non-zero exit code ${exec.status}`);
    process.exit(1);
  }

  log('\n=== Migration complete ===');
  log(`  Organisations:  ${orgs.length}    (ids 1..${orgs.length})`);
  log(`  Events:         ${events.length}  (ids 1..${events.length}, ${unmatchedOrgRefs} unmatched org refs)`);
  log(`  Videos:         ${SEED_VIDEOS.length} (ids 1..${SEED_VIDEOS.length})`);
  log(`  Fixture rows at 9001+ are still in place — wipe in Phase 6 cutover.`);
  log(`\n  Verify in admin: https://deafhive.online/admin/`);
}

main().catch(err => {
  fail(`FATAL: ${err.message}`);
  process.exit(1);
});
