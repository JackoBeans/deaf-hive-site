# DeafHive Cloudflare Worker

Serverless proxy between the public site and Airtable. Hides the Airtable token, caches responses for 1 hour, and exposes a `/purge` endpoint that an Airtable automation hits when a record is approved.

## One-time setup

### 1. Install Wrangler

Wrangler is Cloudflare's CLI. You need Node.js installed first.

```bash
npm install -g wrangler
wrangler login
```

The `login` command opens a browser to authorise Wrangler with your Cloudflare account.

### 2. Set the two secrets

Wrangler prompts for each value — paste it and press enter. Secrets are stored encrypted on Cloudflare; they never appear in code, in `wrangler.toml`, or in git history.

```bash
# Airtable Personal Access Token.
# Create at: https://airtable.com/create/tokens
# Scope:  data.records:read
# Access: just the DeafHive Database base (do not grant all-workspaces access)
wrangler secret put AIRTABLE_TOKEN

# Random string used to authenticate /purge requests from Airtable.
# Generate one with:
#   openssl rand -hex 32
# Save a copy locally — you will paste it into the Airtable automation later.
wrangler secret put PURGE_SECRET
```

### 3. Deploy

From inside the `worker/` directory:

```bash
wrangler deploy
```

Wrangler prints the deployed URL, e.g. `https://directory-proxy.<your-subdomain>.workers.dev`.
Copy that URL into `../app.js` as the value of `WORKER_URL`.

## Testing

Tail logs in real time (handy while you test):

```bash
wrangler tail
```

Hit the endpoints directly:

```bash
curl https://directory-proxy.<your-subdomain>.workers.dev/organisations
curl https://directory-proxy.<your-subdomain>.workers.dev/events
```

Test the purge endpoint (replace `<your-secret>` with the value you set for `PURGE_SECRET`):

```bash
curl -X POST \
     -H "X-Purge-Token: <your-secret>" \
     https://directory-proxy.<your-subdomain>.workers.dev/purge
```

Without the header (or with a wrong value) you should get a `401 Unauthorised`.

## What lives where

- `src/index.js` — the Worker code. All configuration constants are at the top: base ID, table IDs, cache TTL, allowed CORS origins.
- `wrangler.toml` — Worker name, entry point, compatibility date.

## Updating later

- **Rename the Worker.** Change `name` in `wrangler.toml`, run `wrangler deploy`. The new URL replaces the old; update `WORKER_URL` in `../app.js`.
- **Adjust cache TTL.** Edit `CACHE_TTL_SECONDS` in `src/index.js`. **Do not exceed 7200 seconds (2 hours)** — Airtable attachment URLs expire 2 hours after being fetched, so any cached image URL must still be valid when served.
- **Add a new table.** Extend the `TABLES` map in `src/index.js` with a new `path → tableId` entry, then add a matching render function on the site side.
- **Allow another origin temporarily** (e.g. for local testing): add it to `ALLOWED_ORIGINS` in `src/index.js` and redeploy. Remove it again afterwards so the Worker only serves the production site.
