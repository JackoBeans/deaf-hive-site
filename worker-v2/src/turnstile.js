// ════════════════════════════════════════════════════════════════════════
// Cloudflare Turnstile — server-side token verification.
//
// The client embeds the Turnstile widget on the form page; on user
// interaction it produces a single-use token. We post it to Cloudflare
// along with TURNSTILE_SECRET and the client IP for binding. Cloudflare
// returns {success, error-codes, ...}. We only treat success: true as ok.
//
// Docs:
//   https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
//
// Failure modes we care about and pass through to the client:
//   - timeout-or-duplicate    user submitted the same token twice
//   - invalid-input-response  token is malformed / missing
//   - invalid-input-secret    we sent the wrong secret (server misconfig)
// ════════════════════════════════════════════════════════════════════════

const SITE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// Returns { ok: true } or { ok: false, error_codes: [...] }.
export async function verifyTurnstile(env, request, token) {
  if (!env.TURNSTILE_SECRET) {
    return { ok: false, error_codes: ['server_misconfig:turnstile_secret_missing'] };
  }
  if (!token || typeof token !== 'string') {
    return { ok: false, error_codes: ['missing-input-response'] };
  }

  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token);
  const ip = request.headers.get('cf-connecting-ip');
  if (ip) form.append('remoteip', ip);

  let res;
  try {
    res = await fetch(SITE_VERIFY_URL, { method: 'POST', body: form });
  } catch (err) {
    return { ok: false, error_codes: ['network', String(err?.message || err)] };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return { ok: false, error_codes: ['non_json_response'] };
  }

  if (data.success === true) return { ok: true };
  return { ok: false, error_codes: data['error-codes'] || ['unknown_failure'] };
}
