// ════════════════════════════════════════════════════════════════════════
// HMAC-SHA256 session tokens.
//
// Token format:  admin.<expires_epoch_seconds>.<base64url(hmac)>
//
// Issuance: POST /admin/login validates the supplied password against
// env.ADMIN_PASSWORD (constant-time), then issues a token signed with
// env.ADMIN_TOKEN_SECRET, valid for 30 days.
//
// Verification: bearer header on every /admin/* endpoint goes through
// verifyToken() — checks format, signature, and expiry. Returns
// { ok: true, actor, expires } on success or { ok: false, error } on
// any failure (constant-time signature check so timing doesn't leak).
//
// Why HMAC (vs JWT)? No third-party dependency, no JSON to parse, no
// algorithm-negotiation footgun. The signed payload is so small (just
// "admin.<epoch>") that we don't need a structured token format.
// ════════════════════════════════════════════════════════════════════════

const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

// ── Base64url helpers (Workers don't ship a built-in) ──

function bytesToBase64Url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ── Constant-time byte/string equality ──
// Branchless XOR-or-accumulate. Same length is checked separately
// because returning early on length mismatch IS a timing oracle for
// length, but length isn't a secret here — it's the same for every
// valid token, so a length mismatch always means "tampered".

function timingSafeEqualBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function timingSafeEqualStrings(a, b) {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  return timingSafeEqualBytes(ea, eb);
}

// ── HMAC-SHA256 ──

async function importHmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

async function hmacSign(secret, payload) {
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return new Uint8Array(sig);
}

// ── Public API ──

export async function verifyPassword(env, supplied) {
  if (!env.ADMIN_PASSWORD) return false;
  if (typeof supplied !== 'string') return false;
  return timingSafeEqualStrings(supplied, env.ADMIN_PASSWORD);
}

export async function issueToken(env, actor = 'admin') {
  if (!env.ADMIN_TOKEN_SECRET) {
    throw new Error('ADMIN_TOKEN_SECRET is not configured');
  }
  const expires = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const payload = `${actor}.${expires}`;
  const sig = await hmacSign(env.ADMIN_TOKEN_SECRET, payload);
  return `${payload}.${bytesToBase64Url(sig)}`;
}

export async function verifyToken(env, token) {
  if (!env.ADMIN_TOKEN_SECRET) return { ok: false, error: 'auth_not_configured' };
  if (typeof token !== 'string') return { ok: false, error: 'no_token' };

  const lastDot = token.lastIndexOf('.');
  if (lastDot < 0) return { ok: false, error: 'malformed_token' };

  const payload = token.slice(0, lastDot);     // "admin.<expires>"
  const sigB64  = token.slice(lastDot + 1);    // "<base64url>"

  // Parse payload — strict shape, no whitespace allowed.
  const firstDot = payload.indexOf('.');
  if (firstDot < 0) return { ok: false, error: 'malformed_token' };
  const actor   = payload.slice(0, firstDot);
  const expires = Number(payload.slice(firstDot + 1));
  if (!Number.isInteger(expires) || expires <= 0) {
    return { ok: false, error: 'malformed_token' };
  }

  // Always run the HMAC compare before checking expiry — preserves
  // constant-time properties so an attacker can't distinguish
  // "expired" from "bad signature" by timing.
  let expected;
  try {
    expected = await hmacSign(env.ADMIN_TOKEN_SECRET, payload);
  } catch {
    return { ok: false, error: 'signing_failed' };
  }
  let provided;
  try {
    provided = base64UrlToBytes(sigB64);
  } catch {
    return { ok: false, error: 'malformed_signature' };
  }
  const sigOk = timingSafeEqualBytes(expected, provided);

  if (!sigOk) return { ok: false, error: 'bad_signature' };
  if (Math.floor(Date.now() / 1000) >= expires) {
    return { ok: false, error: 'expired' };
  }

  return { ok: true, actor, expires };
}

// Convenience: pull bearer token off the Authorization header.
export function bearerFromRequest(request) {
  const h = request.headers.get('Authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}
