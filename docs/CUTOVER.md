# Cutover runbook — Airtable → D1/R2

Self-contained step-by-step for flipping the live `deafhive.online` site
from the Airtable-backed Worker (`worker/`) to the D1/R2-backed Worker
(`worker-v2/`).

**Before you run this**, the Phase 6 prep checklist must be done:

- [x] D1 + R2 hold the migrated data (35 orgs, 138 events, 6 videos)
- [x] Fixture rows wiped from D1 (`worker-v2/fixture-wipe.sql` applied)
- [x] `media.deafhive.online` resolves over HTTPS and serves R2 objects
- [x] worker-v2 CORS allowlist is production-only (no localhost)
- [x] Admin UI shows real data correctly

The cutover itself is **5 small edits** to two files, one commit, one
push, one cache purge. Total wall-clock: under 5 minutes if nothing
goes wrong. Rollback is **one revert + one push**.

---

## Phase A — code changes (one commit, one push)

### 1. `app.js` — switch `WORKER_URL` to the new worker

```diff
-const WORKER_URL = 'https://directory-proxy.silent-term-d0e4.workers.dev';
+const WORKER_URL = 'https://directory-proxy-v2.silent-term-d0e4.workers.dev';
```

That's the production flip. From this commit on, every visitor's page
load reads orgs/events from D1, not Airtable.

### 2. `app.js` — update field mappings to the new stable-key shape

The new Worker returns `fields.name`, `fields.logo_url`, `fields.organisation_name`
etc. — stable strings, not Airtable `fld...` IDs.

Replace the `SECTIONS.organisations.fields` block and `EVENTS_CONFIG.fields`:

```diff
 const SECTIONS = {
   organisations: {
     endpoint: '/organisations',
     listElId: 'organisations-list',
     filtersElId: 'organisations-filters',
     searchElId: 'organisations-search',
     countElId: 'organisations-count',
     emptyMessage: 'No organisations match your filters.',
     nounSingular: 'organisation',
     nounPlural: 'organisations',
     fields: {
-      title:      'fld4bfPSAbKzFECtJ',  // Name
-      logo:       'fldttGzEhgV9NUCBs',  // Image(s) — attachment
-      about:      ABOUT_FIELD_ID,       // Organisation / Service - Description
-      website:    'fld4mNGInMTVA1jag',  // Website
-      email:      'fldYmHVYnc6wnIZjj',  // Contact (public)
-      categories: 'fldes1yumsDCD1rtB',  // Category Type
+      title:      'name',
+      logo:       'logo_url',
+      about:      'about',
+      website:    'website',
+      email:      'email_public',
+      categories: 'category_types',
     },
-    searchField: 'fld4bfPSAbKzFECtJ',
+    searchField: 'name',
     filterFields: [
-      { id: 'fldes1yumsDCD1rtB', label: 'Category Type' },
-      { id: 'fldOHinxLA1zPEobA', label: 'Age Category' },
+      { id: 'category_types', label: 'Category Type' },
+      { id: 'age_categories', label: 'Age Category' },
     ],
   },
 };

 const EVENTS_CONFIG = {
   endpoint: '/events',
   fields: {
-    eventName:    'fldoBpajSR36bVUvO',
-    date:         'fldhcuE2MS7apCNat',
-    organisation: 'fldS9rjbFoHAJ4M1I',
-    details:      'fldt13ci6IUl7KpvC',
-    address:      'fldVa5avzI8lFE1NL',
-    poster:       'fldwC5PJAa0KUpUgv',
+    eventName:    'name',
+    date:         'event_date',
+    organisation: 'organisation_name',
+    details:      'details',
+    address:      'address',
+    poster:       'poster_url',
   },
 };
```

Also remove or repurpose the now-orphaned constant:

```diff
-const ABOUT_FIELD_ID = 'fldFXsrljrnYXfM8N';
```

### 3. `app.js` — fix the logo/poster reader (attachments → URL strings)

The old Worker returned attachment arrays (`fields.fldXXX[0].url`); the
new one returns plain strings (`fields.logo_url`). The render code has
a helper that pulls a URL out of the attachment shape — update it to
accept either shape so it's resilient. Search `app.js` for
`Attachments` / `.url` reads. The exact diff depends on the helper name
in your current code; the principle:

```js
// Old:
//   const url = fields[cfg.logo]?.[0]?.url;
// New:
//   const v = fields[cfg.logo];
//   const url = typeof v === 'string' ? v : v?.[0]?.url;
```

(Backwards-compat. If you want to be strict and drop the old code,
just `const url = fields[cfg.logo] || null;`.)

### 4. `index.html` — replace the hard-coded YouTube video block with a dynamic container

Find the existing 7-video block (around line 160, starts at the first
`<button class="video-facade" data-id="_raNeUTdE6Q" ...`). Replace the
block with:

```html
<div id="videos-list" class="videos-list"></div>
```

You'll need a small JS renderer in `app.js` that fetches `/videos` and
renders each as a `<button class="video-facade" data-id="..." ...>` —
matches what the old modal flow expects.

**Optional simpler interim**: leave the static block in place for now.
Re-rendering the videos dynamically is a UX-equivalent change, not a
data-source change. The cutover can ship without it; do it as a
follow-up commit if time-pressed.

### 5. `app.js` — surface `event.organisation_name` directly

The old shape: `event.fields[organisation]` returned `[ "Bristol Beacon" ]`
(an array because Airtable Lookups always return arrays). The new
shape: `event.fields.organisation_name` is a plain string. Anywhere in
the event-render code that did `org[0]` or `org.join(', ')`, update to
just read the string.

### Commit + push

```bash
git add app.js index.html
git commit -m "Phase 6 cutover: read from D1 (worker-v2) instead of Airtable"
git push origin main
```

GitHub Pages will rebuild in ~30–60 s.

---

## Phase B — verify (do this in a private window)

1. Open `https://deafhive.online` in an incognito window
2. Confirm the org grid renders 35 cards, alphabetised
3. Click one — modal opens with About text + logo
4. Switch to Events block — calendar populates with 138 events
5. Filter by category / age — should narrow the count
6. Network tab: confirm requests go to `directory-proxy-v2.*` (not
   `directory-proxy.*`)
7. Confirm images load from `media.deafhive.online/...`

If anything is broken — see Rollback below.

---

## Phase C — refresh edge cache

The new Worker caches `/organisations`, `/events`, `/videos` for 1 h.
First-time visitors after cutover will hit a cold cache and trigger
a fresh D1 read. Within seconds the edge fills up.

You don't *need* to force a purge, but it can't hurt:

```bash
curl -X POST \
  -H "X-Purge-Token: $YOUR_PURGE_SECRET" \
  https://directory-proxy-v2.silent-term-d0e4.workers.dev/purge
```

(`$YOUR_PURGE_SECRET` is whatever you set `PURGE_SECRET` to.)

---

## Rollback (if needed)

If anything goes wrong, the rollback is one git operation:

```bash
git revert HEAD                 # creates an "undo" commit
git push origin main            # GitHub Pages rebuilds with the OLD app.js
```

GitHub Pages republishes in ~30–60 s. Site is back on the Airtable
Worker. The new Worker stays deployed and ready for a retry once
you've diagnosed the issue.

The OLD `worker/` is still running (we never decommissioned it). Its
URL is `https://directory-proxy.silent-term-d0e4.workers.dev`.
Airtable still has all the data.

---

## Post-cutover holding period (2 weeks)

Per the rebuild plan, **don't decommission anything for 2 weeks** even
if cutover looks clean. Reasons:

- Latent bugs in admin UI may not surface immediately
- Airtable still serves as a backup of record
- The old Worker is your one-line rollback

After 2 trouble-free weeks, run Phase 7 (decommission):

1. Revoke the Airtable PAT used by the OLD Worker
2. `wrangler delete directory-proxy` (the old worker — verify name first)
3. Downgrade Airtable to free plan if it's currently paid
4. Update docs that reference the old Worker URL

---

## Cheat sheet — exact commands you'll type

```bash
# Phase A
cd ~/Library/CloudStorage/Dropbox/ClaudeCode/deafhive-site
# (apply the 5 edits above to app.js and index.html)
git add app.js index.html
git commit -m "Phase 6 cutover: read from D1 (worker-v2) instead of Airtable"
git push origin main

# Phase B
open -a Safari -W "https://deafhive.online" --new --args -private-browsing
# (eyeball the site)

# Phase C (optional)
curl -X POST -H "X-Purge-Token: <your-purge-secret>" \
  https://directory-proxy-v2.silent-term-d0e4.workers.dev/purge

# Rollback (only if needed)
git revert HEAD && git push origin main
```
