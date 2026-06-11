// ════════════════════════════════════════════════════════════════════════
// Resend — "you have a new submission" email.
//
// Reads two env vars:
//   RESEND_API_KEY      — starts with "re_..."
//   NOTIFY_RECIPIENTS   — comma-separated list, e.g. "mail@signingworks.co.uk"
//
// From address is `onboarding@resend.dev` (Resend's free-tier sender,
// no DNS verification needed). The body is plain text with a deep link
// straight to the admin tab + row so triage is one click.
//
// Failure is non-fatal: an email-send error must not break the public
// submission — the row is already in D1. We log + swallow.
// ════════════════════════════════════════════════════════════════════════

const RESEND_URL = 'https://api.resend.com/emails';
const FROM = 'DeafHive Submissions <onboarding@resend.dev>';

function recipients(env) {
  return (env.NOTIFY_RECIPIENTS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

const PUBLIC_SITE = 'https://deafhive.online';

const TAB_FOR = {
  organisation: 'organisations',
  event:        'events',
  video:        'videos',
};

// type ∈ {'organisation','event','video'}
export async function notifySubmission(env, ctx, { type, id, name, submitterEmail }) {
  if (!env.RESEND_API_KEY) {
    console.warn('notify skipped: RESEND_API_KEY not set');
    return;
  }
  const to = recipients(env);
  if (to.length === 0) {
    console.warn('notify skipped: NOTIFY_RECIPIENTS empty');
    return;
  }

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

  const send = async () => {
    try {
      const res = await fetch(RESEND_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({ from: FROM, to, subject, text }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        console.warn(`notify: Resend ${res.status} — ${detail.slice(0, 240)}`);
      }
    } catch (err) {
      console.warn('notify: send failed', err?.message || err);
    }
  };

  // Fire-and-forget so the user gets a quick success response even if
  // Resend is slow.
  ctx.waitUntil(send());
}
