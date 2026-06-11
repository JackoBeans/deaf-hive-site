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
