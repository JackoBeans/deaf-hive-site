/**
 * DeafHive Cloudflare Worker
 *
 * A serverless proxy between the public DeafHive site and Airtable.
 * - Hides the Airtable PAT (kept as an encrypted secret, never in code).
 * - Caches Airtable responses for 1 hour using Cloudflare's Cache API so
 *   we stay well under the Airtable free-tier limit (1,000 calls/month).
 * - Exposes a /purge endpoint that an Airtable automation calls when a
 *   record's Status flips to Approved, so admin changes appear within seconds.
 *
 * Endpoints:
 *   GET  /organisations  → approved rows from the Organisations table
 *   GET  /events         → approved rows from the Events table
 *   POST /purge          → clears both caches (requires X-Purge-Token header)
 */

// ─── Configuration ────────────────────────────────────────────────────────

const AIRTABLE_BASE_ID = 'app0JwQ5lgCrRJ00M';   // DeafHive Database

// Each endpoint maps to one Airtable table and an explicit allowlist of
// PUBLIC field IDs. The Worker passes these as `fields[]=...` to Airtable
// so admin-only fields (e.g. internal email) are never fetched in the
// first place, let alone returned to the public site.
//
// To add a new public field: add its `fld...` ID here AND wire it into
// the site (app.js' SECTIONS / EVENTS_CONFIG).
const TABLES = {
  '/organisations': {
    id: 'tblvtUmdlXXHGDj0l',                 // Organisation table
    fields: [
      'fld4bfPSAbKzFECtJ', // Name
      'fldttGzEhgV9NUCBs', // Image(s) — attachment, used as logo
      'fld4mNGInMTVA1jag', // Website
      'fldYmHVYnc6wnIZjj', // Contact (public) — email
      'fldFXsrljrnYXfM8N', // Organisation / Service - Description (used as "About")
      'fldes1yumsDCD1rtB', // Category Type (multi-select, drives filter + Categories chips)
      'fldOHinxLA1zPEobA', // Age Category (multi-select)
    ],
  },
  '/events': {
    id: 'tblffh6BKb8ZO3QGg',                 // Events table
    fields: [
      'fldoBpajSR36bVUvO', // Event Name
      'fldhcuE2MS7apCNat', // Date (dateTime)
      'fldt13ci6IUl7KpvC', // Event Details
      'fldVa5avzI8lFE1NL', // Event Address
      'fldS9rjbFoHAJ4M1I', // Name (from Organisation) — Lookup that returns the linked org's name
      'fldwC5PJAa0KUpUgv', // Event Poster/Picture (attachment)
    ],
  },
};

// Cache TTL in seconds.
// IMPORTANT: must stay BELOW 7200 (2 hours). Airtable attachment URLs expire
// 2 hours after being returned by the API, so cached image URLs must still
// be valid when served. 1 hour gives a safe margin.
const CACHE_TTL_SECONDS = 3600;

// CORS — only these origins are allowed to call the Worker from a browser.
// `http://localhost:4423` is the local Python http.server used for previews;
// REMOVE before going to production to avoid leaving a dev-only origin on
// the live Worker forever.
const ALLOWED_ORIGINS = [
  'https://deafhive.online',
  'http://localhost:4423',   // TODO: remove before public launch
];

// Public visibility filter. Both tables are assumed to have a "Status"
// single-select with the value "Approved". TODO confirm for Events.
const APPROVED_FORMULA = "{Status}='Approved'";

// ─── Main handler ─────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    // Preflight CORS request — browsers send OPTIONS before the real request.
    if (request.method === 'OPTIONS') {
      return preflightResponse(origin);
    }

    // Cache-purge endpoint (called by the Airtable automation).
    if (request.method === 'POST' && url.pathname === '/purge') {
      return handlePurge(request, env, url, origin);
    }

    // Data endpoints.
    if (request.method === 'GET' && TABLES[url.pathname]) {
      return handleTableFetch(request, env, ctx, url, origin);
    }

    return jsonResponse({ error: 'Not found' }, 404, origin);
  },
};

// ─── Data fetch with edge caching ─────────────────────────────────────────

async function handleTableFetch(request, env, ctx, url, origin) {
  const cache = caches.default;
  // Cache key is the URL itself (origin + path). Use a GET Request as the key.
  const cacheKey = new Request(url.toString(), { method: 'GET' });

  // Try the edge cache first. On a hit, we re-apply CORS headers (the cached
  // response was stored without an origin-specific Allow-Origin header).
  const cached = await cache.match(cacheKey);
  if (cached) {
    return withCors(cached, origin);
  }

  // Cache miss — fetch from Airtable, paginating through all pages.
  const config = TABLES[url.pathname];
  let allRecords;
  try {
    allRecords = await fetchAllPages(config, env.AIRTABLE_TOKEN);
  } catch (err) {
    return jsonResponse(
      { error: err.message || 'Upstream error' },
      err.status || 502,
      origin,
    );
  }

  const body = JSON.stringify({ records: allRecords });
  const response = new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
    },
  });

  // Write into the edge cache without blocking the response to the user.
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return withCors(response, origin);
}

// ─── Airtable pagination ──────────────────────────────────────────────────
//
// Airtable returns at most 100 records per page; if more exist it returns
// an "offset" cursor that we feed back to fetch the next page. We loop
// until there is no more offset.
//
// `returnFieldsByFieldId=true` makes Airtable key each record's `fields`
// object by field ID instead of field name. This means renaming a field
// in Airtable won't break the site — the site references field IDs only.

async function fetchAllPages(config, token) {
  const { id: tableId, fields } = config;
  const records = [];
  let offset = null;

  do {
    const params = new URLSearchParams({
      filterByFormula: APPROVED_FORMULA,
      returnFieldsByFieldId: 'true',
      pageSize: '100',
    });
    if (offset) params.set('offset', offset);
    // Allowlist of fields to return. Admin-only fields are excluded server-side
    // so they never travel through the Worker. Note: `filterByFormula` still
    // works against fields not in this list — Airtable evaluates the formula
    // before applying the fields filter.
    (fields || []).forEach(id => params.append('fields[]', id));

    const apiUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${tableId}?${params}`;
    const res = await fetch(apiUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status === 429) {
      const err = new Error('Airtable is rate-limiting requests. Try again shortly.');
      err.status = 429;
      throw err;
    }
    if (!res.ok) {
      const err = new Error(`Airtable returned status ${res.status}`);
      err.status = 502;
      throw err;
    }

    let data;
    try {
      data = await res.json();
    } catch {
      const err = new Error('Malformed response from Airtable');
      err.status = 502;
      throw err;
    }

    records.push(...(data.records || []));
    offset = data.offset || null;
  } while (offset);

  return records;
}

// ─── Cache purge ──────────────────────────────────────────────────────────
//
// Called by an Airtable automation when a record's Status flips to Approved.
// Protected by a shared secret in the X-Purge-Token header.

async function handlePurge(request, env, url, origin) {
  const provided = request.headers.get('X-Purge-Token');
  if (!provided || provided !== env.PURGE_SECRET) {
    return jsonResponse({ error: 'Unauthorised' }, 401, origin);
  }

  const cache = caches.default;
  const purged = [];
  for (const path of Object.keys(TABLES)) {
    const cacheKey = new Request(`${url.origin}${path}`, { method: 'GET' });
    const deleted = await cache.delete(cacheKey);
    if (deleted) purged.push(path);
  }
  return jsonResponse({ purged }, 200, origin);
}

// ─── CORS helpers ─────────────────────────────────────────────────────────

function isAllowedOrigin(origin) {
  return ALLOWED_ORIGINS.includes(origin);
}

function corsHeaders(origin) {
  const headers = { 'Vary': 'Origin' };
  if (isAllowedOrigin(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

function preflightResponse(origin) {
  const headers = {
    ...corsHeaders(origin),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Purge-Token',
    'Access-Control-Max-Age': '86400',
  };
  return new Response(null, { status: 204, headers });
}

function withCors(response, origin) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders(origin))) {
    headers.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonResponse(payload, status, origin) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin),
    },
  });
}
