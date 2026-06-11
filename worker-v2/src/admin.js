// ════════════════════════════════════════════════════════════════════════
// Admin endpoints — Phase 2 (read-only).
//
//   POST /admin/login                    body: {password} → {token, expires}
//   GET  /admin/whoami                                    → {actor, expires}
//   GET  /admin/organisations?status=…                    → {records: [...]}
//   GET  /admin/events?status=…                           → {records: [...]}
//   GET  /admin/videos?status=…                           → {records: [...]}
//
// All endpoints except /admin/login require Authorization: Bearer <token>.
// Phase 3 will add the write side (POST/PUT/DELETE + /status flips).
// ════════════════════════════════════════════════════════════════════════

import { jsonResponse } from './cors.js';
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
} from './db.js';

// ── Auth gate — used by every endpoint except /admin/login ──

async function requireAuth(request, env, origin) {
  const token = bearerFromRequest(request);
  if (!token) {
    return { resp: jsonResponse({ error: 'unauthorised' }, 401, env, origin) };
  }
  const result = await verifyToken(env, token);
  if (!result.ok) {
    return { resp: jsonResponse({ error: result.error || 'unauthorised' }, 401, env, origin) };
  }
  return { resp: null, actor: result.actor, expires: result.expires };
}

// ── POST /admin/login ──────────────────────────────────────────────────

async function handleLogin(request, env, origin) {
  if (!env.ADMIN_PASSWORD || !env.ADMIN_TOKEN_SECRET) {
    return jsonResponse({ error: 'auth_not_configured' }, 503, env, origin);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid_json' }, 400, env, origin);
  }

  const password = body && typeof body.password === 'string' ? body.password : '';
  // Always run the timing-safe compare even if the body is malformed so
  // an attacker can't distinguish "no password" from "wrong password" by
  // response time.
  const ok = await verifyPassword(env, password);
  if (!ok) {
    return jsonResponse({ error: 'unauthorised' }, 401, env, origin);
  }

  const token = await issueToken(env, 'admin');
  // Parse expiry back out so the client knows when to re-login.
  // (Token format: admin.<expires>.<sig>)
  const expires = Number(token.split('.')[1]);
  return jsonResponse({ token, expires, actor: 'admin' }, 200, env, origin);
}

// ── GET /admin/whoami ──────────────────────────────────────────────────

async function handleWhoami(request, env, origin) {
  const auth = await requireAuth(request, env, origin);
  if (auth.resp) return auth.resp;
  return jsonResponse({ ok: true, actor: auth.actor, expires: auth.expires }, 200, env, origin);
}

// ── GET /admin/<table>?status=… ────────────────────────────────────────

const TABLE_FETCHERS = {
  organisations: fetchAdminOrganisations,
  events:        fetchAdminEvents,
  videos:        fetchAdminVideos,
};

async function handleTableList(request, env, origin, table) {
  const auth = await requireAuth(request, env, origin);
  if (auth.resp) return auth.resp;

  const url = new URL(request.url);
  const status = url.searchParams.get('status') || 'all';
  if (!isValidStatusFilter(status)) {
    return jsonResponse(
      { error: 'invalid_status', allowed: ['all', 'pending', 'approved', 'rejected', 'draft'] },
      400, env, origin,
    );
  }

  const fetcher = TABLE_FETCHERS[table];
  let records;
  try {
    records = await fetcher(env, status);
  } catch (err) {
    return jsonResponse(
      { error: 'db_error', message: String(err?.message || err) },
      500, env, origin,
    );
  }
  return jsonResponse({ records, status }, 200, env, origin);
}

// ── Router entry point ─────────────────────────────────────────────────

export async function handleAdmin(request, env, url, origin) {
  // POST /admin/login
  if (request.method === 'POST' && url.pathname === '/admin/login') {
    return handleLogin(request, env, origin);
  }

  // GET /admin/whoami
  if (request.method === 'GET' && url.pathname === '/admin/whoami') {
    return handleWhoami(request, env, origin);
  }

  // GET /admin/<table>
  if (request.method === 'GET') {
    const match = /^\/admin\/(organisations|events|videos)$/.exec(url.pathname);
    if (match) return handleTableList(request, env, origin, match[1]);
  }

  return jsonResponse({ error: 'not_found', path: url.pathname }, 404, env, origin);
}
