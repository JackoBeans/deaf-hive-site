# DeafHive

The DeafHive public site. Static frontend hosted on GitHub Pages at <https://deafhive.online>; the **Organisations** directory and **Events** archive are populated from an Airtable base via a Cloudflare Worker proxy.

## Architecture at a glance

```
Browser ──→ GitHub Pages (this repo)
              │
              └── app.js fetches from the Worker
                    │
                    └── Cloudflare Worker (worker/) ──→ Airtable API
                          ├── Cache (1h, Cloudflare Cache API)
                          └── /purge ← Airtable automation (status → Approved)
```

- **Frontend** (this folder, repo root): plain HTML/CSS/JS, no build step.
- **Worker** (`worker/`): hides the Airtable PAT, caches responses, exposes a `/purge` endpoint.
- **Airtable**: the source of truth. Admins approve records by setting `Status` to `Approved`. Public sees Approved only.

---

## One-time setup

### 1. Airtable

1. Open the **DeafHive Database** base (`app0JwQ5lgCrRJ00M`).
2. Confirm a `Status` single-select field exists on both the **Organisation** and **Events** tables, with at least an `Approved` option. Only records set to `Approved` are exposed publicly by the Worker (records in `Draft`, or any other state, are filtered out).
3. Create a Personal Access Token at <https://airtable.com/create/tokens>:
   - **Scopes**: `data.records:read` (and add `schema.bases:read` if you want to use the metadata API for schema lookups).
   - **Access**: the DeafHive Database base only — do NOT grant all-workspaces access.
4. Save the token. You'll paste it into Wrangler in the next step.

### 2. Cloudflare Worker

```bash
cd worker
npm install -g wrangler
wrangler login                    # opens a browser to authorise Wrangler

wrangler secret put AIRTABLE_TOKEN
# Paste the Airtable PAT from step 1.3 when prompted.

wrangler secret put PURGE_SECRET
# Paste a random string. Generate one with:
#   openssl rand -hex 32
# Save a copy — you'll paste it into the Airtable automation in step 3.

wrangler deploy
# Wrangler prints a URL, e.g.
#   https://directory-proxy.<your-subdomain>.workers.dev
# Copy that URL — you need it for step 4.
```

Full Worker reference: [`worker/README.md`](worker/README.md).

### 3. Airtable automation for cache purge

The Worker caches responses for **1 hour**. To make admin changes appear within seconds rather than within an hour, Airtable POSTs to `/purge` whenever a record's `Status` flips to `Approved`.

In Airtable → **Automations** → **Create**:

1. **Trigger**: "When a record matches conditions"
   - Table: **Organisation**
   - Conditions: `Status is Approved`
2. **Action**: "Send webhook"
   - URL: `https://directory-proxy.<your-subdomain>.workers.dev/purge`
   - Method: `POST`
   - Headers: add `X-Purge-Token` → set the value to the `PURGE_SECRET` you generated in step 2.

Repeat the same automation for the **Events** table (using the same secret).

### 4. Site deployment

1. Edit [`app.js`](app.js). At the top, replace the placeholder:
   ```js
   const WORKER_URL = 'https://directory-proxy.<your-subdomain>.workers.dev';
   ```
   No trailing slash.
2. Commit and push to GitHub.
3. In the repo on GitHub → **Settings → Pages**:
   - **Source**: `Deploy from a branch`
   - **Branch**: `main` / root
   - **Custom domain**: `deafhive.online` (the `CNAME` file in this repo handles this automatically once you push)
4. Configure DNS for `deafhive.online` to point at GitHub Pages — see [GitHub's guide on custom domains](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site).

### 5. End-to-end test

1. In Airtable, add a new Organisation record with `Status = Draft`. Reload <https://deafhive.online>. The record should **not** appear in the directory.
2. Change the record's status to `Approved`. Within a few seconds, reload — the record should now appear.

If it doesn't:
- In the `worker/` folder run `wrangler tail` to see whether `/purge` was called.
- In Airtable, check the automation's run history for failures.
- Confirm the Airtable PAT has `data.records:read` on the DeafHive Database base.
- Confirm CORS — the page is served from `https://deafhive.online` (matches `ALLOWED_ORIGINS` in `worker/src/index.js`). Testing from a different origin (a local file, a different domain) will be blocked by the browser.

---

## Repo layout

```
deafhive-site/
├── README.md          ← this file
├── CNAME              ← deafhive.online (GitHub Pages custom domain)
├── index.html
├── style.css
├── app.js             ← WORKER_URL + per-section field config lives here
└── worker/
    ├── wrangler.toml
    ├── src/index.js   ← Worker code; constants at the top
    └── README.md      ← Worker setup detail
```

## Making changes later

- **Add/remove display fields on a card**: edit `SECTIONS.<name>.displayFields` in `app.js`. Each entry is `{ id: 'fld...', kind: 'title' | 'email' | 'url' | 'address-line1' | 'address-line2' | 'text' }`.
- **Add/remove filter chip rows**: edit `SECTIONS.<name>.filterFields` in `app.js`. The chips are built from the unique values present in the loaded data, so adding a field with no data yet is harmless.
- **Allow another origin to call the Worker** (e.g. for a staging URL or local testing): add it to `ALLOWED_ORIGINS` in `worker/src/index.js`, then `wrangler deploy`. Remove it once you're done — strict CORS is a small but useful guardrail.
- **Adjust cache TTL**: edit `CACHE_TTL_SECONDS` in `worker/src/index.js`. **Do not exceed 7200 seconds.** Airtable attachment URLs expire 2 hours after being returned, so any cached image URL must still be valid when served.

## Plan ceilings to watch

| Service             | Limit (current plan)          | Notes                                                                 |
|---------------------|-------------------------------|-----------------------------------------------------------------------|
| Airtable Team plan  | 100,000 API calls / month     | The Worker's 1h cache keeps real usage well under this in practice.   |
| Airtable Team plan  | 50,000 records / base         | Plenty of headroom.                                                   |
| Cloudflare Workers  | 100,000 requests / day        | Comfortably above public-site traffic.                                |
| GitHub Pages        | 100 GB bandwidth / month      | Comfortable for this size of site.                                    |

## Local development

To preview the site without deploying:

```bash
cd deafhive-site
python3 -m http.server 8000
# Visit http://localhost:8000/
```

While `WORKER_URL` is still the `TODO-fill-in` placeholder, the two Airtable sections show a friendly "Worker URL not configured yet" message; everything else (nav, video facades, modal, role-model cards) works.

If you want to test against a real Worker locally, add the local origin to `ALLOWED_ORIGINS` in `worker/src/index.js` and redeploy. Remove it once you're done.
