// ════════════════════════════════════════════════════════════════════════
// CORS — origin allowlist + preflight handling
//
// Allowlist comes from env.ALLOWED_ORIGINS (comma-separated). Cached
// responses are stored WITHOUT an origin-specific Allow-Origin header,
// then re-stamped by withCors() on the way out — this way a single cache
// entry serves any allowed origin without per-origin cache fragmentation.
// ════════════════════════════════════════════════════════════════════════

function allowedOrigins(env) {
  return (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

export function isAllowedOrigin(env, origin) {
  return !!origin && allowedOrigins(env).includes(origin);
}

export function corsHeaders(env, origin) {
  const headers = { 'Vary': 'Origin' };
  if (isAllowedOrigin(env, origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

export function preflightResponse(env, origin) {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(env, origin),
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Purge-Token',
      'Access-Control-Max-Age': '86400',
    },
  });
}

export function withCors(response, env, origin) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders(env, origin))) {
    headers.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// Shared "parse request as JSON or return a 400" helper. Used at every
// endpoint that accepts a JSON body. Returns either { body } on success
// or { resp } with a pre-built 400 response on parse failure.
export async function readJsonBody(request, env, origin) {
  try {
    const body = await request.json();
    return { body };
  } catch {
    return { resp: jsonResponse({ error: 'invalid_json' }, 400, env, origin) };
  }
}

export function jsonResponse(payload, status, env, origin, extraHeaders) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(env, origin),
      ...(extraHeaders || {}),
    },
  });
}
