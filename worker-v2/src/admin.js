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

import { jsonResponse, readJsonBody } from './cors.js';
import { cachePurge } from './cache.js';
import {
  verifyPasswordHash,
  hashPassword,
  issueToken,
  verifyToken,
  bearerFromRequest,
  generateResetToken,
  hashResetToken,
  RESET_TTL_FORGOT_SECONDS,
  resetUrlFor,
  isValidPassword,
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
  fetchUserById,
  fetchUserByEmailWithHash,
  touchLastLogin,
  updateUser,
  createPasswordReset,
  consumeResetToken,
  sweepExpiredResets,
  STATUS_VALUES,
} from './db.js';
import { notifyPasswordReset } from './notify.js';
import { handleUpload, handleUploadDelete } from './images.js';
import { handleUsers } from './users.js';

import { READ_PATHS } from './reads.js';

// ── Auth gate ──────────────────────────────────────────────────────────
// Returns { resp: null, user, expires } on success — `user` is the
// public shape from fetchUserById (no password_hash). Returns 401 if
// the token is bad/expired OR the user has been deleted / disabled
// since the token was issued, so role + status changes take effect
// on the next admin click.

async function requireAuth(request, env, origin) {
  const token = bearerFromRequest(request);
  if (!token) return { resp: jsonResponse({ error: 'unauthorised' }, 401, env, origin) };

  const r = await verifyToken(env, token);
  if (!r.ok) return { resp: jsonResponse({ error: r.error || 'unauthorised' }, 401, env, origin) };

  const user = await fetchUserById(env, r.user_id);
  if (!user) return { resp: jsonResponse({ error: 'user_not_found' }, 401, env, origin) };
  if (user.fields.status !== 'active') {
    return { resp: jsonResponse({ error: 'user_disabled' }, 401, env, origin) };
  }
  return { resp: null, user, expires: r.expires };
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

async function handleLogin(request, env, ctx, origin) {
  if (!env.ADMIN_TOKEN_SECRET) {
    return jsonResponse({ error: 'auth_not_configured' }, 503, env, origin);
  }
  const { body, resp: bodyResp } = await readJsonBody(request, env, origin);
  if (bodyResp) return bodyResp;

  const email    = body && typeof body.email === 'string'    ? body.email.trim().toLowerCase() : '';
  const password = body && typeof body.password === 'string' ? body.password : '';

  // Always run verifyPasswordHash — even when the user doesn't exist,
  // we run a dummy PBKDF2 inside the helper so the response timing
  // doesn't leak account existence.
  const userRow = email ? await fetchUserByEmailWithHash(env, email) : null;
  const ok = await verifyPasswordHash(password, userRow?.password_hash || '');
  if (!ok || !userRow || userRow.status !== 'active') {
    return jsonResponse({ error: 'unauthorised' }, 401, env, origin);
  }

  const token = await issueToken(env, userRow.id);
  // Extract expires from the token: u<id>.<expires>.<sig>
  const expires = Number(token.split('.')[1]);

  // Don't block the response on the last-login bump.
  ctx.waitUntil(touchLastLogin(env, userRow.id));

  return jsonResponse({
    token,
    expires,
    user: {
      id:           userRow.id,
      email:        userRow.email,
      role:         userRow.role,
      display_name: userRow.display_name ?? null,
    },
  }, 200, env, origin);
}

async function handleWhoami(request, env, origin) {
  const auth = await requireAuth(request, env, origin);
  if (auth.resp) return auth.resp;
  return jsonResponse({
    ok: true,
    user: auth.user,
    expires: auth.expires,
  }, 200, env, origin);
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

  const { body, resp: bodyResp } = await readJsonBody(request, env, origin);
  if (bodyResp) return bodyResp;

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
    actor: auth.user.fields.email, action: 'create', entity: ops.entity, entity_id: id,
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

  const { body, resp: bodyResp } = await readJsonBody(request, env, origin);
  if (bodyResp) return bodyResp;

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
    actor: auth.user.fields.email, action: 'update', entity: ops.entity, entity_id: id,
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
    actor: auth.user.fields.email, action: 'delete', entity: ops.entity, entity_id: id,
    diff: { before: before.fields },
  });
  if (before.fields.status === 'approved') await purgePublicCaches(env, url);

  return jsonResponse({ ok: true, id }, 200, env, origin);
}

// ── Status flip ────────────────────────────────────────────────────────

async function handleStatusChange(request, env, url, origin, table, id) {
  const auth = await requireAuth(request, env, origin);
  if (auth.resp) return auth.resp;

  const { body, resp: bodyResp } = await readJsonBody(request, env, origin);
  if (bodyResp) return bodyResp;

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
    actor: auth.user.fields.email, action, entity: ops.entity, entity_id: id,
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

// ── Password change / forgot / reset ───────────────────────────────────

// POST /admin/me/change-password — auth required.
// Body: { current_password, new_password }. The bearer token alone
// doesn't authorise a password change — a stolen token would otherwise
// let the attacker lock the legitimate user out. Requiring the current
// password is the minimum sane gate.
async function handleChangePassword(request, env, origin) {
  const auth = await requireAuth(request, env, origin);
  if (auth.resp) return auth.resp;

  const { body, resp: bodyResp } = await readJsonBody(request, env, origin);
  if (bodyResp) return bodyResp;

  const current = body && typeof body.current_password === 'string' ? body.current_password : '';
  const next    = body && typeof body.new_password     === 'string' ? body.new_password     : '';
  if (!isValidPassword(next)) {
    return jsonResponse({ error: 'invalid_password', message: 'min 8 characters' }, 400, env, origin);
  }

  // Re-fetch with hash to verify the current password.
  const withHash = await fetchUserByEmailWithHash(env, auth.user.fields.email);
  if (!withHash) return jsonResponse({ error: 'user_not_found' }, 401, env, origin);
  const ok = await verifyPasswordHash(current, withHash.password_hash);
  if (!ok) return jsonResponse({ error: 'wrong_current_password' }, 401, env, origin);

  const newHash = await hashPassword(next);
  await updateUser(env, auth.user.id, { password_hash: newHash });
  await writeAuditEntry(env, {
    actor: auth.user.fields.email, action: 'update', entity: 'user',
    entity_id: auth.user.id, diff: { password_changed: true, via: 'self_change' },
  });
  return jsonResponse({ ok: true }, 200, env, origin);
}

// POST /admin/forgot-password — NO auth required.
// Body: { email }. Response is always 202 — we never reveal whether the
// email is registered (prevents enumeration). If the user does exist,
// we issue a 1-hour token and try to email it via Resend (silent skip
// if Resend isn't set up yet — see notify.js).
async function handleForgotPassword(request, env, ctx, origin) {
  const { body, resp: bodyResp } = await readJsonBody(request, env, origin);
  if (bodyResp) return bodyResp;

  const email = body && typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  // Always return 202 — same response regardless of whether the email
  // exists or not. The work below happens in the background.
  ctx.waitUntil((async () => {
    if (!email) return;
    const user = await fetchUserByEmailWithHash(env, email);
    if (!user) return;
    if (user.status !== 'active') return;

    const raw = generateResetToken();
    const tokenHash = await hashResetToken(raw);
    const expiresAt = Math.floor(Date.now() / 1000) + RESET_TTL_FORGOT_SECONDS;
    try {
      await createPasswordReset(env, {
        user_id: user.id, token_hash: tokenHash, expires_at: expiresAt,
        source: 'forgot_password',
      });
      const resetUrl = resetUrlFor(raw);
      notifyPasswordReset(env, ctx, { toEmail: email, resetUrl, expiresAt });
      await writeAuditEntry(env, {
        actor: 'public', action: 'create', entity: 'password_reset',
        entity_id: user.id, diff: { source: 'forgot_password' },
      });
    } catch (err) {
      console.warn('forgot-password background work failed', err?.message || err);
    }
  })());
  sweepExpiredResets(env, ctx);
  return jsonResponse({ ok: true }, 202, env, origin);
}

// POST /admin/reset-password — NO auth required.
// Body: { token, new_password }. Consumes the token (one-shot) and
// updates the linked user's password. Returns 200 on success, 400 on
// invalid/expired/used token — same error for all three to avoid
// confirming which case happened.
async function handleResetPassword(request, env, origin) {
  const { body, resp: bodyResp } = await readJsonBody(request, env, origin);
  if (bodyResp) return bodyResp;

  const raw  = body && typeof body.token        === 'string' ? body.token        : '';
  const next = body && typeof body.new_password === 'string' ? body.new_password : '';
  if (!isValidPassword(next)) {
    return jsonResponse({ error: 'invalid_password', message: 'min 8 characters' }, 400, env, origin);
  }
  if (!raw) return jsonResponse({ error: 'invalid_or_expired' }, 400, env, origin);

  const tokenHash = await hashResetToken(raw);
  const claim = await consumeResetToken(env, tokenHash);
  if (!claim) return jsonResponse({ error: 'invalid_or_expired' }, 400, env, origin);

  const newHash = await hashPassword(next);
  await updateUser(env, claim.user_id, { password_hash: newHash });
  await writeAuditEntry(env, {
    actor: 'public', action: 'update', entity: 'user',
    entity_id: claim.user_id, diff: { password_changed: true, via: 'reset_link' },
  });
  return jsonResponse({ ok: true }, 200, env, origin);
}

// ── Router ─────────────────────────────────────────────────────────────

export async function handleAdmin(request, env, ctx, url, origin) {
  // Auth
  if (request.method === 'POST' && url.pathname === '/admin/login')   return handleLogin(request, env, ctx, origin);
  if (request.method === 'GET'  && url.pathname === '/admin/whoami')  return handleWhoami(request, env, origin);
  if (request.method === 'GET'  && url.pathname === '/admin/audit')   return handleAudit(request, env, origin);

  // Password change / forgot / reset
  if (request.method === 'POST' && url.pathname === '/admin/me/change-password') return handleChangePassword(request, env, origin);
  if (request.method === 'POST' && url.pathname === '/admin/forgot-password')    return handleForgotPassword(request, env, ctx, origin);
  if (request.method === 'POST' && url.pathname === '/admin/reset-password')     return handleResetPassword(request, env, origin);

  // Upload — auth checked inside the handler.
  if (request.method === 'POST'   && url.pathname === '/admin/upload') return handleUpload(request, env, origin);
  if (request.method === 'DELETE' && url.pathname.startsWith('/admin/upload/')) {
    return handleUploadDelete(request, env, url, origin);
  }

  // /admin/users* — auth runs here, then dispatch with the auth result.
  if (url.pathname === '/admin/users' || url.pathname.startsWith('/admin/users/')) {
    const auth = await requireAuth(request, env, origin);
    if (auth.resp) return auth.resp;
    return handleUsers(request, env, url, origin, auth);
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
