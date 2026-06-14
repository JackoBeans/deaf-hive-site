// ════════════════════════════════════════════════════════════════════════
// Resend — outbound email (submission notifications + password resets).
//
// Reads:
//   RESEND_API_KEY      — starts with "re_..."
//   NOTIFY_RECIPIENTS   — comma-separated list, used by notifySubmission
//   MAIL_FROM           — optional sender override (see DEFAULT_FROM)
//
// From address defaults to `onboarding@resend.dev` — Resend's free-tier
// sender, which works with NO DNS verification but only delivers to the
// Resend account owner's own address. Once a sending domain is verified
// in Resend, set the MAIL_FROM secret to e.g.
// `DeafHive <notifications@deafhive.online>` and sends reach anyone —
// no code change or redeploy needed (secrets apply immediately).
//
// All sends are fire-and-forget via ctx.waitUntil. Send failures log +
// swallow — the calling flow (a submission or a reset) must not break
// because email is slow/down.
// ════════════════════════════════════════════════════════════════════════

const RESEND_URL = 'https://api.resend.com/emails';
const DEFAULT_FROM = 'DeafHive <onboarding@resend.dev>';
const PUBLIC_SITE = 'https://deafhive.online';

const TAB_FOR = {
  organisation: 'organisations',
  event:        'events',
  video:        'videos',
};

function recipients(env) {
  return (env.NOTIFY_RECIPIENTS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

// Shared fire-and-forget sender. Logs failures with a caller-chosen
// tag so notify-vs-reset errors stay distinguishable in Worker logs.
function sendEmail(env, ctx, { to, subject, text, logTag }) {
  if (!env.RESEND_API_KEY) {
    console.warn(`${logTag}: skipped — RESEND_API_KEY not set`);
    return;
  }
  if (!Array.isArray(to) || to.length === 0) {
    console.warn(`${logTag}: skipped — no recipients`);
    return;
  }
  const send = async () => {
    try {
      const res = await fetch(RESEND_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({ from: env.MAIL_FROM || DEFAULT_FROM, to, subject, text }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        console.warn(`${logTag}: Resend ${res.status} — ${detail.slice(0, 240)}`);
      }
    } catch (err) {
      console.warn(`${logTag}: send failed`, err?.message || err);
    }
  };
  ctx.waitUntil(send());
}

// ── Password reset email ───────────────────────────────────────────────

export function notifyPasswordReset(env, ctx, { toEmail, resetUrl, expiresAt }) {
  if (!toEmail || !resetUrl) {
    console.warn('reset email: skipped — missing toEmail or resetUrl');
    return;
  }
  const expiresMins = expiresAt
    ? Math.max(1, Math.round((expiresAt - Math.floor(Date.now() / 1000)) / 60))
    : 60;
  const subject = 'DeafHive — reset your password';
  const text = [
    'Someone (hopefully you) asked to reset the password for this DeafHive admin account.',
    '',
    `Reset link: ${resetUrl}`,
    '',
    `This link expires in about ${expiresMins} minute${expiresMins === 1 ? '' : 's'} and can only be used once.`,
    '',
    `If you didn't request this, you can safely ignore this email — your existing password is unchanged.`,
  ].join('\n');
  sendEmail(env, ctx, { to: [toEmail], subject, text, logTag: 'reset email' });
}

// ── Submission notification email ──────────────────────────────────────
// type ∈ {'organisation','event','video'}

export function notifySubmission(env, ctx, { type, id, name, submitterEmail }) {
  const tab = TAB_FOR[type] || 'organisations';
  const link = `${PUBLIC_SITE}/admin/?tab=${tab}&focus=${id}`;
  const subject = `DeafHive — new ${type} submission awaiting review`;
  const text = [
    `A new ${type} ("${name || '(untitled)'}") has been submitted via deafhive.online/submit.`,
    '',
    submitterEmail ? `Submitter email: ${submitterEmail}` : '(no submitter email provided)',
    '',
    `Review: ${link}`,
  ].join('\n');
  sendEmail(env, ctx, { to: recipients(env), subject, text, logTag: 'notify' });
}
