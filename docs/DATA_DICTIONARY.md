# Airtable data dictionary

How each field in the **DeafHive Database** Airtable base maps to the public site at <https://deafhive.online>. Field IDs are pinned in the Worker's `fields[]` allowlist (`worker/src/index.js`) and in `EVENTS_CONFIG` / `SECTIONS` in `app.js`.

**Base ID**: `app0JwQ5lgCrRJ00M`

The Worker only ever fetches the fields listed under **Public** below — admin-only fields are excluded server-side and never travel to the browser.

---

## Table: `Organisation` (`tblvtUmdlXXHGDj0l`)

The community directory. Each Approved row appears as a card in the "DeafHive Community Directory" section.

### Public fields

| Field | ID | Type | Surfaces on the site |
|---|---|---|---|
| `Name` | `fld4bfPSAbKzFECtJ` | Single line text | Card title · modal title · case-insensitive substring search input |
| `Image(s)` | `fldttGzEhgV9NUCBs` | Attachment | Card thumbnail (uses `thumbnails.large.url`) · modal logo (uses original `url`). Falls back to a navy monogram of the first letter if empty. |
| `Website` | `fld4mNGInMTVA1jag` | URL | Yellow "Visit Website" button in modal. Auto-prefixed with `https://` if missing. |
| `Contact (public)` | `fldYmHVYnc6wnIZjj` | Email | Outlined "Contact by Email" button + email shown as text in modal. |
| `Organisation / Service - Description` | `fldFXsrljrnYXfM8N` | Long text (multiline) | "About" section in modal. Rendered through a safe Markdown converter (paragraphs · **bold** · bare URLs become clickable · `[text](url)` becomes a link). |
| `Category Type` | `fldes1yumsDCD1rtB` | Multi-select | (a) Chip filter row above the card grid. (b) Categories chips shown in the modal. |
| `Age Category` | `fldOHinxLA1zPEobA` | Multi-select | Chip filter row above the card grid. |

### Admin-only (never fetched by the Worker)

| Field | ID | Type | Purpose |
|---|---|---|---|
| `Status` | `fldfUXFb877KVYzvr` | Single select (`Approved` / `Draft`) | Used **server-side** by the Worker's `filterByFormula={Status}='Approved'`. Records not set to `Approved` are filtered out before the response leaves Airtable. The field is intentionally not in the `fields[]` allowlist — the formula still evaluates against it. |
| `Email (admin)` | `fldrKWH3HpVXVqoA3` | Text | Admin contact, never exposed. |
| `Events` | `fldQMklkkLLmtId4i` | Linked records → Events | Reverse link from Events; not used publicly. |
| `Description` (aiText) | `fld93ijODwW9SroWL` | AI-generated text | Auto-summary from the Website URL. Currently not displayed — `Organisation / Service - Description` is the live "About" field. |
| `Organisation Address` | `fldt4ZfRmKlXaN76p` | Long text (multiline) | Present in Airtable but **not rendered** on the site (the redesigned card/modal layout drops physical address for Organisations). If you want it back, add the field ID to the Worker allowlist and to the org modal. |

---

## Table: `Events` (`tblffh6BKb8ZO3QGg`)

The BSL events archive. Each Approved row with a valid `Date` appears in the calendar.

### Public fields

| Field | ID | Type | Surfaces on the site |
|---|---|---|---|
| `Event Name` | `fldoBpajSR36bVUvO` | Single line text | Calendar pill title · agenda card title · modal title · part of the search index. |
| `Date` | `fldhcuE2MS7apCNat` | Date + time | Determines which day cell the event lands in. If time is set, shown formatted (e.g. "19:30"). If not, shown as "All day". |
| `Event Details` | `fldt13ci6IUl7KpvC` | Long text (multiline) | "Event Details" body in the modal. URLs are auto-linked; line breaks preserved. Searched as part of the search index. |
| `Event Address` | `fldVa5avzI8lFE1NL` | Long text (multiline) | Address row in the modal with a map-pin icon. Multi-line addresses render with line breaks. |
| `Name (from Organisation)` | `fldS9rjbFoHAJ4M1I` | Lookup → text (from Organisation `Name`) | Yellow organisation badge(s) in the modal · org line in agenda card · option in the Organisation filter dropdown · part of the search index. **This must remain a Lookup field** — the raw linked-record field (`Organisation` / `fldYoWk07WWcvM4eL`) returns record IDs like `recXXX`, which would show as garbage in the UI. |
| `Event Poster/Picture` | `fldwC5PJAa0KUpUgv` | Attachment | Poster image at the top of the event-detail modal's left column. Falls back to "no poster" gracefully — section hidden when empty. |

### Admin-only (never fetched by the Worker)

| Field | ID | Type | Purpose |
|---|---|---|---|
| `Status` | `fldgL0tG8UBlEqElL` | Single select (`Approved` / `Draft`) | Worker filter (same as Organisation Status). |
| `Organisation` | `fldYoWk07WWcvM4eL` | Linked records → Organisation | Raw link; **not** sent to the browser. The Lookup field `Name (from Organisation)` is what the site reads. |
| Various lookups (`Website`, `Age Category`, `Category Type`, `Description`, `Email (public)`, `Image(s)` from Organisation) | several `fld...` | Lookup | Useful for Airtable views; not currently surfaced on the site. Could be wired up if event cards/modals need richer info from the linked org. |
| Legacy / draft fields (`Event Name:`, `End Date`, `Event Time:`, `Event Location / Venue:`, `Event Contact Details:`, `Event Description:`, `Event Date (from Event Dates)`, `Organisation 2`, `From field: Event Description:`, `Event Details (from Event Description:)`, `Do the following event(s) have:`) | various | various | Looks like leftover work-in-progress fields from earlier iterations of the Events table. None are read by the site. Safe to clean up in Airtable when convenient. |

---

## Table: `Event Dates` (`tblEq7ExO4idhHtEL`)

A linked support table for events with multiple occurrence dates. **Not currently used by the public site** — the site reads the primary `Date` field on Events directly. Could be useful in the future if recurring events become a feature.

## Table: `Role Models` (`tbluqCumz1dt3snED`)

Currently the role-model card on the site (the "David" card under "See It. Believe It. Be It.") is **hardcoded** in `index.html`. This Airtable table exists but isn't wired up — would require new section logic in `app.js` to make it Airtable-driven.

## Table: `BSL Videos` (`tblnMir6CEHaZQd6p`)

Internal asset tracking table (status: Todo / In progress / Done). Not exposed on the site.

---

## How "public field" gets enforced

Defence in depth — fields are gated at three points:

1. **Worker `fields[]` allowlist** (`worker/src/index.js`, the `TABLES` map). The Worker asks Airtable for only the listed fields. Anything not listed is never fetched and so never reaches the browser at all.
2. **CORS** (`ALLOWED_ORIGINS` in the same file). The Worker only responds to browser requests from `https://deafhive.online` (currently also `http://localhost:4423` for dev — should be removed before broader public).
3. **Status formula** (`filterByFormula` in the Worker). Only records with `Status = Approved` are returned.

To make a new field public, all three layers cooperate:

1. Add the field ID to `TABLES.<endpoint>.fields` in `worker/src/index.js` and `wrangler deploy`.
2. Reference the field in `app.js` (`SECTIONS.organisations.fields`, `EVENTS_CONFIG.fields`, or a new render function).
3. Push the site change to GitHub Pages.

A `/purge` from Airtable will pick up the new data within seconds once the Worker is redeployed.
