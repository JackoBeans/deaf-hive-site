# DeafHive

The DeafHive public site — a directory of Deaf-community organisations, a BSL
events calendar, and a sign-language video archive — at <https://deafhive.online>.

Static frontend on GitHub Pages, with a Cloudflare Worker backend (`worker-v2/`)
backed by Cloudflare **D1** (database) and **R2** (media). Community members can
submit listings; staff moderate them in a private admin area.

> **History.** DeafHive originally ran on an Airtable base proxied by a Cloudflare
> Worker (`worker/`). That backend was migrated to self-hosted Cloudflare D1 + R2
> and **decommissioned in Phase 7 (2026-06-17)**. The migration record lives in
> [`docs/REBUILD_PLAN.md`](docs/REBUILD_PLAN.md) and [`docs/CUTOVER.md`](docs/CUTOVER.md).

## Architecture at a glance

```
Browser ──→ GitHub Pages (this repo)
   │           ├── /          public directory + calendar + videos  (index.html, app.js)
   │           ├── /admin/     staff moderation UI                   (admin/)
   │           └── /submit/    public submission forms               (submit/)
   │
   └── fetch() ─→ Cloudflare Worker  (worker-v2/  ·  "directory-proxy-v2")
                     ├── D1   (SQLite)  · organisations / events / videos / users / audit
                     ├── R2   (media)   · served via the Worker's GET /media/<key> route
                     └── Edge cache (1h) with purge-on-write
```

- **Frontend** (repo root): plain HTML/CSS/JS, no build step. Three areas — the
  public site, `admin/`, and `submit/`.
- **Backend** (`worker-v2/`): the only route to the data. Public read endpoints,
  authenticated admin/write endpoints, and public submission endpoints. Full setup
  in [`worker-v2/README.md`](worker-v2/README.md).
- **Data**: Cloudflare **D1** (SQLite) is the source of truth. **R2** holds images
  and posters, served through the Worker (the bucket is not public).
- **Moderation**: staff sign in at `/admin/` (multi-user, owner/admin roles).
  Public submissions arrive as *pending* and only appear once approved.

## Managing content

Day-to-day content is managed in the **admin UI at <https://deafhive.online/admin>**
— not by editing files or any third-party tool. See
[`docs/ADMIN_HANDBOOK.md`](docs/ADMIN_HANDBOOK.md) for the editor guide.

- Sign in with your email + password (self-service password reset available).
- Tabs: Organisations, Events, Videos — plus Users and Activity for owners.
- Create / edit / delete listings, upload logos and posters, and approve or reject
  community submissions.
- Every change and sign-in is recorded in an audit log (Activity tab, owners only).
- Saving a change purges the edge cache automatically, so edits appear within seconds.

## Public submissions

Anyone can propose a listing via the forms at `/submit/` (organisation, event,
video). Submissions are protected by Cloudflare Turnstile (CAPTCHA), a honeypot,
and per-IP rate limiting, and land as **pending** for staff to review.

## Local development

Preview the static frontend without deploying:

```bash
cd deafhive-site
python3 -m http.server 8000
# Visit http://localhost:8000/
```

The page talks to the live Worker (`WORKER_URL` in `app.js`), so reads work against
production data. For backend work, run the Worker locally — see
[`worker-v2/README.md`](worker-v2/README.md) → "Local development".

> **CORS.** The Worker only accepts browser calls from `https://deafhive.online`.
> A page served from `localhost` can't call the live Worker; point it at a local
> `wrangler dev` Worker instead.

## Deploying

- **Frontend**: push to `main`. GitHub Pages serves the repo root at
  `deafhive.online` (the `CNAME` file sets the custom domain).
- **Backend**: `wrangler deploy --config worker-v2/wrangler.toml`.

The frontend's `WORKER_URL` is pinned in three files, all the same value:
`app.js`, `admin/admin.js`, `submit/submit.js`.

## Worker secrets

Set via `wrangler secret put <NAME> --config worker-v2/wrangler.toml` (or the
Cloudflare dashboard → Workers → `directory-proxy-v2` → Settings → Variables):

| Secret | Purpose |
|---|---|
| `ADMIN_TOKEN_SECRET` | HMAC key for signing admin session tokens |
| `PURGE_SECRET` | bearer token for the manual `/purge` endpoint |
| `TURNSTILE_SECRET` | Cloudflare Turnstile server-side key |
| `BREVO_API_KEY` / `NOTIFY_RECIPIENTS` / `MAIL_FROM` | outbound email for submission notifications — **currently parked**, pending sender-domain DNS |

Non-secret config (cache TTL, CORS allowlist, media base URL) lives in `[vars]`
in `worker-v2/wrangler.toml`.

## Repo layout

```
deafhive-site/
├── README.md            ← this file
├── CNAME                ← deafhive.online (GitHub Pages custom domain)
├── robots.txt · sitemap.xml
├── index.html · style.css · app.js     ← public directory / calendar / videos
├── admin/               ← staff moderation UI (HTML/CSS/JS)
├── submit/              ← public submission forms (org / event / video)
├── worker-v2/           ← Cloudflare Worker backend (D1 + R2)
│   ├── wrangler.toml · schema.sql · migrations/
│   ├── src/             ← reads, admin, auth, users, submissions, media, …
│   └── README.md        ← backend setup, secrets, deploy, local dev
└── docs/
    ├── ADMIN_HANDBOOK.md    ← editor / moderation guide
    ├── DATA_DICTIONARY.md   ← field-by-field data map
    ├── REBUILD_PLAN.md      ← Airtable → D1/R2 migration plan (historical)
    └── CUTOVER.md           ← cutover runbook (historical)
```

## Free-tier ceilings to watch

| Service | Limit | Notes |
|---|---|---|
| Cloudflare Workers | 100,000 requests / day | Comfortably above public traffic; the 1h cache absorbs most reads. |
| Cloudflare D1 | 5 GB · 5M reads/day · 100k writes/day | Data is a few MB — nowhere near. |
| Cloudflare R2 | 10 GB · no egress fees | Images/posters only (videos are YouTube-hosted). |
| GitHub Pages | 100 GB bandwidth / month | Comfortable for this size of site. |

Everything runs on free tiers — no per-seat software subscription.
