# CLAUDE.md — DeafHive

## Project

DeafHive is a UK Deaf-community public directory (organisations, BSL events, sign-language videos) at **deafhive.online**.

- Repo: `github.com/JackoBeans/deaf-hive-site`
- Local: `~/Projects/deafhive-site`
- Stack: **vanilla HTML/CSS/JS** (no framework) — static front-end on **GitHub Pages** + Cloudflare **Worker `directory-proxy-v2`** over **D1** (SQLite data) + **R2** (media)
- Admin panel: `/admin` — owner/admin roles; the protected owner (`mail@markschofield.org`) cannot be demoted or deleted

## Deploy

Push to `main` → GitHub Actions runs `scripts/prerender.mjs` (fetches live data, writes crawlable `/directory/` + `/events/` pages, bakes homepage org cards into `_site`) → deploys to Pages.

**Pages source is set to "GitHub Actions"** — not a branch. Don't change this.

The build **excludes** `worker-v2/`, `docs/`, `scripts/`, `*.md` from the served site.

## Local preview

```
preview_start deafhive-site   # serves on :4423 via python http.server
```

**Critical:** the Worker CORS allows **only** `https://deafhive.online` (localhost was deliberately removed). On local preview the directory/events data **will not load**. Workarounds:
- Use `?mockEvents=1` for the calendar
- The prerendered `/directory/` and `/events/` pages for visual structure checks
- A Node DOM-stub harness to test `app.js` logic without a browser

## DNS / security headers

Mark has **NO DNS access** for deafhive.online — the DNS zone is in a third-party Cloudflare account. Security headers (CSP/X-Frame-Options etc.) are therefore **blocked on a third party**; the per-page `<meta>` CSP is the ceiling. **Do not walk Mark through DNS/proxy/zone steps** — the DNS controller must apply the runbook in `docs/SECURITY_HEADERS.md`.

## Worker

Worker is in `worker-v2/`. Deploy via `wrangler deploy` from that directory (not from the repo root). The worker URL is `https://directory-proxy-v2.silent-term-d0e4.workers.dev`.

## Key constraints

- Email notifications are **parked** — Brevo/Resend "not currently active" per privacy notice; Mark controls no DNS so DMARC blocks single-sender options
- `og.png` (1200×630) exists at root — reference it in all OG image tags
- `apple-touch-icon.png` (180×180 opaque PNG) exists at root — reference in all `<head>` blocks
- Fonts are **self-hosted** — Raleway via `/fonts.css` + `/fonts/` — do not add Google Fonts links
