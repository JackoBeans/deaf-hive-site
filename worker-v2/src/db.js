// ════════════════════════════════════════════════════════════════════════
// D1 queries + row → fields shaping.
//
// Each fetch function returns an array of {id, fields: {...}} objects in
// the SAME shape app.js will consume after cutover. Keys are stable
// strings (name, logo_url, …), not Airtable fld... IDs.
//
// Image / video URLs are derived here from R2 keys + env.MEDIA_BASE_URL,
// so the client never sees raw bucket paths and we can move the bucket
// without touching the front-end.
// ════════════════════════════════════════════════════════════════════════

// ── Generic helpers (used by both reads and writes) ────────────────────

const NOW = () => Math.floor(Date.now() / 1000);

// Whitelist-driven UPDATE builder: only supplied + allowed keys hit SQL.
// Returns null if nothing valid to update.
function buildUpdate(table, id, fields, allowedKeys) {
  const sets = [];
  const binds = [];
  for (const key of allowedKeys) {
    if (!(key in fields)) continue;
    sets.push(`${key} = ?`);
    binds.push(fields[key]);
  }
  if (sets.length === 0) return null;
  sets.push('updated_at = ?');
  binds.push(NOW());
  binds.push(id);
  return {
    sql: `UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`,
    binds,
  };
}

export function mediaUrl(env, key) {
  if (!key) return null;
  const base = (env.MEDIA_BASE_URL || '').replace(/\/+$/, '');
  return `${base}/${key}`;
}

function parseJsonArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ── Organisations ──────────────────────────────────────────────────────

export async function fetchApprovedOrganisations(env) {
  const { results } = await env.DB
    .prepare(
      `SELECT id, name, website, email_public, about, address,
              logo_r2_key, category_types, age_categories
         FROM organisations
        WHERE status = 'approved'
        ORDER BY name COLLATE NOCASE ASC`,
    )
    .all();

  return (results || []).map(row => ({
    id: row.id,
    fields: {
      name:           row.name,
      logo_url:       mediaUrl(env, row.logo_r2_key),
      about:          row.about ?? null,
      website:        row.website ?? null,
      email_public:   row.email_public ?? null,
      address:        row.address ?? null,
      category_types: parseJsonArray(row.category_types),
      age_categories: parseJsonArray(row.age_categories),
    },
  }));
}

// ── Events ─────────────────────────────────────────────────────────────
// LEFT JOIN organisations so events with a deleted/null org still show.

export async function fetchApprovedEvents(env) {
  const { results } = await env.DB
    .prepare(
      `SELECT e.id, e.name, e.event_date, e.address, e.details,
              e.poster_r2_key, e.organisation_id,
              o.name AS organisation_name
         FROM events e
         LEFT JOIN organisations o ON o.id = e.organisation_id
        WHERE e.status = 'approved'
        ORDER BY e.event_date ASC`,
    )
    .all();

  return (results || []).map(row => ({
    id: row.id,
    fields: {
      name:              row.name,
      event_date:        row.event_date,
      organisation_id:   row.organisation_id ?? null,
      organisation_name: row.organisation_name ?? null,
      details:           row.details ?? null,
      address:           row.address ?? null,
      poster_url:        mediaUrl(env, row.poster_r2_key),
    },
  }));
}

// ── Videos ─────────────────────────────────────────────────────────────
// Sort: display_order ASC first (NULLs last via the COALESCE trick), then
// most-recently-created. So admins can pin priority videos, fresh
// uploads still surface, and unsorted rows fall back to a stable order.

// ── Admin reads — returns ALL columns + status, scoped by status filter ──
//
// Public read endpoints hide status, submitted_via, timestamps; admin
// endpoints want them. The status param accepts a specific value or
// 'all' (default) — anything else is rejected by validateStatusFilter()
// in admin.js before reaching here, so we can interpolate safely.

export const STATUS_VALUES = ['pending', 'approved', 'rejected', 'draft'];

export function isValidStatusFilter(status) {
  return status === 'all' || STATUS_VALUES.includes(status);
}

function statusClause(status) {
  return status === 'all' ? '' : 'WHERE status = ?';
}

function statusBindings(status) {
  return status === 'all' ? [] : [status];
}

export async function fetchAdminOrganisations(env, status = 'all') {
  const sql = `SELECT id, name, status, website, email_public, email_admin,
                      about, address, logo_r2_key, category_types,
                      age_categories, submitted_via, created_at, updated_at
                 FROM organisations
                ${statusClause(status)}
                ORDER BY updated_at DESC`;
  const { results } = await env.DB.prepare(sql).bind(...statusBindings(status)).all();
  return (results || []).map(row => ({
    id: row.id,
    fields: {
      name:           row.name,
      status:         row.status,
      logo_url:       mediaUrl(env, row.logo_r2_key),
      logo_r2_key:    row.logo_r2_key ?? null,
      about:          row.about ?? null,
      website:        row.website ?? null,
      email_public:   row.email_public ?? null,
      email_admin:    row.email_admin ?? null,
      address:        row.address ?? null,
      category_types: parseJsonArray(row.category_types),
      age_categories: parseJsonArray(row.age_categories),
      submitted_via:  row.submitted_via,
      created_at:     row.created_at,
      updated_at:     row.updated_at,
    },
  }));
}

export async function fetchAdminEvents(env, status = 'all') {
  const sql = `SELECT e.id, e.name, e.status, e.event_date, e.address,
                      e.details, e.poster_r2_key, e.organisation_id,
                      e.submitted_via, e.created_at, e.updated_at,
                      o.name AS organisation_name
                 FROM events e
                 LEFT JOIN organisations o ON o.id = e.organisation_id
                ${statusClause(status).replace('WHERE status', 'WHERE e.status')}
                ORDER BY e.updated_at DESC`;
  const { results } = await env.DB.prepare(sql).bind(...statusBindings(status)).all();
  return (results || []).map(row => ({
    id: row.id,
    fields: {
      name:              row.name,
      status:            row.status,
      event_date:        row.event_date,
      organisation_id:   row.organisation_id ?? null,
      organisation_name: row.organisation_name ?? null,
      details:           row.details ?? null,
      address:           row.address ?? null,
      poster_url:        mediaUrl(env, row.poster_r2_key),
      poster_r2_key:     row.poster_r2_key ?? null,
      submitted_via:     row.submitted_via,
      created_at:        row.created_at,
      updated_at:        row.updated_at,
    },
  }));
}

export async function fetchAdminVideos(env, status = 'all') {
  const sql = `SELECT v.id, v.name, v.status, v.description, v.youtube_url,
                      v.video_r2_key, v.poster_r2_key, v.display_order,
                      v.organisation_id, v.submitted_via,
                      v.created_at, v.updated_at,
                      o.name AS organisation_name
                 FROM videos v
                 LEFT JOIN organisations o ON o.id = v.organisation_id
                ${statusClause(status).replace('WHERE status', 'WHERE v.status')}
                ORDER BY v.updated_at DESC`;
  const { results } = await env.DB.prepare(sql).bind(...statusBindings(status)).all();
  return (results || []).map(row => ({
    id: row.id,
    fields: {
      name:              row.name,
      status:            row.status,
      description:       row.description ?? null,
      youtube_url:       row.youtube_url ?? null,
      video_url:         mediaUrl(env, row.video_r2_key),
      video_r2_key:      row.video_r2_key ?? null,
      poster_url:        mediaUrl(env, row.poster_r2_key),
      poster_r2_key:     row.poster_r2_key ?? null,
      organisation_id:   row.organisation_id ?? null,
      organisation_name: row.organisation_name ?? null,
      display_order:     row.display_order ?? null,
      submitted_via:     row.submitted_via,
      created_at:        row.created_at,
      updated_at:        row.updated_at,
    },
  }));
}

export async function fetchApprovedVideos(env) {
  const { results } = await env.DB
    .prepare(
      `SELECT v.id, v.name, v.description, v.youtube_url,
              v.video_r2_key, v.poster_r2_key, v.display_order,
              v.organisation_id,
              o.name AS organisation_name
         FROM videos v
         LEFT JOIN organisations o ON o.id = v.organisation_id
        WHERE v.status = 'approved'
        ORDER BY COALESCE(v.display_order, 2147483647) ASC,
                 v.created_at DESC`,
    )
    .all();

  return (results || []).map(row => ({
    id: row.id,
    fields: {
      name:              row.name,
      description:       row.description ?? null,
      youtube_url:       row.youtube_url ?? null,
      video_url:         mediaUrl(env, row.video_r2_key),
      poster_url:        mediaUrl(env, row.poster_r2_key),
      organisation_id:   row.organisation_id ?? null,
      organisation_name: row.organisation_name ?? null,
      display_order:     row.display_order ?? null,
    },
  }));
}

// ════════════════════════════════════════════════════════════════════════
// MUTATIONS — create / update / delete for each table.
//
// Field whitelists below define which columns a write touches. Anything
// outside the list is silently ignored — protects against caller drift
// and SQL injection (columns are NEVER built from caller-controlled keys).
//
// JSON-as-text columns (category_types, age_categories) are stringified
// here on input and parsed in the read helpers above.
// ════════════════════════════════════════════════════════════════════════

const ORG_WRITE_KEYS = [
  'name', 'status', 'website', 'email_public', 'email_admin', 'about',
  'address', 'logo_r2_key', 'category_types', 'age_categories', 'submitted_via',
];

const EVENT_WRITE_KEYS = [
  'name', 'status', 'organisation_id', 'event_date', 'address',
  'details', 'poster_r2_key', 'submitted_via',
];

const VIDEO_WRITE_KEYS = [
  'name', 'status', 'organisation_id', 'youtube_url', 'video_r2_key',
  'poster_r2_key', 'description', 'display_order', 'submitted_via',
];

// Some incoming fields are objects (JSON arrays) — stringify in place
// so the rest of the write code can treat everything as a scalar bind.
function normaliseJsonFields(fields, jsonKeys) {
  const out = { ...fields };
  for (const key of jsonKeys) {
    if (key in out && Array.isArray(out[key])) {
      out[key] = JSON.stringify(out[key]);
    }
  }
  return out;
}

// ── Organisations ──────────────────────────────────────────────────────

export async function createOrganisation(env, fields) {
  const f = normaliseJsonFields(fields, ['category_types', 'age_categories']);
  const now = NOW();
  const { meta } = await env.DB
    .prepare(
      `INSERT INTO organisations
         (name, status, website, email_public, email_admin, about, address,
          logo_r2_key, category_types, age_categories, submitted_via,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      f.name,
      f.status || 'draft',
      f.website ?? null,
      f.email_public ?? null,
      f.email_admin ?? null,
      f.about ?? null,
      f.address ?? null,
      f.logo_r2_key ?? null,
      f.category_types ?? '[]',
      f.age_categories ?? '[]',
      f.submitted_via || 'admin',
      now, now,
    )
    .run();
  return meta.last_row_id;
}

export async function updateOrganisation(env, id, fields) {
  const f = normaliseJsonFields(fields, ['category_types', 'age_categories']);
  const upd = buildUpdate('organisations', id, f, ORG_WRITE_KEYS);
  if (!upd) return false;
  const { meta } = await env.DB.prepare(upd.sql).bind(...upd.binds).run();
  return meta.changes > 0;
}

export async function deleteOrganisation(env, id) {
  const { meta } = await env.DB
    .prepare('DELETE FROM organisations WHERE id = ?')
    .bind(id).run();
  return meta.changes > 0;
}

// ── Events ─────────────────────────────────────────────────────────────

export async function createEvent(env, fields) {
  const now = NOW();
  const { meta } = await env.DB
    .prepare(
      `INSERT INTO events
         (name, status, organisation_id, event_date, address, details,
          poster_r2_key, submitted_via, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      fields.name,
      fields.status || 'draft',
      fields.organisation_id ?? null,
      fields.event_date,
      fields.address ?? null,
      fields.details ?? null,
      fields.poster_r2_key ?? null,
      fields.submitted_via || 'admin',
      now, now,
    )
    .run();
  return meta.last_row_id;
}

export async function updateEvent(env, id, fields) {
  const upd = buildUpdate('events', id, fields, EVENT_WRITE_KEYS);
  if (!upd) return false;
  const { meta } = await env.DB.prepare(upd.sql).bind(...upd.binds).run();
  return meta.changes > 0;
}

export async function deleteEvent(env, id) {
  const { meta } = await env.DB
    .prepare('DELETE FROM events WHERE id = ?')
    .bind(id).run();
  return meta.changes > 0;
}

// ── Videos ─────────────────────────────────────────────────────────────

export async function createVideo(env, fields) {
  // CHECK constraint in the schema rejects rows with neither source, but
  // we surface a friendlier error here too.
  if (!fields.youtube_url && !fields.video_r2_key) {
    throw new Error('video requires youtube_url or video_r2_key');
  }
  const now = NOW();
  const { meta } = await env.DB
    .prepare(
      `INSERT INTO videos
         (name, status, organisation_id, youtube_url, video_r2_key,
          poster_r2_key, description, display_order, submitted_via,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      fields.name,
      fields.status || 'draft',
      fields.organisation_id ?? null,
      fields.youtube_url ?? null,
      fields.video_r2_key ?? null,
      fields.poster_r2_key ?? null,
      fields.description ?? null,
      fields.display_order ?? null,
      fields.submitted_via || 'admin',
      now, now,
    )
    .run();
  return meta.last_row_id;
}

export async function updateVideo(env, id, fields) {
  const upd = buildUpdate('videos', id, fields, VIDEO_WRITE_KEYS);
  if (!upd) return false;
  const { meta } = await env.DB.prepare(upd.sql).bind(...upd.binds).run();
  return meta.changes > 0;
}

export async function deleteVideo(env, id) {
  const { meta } = await env.DB
    .prepare('DELETE FROM videos WHERE id = ?')
    .bind(id).run();
  return meta.changes > 0;
}

// ── Fetch one row by id (admin detail / post-update repaint) ───────────

export async function fetchOrganisationById(env, id) {
  const row = await env.DB
    .prepare(
      `SELECT id, name, status, website, email_public, email_admin, about,
              address, logo_r2_key, category_types, age_categories,
              submitted_via, created_at, updated_at
         FROM organisations WHERE id = ?`,
    ).bind(id).first();
  if (!row) return null;
  return {
    id: row.id,
    fields: {
      name:           row.name,
      status:         row.status,
      logo_url:       mediaUrl(env, row.logo_r2_key),
      logo_r2_key:    row.logo_r2_key ?? null,
      about:          row.about ?? null,
      website:        row.website ?? null,
      email_public:   row.email_public ?? null,
      email_admin:    row.email_admin ?? null,
      address:        row.address ?? null,
      category_types: parseJsonArray(row.category_types),
      age_categories: parseJsonArray(row.age_categories),
      submitted_via:  row.submitted_via,
      created_at:     row.created_at,
      updated_at:     row.updated_at,
    },
  };
}

export async function fetchEventById(env, id) {
  const row = await env.DB
    .prepare(
      `SELECT e.id, e.name, e.status, e.event_date, e.address, e.details,
              e.poster_r2_key, e.organisation_id, e.submitted_via,
              e.created_at, e.updated_at,
              o.name AS organisation_name
         FROM events e LEFT JOIN organisations o ON o.id = e.organisation_id
        WHERE e.id = ?`,
    ).bind(id).first();
  if (!row) return null;
  return {
    id: row.id,
    fields: {
      name:              row.name,
      status:            row.status,
      event_date:        row.event_date,
      organisation_id:   row.organisation_id ?? null,
      organisation_name: row.organisation_name ?? null,
      details:           row.details ?? null,
      address:           row.address ?? null,
      poster_url:        mediaUrl(env, row.poster_r2_key),
      poster_r2_key:     row.poster_r2_key ?? null,
      submitted_via:     row.submitted_via,
      created_at:        row.created_at,
      updated_at:        row.updated_at,
    },
  };
}

export async function fetchVideoById(env, id) {
  const row = await env.DB
    .prepare(
      `SELECT v.id, v.name, v.status, v.description, v.youtube_url,
              v.video_r2_key, v.poster_r2_key, v.display_order,
              v.organisation_id, v.submitted_via,
              v.created_at, v.updated_at,
              o.name AS organisation_name
         FROM videos v LEFT JOIN organisations o ON o.id = v.organisation_id
        WHERE v.id = ?`,
    ).bind(id).first();
  if (!row) return null;
  return {
    id: row.id,
    fields: {
      name:              row.name,
      status:            row.status,
      description:       row.description ?? null,
      youtube_url:       row.youtube_url ?? null,
      video_url:         mediaUrl(env, row.video_r2_key),
      video_r2_key:      row.video_r2_key ?? null,
      poster_url:        mediaUrl(env, row.poster_r2_key),
      poster_r2_key:     row.poster_r2_key ?? null,
      organisation_id:   row.organisation_id ?? null,
      organisation_name: row.organisation_name ?? null,
      display_order:     row.display_order ?? null,
      submitted_via:     row.submitted_via,
      created_at:        row.created_at,
      updated_at:        row.updated_at,
    },
  };
}

// ════════════════════════════════════════════════════════════════════════
// USERS
//
// Schema is created by migrations/0001-add-users.sql. Helpers:
//   fetchUserById / fetchUserByEmail    — single row, or null
//   listUsers                           — all users, ordered by email
//   createUser                          — INSERT, returns new id
//   updateUser                          — partial update via whitelist
//   deleteUser                          — hard delete (no soft delete)
//   touchLastLogin                      — bump last_login_at, fire-and-forget
//
// Passwords arrive here already hashed (auth.js handles hashing on the
// caller side). This module never sees plaintext.
// ════════════════════════════════════════════════════════════════════════

const USER_PUBLIC_KEYS = `id, email, role, status, display_name,
  created_at, updated_at, last_login_at`;

const USER_WRITE_KEYS = [
  'email', 'password_hash', 'role', 'status', 'display_name',
];

function shapeUserRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    fields: {
      email:         row.email,
      role:          row.role,
      status:        row.status,
      display_name:  row.display_name ?? null,
      created_at:    row.created_at,
      updated_at:    row.updated_at,
      last_login_at: row.last_login_at ?? null,
    },
  };
}

export async function fetchUserById(env, id) {
  const row = await env.DB.prepare(`SELECT ${USER_PUBLIC_KEYS} FROM users WHERE id = ?`).bind(id).first();
  return shapeUserRow(row);
}

// Internal — includes password_hash, used ONLY by login flow.
export async function fetchUserByEmailWithHash(env, email) {
  if (typeof email !== 'string') return null;
  const row = await env.DB
    .prepare(`SELECT ${USER_PUBLIC_KEYS}, password_hash FROM users WHERE email = ?`)
    .bind(email.trim().toLowerCase()).first();
  return row || null;
}

export async function listUsers(env) {
  const { results } = await env.DB
    .prepare(`SELECT ${USER_PUBLIC_KEYS} FROM users ORDER BY email COLLATE NOCASE ASC`)
    .all();
  return (results || []).map(shapeUserRow);
}

export async function createUser(env, fields) {
  if (!fields.email)         throw new Error('email_required');
  if (!fields.password_hash) throw new Error('password_required');
  const now = NOW();
  const { meta } = await env.DB
    .prepare(
      `INSERT INTO users (email, password_hash, role, status, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      String(fields.email).trim().toLowerCase(),
      fields.password_hash,
      fields.role || 'admin',
      fields.status || 'active',
      fields.display_name ?? null,
      now, now,
    )
    .run();
  return meta.last_row_id;
}

export async function updateUser(env, id, fields) {
  // email lowercased here too, in case caller sends mixed case.
  const sanitised = { ...fields };
  if (typeof sanitised.email === 'string') {
    sanitised.email = sanitised.email.trim().toLowerCase();
  }
  const upd = buildUpdate('users', id, sanitised, USER_WRITE_KEYS);
  if (!upd) return false;
  const { meta } = await env.DB.prepare(upd.sql).bind(...upd.binds).run();
  return meta.changes > 0;
}

export async function deleteUser(env, id) {
  const { meta } = await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
  return meta.changes > 0;
}

// Fire-and-forget: bumps last_login_at on successful login. Errors
// swallowed — failing to record the timestamp shouldn't block sign-in.
export async function touchLastLogin(env, id) {
  try {
    await env.DB
      .prepare('UPDATE users SET last_login_at = ? WHERE id = ?')
      .bind(NOW(), id).run();
  } catch {
    /* ignore */
  }
}

// ════════════════════════════════════════════════════════════════════════
// PASSWORD RESETS
//
// Tokens are stored as SHA-256 hashes (token_hash UNIQUE). The raw
// token is only ever known to the caller at issuance time.
//
// consumeResetToken does a SELECT then a single UPDATE — no transaction
// because D1 serialises writes per database. At this scale, the race
// between two concurrent reset-with-same-token requests is academic.
// ════════════════════════════════════════════════════════════════════════

export async function createPasswordReset(env, { user_id, token_hash, expires_at, source }) {
  const now = NOW();
  await env.DB
    .prepare(
      `INSERT INTO password_resets (user_id, token_hash, created_at, expires_at, source)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(user_id, token_hash, now, expires_at, source)
    .run();
}

// Returns { user_id } on a valid, unused, unexpired token (and marks
// it used). Returns null otherwise. Never reveals WHY a token failed —
// caller surfaces a single 'invalid_or_expired' to the client.
export async function consumeResetToken(env, token_hash) {
  if (!token_hash) return null;
  const row = await env.DB
    .prepare(
      `SELECT id, user_id, expires_at, used_at
         FROM password_resets WHERE token_hash = ?`,
    )
    .bind(token_hash).first();
  if (!row)         return null;
  if (row.used_at)  return null;
  if (row.expires_at <= NOW()) return null;

  // Mark used. If the update changes 0 rows (concurrent claim), bail.
  const { meta } = await env.DB
    .prepare('UPDATE password_resets SET used_at = ? WHERE id = ? AND used_at IS NULL')
    .bind(NOW(), row.id).run();
  if (meta.changes === 0) return null;

  return { user_id: row.user_id };
}

// Optional housekeeping — drop rows that have either expired or been
// used > 7 days ago. Sample-based, fired from inside other handlers
// via ctx.waitUntil so it never adds latency to a request.
export function sweepExpiredResets(env, ctx) {
  if (Math.random() > 0.02) return;
  const oldUsedCutoff = NOW() - 7 * 24 * 60 * 60;
  ctx.waitUntil(
    env.DB
      .prepare(
        `DELETE FROM password_resets
           WHERE expires_at < ? OR (used_at IS NOT NULL AND used_at < ?)`,
      )
      .bind(NOW(), oldUsedCutoff)
      .run().catch(() => {}),
  );
}

// ════════════════════════════════════════════════════════════════════════
// AUDIT LOG
//
// One row per mutation. Light-weight: just enough to answer "who changed
// this row when". diff_json is a tiny JSON object {before, after} when
// the action is update/status_change, null otherwise.
// ════════════════════════════════════════════════════════════════════════

const AUDIT_ACTIONS = [
  'create', 'update', 'delete', 'approve', 'reject', 'status_change',
  'login', 'login_failed',
];

export async function writeAuditEntry(env, {
  actor = 'admin',
  action,
  entity,
  entity_id = null,
  diff = null,
}) {
  if (!AUDIT_ACTIONS.includes(action)) {
    throw new Error(`unknown audit action: ${action}`);
  }
  await env.DB
    .prepare(
      `INSERT INTO audit_log (at, actor, action, entity, entity_id, diff_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      NOW(),
      actor,
      action,
      entity,
      entity_id,
      diff == null ? null : JSON.stringify(diff),
    )
    .run();
}

export async function fetchRecentAuditEntries(env, limit = 50) {
  const safeLimit = Math.min(Math.max(1, Number(limit) || 50), 500);
  const { results } = await env.DB
    .prepare('SELECT id, at, actor, action, entity, entity_id, diff_json FROM audit_log ORDER BY at DESC LIMIT ?')
    .bind(safeLimit).all();
  return (results || []).map(r => ({
    id: r.id,
    fields: {
      at: r.at,
      actor: r.actor,
      action: r.action,
      entity: r.entity,
      entity_id: r.entity_id,
      diff: r.diff_json ? safeParse(r.diff_json) : null,
    },
  }));
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}
