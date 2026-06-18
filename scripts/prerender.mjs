#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════
// prerender.mjs — build-time prerender for crawler / no-JS visibility (SEO).
//
// The homepage directory + events are rendered client-side from the Worker,
// so crawlers that don't run JS (Bing, social scrapers, most AI bots) see an
// empty page. This script fetches the live data and writes real static HTML:
//
//   <out>/directory/index.html  — full organisations listing  (/directory/)
//   <out>/events/index.html     — full events listing         (/events/)
//   <out>/index.html            — homepage with org cards baked into
//                                 #organisations-list (app.js replaceChildren()s
//                                 it for JS users) + a <noscript> events fallback
//
// It operates on a COPY of the site (the out dir), never the source tree, so
// nothing generated is committed. Run from CI (see .github/workflows/deploy.yml)
// or locally against a throwaway dir:
//
//   cp -R <site> /tmp/build && node scripts/prerender.mjs /tmp/build
//
// Usage: node scripts/prerender.mjs <outDir>
// Env:   WORKER_URL (defaults to the production worker)
// ════════════════════════════════════════════════════════════════════════

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const OUT = process.argv[2];
if (!OUT) {
  console.error('Usage: node scripts/prerender.mjs <outDir>');
  process.exit(1);
}
const WORKER = (process.env.WORKER_URL || 'https://directory-proxy-v2.silent-term-d0e4.workers.dev').replace(/\/$/, '');
const SITE = 'https://deafhive.online';

// ── Tiny helpers ────────────────────────────────────────────────────────
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Strip light markdown/URLs to plain text, collapse whitespace, truncate.
const plain = (s, max = 240) => {
  let t = String(s ?? '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')   // [text](url) -> text
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length > max) t = t.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
  return t;
};

const asArray = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch { return []; } }
  return [];
};

const httpsUrl = (u) => {
  const s = String(u ?? '').trim();
  if (!s) return '';
  return /^https?:\/\//i.test(s) ? s : 'https://' + s;
};

const fmtDate = (iso) => {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London',
  }).format(d);
};

async function fetchRecords(path) {
  const res = await fetch(`${WORKER}${path}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  const json = await res.json();
  const recs = Array.isArray(json) ? json : (json.records || json.data || []);
  return recs.map((r) => ({ id: r.id, ...(r.fields || r) }));
}

// ── Page shell (self-contained: own CSP, canonical, meta, inline style) ───
function shell({ path, title, description, bodyClass, main, jsonld }) {
  const canonical = `${SITE}${path}`;
  return `<!DOCTYPE html>
<html lang="en-GB">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: ${WORKER}; connect-src 'self' ${WORKER}; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'">
  <meta name="referrer" content="strict-origin-when-cross-origin">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <link rel="canonical" href="${esc(canonical)}">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:url" content="${esc(canonical)}">
  <meta property="og:image" content="${SITE}/og.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Raleway:wght@400;600;700&amp;display=swap">
  <style>
    :root { --navy:#1a2f6e; --paper:#f4f4f0; --ink:#1a2f6e; --muted:#4a4a4a; --line:rgba(28,45,96,0.14); }
    * { box-sizing: border-box; }
    body { margin:0; font-family:'Raleway',system-ui,sans-serif; color:var(--ink); background:var(--paper); line-height:1.55; }
    .wrap { max-width: 900px; margin: 0 auto; padding: 32px 20px 64px; }
    .crumb { font-size:.9rem; margin:0 0 8px; }
    .crumb a { color:var(--navy); }
    h1 { font-size: clamp(1.6rem, 4vw, 2.2rem); margin: 0 0 6px; }
    .lede { color:var(--muted); margin: 0 0 28px; max-width: 60ch; }
    .item { padding: 20px 0; border-top: 1px solid var(--line); }
    .item h2, .item h3 { margin: 0 0 6px; font-size: 1.2rem; }
    .item p { margin: 6px 0; }
    .meta { color:var(--muted); font-size:.92rem; }
    .tags { display:flex; flex-wrap:wrap; gap:6px; margin:8px 0 0; padding:0; list-style:none; }
    .tags li { font-size:.78rem; background:rgba(28,45,96,0.08); border-radius:999px; padding:3px 10px; }
    a { color:#1d3bbe; }
    .home { display:inline-block; margin-top:36px; font-weight:600; }
    .logo { float:right; width:64px; height:64px; object-fit:contain; margin:0 0 8px 16px; border-radius:8px; background:#fff; }
  </style>
</head>
<body class="${bodyClass}">
  <main class="wrap">
${main}
    <a class="home" href="/">← Back to deafhive.online</a>
  </main>
  <script type="application/ld+json">${jsonld.replace(/</g, '\\u003c')}</script>
</body>
</html>
`;
}

// ── Organisations ─────────────────────────────────────────────────────────
function orgItemHtml(o) {
  const cats = [...asArray(o.category_types), ...asArray(o.age_categories)];
  const website = httpsUrl(o.website);
  const logo = o.logo_url ? `<img class="logo" src="${esc(o.logo_url)}" alt="" width="64" height="64" loading="lazy">` : '';
  return `    <article class="item" id="org-${esc(o.id)}">
      ${logo}<h2>${esc(o.name)}</h2>
      ${o.about ? `<p>${esc(plain(o.about, 400))}</p>` : ''}
      ${website ? `<p class="meta"><a href="${esc(website)}" rel="noopener nofollow">${esc(website.replace(/^https?:\/\//, ''))}</a></p>` : ''}
      ${o.email_public ? `<p class="meta">${esc(o.email_public)}</p>` : ''}
      ${o.address ? `<p class="meta">${esc(o.address)}</p>` : ''}
      ${cats.length ? `<ul class="tags">${cats.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
    </article>`;
}

function buildDirectoryPage(orgs) {
  const sorted = [...orgs].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const main = `    <p class="crumb"><a href="/">Home</a> › Directory</p>
    <h1>Deaf-community organisations directory</h1>
    <p class="lede">${sorted.length} Deaf-led and Deaf-serving organisations across the UK — services, support and community groups.</p>
${sorted.map(orgItemHtml).join('\n')}`;
  const jsonld = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'DeafHive community directory',
    numberOfItems: sorted.length,
    itemListElement: sorted.map((o, i) => ({
      '@type': 'ListItem', position: i + 1,
      item: { '@type': 'Organization', name: o.name, ...(httpsUrl(o.website) ? { url: httpsUrl(o.website) } : {}), ...(o.logo_url ? { logo: o.logo_url } : {}) },
    })),
  });
  return shell({
    path: '/directory/',
    title: 'Directory of Deaf organisations — DeafHive',
    description: 'Browse the DeafHive directory of Deaf-led and Deaf-serving organisations, services and community groups across the UK.',
    bodyClass: 'page-directory', main, jsonld,
  });
}

// ── Events ────────────────────────────────────────────────────────────────
function eventItemHtml(e) {
  return `    <article class="item">
      <h3>${esc(e.name)}</h3>
      <p class="meta"><time datetime="${esc(e.event_date)}">${esc(fmtDate(e.event_date))}</time>${e.organisation_name ? ` · ${esc(e.organisation_name)}` : ''}</p>
      ${e.address ? `<p class="meta">${esc(e.address)}</p>` : ''}
      ${e.details ? `<p>${esc(plain(e.details, 280))}</p>` : ''}
    </article>`;
}

function buildEventsPage(events, now) {
  const valid = events.filter((e) => e.event_date && !isNaN(new Date(e.event_date)));
  const upcoming = valid.filter((e) => new Date(e.event_date) >= now).sort((a, b) => new Date(a.event_date) - new Date(b.event_date));
  const past = valid.filter((e) => new Date(e.event_date) < now).sort((a, b) => new Date(b.event_date) - new Date(a.event_date));
  const main = `    <p class="crumb"><a href="/">Home</a> › Events</p>
    <h1>BSL events calendar</h1>
    <p class="lede">British Sign Language events, classes and community gatherings across the UK.</p>
    <h2>Upcoming events</h2>
${(upcoming.length ? upcoming.map(eventItemHtml).join('\n') : '    <p class="item">No upcoming events listed right now.</p>')}
${past.length ? `    <h2 style="margin-top:40px">Past events</h2>\n${past.slice(0, 100).map(eventItemHtml).join('\n')}` : ''}`;
  const jsonld = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'DeafHive BSL events',
    numberOfItems: upcoming.length,
    itemListElement: upcoming.map((e, i) => ({
      '@type': 'ListItem', position: i + 1,
      item: { '@type': 'Event', name: e.name, startDate: e.event_date, ...(e.organisation_name ? { organizer: { '@type': 'Organization', name: e.organisation_name } } : {}) },
    })),
  });
  return shell({
    path: '/events/',
    title: 'BSL events calendar — DeafHive',
    description: 'Upcoming British Sign Language events, classes and community gatherings across the UK, listed on DeafHive.',
    bodyClass: 'page-events', main, jsonld,
  });
}

// ── Homepage injection (between sentinel comments) ────────────────────────
function injectBetween(html, tag, replacement) {
  const open = `<!--PRERENDER:${tag}-->`;
  const close = `<!--/PRERENDER:${tag}-->`;
  const i = html.indexOf(open);
  const j = html.indexOf(close);
  if (i === -1 || j === -1) { console.warn(`! sentinel ${tag} not found in index.html — skipping`); return html; }
  return html.slice(0, i + open.length) + '\n' + replacement + '\n          ' + html.slice(j);
}

function homepageOrgCards(orgs) {
  // Mirrors app.js's card shape (logo + name). app.js replaceChildren()s
  // #organisations-list on load, so this is the crawler / pre-hydration view.
  const sorted = [...orgs].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return sorted.map((o) => {
    const logo = o.logo_url
      ? `<span class="airtable-card-logo"><img src="${esc(o.logo_url)}" alt="" width="120" height="120" loading="lazy"></span>`
      : `<span class="airtable-card-logo airtable-card-logo--empty" aria-hidden="true">${esc(String(o.name).trim().charAt(0).toUpperCase())}</span>`;
    return `          <a class="airtable-card" href="/directory/#org-${esc(o.id)}">${logo}<span class="airtable-card-name">${esc(o.name)}</span></a>`;
  }).join('\n');
}

function homepageEventsFallback(events, now) {
  const valid = events.filter((e) => e.event_date && !isNaN(new Date(e.event_date)) && new Date(e.event_date) >= now)
    .sort((a, b) => new Date(a.event_date) - new Date(b.event_date)).slice(0, 15);
  const items = valid.map((e) => `<li><strong>${esc(e.name)}</strong> — <time datetime="${esc(e.event_date)}">${esc(fmtDate(e.event_date))}</time>${e.organisation_name ? ` (${esc(e.organisation_name)})` : ''}</li>`).join('\n            ');
  // <noscript>: invisible to JS users (who get the live calendar), read by no-JS crawlers.
  return `        <noscript>
          <p>Upcoming BSL events — <a href="/events/">see the full events calendar</a>:</p>
          <ul>
            ${items || '<li>See the <a href="/events/">events calendar</a>.</li>'}
          </ul>
        </noscript>`;
}

// ── Main ──────────────────────────────────────────────────────────────────
(async () => {
  console.log(`prerender → ${OUT}  (worker: ${WORKER})`);
  const [orgs, events] = await Promise.all([fetchRecords('/organisations'), fetchRecords('/events')]);
  const now = new Date();
  console.log(`  fetched ${orgs.length} organisations, ${events.length} events`);

  // Dedicated pages
  await mkdir(join(OUT, 'directory'), { recursive: true });
  await mkdir(join(OUT, 'events'), { recursive: true });
  await writeFile(join(OUT, 'directory', 'index.html'), buildDirectoryPage(orgs));
  await writeFile(join(OUT, 'events', 'index.html'), buildEventsPage(events, now));
  console.log('  wrote /directory/ and /events/');

  // Homepage injection
  let home = await readFile(join(OUT, 'index.html'), 'utf8');
  home = injectBetween(home, 'orgs', homepageOrgCards(orgs));
  home = injectBetween(home, 'events', homepageEventsFallback(events, now));
  await writeFile(join(OUT, 'index.html'), home);
  console.log('  injected homepage fallbacks');

  // Sitemap — add the generated pages to the BUILT artifact only, so the
  // committed sitemap never references pages that don't exist yet.
  try {
    const smPath = join(OUT, 'sitemap.xml');
    let sm = await readFile(smPath, 'utf8');
    if (!sm.includes(`${SITE}/directory/`)) {
      const today = new Date().toISOString().slice(0, 10);
      const entry = (p) => `  <url>\n    <loc>${SITE}${p}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.8</priority>\n  </url>\n`;
      sm = sm.replace('</urlset>', entry('/directory/') + entry('/events/') + '</urlset>');
      await writeFile(smPath, sm);
      console.log('  updated sitemap.xml');
    }
  } catch (e) { console.warn('  sitemap update skipped:', e.message); }

  console.log('done.');
})().catch((err) => { console.error('prerender failed:', err.message); process.exit(1); });
