/* ════════════════════════════════════════════════════════════════════════
   Public submission form — shared JS, used by all three pages.

   The page declares its kind via a <body data-kind="organisation|event|video">
   attribute. This script picks the right endpoint, the right fields to
   serialise, and the right success copy.

   Honeypot, Turnstile token, image upload, JSON POST, inline success/error
   — same shape across all three forms.
   ════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ── Config ──────────────────────────────────────────────────────────

  const WORKER_URL = 'https://directory-proxy-v2.silent-term-d0e4.workers.dev';

  // Cloudflare Turnstile SITE key — public, fine to commit. The
  // matching SECRET key lives on the worker as TURNSTILE_SECRET.
  const TURNSTILE_SITE_KEY = '0x4AAAAAADi5_wIl1h2QkOJV';

  const ENDPOINTS = {
    organisation: '/submissions/organisation',
    event:        '/submissions/event',
    video:        '/submissions/video',
  };

  const SUCCESS_COPY = {
    organisation: 'Thank you — your organisation submission has been received. The DeafHive team will review it and publish it shortly.',
    event:        'Thank you — your event submission has been received. The DeafHive team will review it and publish it shortly.',
    video:        'Thank you — your video submission has been received. The DeafHive team will review it and publish it shortly.',
  };

  const kind = document.body.dataset.kind;
  if (!kind || !ENDPOINTS[kind]) {
    console.error('submit.js: missing or unknown data-kind on body', kind);
    return;
  }

  // ── DOM refs ────────────────────────────────────────────────────────

  const $form     = document.getElementById('submit-form');
  const $submit   = document.getElementById('submit-btn');
  const $bannerOk  = document.getElementById('banner-ok');
  const $bannerErr = document.getElementById('banner-err');
  const $turnstile = document.getElementById('turnstile-widget');

  // ── Turnstile setup ─────────────────────────────────────────────────
  // The Turnstile JS is loaded as <script async src="…"> in the page.
  // It races with this file: on a fast connection Turnstile loads
  // first, so any onloadTurnstileCallback we tried to register here
  // would be too late. Instead we poll for window.turnstile to appear,
  // then render explicitly so we can read the token back at submit.

  let turnstileWidgetId = null;
  let lastToken = '';

  function renderTurnstile() {
    if (!$turnstile) return;
    if (TURNSTILE_SITE_KEY === 'REPLACE_WITH_TURNSTILE_SITE_KEY') {
      $turnstile.textContent = 'Turnstile site key not configured.';
      return;
    }
    turnstileWidgetId = window.turnstile.render($turnstile, {
      sitekey: TURNSTILE_SITE_KEY,
      callback: (token) => { lastToken = token; },
      'expired-callback': () => { lastToken = ''; },
      'error-callback':   () => { lastToken = ''; },
    });
  }

  // Wait up to ~10s for window.turnstile, then render. 100ms polls.
  let turnstileTries = 0;
  (function waitForTurnstile() {
    if (window.turnstile && typeof window.turnstile.render === 'function') {
      renderTurnstile();
      return;
    }
    if (++turnstileTries > 100) {
      if ($turnstile) $turnstile.textContent = 'CAPTCHA failed to load. Refresh to try again.';
      return;
    }
    setTimeout(waitForTurnstile, 100);
  }());

  function resetTurnstile() {
    if (window.turnstile && turnstileWidgetId !== null) {
      window.turnstile.reset(turnstileWidgetId);
    }
    lastToken = '';
  }

  // ── Banners ─────────────────────────────────────────────────────────

  function showOk(message) {
    $bannerOk.textContent = message;
    $bannerOk.hidden = false;
    $bannerErr.hidden = true;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function showErr(message) {
    $bannerErr.textContent = message;
    $bannerErr.hidden = false;
    $bannerOk.hidden = true;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /** Flag a required field as invalid: red border (via aria-invalid),
   *  banner error, and focus the field so the user lands on it.
   *  The aria-invalid clears on the next input/change so the styling
   *  doesn't linger once the user starts typing a correction. */
  function failField(inputName, message) {
    showErr(message);
    const el = $form.elements.namedItem(inputName);
    if (!el || !('focus' in el)) return;
    el.setAttribute('aria-invalid', 'true');
    el.focus();
    const clear = () => {
      el.removeAttribute('aria-invalid');
      el.removeEventListener('input',  clear);
      el.removeEventListener('change', clear);
    };
    el.addEventListener('input',  clear);
    el.addEventListener('change', clear);
  }

  // ── Field serialisation ─────────────────────────────────────────────

  // Read a named input as a string-or-null.
  function val(name) {
    const el = $form.elements.namedItem(name);
    if (!el) return null;
    // Handle nodeList (chip group)
    if (el.length != null && !('value' in el)) {
      return null;
    }
    const v = (el.value || '').trim();
    return v === '' ? null : v;
  }

  // Read all checked chips in a chip-row by name.
  function chipValues(name) {
    const out = [];
    for (const el of $form.querySelectorAll(`input[name="${name}"]`)) {
      if (el.checked && el.value) out.push(el.value);
    }
    return out;
  }

  // Build the submission body per kind. Honeypot + Turnstile token added
  // in submit() below.
  function buildBody() {
    switch (kind) {
      case 'organisation':
        return {
          name:           val('name'),
          about:          val('about'),
          website:        val('website'),
          email_public:   val('email_public'),
          address:        val('address'),
          category_types: chipValues('category_types'),
          age_categories: chipValues('age_categories'),
          submitter_email: val('submitter_email'),
        };
      case 'event':
        return {
          name:             val('name'),
          event_date:       val('event_date'),
          organisation_id:  null,  // public submitters don't pick an org id — admin links if relevant
          details:          val('details'),
          address:          val('address'),
          poster_r2_key:    pendingUploadKey,
          submitter_email:  val('submitter_email'),
        };
      case 'video':
        return {
          name:            val('name'),
          description:     val('description'),
          youtube_url:     val('youtube_url'),
          // No file upload for videos — link only via YouTube to keep R2
          // costs in check + simplify abuse vectors.
          video_r2_key:    null,
          poster_r2_key:   null,
          organisation_id: null,
          submitter_email: val('submitter_email'),
        };
      default:
        return {};
    }
  }

  // ── Chip multi-select visual state ──────────────────────────────────
  // The chip is a <label> wrapping a hidden checkbox. Clicking the label
  // flips the checkbox natively (and chipValues() reads it correctly at
  // submit time), but the parent label's .is-checked class — which drives
  // the highlighted style — needs to be toggled by JS.

  (function wireChips() {
    for (const cb of $form.querySelectorAll('.chip input[type="checkbox"]')) {
      const label = cb.closest('.chip');
      if (!label) continue;
      // Sync initial state in case the form is pre-populated.
      label.classList.toggle('is-checked', cb.checked);
      cb.addEventListener('change', () => {
        label.classList.toggle('is-checked', cb.checked);
      });
    }
  }());

  // ── Image upload (org logo + event poster) ──────────────────────────

  let pendingUploadKey = null;

  function wireUpload() {
    const file    = document.getElementById('upload-file');
    const status  = document.getElementById('upload-status');
    const preview = document.getElementById('upload-preview');
    if (!file) return;

    file.addEventListener('change', async () => {
      const f = file.files && file.files[0];
      if (!f) return;
      if (!lastToken) {
        status.textContent = 'Please complete the CAPTCHA before uploading.';
        file.value = '';
        return;
      }
      status.textContent = `Uploading ${f.name}…`;
      const form = new FormData();
      form.append('file', f);
      form.append('turnstile_token', lastToken);
      try {
        const res = await fetch(`${WORKER_URL}/submissions/upload`, { method: 'POST', body: form });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          status.textContent = `Upload failed: ${data.error || res.status}`;
          file.value = '';
          // Turnstile tokens are single-use — reset for the next try.
          resetTurnstile();
          return;
        }
        pendingUploadKey = data.key;
        if (kind === 'organisation') {
          // Org logo also feeds into the form payload.
          // Stash in pendingUploadKey + read at submit.
        }
        status.textContent = `Ready: ${f.name}`;
        if (preview && data.url) preview.src = data.url;
        // Reset Turnstile — token was consumed by the upload.
        resetTurnstile();
        status.textContent += ' (please re-complete the CAPTCHA before submitting)';
      } catch (err) {
        status.textContent = `Upload error: ${err.message || err}`;
        resetTurnstile();
      }
    });
  }
  wireUpload();

  // ── Submit ─────────────────────────────────────────────────────────

  $form.addEventListener('submit', async (e) => {
    e.preventDefault();
    $bannerOk.hidden = true;
    $bannerErr.hidden = true;

    if (!lastToken) {
      showErr('Please complete the CAPTCHA before submitting.');
      return;
    }

    const body = buildBody();
    // Image upload: orgs use logo_r2_key, events use poster_r2_key.
    if (kind === 'organisation') body.logo_r2_key = pendingUploadKey;
    if (kind === 'event')        body.poster_r2_key = pendingUploadKey;

    // Honeypot + Turnstile
    body.hp_email = val('hp_email') || '';
    body.turnstile_token = lastToken;

    // Required-field client check (server validates again). failField()
    // sets aria-invalid + focuses the field so screen-reader users and
    // keyboard users land on the broken input.
    if (!body.name) {
      failField('name', 'Please enter a name.');
      return;
    }
    if (kind === 'event' && !body.event_date) {
      failField('event_date', 'Please enter the event date and time.');
      return;
    }
    if (kind === 'video' && !body.youtube_url) {
      failField('youtube_url', 'Please enter the YouTube URL.');
      return;
    }

    $submit.disabled = true;
    try {
      const res = await fetch(`${WORKER_URL}${ENDPOINTS[kind]}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 429) {
        const mins = Math.ceil((data.retry_after_seconds || 0) / 60);
        showErr(`Too many submissions from this network. Please try again in about ${mins} minute${mins === 1 ? '' : 's'}.`);
        return;
      }
      if (!res.ok) {
        showErr(`Submission failed: ${data.error || res.status}${data.message ? ' — ' + data.message : ''}`);
        return;
      }
      showOk(SUCCESS_COPY[kind]);
      $form.reset();
      pendingUploadKey = null;
      resetTurnstile();
    } catch (err) {
      showErr(`Network error: ${err.message || err}`);
    } finally {
      $submit.disabled = false;
    }
  });

}());
