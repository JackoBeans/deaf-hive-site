# worker-v2 — DeafHive D1/R2 backend

This is the new backend that will replace the Airtable-proxy Worker in
`/worker`. It's being built in parallel — the live site keeps using the old
Worker until cutover (Phase 6 in `docs/REBUILD_PLAN.md`).

## Layout

```
worker-v2/
├── wrangler.toml      ← bindings + vars + secrets reference
├── schema.sql         ← D1 schema (organisations, events, videos, …)
├── migrations/        ← numbered SQL files for future schema changes
├── src/
│   └── index.js       ← Phase 0 hello-world router (just /healthz + /probe-bindings)
└── README.md          ← this file
```

## Phase 0 — first-time setup

Run from the repo root.

### 1. Create the D1 database

```bash
wrangler d1 create deafhive
```

Wrangler prints a `database_id`. Open `worker-v2/wrangler.toml` and paste it
in place of `REPLACE_AFTER_D1_CREATE`.

### 2. Create the R2 bucket

```bash
wrangler r2 bucket create deafhive-images
```

(Name kept generic so it can hold both images and videos.)

### 3. Apply the schema

```bash
wrangler d1 execute deafhive --remote --file=worker-v2/schema.sql
```

You can also run with `--local` to apply to a local SQLite snapshot for `wrangler dev`.

### 4. Set the R2 custom domain

In the Cloudflare dashboard:

> R2 → `deafhive-images` → Settings → Custom Domains → add `media.deafhive.online`

Then add a DNS CNAME at your DNS provider per Cloudflare's instructions.
Once propagated, R2 objects are served from `https://media.deafhive.online/<key>`.

### 5. Set the secrets

Easiest: Cloudflare dashboard → Workers → `directory-proxy-v2` → Settings → Variables → Add secret.

Or via CLI (each prompts for the value):

```bash
wrangler secret put ADMIN_PASSWORD     --config worker-v2/wrangler.toml
wrangler secret put ADMIN_TOKEN_SECRET --config worker-v2/wrangler.toml
wrangler secret put PURGE_SECRET       --config worker-v2/wrangler.toml
wrangler secret put TURNSTILE_SECRET   --config worker-v2/wrangler.toml
```

(`RESEND_API_KEY` and `NOTIFY_RECIPIENTS` come later, in Phase 4.)

### 6. Deploy the hello-world

```bash
wrangler deploy --config worker-v2/wrangler.toml
```

### 7. Verify bindings

Wrangler prints the live URL (something like
`https://directory-proxy-v2.<your-subdomain>.workers.dev`). Then:

```bash
WORKER=https://directory-proxy-v2.<your-subdomain>.workers.dev

curl -s "$WORKER/healthz" | jq
# expect: { "ok": true, "version": "0.1.0-phase0" }

curl -s "$WORKER/probe-bindings" | jq
# expect: { "ok": true, "db": { "ok": true, ... }, "r2": { "ok": true, ... } }
```

If both probes return `ok: true`, Phase 0 is done. Move on to Phase 1.

## Local development

```bash
wrangler dev --config worker-v2/wrangler.toml --local --persist-to .wrangler/state
```

Local D1 and R2 are sandboxed under `.wrangler/state` — they don't touch the
live data. Apply the schema to the local sandbox once with
`wrangler d1 execute deafhive --local --file=worker-v2/schema.sql`.

## Why a separate Worker?

The old `worker/` proxies Airtable and is still serving the live site. Cutover
in Phase 6 swaps `WORKER_URL` in `app.js` from `directory-proxy` →
`directory-proxy-v2` and keeps the old Worker around as a one-line rollback.
See `docs/REBUILD_PLAN.md` → "Cutover plan" for the full procedure.
