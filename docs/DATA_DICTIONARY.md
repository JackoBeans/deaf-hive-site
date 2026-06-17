# Data dictionary

How each database field maps to the public site at <https://deafhive.online>. The
authoritative schema is [`worker-v2/schema.sql`](../worker-v2/schema.sql) (plus the
numbered files in `worker-v2/migrations/`); the client-side field mapping is in
`SECTIONS` / `EVENTS_CONFIG` in `app.js`.

Data lives in **Cloudflare D1** (SQLite). Media (logos, posters, video files) lives
in **Cloudflare R2**; tables store an R2 *key* (e.g. `orgs/2026/05/abc.jpg`) and the
Worker serves the object at `GET /media/<key>`.

## How "public" is enforced

Defence in depth — three layers in the Worker (`worker-v2/src/`):

1. **Status filter.** The public read endpoints return only rows with
   `status = 'approved'`. Pending / Draft / Rejected never leave the Worker.
2. **Column selection.** Read handlers (`reads.js`) select only the public columns
   below and resolve R2 keys into `*_url` links. Admin-only columns (e.g.
   `email_admin`) are never put into the public JSON, so they can't appear in
   view-source.
3. **CORS.** The Worker only answers browser requests from `https://deafhive.online`.

R2 is **not a public bucket** — media is reachable only through the Worker's
`/media/<key>` route.

---

## Table: `organisations`

The community directory. Each `approved` row is a card in the directory.

### Public fields

| Column | Type | Surfaces on the site |
|---|---|---|
| `name` | text | Card title · modal title · case-insensitive search. |
| `logo_r2_key` → `logo_url` | R2 key → URL | Card thumbnail · modal logo. Falls back to a navy monogram of the first letter if empty. |
| `about` | long text | "About" body in the modal. Rendered through a safe Markdown converter (paragraphs · **bold** · `[text](url)` · bare URLs become links). |
| `website` | text (URL) | "Visit Website" button. `https://` is auto-prefixed if missing. |
| `email_public` | text (email) | "Contact by Email" button + shown as text in the modal. |
| `category_types` | JSON array | (a) Category filter row above the grid. (b) Category chips in the modal. |
| `age_categories` | JSON array | Age filter row above the grid. |

### Admin-only (never sent to the public)

| Column | Type | Purpose |
|---|---|---|
| `status` | `pending`/`approved`/`rejected`/`draft` | Visibility. Public endpoint returns `approved` only. |
| `email_admin` | text | Internal contact — never exposed. |
| `address` | text | Stored, but the current card/modal design doesn't render org addresses. Wire it into `reads.js` + `app.js` to surface it. |
| `submitted_via` | `admin`/`public` | Whether staff or a public submission created the row. |
| `id`, `created_at`, `updated_at` | int | Internal. |

---

## Table: `events`

The BSL events calendar. Each `approved` row with a valid `event_date` appears.

### Public fields

| Column | Type | Surfaces on the site |
|---|---|---|
| `name` | text | Calendar pill · agenda/modal title · search. |
| `event_date` | ISO 8601 datetime | Which day the event lands on. With a time, shown formatted (e.g. "19:30"); otherwise "All day". |
| `organisation_id` → `organisation_name` | FK → joined name | The Worker joins `organisations.name` and returns it as `organisation_name`: org badge in the modal · org line in the agenda · option in the Organisation filter. The raw `organisation_id` is **not** sent to the browser. |
| `address` | long text | Address row in the modal (map-pin icon); line breaks preserved. |
| `details` | long text | "Event Details" body in the modal; URLs auto-link. Part of the search index. |
| `poster_r2_key` → `poster_url` | R2 key → URL | Poster at the top of the event modal. Section hidden when empty. |

### Admin-only

| Column | Type | Purpose |
|---|---|---|
| `status` | enum | Visibility (as above). |
| `organisation_id` | FK → `organisations(id)` | Used server-side to join the org name; the raw ID isn't exposed. `ON DELETE SET NULL`. |
| `submitted_via` | `admin`/`public` | Source of the row. |
| `id`, `created_at`, `updated_at` | int | Internal. |

---

## Table: `videos`

The sign-language video archive. A row must have **either** a `youtube_url` **or** a
`video_r2_key` (DB-enforced).

### Public fields

| Column | Type | Surfaces on the site |
|---|---|---|
| `name` | text | Video title. |
| `youtube_url` | text (URL) | Embedded via `youtube-nocookie` when present (preferred). |
| `video_r2_key` → `video_url` | R2 key → URL | Self-hosted playback when there's no YouTube URL. |
| `poster_r2_key` → `poster_url` | R2 key → URL | Thumbnail override. Without it, YouTube rows use YouTube's thumbnail. |
| `description` | text | Shown with the video. |
| `organisation_id` | FK (nullable) | If set, the video also appears inside that organisation's modal. Standalone (null) videos appear only in the Videos section. |
| `display_order` | int (nullable) | Admin pin order — lower sorts first. `NULL` ⇒ newest-first (`created_at DESC`). |

### Admin-only

`status` (visibility), `submitted_via`, `id`, `created_at`, `updated_at`.

---

## Supporting tables (internal — never public)

These back the admin system and abuse-protection. None are reachable from the
public site.

| Table | Purpose |
|---|---|
| `users` | Admin accounts. `email`, `password_hash` (PBKDF2-SHA256, 100k iter — see `auth.js`), `role` (`owner`/`admin`), `status` (`active`/`disabled`), `last_login_at`. |
| `password_resets` | SHA-256 hashes of issued reset tokens (never the raw token). Single-use (`used_at`), expiring, with a `source` of `forgot_password` or `owner_created`. |
| `submission_quota` | Per-IP rate-limit buckets for public submissions and login. Key is a **SHA-256 of the client IP** — no raw IP / PII stored. |
| `audit_log` | Append-only trail: `actor`, `action` (create/update/delete/approve/reject/login/…), `entity`, `entity_id`, optional `diff_json`. Surfaced read-only in the owner-only Activity tab. |

---

## How to make a new field public

All layers must cooperate:

1. **Schema** — add the column via a new `worker-v2/migrations/NNNN-*.sql`, then
   `wrangler d1 execute deafhive --remote --file=…`.
2. **Worker** — include the column in the public `SELECT` in
   `worker-v2/src/reads.js` (and in the admin write path / edit-form schema if it
   should be editable), then `wrangler deploy --config worker-v2/wrangler.toml`.
3. **Site** — reference it in `SECTIONS` / `EVENTS_CONFIG` in `app.js` (or add a
   render function), then push to GitHub Pages.

Saving any record in the admin UI clears the public cache, so new data appears
within seconds once the Worker and site are deployed.
