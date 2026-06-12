// ════════════════════════════════════════════════════════════════════════
// User management endpoints.
//
//   GET    /admin/users         → list (any authenticated user)
//   GET    /admin/users/{id}    → single user (any authenticated user)
//   POST   /admin/users         → create (owner only)
//   PATCH  /admin/users/{id}    → update (owner OR self for own
//                                  password + display_name only)
//   DELETE /admin/users/{id}    → delete (owner only, can't delete self)
//
// Every write is audit-logged. The audit `actor` is the email of the
// signed-in user; `entity` is 'user'; `entity_id` is the target user's id.
//
// Auth flow notes:
// - requireAuth and requireOwner live in admin.js (composing on top of
//   verifyToken + fetchUserById). This module re-exports nothing —
//   admin.js dispatches the request to handleUsers below.
// - Plain-text passwords arrive only on create + self-password-change.
//   They are hashed here via auth.hashPassword before reaching db.js.
// ════════════════════════════════════════════════════════════════════════

import { jsonResponse } from './cors.js';
import { hashPassword } from './auth.js';
import {
  fetchUserById,
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  writeAuditEntry,
} from './db.js';

const ROLES    = ['owner', 'admin'];
const STATUSES = ['active', 'disabled'];

// Cheap RFC-ish email shape check — server is not the right place for
// "is this a real address" verification (there is no canonical answer),
// just for catching obvious typos / non-strings.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function isValidEmail(s)    { return typeof s === 'string' && EMAIL_RE.test(s); }
function isValidRole(s)     { return ROLES.includes(s); }
function isValidStatusU(s)  { return STATUSES.includes(s); }
function isValidPassword(s) {
  // The bar is intentionally lenient — admins are trusted to use
  // password managers — but we reject anything too short / non-string
  // / clearly empty.
  return typeof s === 'string' && s.length >= 8 && s.length <= 256;
}

// ── Handlers (all gated by the calling router; we receive {auth}) ──────

async function handleList(env, origin, auth) {
  const records = await listUsers(env);
  return jsonResponse({ records }, 200, env, origin);
}

async function handleDetail(env, origin, auth, id) {
  const record = await fetchUserById(env, id);
  if (!record) return jsonResponse({ error: 'not_found' }, 404, env, origin);
  return jsonResponse({ record }, 200, env, origin);
}

async function handleCreate(request, env, origin, auth) {
  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: 'invalid_json' }, 400, env, origin); }

  const fields = body && body.fields ? body.fields : body;
  if (!fields || typeof fields !== 'object') {
    return jsonResponse({ error: 'missing_fields' }, 400, env, origin);
  }
  if (!isValidEmail(fields.email)) {
    return jsonResponse({ error: 'invalid_email' }, 400, env, origin);
  }
  if (!isValidPassword(fields.password)) {
    return jsonResponse({ error: 'invalid_password', message: 'min 8 characters' }, 400, env, origin);
  }
  const role = fields.role || 'admin';
  if (!isValidRole(role)) {
    return jsonResponse({ error: 'invalid_role', allowed: ROLES }, 400, env, origin);
  }
  const status = fields.status || 'active';
  if (!isValidStatusU(status)) {
    return jsonResponse({ error: 'invalid_status', allowed: STATUSES }, 400, env, origin);
  }

  let password_hash;
  try { password_hash = await hashPassword(fields.password); }
  catch (err) {
    return jsonResponse({ error: 'hash_failed', message: String(err?.message || err) }, 500, env, origin);
  }

  let newId;
  try {
    newId = await createUser(env, {
      email:        fields.email,
      password_hash,
      role,
      status,
      display_name: fields.display_name ?? null,
    });
  } catch (err) {
    const msg = String(err?.message || err);
    // Surface UNIQUE-constraint failures as a friendly error.
    if (/UNIQUE constraint failed/i.test(msg)) {
      return jsonResponse({ error: 'email_taken' }, 409, env, origin);
    }
    return jsonResponse({ error: 'create_failed', message: msg }, 400, env, origin);
  }

  await writeAuditEntry(env, {
    actor: auth.user.fields.email, action: 'create', entity: 'user',
    entity_id: newId,
    diff: { after: { email: fields.email, role, status, display_name: fields.display_name ?? null } },
  });

  const record = await fetchUserById(env, newId);
  return jsonResponse({ record }, 201, env, origin);
}

async function handleUpdate(request, env, origin, auth, id) {
  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: 'invalid_json' }, 400, env, origin); }

  const fields = body && body.fields ? body.fields : body;
  if (!fields || typeof fields !== 'object') {
    return jsonResponse({ error: 'missing_fields' }, 400, env, origin);
  }

  const before = await fetchUserById(env, id);
  if (!before) return jsonResponse({ error: 'not_found' }, 404, env, origin);

  const isSelf  = auth.user.id === id;
  const isOwner = auth.user.fields.role === 'owner';

  if (!isOwner && !isSelf) {
    return jsonResponse({ error: 'forbidden' }, 403, env, origin);
  }

  // Self-edit allows ONLY display_name + password. Owner may set anything,
  // EXCEPT: owner editing themselves cannot demote their own role or
  // disable themselves — prevents "no owner remaining" lockouts.
  const writable = {};
  if (typeof fields.display_name === 'string' || fields.display_name === null) {
    writable.display_name = fields.display_name;
  }
  if (typeof fields.password === 'string' && fields.password !== '') {
    if (!isValidPassword(fields.password)) {
      return jsonResponse({ error: 'invalid_password', message: 'min 8 characters' }, 400, env, origin);
    }
    try { writable.password_hash = await hashPassword(fields.password); }
    catch (err) {
      return jsonResponse({ error: 'hash_failed', message: String(err?.message || err) }, 500, env, origin);
    }
  }
  if (isOwner) {
    if (typeof fields.email === 'string') {
      if (!isValidEmail(fields.email)) {
        return jsonResponse({ error: 'invalid_email' }, 400, env, origin);
      }
      writable.email = fields.email;
    }
    if (typeof fields.role === 'string') {
      if (!isValidRole(fields.role)) {
        return jsonResponse({ error: 'invalid_role', allowed: ROLES }, 400, env, origin);
      }
      if (isSelf && fields.role !== 'owner') {
        return jsonResponse({ error: 'cannot_demote_self' }, 400, env, origin);
      }
      writable.role = fields.role;
    }
    if (typeof fields.status === 'string') {
      if (!isValidStatusU(fields.status)) {
        return jsonResponse({ error: 'invalid_status', allowed: STATUSES }, 400, env, origin);
      }
      if (isSelf && fields.status !== 'active') {
        return jsonResponse({ error: 'cannot_disable_self' }, 400, env, origin);
      }
      writable.status = fields.status;
    }
  }

  if (Object.keys(writable).length === 0) {
    return jsonResponse({ error: 'no_op' }, 400, env, origin);
  }

  let changed;
  try { changed = await updateUser(env, id, writable); }
  catch (err) {
    const msg = String(err?.message || err);
    if (/UNIQUE constraint failed/i.test(msg)) {
      return jsonResponse({ error: 'email_taken' }, 409, env, origin);
    }
    return jsonResponse({ error: 'update_failed', message: msg }, 400, env, origin);
  }
  if (!changed) return jsonResponse({ error: 'not_found' }, 404, env, origin);

  const after = await fetchUserById(env, id);

  // Build an audit diff but never log raw hashes.
  const touchedKeys = Object.keys(writable).filter(k => k !== 'password_hash');
  const diff = {
    before: Object.fromEntries(touchedKeys.map(k => [k, before.fields[k]])),
    after:  Object.fromEntries(touchedKeys.map(k => [k, after.fields[k]])),
    password_changed: 'password_hash' in writable ? true : undefined,
  };

  await writeAuditEntry(env, {
    actor: auth.user.fields.email, action: 'update', entity: 'user',
    entity_id: id, diff,
  });

  return jsonResponse({ record: after }, 200, env, origin);
}

async function handleDelete(env, origin, auth, id) {
  if (auth.user.id === id) {
    return jsonResponse({ error: 'cannot_delete_self' }, 400, env, origin);
  }
  const before = await fetchUserById(env, id);
  if (!before) return jsonResponse({ error: 'not_found' }, 404, env, origin);

  await deleteUser(env, id);
  await writeAuditEntry(env, {
    actor: auth.user.fields.email, action: 'delete', entity: 'user',
    entity_id: id,
    diff: { before: { email: before.fields.email, role: before.fields.role } },
  });
  return jsonResponse({ ok: true, id }, 200, env, origin);
}

// ── Entry point — admin.js dispatches here AFTER requireAuth has run ───

function ownerOnly(env, origin, auth) {
  if (auth.user.fields.role !== 'owner') {
    return jsonResponse({ error: 'forbidden_owner_only' }, 403, env, origin);
  }
  return null;
}

export async function handleUsers(request, env, url, origin, auth) {
  // GET — list / detail (any authenticated user)
  if (request.method === 'GET') {
    if (url.pathname === '/admin/users') return handleList(env, origin, auth);
    const m = /^\/admin\/users\/(\d+)$/.exec(url.pathname);
    if (m) return handleDetail(env, origin, auth, Number(m[1]));
  }

  // POST /admin/users — create (owner only)
  if (request.method === 'POST' && url.pathname === '/admin/users') {
    const blocked = ownerOnly(env, origin, auth);
    if (blocked) return blocked;
    return handleCreate(request, env, origin, auth);
  }

  // PATCH /admin/users/:id — owner OR self (gate enforced in handleUpdate)
  if (request.method === 'PATCH') {
    const m = /^\/admin\/users\/(\d+)$/.exec(url.pathname);
    if (m) return handleUpdate(request, env, origin, auth, Number(m[1]));
  }

  // DELETE /admin/users/:id — owner only (self-delete also blocked inside)
  if (request.method === 'DELETE') {
    const m = /^\/admin\/users\/(\d+)$/.exec(url.pathname);
    if (m) {
      const blocked = ownerOnly(env, origin, auth);
      if (blocked) return blocked;
      return handleDelete(env, origin, auth, Number(m[1]));
    }
  }

  return jsonResponse({ error: 'not_found', path: url.pathname, method: request.method }, 404, env, origin);
}
