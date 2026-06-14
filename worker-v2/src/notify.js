// ════════════════════════════════════════════════════════════════════════
// Brevo — outbound email (submission notifications + password resets).
//
// Reads:
//   BREVO_API_KEY       — Brevo SMTP API key (starts with "xkeysib-...")
//   NOTIFY_RECIPIENTS   — comma-separated list, used by notifySubmission
//   MAIL_FROM           — sender, as "Name <email>" or "email" (see below)
//
// Brevo has no universal free sender — the MAIL_FROM address must be a
// VERIFIED sender (or on a verified domain) in the Brevo dashboard, or
// the send is rejected. The single-sender route needs no DNS: verify one
// address by clicking the link Brevo emails to it, then send from it to
// anyone. To change the sender later, verify the new address/domain in
// Brevo and update the MAIL_FROM secret — no code change or redeploy
// (secrets apply immediately). DEFAULT_FROM is the planned first sender
// so it works out of the box once that address is verified.
//
// All sends are fire-and-forget via ctx.waitUntil. Send failures log +
// swallow — the calling flow (a submission or a reset) must not break
// because email is slow/down.
// ════════════════════════════════════════════════════════════════════════

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';
const DEFAULT_FROM = 'DeafHive <mail@markschofield.org>';
const PUBLIC_SITE = 'https://deafhive.online';

// Parse "Name <email>" or a bare "email" into Brevo's {name, email} shape.
function parseSender(from) {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from || '');
  if (m) return { name: m[1] || 'DeafHive', email: m[2].trim() };
  return { name: 'DeafHive', email: (from || '').trim() };
}

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
  if (!env.BREVO_API_KEY) {
    console.warn(`${logTag}: skipped — BREVO_API_KEY not set`);
    return;
  }
  if (!Array.isArray(to) || to.length === 0) {
    console.warn(`${logTag}: skipped — no recipients`);
    return;
  }
  const send = async () => {
    try {
      const res = await fetch(BREVO_URL, {
        method: 'POST',
        headers: {
          'api-key':       env.BREVO_API_KEY,
          'Content-Type':  'application/json',
          'accept':        'application/json',
        },
        body: JSON.stringify({
          sender:      parseSender(env.MAIL_FROM || DEFAULT_FROM),
          to:          to.map(email => ({ email })),
          subject,
          textContent: text,
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        console.warn(`${logTag}: Brevo ${res.status} — ${detail.slice(0, 240)}`);
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
