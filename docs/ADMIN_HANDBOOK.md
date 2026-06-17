# Admin handbook

For people maintaining DeafHive content. Everything is managed in the **admin UI
at <https://deafhive.online/admin>** — there's no spreadsheet or third-party tool
to log into. If you also write code, see [`DATA_DICTIONARY.md`](DATA_DICTIONARY.md)
and the root [`README.md`](../README.md).

## How the site flows

```
You sign in at deafhive.online/admin
       │
       ├─ create / edit a record  → saved to the database (Cloudflare D1)
       │      │
       │      └─ saving clears the public site's cache automatically
       │
       └─ set Status → "Approved"
              │
              └─ Anyone visiting deafhive.online sees Approved records only
                     (Pending / Draft / Rejected stay hidden)
```

In practice: when you save a change in the admin UI it clears the public cache for
you, so edits appear on **deafhive.online within a few seconds**. (No manual purge,
no automation to babysit — that was the old Airtable setup.)

Only records with **Status = Approved** are shown publicly. Everything else
(Pending, Draft, Rejected) is invisible to the public.

---

## Signing in

1. Go to <https://deafhive.online/admin>.
2. Enter your **email** and **password** and click **Sign in**.
3. First time, or forgotten it? Click **Forgot password?** → enter your email →
   you'll get a reset link (see [Password resets](#password-resets) below).

Sign-in is rate-limited: after about 10 failed attempts the form locks you out for
~15 minutes. If you see "Too many sign-in attempts", wait and try again.

## The admin screen

- **Tabs**: Organisations · Events · Videos. Owners also see **Users** and
  **Activity**.
- **Status filter** (top-left): show All, or just Pending / Approved / Rejected /
  Draft. Set it to **Pending** to find new community submissions waiting for review.
- **+ New**: create a record in the current tab.
- **↻ Refresh**: reload the table.
- Each row has a **✏️ edit** and **🗑 delete** action; click a row's **status
  badge** to move it through the status cycle (see below).

## Status — how approving works

Every Organisation, Event and Video has a status: **Pending → Approved → Rejected →
Draft**.

- **The public only ever sees `Approved`.**
- **Community submissions** arrive as **Pending**.
- **To approve**: click the row's status badge — it cycles
  `Pending → Approved → Rejected → (back to Pending)`. Or open the record (✏️) and
  set **Status** in the form. A confirmation may appear for destructive flips.
- **Draft** is for things you're still working on — saved but never shown publicly.

After you set something to Approved, the public cache is cleared automatically, so
it appears on the live site within seconds.

---

## Adding / editing an Organisation

Open the **Organisations** tab → **+ New** (or ✏️ an existing row). Fields:

| Field | Notes |
|---|---|
| **Name** *(required)* | As it should appear on the card and modal title. Also powers search. |
| **Status** | Start at **Draft** while working; set **Approved** to publish. |
| **About (Markdown)** | The "About" body in the modal. Supports basic Markdown: blank lines for paragraphs, `**bold**`, `[link text](https://url)`, and bare URLs become clickable. |
| **Logo** | Upload an image (square works best). Falls back to a navy monogram of the first letter if empty. |
| **Website** | `https://…` or just the domain — `https://` is added automatically. Shows as the "Visit Website" button. |
| **Public contact email** | Shown publicly as the "Contact by Email" button. |
| **Admin email (private)** | Internal contact — **never shown on the site**. |
| **Address** | Stored, but not currently shown on Organisation cards/modals. |
| **Category Types** | Tick any of: Community, Education, Sports, Faith, Arts, Health, Support. Drives the Category filter row **and** the chips in the modal. |
| **Age Categories** | Tick any of: Children (0-12), Young people (13-24), Adults (25-59), Seniors (60+), All ages. Drives the Age filter row. |

## Adding / editing an Event

Open the **Events** tab → **+ New**. Fields:

| Field | Notes |
|---|---|
| **Event name** *(required)* | Calendar pill + modal title. |
| **Status** | Draft while drafting; Approved to publish. |
| **Date & time** *(required)* | Determines which day the event lands on in the calendar. With a time set it shows e.g. "19:30"; without, "All day". |
| **Organisation** | Pick an existing organisation from the picker. The org's name then shows as a badge on the event. |
| **Address** | Venue address — shown in the modal with a map-pin icon. |
| **Details** | Description in the modal; URLs auto-link. |
| **Poster** | Upload a flyer/poster — shown at the top of the event modal. |

> A past-dated event won't show under the calendar's default "Upcoming" filter —
> switch the time filter to "All" or "Past" to see it.

## Adding / editing a Video

Open the **Videos** tab → **+ New**. Fields:

| Field | Notes |
|---|---|
| **Title** *(required)* | Video title. |
| **Status** | Draft / Approved as above. |
| **YouTube URL** | A YouTube link — the usual case. Provide **this or** a video file. |
| **Video file (R2)** | Upload a video file directly instead of YouTube. (At least one of YouTube URL / video file is required.) |
| **Poster (optional)** | Thumbnail override. Without it, YouTube videos use YouTube's thumbnail. |
| **Description** | Shown with the video. |
| **Organisation (optional)** | If set, the video also appears in that organisation's modal. |
| **Pin order (lower = first)** | Optional number to pin a video higher in the list. Leave blank to sort newest-first. |

## Uploading images and video

Logos, posters and video files upload straight from the edit form to the project's
own media storage (Cloudflare R2) and are served back through the site — there are
no expiring links to worry about. Use ordinary image formats (PNG/JPG/WebP) for
logos and posters.

## Reviewing community submissions

The public can propose listings via the **Submit** forms (`/submit/`). These arrive
as **Pending** with "Via: public" in the table.

1. Set the **Status filter** to **Pending**.
2. Open each one (✏️), check the details, fix anything if needed.
3. **Approve** (it goes live) or **Reject** (it stays hidden) via the status badge
   or the edit form.

Submissions are already spam-filtered (CAPTCHA + honeypot + rate limiting), but you
are the final gate — nothing a stranger submits appears publicly until you approve it.

## Removing a record from the live site

- **Quick + reversible**: set **Status = Draft** (or Rejected). It disappears from
  the public site on the next save/cache clear.
- **Permanent**: click **🗑 Delete** on the row and confirm. This also removes its
  uploaded image/poster.

## Forcing a refresh

Normally unnecessary — saving in the admin UI clears the public cache for you. If
the live site ever looks stale, re-save the record (or wait up to the cache TTL,
currently 1 hour, for it to refresh on its own).

---

## Users (owners only)

The **Users** tab is visible to **owners** only.

- **Add a user**: **+ New** → email, optional display name, role, and an initial
  password (or generate a reset link for them — see below).
- **Roles**: **owner** (full access, including Users + Activity) or **admin**
  (manage content, but not other users).
- **Disable** a user by setting their Status to **disabled** — they keep their row
  and history but can't sign in.
- **Protected owner**: `mail@markschofield.org` is locked. It can't be deleted,
  demoted, or disabled through the UI or the API — a deliberate lockout-proof guard
  so the site can never be left with no owner.

## Password resets

Three ways, all in the UI:

1. **Change your own** — header → **Change password** (enter current + new).
2. **Forgot password** — on the sign-in screen → **Forgot password?** → enter your
   email → use the reset link. Links are single-use and expire in 24 hours.
3. **Owner-created link** — in the **Users** tab an owner can generate a reset link
   for any user and share it out-of-band (in person, SMS, etc.). Also single-use,
   24-hour expiry.

> Email delivery of reset links is currently **parked** (pending sender-domain
> DNS), so for now use option 3: an owner generates the link and passes it to the
> person directly.

## Activity log (owners only)

The **Activity** tab is a read-only audit trail (owners only). It records every
create / edit / delete / approve / reject, plus successful and failed sign-ins —
with who did it, when, what type of record, and which one. Use it to see what
changed and by whom.

---

## Common problems and what to check

### "My record isn't showing on the live site"
- ✅ Is **Status = Approved** (not Draft/Pending/Rejected)?
- ✅ For Events: does it have a **Date & time**? Events without a valid date are skipped.
- ✅ For Events: is the calendar's time filter on the right window? A past event won't show under "Upcoming".
- ✅ Give it ~10 seconds after approving, then hard-refresh deafhive.online (`Cmd+Shift+R` / `Ctrl+F5`).

### "An event shows no organisation"
- Open the event and confirm an **Organisation** is selected in the picker.

### "I added a logo/poster but it's not appearing"
- Confirm it's an image file (PNG/JPG/WebP). Re-open the record and re-upload if needed.

### "I added a new Category but no filter chip appeared"
- Filter chips are built from values actually used by **approved** records. The chip
  appears once at least one approved organisation uses that category.

### "I can't see the Users / Activity tabs"
- Those are owner-only. Ask an owner to change your role if you need them.

---

## Who owns what

| Service | Account owner | What lives here |
|---|---|---|
| Cloudflare | (Mark Schofield) | The Worker (`directory-proxy-v2`), the D1 database, the R2 media bucket |
| GitHub | (JackoBeans) | The site code at <https://github.com/JackoBeans/deaf-hive-site> |
| Domain registrar | (Mark Schofield) | deafhive.online (DNS is managed in a third-party Cloudflare account) |

Fill in the actual people/teams. If anyone leaves, see Handover below.

## Handover checklist

When transferring custodianship:

1. **Cloudflare** — invite the new person to the account with access to Workers,
   D1, and R2 (and DNS if applicable).
2. **GitHub** — add them as a collaborator on the `deaf-hive-site` repo.
3. **Admin user** — create an admin (or owner) account for them in the Users tab.
4. **Domain registrar** — share access or move the domain to a shared account.
5. **Secrets** — rotate the Worker secrets (below) so a departing person's stored
   copies stop working.

## Backing up data

The data lives in Cloudflare D1; media lives in R2. Both are recoverable, but take
your own copies before anything risky (bulk edits, deletions, schema changes):

```bash
# Full database export to a SQL file
wrangler d1 export deafhive --remote --output=deafhive-backup.sql --config worker-v2/wrangler.toml
```

The site and Worker code are in git. The only things that live **only** in
Cloudflare are the actual data (D1), the media (R2), and the secrets — back those
up accordingly.

## Rotating secrets

If you suspect a Worker secret has been exposed, overwrite it (Cloudflare can't show
you an existing secret's value — you can only replace it):

```bash
wrangler secret put ADMIN_TOKEN_SECRET --config worker-v2/wrangler.toml   # invalidates all sessions
wrangler secret put PURGE_SECRET       --config worker-v2/wrangler.toml
wrangler secret put TURNSTILE_SECRET   --config worker-v2/wrangler.toml
```

Rotating `ADMIN_TOKEN_SECRET` signs everyone out (they just sign in again). See the
secrets table in the root [`README.md`](../README.md) for what each one does.
