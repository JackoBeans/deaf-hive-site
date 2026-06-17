# worker-v2 — DeafHive D1/R2 backend

The DeafHive backend: a Cloudflare Worker (`directory-proxy-v2`) over Cloudflare
**D1** (data) and **R2** (media). This is the live backend — it replaced the
original Airtable-proxy Worker (`worker/`), which was **decommissioned in Phase 7
(2026-06-17)**. Migration history is in `docs/REBUILD_PLAN.md` and
`docs/CUTOVER.md`.

> The "Phase 0 — first-time setup" steps below are the original scaffolding
> instructions, kept as a from-scratch reference. The resources they create (D1
> database `deafhive`, R2 bucket `deafhive-images`, secrets) already exist in
> production.

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

## History — why "v2"?

This was built in parallel with the original Airtable-proxy Worker (`worker/`),
which kept serving the live site until cutover. Cutover (Phase 6) swapped
`WORKER_URL` in `app.js` from `directory-proxy` → `directory-proxy-v2`; the old
Worker was held briefly as a one-line rollback, then deleted in Phase 7. See
`docs/REBUILD_PLAN.md` → "Cutover plan" for the procedure that was followed.
