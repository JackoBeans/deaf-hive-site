// ════════════════════════════════════════════════════════════════════════
// DeafHive worker-v2 — router
//
// Endpoints (Phase 2):
//   Public (cached):
//     GET  /organisations          approved orgs from D1, edge-cached
//     GET  /events                 approved events + joined org name
//     GET  /videos                 approved videos + joined org name
//
//   Admin (HMAC bearer token, multi-user — see users table):
//     POST /admin/login            {email, password} → token + user
//     GET  /admin/whoami           verify current token + user state
//     GET/POST/PUT/DELETE /admin/{organisations,events,videos}[/:id]
//     POST /admin/{table}/:id/status   flip status (auto-purges cache)
//     POST /admin/upload                multipart image/video → R2
//     DELETE /admin/upload/{key}
//     GET    /admin/users          list (any auth)
//     POST   /admin/users          create (owner only)
//     PATCH  /admin/users/:id      update (owner OR self)
//     DELETE /admin/users/:id      delete (owner only, blocks self-delete)
//     POST /admin/users/:id/create-reset-link  generate 24h reset URL (owner)
//     POST /admin/me/change-password           {current, new} (auth)
//     POST /admin/forgot-password              {email} (no auth, always 202)
//     POST /admin/reset-password               {token, new_password} (no auth)
//     GET  /admin/audit?limit=50
//
//   Public submissions (Turnstile + rate-limit):
//     POST /submissions/organisation
//     POST /submissions/event
//     POST /submissions/video
//     POST /submissions/upload     multipart image → R2 under pending/
//
//   System:
//     POST /purge                  clears all caches (X-Purge-Token header)
//     GET  /healthz                { ok, version }
//     GET  /probe-bindings         confirms D1 + R2 bindings reachable
//
// Write endpoints (POST/PUT/DELETE on /admin/*, /submissions/*, /upload)
// land in Phase 3 onwards.
// ════════════════════════════════════════════════════════════════════════

import {
  jsonResponse,
  preflightResponse,
} from './cors.js';
import { cachePurge } from './cache.js';
import { handleRead, READ_PATHS } from './reads.js';
import { handleAdmin } from './admin.js';
import { handleSubmissions } from './submissions.js';

const VERSION = '0.7.1-consolidated';

// ── Phase 0 probes (kept for ongoing health checks) ────────────────────

async function handleHealthz(env, origin) {
  return jsonResponse({ ok: true, version: VERSION }, 200, env, origin);
}

async function handleProbeBindings(env, origin) {
  let dbResult;
  try {
    const row = await env.DB.prepare('SELECT 1 AS one').first();
    dbResult = { ok: true, returned: row };
  } catch (err) {
    dbResult = { ok: false, error: String(err?.message || err) };
  }

  let r2Result;
  try {
    const list = await env.MEDIA.list({ limit: 1 });
    r2Result = {
      ok: true,
      bucket_reachable: true,
      object_count_first_page: list.objects?.length ?? 0,
      truncated: !!list.truncated,
    };
  } catch (err) {
    r2Result = { ok: false, error: String(err?.message || err) };
  }

  const allOk = dbResult.ok && r2Result.ok;
  return jsonResponse(
    {
      ok: allOk,
      version: VERSION,
      db: dbResult,
      r2: r2Result,
      media_base_url: env.MEDIA_BASE_URL || null,
    },
    allOk ? 200 : 503,
    env,
    origin,
  );
}

// ── Purge — same X-Purge-Token model as the existing worker so the live
//    Airtable automation can keep pointing here unchanged at cutover. ──

async function handlePurge(request, env, url, origin) {
  const provided = request.headers.get('X-Purge-Token');
  if (!env.PURGE_SECRET) {
    return jsonResponse({ error: 'purge_not_configured' }, 503, env, origin);
  }
  if (!provided || provided !== env.PURGE_SECRET) {
    return jsonResponse({ error: 'unauthorised' }, 401, env, origin);
  }
  const purged = await cachePurge(url.origin, READ_PATHS);
  return jsonResponse({ purged }, 200, env, origin);
}

// ── Router ─────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return preflightResponse(env, origin);
    }

    if (request.method === 'POST' && url.pathname === '/purge') {
      return handlePurge(request, env, url, origin);
    }

    if (request.method === 'GET' && url.pathname === '/healthz') {
      return handleHealthz(env, origin);
    }

    if (request.method === 'GET' && url.pathname === '/probe-bindings') {
      return handleProbeBindings(env, origin);
    }

    if (request.method === 'GET' && READ_PATHS.includes(url.pathname)) {
      return handleRead(request, env, ctx, url, origin);
    }

    if (url.pathname.startsWith('/admin/')) {
      return handleAdmin(request, env, ctx, url, origin);
    }

    if (url.pathname.startsWith('/submissions/')) {
      return handleSubmissions(request, env, ctx, url, origin);
    }

    return jsonResponse(
      { error: 'not_found', path: url.pathname },
      404,
      env,
      origin,
    );
  },
};
