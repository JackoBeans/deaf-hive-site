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

function mediaUrl(env, key) {
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

const STATUS_VALUES = ['pending', 'approved', 'rejected', 'draft'];

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
