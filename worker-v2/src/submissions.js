// ════════════════════════════════════════════════════════════════════════
// Public submission endpoints.
//
//   POST /submissions/upload         multipart, one image (≤5MB) for use
//                                    by the org/event/video submission
//                                    forms. Stores under pending/ namespace.
//   POST /submissions/organisation   JSON body, creates a pending org row
//   POST /submissions/event          JSON body, creates a pending event row
//   POST /submissions/video          JSON body, creates a pending video row
//
// Every POST runs the same gauntlet, in this order:
//
//   1. JSON parse                  → 400 invalid_json
//   2. Honeypot field (`hp_email`) → success-shaped 200 (silent drop)
//   3. Turnstile verify            → 400 captcha_failed
//   4. Rate limit (3/IP/hour)      → 429 rate_limited
//   5. Body validation             → 400 invalid_body
//   6. INSERT + audit + notify     → 200 {ok: true, id}
//
// The honeypot precedes Turnstile so spam bots that fill `hp_email`
// don't burn through Cloudflare's verify quota.
// ════════════════════════════════════════════════════════════════════════

import { jsonResponse } from './cors.js';
import { verifyTurnstile } from './turnstile.js';
import { checkAndCount, sweepExpired } from './rate-limit.js';
import { notifySubmission } from './notify.js';
import {
  createOrganisation,
  createEvent,
  createVideo,
  writeAuditEntry,
} from './db.js';

// ── Shared pre-flight (honeypot + Turnstile + rate-limit) ──────────────

async function preflight(request, env, ctx, body, origin) {
  // Silent honeypot — bots fill this hidden field, humans don't.
  if (body && typeof body.hp_email === 'string' && body.hp_email.trim() !== '') {
    // Pretend success; index in DB is never touched. This intentionally
    // looks the same as a real success so the bot doesn't learn to retry.
    return { silentDrop: true };
  }

  const tsResult = await verifyTurnstile(env, request, body && body.turnstile_token);
  if (!tsResult.ok) {
    return {
      resp: jsonResponse(
        { error: 'captcha_failed', error_codes: tsResult.error_codes },
        400, env, origin,
      ),
    };
  }

  const rl = await checkAndCount(env, request);
  sweepExpired(env, ctx);
  if (!rl.ok) {
    return {
      resp: jsonResponse(
        { error: 'rate_limited', retry_after_seconds: rl.retry_after },
        429, env, origin,
      ),
    };
  }

  return { ok: true };
}

// ── Body validators ────────────────────────────────────────────────────

function pickStringOrNull(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s === '' ? null : s;
}

function validateOrgBody(body) {
  const name = pickStringOrNull(body.name);
  if (!name) return { error: 'name_required' };
  return {
    fields: {
      name,
      about:          pickStringOrNull(body.about),
      website:        pickStringOrNull(body.website),
      email_public:   pickStringOrNull(body.email_public),
      email_admin:    pickStringOrNull(body.submitter_email),
      address:        pickStringOrNull(body.address),
      logo_r2_key:    pickStringOrNull(body.logo_r2_key),
      category_types: Array.isArray(body.category_types) ? body.category_types : [],
      age_categories: Array.isArray(body.age_categories) ? body.age_categories : [],
      status:         'pending',
      submitted_via:  'public',
    },
  };
}

function validateEventBody(body) {
  const name = pickStringOrNull(body.name);
  if (!name) return { error: 'name_required' };
  const event_date = pickStringOrNull(body.event_date);
  if (!event_date) return { error: 'event_date_required' };
  return {
    fields: {
      name,
      event_date,
      organisation_id: body.organisation_id != null ? Number(body.organisation_id) : null,
      details:         pickStringOrNull(body.details),
      address:         pickStringOrNull(body.address),
      poster_r2_key:   pickStringOrNull(body.poster_r2_key),
      status:          'pending',
      submitted_via:   'public',
    },
    submitter_email: pickStringOrNull(body.submitter_email),
  };
}

function validateVideoBody(body) {
  const name = pickStringOrNull(body.name);
  if (!name) return { error: 'name_required' };
  const youtube_url  = pickStringOrNull(body.youtube_url);
  const video_r2_key = pickStringOrNull(body.video_r2_key);
  if (!youtube_url && !video_r2_key) return { error: 'youtube_or_file_required' };
  return {
    fields: {
      name,
      description:     pickStringOrNull(body.description),
      youtube_url,
      video_r2_key,
      poster_r2_key:   pickStringOrNull(body.poster_r2_key),
      organisation_id: body.organisation_id != null ? Number(body.organisation_id) : null,
      status:          'pending',
      submitted_via:   'public',
    },
    submitter_email: pickStringOrNull(body.submitter_email),
  };
}

// ── Handler factory ────────────────────────────────────────────────────

function makeSubmissionHandler({ type, validator, creator, entityName }) {
  return async function (request, env, ctx, origin) {
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: 'invalid_json' }, 400, env, origin);
    }

    const pre = await preflight(request, env, ctx, body, origin);
    if (pre.silentDrop) {
      // Lie back a successful-looking response so the bot doesn't retry.
      return jsonResponse({ ok: true, id: null }, 200, env, origin);
    }
    if (pre.resp) return pre.resp;

    const v = validator(body);
    if (v.error) return jsonResponse({ error: v.error }, 400, env, origin);

    let id;
    try {
      id = await creator(env, v.fields);
    } catch (err) {
      return jsonResponse(
        { error: 'create_failed', message: String(err?.message || err) },
        400, env, origin,
      );
    }

    // Audit + notify are post-response work — the submitter doesn't need
    // either to land before we acknowledge their submission. Deferring
    // via ctx.waitUntil cuts ~one D1 round-trip + email API latency off
    // every submission's perceived response time.
    ctx.waitUntil(
      writeAuditEntry(env, {
        actor: 'public', action: 'create', entity: entityName, entity_id: id,
        diff: { after: v.fields },
      }).catch(err => console.warn('audit write failed', err?.message || err)),
    );

    notifySubmission(env, ctx, {
      type,
      id,
      name: v.fields.name,
      submitterEmail: v.submitter_email || v.fields.email_admin || null,
    });

    return jsonResponse({ ok: true, id }, 200, env, origin);
  };
}

const handleOrgSubmission = makeSubmissionHandler({
  type: 'organisation',
  validator: validateOrgBody,
  creator: createOrganisation,
  entityName: 'organisation',
});

const handleEventSubmission = makeSubmissionHandler({
  type: 'event',
  validator: validateEventBody,
  creator: createEvent,
  entityName: 'event',
});

const handleVideoSubmission = makeSubmissionHandler({
  type: 'video',
  validator: validateVideoBody,
  creator: createVideo,
  entityName: 'video',
});

// ── Public image upload (used by the submission forms) ─────────────────
//
// Slightly different from /admin/upload:
//   - No auth (Turnstile-gated instead — token in querystring/form)
//   - Always lands in pending/ namespace; admin moves to permanent on approve
//   - Image only, 5MB cap
//
// We DON'T accept video uploads via this path — at 100MB they're way too
// abusable for a public endpoint. Videos from public submissions can be
// YouTube-only for now.

const PUBLIC_UPLOAD_MIME = {
  'image/jpeg': 'jpg',
  'image/png':  'png',
  'image/webp': 'webp',
  'image/gif':  'gif',
};
const PUBLIC_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

function ymPrefix() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}/${m}`;
}

async function handlePublicUpload(request, env, ctx, origin) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return jsonResponse({ error: 'invalid_multipart' }, 400, env, origin);
  }

  // Turnstile + rate-limit, then file. We construct a tiny pseudo-body
  // so preflight() can read hp_email + turnstile_token off it.
  const pseudoBody = {
    hp_email: form.get('hp_email') || '',
    turnstile_token: form.get('turnstile_token') || '',
  };
  const pre = await preflight(request, env, ctx, pseudoBody, origin);
  if (pre.silentDrop) return jsonResponse({ ok: true, key: null, url: null }, 200, env, origin);
  if (pre.resp) return pre.resp;

  const file = form.get('file');
  if (!file || typeof file === 'string') {
    return jsonResponse({ error: 'missing_file_field' }, 400, env, origin);
  }
  const mime = file.type || 'application/octet-stream';
  const ext  = PUBLIC_UPLOAD_MIME[mime];
  if (!ext) {
    return jsonResponse(
      { error: 'unsupported_type', received: mime, allowed: Object.keys(PUBLIC_UPLOAD_MIME) },
      415, env, origin,
    );
  }
  if (typeof file.size === 'number' && file.size > PUBLIC_UPLOAD_MAX_BYTES) {
    return jsonResponse(
      { error: 'too_large', max_bytes: PUBLIC_UPLOAD_MAX_BYTES, received_bytes: file.size },
      413, env, origin,
    );
  }

  const key = `pending/${ymPrefix()}/${crypto.randomUUID()}.${ext}`;
  try {
    await env.MEDIA.put(key, file.stream(), { httpMetadata: { contentType: mime } });
  } catch (err) {
    return jsonResponse(
      { error: 'upload_failed', message: String(err?.message || err) },
      500, env, origin,
    );
  }

  const base = (env.MEDIA_BASE_URL || '').replace(/\/+$/, '');
  return jsonResponse({ ok: true, key, url: `${base}/${key}` }, 200, env, origin);
}

// ── Router ─────────────────────────────────────────────────────────────

export async function handleSubmissions(request, env, ctx, url, origin) {
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, 405, env, origin);
  }
  switch (url.pathname) {
    case '/submissions/organisation': return handleOrgSubmission(request, env, ctx, origin);
    case '/submissions/event':        return handleEventSubmission(request, env, ctx, origin);
    case '/submissions/video':        return handleVideoSubmission(request, env, ctx, origin);
    case '/submissions/upload':       return handlePublicUpload(request, env, ctx, origin);
    default:
      return jsonResponse({ error: 'not_found', path: url.pathname }, 404, env, origin);
  }
}
