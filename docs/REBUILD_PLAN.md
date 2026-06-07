# Rebuild plan: move data off Airtable to Cloudflare D1 + R2

A staged plan for replacing the Airtable backend with a self-hosted (free-tier Cloudflare) data layer. The public site at `deafhive.online` keeps running unchanged throughout — every step happens on a parallel Worker URL until cutover.

## Goals

- **Genuinely $0/month** at DeafHive's scale. Forever, not just on free trial.
- **No rate limits** that can break the live site.
- **Permanent image URLs** with CDN delivery (kill the 2-hour Airtable URL expiry workaround).
- **Anonymous public submissions** with admin approval queue (preserves the current `Status = Approved` workflow but moves submission off Airtable's form feature).
- **Multi-user-capable admin UI** — start with one shared password, leave the door open for SSO later.
- **Live site never breaks during rebuild** — old Worker keeps serving until the day we flip one constant.

---

## Architecture

```
                    ┌────────────────────────┐
                    │  Public site            │
                    │  deafhive.online        │
                    │  GitHub Pages, free     │
                    └────────────┬────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │  Worker (Cloudflare)    │
                    │  Free: 100k req/day     │
                    │                          │
                    │   ┌── public reads      │
                    │   ├── public submits    │
                    │   ├── admin r/w         │
                    │   └── image upload      │
                    └──┬──────────┬───────────┘
                       │          │
                       ▼          ▼
                 ┌────────┐  ┌────────┐
                 │   D1   │  │   R2   │
                 │ SQLite │  │ images │
                 │ 5 GB   │  │ 10 GB  │
                 │ free   │  │ free   │
                 └────────┘  └────────┘
                       ▲          ▲
       ┌───────────────┴──────────┴──────────────┐
       │                                          │
┌──────┴──────────┐              ┌────────────────┴────────┐
│ Public          │              │ Admin UI                │
│ submission      │              │ /admin (same site,      │
│ form            │              │ password-gated)         │
│ (anonymous +    │              │                         │
│ Turnstile)      │              │ - inline cell editing   │
└─────────────────┘              │ - drag-drop image upload│
                                 │ - approve/reject queue  │
                                 └─────────────────────────┘
```

### Cost forecast

| Service | Limit (free tier) | Realistic monthly usage at DeafHive's scale | Cost |
|---|---|---|---|
| Cloudflare D1 | 5 GB storage, 5M reads/day, 100k writes/day | ~2 MB, ~1,500 reads/day, ~50 writes/day | **$0** |
| Cloudflare R2 | 10 GB storage, no egress fees | ~50 MB (orgs + event posters) | **$0** |
| Cloudflare Workers | 100k req/day | ~5,000 req/day | **$0** |
| Cloudflare Turnstile (CAPTCHA) | unlimited free | ~10 submissions/week | **$0** |
| GitHub Pages | 100 GB bandwidth/month | <1 GB | **$0** |
| **Total** | | | **$0/month** |

Even with 100× growth (3,000 organisations, 5,000 events, ~5 GB of images), we'd still be inside every free tier.

---

## Phases

The work splits into 7 phases. Each phase ships independently and the live site keeps working between them. Estimated effort assumes one developer focused on this; double it if you're interleaving with other work.

| Phase | Outcome | Effort |
|---|---|---|
| 0 | Cloudflare resources created, schema applied, dev environment ready | ~1 h |
| 1 | Read-only Worker returning same JSON shape as today, backed by D1 with fixture data | ~3 h |
| 2 | Admin UI shell — login, read-only tables for orgs + events | ~3 h |
| 3 | Admin UI write — inline editing, status changes, delete, image upload | ~6 h |
| 4 | Public submissions — form pages, rate-limited POST endpoints, abuse protection | ~3 h |
| 5 | Migration script — Airtable → D1 + R2, validated row counts | ~2 h |
| 6 | Cutover — flip `WORKER_URL`, monitor, hold old Worker as rollback | ~1 h |
| 7 | Decommission — revoke Airtable PAT, downgrade Team plan | ~30 min |
| | **Total** | **~19 h** (3 working days) |

---

## Phase 0 — Setup

### 0.1 Create Cloudflare resources

```bash
# From the worker-v2/ directory once it exists
wrangler login   # (already done)

# Create the D1 database
wrangler d1 create deafhive
# Note the database_id printed — paste into wrangler.toml

# Create the R2 bucket
wrangler r2 bucket create deafhive-images

# Bind both into the Worker (in wrangler.toml):
#   [[d1_databases]]
#   binding = "DB"
#   database_name = "deafhive"
#   database_id = "<from create command>"
#
#   [[r2_buckets]]
#   binding = "IMAGES"
#   bucket_name = "deafhive-images"
```

### 0.2 Add R2 custom domain (one-time)

In the Cloudflare dashboard → R2 → `deafhive-images` → Settings → Custom Domains → add `images.deafhive.online`. Set up a DNS CNAME record at your DNS provider pointing `images` → `<bucket>.r2.cloudflarestorage.com` (Cloudflare provides the exact value). Once propagated, image URLs are `https://images.deafhive.online/<key>` — permanent, CDN-cached, zero egress fees.

### 0.3 Set Worker secrets

```bash
wrangler secret put ADMIN_PASSWORD     # shared admin login password
wrangler secret put ADMIN_TOKEN_SECRET # used to sign session tokens (HMAC key)
wrangler secret put PURGE_SECRET       # same purge model as today
wrangler secret put TURNSTILE_SECRET   # from Cloudflare Turnstile dashboard
```

### 0.4 Repo layout after rebuild

```
deafhive-site/
├── (existing public site — index.html, app.js, style.css, etc.)
├── worker/                ← existing Airtable Worker (kept for rollback during cutover)
├── worker-v2/             ← new Worker
│   ├── wrangler.toml
│   ├── schema.sql         ← D1 schema, version-controlled
│   ├── migrations/        ← future schema changes (numbered SQL files)
│   ├── src/
│   │   ├── index.js       ← router
│   │   ├── reads.js       ← GET /organisations, /events
│   │   ├── submissions.js ← POST /submissions/*
│   │   ├── admin.js       ← /admin/* routes
│   │   ├── images.js      ← R2 upload/delete handlers
│   │   ├── auth.js        ← token issue + verify (HMAC)
│   │   ├── rate-limit.js  ← IP-bucket rate limiting via D1
│   │   ├── db.js          ← prepared statement helpers
│   │   └── cors.js        ← shared CORS logic (same as today)
│   ├── migrate-from-airtable.js  ← one-shot import script
│   └── README.md
├── admin/                 ← new admin app, served by GitHub Pages
│   ├── index.html
│   ├── admin.css
│   └── admin.js
├── submit/                ← new public submission pages
│   ├── organisation.html
│   ├── event.html
│   ├── submit.css
│   └── submit.js
└── docs/
    ├── REBUILD_PLAN.md    ← this file
    ├── DATA_DICTIONARY.md ← will be updated after rebuild
    └── ADMIN_HANDBOOK.md  ← will be updated after rebuild
```

---

## Database schema

A single `schema.sql` file applied via `wrangler d1 execute deafhive --file=worker-v2/schema.sql`.

```sql
-- ════════════════════════════════════════════════════════════════════════
-- DeafHive D1 schema
-- ════════════════════════════════════════════════════════════════════════

-- ── Organisations ──────────────────────────────────────────────────────
CREATE TABLE organisations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'approved', 'rejected', 'draft')),
  website         TEXT,
  email_public    TEXT,
  email_admin     TEXT,
  about           TEXT,         -- long text (was "Organisation / Service - Description")
  address         TEXT,
  logo_r2_key     TEXT,         -- e.g. 'orgs/2026/05/abc123.jpg'
  category_types  TEXT NOT NULL DEFAULT '[]',  -- JSON array of strings
  age_categories  TEXT NOT NULL DEFAULT '[]',  -- JSON array of strings
  submitted_via   TEXT NOT NULL DEFAULT 'admin'
                   CHECK (submitted_via IN ('admin', 'public')),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX idx_orgs_status ON organisations(status);
CREATE INDEX idx_orgs_name   ON organisations(name);

-- ── Events ─────────────────────────────────────────────────────────────
CREATE TABLE events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'approved', 'rejected', 'draft')),
  organisation_id INTEGER REFERENCES organisations(id) ON DELETE SET NULL,
  event_date      TEXT NOT NULL,    -- ISO 8601 datetime, e.g. '2026-05-19T14:00:00Z'
  address         TEXT,
  details         TEXT,
  poster_r2_key   TEXT,
  submitted_via   TEXT NOT NULL DEFAULT 'admin'
                   CHECK (submitted_via IN ('admin', 'public')),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX idx_events_status ON events(status);
CREATE INDEX idx_events_date   ON events(event_date);
CREATE INDEX idx_events_org    ON events(organisation_id);

-- ── Submission rate limiting ───────────────────────────────────────────
CREATE TABLE submission_quota (
  ip_hash      TEXT PRIMARY KEY,    -- SHA-256 of client IP (no PII stored)
  count        INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL     -- unix epoch seconds
);

-- ── Audit log (light-weight) ───────────────────────────────────────────
-- Optional but useful for debugging "who changed this when". Keeps last
-- ~10k entries by simple LRU sweep in the admin endpoint.
CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         INTEGER NOT NULL,           -- unix epoch
  actor      TEXT NOT NULL,              -- 'admin' or 'public' or specific user
  action     TEXT NOT NULL,              -- 'create', 'update', 'delete', 'approve', 'reject'
  entity     TEXT NOT NULL,              -- 'organisation' | 'event' | 'image'
  entity_id  INTEGER,
  diff_json  TEXT                        -- optional JSON of changed fields
);

CREATE INDEX idx_audit_at ON audit_log(at DESC);
```

### Schema decisions explained

- **JSON-as-text for multi-select fields** (`category_types`, `age_categories`) — avoids three-table joins for a small list. SQLite has JSON1 built in; queries like `WHERE json_extract(category_types, '$[0]') = 'Community'` work, but for our scale we'll just parse client-side.
- **R2 keys, not URLs** — store the bucket path (e.g. `orgs/2026/05/abc.jpg`), let the read API concatenate `https://images.deafhive.online/<key>` at render time. Keeps the database portable.
- **Unix timestamps as INTEGER** — D1 doesn't have a native `TIMESTAMP` type; storing seconds-since-epoch is universal.
- **`CHECK` constraints on status + submitted_via** — typo-proofs the small enum set at the database layer.
- **No vocabulary table for categories** — values are small, stable, and OK to be free text. If you ever want admin-managed dropdowns, add a `vocabularies` table later.

---

## Worker endpoints

The new Worker exposes ~14 routes. Below, **PUB** = no auth, **ADMIN** = requires bearer token, **SYS** = requires the existing purge secret.

### Public read endpoints (cached)

| Method | Path | Auth | Returns |
|---|---|---|---|
| `GET` | `/organisations` | PUB | `{records: [...approved orgs with public fields...]}` — same shape as today |
| `GET` | `/events` | PUB | `{records: [...approved events with public fields + joined org name...]}` |

Cache rules:
- Same Cloudflare Cache API approach as today
- TTL 1 hour for safety (R2 URLs don't expire so this is purely an optimisation now)
- `/purge` clears both

### Public submission endpoints

| Method | Path | Auth | Body | Effect |
|---|---|---|---|---|
| `POST` | `/submissions/organisation` | PUB + rate-limit + Turnstile | JSON: org fields + optional `image_upload_id` | Inserts row with `status='pending'`, `submitted_via='public'` |
| `POST` | `/submissions/event` | PUB + rate-limit + Turnstile | JSON: event fields + optional `image_upload_id` | Same for events |
| `POST` | `/submissions/upload` | PUB + rate-limit + Turnstile | multipart with one image | Uploads to R2 under `pending/<uuid>.<ext>`, returns `{id, url}` for the submitter to reference |

Public submission rules:
- Rate limit: **3 submissions per IP per hour** (hashed IP, no PII stored)
- Turnstile token required (free Cloudflare CAPTCHA)
- Honeypot field (`hp_email` — bots fill, humans don't) — if non-empty, return success-shaped response but drop silently
- Max image size 5 MB, must be image/* MIME

### Admin endpoints (all require `Authorization: Bearer <token>`)

| Method | Path | Effect |
|---|---|---|
| `POST` | `/admin/login` | Validate `password` body field against `ADMIN_PASSWORD` env; on match, return signed HMAC token valid for 30 days |
| `GET` | `/admin/whoami` | Verify token is still valid (used by admin UI on load) |
| `GET` | `/admin/organisations?status=pending\|all` | List orgs (filtered) |
| `GET` | `/admin/organisations/:id` | Single org |
| `POST` | `/admin/organisations` | Create new org (admin-direct) |
| `PUT` | `/admin/organisations/:id` | Update fields |
| `DELETE` | `/admin/organisations/:id` | Remove |
| `POST` | `/admin/organisations/:id/status` | Body `{status}` — sets status; if going to `approved`, fires `/purge` internally so the public site refreshes |
| `GET` | `/admin/events*` | Same shape as orgs |
| `POST/PUT/DELETE` | `/admin/events*` | Same shape as orgs |
| `POST` | `/admin/upload` | Multipart image upload to R2, returns `{key, url}` |
| `DELETE` | `/admin/upload/:key` | Remove from R2 (also clears the reference in any row that has it) |
| `GET` | `/admin/audit?limit=50` | Recent audit-log entries |

### System endpoints

| Method | Path | Auth | Effect |
|---|---|---|---|
| `POST` | `/purge` | `X-Purge-Token` header (existing pattern) | Clears edge cache for /organisations and /events |
| `GET` | `/healthz` | PUB | Returns `{ok: true, db: <ping result>, r2: <ping result>}` |

### CORS

Same allowlist pattern as today:

```js
const ALLOWED_ORIGINS = [
  'https://deafhive.online',
  // admin/submit pages are same-origin so no extra CORS needed
];
```

### Response shape

`/organisations` and `/events` return the **same** JSON shape as the current Airtable Worker so `app.js` doesn't need any field-mapping changes:

```json
{
  "records": [
    {
      "id": 42,                           // D1 integer id, not Airtable rec-id
      "fields": {
        "name": "Bristol Beacon",
        "logo_url": "https://images.deafhive.online/orgs/.../bb.jpg",
        "website": "https://bristolbeacon.org",
        "email_public": "hello@bristolbeacon.org",
        "about": "Bristol Beacon is...",
        "category_types": ["Community"],
        "age_categories": ["Adults (25-59)"]
      }
    }
  ]
}
```

`app.js`'s `SECTIONS.organisations.fields` config switches from Airtable `fld...` IDs to these stable JSON keys — a 7-line change in one place.

---

## Authentication design

### Token issuance (`POST /admin/login`)

```js
// pseudo-code
const { password } = await request.json();
if (timingSafeEqual(password, env.ADMIN_PASSWORD)) {
  const expires = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60; // 30 days
  const payload = `admin.${expires}`;
  const sig = await hmacSha256(payload, env.ADMIN_TOKEN_SECRET);
  const token = `${payload}.${sig}`;
  return json({ token, expires });
}
return json({ error: 'wrong password' }, 401);
```

### Token verification (every admin endpoint)

```js
function verifyToken(authHeader, env) {
  const m = /^Bearer (admin\.\d+)\.([0-9a-f]+)$/.exec(authHeader || '');
  if (!m) return null;
  const [, payload, sig] = m;
  const expected = await hmacSha256(payload, env.ADMIN_TOKEN_SECRET);
  if (!timingSafeEqual(sig, expected)) return null;
  const expires = Number(payload.split('.')[1]);
  if (expires < Math.floor(Date.now() / 1000)) return null;
  return { actor: 'admin', expires };
}
```

No external auth library; no JWT spec dependency. HMAC + timestamp is sufficient for a shared-password project.

### Multi-user upgrade path

When you outgrow shared password (more than 2–3 admins or you want audit-by-name), drop in **Cloudflare Access**:

- Free for up to 50 users
- Integrates as middleware in front of the Worker — adds `Cf-Access-Jwt-Assertion` header for the authenticated user
- Replace `verifyToken` with a JWT verification against Cloudflare's public key
- Audit log gains real user identity for free

No application code redesign required — auth is a layer.

---

## Image upload flow

```
[Admin or public submitter selects file]
                │
                ▼
   POST multipart /admin/upload (or /submissions/upload)
                │
                ▼
        Worker validates:
        - size <= 5 MB
        - mime starts 'image/'
        - file actually parses as image (sniff first bytes)
                │
                ▼
   Generates key:
   - admin uploads:  orgs/2026/05/<uuid>.<ext>
   - public submits: pending/<uuid>.<ext>
                │
                ▼
       PUT to R2 via env.IMAGES.put(key, body)
                │
                ▼
    Returns { key, url: 'https://images.deafhive.online/<key>' }
                │
                ▼
   Client uses url for preview;
   key written into the row's logo_r2_key / poster_r2_key field
```

### Public-submission image handling

Public submissions upload to `pending/` namespace. On approval, the admin endpoint optionally moves the object to a permanent location via R2's `copy` + `delete`. Or leaves it — the namespace is purely organisational; R2 doesn't charge differently.

### Image cleanup

When a row is deleted, the admin endpoint also issues `env.IMAGES.delete(key)` so we don't accumulate orphans. Belt-and-braces: a periodic Worker cron (free) walks `images.deafhive.online/orgs/*` and removes objects no row references.

---

## Public submission form

### Pages

- `/submit/organisation.html` — submission form, fields below
- `/submit/event.html` — same shape for events
- Link from main site: button at the end of the hero section or in a "Get involved" CTA

### Fields (organisation example)

| Field | Required | Notes |
|---|---|---|
| Organisation name | ✓ | text |
| Public email | | email format |
| Website | | URL format |
| About (description) | ✓ | textarea (Markdown supported) |
| Address | | textarea |
| Category Type | | multi-select from controlled vocabulary |
| Age Category | | multi-select from controlled vocabulary |
| Logo upload | | optional, image |
| Admin contact email (private) | ✓ | not shown publicly; admin uses to follow up |
| Honeypot (`hp_email`) | hidden | bots fill, humans don't |
| Turnstile widget | ✓ | invisible-mode CAPTCHA |

### Submission flow

1. User fills the form
2. JS optionally uploads image first → gets back `{id}`
3. Form POSTs JSON to `/submissions/organisation`
4. Worker:
   - Verifies Turnstile token
   - Hashes IP, checks rate limit (3/hour)
   - Validates the honeypot is empty
   - Inserts row with `status='pending'`, `submitted_via='public'`
   - Writes audit entry
5. Returns `{success: true, id}`
6. User sees a thank-you page

### Abuse protection summary

| Vector | Defence |
|---|---|
| Bot spam | Turnstile + honeypot |
| Rapid manual submission | IP-bucket rate limit (3/hour) |
| Oversized payloads | Worker rejects bodies > 100 KB JSON or > 5 MB image |
| SQLi | Prepared statements throughout (D1 mandates) |
| XSS | Same render path as today — `textContent` + safe Markdown renderer |
| CSRF on admin | Token in `Authorization` header (not cookie), so no cross-site auto-send |

---

## Admin UI

### Stack

Same as the main site: plain HTML/CSS/JS, no build step, no framework. Lives at `/admin/index.html` on the same GitHub Pages domain.

### Page structure

```
┌──────────────────────────────────────────────────────────┐
│ DeafHive Admin                              [Log out]    │
├──────────────────────────────────────────────────────────┤
│  [Organisations] [Events] [Submissions(3)] [Audit]       │  ← tabs
├──────────────────────────────────────────────────────────┤
│  [+ New]  [Search…]  Filter: [All ▾] [Status ▾]          │  ← toolbar
├──────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────────┐    │
│  │ Name        | Status   | Cat. | Logo | Updated   │    │
│  ├──────────────────────────────────────────────────┤    │
│  │ Bristol …   | Approved | Comm.| 🖼️   | 5 days ago│    │
│  │ ASLI SW     | Draft    | …    | 🖼️   | 2 weeks   │    │
│  │ Deaf Active | Pending  | …    |      | yesterday │    │
│  └──────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────┘
```

Clicking a row opens an inline editor (or a side panel) with all fields editable. Image upload is drag-and-drop into a square preview area. Save button at top-right + auto-save on blur.

### Implementation notes

- One JS file (`admin/admin.js`) handles all tabs via a tiny route function
- Uses `fetch` against the new Worker with `Authorization: Bearer <token>` from `sessionStorage`
- 401 response → clears token, redirects to login screen
- All updates use optimistic UI: change cell, save in background, show toast on success/failure

### Login screen

- Single password field
- POSTs to `/admin/login`
- On success, store token in `sessionStorage.deafhive_admin_token`
- Reload → admin dashboard
- "Log out" clears the token

### Mobile considerations

Hobby project; assume admins use a laptop. Mobile responsiveness as a nice-to-have, not a requirement.

---

## Migration script

`worker-v2/migrate-from-airtable.js` runs once. Run it locally as a Node script using the `wrangler` CLI's `--remote` mode so it actually writes to production D1 and R2.

### Steps

1. Fetch all Organisation records from Airtable metadata API
2. For each org:
   - Download each attachment to a temp file
   - Upload to R2 under `orgs/migrated/<airtable-id>/<filename>`
   - Insert row into D1 with mapped fields:
     - `name` ← `Name`
     - `status` ← `Status` (`Approved`→`approved`, `Draft`→`draft`)
     - `website` ← `Website`
     - `email_public` ← `Contact (public)`
     - `about` ← `Organisation / Service - Description`
     - `address` ← `Organisation Address`
     - `logo_r2_key` ← R2 key from upload
     - `category_types` ← JSON.stringify of `Category Type` array
     - `age_categories` ← JSON.stringify of `Age Category` array
     - `created_at`/`updated_at` ← Airtable's `createdTime` field as epoch
3. Repeat for Events:
   - Foreign key to `organisation_id` resolved by name match (or by carrying Airtable's record-ID mapping in a temp table during migration)
4. Validate:
   - D1 row counts == Airtable row counts
   - Random spot-check: pick 5 orgs, compare every field
   - All `logo_r2_key` URLs return 200 OK

### Idempotency

The script is destructive (truncates tables before insert). Run as a one-shot only. To re-run, wipe D1 first.

### Failure mode

If the script crashes partway, the D1 state is incomplete. Recovery is easy: `wrangler d1 execute deafhive --command "DELETE FROM ..."` to wipe, then re-run.

---

## Cutover plan

### Pre-cutover (Phase 5 complete)

- New Worker deployed and accepting requests at `https://directory-proxy-v2.<subdomain>.workers.dev`
- D1 populated with migrated data
- R2 has all images
- New Worker returns same JSON shape as old Worker for `/organisations` and `/events`
- Admin UI tested with new Worker
- Public submission tested

### Cutover (Phase 6)

1. Open a feature branch on the deaf-hive-site repo
2. Edit `app.js`:
   ```js
   const WORKER_URL = 'https://directory-proxy-v2.<subdomain>.workers.dev';
   ```
3. Update `worker/src/index.js` `ALLOWED_ORIGINS` in NEW worker to include `https://deafhive.online`
4. Open PR, review, merge
5. GitHub Pages rebuilds (~30 sec)
6. Hard-refresh `https://deafhive.online` to verify
7. Observe: open browser DevTools, confirm requests go to the new Worker URL, returning real data

### Rollback (if needed)

Revert the `app.js` commit. GitHub Pages redeploys in ~30 sec. Old (Airtable) Worker is still running with valid secrets. Live site is back on the old backend.

### Post-cutover holding period (2 weeks)

- Keep both Workers running
- Keep Airtable PAT active (read-only)
- Spot-check the live site weekly
- Watch the new Worker's logs (`wrangler tail`) for errors

### Decommission (Phase 7)

After the holding period with no rollback events:

1. Revoke the Airtable PAT
2. Delete the old `worker/` directory and its Wrangler deployment (`wrangler delete --name directory-proxy`)
3. Downgrade or cancel the Airtable Team plan
4. Update `docs/DATA_DICTIONARY.md` and `docs/ADMIN_HANDBOOK.md` to reflect the new backend
5. Rename `worker-v2/` to `worker/` for tidiness
6. Final commit + push

---

## Testing strategy

### Unit-ish (per Worker endpoint)

- Manual curl with a stable test payload, checked into `worker-v2/tests/curl-examples.sh`
- One example per endpoint: success path + auth failure + validation failure

### End-to-end (admin UI flow)

- Manual scripted walkthrough recorded in `docs/admin-test-script.md`
- Login → create org → upload logo → approve → check live site
- Public submission → admin review → approve → check live site

### Smoke (post-deploy)

- `curl https://directory-proxy-v2.<subdomain>.workers.dev/healthz`
- Visit `https://deafhive.online` and verify the 32 (or migrated count) orgs render
- Open a known org's modal, confirm logo and About text match Airtable

---

## What this rebuild DOESN'T solve

For transparency:

- **Real-time updates** — site still uses a 1-hour cache + purge-on-approve. Same behaviour as today.
- **Editorial workflow beyond approve/reject** — no "needs revision" state, no comments on submissions. Add later if needed.
- **Versioned content** — no field history beyond the audit log. To roll back an edit, you re-type the prior value.
- **Search across submissions** — the admin can filter by status but there's no fancy search. SQLite LIKE queries will do for ~thousands of records.
- **Internationalisation** — site is en-GB only, same as today.
- **The current Role Models card hardcoded in index.html** — out of scope, untouched. If you want it Airtable/D1-driven, separate task.

---

## Open questions to resolve before Phase 1

1. **Custom domain for R2** — confirm `images.deafhive.online` is acceptable. Alternative: serve images directly from `*.r2.cloudflarestorage.com` (uglier URLs, same performance).
2. **Admin URL** — `deafhive.online/admin/` (same-origin, simplest) or `admin.deafhive.online` (subdomain, slightly cleaner separation)?
3. **Submission URL** — same question: `deafhive.online/submit/` or `submit.deafhive.online`?
4. **Submission notification** — should approving an admin email them when a public submission lands, or do you check the queue on a schedule? (Affects whether we need an email-sending Worker.)
5. **Vocabulary management** — is the current Category Type list (Career / Community / Education / Health / etc.) frozen, or do you want admins to be able to add new values? (Affects whether we add a `vocabularies` table.)
6. **Migration timing** — when's a good day for the cutover? Aim for a low-traffic window (Sunday morning UK time tends to be quietest).
7. **Backup cadence** — D1 doesn't auto-backup on the free tier. Acceptable to script a weekly export to a separate file? Or pay $5/mo for Cloudflare's hosted backups?

Answer those, and Phase 0 can start the same day.
