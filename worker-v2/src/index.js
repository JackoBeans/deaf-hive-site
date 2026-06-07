// ════════════════════════════════════════════════════════════════════════
// DeafHive worker-v2 — Phase 0 hello-world router
//
// This is a SCAFFOLD. It exposes just enough to prove the D1 + R2 bindings
// are wired correctly:
//
//   GET /healthz          → { ok: true, version: '0.1.0-phase0' }
//   GET /probe-bindings   → { db: <D1 ping result>, r2: <R2 ping result> }
//
// Real endpoints (/organisations, /events, /videos, /admin/*, /submissions/*)
// land in Phase 1 onwards. See docs/REBUILD_PLAN.md for the full route table.
// ════════════════════════════════════════════════════════════════════════

const VERSION = '0.1.0-phase0';

// ── Tiny CORS helper (full implementation lifts from worker/src/index.js in Phase 1) ──
function corsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const origin = request.headers.get('Origin');
  const ok = origin && allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : 'null',
    'Vary': 'Origin',
  };
}

function json(data, init, request, env) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    ...corsHeaders(request, env),
    ...(init?.headers || {}),
  };
  return new Response(JSON.stringify(data, null, 2), { ...init, headers });
}

// ── Route handlers ──────────────────────────────────────────────────────

async function handleHealthz(request, env) {
  return json({ ok: true, version: VERSION }, { status: 200 }, request, env);
}

async function handleProbeBindings(request, env) {
  // D1 probe: run a trivial query that doesn't depend on any table existing
  let dbResult;
  try {
    const row = await env.DB.prepare('SELECT 1 AS one').first();
    dbResult = { ok: true, returned: row };
  } catch (err) {
    dbResult = { ok: false, error: String(err?.message || err) };
  }

  // R2 probe: list with a small cap. Doesn't require any objects to exist.
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
  return json(
    {
      ok: allOk,
      version: VERSION,
      db: dbResult,
      r2: r2Result,
      media_base_url: env.MEDIA_BASE_URL || null,
    },
    { status: allOk ? 200 : 503 },
    request,
    env,
  );
}

// ── Router ──────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders(request, env),
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Purge-Token',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    if (request.method === 'GET' && url.pathname === '/healthz') {
      return handleHealthz(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/probe-bindings') {
      return handleProbeBindings(request, env);
    }

    return json(
      { error: 'not_found', path: url.pathname, hint: 'Phase 0 scaffold — only /healthz and /probe-bindings exist yet.' },
      { status: 404 },
      request,
      env,
    );
  },
};
