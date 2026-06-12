// ════════════════════════════════════════════════════════════════════════
// Session tokens + password hashing for multi-user admin login.
//
// Token format:  u<user_id>.<expires_epoch_seconds>.<base64url(hmac)>
//
// Issuance: POST /admin/login looks up the user by email, verifies their
// PBKDF2-hashed password, then issues a token signed with
// env.ADMIN_TOKEN_SECRET, valid for 30 days. The token carries only the
// numeric user_id; the rest (role, status, display_name) is loaded fresh
// from D1 on every admin request so role/status changes take effect
// immediately on the next click.
//
// Verification: bearer header on every /admin/* endpoint goes through
// verifyToken() — checks format, signature, expiry. The caller (admin.js
// requireAuth) then loads the user row and rejects if missing/disabled.
//
// Password hashing: PBKDF2-SHA256 via Web Crypto (Workers native).
// 100k iterations, 16-byte random salt, 32-byte derived key. Stored as
// '<iterations>.<base64url salt>.<base64url hash>' so the algorithm can
// be upgraded later by rewriting on next successful login.
// ════════════════════════════════════════════════════════════════════════

const TOKEN_TTL_SECONDS  = 30 * 24 * 60 * 60; // 30 days
const PBKDF2_ITERATIONS  = 100_000;
const PBKDF2_SALT_BYTES  = 16;
const PBKDF2_HASH_BYTES  = 32;

// ── Base64url helpers ──────────────────────────────────────────────────

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

// ── Constant-time byte equality ────────────────────────────────────────

function timingSafeEqualBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ── HMAC-SHA256 (for session tokens) ───────────────────────────────────

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

// ── PBKDF2-SHA256 password hashing ─────────────────────────────────────

async function pbkdf2(passwordBytes, salt, iterations, hashBytes) {
  const baseKey = await crypto.subtle.importKey(
    'raw', passwordBytes, { name: 'PBKDF2' }, false, ['deriveBits'],
  );
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    baseKey,
    hashBytes * 8,
  );
  return new Uint8Array(derived);
}

// hashPassword(plaintext) → 'iterations.salt_b64url.hash_b64url'
export async function hashPassword(plain) {
  if (typeof plain !== 'string' || plain.length === 0) {
    throw new Error('password must be a non-empty string');
  }
  const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
  const hash = await pbkdf2(
    new TextEncoder().encode(plain),
    salt,
    PBKDF2_ITERATIONS,
    PBKDF2_HASH_BYTES,
  );
  return `${PBKDF2_ITERATIONS}.${bytesToBase64Url(salt)}.${bytesToBase64Url(hash)}`;
}

// verifyPasswordHash(plaintext, stored) → boolean (timing-safe).
// Even when the stored hash is malformed or the plaintext is empty, we
// still run a dummy PBKDF2 round so a network observer can't distinguish
// "user not found / hash invalid" from "user found, wrong password" by
// response timing.
export async function verifyPasswordHash(plain, stored) {
  const fallbackOk = async () => {
    // Burn some CPU to match the cost of a real verify.
    await pbkdf2(new TextEncoder().encode('x'), new Uint8Array(PBKDF2_SALT_BYTES), PBKDF2_ITERATIONS, PBKDF2_HASH_BYTES);
    return false;
  };
  if (typeof plain !== 'string' || typeof stored !== 'string') return fallbackOk();

  const parts = stored.split('.');
  if (parts.length !== 3) return fallbackOk();
  const iterations = Number(parts[0]);
  if (!Number.isInteger(iterations) || iterations < 1000 || iterations > 10_000_000) return fallbackOk();

  let salt, expectedHash;
  try {
    salt = base64UrlToBytes(parts[1]);
    expectedHash = base64UrlToBytes(parts[2]);
  } catch {
    return fallbackOk();
  }
  if (salt.length === 0 || expectedHash.length === 0) return fallbackOk();

  const actualHash = await pbkdf2(
    new TextEncoder().encode(plain),
    salt,
    iterations,
    expectedHash.length,
  );
  return timingSafeEqualBytes(actualHash, expectedHash);
}

// ── Session tokens ─────────────────────────────────────────────────────

// Token payload: `u<user_id>.<expires>` — the 'u' prefix lets future
// formats (service tokens, scoped tokens) coexist without collision.

export async function issueToken(env, userId) {
  if (!env.ADMIN_TOKEN_SECRET) {
    throw new Error('ADMIN_TOKEN_SECRET is not configured');
  }
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error('issueToken requires a positive integer user_id');
  }
  const expires = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const payload = `u${userId}.${expires}`;
  const sig = await hmacSign(env.ADMIN_TOKEN_SECRET, payload);
  return `${payload}.${bytesToBase64Url(sig)}`;
}

export async function verifyToken(env, token) {
  if (!env.ADMIN_TOKEN_SECRET) return { ok: false, error: 'auth_not_configured' };
  if (typeof token !== 'string') return { ok: false, error: 'no_token' };

  const lastDot = token.lastIndexOf('.');
  if (lastDot < 0) return { ok: false, error: 'malformed_token' };

  const payload = token.slice(0, lastDot);     // "u<id>.<expires>"
  const sigB64  = token.slice(lastDot + 1);

  // Parse `u<id>.<expires>` strictly.
  const firstDot = payload.indexOf('.');
  if (firstDot < 0) return { ok: false, error: 'malformed_token' };
  const idPart = payload.slice(0, firstDot);
  if (idPart.length < 2 || idPart[0] !== 'u') return { ok: false, error: 'malformed_token' };
  const userId = Number(idPart.slice(1));
  const expires = Number(payload.slice(firstDot + 1));
  if (!Number.isInteger(userId) || userId <= 0) return { ok: false, error: 'malformed_token' };
  if (!Number.isInteger(expires) || expires <= 0) return { ok: false, error: 'malformed_token' };

  // Signature check FIRST, then expiry — keeps the constant-time
  // property between "wrong sig" and "expired".
  let expected, provided;
  try {
    expected = await hmacSign(env.ADMIN_TOKEN_SECRET, payload);
  } catch {
    return { ok: false, error: 'signing_failed' };
  }
  try {
    provided = base64UrlToBytes(sigB64);
  } catch {
    return { ok: false, error: 'malformed_signature' };
  }
  if (!timingSafeEqualBytes(expected, provided)) return { ok: false, error: 'bad_signature' };
  if (Math.floor(Date.now() / 1000) >= expires) return { ok: false, error: 'expired' };

  return { ok: true, user_id: userId, expires };
}

// ── Password-reset tokens ──────────────────────────────────────────────
// Raw token is 32 random bytes, base64url — returned to the caller
// ONCE (in the reset URL or via the owner-create endpoint) and never
// stored. We store SHA-256 of the raw token; on consumption we hash
// the URL token and look up by hash.

const RESET_TOKEN_BYTES = 32;
export const RESET_TTL_FORGOT_SECONDS  = 60 * 60;          // 1 hour
export const RESET_TTL_OWNER_SECONDS   = 24 * 60 * 60;     // 24 hours

export function generateResetToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(RESET_TOKEN_BYTES));
  return bytesToBase64Url(bytes);
}

export async function hashResetToken(rawToken) {
  if (typeof rawToken !== 'string' || rawToken === '') return '';
  const bytes = new TextEncoder().encode(rawToken);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function bearerFromRequest(request) {
  const h = request.headers.get('Authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}
