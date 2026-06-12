// ════════════════════════════════════════════════════════════════════════
// Public media route — GET/HEAD /media/<r2-key>
//
// Serves objects straight from the R2 binding. This stands in for the
// media.deafhive.online R2 custom domain, which we can't attach because
// the deafhive.online DNS zone lives in a third party's Cloudflare
// account (R2 custom domains require zone + bucket in the same account).
// If the zone ever moves into this account, flip MEDIA_BASE_URL back to
// the custom domain and this route simply stops being referenced.
//
// Behaviour notes:
// - Keys are immutable: every upload generates a fresh uuid key, so
//   responses are cached forever (max-age=1y, immutable) at the edge
//   and in browsers. Deletes never need a purge — the key is simply
//   never referenced again.
// - Range requests are honoured (single range) because the bucket holds
//   videos and <video> seeking needs 206 responses. Partial responses
//   are NOT edge-cached; only full 200 GETs are.
// - Public by design — same exposure as the R2 custom domain would have
//   had. No origin allowlist: <img>/<video> tags don't send CORS
//   preflights, and the assets are public anyway.
// - X-Content-Type-Options: nosniff + the upload-time MIME allowlist
//   (images.js) together prevent the bucket being used to host HTML.
// ════════════════════════════════════════════════════════════════════════

const MAX_KEY_LENGTH = 512;

function mediaNotFound() {
  return new Response(JSON.stringify({ error: 'not_found' }), {
    status: 404,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      // Negative results are not edge-cached, but tell browsers not to
      // hammer either — a missing key stays missing.
      'Cache-Control': 'public, max-age=60',
    },
  });
}

function baseHeaders(obj) {
  const headers = new Headers();
  // Restores Content-Type (and any other HTTP metadata) captured at
  // upload time by R2.
  obj.writeHttpMetadata(headers);
  if (!headers.get('Content-Type')) {
    headers.set('Content-Type', 'application/octet-stream');
  }
  headers.set('ETag', obj.httpEtag);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('X-Content-Type-Options', 'nosniff');
  return headers;
}

// R2 returns the satisfied range as {offset,length} or {suffix}; normalise
// to absolute offset + length against the full object size.
function normaliseRange(range, size) {
  if (range.suffix != null) {
    const length = Math.min(range.suffix, size);
    return { offset: size - length, length };
  }
  const offset = range.offset ?? 0;
  const length = range.length ?? size - offset;
  return { offset, length };
}

export async function handleMedia(request, env, ctx, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { 'Allow': 'GET, HEAD' } });
  }

  let key;
  try {
    key = decodeURIComponent(url.pathname.slice('/media/'.length));
  } catch {
    return mediaNotFound();
  }
  if (!key || key.length > MAX_KEY_LENGTH || key.includes('\0')) {
    return mediaNotFound();
  }

  // HEAD — metadata only, no body fetch from R2.
  if (request.method === 'HEAD') {
    const head = await env.MEDIA.head(key);
    if (!head) return mediaNotFound();
    const headers = baseHeaders(head);
    headers.set('Content-Length', String(head.size));
    return new Response(null, { status: 200, headers });
  }

  const rangeHeader = request.headers.get('Range');

  // Edge cache — full responses only. Keyed on bare URL (no query).
  // Conditional requests must be honoured here too: cache.match() returns
  // the stored 200 as-is, so without this check a revalidating client
  // would always be sent the full body once the edge is warm.
  const cacheKey = new Request(`${url.origin}${url.pathname}`, { method: 'GET' });
  const inm = request.headers.get('If-None-Match');
  if (!rangeHeader) {
    const hit = await caches.default.match(cacheKey);
    if (hit) {
      if (inm && inm === hit.headers.get('ETag')) {
        return new Response(null, { status: 304, headers: hit.headers });
      }
      return hit;
    }
  }

  let obj;
  try {
    obj = rangeHeader
      ? await env.MEDIA.get(key, { range: request.headers })
      : await env.MEDIA.get(key);
  } catch {
    // R2 throws on an unsatisfiable/malformed Range rather than ignoring it.
    return new Response(null, { status: 416, headers: { 'Access-Control-Allow-Origin': '*' } });
  }
  if (!obj) return mediaNotFound();

  const headers = baseHeaders(obj);

  // Conditional GET — immutable keys mean a matching ETag is always current.
  if (inm && inm === obj.httpEtag) {
    return new Response(null, { status: 304, headers });
  }

  if (rangeHeader && obj.range) {
    const { offset, length } = normaliseRange(obj.range, obj.size);
    headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    headers.set('Content-Length', String(length));
    return new Response(obj.body, { status: 206, headers });
  }

  headers.set('Content-Length', String(obj.size));
  const resp = new Response(obj.body, { status: 200, headers });
  ctx.waitUntil(caches.default.put(cacheKey, resp.clone()));
  return resp;
}
