/* ════════════════════════════════════════════════════════════════════════
   DeafHive admin — Phase 2 shell (read-only).

   Flow:
     1. On load: read token from localStorage. If present, call /admin/whoami
        to confirm it's still valid. Valid → show shell. 401 → show login.
     2. Login submit: POST /admin/login. Success → store token + show shell.
     3. Shell: tabs (orgs/events/videos) + status filter trigger fetches of
        GET /admin/<tab>?status=<filter>. Tables render via DOM, never
        innerHTML — admin sees user-controlled data so safe rendering matters.
     4. Logout: clear token + show login.

   All API calls use apiCall() which attaches the bearer header. A 401
   anywhere kicks the user back to login (auto-logout on expiry).
   ════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ── Config ──────────────────────────────────────────────────────────

  const WORKER_URL = 'https://directory-proxy-v2.silent-term-d0e4.workers.dev';
  const TOKEN_KEY  = 'deafhive_admin_token';

  // ── DOM refs ────────────────────────────────────────────────────────

  const $loginView   = document.getElementById('login-view');
  const $loginForm   = document.getElementById('login-form');
  const $loginPwd    = document.getElementById('login-password');
  const $loginSubmit = $loginForm.querySelector('button[type="submit"]');
  const $loginError  = document.getElementById('login-error');

  const $shellView   = document.getElementById('shell-view');
  const $sessionInfo = document.getElementById('session-info');
  const $logoutBtn   = document.getElementById('logout-btn');

  const $tabStrip      = document.querySelector('.tab-strip');
  const $statusFilter  = document.getElementById('status-filter');
  const $refreshBtn    = document.getElementById('refresh-btn');
  const $rowCount      = document.getElementById('row-count');

  const $tableWrap    = document.getElementById('table-wrap');
  const $table        = document.getElementById('data-table');
  const $thead        = document.getElementById('table-head');
  const $tbody        = document.getElementById('table-body');
  const $tableEmpty   = document.getElementById('table-empty');
  const $tableError   = document.getElementById('table-error');
  const $tableLoading = document.getElementById('table-loading');

  // ── State ───────────────────────────────────────────────────────────

  let currentTab = 'organisations';

  // ── Token helpers ───────────────────────────────────────────────────

  function getToken()        { return localStorage.getItem(TOKEN_KEY); }
  function setToken(t)       { localStorage.setItem(TOKEN_KEY, t); }
  function clearToken()      { localStorage.removeItem(TOKEN_KEY); }

  // ── API wrapper ─────────────────────────────────────────────────────

  async function apiCall(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    const token = getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (options.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(`${WORKER_URL}${path}`, { ...options, headers });
    // 401 → token is dead, force re-login.
    if (res.status === 401) {
      clearToken();
      showLogin('Session expired — please sign in again.');
      throw new Error('unauthorised');
    }
    return res;
  }

  // ── View switching ──────────────────────────────────────────────────

  function showLogin(message) {
    $shellView.hidden = true;
    $loginView.hidden = false;
    if (message) {
      $loginError.textContent = message;
      $loginError.hidden = false;
    } else {
      $loginError.hidden = true;
    }
    $loginPwd.value = '';
    setTimeout(() => $loginPwd.focus(), 0);
  }

  function showShell() {
    $loginView.hidden = true;
    $shellView.hidden = false;
  }

  // ── Login flow ──────────────────────────────────────────────────────

  $loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = $loginPwd.value;
    if (!password) return;

    $loginSubmit.disabled = true;
    $loginError.hidden = true;

    try {
      const res = await fetch(`${WORKER_URL}/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });

      if (res.status === 401) {
        $loginError.textContent = 'Wrong password.';
        $loginError.hidden = false;
        return;
      }
      if (res.status === 503) {
        $loginError.textContent = 'Admin authentication is not configured on the server yet.';
        $loginError.hidden = false;
        return;
      }
      if (!res.ok) {
        $loginError.textContent = `Login failed (${res.status}).`;
        $loginError.hidden = false;
        return;
      }

      const data = await res.json();
      setToken(data.token);
      renderSessionInfo(data.expires);
      showShell();
      await loadTable();
    } catch (err) {
      $loginError.textContent = `Network error: ${err.message || err}`;
      $loginError.hidden = false;
    } finally {
      $loginSubmit.disabled = false;
    }
  });

  $logoutBtn.addEventListener('click', () => {
    clearToken();
    showLogin();
  });

  // ── Session info ────────────────────────────────────────────────────

  function renderSessionInfo(expiresEpoch) {
    if (!expiresEpoch) {
      $sessionInfo.textContent = 'Signed in.';
      return;
    }
    const d = new Date(expiresEpoch * 1000);
    const fmt = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' });
    $sessionInfo.textContent = `Signed in · session until ${fmt.format(d)}`;
  }

  // ── Tabs ────────────────────────────────────────────────────────────

  $tabStrip.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    const tab = btn.dataset.tab;
    if (!tab || tab === currentTab) return;

    for (const b of $tabStrip.querySelectorAll('.tab-btn')) {
      const isActive = b === btn;
      b.classList.toggle('is-active', isActive);
      b.setAttribute('aria-selected', String(isActive));
    }
    currentTab = tab;
    loadTable();
  });

  $statusFilter.addEventListener('change', loadTable);
  $refreshBtn.addEventListener('click', loadTable);

  // ── Table renderer ──────────────────────────────────────────────────

  const COLUMNS = {
    organisations: [
      { key: 'name',           label: 'Name',     render: text },
      { key: 'status',         label: 'Status',   render: badge },
      { key: 'logo_url',       label: 'Logo',     render: thumb },
      { key: 'category_types', label: 'Categories', render: chips },
      { key: 'website',        label: 'Website',  render: link },
      { key: 'email_public',   label: 'Email',    render: text },
      { key: 'submitted_via',  label: 'Via',      render: text },
      { key: 'updated_at',     label: 'Updated',  render: epoch },
    ],
    events: [
      { key: 'name',              label: 'Event',         render: text },
      { key: 'status',            label: 'Status',        render: badge },
      { key: 'event_date',        label: 'Date',          render: datetime },
      { key: 'organisation_name', label: 'Organisation',  render: text },
      { key: 'address',           label: 'Address',       render: text },
      { key: 'poster_url',        label: 'Poster',        render: thumb },
      { key: 'submitted_via',     label: 'Via',           render: text },
      { key: 'updated_at',        label: 'Updated',       render: epoch },
    ],
    videos: [
      { key: 'name',              label: 'Video',        render: text },
      { key: 'status',            label: 'Status',       render: badge },
      { key: 'display_order',     label: 'Pin',          render: orderPin },
      { key: 'youtube_url',       label: 'YouTube',      render: link },
      { key: 'video_url',         label: 'R2 file',      render: link },
      { key: 'poster_url',        label: 'Poster',       render: thumb },
      { key: 'organisation_name', label: 'Organisation', render: text },
      { key: 'updated_at',        label: 'Updated',      render: epoch },
    ],
  };

  // Renderers — each returns a DOM node, never an HTML string.

  function text(val) {
    if (val == null || val === '') return muted('—');
    return document.createTextNode(String(val));
  }

  function muted(s) {
    const span = document.createElement('span');
    span.className = 'muted';
    span.textContent = s;
    return span;
  }

  function badge(status) {
    if (!status) return muted('—');
    const span = document.createElement('span');
    span.className = `badge is-${status}`;
    span.textContent = status;
    return span;
  }

  function thumb(url) {
    if (!url) return muted('—');
    const img = document.createElement('img');
    img.className = 'thumb';
    img.src = url;
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    // R2 images won't load until media.deafhive.online resolves — graceful fallback
    img.addEventListener('error', () => img.replaceWith(muted('(no image)')));
    return img;
  }

  function chips(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return muted('—');
    const frag = document.createDocumentFragment();
    arr.forEach((tag, i) => {
      if (i > 0) frag.appendChild(document.createTextNode(', '));
      frag.appendChild(document.createTextNode(String(tag)));
    });
    return frag;
  }

  function link(url) {
    if (!url) return muted('—');
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    // Show a short label, not the raw URL
    try {
      const u = new URL(url);
      a.textContent = u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/$/, '');
    } catch {
      a.textContent = url;
    }
    return a;
  }

  function datetime(iso) {
    if (!iso) return muted('—');
    const d = new Date(iso);
    if (isNaN(d)) return document.createTextNode(iso);
    const fmt = new Intl.DateTimeFormat('en-GB', {
      dateStyle: 'medium', timeStyle: 'short',
    });
    return document.createTextNode(fmt.format(d));
  }

  function epoch(secs) {
    if (!secs) return muted('—');
    const d = new Date(secs * 1000);
    if (isNaN(d)) return muted('—');
    const fmt = new Intl.DateTimeFormat('en-GB', { dateStyle: 'short' });
    return document.createTextNode(fmt.format(d));
  }

  function orderPin(n) {
    if (n == null) return muted('—');
    const span = document.createElement('span');
    span.textContent = `#${n}`;
    return span;
  }

  // ── Load + render a table ───────────────────────────────────────────

  function setState(state) {
    $table.hidden        = state !== 'data';
    $tableEmpty.hidden   = state !== 'empty';
    $tableError.hidden   = state !== 'error';
    $tableLoading.hidden = state !== 'loading';
  }

  async function loadTable() {
    setState('loading');
    $rowCount.textContent = '';

    const status = $statusFilter.value;
    let data;
    try {
      const res = await apiCall(`/admin/${currentTab}?status=${encodeURIComponent(status)}`);
      if (!res.ok) {
        $tableError.textContent = `Failed to load (${res.status}).`;
        setState('error');
        return;
      }
      data = await res.json();
    } catch (err) {
      // apiCall already showed login on 401; otherwise surface error.
      if (err.message !== 'unauthorised') {
        $tableError.textContent = `Network error: ${err.message || err}`;
        setState('error');
      }
      return;
    }

    const records = Array.isArray(data.records) ? data.records : [];
    $rowCount.textContent = `${records.length} ${records.length === 1 ? 'row' : 'rows'}`;

    if (records.length === 0) {
      setState('empty');
      return;
    }

    renderTable(currentTab, records);
    setState('data');
  }

  function renderTable(tab, records) {
    const cols = COLUMNS[tab] || [];

    // Header
    while ($thead.firstChild) $thead.removeChild($thead.firstChild);
    for (const col of cols) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = col.label;
      $thead.appendChild(th);
    }

    // Body
    while ($tbody.firstChild) $tbody.removeChild($tbody.firstChild);
    for (const rec of records) {
      const tr = document.createElement('tr');
      tr.dataset.id = rec.id;
      for (const col of cols) {
        const td = document.createElement('td');
        const val = rec.fields ? rec.fields[col.key] : undefined;
        const node = col.render(val);
        if (node) td.appendChild(node);
        tr.appendChild(td);
      }
      $tbody.appendChild(tr);
    }
  }

  // ── Boot ────────────────────────────────────────────────────────────

  (async function init() {
    const token = getToken();
    if (!token) { showLogin(); return; }

    try {
      const res = await fetch(`${WORKER_URL}/admin/whoami`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (res.status === 401) {
        clearToken();
        showLogin();
        return;
      }
      if (!res.ok) {
        showLogin(`Could not verify session (${res.status}).`);
        return;
      }
      const data = await res.json();
      renderSessionInfo(data.expires);
      showShell();
      await loadTable();
    } catch (err) {
      showLogin(`Network error: ${err.message || err}`);
    }
  })();

}());
