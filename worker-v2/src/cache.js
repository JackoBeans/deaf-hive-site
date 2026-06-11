// ════════════════════════════════════════════════════════════════════════
// Edge cache helpers — wraps the Cloudflare Cache API.
//
// Cache keys are the bare URL with no Origin header, so a single entry
// serves any allowed origin. CORS headers are applied AFTER reading from
// cache via cors.withCors().
//
// TTL comes from env.CACHE_TTL_SECONDS (default 3600 if unset).
// ════════════════════════════════════════════════════════════════════════

const DEFAULT_TTL = 3600;

function ttl(env) {
  const n = Number(env.CACHE_TTL_SECONDS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL;
}

function cacheKeyFor(url) {
  // Strip query string from the key so cache-busting params don't fragment.
  // Phase 1 endpoints take no query params, so this is forward-looking only.
  const u = new URL(url);
  return new Request(`${u.origin}${u.pathname}`, { method: 'GET' });
}

export async function cacheGet(url) {
  return caches.default.match(cacheKeyFor(url));
}

export async function cachePut(ctx, url, response, env) {
  // Clone first — Response bodies are one-shot streams; the caller still
  // needs the original to return to the client.
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', `public, max-age=${ttl(env)}`);
  const toCache = new Response(response.clone().body, {
    status: response.status,
    headers,
  });
  ctx.waitUntil(caches.default.put(cacheKeyFor(url), toCache));
}

export async function cachePurge(originUrl, paths) {
  const purged = [];
  for (const path of paths) {
    const key = new Request(`${originUrl}${path}`, { method: 'GET' });
    const deleted = await caches.default.delete(key);
    if (deleted) purged.push(path);
  }
  return purged;
}
