# Admin handbook

For people maintaining DeafHive content in Airtable. If you write code, you also want [`DATA_DICTIONARY.md`](DATA_DICTIONARY.md) and the root [`README.md`](../README.md).

## How the site flows

```
You edit a record in Airtable
       │
       ├─ flip Status → "Approved"
       │      │
       │      └─ Airtable Automation POSTs to the Worker's /purge endpoint
       │              │
       │              └─ Worker clears its 1-hour cache
       │
       └─ Anyone visiting deafhive.online
              │
              └─ Page asks the Worker → Worker fetches Airtable (or serves cache)
                     → page renders the Approved record
```

In practice: setting `Status = Approved` makes the record appear on the site within ~5 seconds. Setting it back to `Draft` makes it disappear on the **next** cache refresh, which is either when another record gets approved (triggering a purge), or up to 60 minutes later.

---

## Adding a new Organisation

1. Open the **Organisation** table in the DeafHive Database base.
2. Add a new row. Fill in **at least**:
   - `Name` — the organisation's name as it should appear on cards.
   - `Status` → start at **Draft** while you're working on it.
3. Recommended (for a good-looking card + modal):
   - `Image(s)` — drag in a logo (square or close to it works best). Will fall back to a plain navy "first-letter" tile if empty.
   - `Website` — `https://...` or just the domain. The site auto-adds `https://` if missing.
   - `Contact (public)` — public email. Shows on the modal under the "Contact by Email" button.
   - `Organisation / Service - Description` — the "About" body in the modal. Supports basic Markdown: blank lines for paragraph breaks, `**bold**`, `[link text](https://url)`, and bare URLs become clickable.
   - `Category Type` — pick from the multi-select. Drives both the Category Type filter row AND the Categories chip(s) inside the modal.
   - `Age Category` — pick from the multi-select. Drives the Age Category filter row.
4. When you're happy with how it looks, set `Status = Approved`. Check <https://deafhive.online> — the card should appear within seconds.

**Do not fill** in:
- `Email (admin)` — admin-only; not shown publicly. Use this for internal contacts.
- `Description` (the AI one) — it auto-generates from the Website URL; not currently displayed.

## Adding a new Event

1. Open the **Events** table.
2. Add a new row. Fill in at least:
   - `Event Name`
   - `Date` (set both date and time if known — events without time show as "All day")
   - `Organisation` — link to a record in the Organisation table (start typing the name; pick from the dropdown). This automatically populates the `Name (from Organisation)` Lookup field that the site reads.
   - `Status = Draft` while drafting.
3. Recommended:
   - `Event Details` — the description shown in the modal. URLs are auto-linked.
   - `Event Address` — venue address.
   - `Event Poster/Picture` — drag in a flyer/poster. Shows at the top of the modal.
4. When ready: `Status = Approved`. Check the live site (the event will appear in the calendar on the matching date; if it's in the past, switch the Time filter to "All" or "Past" to see it).

## Editing an existing record

1. Edit the field directly in Airtable.
2. Field changes don't currently re-purge the cache — only `Status` flips do. So:
   - **If the record is already Approved** and you just changed text or a field value, the change appears on the live site within 60 minutes (when the cache TTL expires) **or** sooner if any record on the same table gets re-approved (each `/purge` clears the whole table's cache, not just one record).
   - If you need the change live faster, you can do a manual purge — see "Forcing a refresh" below.

## Removing a record from the live site

Pick one:
- **Quick + reversible**: set `Status = Draft`. The record disappears on the next purge or cache expiry.
- **Permanent**: delete the row in Airtable.

## Forcing a cache refresh

If you've made urgent edits and don't want to wait:

1. Set the record's `Status` to `Draft`, then back to `Approved`. Each `Approved` flip fires the purge automation. **Or:**
2. In Airtable → Automations → find "Purge cache on Organisation Approved" (or Events) → run it manually with any approved record.

If automations aren't set up yet, the only way is to wait up to 60 minutes for the cache to expire naturally.

---

## Common problems and what to check

### "My record isn't showing on the live site"
- ✅ Is `Status` set to **`Approved`** (not `Draft` or empty)?
- ✅ For Events: does `Date` have a value? Events without a parseable date are silently skipped.
- ✅ For Events: is the time filter showing the right window? An event on a past date won't show under the default "Upcoming" filter.
- ✅ Wait ~10 seconds after flipping to Approved (the purge automation needs a moment).
- ✅ Try a hard refresh on deafhive.online (`Cmd+Shift+R` on Mac, `Ctrl+F5` on Windows) — sometimes the browser caches an old page.
- If still missing after a few minutes → check the Airtable Automation run history; if the purge automation isn't enabled or has failed, the cache may be stale.

### "An event's organisation name shows as 'recXXX...' instead of the real name"
- This means the `Name (from Organisation)` **Lookup** field on Events is broken or empty.
- Open the event row → check that the `Organisation` link points to a valid Organisation record.
- The `Name (from Organisation)` field should auto-populate. If it's blank, the linked organisation has no `Name` value.

### "Image isn't appearing on the card"
- Confirm the attachment is an **image** file (PNG, JPG, SVG). PDFs and other formats won't render.
- Try re-uploading.
- Airtable signed URLs expire 2 hours after each fetch — the Worker's cache refreshes them well within that window, so this shouldn't normally be a problem. If it is, wait an hour and try again.

### "I added a new Category Type / Age Category option but nothing changes on the site"
- Filter chips are built from the values actually present in approved records. Until at least one record uses the new option, no chip appears.

### "I can't log in to Cloudflare / I don't have access"
- Cloudflare account ownership: see "Who owns what" below.

---

## Who owns what

| Service | Account owner | What lives here |
|---|---|---|
| Airtable | (DeafHive admin team) | The DeafHive Database base, all content, automations |
| Cloudflare | (Mark Schofield) | The Worker (`directory-proxy`), DNS for deafhive.online if hosted on Cloudflare |
| GitHub | (JackoBeans) | The site code at <https://github.com/JackoBeans/deaf-hive-site> |
| Domain registrar | (Mark Schofield) | deafhive.online |

Fill these in with the actual people/teams. If any of them leaves the project, see "Handover" below.

---

## Handover checklist

When transferring custodianship to a new admin/developer:

1. **Airtable** — invite them to the DeafHive Database base as an Owner.
2. **Cloudflare** — invite them to the account as a Member with access to Workers & Pages (and DNS if applicable).
3. **GitHub** — add them as a collaborator on the `deaf-hive-site` repo.
4. **Domain registrar** — share login or move the domain to a shared account.
5. **Secrets** — rotate both Worker secrets and the Airtable PAT (see "Rotating secrets" below) so the departing person no longer has access via stored copies.

## Rotating secrets

If you suspect the Airtable PAT or the cache `PURGE_SECRET` has been exposed (committed to a public file, sent in chat, etc.):

**Airtable token:**
1. Go to <https://airtable.com/create/tokens>, find the token, click **Revoke**.
2. Create a new token with the same scope (`data.records:read` on the DeafHive Database base).
3. In Cloudflare → Workers → `directory-proxy` → Settings → Variables and Secrets → edit `AIRTABLE_TOKEN` → paste the new value → Save → Deploy.

**Purge secret:**
1. Generate a new random string: `openssl rand -hex 32` in a terminal.
2. Cloudflare dashboard: edit the `PURGE_SECRET` value → Save → Deploy.
3. Airtable → Automations → open both "Purge cache on … Approved" automations → update the `X-Purge-Token` header to the new value → Save.

(The cache itself doesn't need clearing — the next fetch after the secret rotation will work as normal. Only `/purge` requests need the new value.)

---

## Backing up data

Airtable has its own snapshot system (Base → ⚙️ → Snapshots). Take a snapshot before:
- Bulk imports/edits
- Bulk Status changes
- Deleting fields
- Major schema changes

For deeper backup, export each table as CSV periodically and store somewhere safe.

The site code is in git; the Worker code is also in git (`worker/src/index.js`). The only thing that lives ONLY in Cloudflare and ONLY in Airtable is the actual data + secrets. Plan accordingly.
