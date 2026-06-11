// ════════════════════════════════════════════════════════════════════════
// R2 upload + delete.
//
//   POST   /admin/upload         multipart with one file field
//   DELETE /admin/upload/<key>   (key is base64url-encoded by the client)
//
// Content-type drives the destination prefix and the size cap:
//
//   image/*  →  orgs/2026/06/<uuid>.<ext>     ≤ 5 MB
//   video/*  →  videos/2026/06/<uuid>.<ext>   ≤ 100 MB
//
// We keep an explicit MIME allowlist so callers can't smuggle e.g.
// text/html into R2 to host a phishing page from media.deafhive.online.
// ════════════════════════════════════════════════════════════════════════

import { jsonResponse } from './cors.js';
import { bearerFromRequest, verifyToken } from './auth.js';

const IMAGE_MIME_MAP = {
  'image/jpeg': 'jpg',
  'image/png':  'png',
  'image/webp': 'webp',
  'image/gif':  'gif',
  'image/svg+xml': 'svg',
};

const VIDEO_MIME_MAP = {
  'video/mp4':       'mp4',
  'video/webm':      'webm',
  'video/quicktime': 'mov',
};

const MAX_IMAGE_BYTES = 5  * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

// ── Auth gate (same as admin.js but local — keeps admin.js skinny) ──

async function requireAdmin(request, env, origin) {
  const token = bearerFromRequest(request);
  if (!token) return jsonResponse({ error: 'unauthorised' }, 401, env, origin);
  const r = await verifyToken(env, token);
  if (!r.ok) return jsonResponse({ error: r.error || 'unauthorised' }, 401, env, origin);
  return null;
}

// ── Key generation ────────────────────────────────────────────────────

// Date.now() in Workers — fine here (this is not a sandboxed workflow).
function ymPrefix() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}/${m}`;
}

function uuid() {
  return crypto.randomUUID();
}

function r2KeyFor(folder, ext) {
  return `${folder}/${ymPrefix()}/${uuid()}.${ext}`;
}

function urlFor(env, key) {
  const base = (env.MEDIA_BASE_URL || '').replace(/\/+$/, '');
  return `${base}/${key}`;
}

// ── POST /admin/upload ────────────────────────────────────────────────

export async function handleUpload(request, env, origin) {
  const authErr = await requireAdmin(request, env, origin);
  if (authErr) return authErr;

  let form;
  try {
    form = await request.formData();
  } catch {
    return jsonResponse({ error: 'invalid_multipart' }, 400, env, origin);
  }

  const file = form.get('file');
  if (!file || typeof file === 'string') {
    return jsonResponse({ error: 'missing_file_field' }, 400, env, origin);
  }

  const mime = file.type || 'application/octet-stream';
  const ext  = IMAGE_MIME_MAP[mime] || VIDEO_MIME_MAP[mime];
  if (!ext) {
    return jsonResponse(
      { error: 'unsupported_type', received: mime, allowed: [...Object.keys(IMAGE_MIME_MAP), ...Object.keys(VIDEO_MIME_MAP)] },
      415, env, origin,
    );
  }

  const isImage = mime in IMAGE_MIME_MAP;
  const cap     = isImage ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
  if (typeof file.size === 'number' && file.size > cap) {
    return jsonResponse(
      { error: 'too_large', max_bytes: cap, received_bytes: file.size },
      413, env, origin,
    );
  }

  // Optional "folder hint" lets the caller override the default prefix
  // (e.g. an event poster goes under events/ even though it's image/*).
  const folderHint = form.get('folder');
  const folder = (() => {
    if (folderHint === 'orgs' || folderHint === 'events' || folderHint === 'videos') {
      return folderHint;
    }
    return isImage ? 'orgs' : 'videos';
  })();

  const key = r2KeyFor(folder, ext);
  try {
    await env.MEDIA.put(key, file.stream(), {
      httpMetadata: { contentType: mime },
    });
  } catch (err) {
    return jsonResponse(
      { error: 'upload_failed', message: String(err?.message || err) },
      500, env, origin,
    );
  }

  return jsonResponse(
    { ok: true, key, url: urlFor(env, key), content_type: mime },
    200, env, origin,
  );
}

// ── DELETE /admin/upload/<key> ────────────────────────────────────────
// Key is URL-encoded by the client (since it contains slashes).

export async function handleUploadDelete(request, env, url, origin) {
  const authErr = await requireAdmin(request, env, origin);
  if (authErr) return authErr;

  const raw = url.pathname.slice('/admin/upload/'.length);
  const key = decodeURIComponent(raw);
  if (!key || key.includes('..')) {
    return jsonResponse({ error: 'invalid_key' }, 400, env, origin);
  }
  try {
    await env.MEDIA.delete(key);
  } catch (err) {
    return jsonResponse(
      { error: 'delete_failed', message: String(err?.message || err) },
      500, env, origin,
    );
  }
  return jsonResponse({ ok: true, key }, 200, env, origin);
}
