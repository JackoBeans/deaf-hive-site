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
| Cloudflare R2 | 10 GB storage, no egress fees | ~50 MB images + 0–1 GB videos (YouTube-hosted videos cost nothing) | **$0** |
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
| 0 | Cloudflare resources created, schema applied (incl. `videos` table), dev environment ready | ~1 h |
| 1 | Read-only Worker returning same JSON shape as today + new `/videos` endpoint, backed by D1 with fixture data | ~3.5 h |
| 2 | Admin UI shell — login, read-only tables for orgs + events + videos | ~3 h |
| 3 | Admin UI write — inline editing, status changes, delete, image + video upload | ~7 h |
| 4 | Public submissions — form pages (org + event + video), rate-limited POST endpoints, abuse protection | ~3.5 h |
| 5 | Migration — Airtable → D1 + R2 for orgs/events, + seed the 7 current YouTube embeds into `videos` | ~2.5 h |
| 6 | Cutover — flip `WORKER_URL`, replace hard-coded video block in `index.html` with dynamic render, monitor, hold old Worker as rollback | ~1.5 h |
| 7 | Decommission — revoke Airtable PAT, downgrade Team plan | ~30 min |
| | **Total** | **~22 h** (3–4 working days) |

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

In the Cloudflare dashboard → R2 → `deafhive-images` → Settings → Custom Domains → add `media.deafhive.online`. Set up a DNS CNAME record at your DNS provider pointing `media` → `<bucket>.r2.cloudflarestorage.com` (Cloudflare provides the exact value). Once propagated, media URLs are `https://media.deafhive.online/<key>` — permanent, CDN-cached, zero egress fees. The bucket is named `deafhive-images` for historical reasons but serves both images (`orgs/`, `events/`) and videos (`videos/`).

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

-- ── Videos ─────────────────────────────────────────────────────────────
-- A video has EITHER a youtube_url OR a video_r2_key (or both — youtube
-- preferred for embed if both set). poster_r2_key is an optional thumbnail
-- override; if absent we fall back to YouTube's thumbnail (for youtube_url
-- rows) or a generic placeholder (for R2-hosted rows without a poster).
-- organisation_id is nullable: a video can stand alone in the "Videos"
-- section, or be linked to an org (shown in the org's modal too).
CREATE TABLE videos (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'approved', 'rejected', 'draft')),
  organisation_id   INTEGER REFERENCES organisations(id) ON DELETE SET NULL,
  youtube_url       TEXT,
  video_r2_key      TEXT,      -- e.g. 'videos/2026/05/intro.mp4'
  poster_r2_key     TEXT,      -- optional poster/thumbnail override
  description       TEXT,
  display_order     INTEGER,   -- admin pin order; NULL = sort by created_at DESC
  submitted_via     TEXT NOT NULL DEFAULT 'admin'
                     CHECK (submitted_via IN ('admin', 'public')),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  -- A video MUST have at least one playable source
  CHECK (youtube_url IS NOT NULL OR video_r2_key IS NOT NULL)
);

CREATE INDEX idx_videos_status ON videos(status);
CREATE INDEX idx_videos_org    ON videos(organisation_id);
CREATE INDEX idx_videos_order  ON videos(display_order, created_at DESC);

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
  entity     TEXT NOT NULL,              -- 'organisation' | 'event' | 'video' | 'image'
  entity_id  INTEGER,
  diff_json  TEXT                        -- optional JSON of changed fields
);

CREATE INDEX idx_audit_at ON audit_log(at DESC);
```

### Schema decisions explained

- **JSON-as-text for multi-select fields** (`category_types`, `age_categories`) — avoids three-table joins for a small list. SQLite has JSON1 built in; queries like `WHERE json_extract(category_types, '$[0]') = 'Community'` work, but for our scale we'll just parse client-side.
- **R2 keys, not URLs** — store the bucket path (e.g. `orgs/2026/05/abc.jpg`), let the read API concatenate `https://media.deafhive.online/<key>` at render time. Keeps the database portable.
- **Unix timestamps as INTEGER** — D1 doesn't have a native `TIMESTAMP` type; storing seconds-since-epoch is universal.
- **`CHECK` constraints on status + submitted_via** — typo-proofs the small enum set at the database layer.
- **No vocabulary table for categories** — values are small, stable, and OK to be free text. If you ever want admin-managed dropdowns, add a `vocabularies` table later.
- **Videos: dual source + CHECK constraint** — a video row has either a `youtube_url` or an `video_r2_key` (or both, with YouTube preferred for embed). The `CHECK` at the bottom of the table prevents inserting a row with no playable source. `organisation_id` is nullable so videos can stand alone or be linked to an org. `display_order` lets admin pin the welcome video first; rows with `NULL` order fall back to `created_at DESC`.
- **R2 video size budget** — R2 free tier is 10 GB. A 10-minute 720p MP4 ≈ 100 MB, so ~100 R2-hosted videos before paid storage kicks in ($0.015/GB/month after that). YouTube-hosted videos cost nothing in R2. The admin upload endpoint caps individual video uploads at 100 MB (Workers' max request body size on free tier).

---

## Worker endpoints

The new Worker exposes ~19 routes. Below, **PUB** = no auth, **ADMIN** = requires bearer token, **SYS** = requires the existing purge secret.

### Public read endpoints (cached)

| Method | Path | Auth | Returns |
|---|---|---|---|
| `GET` | `/organisations` | PUB | `{records: [...approved orgs with public fields...]}` — same shape as today |
| `GET` | `/events` | PUB | `{records: [...approved events with public fields + joined org name...]}` |
| `GET` | `/videos` | PUB | `{records: [...approved videos, sorted by display_order then created_at DESC, with joined org name if linked...]}` |

Cache rules:
- Same Cloudflare Cache API approach as today
- TTL 1 hour for safety (R2 URLs don't expire so this is purely an optimisation now)
- `/purge` clears all three

### Public submission endpoints

| Method | Path | Auth | Body | Effect |
|---|---|---|---|---|
| `POST` | `/submissions/organisation` | PUB + rate-limit + Turnstile | JSON: org fields + optional `image_upload_id` | Inserts row with `status='pending'`, `submitted_via='public'` |
| `POST` | `/submissions/event` | PUB + rate-limit + Turnstile | JSON: event fields + optional `image_upload_id` | Same for events |
| `POST` | `/submissions/video` | PUB + rate-limit + Turnstile | JSON: `{name, description, youtube_url?, video_upload_id?, poster_upload_id?, organisation_id?}` | Inserts video row with `status='pending'`. Validates ≥1 of youtube_url/video_upload_id present. |
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
| `GET` | `/admin/videos?status=pending\|all` | List videos (filtered) |
| `GET` | `/admin/videos/:id` | Single video |
| `POST` | `/admin/videos` | Create new video (admin-direct). Body: `{name, description, youtube_url?, video_r2_key?, poster_r2_key?, organisation_id?, display_order?}`. Same CHECK as schema: ≥1 of youtube_url / video_r2_key. |
| `PUT` | `/admin/videos/:id` | Update fields |
| `DELETE` | `/admin/videos/:id` | Remove row + R2 objects (video + poster if present) |
| `POST` | `/admin/videos/:id/status` | Body `{status}` — fires `/purge` on transition to `approved` |
| `POST` | `/admin/upload` | Multipart upload to R2 — content-type drives target prefix (`image/*` → `orgs/`, `video/*` → `videos/`). Returns `{key, url}`. |
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
        "logo_url": "https://media.deafhive.online/orgs/.../bb.jpg",
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

`/videos` returns a similar shape:

```json
{
  "records": [
    {
      "id": 7,
      "fields": {
        "name": "Welcome to DeafHive",
        "description": "A short BSL introduction to the directory.",
        "youtube_url": "https://www.youtube.com/watch?v=abc123",
        "video_url": null,                                          // populated when video_r2_key set
        "poster_url": "https://media.deafhive.online/videos/.../poster.jpg",
        "organisation_id": null,
        "organisation_name": null,                                  // joined when organisation_id set
        "display_order": 1
      }
    }
  ]
}
```

The Worker derives `video_url` and `poster_url` from the R2 keys at response time — the client never touches raw bucket paths.

`app.js`'s `SECTIONS.organisations.fields` config switches from Airtable `fld...` IDs to these stable JSON keys — a 7-line change in one place. A new `SECTIONS.videos` block (similar shape) renders the dynamic Videos section, replacing the 7 hard-coded YouTube embeds currently in `index.html`.

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
    Returns { key, url: 'https://media.deafhive.online/<key>' }
                │
                ▼
   Client uses url for preview;
   key written into the row's logo_r2_key / poster_r2_key field
```

### Public-submission image handling

Public submissions upload to `pending/` namespace. On approval, the admin endpoint optionally moves the object to a permanent location via R2's `copy` + `delete`. Or leaves it — the namespace is purely organisational; R2 doesn't charge differently.

### Image cleanup

When a row is deleted, the admin endpoint also issues `env.IMAGES.delete(key)` so we don't accumulate orphans. Belt-and-braces: a periodic Worker cron (free) walks the R2 bucket's `orgs/`, `events/`, and `videos/` prefixes and removes objects no row references.

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

## Parallel build & private testing strategy

How the new site grows alongside the live one without visitors noticing a thing.

### The mental model

Only the **backend** needs to truly run "in parallel". Everything else (new admin UI, new submission form) can be deployed incrementally to the live `deafhive.online` site without affecting public visitors, as long as the homepage doesn't link to those new pages.

```
┌────────────────────────────────────────────────────────────────────┐
│ Public visitor at deafhive.online/                                 │
│                                                                    │
│   • Sees the same homepage they see today                          │
│   • Worker URL still points at directory-proxy (Airtable backend) │
│   • No "Submit" link visible anywhere yet                          │
│   • Has no idea anything is changing                               │
└────────────────────────────────────────────────────────────────────┘
                              │
                              │ same repo, same site, same DNS
                              ▼
┌────────────────────────────────────────────────────────────────────┐
│ You + admins (via specific URLs and feature flags):                │
│                                                                    │
│   deafhive.online/?staging=1                                       │
│     • Loads homepage but swaps WORKER_URL to v2                    │
│     • Shows D1-backed data, full parity verified                   │
│                                                                    │
│   deafhive.online/admin/  (password-protected)                     │
│     • New admin UI                                                  │
│     • Lives in same repo, behind login screen                      │
│     • Bots can't find it; no public link from homepage             │
│                                                                    │
│   deafhive.online/submit/  (unlinked but reachable)                │
│     • New submission form                                           │
│     • Tested by you/admins via direct URL during build             │
│     • No homepage link until launch day                            │
└────────────────────────────────────────────────────────────────────┘
```

### Mechanism 1 — backend feature flag in `app.js`

```js
// Default: production (Airtable backend, current live site)
const WORKER_URL_PRODUCTION = 'https://directory-proxy.silent-term-d0e4.workers.dev';
// Staging: new D1 backend (only loads if ?staging=1 in the URL)
const WORKER_URL_STAGING    = 'https://directory-proxy-v2.silent-term-d0e4.workers.dev';

const isStaging = new URLSearchParams(location.search).get('staging') === '1';
const WORKER_URL = isStaging ? WORKER_URL_STAGING : WORKER_URL_PRODUCTION;
```

- Public visitor at `deafhive.online/` → hits Airtable Worker (unchanged)
- You at `deafhive.online/?staging=1` → hits D1 Worker (testing the new backend)

Same HTML, CSS, JS — only the data source flips based on the URL parameter. The new Worker's CORS allowlist includes `https://deafhive.online` so the same origin works for both.

### Mechanism 2 — three layers of "private" for the admin UI

The new admin lives at `deafhive.online/admin/` (built by Phase 2–3). Layers of inaccessibility:

| Layer | What it does |
|---|---|
| No homepage link | Casual visitors don't know it exists |
| Login screen on first interaction | Typing the URL just shows a password field |
| Worker bearer-token auth | Even reaching `/admin/` doesn't grant data access without a valid token |
| `robots.txt` Disallow | Search engines won't index it |

### Mechanism 3 — submission form lives but is unlinked

`/submit/` is reachable from day one of Phase 4, but no public page links to it. You and a few testers exercise it via direct URL. On launch day, you add a "Submit an organisation" button to the homepage — that's the moment the public can find it.

### Optional upgrade — Cloudflare Pages + Access (strongest privacy)

For maximum privacy during testing (e.g., demos where you don't want anyone discovering `?staging=1`), there's a stronger option: **Cloudflare Access** wraps any URL with a login screen, restricted to specific emails. Free for up to 50 users; integrates with Google, GitHub, Microsoft, or one-time email codes.

Cloudflare Access requires the site to be behind Cloudflare DNS. Today the site is on GitHub Pages (DNS points at GitHub IPs). Moving to **Cloudflare Pages** (free, same limits as GitHub Pages, deploys from the same repo) puts the site behind Cloudflare and unlocks:

- Wrap `deafhive.online/admin/*` with Access → only specific emails get in
- Wrap `deafhive.online/?staging=1` (or a `/preview/` path) with Access → only listed testers see new-backend rendering
- Single dashboard for Pages + Workers + D1 + R2 + Access
- ~30 min one-off migration during the rebuild

Worth doing if you want belt-and-braces privacy; safe to skip if "password + no link + robots disallow" is enough.

### Visitor-visible difference during the build

At every point from "started the rebuild" through "decommissioned Airtable", a public visitor to `deafhive.online` sees:

- The same homepage layout
- The same data they see today (until cutover)
- The same data, freshly served from the new backend (after cutover)
- The same URL
- No login prompts, no redirects, no maintenance pages, no service outage

The only risky moment is the cutover itself — a 30-second GitHub Pages rebuild that swaps which Worker URL `app.js` calls.

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

## Decisions locked in

| Question | Decision |
|---|---|
| R2 custom domain | `media.deafhive.online` |
| Admin URL | `deafhive.online/admin/` (same-origin) |
| Submission URL | `deafhive.online/submit/` (same-origin) |
| Submission notifications | Yes — auto-email on each new public submission |
| Email sender | Resend (basic mode — no domain verification) |
| From address | `onboarding@resend.dev` |
| To address(es) | `mail@signingworks.co.uk` (single recipient to start; Worker secret holds a comma-separated list for fan-out later) |
| Vocabulary management | Admins can add new Category Type / Age Category values (adds a `vocabularies` table) |
| Videos feature | New dynamic Videos section, replaces the 7 hard-coded YouTube embeds. Sources: YouTube URL **or** R2-hosted file (or both). Relationship: standalone **and** optionally linked to an organisation. |
| Migration timing | Late-night low-traffic window (Sunday UK time) |
| Backup cadence | Scripted weekly export (cron Worker or local script) |

### Schema addendum: `vocabularies` table

```sql
CREATE TABLE vocabularies (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,    -- 'category_type' | 'age_category'
  value      TEXT NOT NULL,    -- e.g. 'Community'
  sort_order INTEGER NOT NULL DEFAULT 100,
  created_at INTEGER NOT NULL,
  UNIQUE (kind, value)
);
```

Admin UI gets a small "Manage vocabularies" panel inside Settings — add/remove values, drag to reorder. Submitting orgs/events pick from the live list rather than a hardcoded set.

### Resend integration

Worker dependency: `fetch` POST to `https://api.resend.com/emails` with `Authorization: Bearer <RESEND_API_KEY>`. No SDK needed.

```js
async function notifySubmission(env, { type, id, name }) {
  const to = env.NOTIFY_RECIPIENTS.split(',').map(s => s.trim());
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'DeafHive Submissions <onboarding@resend.dev>',
      to,
      subject: `DeafHive — new ${type} submission awaiting review`,
      text: `A new ${type} ("${name}") has been submitted via deafhive.online/submit.\n\nReview at: https://deafhive.online/admin/?tab=submissions&focus=${id}`,
    }),
  });
}
```

New Worker secrets to add at Phase 0:

```bash
wrangler secret put RESEND_API_KEY        # from resend.com dashboard
wrangler secret put NOTIFY_RECIPIENTS      # comma-separated emails
```

Phase 0 starts now.
