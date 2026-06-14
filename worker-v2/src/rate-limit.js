// ════════════════════════════════════════════════════════════════════════
// IP-bucket rate limiter, persisted in D1 (submission_quota table).
//
// 3 submissions per IP per rolling 1-hour window.
//
// The IP is SHA-256-hashed before storage so we never persist PII — the
// hash is one-way and Cloudflare strips IPs from logs by default. The
// salt-via-HMAC pattern isn't worth it here: the input space is small
// (~4 billion IPv4s + a lot of IPv6s) and the only attack is "given the
// hash, recover the IP", which Cloudflare can already do upstream.
//
// Concurrency note: D1 is serialised per-database, so the read-then-
// write here can race against itself only at very high RPS — for a
// hobby community site, the worst-case is "an attacker sneaks one
// extra submission past the cap", which is fine.
// ════════════════════════════════════════════════════════════════════════

const WINDOW_SECONDS = 60 * 60;   // 1 hour
const MAX_PER_WINDOW = 3;

// Admin auth endpoints (login / forgot / reset) get their OWN bucket:
// tighter window, higher cap. 10 attempts / 15 min / IP is generous for a
// human fumbling a password but throttles online brute-force. Stored in the
// same submission_quota table under a namespaced ('auth:') hash key, so no
// schema change is needed and it never shares a counter with submissions.
const AUTH_WINDOW_SECONDS = 15 * 60;  // 15 minutes
const AUTH_MAX_PER_WINDOW = 10;

async function sha256Hex(s) {
  const bytes = new TextEncoder().encode(s);
  const hash  = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function clientIp(request) {
  // Cloudflare always sets this; fall back to a constant if testing
  // locally with `wrangler dev` so the hash is at least stable.
  return request.headers.get('cf-connecting-ip') || '0.0.0.0';
}

const NOW = () => Math.floor(Date.now() / 1000);

// Core IP-bucket check against submission_quota. `key` is an already-hashed,
// namespaced bucket id. Returns { ok: true } (and increments the counter)
// while under the cap, or { ok: false, retry_after } once the cap is reached.
async function checkBucket(env, key, maxPerWindow, windowSeconds) {
  const now = NOW();

  const row = await env.DB
    .prepare('SELECT count, window_start FROM submission_quota WHERE ip_hash = ?')
    .bind(key).first();

  // Fresh window if nothing exists OR previous window expired.
  if (!row || (now - row.window_start) >= windowSeconds) {
    await env.DB
      .prepare(
        `INSERT INTO submission_quota (ip_hash, count, window_start)
         VALUES (?, 1, ?)
         ON CONFLICT(ip_hash) DO UPDATE
           SET count = 1, window_start = excluded.window_start`,
      )
      .bind(key, now).run();
    return { ok: true };
  }

  // Same window — check the cap before counting.
  if (row.count >= maxPerWindow) {
    return { ok: false, retry_after: windowSeconds - (now - row.window_start) };
  }

  await env.DB
    .prepare('UPDATE submission_quota SET count = count + 1 WHERE ip_hash = ?')
    .bind(key).run();
  return { ok: true };
}

// Public submissions: 3 / IP / hour. Returns { ok } or { ok:false, retry_after }.
export async function checkAndCount(env, request) {
  const ipHash = await sha256Hex(clientIp(request));
  return checkBucket(env, ipHash, MAX_PER_WINDOW, WINDOW_SECONDS);
}

// Admin auth (login / forgot-password / reset-password): 10 / IP / 15 min.
// The 'auth:' prefix namespaces the hash so this shares the table without
// ever sharing a counter with the public submission limiter above.
export async function checkAuthRateLimit(env, request) {
  const key = await sha256Hex('auth:' + clientIp(request));
  return checkBucket(env, key, AUTH_MAX_PER_WINDOW, AUTH_WINDOW_SECONDS);
}

// Periodic janitor — purges rows whose window has expired. Cheap to
// call from inside any submission handler (uses waitUntil) so the
// table doesn't grow unbounded. Skipped at random to spread load.
export function sweepExpired(env, ctx) {
  // 1-in-20 sample so we only sweep occasionally without using
  // Math.random in scripts that run in the strict workflow runtime.
  // (Workers `fetch()` is not scoped, so Math.random IS available here.)
  if (Math.random() > 0.05) return;
  const cutoff = NOW() - WINDOW_SECONDS;
  ctx.waitUntil(
    env.DB
      .prepare('DELETE FROM submission_quota WHERE window_start < ?')
      .bind(cutoff).run().catch(() => {}),
  );
}
