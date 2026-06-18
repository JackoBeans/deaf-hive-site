# Security response headers — Cloudflare runbook

Goal: add the HTTP security headers GitHub Pages can't send (CSP, X-Frame-Options,
X-Content-Type-Options, Permissions-Policy, a real HSTS) by routing `deafhive.online`
through Cloudflare's proxy. Target: **A+** on <https://securityheaders.com>.

## Current state (for context)
- The `deafhive.online` DNS **zone is already on Cloudflare** (nameservers
  `eric/erin.ns.cloudflare.com`).
- The records are **DNS-only ("grey cloud")**, pointing straight at GitHub Pages
  (`185.199.108–111.153`), so traffic is **browser → GitHub Pages** today
  (`server: GitHub.com`, no `cf-ray`). Cloudflare hosts the DNS but isn't in the path.
- These steps stay **in the existing Cloudflare account** — nothing moves, no
  nameserver change. **Zero-downtime and fully reversible** if done in this order.

> **Prerequisite:** dashboard access to the Cloudflare account that holds the
> `deafhive.online` zone. Everything below happens in that account.

---

## Step 1 — Set SSL/TLS mode FIRST (prevents redirect loops)
Dashboard → select **deafhive.online** → **SSL/TLS → Overview** → Encryption mode →
**Full (strict)**.

- GitHub Pages presents a valid certificate for the custom domain, so Full (strict)
  validates correctly.
- **Do NOT use Flexible** — once the record is proxied, Flexible causes an infinite
  HTTPS redirect loop (site appears broken). This is the #1 mistake; set it first.

## Step 2 — Proxy the records (grey → orange)
**DNS → Records.** Toggle the proxy ON (orange cloud = "Proxied") for:
- the four apex **`deafhive.online`** `A` records (`185.199.108/109/110/111.153`)
- the **`www`** record

Takes effect in seconds (the records already live here; no propagation wait).
After this, `curl -sI https://deafhive.online` should show a `cf-ray` header.

## Step 3 — Always-HTTPS + HSTS
**SSL/TLS → Edge Certificates:**
- **Always Use HTTPS: On**
- **HSTS → Enable HSTS:**
  - Max-Age: **12 months** (`31536000`)
  - **Include subdomains: On**
  - **Preload: On** *(optional — see note)*
  - Tick the acknowledgement boxes.

> **Commitment notes:** `includeSubDomains` means every current/future
> `*.deafhive.online` must serve HTTPS (fine today). `Preload` is a near-permanent
> "HTTPS-only forever" promise (browsers bake it in) — only enable it if you're sure;
> it's optional and **not required for an A+**. HSTS is handled here, so don't also
> add it in the Transform Rule below.

## Step 4 — Transform Rule: set the security headers
**Rules → Transform Rules → Modify Response Header → Create rule.**
- Rule name: `Security headers`
- **When incoming requests match:** *All incoming requests*
- **Then → Modify response header → Set static** — add one row per header:

| Header name | Value |
|---|---|
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), browsing-topics=()` |
| `Content-Security-Policy` | *(paste the one-line value below)* |

**Content-Security-Policy** value (tailored to the site's real assets — self-hosted
fonts, the worker API/media, YouTube embeds, Turnstile). `frame-ancestors` and
`upgrade-insecure-requests` work here as a real header (they're ignored in the
`<meta>` CSP):

```
default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; img-src 'self' data: https://i.ytimg.com https://directory-proxy-v2.silent-term-d0e4.workers.dev; style-src 'self' 'unsafe-inline'; script-src 'self' https://challenges.cloudflare.com; font-src 'self'; connect-src 'self' https://directory-proxy-v2.silent-term-d0e4.workers.dev https://challenges.cloudflare.com; frame-src https://www.youtube-nocookie.com https://challenges.cloudflare.com; form-action 'self'; upgrade-insecure-requests
```

Click **Deploy**.

> Each page also has its own tighter `<meta>` CSP. With both present the browser
> enforces the **intersection**, so this header (a superset covering every page)
> never breaks a page, and the per-page metas keep each page as tight as it already is.

---

## Step 5 — Verify
```bash
curl -sI https://deafhive.online | grep -iE 'content-security|x-frame|x-content-type|referrer-policy|permissions-policy|strict-transport|cf-ray'
```
Expect all five headers + HSTS + a `cf-ray`. Then:
- Load `https://deafhive.online`, `/submit/organisation.html`, `/admin/` and open the
  browser console → confirm **no `Refused to load … Content Security Policy`** errors
  (CSP is the easy thing to get wrong). If one asset is blocked, add just that host to
  the specific directive (e.g. another `img-src` host) — don't drop the CSP.
- Re-scan <https://securityheaders.com/?q=deafhive.online> → expect **A / A+**.

## Rollback (if anything looks wrong)
- Quickest: **DNS → set the records back to grey cloud (DNS-only)** → traffic returns
  to GitHub Pages directly, exactly as before.
- Or disable just the Transform Rule (Rules → Transform Rules → toggle off).
- HSTS is the only sticky bit: once sent with a long max-age, browsers that saw it
  will force HTTPS for that duration even after rollback (the site is HTTPS-only
  anyway, so this is harmless).

## Notes
- No GitHub-side change is needed; keep GitHub Pages "Enforce HTTPS" **on**.
- Nothing in this repo changes — the headers are added at Cloudflare's edge.
- Trade-off of staying in the current (third-party) account: the
  `media.deafhive.online` R2 custom domain stays blocked (it needs the zone and the
  R2 bucket in the same account). Unrelated to headers; media works via the worker's
  `/media` route today.
