// ════════════════════════════════════════════════════════════════════════
// Admin endpoints — Phase 3 (read + write).
//
//   POST   /admin/login                          → token + expires
//   GET    /admin/whoami                         → actor + expires
//
//   GET    /admin/{table}?status=…               → records list
//   GET    /admin/{table}/{id}                   → single record
//   POST   /admin/{table}                        → create
//   PUT    /admin/{table}/{id}                   → update (partial)
//   DELETE /admin/{table}/{id}                   → delete (R2 cleanup chain
//                                                   stays in the UI for now)
//   POST   /admin/{table}/{id}/status            → body {status} → flip
//
//   POST   /admin/upload                         → multipart file → R2
//   DELETE /admin/upload/{encoded-key}           → remove from R2
//
//   GET    /admin/audit?limit=50                 → recent audit_log rows
//
// {table} = organisations | events | videos
//
// Every mutation writes an audit_log entry. Mutations to/from 'approved'
// status fire an internal cache purge so the public /organisations, /events,
// /videos endpoints refresh within seconds.
// ════════════════════════════════════════════════════════════════════════

import { jsonResponse } from './cors.js';
import { cachePurge } from './cache.js';
import {
  verifyPassword,
  issueToken,
  verifyToken,
  bearerFromRequest,
} from './auth.js';
import {
  isValidStatusFilter,
  fetchAdminOrganisations,
  fetchAdminEvents,
  fetchAdminVideos,
  fetchOrganisationById,
  fetchEventById,
  fetchVideoById,
  createOrganisation,
  createEvent,
  createVideo,
  updateOrganisation,
  updateEvent,
  updateVideo,
  deleteOrganisation,
  deleteEvent,
  deleteVideo,
  writeAuditEntry,
  fetchRecentAuditEntries,
} from './db.js';
import { handleUpload, handleUploadDelete } from './images.js';

import { READ_PATHS } from './reads.js';

const STATUS_VALUES = ['pending', 'approved', 'rejected', 'draft'];

// ── Auth gate ──────────────────────────────────────────────────────────

async function requireAuth(request, env, origin) {
  const token = bearerFromRequest(request);
  if (!token) return { resp: jsonResponse({ error: 'unauthorised' }, 401, env, origin) };
  const r = await verifyToken(env, token);
  if (!r.ok) return { resp: jsonResponse({ error: r.error || 'unauthorised' }, 401, env, origin) };
  return { resp: null, actor: r.actor, expires: r.expires };
}

// ── Per-table function map ─────────────────────────────────────────────

const TABLE_OPS = {
  organisations: {
    list:   fetchAdminOrganisations,
    detail: fetchOrganisationById,
    create: createOrganisation,
    update: updateOrganisation,
    remove: deleteOrganisation,
    entity: 'organisation',
  },
  events: {
    list:   fetchAdminEvents,
    detail: fetchEventById,
    create: createEvent,
    update: updateEvent,
    remove: deleteEvent,
    entity: 'event',
  },
  videos: {
    list:   fetchAdminVideos,
    detail: fetchVideoById,
    create: createVideo,
    update: updateVideo,
    remove: deleteVideo,
    entity: 'video',
  },
};

// ── Cache purge after mutations that affect public reads ───────────────

async function purgePublicCaches(env, url) {
  try {
    await cachePurge(url.origin, READ_PATHS);
  } catch (err) {
    // Cache purge failing isn't fatal — caches will expire naturally
    // within the TTL. Just log.
    console.warn('cache purge failed', err?.message || err);
  }
}

// ── Auth endpoints ─────────────────────────────────────────────────────

async function handleLogin(request, env, origin) {
  if (!env.ADMIN_PASSWORD || !env.ADMIN_TOKEN_SECRET) {
    return jsonResponse({ error: 'auth_not_configured' }, 503, env, origin);
  }
  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: 'invalid_json' }, 400, env, origin); }

  const password = body && typeof body.password === 'string' ? body.password : '';
  const ok = await verifyPassword(env, password);
  if (!ok) return jsonResponse({ error: 'unauthorised' }, 401, env, origin);

  const token = await issueToken(env, 'admin');
  const expires = Number(token.split('.')[1]);
  return jsonResponse({ token, expires, actor: 'admin' }, 200, env, origin);
}

async function handleWhoami(request, env, origin) {
  const auth = await requireAuth(request, env, origin);
  if (auth.resp) return auth.resp;
  return jsonResponse({ ok: true, actor: auth.actor, expires: auth.expires }, 200, env, origin);
}

// ── List / detail ──────────────────────────────────────────────────────

async function handleList(request, env, origin, table) {
  const auth = await requireAuth(request, env, origin);
  if (auth.resp) return auth.resp;

  const url = new URL(request.url);
  const status = url.searchParams.get('status') || 'all';
  if (!isValidStatusFilter(status)) {
    return jsonResponse(
      { error: 'invalid_status', allowed: ['all', ...STATUS_VALUES] },
      400, env, origin,
    );
  }
  try {
    const records = await TABLE_OPS[table].list(env, status);
    return jsonResponse({ records, status }, 200, env, origin);
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: String(err?.message || err) }, 500, env, origin);
  }
}

async function handleDetail(request, env, origin, table, id) {
  const auth = await requireAuth(request, env, origin);
  if (auth.resp) return auth.resp;
  try {
    const record = await TABLE_OPS[table].detail(env, id);
    if (!record) return jsonResponse({ error: 'not_found' }, 404, env, origin);
    return jsonResponse({ record }, 200, env, origin);
  } catch (err) {
    return jsonResponse({ error: 'db_error', message: String(err?.message || err) }, 500, env, origin);
  }
}

// ── Create / Update / Delete ───────────────────────────────────────────

async function handleCreate(request, env, url, origin, table) {
  const auth = await requireAuth(request, env, origin);
  if (auth.resp) return auth.resp;

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: 'invalid_json' }, 400, env, origin); }

  const fields = body && body.fields ? body.fields : body;
  if (!fields || typeof fields !== 'object') {
    return jsonResponse({ error: 'missing_fields' }, 400, env, origin);
  }
  if (!fields.name || typeof fields.name !== 'string') {
    return jsonResponse({ error: 'name_required' }, 400, env, origin);
  }
  if (table === 'events' && !fields.event_date) {
    return jsonResponse({ error: 'event_date_required' }, 400, env, origin);
  }

  const ops = TABLE_OPS[table];
  let id;
  try {
    id = await ops.create(env, fields);
  } catch (err) {
    return jsonResponse({ error: 'create_failed', message: String(err?.message || err) }, 400, env, origin);
  }
  await writeAuditEntry(env, {
    actor: auth.actor, action: 'create', entity: ops.entity, entity_id: id,
    diff: { after: fields },
  });
  // New approved row → purge cache.
  if (fields.status === 'approved') await purgePublicCaches(env, url);

  const record = await ops.detail(env, id);
  return jsonResponse({ record }, 201, env, origin);
}

async function handleUpdate(request, env, url, origin, table, id) {
  const auth = await requireAuth(request, env, origin);
  if (auth.resp) return auth.resp;

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: 'invalid_json' }, 400, env, origin); }

  const fields = body && body.fields ? body.fields : body;
  if (!fields || typeof fields !== 'object') {
    return jsonResponse({ error: 'missing_fields' }, 400, env, origin);
  }

  const ops = TABLE_OPS[table];
  const before = await ops.detail(env, id);
  if (!before) return jsonResponse({ error: 'not_found' }, 404, env, origin);

  let changed;
  try {
    changed = await ops.update(env, id, fields);
  } catch (err) {
    return jsonResponse({ error: 'update_failed', message: String(err?.message || err) }, 400, env, origin);
  }
  if (!changed) {
    return jsonResponse({ error: 'no_op', message: 'no writeable fields supplied' }, 400, env, origin);
  }

  const after = await ops.detail(env, id);
  await writeAuditEntry(env, {
    actor: auth.actor, action: 'update', entity: ops.entity, entity_id: id,
    diff: diffFields(before.fields, after.fields, Object.keys(fields)),
  });
  // Touched a row that's approved (or just became approved) → purge.
  if (before.fields.status === 'approved' || after.fields.status === 'approved') {
    await purgePublicCaches(env, url);
  }
  return jsonResponse({ record: after }, 200, env, origin);
}

async function handleDelete(request, env, url, origin, table, id) {
  const auth = await requireAuth(request, env, origin);
  if (auth.resp) return auth.resp;

  const ops = TABLE_OPS[table];
  const before = await ops.detail(env, id);
  if (!before) return jsonResponse({ error: 'not_found' }, 404, env, origin);

  try {
    await ops.remove(env, id);
  } catch (err) {
    return jsonResponse({ error: 'delete_failed', message: String(err?.message || err) }, 500, env, origin);
  }

  await writeAuditEntry(env, {
    actor: auth.actor, action: 'delete', entity: ops.entity, entity_id: id,
    diff: { before: before.fields },
  });
  if (before.fields.status === 'approved') await purgePublicCaches(env, url);

  return jsonResponse({ ok: true, id }, 200, env, origin);
}

// ── Status flip ────────────────────────────────────────────────────────

async function handleStatusChange(request, env, url, origin, table, id) {
  const auth = await requireAuth(request, env, origin);
  if (auth.resp) return auth.resp;

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: 'invalid_json' }, 400, env, origin); }

  const next = body && body.status;
  if (!STATUS_VALUES.includes(next)) {
    return jsonResponse({ error: 'invalid_status', allowed: STATUS_VALUES }, 400, env, origin);
  }

  const ops = TABLE_OPS[table];
  const before = await ops.detail(env, id);
  if (!before) return jsonResponse({ error: 'not_found' }, 404, env, origin);

  if (before.fields.status === next) {
    // No-op — still respond 200 with the unchanged record.
    return jsonResponse({ record: before, unchanged: true }, 200, env, origin);
  }

  try {
    await ops.update(env, id, { status: next });
  } catch (err) {
    return jsonResponse({ error: 'update_failed', message: String(err?.message || err) }, 500, env, origin);
  }

  const after = await ops.detail(env, id);

  // Audit: "approve" / "reject" are explicit verbs; other transitions get
  // logged as generic status_change so the audit log answers questions
  // like "when was this taken down" without ambiguity.
  const action =
      next === 'approved' ? 'approve'
    : next === 'rejected' ? 'reject'
    : 'status_change';

  await writeAuditEntry(env, {
    actor: auth.actor, action, entity: ops.entity, entity_id: id,
    diff: { before: { status: before.fields.status }, after: { status: next } },
  });

  // Anything touching the approved set → purge.
  if (before.fields.status === 'approved' || next === 'approved') {
    await purgePublicCaches(env, url);
  }
  return jsonResponse({ record: after }, 200, env, origin);
}

// ── Audit log ──────────────────────────────────────────────────────────

async function handleAudit(request, env, origin) {
  const auth = await requireAuth(request, env, origin);
  if (auth.resp) return auth.resp;
  const url = new URL(request.url);
  const limit = url.searchParams.get('limit');
  const records = await fetchRecentAuditEntries(env, limit);
  return jsonResponse({ records }, 200, env, origin);
}

// ── Tiny diff (only the keys the caller touched) ───────────────────────

function diffFields(before, after, keys) {
  const b = {}, a = {};
  for (const k of keys) {
    if (before[k] !== after[k]) {
      b[k] = before[k];
      a[k] = after[k];
    }
  }
  return Object.keys(a).length ? { before: b, after: a } : null;
}

// ── Router ─────────────────────────────────────────────────────────────

export async function handleAdmin(request, env, url, origin) {
  // Auth
  if (request.method === 'POST' && url.pathname === '/admin/login')   return handleLogin(request, env, origin);
  if (request.method === 'GET'  && url.pathname === '/admin/whoami')  return handleWhoami(request, env, origin);
  if (request.method === 'GET'  && url.pathname === '/admin/audit')   return handleAudit(request, env, origin);

  // Upload — auth checked inside the handler.
  if (request.method === 'POST'   && url.pathname === '/admin/upload') return handleUpload(request, env, origin);
  if (request.method === 'DELETE' && url.pathname.startsWith('/admin/upload/')) {
    return handleUploadDelete(request, env, url, origin);
  }

  // /admin/<table> and /admin/<table>/<id>[/status]
  const m = /^\/admin\/(organisations|events|videos)(?:\/(\d+))?(\/status)?$/.exec(url.pathname);
  if (m) {
    const table = m[1];
    const id    = m[2] ? Number(m[2]) : null;
    const isStatusPath = !!m[3];

    if (request.method === 'GET'    && id == null && !isStatusPath) return handleList(request, env, origin, table);
    if (request.method === 'POST'   && id == null && !isStatusPath) return handleCreate(request, env, url, origin, table);
    if (request.method === 'GET'    && id != null && !isStatusPath) return handleDetail(request, env, origin, table, id);
    if (request.method === 'PUT'    && id != null && !isStatusPath) return handleUpdate(request, env, url, origin, table, id);
    if (request.method === 'DELETE' && id != null && !isStatusPath) return handleDelete(request, env, url, origin, table, id);
    if (request.method === 'POST'   && id != null &&  isStatusPath) return handleStatusChange(request, env, url, origin, table, id);
  }

  return jsonResponse({ error: 'not_found', path: url.pathname, method: request.method }, 404, env, origin);
}
