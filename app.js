/**
 * DeafHive client-side script.
 *
 * Two parts:
 *   1. Page chrome — nav toggle, smooth-scroll links, video modal.
 *      Carried over (unchanged in behaviour) from the original page.
 *   2. Airtable rendering — fetches the Worker's /organisations and /events
 *      endpoints, builds chip-pill filter rows, renders card grids.
 *
 * The Worker URL must be filled in below before the page can load data.
 */

// Raleway is now self-hosted (see /fonts.css) with font-display: swap, so the
// old async font-swap shim that promoted a print-only Google Fonts <link> is
// no longer needed.

// ════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ════════════════════════════════════════════════════════════════════════

// The deployed Cloudflare Worker backed by D1 + R2. No trailing slash.
const WORKER_URL = 'https://directory-proxy-v2.silent-term-d0e4.workers.dev';

/**
 * Per-section configuration.
 *
 * Field keys are the stable snake_case column names the D1-backed Worker
 * returns (e.g. `name`, `logo_url`, `category_types`) — see
 * worker-v2/src/db.js for the canonical list.
 *
 * `fields` is a NAMED map (title, logo, about, website, email, categories).
 * Each name has one job; if a field is null/missing the relevant UI bit
 * is skipped without breaking the rest.
 */
const SECTIONS = {
  organisations: {
    endpoint: '/organisations',
    listElId: 'organisations-list',
    filtersElId: 'organisations-filters',
    searchElId: 'organisations-search',
    countElId: 'organisations-count',
    emptyMessage: 'No organisations match your filters.',
    nounSingular: 'organisation',
    nounPlural: 'organisations',
    fields: {
      title:      'name',
      logo:       'logo_url',        // plain URL string (R2-hosted)
      about:      'about',
      website:    'website',
      email:      'email_public',
      categories: 'category_types',  // string array — same field powers the filter
    },
    // Case-insensitive substring search over this field. null = no search input.
    searchField: 'name',
    // Chip-pill filter rows, in display order.
    filterFields: [
      { id: 'category_types', label: 'Category Type' },
      { id: 'age_categories', label: 'Age Category' },
    ],
  },
};

// Events live in a separate module (see EVENTS BLOCK section at the bottom)
// because they need a calendar/views model that doesn't fit the card grid.
const EVENTS_CONFIG = {
  endpoint: '/events',
  fields: {
    eventName:    'name',
    date:         'event_date',         // ISO 8601 string
    organisation: 'organisation_name',  // joined org name, plain string
    details:      'details',
    address:      'address',
    poster:       'poster_url',         // plain URL string (R2-hosted)
  },
};

// ════════════════════════════════════════════════════════════════════════
// PAGE CHROME (nav, smooth scroll, video modal)
// Carried over from the original single-file page.
// ════════════════════════════════════════════════════════════════════════

(function pageChrome() {
  const scrollTargets = ['#about', '#directory-embed', '#events', '#role-models'];
  const siteNav = document.getElementById('site-nav');
  const navToggle = document.getElementById('nav-toggle');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  if ('scrollRestoration' in history) {
    history.scrollRestoration = 'manual';
  }

  // Strip any hash that would auto-scroll the user past the hero on load.
  if (scrollTargets.includes(window.location.hash)) {
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  window.addEventListener('load', function () {
    window.scrollTo(0, 0);
  });

  function setNavOpen(isOpen) {
    if (!siteNav || !navToggle) return;
    siteNav.classList.toggle('is-open', isOpen);
    navToggle.setAttribute('aria-expanded', String(isOpen));
    navToggle.setAttribute('aria-label', isOpen ? 'Close navigation menu' : 'Open navigation menu');
  }

  if (navToggle && siteNav) {
    navToggle.addEventListener('click', function () {
      setNavOpen(!siteNav.classList.contains('is-open'));
    });
  }

  function scrollSectionIntoView(section) {
    if (!section || !siteNav) return;
    const gap = 20;
    const targetTop = section.getBoundingClientRect().top + window.scrollY;
    const scrollTop = Math.max(0, targetTop - siteNav.getBoundingClientRect().height - gap);
    window.scrollTo({
      top: scrollTop,
      behavior: reducedMotion.matches ? 'auto' : 'smooth',
    });
  }

  document.addEventListener('click', function (event) {
    const trigger = event.target.closest('a[data-scroll-target]');
    if (!trigger) return;
    const targetSelector = trigger.getAttribute('data-scroll-target');
    const targetSection = targetSelector ? document.querySelector(targetSelector) : null;
    if (!targetSection) return;
    event.preventDefault();
    if (trigger.closest('#site-nav')) {
      setNavOpen(false);
    }
    scrollSectionIntoView(targetSection);
  });

  window.addEventListener('resize', function () {
    if (window.innerWidth > 768) {
      setNavOpen(false);
    }
  });

  // ── Video modal ──
  // The standard modal mechanics (is-open class, focus restore, inert
  // siblings, backdrop click, Escape) come from createModalAPI; the
  // populate/cleanup hooks below handle the bits that ARE unique to
  // video — creating/removing the YouTube iframe, and copying the role-
  // card bio into the modal's side panel.
  const videoModal = document.getElementById('video-modal');
  const videoModalFrame   = videoModal ? videoModal.querySelector('.video-modal-frame') : null;
  const videoModalDetails = videoModal ? videoModal.querySelector('.video-modal-details') : null;
  const videoModalName    = videoModal ? videoModal.querySelector('.video-modal-name')    : null;
  const videoModalBio     = videoModal ? videoModal.querySelector('.video-modal-bio')     : null;

  function videoModalPopulate(id, title, invoker) {
    // Tell createModalAPI to abort the open if the iframe slot is missing —
    // otherwise it would lock the page behind an empty modal.
    if (!videoModalFrame) return false;
    // Replace any previous iframe with a fresh one (forces a clean YouTube load).
    const existing = videoModalFrame.querySelector('iframe');
    if (existing) existing.remove();
    const iframe = document.createElement('iframe');
    iframe.src = 'https://www.youtube-nocookie.com/embed/' + id + '?autoplay=1&rel=0';
    iframe.title = title;
    iframe.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share');
    iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    iframe.setAttribute('allowfullscreen', '');
    videoModalFrame.appendChild(iframe);

    // If the click came from a role-model card, clone its name + bio into
    // the modal's side panel. Otherwise hide the side panel.
    const card = invoker ? invoker.closest('.role-card') : null;
    if (card && videoModalDetails && videoModalName && videoModalBio) {
      const nameEl = card.querySelector('.role-card-name');
      const bioEl  = card.querySelector('.role-card-bio');
      videoModalName.textContent = nameEl ? nameEl.textContent : title;
      videoModalBio.replaceChildren();
      if (bioEl) {
        Array.from(bioEl.childNodes).forEach(node => {
          videoModalBio.appendChild(node.cloneNode(true));
        });
      }
      videoModalDetails.hidden = false;
      videoModalDetails.scrollTop = 0;
    } else if (videoModalDetails) {
      videoModalDetails.hidden = true;
      if (videoModalName) videoModalName.textContent = '';
      if (videoModalBio) videoModalBio.replaceChildren();
    }
  }

  function videoModalCleanup() {
    if (!videoModalFrame) return;
    const iframe = videoModalFrame.querySelector('iframe');
    if (iframe) iframe.remove();  // Stops the video + frees the network connection.
    if (videoModalDetails) {
      videoModalDetails.hidden = true;
      if (videoModalName) videoModalName.textContent = '';
      if (videoModalBio) videoModalBio.replaceChildren();
    }
  }

  const videoModalAPI = createModalAPI(videoModal, {
    populate: videoModalPopulate,
    cleanup:  videoModalCleanup,
  });

  // Document-level click handler just spots .video-facade buttons and
  // opens the modal — close-button click, backdrop click, and Escape are
  // all handled inside createModalAPI.
  document.addEventListener('click', function (event) {
    const facade = event.target.closest('.video-facade');
    if (!facade) return;
    event.preventDefault();
    const id = facade.dataset.id;
    if (!id) return;
    if (videoModalAPI) videoModalAPI.open(id, facade.dataset.title || '', facade);
  });
}());

// ════════════════════════════════════════════════════════════════════════
// AIRTABLE RENDERING
// ════════════════════════════════════════════════════════════════════════

// The org-detail modal is wired up once at startup; the API is reused for
// every Organisations card click.
const orgModalAPI = setupOrgModal();

(function airtableSections() {
  // Only Organisations runs through the generic section flow.
  // Events has its own block at the bottom of this file.
  initSection(SECTIONS.organisations, record => {
    if (orgModalAPI) orgModalAPI.open(record, SECTIONS.organisations);
  });
}());

/**
 * Initialise a section:
 *   - fetches records from the Worker,
 *   - builds the search input + chip filters from the loaded data,
 *   - renders the card grid (each card optionally clickable),
 *   - updates the result count on every filter/search change.
 *
 * If the section's `fields.title` is null we treat the section as
 * not-yet-configured and show a friendly placeholder.
 */
// Fetch a Worker endpoint and return its records array (or throw on a non-OK
// response / network error). The organisations and events blocks share this
// fetch+parse shell; each caller keeps its own error UI and post-processing.
async function fetchWorkerRecords(endpoint) {
  const res = await fetch(WORKER_URL + endpoint, { method: 'GET' });
  if (!res.ok) throw new Error('Worker returned status ' + res.status);
  const data = await res.json();
  return Array.isArray(data.records) ? data.records : [];
}

async function initSection(section, onCardClick) {
  const listEl = section.listElId ? document.getElementById(section.listElId) : null;
  if (!listEl) return;

  const filtersEl = section.filtersElId ? document.getElementById(section.filtersElId) : null;
  const searchEl  = section.searchElId  ? document.getElementById(section.searchElId)  : null;
  const countEl   = section.countElId   ? document.getElementById(section.countElId)   : null;

  if (!section.fields || !section.fields.title) {
    setStatus(listEl, 'Display fields not yet configured for this section.');
    return;
  }

  if (WORKER_URL.includes('TODO-fill-in')) {
    setStatus(listEl, 'Worker URL not configured yet. See app.js.', true);
    return;
  }

  let records;
  try {
    records = await fetchWorkerRecords(section.endpoint);
  } catch (err) {
    setStatus(listEl, 'Could not load — please try again later.', true);
    console.error('[' + section.endpoint + '] fetch failed:', err);
    return;
  }

  // Structured data (JSON-LD) for search engines — built from the records
  // we just fetched. Wrapped so a schema bug can never break rendering.
  if (section.endpoint === '/organisations') {
    try { injectOrganisationSchema(records); }
    catch (err) { console.warn('organisation schema injection failed', err); }
  }

  // Filter state: Map<fieldId, Set<value>>. OR within a field, AND across fields.
  const selected = new Map();
  (section.filterFields || []).forEach(f => selected.set(f.id, new Set()));
  let searchTerm = '';

  function rerender() {
    const filtered = applyFilters(records, selected, searchTerm, section);
    renderRecords(listEl, filtered, section, onCardClick);
    if (countEl) {
      countEl.textContent = formatCount(filtered.length, section);
      countEl.hidden = false;
    }
  }

  if (filtersEl && (section.filterFields || []).length > 0) {
    buildFilters(filtersEl, section.filterFields, records, selected, rerender);
    filtersEl.hidden = false;
  }

  if (searchEl && section.searchField) {
    searchEl.addEventListener('input', () => {
      searchTerm = searchEl.value.trim().toLowerCase();
      rerender();
    });
    searchEl.hidden = false;
  }

  rerender();

  const sectionEl = listEl.closest('.airtable-section');
  if (sectionEl) sectionEl.setAttribute('aria-busy', 'false');
}

/**
 * Apply the active filters AND the search term to the record list.
 * OR within a multi-select filter, AND across different filter fields.
 */
function applyFilters(records, selected, searchTerm, section) {
  return records.filter(record => {
    // Chip filters
    for (const [fieldId, chosen] of selected) {
      if (chosen.size === 0) continue;
      const recordValues = toValueArray(record.fields && record.fields[fieldId]);
      if (!recordValues.some(v => chosen.has(v))) return false;
    }
    // Text search
    if (searchTerm && section.searchField) {
      const haystack = String(
        (record.fields && record.fields[section.searchField]) || ''
      ).toLowerCase();
      if (!haystack.includes(searchTerm)) return false;
    }
    return true;
  });
}

function formatCount(n, section) {
  return `Showing ${n} ${n === 1 ? section.nounSingular : section.nounPlural}`;
}

/**
 * Build chip-pill filter rows by gathering unique values from the records.
 * `onChange` is invoked whenever a chip is toggled.
 */
function buildFilters(filtersEl, filterFields, records, selected, onChange) {
  filtersEl.replaceChildren();

  // Disclosure: on mobile (≤768px, CSS-gated) the chip rows collapse behind a
  // "Filters" toggle so the directory is visible immediately; on desktop they
  // stay fully visible. The search input lives outside filtersEl, so it's always
  // shown. When collapsed, active selections appear as removable chips.
  const panelId = (filtersEl.id || 'filters') + '-panel';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'filters-toggle';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', panelId);
  const toggleText = document.createElement('span');
  toggleText.textContent = 'Filters';
  const badge = document.createElement('span');
  badge.className = 'filters-toggle-badge';
  badge.hidden = true;
  const chevron = document.createElement('span');
  chevron.className = 'filters-toggle-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.textContent = '▾';
  toggle.append(toggleText, badge, chevron);

  const active = document.createElement('div');
  active.className = 'filters-active';
  active.setAttribute('role', 'group');
  active.setAttribute('aria-label', 'Active filters');

  const panel = document.createElement('div');
  panel.className = 'filters-panel';
  panel.id = panelId;

  // fieldId\0value -> main chip element, so removing an active chip syncs it.
  const chipEls = new Map();
  const keyOf = (fieldId, value) => `${fieldId} ${value}`;

  filterFields.forEach(field => {
    const values = uniqueValues(records, field.id);
    if (values.length === 0) return;

    const row = document.createElement('div');
    row.className = 'airtable-filter-row';
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', field.label);

    const label = document.createElement('span');
    label.className = 'airtable-filter-label';
    label.textContent = field.label;
    row.appendChild(label);

    values.forEach(value => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'airtable-chip';
      chip.textContent = value;
      chip.setAttribute('aria-pressed', 'false');
      chip.addEventListener('click', () => {
        const set = selected.get(field.id);
        const turnOn = !set.has(value);
        if (turnOn) set.add(value); else set.delete(value);
        chip.setAttribute('aria-pressed', String(turnOn));
        onChange();
        updateSummary();
      });
      chipEls.set(keyOf(field.id, value), chip);
      row.appendChild(chip);
    });

    panel.appendChild(row);
  });

  function clearOne(fieldId, value) {
    selected.get(fieldId).delete(value);
    const chip = chipEls.get(keyOf(fieldId, value));
    if (chip) chip.setAttribute('aria-pressed', 'false');
    onChange();
    updateSummary();
  }

  // Rebuild the removable active-chip row + the toggle badge count.
  function updateSummary() {
    active.replaceChildren();
    let count = 0;
    filterFields.forEach(field => {
      selected.get(field.id).forEach(value => {
        count += 1;
        const tag = document.createElement('button');
        tag.type = 'button';
        tag.className = 'filters-active-chip';
        tag.setAttribute('aria-label', `Remove filter ${field.label}: ${value}`);
        tag.appendChild(document.createTextNode(value));
        const x = document.createElement('span');
        x.className = 'filters-active-x';
        x.setAttribute('aria-hidden', 'true');
        x.textContent = '×';
        tag.appendChild(x);
        tag.addEventListener('click', () => clearOne(field.id, value));
        active.appendChild(tag);
      });
    });
    badge.textContent = String(count);
    badge.hidden = count === 0;
  }

  toggle.addEventListener('click', () => {
    const open = filtersEl.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', String(open));
  });

  filtersEl.append(toggle, active, panel);
  updateSummary();
}

/** Render the card grid. Empty list → status message instead. */
function renderRecords(listEl, records, section, onCardClick) {
  listEl.replaceChildren();
  if (records.length === 0) {
    setStatus(listEl, section.emptyMessage);
    return;
  }
  records.forEach(record => {
    listEl.appendChild(buildCard(record, section, onCardClick));
  });
}

/**
 * Build a single card. If `onCardClick` is provided the card is a button
 * (keyboard- and screen-reader-friendly); otherwise it's a plain div.
 *
 * The card shows the logo (from an attachment field; falls back to a
 * first-letter monogram) and the organisation/event name. The full record
 * is shown in the modal that opens on click.
 */
function buildCard(record, section, onCardClick) {
  const title = String((record.fields && record.fields[section.fields.title]) || '');

  const card = document.createElement(onCardClick ? 'button' : 'div');
  if (onCardClick) {
    card.type = 'button';
    card.addEventListener('click', () => onCardClick(record));
    card.setAttribute('aria-label', title);
  }
  card.className = 'airtable-card';

  // ─ Logo (or empty monogram fallback) ─
  const logoEl = document.createElement('div');
  logoEl.className = 'airtable-card-logo';
  const logoUrl = section.fields.logo
    ? getAttachmentUrl(record.fields && record.fields[section.fields.logo], 'thumbnail')
    : null;
  if (logoUrl) {
    const img = document.createElement('img');
    img.src = logoUrl;
    img.alt = '';
    img.loading = 'lazy';
    logoEl.appendChild(img);
  } else {
    // Fallback: a navy-bordered white circle with up to 3 initials.
    logoEl.classList.add('airtable-card-logo--empty');
    const monogram = document.createElement('span');
    monogram.className = 'monogram';
    monogram.textContent = getInitials(title);
    monogram.setAttribute('aria-hidden', 'true'); // card already has aria-label with the full name
    logoEl.appendChild(monogram);
  }
  card.appendChild(logoEl);

  // ─ Name ─
  const name = document.createElement('div');
  name.className = 'airtable-card-name';
  name.textContent = title;
  card.appendChild(name);

  return card;
}

// ════════════════════════════════════════════════════════════════════════
// ORGANISATION DETAIL MODAL
// ════════════════════════════════════════════════════════════════════════

/**
 * Wire up the org-detail modal once and return { open, close } handlers.
 * Open/close behaviour comes from createModalAPI; we just plug in a
 * populate hook that fills the DOM from the record data.
 */
function setupOrgModal() {
  const modal = document.getElementById('org-modal');
  if (!modal) return null;
  const els = {
    title:        document.getElementById('org-modal-title'),
    logo:         document.getElementById('org-modal-logo'),
    contact:      document.getElementById('org-modal-contact'),
    aboutSection: document.getElementById('org-modal-about-section'),
    about:        document.getElementById('org-modal-about'),
    catsSection:  document.getElementById('org-modal-categories-section'),
    categories:   document.getElementById('org-modal-categories'),
  };
  return createModalAPI(modal, {
    populate: (record, section) => populateOrgModal(els, record, section),
  });
}

/** Populate the modal DOM from a record. Hides empty sections. */
function populateOrgModal(els, record, section) {
  const f = section.fields;
  const fields = (record && record.fields) || {};
  const title = String(fields[f.title] || '');

  if (els.title) els.title.textContent = title;

  // Logo (prefer original URL — more space in the modal than the card)
  if (els.logo) {
    els.logo.replaceChildren();
    els.logo.classList.remove('org-modal-logo-box--empty');
    const url = f.logo ? getAttachmentUrl(fields[f.logo], 'full') : null;
    if (url) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      els.logo.appendChild(img);
    } else {
      // Same monogram fallback as the card, scaled up for the modal box.
      els.logo.classList.add('org-modal-logo-box--empty');
      const monogram = document.createElement('span');
      monogram.className = 'monogram';
      monogram.textContent = getInitials(title);
      monogram.setAttribute('aria-hidden', 'true'); // modal title carries the org name
      els.logo.appendChild(monogram);
    }
  }

  // Contact box (Visit Website + Contact by Email)
  if (els.contact) {
    els.contact.replaceChildren();
    const website = f.website ? safeUrl(String(fields[f.website] || '')) : null;
    const email   = f.email   ? safeEmail(String(fields[f.email] || '')) : null;

    if (website) {
      const a = document.createElement('a');
      a.className = 'btn-yellow';
      a.href = website;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = 'Visit Website';
      els.contact.appendChild(a);
    }
    if (email) {
      const a = document.createElement('a');
      a.className = 'btn-outline';
      a.href = 'mailto:' + email;
      a.textContent = 'Contact by Email';
      els.contact.appendChild(a);

      const p = document.createElement('p');
      p.className = 'org-modal-email';
      const a2 = document.createElement('a');
      a2.href = 'mailto:' + email;
      a2.textContent = email;
      p.appendChild(a2);
      els.contact.appendChild(p);
    }
    els.contact.hidden = !(website || email);
  }

  // About (Markdown → DOM)
  if (els.about && els.aboutSection) {
    els.about.replaceChildren();
    const aboutText = f.about ? String(fields[f.about] || '') : '';
    if (aboutText.trim()) {
      renderMarkdown(aboutText, els.about);
      els.aboutSection.hidden = false;
    } else {
      els.aboutSection.hidden = true;
    }
  }

  // Categories (multi-select values rendered as static chips)
  if (els.categories && els.catsSection) {
    els.categories.replaceChildren();
    const cats = f.categories ? toValueArray(fields[f.categories]) : [];
    if (cats.length > 0) {
      cats.forEach(value => {
        const chip = document.createElement('span');
        chip.className = 'org-modal-category';
        chip.textContent = value;
        els.categories.appendChild(chip);
      });
      els.catsSection.hidden = false;
    } else {
      els.catsSection.hidden = true;
    }
  }
}

// ════════════════════════════════════════════════════════════════════════
// MARKDOWN RENDERER (safe, DOM-based)
// ════════════════════════════════════════════════════════════════════════
//
// Supports the small subset Airtable's rich-text long-text emits:
//   - Paragraphs (blank lines separate)
//   - Bullet lists (lines starting with "- " or "* ")
//   - **bold**
//   - [link text](https://url)  and bare http(s) URLs
//   - Soft line breaks (single \n inside a paragraph → <br>)
//
// We never use innerHTML and we validate every URL through safeUrl(), so
// the rendered output is restricted to a known-safe tag set: p, ul, li,
// strong, a, br. Anything else flows through as plain text.

function renderMarkdown(text, container) {
  const blocks = text.split(/\n\s*\n/);
  for (const block of blocks) {
    const trimmed = block.replace(/^\s+|\s+$/g, '');
    if (!trimmed) continue;

    if (isBulletList(trimmed)) {
      const ul = document.createElement('ul');
      trimmed.split('\n').forEach(line => {
        const item = line.replace(/^\s*[-*]\s+/, '');
        if (!item) return;
        const li = document.createElement('li');
        renderInline(item, li);
        ul.appendChild(li);
      });
      container.appendChild(ul);
    } else {
      const p = document.createElement('p');
      renderInline(trimmed, p);
      container.appendChild(p);
    }
  }
}

function isBulletList(block) {
  const lines = block.split('\n').filter(l => l.trim());
  return lines.length > 0 && lines.every(l => /^\s*[-*]\s+\S/.test(l));
}

function renderInline(text, parent) {
  // Match in priority order: **bold**, [text](url), bare URL, single newline.
  const PATTERN = /\*\*([\s\S]+?)\*\*|\[([^\]]+?)\]\(([^)\s]+?)\)|(https?:\/\/[^\s<>"')]+)|\n/g;
  let lastIndex = 0;

  for (const match of text.matchAll(PATTERN)) {
    if (match.index > lastIndex) {
      parent.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
    }
    const token = match[0];
    const boldInner = match[1];
    const linkText  = match[2];
    const linkUrl   = match[3];
    const bareUrl   = match[4];

    if (boldInner !== undefined) {
      const strong = document.createElement('strong');
      strong.textContent = boldInner;
      parent.appendChild(strong);
    } else if (linkText !== undefined && linkUrl !== undefined) {
      appendLink(parent, linkUrl, linkText);
    } else if (bareUrl !== undefined) {
      appendLink(parent, bareUrl, bareUrl);
    } else if (token === '\n') {
      parent.appendChild(document.createElement('br'));
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) {
    parent.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
}

function appendLink(parent, url, displayText) {
  const safe = safeUrl(url);
  if (!safe) {
    // Fall back to plain text for anything that doesn't parse as http(s).
    parent.appendChild(document.createTextNode(displayText));
    return;
  }
  const a = document.createElement('a');
  a.href = safe;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = displayText;
  parent.appendChild(a);
}

// ════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════

function setStatus(listEl, message, isError) {
  listEl.replaceChildren();
  const p = document.createElement('p');
  p.className = 'airtable-status' + (isError ? ' airtable-status--error' : '');
  // role=alert announces on DOM insertion — without it a screen-reader
  // user gets no signal that loading failed and the page is empty.
  if (isError) p.setAttribute('role', 'alert');
  p.textContent = message;
  listEl.appendChild(p);
}

/** Normalise a field value to an array of strings (multi-select → array). */
function toValueArray(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map(String);
  return [String(value)];
}

/** Unique values (sorted, case-insensitive) for a given field. */
function uniqueValues(records, fieldId) {
  const set = new Set();
  records.forEach(r => toValueArray(r.fields && r.fields[fieldId]).forEach(v => set.add(v)));
  return Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

/**
 * Pull a usable image URL out of a field value.
 *
 * The D1-backed Worker returns plain URL strings (`logo_url`,
 * `poster_url`) — permanent R2-hosted links, no expiry. The old
 * Airtable attachment-array shape (`[{url, thumbnails…}]`) is still
 * accepted as a fallback so a rollback to the old Worker doesn't break
 * rendering. `prefer` ('thumbnail' | 'full') only matters for the
 * legacy shape; R2 URLs serve one size.
 */
function getAttachmentUrl(value, prefer) {
  if (typeof value === 'string') return value.trim() || null;
  if (!Array.isArray(value) || value.length === 0) return null;
  const att = value[0];
  if (!att) return null;
  if (prefer === 'thumbnail' && att.thumbnails && att.thumbnails.large && att.thumbnails.large.url) {
    return att.thumbnails.large.url;
  }
  return att.url || (att.thumbnails && att.thumbnails.large && att.thumbnails.large.url) || null;
}

/** Validate a URL is http(s); prepend https:// if no scheme present. */
function safeUrl(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v) return null;
  const candidate = /^https?:\/\//i.test(v) ? v : 'https://' + v;
  try {
    const u = new URL(candidate);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** Cheap email check — rejects values with no @ or any whitespace. */
function safeEmail(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v.includes('@')) return null;
  if (/\s/.test(v)) return null;
  return v;
}

/**
 * Initials for the empty-logo monogram. Up to three first letters from
 * the first three non-empty words. "British Deaf Association" → "BDA".
 * Falls back to "?" for blank/missing names.
 */
function getInitials(name) {
  if (!name || typeof name !== 'string') return '?';
  const words = name.trim().split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) return '?';
  return words.slice(0, 3).map(w => w[0].toUpperCase()).join('');
}

/**
 * Mark every direct child of <body> as inert, except the given element.
 * Used to lock the rest of the page while a modal is open.
 */
function setSiblingsInert(exceptEl, on) {
  const children = document.body.children;
  for (let i = 0; i < children.length; i += 1) {
    const el = children[i];
    if (el === exceptEl) continue;
    if (on) el.setAttribute('inert', '');
    else el.removeAttribute('inert');
  }
}

/**
 * Create a standardised modal controller — the same open/close/focus/inert
 * dance was previously repeated 4 times across the codebase.
 *
 * The returned API exposes `open(...args)` and `close()`. Args passed to
 * `open` are forwarded to the `populate` hook (so callers can pass record
 * data, event IDs, etc.). The `cleanup` hook fires inside `close()` for
 * any teardown (removing iframes, clearing fields).
 *
 * Behaviours included automatically:
 *   - toggles `.is-open` and `aria-hidden`
 *   - sets `inert` on all body siblings while open (focus trap-lite)
 *   - locks `<body>` scroll while open
 *   - moves focus to the close button on open, restores prior focus on close
 *   - dismiss handlers: × button, click on backdrop, Escape key
 */
function createModalAPI(modal, options) {
  if (!modal) return null;
  const opts = options || {};
  const closeBtn = modal.querySelector(
    opts.closeSelector || '.org-modal-close, .event-modal-close, .video-modal-close'
  );
  let lastFocused = null;
  // Track where a mousedown landed so we can tell a true backdrop click
  // (started AND released on the dim backdrop) apart from a text-selection
  // drag that began inside the white content and was released over the
  // backdrop. Without this, the drag would close the modal mid-selection.
  let mouseDownTarget = null;

  function open(...args) {
    // populate may return `false` to abort the open — used by the video
    // modal to bail when its iframe slot is missing, instead of leaving
    // an empty locked modal over the page.
    if (opts.populate && opts.populate(...args) === false) return;
    setSiblingsInert(modal, true);
    modal.classList.add('is-open');
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    // Prefer an explicit focusable element passed via args (e.g. the
    // .video-facade button) over document.activeElement — Safari does not
    // focus buttons on click, so activeElement is often <body> at this
    // point, which would lose the user's focus point on close.
    const invoker = args.find(a => a && typeof a.focus === 'function');
    lastFocused = invoker || document.activeElement;
    if (closeBtn && typeof closeBtn.focus === 'function') closeBtn.focus();
  }

  function close() {
    if (!modal.classList.contains('is-open')) return;
    if (opts.cleanup) opts.cleanup();
    modal.classList.remove('is-open');
    modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    setSiblingsInert(modal, false);
    if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
    lastFocused = null;
  }

  if (closeBtn) closeBtn.addEventListener('click', close);
  modal.addEventListener('mousedown', e => { mouseDownTarget = e.target; });
  modal.addEventListener('click', e => {
    if (e.target === modal && mouseDownTarget === modal) close();
    mouseDownTarget = null;
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && modal.classList.contains('is-open')) close();
  });

  return { open, close, modal };
}

// ════════════════════════════════════════════════════════════════════════
// EVENTS BLOCK
// ════════════════════════════════════════════════════════════════════════
//
// Recreates the Softr calendar UI: three views (agenda/week/month),
// search + time + organisation filters, day-events modal, event-detail
// modal. Operates on records from the Worker's /events endpoint, which
// must include the fields configured in EVENTS_CONFIG.fields above.
//
// The Organisation field is expected to be a Lookup field that returns
// the linked Organisation's NAME as a string (not the raw linked-record
// ID array). Add a Lookup on the Events table if it doesn't exist yet.

const EVENT_WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

(function eventsBlock() {
  const statusEl = document.getElementById('events-status');
  const blockEl  = document.getElementById('event-block');
  if (!statusEl || !blockEl) return;

  // Cache DOM up front — every event-block element is queried once here.
  const els = {
    status:        statusEl,
    block:         blockEl,
    viewChips:     blockEl.querySelectorAll('.event-view-toggle .event-chip'),
    clearBtn:      document.getElementById('event-clear'),
    search:        document.getElementById('event-search'),
    timeBtn:       document.getElementById('event-time-btn'),
    timeMenu:      document.getElementById('event-time-menu'),
    timeLabel:     document.getElementById('event-time-label'),
    timeChips:     blockEl.querySelectorAll('#event-time-menu .event-chip'),
    orgBtn:        document.getElementById('event-org-btn'),
    orgMenu:       document.getElementById('event-org-menu'),
    orgLabel:      document.getElementById('event-org-label'),
    activeBar:     document.getElementById('event-active-filters'),
    activeCount:   document.getElementById('event-active-count'),
    activePills:   document.getElementById('event-active-pills'),
    count:         document.getElementById('event-count'),
    prevBtn:       document.getElementById('event-prev'),
    nextBtn:       document.getElementById('event-next'),
    todayBtn:      document.getElementById('event-today'),
    rangeLabel:    document.getElementById('event-range-label'),
    view:          document.getElementById('event-view'),
  };

  // Module-level state.
  const state = {
    records: [],            // [{ id, fields, eventDate: Date }]
    view: 'month',          // 'agenda' | 'week' | 'month'
    currentDate: startOfDay(new Date()),
    searchQuery: '',
    timeFilter: 'upcoming', // 'upcoming' | 'past' | 'all'
    selectedOrgs: new Set(),// org name strings
  };

  // Modal APIs (always set up — they're inert until opened).
  const detailModalAPI = setupEventDetailModal();
  const dayModalAPI    = setupDayEventsModal(record => detailModalAPI && detailModalAPI.open(record));

  // Dev affordance: ?mockEvents=1 substitutes a hardcoded dataset so the
  // calendar can be styled / verified without a deployed Worker. The mock
  // also swaps in the matching field IDs so the production config can stay
  // pinned to TODOs until the real ones are pasted in.
  const useMockEvents = new URLSearchParams(location.search).has('mockEvents');
  if (useMockEvents) {
    Object.assign(EVENTS_CONFIG.fields, {
      eventName: 'mockEventName',
      date: 'mockDate',
      organisation: 'mockOrg',
      details: 'mockDetails',
      address: 'mockAddress',
      poster: 'mockPoster',
    });
    state.records = MOCK_EVENT_RECORDS()
      .map(r => ({ ...r, eventDate: parseEventDate(r.fields.mockDate) }))
      .filter(r => r.eventDate)
      .sort((a, b) => a.eventDate - b.eventDate);
    // Mock dataset spans past + future; show everything by default so the
    // calendar grid lights up.
    state.timeFilter = 'all';
    els.status.hidden = true;
    els.block.hidden = false;
    wireEventListeners(els, state, rerender);
    rerender();
    return;
  }

  // Config gate. `null` is treated as "intentionally optional — no such field"
  // (e.g. Events doesn't have an Address field; it's fine to leave that null).
  const f = EVENTS_CONFIG.fields;
  const hasAllFields = Object.values(f).every(id =>
    id === null || (typeof id === 'string' && id && !id.startsWith('TODO_'))
  );
  if (!hasAllFields) {
    showEventsStatus(els, 'Event field IDs not yet configured. See app.js.', false);
    return;
  }
  if (WORKER_URL.includes('TODO-fill-in')) {
    showEventsStatus(els, 'Worker URL not configured yet. See app.js.', true);
    return;
  }

  // Fetch + initial render.
  fetchWorkerRecords(EVENTS_CONFIG.endpoint)
    .then(records => {
      state.records = records
        .map(r => ({ ...r, eventDate: parseEventDate(r.fields && r.fields[f.date]) }))
        .filter(r => r.eventDate)
        .sort((a, b) => a.eventDate - b.eventDate);

      // Structured data (JSON-LD) for search engines, built from the same
      // records. Wrapped so a schema bug can never break the calendar.
      try { injectEventSchema(state.records); }
      catch (err) { console.warn('event schema injection failed', err); }

      els.status.hidden = true;
      els.block.hidden = false;
      wireEventListeners(els, state, rerender);
      rerender();
    })
    .catch(err => {
      console.error('[/events] fetch failed:', err);
      showEventsStatus(els, 'Could not load events — please try again later.', true);
    });

  // The render orchestrator: runs after any state change.
  function rerender() {
    // View toggle chips
    els.viewChips.forEach(chip => {
      const active = chip.dataset.view === state.view;
      chip.classList.toggle('is-active', active);
      chip.setAttribute('aria-pressed', String(active));
    });

    // Time chips inside the time dropdown
    els.timeChips.forEach(chip => {
      const active = chip.dataset.time === state.timeFilter;
      chip.classList.toggle('is-active', active);
      chip.setAttribute('aria-pressed', String(active));
    });

    // Dropdown button labels
    els.timeLabel.textContent =
      state.timeFilter === 'upcoming' ? 'Time'
      : state.timeFilter === 'all'    ? 'Time · All'
      :                                 'Time · Past';
    els.orgLabel.textContent =
      state.selectedOrgs.size > 0
        ? `Organisation (${state.selectedOrgs.size})`
        : 'Organisation';

    // Rebuild the org dropdown menu (chip list reflects current data + selection).
    const orgOptions = getUniqueEventOrgs(state.records, EVENTS_CONFIG.fields.organisation);
    renderOrgMenu(els.orgMenu, orgOptions, state.selectedOrgs, rerender);

    // Apply filters → list + by-day map.
    const filtered = filterEvents(state.records, state, EVENTS_CONFIG.fields);
    const eventsByDay = groupEventsByDay(filtered);

    // Active-filters bar vs plain count.
    const hasActive =
      state.searchQuery !== '' ||
      state.timeFilter !== 'upcoming' ||
      state.selectedOrgs.size > 0;
    els.clearBtn.hidden = !hasActive;
    if (hasActive) {
      renderActivePills(els.activePills, state, rerender);
      els.activeCount.textContent = `${filtered.length} event${filtered.length === 1 ? '' : 's'}`;
      els.activeBar.hidden = false;
      els.count.hidden = true;
    } else {
      els.activeBar.hidden = true;
      els.count.textContent = `Showing ${filtered.length} event${filtered.length === 1 ? '' : 's'}`;
      els.count.hidden = false;
    }

    // Range label + view body
    els.rangeLabel.textContent = getRangeLabel(state.view, state.currentDate);

    const onOpenEvent = record => detailModalAPI && detailModalAPI.open(record);
    const onOpenDay = (date, list) => dayModalAPI && dayModalAPI.open(date, list);

    if (state.view === 'agenda') {
      renderAgendaView(els.view, filtered, EVENTS_CONFIG.fields, onOpenEvent);
    } else if (state.view === 'week') {
      renderWeekView(els.view, eventsByDay, state.currentDate, EVENTS_CONFIG.fields, onOpenEvent, onOpenDay);
    } else {
      renderMonthView(els.view, eventsByDay, state.currentDate, EVENTS_CONFIG.fields, onOpenEvent, onOpenDay);
    }
  }

  // Expose for testing via the preview (handy for mock-data dry runs).
  if (typeof window !== 'undefined') {
    window.__events = { state, rerender };
  }
}());

// ─── Events helpers ──────────────────────────────────────────────────────

function showEventsStatus(els, text, isError) {
  els.status.textContent = text;
  els.status.classList.toggle('airtable-status--error', !!isError);
  els.status.hidden = false;
  els.block.hidden = true;
}

function wireEventListeners(els, state, rerender) {
  // View toggle
  els.viewChips.forEach(chip => {
    chip.addEventListener('click', () => {
      state.view = chip.dataset.view;
      rerender();
    });
  });

  // Time chips
  els.timeChips.forEach(chip => {
    chip.addEventListener('click', () => {
      state.timeFilter = chip.dataset.time;
      rerender();
    });
  });

  // Time dropdown
  els.timeBtn.addEventListener('click', e => {
    e.stopPropagation();
    const willOpen = els.timeMenu.hidden;
    closeAllEventMenus(els);
    if (willOpen) {
      els.timeMenu.hidden = false;
      els.timeBtn.setAttribute('aria-expanded', 'true');
    }
  });

  // Org dropdown
  els.orgBtn.addEventListener('click', e => {
    e.stopPropagation();
    const willOpen = els.orgMenu.hidden;
    closeAllEventMenus(els);
    if (willOpen) {
      els.orgMenu.hidden = false;
      els.orgBtn.setAttribute('aria-expanded', 'true');
    }
  });

  // Click outside closes both dropdowns
  document.addEventListener('click', e => {
    if (!e.target.closest('.event-dropdown')) {
      closeAllEventMenus(els);
    }
  });

  // Escape closes any open dropdown and returns focus to its trigger button
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!els.timeMenu.hidden) { closeAllEventMenus(els); els.timeBtn.focus(); }
    else if (!els.orgMenu.hidden) { closeAllEventMenus(els); els.orgBtn.focus(); }
  });

  // Search
  els.search.addEventListener('input', () => {
    state.searchQuery = els.search.value.trim();
    rerender();
  });

  // Date nav
  els.prevBtn.addEventListener('click', () => {
    state.currentDate = getNextEventDate(state.currentDate, state.view, -1);
    rerender();
  });
  els.nextBtn.addEventListener('click', () => {
    state.currentDate = getNextEventDate(state.currentDate, state.view, 1);
    rerender();
  });
  els.todayBtn.addEventListener('click', () => {
    state.currentDate = startOfDay(new Date());
    rerender();
  });

  // Clear all filters
  els.clearBtn.addEventListener('click', () => {
    state.searchQuery = '';
    state.timeFilter = 'upcoming';
    state.selectedOrgs.clear();
    els.search.value = '';
    rerender();
  });
}

function closeAllEventMenus(els) {
  els.timeMenu.hidden = true;
  els.orgMenu.hidden = true;
  els.timeBtn.setAttribute('aria-expanded', 'false');
  els.orgBtn.setAttribute('aria-expanded', 'false');
}

// ─── Date utilities (ported from the Softr block) ────────────────────────

function parseEventDate(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return null;
  if (raw instanceof Date) return isNaN(raw.getTime()) ? null : raw;
  if (typeof raw === 'string' || typeof raw === 'number') {
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof raw === 'object') {
    const candidate = raw.start || raw.date || raw.startDate || raw.iso || raw.value;
    if (!candidate) return null;
    const d = new Date(candidate);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}
function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth() === b.getMonth() &&
         a.getDate() === b.getDate();
}
function formatDayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function formatLongDate(date) {
  return new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(date);
}
function formatMonthLabel(date) {
  return new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' }).format(date);
}
function formatTimeLabel(date) {
  const hasTime = date.getHours() !== 0 || date.getMinutes() !== 0 || date.getSeconds() !== 0;
  if (!hasTime) return 'All day';
  return new Intl.DateTimeFormat('en-GB', { hour: 'numeric', minute: '2-digit' }).format(date);
}
function getWeekStart(date) {
  const day = date.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const next = new Date(date);
  next.setDate(date.getDate() + mondayOffset);
  return startOfDay(next);
}
function getWeekDays(date) {
  const weekStart = getWeekStart(date);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    return d;
  });
}
function getMonthDays(date) {
  const monthStart = new Date(date.getFullYear(), date.getMonth(), 1);
  const monthEnd = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  const gridStart = getWeekStart(monthStart);
  const gridEnd = getWeekStart(monthEnd);
  gridEnd.setDate(gridEnd.getDate() + 6);
  const days = [];
  const cursor = new Date(gridStart);
  while (cursor <= gridEnd) {
    days.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}
function getRangeLabel(view, currentDate) {
  if (view === 'month') return formatMonthLabel(currentDate);
  if (view === 'week') {
    const days = getWeekDays(currentDate);
    const first = days[0], last = days[6];
    const sameMonth = first.getMonth() === last.getMonth();
    const sameYear  = first.getFullYear() === last.getFullYear();
    if (sameMonth && sameYear) {
      return `${first.getDate()}–${last.getDate()} ${formatMonthLabel(first)}`;
    }
    const m1 = first.toLocaleString('en-GB', { month: 'short' });
    const m2 = last.toLocaleString('en-GB', { month: 'short', year: 'numeric' });
    return `${first.getDate()} ${m1} – ${last.getDate()} ${m2}`;
  }
  return 'Agenda';
}
function getNextEventDate(date, view, direction) {
  const next = new Date(date);
  if (view === 'week') {
    next.setDate(next.getDate() + direction * 7);
  } else {
    // month + agenda both jump a month
    next.setMonth(next.getMonth() + direction);
  }
  return next;
}

// ─── Filtering ───────────────────────────────────────────────────────────

function filterEvents(records, state, fields) {
  const today = startOfDay(new Date());
  const q = state.searchQuery.toLowerCase();
  return records.filter(record => {
    const recFields = record.fields || {};
    const orgs = getEventOrgLabels(recFields[fields.organisation]);

    // Organisation filter
    if (state.selectedOrgs.size > 0) {
      const ok = orgs.some(label => state.selectedOrgs.has(label));
      if (!ok) return false;
    }

    // Search
    if (q) {
      const haystack = [
        recFields[fields.eventName],
        recFields[fields.details],
        recFields[fields.address],
        orgs.join(' '),
      ].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }

    // Time
    if (state.timeFilter !== 'all') {
      const eventDay = startOfDay(record.eventDate);
      if (state.timeFilter === 'upcoming' && eventDay < today) return false;
      if (state.timeFilter === 'past' && eventDay >= today) return false;
    }

    return true;
  });
}

function groupEventsByDay(events) {
  const map = new Map();
  events.forEach(ev => {
    const k = formatDayKey(ev.eventDate);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(ev);
  });
  return map;
}

function getUniqueEventOrgs(records, orgFieldId) {
  const set = new Set();
  records.forEach(r => getEventOrgLabels(r.fields && r.fields[orgFieldId]).forEach(v => set.add(v)));
  return Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

// Lookup fields return either a string, a single-element array, or sometimes
// an array of strings (when the lookup is on a linked record with multiple).
function getEventOrgLabels(value) {
  if (value == null) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr.map(v => {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') return v.label || v.name || v.primary || v.title || '';
    return String(v);
  }).filter(Boolean);
}

// ─── Org dropdown menu ───────────────────────────────────────────────────

function renderOrgMenu(menuEl, options, selected, onChange) {
  menuEl.replaceChildren();

  const allBtn = document.createElement('button');
  allBtn.type = 'button';
  allBtn.className = 'event-chip' + (selected.size === 0 ? ' is-active' : '');
  allBtn.setAttribute('aria-pressed', String(selected.size === 0));
  allBtn.textContent = 'All organisations';
  allBtn.addEventListener('click', () => {
    selected.clear();
    onChange();
  });
  menuEl.appendChild(allBtn);

  options.forEach(label => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'event-chip' + (selected.has(label) ? ' is-active' : '');
    btn.setAttribute('aria-pressed', String(selected.has(label)));
    btn.textContent = label;
    btn.addEventListener('click', () => {
      if (selected.has(label)) selected.delete(label);
      else selected.add(label);
      onChange();
    });
    menuEl.appendChild(btn);
  });
}

// ─── Active-filter pills ─────────────────────────────────────────────────

function renderActivePills(pillsEl, state, rerender) {
  pillsEl.replaceChildren();

  if (state.searchQuery) {
    pillsEl.appendChild(makeActivePill(
      'Search: ' + state.searchQuery,
      'Clear search',
      () => { state.searchQuery = ''; document.getElementById('event-search').value = ''; rerender(); }
    ));
  }
  if (state.timeFilter !== 'upcoming') {
    pillsEl.appendChild(makeActivePill(
      'Time: ' + (state.timeFilter === 'all' ? 'All' : 'Past'),
      'Clear time filter',
      () => { state.timeFilter = 'upcoming'; rerender(); }
    ));
  }
  Array.from(state.selectedOrgs).sort((a, b) => a.localeCompare(b)).forEach(label => {
    pillsEl.appendChild(makeActivePill(label, 'Remove ' + label, () => {
      state.selectedOrgs.delete(label);
      rerender();
    }, true /* yellow */));
  });
}

function makeActivePill(text, ariaLabel, onRemove, isOrg) {
  const span = document.createElement('span');
  span.className = 'event-active-pill' + (isOrg ? ' event-active-pill--org' : '');
  span.appendChild(document.createTextNode(text));
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('aria-label', ariaLabel);
  btn.addEventListener('click', onRemove);
  btn.appendChild(svgIcon('icon-x'));
  span.appendChild(btn);
  return span;
}

// ─── View renderers ──────────────────────────────────────────────────────

function renderAgendaView(container, events, fields, onOpen) {
  container.replaceChildren();
  container.className = 'event-view event-view-agenda';

  if (events.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'event-agenda-empty';
    empty.textContent = 'No events match your search or filters.';
    container.appendChild(empty);
    return;
  }

  // Group by day
  const groups = [];
  events.forEach(ev => {
    const key = formatDayKey(ev.eventDate);
    const existing = groups.find(g => g.key === key);
    if (existing) existing.events.push(ev);
    else groups.push({ key, date: ev.eventDate, events: [ev] });
  });

  groups.forEach(group => {
    const groupEl = document.createElement('div');
    groupEl.className = 'event-agenda-group';

    const head = document.createElement('div');
    head.className = 'event-agenda-group-head';
    head.appendChild(svgIcon('icon-calendar'));
    const h4 = document.createElement('h4');
    h4.textContent = formatLongDate(group.date);
    head.appendChild(h4);
    groupEl.appendChild(head);

    const list = document.createElement('div');
    list.className = 'event-agenda-cards';
    group.events.forEach(event => list.appendChild(buildAgendaCard(event, fields, onOpen)));
    groupEl.appendChild(list);

    container.appendChild(groupEl);
  });
}

function buildAgendaCard(event, fields, onOpen) {
  const f = event.fields || {};
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'event-agenda-card';
  card.addEventListener('click', () => onOpen(event));

  const main = document.createElement('div');
  main.className = 'event-agenda-card-main';

  const leftCol = document.createElement('div');
  const title = document.createElement('h3');
  title.className = 'event-agenda-card-title';
  title.textContent = String(f[fields.eventName] || '');
  leftCol.appendChild(title);
  const time = document.createElement('p');
  time.className = 'event-agenda-card-time';
  time.textContent = formatTimeLabel(event.eventDate);
  leftCol.appendChild(time);
  const orgs = getEventOrgLabels(f[fields.organisation]);
  if (orgs.length > 0) {
    const orgP = document.createElement('p');
    orgP.className = 'event-agenda-card-org';
    orgP.textContent = orgs.join(', ');
    leftCol.appendChild(orgP);
  }
  main.appendChild(leftCol);

  const rightCol = document.createElement('div');
  if (f[fields.address]) {
    const addr = document.createElement('p');
    addr.className = 'event-agenda-card-address';
    addr.textContent = String(f[fields.address]);
    rightCol.appendChild(addr);
  }
  main.appendChild(rightCol);

  card.appendChild(main);

  const badge = document.createElement('span');
  badge.className = 'event-agenda-card-badge';
  badge.textContent = 'View details';
  card.appendChild(badge);

  return card;
}

function renderWeekView(container, eventsByDay, currentDate, fields, onOpen, onOpenDay) {
  container.replaceChildren();
  container.className = 'event-view event-grid event-grid-week';

  const today = new Date();
  getWeekDays(currentDate).forEach((day, i) => {
    container.appendChild(buildDayCell(day, eventsByDay.get(formatDayKey(day)) || [],
      EVENT_WEEKDAY_LABELS[i], today, fields, onOpen, onOpenDay, false));
  });
}

function renderMonthView(container, eventsByDay, currentDate, fields, onOpen, onOpenDay) {
  container.replaceChildren();
  container.className = 'event-view';

  // Day-of-week header
  const head = document.createElement('div');
  head.className = 'event-grid-month-head';
  EVENT_WEEKDAY_LABELS.forEach(label => {
    const cell = document.createElement('div');
    cell.textContent = label;
    head.appendChild(cell);
  });
  container.appendChild(head);

  const grid = document.createElement('div');
  grid.className = 'event-grid event-grid-month';

  const today = new Date();
  getMonthDays(currentDate).forEach(day => {
    const inMonth = day.getMonth() === currentDate.getMonth();
    grid.appendChild(buildDayCell(day, eventsByDay.get(formatDayKey(day)) || [],
      null, today, fields, onOpen, onOpenDay, !inMonth));
  });

  container.appendChild(grid);
}

function buildDayCell(day, dayEvents, weekLabel, today, fields, onOpen, onOpenDay, outsideMonth) {
  const cell = document.createElement('div');
  cell.className = 'event-day';
  if (isSameDay(day, today)) cell.classList.add('event-day--today');
  if (outsideMonth) cell.classList.add('event-day--out');

  const head = document.createElement('div');
  head.className = 'event-day-head';
  if (weekLabel) {
    const labelWrap = document.createElement('div');
    const lbl = document.createElement('div');
    lbl.className = 'event-day-label';
    lbl.textContent = weekLabel;
    labelWrap.appendChild(lbl);
    const num = document.createElement('div');
    num.className = 'event-day-num';
    num.textContent = String(day.getDate());
    labelWrap.appendChild(num);
    head.appendChild(labelWrap);
  } else {
    const num = document.createElement('div');
    num.className = 'event-day-num';
    num.textContent = String(day.getDate());
    head.appendChild(num);
    if (dayEvents.length > 0) {
      // A button (not a span) so keyboard / screen-reader users can open the
      // day's events — important on phones, where the pills below are hidden.
      const count = document.createElement('button');
      count.type = 'button';
      count.className = 'event-day-count';
      count.textContent = String(dayEvents.length);
      const dl = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }).format(day);
      count.setAttribute('aria-label', `${dayEvents.length} event${dayEvents.length > 1 ? 's' : ''} on ${dl} — view`);
      count.addEventListener('click', (e) => { e.stopPropagation(); onOpenDay(day, dayEvents); });
      head.appendChild(count);
    }
  }
  cell.appendChild(head);

  const items = document.createElement('div');
  items.className = 'event-day-items';

  if (dayEvents.length === 0) {
    if (weekLabel) {
      // Week view shows an explicit "No events" pill on empty days.
      const empty = document.createElement('div');
      empty.className = 'event-day-empty';
      empty.textContent = 'No events';
      items.appendChild(empty);
    }
  } else {
    // Show up to 3 event pills (month view) / all (week view, narrow on mobile via CSS).
    const limit = weekLabel ? dayEvents.length : 3;
    dayEvents.slice(0, limit).forEach(event => {
      items.appendChild(buildEventPill(event, fields, onOpen));
    });
    if (dayEvents.length > limit) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'event-pill-more';
      more.textContent = `+${dayEvents.length - limit} more`;
      more.addEventListener('click', () => onOpenDay(day, dayEvents));
      items.appendChild(more);
    }
  }

  cell.appendChild(items);

  // Month view on phones: the pills are hidden, so a tap anywhere on a day that
  // has events opens that day's list (the count badge does the same for
  // keyboard). Ignore taps that land on the pills / badge (they have their own
  // handlers), and only act at phone widths where the pills aren't shown.
  if (!weekLabel && dayEvents.length > 0) {
    cell.classList.add('event-day--tappable');
    cell.addEventListener('click', (e) => {
      if (e.target.closest('.event-pill, .event-pill-more, .event-day-count')) return;
      if (window.matchMedia('(max-width: 767px)').matches) onOpenDay(day, dayEvents);
    });
  }

  return cell;
}

function buildEventPill(event, fields, onOpen) {
  const f = event.fields || {};
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'event-pill';
  btn.addEventListener('click', () => onOpen(event));

  const title = document.createElement('div');
  title.className = 'event-pill-title';
  title.textContent = String(f[fields.eventName] || '');
  btn.appendChild(title);

  const time = document.createElement('div');
  time.className = 'event-pill-time';
  time.textContent = formatTimeLabel(event.eventDate);
  btn.appendChild(time);

  return btn;
}

// ─── Event modals ────────────────────────────────────────────────────────

function setupEventDetailModal() {
  const modal = document.getElementById('event-detail-modal');
  if (!modal) return null;
  const els = {
    title:       document.getElementById('event-detail-modal-title'),
    posterWrap:  document.getElementById('event-detail-poster'),
    posterImg:   document.getElementById('event-detail-poster-img'),
    date:        document.getElementById('event-detail-date'),
    time:        document.getElementById('event-detail-time'),
    orgWrap:     document.getElementById('event-detail-org'),
    orgBadges:   document.getElementById('event-detail-org-badges'),
    addressWrap: document.getElementById('event-detail-address'),
    addressText: document.getElementById('event-detail-address-text'),
    detailsWrap: document.getElementById('event-detail-details-section'),
    details:     document.getElementById('event-detail-details'),
    empty:       document.getElementById('event-detail-empty'),
  };
  return createModalAPI(modal, {
    populate: record => populateEventDetail(els, record, EVENTS_CONFIG.fields),
  });
}

function populateEventDetail(els, record, fields) {
  const f = record.fields || {};
  els.title.textContent = String(f[fields.eventName] || '');

  // Event poster — show the first attachment if present, hide otherwise.
  if (els.posterWrap && els.posterImg) {
    const posterUrl = fields.poster ? getAttachmentUrl(f[fields.poster], 'full') : null;
    if (posterUrl) {
      els.posterImg.src = posterUrl;
      els.posterImg.alt = (String(f[fields.eventName] || '').trim() || 'Event') + ' — event poster';
      els.posterWrap.hidden = false;
    } else {
      els.posterImg.removeAttribute('src');
      els.posterImg.alt = '';
      els.posterWrap.hidden = true;
    }
  }

  els.date.textContent = formatLongDate(record.eventDate);
  els.time.textContent = formatTimeLabel(record.eventDate);

  const orgs = getEventOrgLabels(f[fields.organisation]);
  els.orgBadges.replaceChildren();
  if (orgs.length > 0) {
    orgs.forEach(label => {
      const badge = document.createElement('span');
      badge.className = 'event-detail-org-badge';
      badge.textContent = label;
      els.orgBadges.appendChild(badge);
    });
    els.orgWrap.hidden = false;
  } else {
    els.orgWrap.hidden = true;
  }

  if (f[fields.address]) {
    els.addressText.textContent = String(f[fields.address]);
    els.addressWrap.hidden = false;
  } else {
    els.addressWrap.hidden = true;
  }

  els.details.replaceChildren();
  if (f[fields.details]) {
    renderTextWithLinks(String(f[fields.details]), els.details);
    els.detailsWrap.hidden = false;
    els.empty.hidden = true;
  } else {
    els.detailsWrap.hidden = true;
    els.empty.hidden = false;
  }
}

function setupDayEventsModal(onOpenEvent) {
  const modal = document.getElementById('day-events-modal');
  if (!modal) return null;
  const titleEl = document.getElementById('day-events-modal-title');
  const listEl  = document.getElementById('day-events-modal-list');

  // We need `api.close()` inside the `populate` callback (cards must close
  // the day-events modal before opening the event-detail modal). Declare
  // `api` first so the closure picks it up at call time.
  const api = createModalAPI(modal, {
    populate: (date, events) => {
      titleEl.textContent = 'Events on ' + formatLongDate(date);
      listEl.replaceChildren();
      events.forEach(event => {
        const card = buildDayEventsCard(event, EVENTS_CONFIG.fields, () => {
          api.close();
          onOpenEvent(event);
        });
        listEl.appendChild(card);
      });
    },
  });
  return api;
}

function buildDayEventsCard(event, fields, onClick) {
  const f = event.fields || {};
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'event-day-card';
  card.addEventListener('click', onClick);

  const main = document.createElement('div');
  main.className = 'event-day-card-main';

  const title = document.createElement('h3');
  title.className = 'event-day-card-title';
  title.textContent = String(f[fields.eventName] || '');
  main.appendChild(title);

  const time = document.createElement('p');
  time.className = 'event-day-card-time';
  time.textContent = formatTimeLabel(event.eventDate);
  main.appendChild(time);

  const orgs = getEventOrgLabels(f[fields.organisation]);
  if (orgs.length > 0) {
    const o = document.createElement('p');
    o.className = 'event-day-card-org';
    o.textContent = orgs.join(', ');
    main.appendChild(o);
  }
  if (f[fields.address]) {
    const a = document.createElement('p');
    a.className = 'event-day-card-address';
    a.textContent = String(f[fields.address]);
    main.appendChild(a);
  }

  card.appendChild(main);

  const badge = document.createElement('span');
  badge.className = 'event-agenda-card-badge';
  badge.textContent = 'View details';
  card.appendChild(badge);

  return card;
}

// ─── URL auto-linking for event details ──────────────────────────────────
//
// Plain text in / wraps `https?://...` and bare `www....` in <a> tags.
// Keeps newlines via the parent's `white-space: pre-wrap`.

function renderTextWithLinks(text, container) {
  const PATTERN = /(https?:\/\/[^\s]+|www\.[^\s]+)/g;
  let lastIndex = 0;
  for (const match of text.matchAll(PATTERN)) {
    if (match.index > lastIndex) {
      container.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
    }
    const token = match[0];
    const href = token.startsWith('http') ? token : 'https://' + token;
    const safe = safeUrl(href);
    if (safe) {
      const a = document.createElement('a');
      a.href = safe;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = token;
      container.appendChild(a);
    } else {
      container.appendChild(document.createTextNode(token));
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) {
    container.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
}

// ─── Small DOM helpers ──────────────────────────────────────────────────

function svgIcon(symbolId) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#' + symbolId);
  svg.appendChild(use);
  return svg;
}

// ─── Mock data (only used when ?mockEvents=1 is in the URL) ─────────────

function MOCK_EVENT_RECORDS() {
  // Build dates relative to today so the views land on a populated month.
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = today.getMonth();
  const mkDate = (day, hh = 0, min = 0) =>
    new Date(yyyy, mm, day, hh, min).toISOString();
  return [
    { id: 'mock1', fields: {
      mockEventName: 'Deaf Coffee Morning',
      mockDate: mkDate(2, 10, 30),
      mockOrg: 'Bristol Centre for Deaf People',
      mockDetails: 'A friendly drop-in for the Deaf community. BSL interpreter present. All welcome.\n\nMore info: https://example.org/coffee',
      mockAddress: 'Bristol Centre, 16 King Square Avenue, Bristol BS2 8HU',
    }},
    { id: 'mock2', fields: {
      mockEventName: 'BSL Beginner Course (Week 3)',
      mockDate: mkDate(4, 18, 0),
      mockOrg: 'ASLI South West',
      mockDetails: 'Weekly evening course. Bring a notebook.',
      mockAddress: 'Online via Zoom',
    }},
    { id: 'mock3', fields: {
      mockEventName: 'Deaf Mental Health Q&A',
      mockDate: mkDate(10, 14, 0),
      mockOrg: 'AWP Adult Mental Health and Deafness Service',
      mockDetails: 'Open Q&A session with mental-health professionals. Booking required: www.example.org/booking',
      mockAddress: 'Callington Road Hospital, Bristol',
    }},
    { id: 'mock4', fields: {
      mockEventName: 'Cycling BSL',
      mockDate: mkDate(15),
      mockOrg: 'Bristol BSL Cycling',
      mockDetails: '',
      mockAddress: 'Meeting at College Green, Bristol',
    }},
    { id: 'mock5', fields: {
      mockEventName: 'BSL Interpreted Concert',
      mockDate: mkDate(15, 19, 30),
      mockOrg: 'Bristol Beacon',
      mockDetails: 'Evening concert with BSL interpretation. Doors 7pm. https://bristolbeacon.org',
      mockAddress: 'Bristol Beacon, Trenchard Street, Bristol BS1 5AR',
      mockPoster: [{
        url: 'https://placehold.co/600x400/2852b7/f5c842/png?text=BSL+Concert',
        thumbnails: { large: { url: 'https://placehold.co/600x400/2852b7/f5c842/png?text=BSL+Concert' } },
      }],
    }},
    { id: 'mock6', fields: {
      mockEventName: 'Deaf Active Walk',
      mockDate: mkDate(20, 11, 0),
      mockOrg: 'Deaf Active',
      mockDetails: 'A 5-mile circular walk on the Mendips. Suitable for all abilities. Meet at the car park.',
      mockAddress: 'Burrington Combe car park, BS40 7AT',
    }},
    { id: 'mock7', fields: {
      mockEventName: 'Action on Hearing Loss surgery',
      mockDate: mkDate(22, 13, 0),
      mockOrg: 'Action on Hearing Loss',
      mockDetails: 'Drop-in surgery — bring your hearing aids for cleaning and adjustment.',
      mockAddress: 'Bristol Library, College Green, Bristol',
    }},
    { id: 'mock8', fields: {
      mockEventName: 'Past Event Example',
      mockDate: mkDate(-3, 10, 0),  // 3 days before the current month
      mockOrg: 'Bristol Centre for Deaf People',
      mockDetails: 'This is a past event — shown only when the Time filter is set to Past or All.',
      mockAddress: '',
    }},
  ];
}

// ════════════════════════════════════════════════════════════════════════
// STRUCTURED DATA (JSON-LD) — built from the listings after they load.
//
// The directory content is fetched client-side, so it can't live in the
// static HTML. Instead we build schema.org ItemLists from the same records
// app.js already renders and inject them into <head>. Google executes JS and
// reads dynamically-added JSON-LD, so this makes the organisations and events
// machine-readable for search. Non-JS crawlers still won't see it — that
// needs server-side rendering (tracked separately as SEO-1).
//
// Safety: written via DOM textContent (never innerHTML), and every '<' in the
// JSON is escaped to <, so a stray '</script>' inside a user-submitted
// name or description can't break out of the <script> element.
// ════════════════════════════════════════════════════════════════════════

const LD_SITE_URL = 'https://deafhive.online/';

function upsertJsonLd(id, obj) {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('script');
    el.type = 'application/ld+json';
    el.id = id;
    document.head.appendChild(el);
  }
  el.textContent = JSON.stringify(obj).replace(/</g, '\\u003c');
}

// Markdown-ish → single-line plain text, length-capped. Used for descriptions
// so JSON-LD carries clean prose, not '**bold**' / '[text](url)' syntax.
function ldPlainText(value, maxLen) {
  if (typeof value !== 'string') return '';
  let s = value
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')   // [text](url) → text
    .replace(/\*\*([^*]+)\*\*/g, '$1')          // **bold** → bold
    .replace(/\s+/g, ' ')                        // collapse whitespace/newlines
    .trim();
  if (maxLen && s.length > maxLen) s = s.slice(0, maxLen - 1).replace(/\s+\S*$/, '') + '…';
  return s;
}

function ldTrim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function injectOrganisationSchema(records) {
  const f = SECTIONS.organisations.fields;
  const items = [];
  records.forEach(rec => {
    const fields = rec.fields || {};
    const name = ldTrim(fields[f.title]);
    if (!name) return;
    const org = { '@type': 'Organization', name };
    const website = safeUrl(String(fields[f.website] || ''));
    if (website) org.url = website;
    const logo = getAttachmentUrl(fields[f.logo]);
    if (logo) org.logo = logo;
    const about = ldPlainText(fields[f.about], 300);
    if (about) org.description = about;
    const address = ldTrim(fields.address);
    if (address) org.address = address;
    const email = ldTrim(fields[f.email]);
    if (email) org.email = email;
    items.push({ '@type': 'ListItem', position: items.length + 1, item: org });
  });
  if (!items.length) return;
  upsertJsonLd('ld-organisations', {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'Deaf community organisations',
    url: LD_SITE_URL + '#directory-embed',
    numberOfItems: items.length,
    itemListElement: items,
  });
}

function injectEventSchema(records) {
  const f = EVENTS_CONFIG.fields;
  const items = [];
  records.forEach(rec => {
    const fields = rec.fields || {};
    const name = ldTrim(fields[f.eventName]);
    const startDate = ldTrim(fields[f.date]);
    if (!name || !startDate) return;
    const ev = { '@type': 'Event', name, startDate };
    // Location only when we actually know it — don't fabricate a place
    // (an inaccurate location is worse than an omitted one for Google).
    const address = ldTrim(fields[f.address]);
    if (address) ev.location = { '@type': 'Place', name: address, address };
    const details = ldPlainText(fields[f.details], 300);
    if (details) ev.description = details;
    const poster = getAttachmentUrl(fields[f.poster]);
    if (poster) ev.image = poster;
    const org = ldTrim(fields[f.organisation]);
    if (org) ev.organizer = { '@type': 'Organization', name: org };
    items.push({ '@type': 'ListItem', position: items.length + 1, item: ev });
  });
  if (!items.length) return;
  upsertJsonLd('ld-events', {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'BSL events & Deaf community events',
    url: LD_SITE_URL + '#events',
    numberOfItems: items.length,
    itemListElement: items,
  });
}

// ── Back-to-top button ───────────────────────────────────────────────────
// Shows once you've scrolled down ~a screenful; returns to the top on click
// (honours prefers-reduced-motion). Mounted in index.html as #back-to-top.
(function backToTop() {
  const btn = document.getElementById('back-to-top');
  if (!btn) return;
  const THRESHOLD = 600;
  const sync = () => btn.classList.toggle('is-visible', window.scrollY > THRESHOLD);
  window.addEventListener('scroll', sync, { passive: true });
  sync();
  btn.addEventListener('click', () => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
  });
}());

// ── Auto-hide the sticky nav on scroll-down, reveal on scroll-up ───────────
// Reclaims screen space while reading; the nav reappears the moment you scroll
// up, get near the top, focus into it (so keyboard focus is never trapped
// off-screen), or open the mobile menu.
(function autoHideNav() {
  const nav = document.getElementById('site-nav');
  if (!nav) return;
  const REVEAL_AT = 80; // always shown within this many px of the top
  let lastY = Math.max(0, window.scrollY);
  let ticking = false;
  const update = () => {
    ticking = false;
    const y = Math.max(0, window.scrollY);
    if (nav.classList.contains('is-open') || nav.contains(document.activeElement) || y < REVEAL_AT) {
      nav.classList.remove('nav--hidden');
    } else if (y > lastY + 4) {        // scrolling down
      nav.classList.add('nav--hidden');
    } else if (y < lastY - 4) {        // scrolling up
      nav.classList.remove('nav--hidden');
    }
    lastY = y;
  };
  window.addEventListener('scroll', () => {
    if (!ticking) { ticking = true; requestAnimationFrame(update); }
  }, { passive: true });
}());

// ── Mobile bottom tab bar: highlight the section currently in view ─────────
// Each .tabbar-tab[data-spy] points at a page section. The active tab is the
// last section whose top has scrolled above an activation line near the top of
// the viewport — robust for short and tall sections alike. (No-op on desktop,
// where the tab bar is hidden.)
(function tabbarSpy() {
  const tabs = [...document.querySelectorAll('.tabbar-tab[data-spy]')];
  if (!tabs.length) return;
  const entries = tabs
    .map((tab) => ({ tab, sec: document.querySelector(tab.getAttribute('data-spy')) }))
    .filter((e) => e.sec);
  if (!entries.length) return;
  const setActive = (tab) => tabs.forEach((t) => {
    const on = t === tab;
    t.classList.toggle('is-active', on);
    if (on) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  });
  const update = () => {
    const line = window.innerHeight * 0.28; // activation line near the top
    let active = entries[0];
    for (const e of entries) {
      if (e.sec.getBoundingClientRect().top <= line) active = e; else break;
    }
    setActive(active.tab);
  };
  window.addEventListener('scroll', update, { passive: true });
  update();
}());
