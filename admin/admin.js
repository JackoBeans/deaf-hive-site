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

  const STATUS_VALUES = ['pending', 'approved', 'rejected', 'draft'];

  // Existing vocabulary — admin-managed editing comes later (Phase 5
  // schema addendum). For now these match the public site's filter chips.
  const CATEGORY_TYPES = ['Community', 'Education', 'Sports', 'Faith', 'Arts', 'Health', 'Support'];
  const AGE_CATEGORIES = ['Children (0-12)', 'Young people (13-24)', 'Adults (25-59)', 'Seniors (60+)', 'All ages'];

  // ── Per-table form schema (drives the edit modal renderer) ─────────

  const ROLE_OPTIONS   = ['owner', 'admin'];
  const STATUS_USERS   = ['active', 'disabled'];

  const SCHEMA = {
    users: {
      label: 'User',
      // Users don't use the upload widget; this stays unused.
      uploadFolder: 'orgs',
      fields: [
        { key: 'email',        label: 'Email',         type: 'email',  required: true },
        { key: 'display_name', label: 'Display name',  type: 'text' },
        { key: 'role',         label: 'Role',          type: 'choice', options: ROLE_OPTIONS,    ownerOnly: true },
        { key: 'status',       label: 'Status',        type: 'choice', options: STATUS_USERS,    ownerOnly: true },
        { key: 'password',     label: 'Set new password', type: 'password' },
      ],
    },
    organisations: {
      label: 'Organisation',
      uploadFolder: 'orgs',
      fields: [
        { key: 'name',           label: 'Name',                 type: 'text',     required: true },
        { key: 'status',         label: 'Status',               type: 'status' },
        { key: 'about',          label: 'About (Markdown)',     type: 'textarea' },
        { key: 'logo_r2_key',    label: 'Logo',                 type: 'image',    urlKey: 'logo_url', accept: 'image/*' },
        { key: 'website',        label: 'Website',              type: 'url' },
        { key: 'email_public',   label: 'Public contact email', type: 'email' },
        { key: 'email_admin',    label: 'Admin email (private)', type: 'email' },
        { key: 'address',        label: 'Address',              type: 'text' },
        { key: 'category_types', label: 'Category Types',       type: 'chips',    options: CATEGORY_TYPES },
        { key: 'age_categories', label: 'Age Categories',       type: 'chips',    options: AGE_CATEGORIES },
      ],
    },
    events: {
      label: 'Event',
      uploadFolder: 'events',
      fields: [
        { key: 'name',            label: 'Event name',  type: 'text',     required: true },
        { key: 'status',          label: 'Status',      type: 'status' },
        { key: 'event_date',      label: 'Date & time', type: 'datetime', required: true },
        { key: 'organisation_id', label: 'Organisation',type: 'org-picker' },
        { key: 'address',         label: 'Address',     type: 'text' },
        { key: 'details',         label: 'Details',     type: 'textarea' },
        { key: 'poster_r2_key',   label: 'Poster',      type: 'image', urlKey: 'poster_url', accept: 'image/*' },
      ],
    },
    videos: {
      label: 'Video',
      uploadFolder: 'videos',
      fields: [
        { key: 'name',            label: 'Title',       type: 'text', required: true },
        { key: 'status',          label: 'Status',      type: 'status' },
        { key: 'youtube_url',     label: 'YouTube URL', type: 'url' },
        { key: 'video_r2_key',    label: 'Video file (R2)', type: 'video', urlKey: 'video_url', accept: 'video/*' },
        { key: 'poster_r2_key',   label: 'Poster (optional)', type: 'image', urlKey: 'poster_url', accept: 'image/*' },
        { key: 'description',     label: 'Description', type: 'textarea' },
        { key: 'organisation_id', label: 'Organisation (optional)', type: 'org-picker' },
        { key: 'display_order',   label: 'Pin order (lower = first)', type: 'number' },
      ],
    },
  };

  // ── DOM refs ────────────────────────────────────────────────────────

  const $loginView   = document.getElementById('login-view');
  const $loginForm   = document.getElementById('login-form');
  const $loginEmail  = document.getElementById('login-email');
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
  const $newBtn       = document.getElementById('new-btn');

  const $editModal    = document.getElementById('edit-modal');
  const $editForm     = document.getElementById('edit-form');
  const $editTitle    = document.getElementById('edit-modal-title');
  const $editFields   = document.getElementById('edit-fields');
  const $editError    = document.getElementById('edit-error');
  const $editDelete   = document.getElementById('edit-delete-btn');
  const $editCancel   = document.getElementById('edit-cancel-btn');
  const $editSave     = document.getElementById('edit-save-btn');

  const $confirmModal = document.getElementById('confirm-modal');
  const $confirmMsg   = document.getElementById('confirm-message');
  const $confirmYes   = document.getElementById('confirm-yes');
  const $confirmNo    = document.getElementById('confirm-no');

  // Forgot / reset / change-password views & modals
  const $forgotView   = document.getElementById('forgot-view');
  const $forgotForm   = document.getElementById('forgot-form');
  const $forgotEmail  = document.getElementById('forgot-email');
  const $forgotInfo   = document.getElementById('forgot-info');
  const $forgotError  = document.getElementById('forgot-error');

  const $resetView    = document.getElementById('reset-view');
  const $resetForm    = document.getElementById('reset-form');
  const $resetPw      = document.getElementById('reset-pw');
  const $resetConfirm = document.getElementById('reset-confirm');
  const $resetInfo    = document.getElementById('reset-info');
  const $resetError   = document.getElementById('reset-error');

  const $changePwBtn      = document.getElementById('change-pw-btn');
  const $changePwModal    = document.getElementById('changepw-modal');
  const $changePwForm     = document.getElementById('changepw-form');
  const $changePwCurrent  = document.getElementById('changepw-current');
  const $changePwNew      = document.getElementById('changepw-new');
  const $changePwConfirm  = document.getElementById('changepw-confirm');
  const $changePwError    = document.getElementById('changepw-error');
  const $changePwOk       = document.getElementById('changepw-ok');

  const $resetLinkModal  = document.getElementById('resetlink-modal');
  const $resetLinkUrl    = document.getElementById('resetlink-url');
  const $resetLinkExpiry = document.getElementById('resetlink-expiry');
  const $resetLinkCopy   = document.getElementById('resetlink-copy');

  // ── State ───────────────────────────────────────────────────────────

  let currentTab = 'organisations';
  // Editor state — null when modal closed, {mode, id, record, pendingFields} when open.
  let editor = null;
  // Cached org list for the org-picker dropdown in events/videos forms.
  let orgCache = null;
  // Currently signed-in user — populated by login + whoami; null when signed out.
  let currentUser = null;

  // ── Token helpers ───────────────────────────────────────────────────

  function getToken()        { return localStorage.getItem(TOKEN_KEY); }
  function setToken(t)       { localStorage.setItem(TOKEN_KEY, t); }
  function clearToken()      { localStorage.removeItem(TOKEN_KEY); }

  // ── API wrapper ─────────────────────────────────────────────────────

  async function apiCall(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    const token = getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    // Don't set Content-Type for FormData — the browser sets it with the
    // multipart boundary. Setting it manually breaks the upload.
    if (options.body && !headers['Content-Type'] && !(options.body instanceof FormData)) {
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

  function hideAuthViews() {
    $loginView.hidden = true;
    $forgotView.hidden = true;
    $resetView.hidden = true;
  }

  function showLogin(message) {
    $shellView.hidden = true;
    hideAuthViews();
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

  function showForgot() {
    $shellView.hidden = true;
    hideAuthViews();
    $forgotView.hidden = false;
    $forgotInfo.hidden = true;
    $forgotError.hidden = true;
    $forgotEmail.value = '';
    setTimeout(() => $forgotEmail.focus(), 0);
  }

  function showReset(token) {
    $shellView.hidden = true;
    hideAuthViews();
    $resetView.hidden = false;
    $resetInfo.hidden = true;
    $resetError.hidden = true;
    $resetPw.value = '';
    $resetConfirm.value = '';
    $resetForm.dataset.token = token;
    setTimeout(() => $resetPw.focus(), 0);
  }

  function showShell() {
    hideAuthViews();
    $shellView.hidden = false;
  }

  // ── Login flow ──────────────────────────────────────────────────────

  $loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email    = ($loginEmail.value || '').trim();
    const password = $loginPwd.value;
    if (!email || !password) return;

    $loginSubmit.disabled = true;
    $loginError.hidden = true;

    try {
      const res = await fetch(`${WORKER_URL}/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      if (res.status === 401) {
        $loginError.textContent = 'Wrong email or password.';
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
      currentUser = data.user;
      applyRoleVisibility();
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
    currentUser = null;
    showLogin();
  });

  // ── Session info ────────────────────────────────────────────────────

  function renderSessionInfo(expiresEpoch) {
    const parts = [];
    if (currentUser) {
      const who = currentUser.display_name || currentUser.email || '';
      parts.push(`Signed in as ${who} (${currentUser.role})`);
    } else {
      parts.push('Signed in.');
    }
    if (expiresEpoch) {
      const d = new Date(expiresEpoch * 1000);
      const fmt = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' });
      parts.push(`session until ${fmt.format(d)}`);
    }
    $sessionInfo.textContent = parts.join(' · ');
  }

  // Show owner-only UI bits (currently: the Users tab) based on currentUser.
  function applyRoleVisibility() {
    const usersBtn = document.querySelector('.tab-btn[data-tab="users"]');
    if (!usersBtn) return;
    const isOwner = currentUser?.role === 'owner';
    usersBtn.hidden = !isOwner;
    // If a non-owner is somehow stuck on the users tab, kick them home.
    if (!isOwner && currentTab === 'users') {
      currentTab = 'organisations';
      for (const b of $tabStrip.querySelectorAll('.tab-btn')) {
        const active = b.dataset.tab === 'organisations';
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-selected', String(active));
      }
    }
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
    users: [
      { key: 'email',         label: 'Email',         render: text },
      { key: 'display_name',  label: 'Name',          render: text },
      { key: 'role',          label: 'Role',          render: rolePill },
      { key: 'status',        label: 'Status',        render: badge },
      { key: 'last_login_at', label: 'Last login',    render: epoch },
      { key: 'created_at',    label: 'Created',       render: epoch },
      { key: '__actions',     label: '',              render: userActionsCell },
    ],
    organisations: [
      { key: 'name',           label: 'Name',     render: text },
      { key: 'status',         label: 'Status',   render: badge },
      { key: 'logo_url',       label: 'Logo',     render: thumb },
      { key: 'category_types', label: 'Categories', render: chips },
      { key: 'website',        label: 'Website',  render: link },
      { key: 'email_public',   label: 'Email',    render: text },
      { key: 'submitted_via',  label: 'Via',      render: text },
      { key: 'updated_at',     label: 'Updated',  render: epoch },
      { key: '__actions',      label: '',         render: actionsCell },
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
      { key: '__actions',         label: '',              render: actionsCell },
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
      { key: '__actions',         label: '',             render: actionsCell },
    ],
  };

  function actionsCell(_, rec) {
    const wrap = document.createElement('div');
    wrap.className = 'row-actions';
    // Explicit Edit button — the row-click shortcut stays for mouse
    // users, but a <tr> click handler is unreachable by keyboard, so
    // this is the keyboard path into the edit modal (WCAG 2.1.1).
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'icon-btn js-row-edit';
    edit.title = 'Edit';
    edit.setAttribute('aria-label', `Edit ${rowName(rec)}`);
    edit.textContent = '✏️';
    wrap.appendChild(edit);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'icon-btn js-row-delete';
    del.title = 'Delete';
    del.setAttribute('aria-label', `Delete ${rowName(rec)}`);
    del.textContent = '🗑';
    wrap.appendChild(del);
    return wrap;
  }

  // User-specific actions cell: same delete affordance, but skip on the
  // current user's own row (server also blocks self-delete; the UI
  // mirrors so it's not even surfaced).
  function userActionsCell(_, rec) {
    if (currentUser && rec && currentUser.id === rec.id) {
      return muted('(you)');
    }
    return actionsCell(_, rec);
  }

  function rolePill(role) {
    if (!role) return muted('—');
    const span = document.createElement('span');
    span.className = `badge is-${role === 'owner' ? 'approved' : 'draft'}`;
    span.textContent = role;
    return span;
  }

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

  // Real <button> so the status-cycle action is keyboard-operable —
  // a span with a click handler is mouse-only (WCAG 2.1.1).
  function badge(status, rec) {
    if (!status) return muted('—');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `badge is-${status}`;
    btn.textContent = status;
    btn.setAttribute('aria-label', `Status: ${status} — ${rowName(rec)}. Click to change.`);
    return btn;
  }

  // Human identifier for a row, used in action-button labels so screen
  // readers hear "Delete Bristol Deaf Club", not "Delete row".
  function rowName(rec) {
    const f = (rec && rec.fields) || {};
    return f.name || f.email || (rec ? `#${rec.id}` : 'row');
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
    // Public submitters can land arbitrary URLs in the org website + video
    // youtube_url fields. Render only http(s) as a real anchor — anything
    // else (javascript:, data:, vbscript:, file:, etc.) becomes plain text
    // so a click can't execute code in the admin origin.
    let u;
    try { u = new URL(url); }
    catch { return document.createTextNode(url); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return document.createTextNode(url);
    }
    const a = document.createElement('a');
    a.href = u.href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/$/, '');
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

    // Users tab has no Status filter; hide the control on that tab.
    const $statusWrap = $statusFilter.closest('.toolbar')?.querySelector('label[for="status-filter"]') || null;
    $statusFilter.hidden = currentTab === 'users';
    if ($statusWrap) $statusWrap.hidden = currentTab === 'users';

    const status = $statusFilter.value;
    let data;
    try {
      const path = currentTab === 'users'
        ? '/admin/users'
        : `/admin/${currentTab}?status=${encodeURIComponent(status)}`;
      const res = await apiCall(path);
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
        const node = col.render(val, rec);
        if (node) td.appendChild(node);
        tr.appendChild(td);
      }
      $tbody.appendChild(tr);
    }
  }

  // ── Table-row interactions ──────────────────────────────────────────

  $tbody.addEventListener('click', async (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const id = Number(tr.dataset.id);

    // Delete button click
    if (e.target.closest('.js-row-delete')) {
      e.stopPropagation();
      return confirmDelete(id);
    }

    // Edit button click (keyboard path — row click is mouse-only)
    if (e.target.closest('.js-row-edit')) {
      e.stopPropagation();
      return openEditModalFor(id);
    }

    // Status badge click → cycle to next status
    if (e.target.closest('.badge')) {
      e.stopPropagation();
      return cycleStatus(id, e.target.closest('.badge').textContent.trim());
    }

    // Row click → open edit modal
    return openEditModalFor(id);
  });

  $newBtn.addEventListener('click', () => openEditModalNew());

  // ── Status cycle (pending → approved → rejected → pending) ──────────

  const STATUS_CYCLE = { pending: 'approved', approved: 'rejected', rejected: 'pending', draft: 'pending' };

  async function cycleStatus(id, currentStatus) {
    const next = STATUS_CYCLE[currentStatus] || 'pending';
    try {
      const res = await apiCall(`/admin/${currentTab}/${id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        alert(`Status change failed: ${j.error || res.status}`);
        return;
      }
      await loadTable();
    } catch (err) {
      if (err.message !== 'unauthorised') alert(`Network error: ${err.message || err}`);
    }
  }

  // ── Modal focus management ──────────────────────────────────────────
  // Every modal: save the element that had focus at open, make everything
  // except the topmost modal inert (keyboard + screen-reader users can't
  // wander into the background), restore focus on close. Stack-based so
  // the confirm and reset-link modals can sit on top of the edit modal.
  // Same pattern as createModalAPI in the public site's app.js.

  const modalStack = [];

  function recomputeInert() {
    const top = modalStack.length ? modalStack[modalStack.length - 1].modal : null;
    for (const el of document.body.children) {
      if (el.tagName === 'SCRIPT') continue;
      if (top && el !== top) el.setAttribute('inert', '');
      else el.removeAttribute('inert');
    }
  }

  function modalOpened(modal) {
    modalStack.push({ modal, prev: document.activeElement });
    recomputeInert();
  }

  function modalClosed(modal) {
    for (let i = modalStack.length - 1; i >= 0; i--) {
      if (modalStack[i].modal !== modal) continue;
      const { prev } = modalStack.splice(i, 1)[0];
      recomputeInert();
      if (prev && typeof prev.focus === 'function') prev.focus();
      return;
    }
  }

  // ── Edit modal — open / close ───────────────────────────────────────

  function openEditModalNew() {
    editor = { mode: 'create', id: null, record: { id: null, fields: {} }, pendingFields: {} };
    $editTitle.textContent = `New ${SCHEMA[currentTab].label.toLowerCase()}`;
    $editDelete.hidden = true;
    $editError.hidden = true;
    renderEditForm();
    showEditModal();
  }

  async function openEditModalFor(id) {
    try {
      const res = await apiCall(`/admin/${currentTab}/${id}`);
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        alert(`Could not load row: ${j.error || res.status}`);
        return;
      }
      const data = await res.json();
      editor = { mode: 'edit', id, record: data.record, pendingFields: {} };
      $editTitle.textContent = `Edit ${SCHEMA[currentTab].label.toLowerCase()}`;
      $editDelete.hidden = false;
      $editError.hidden = true;
      renderEditForm();
      showEditModal();
    } catch (err) {
      if (err.message !== 'unauthorised') alert(`Network error: ${err.message || err}`);
    }
  }

  function showEditModal() {
    $editModal.hidden = false;
    document.body.style.overflow = 'hidden';
    modalOpened($editModal);
    setTimeout(() => {
      const first = $editFields.querySelector('input,textarea,select');
      if (first && typeof first.focus === 'function') first.focus();
    }, 0);
  }

  function closeEditModal() {
    $editModal.hidden = true;
    document.body.style.overflow = '';
    editor = null;
    modalClosed($editModal);
  }

  $editModal.addEventListener('click', (e) => {
    if (e.target.dataset && 'close' in e.target.dataset) closeEditModal();
  });
  $editCancel.addEventListener('click', closeEditModal);
  // One Escape handler for all four modals, topmost first — confirm and
  // reset-link can stack on top of the edit modal. The confirm modal's
  // close logic lives in listeners scoped inside confirmDelete(), so
  // Escape routes through a click on its Cancel button.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$resetLinkModal.hidden) { closeResetLinkModal(); return; }
    if (!$confirmModal.hidden)   { $confirmNo.click(); return; }
    if (!$changePwModal.hidden)  { closeChangePw(); return; }
    if (!$editModal.hidden)      { closeEditModal(); }
  });

  // ── Edit form renderer ─────────────────────────────────────────────

  function renderEditForm() {
    while ($editFields.firstChild) $editFields.removeChild($editFields.firstChild);
    const schema = SCHEMA[currentTab];
    const f = editor.record.fields || {};
    for (const def of schema.fields) {
      $editFields.appendChild(renderField(def, f[def.key]));
    }
    // Owner-only "Create reset link" button — shown only when editing
    // an existing user that's NOT the signed-in user. The signed-in
    // user uses "Change password" in the header instead.
    if (currentTab === 'users'
        && editor.mode === 'edit'
        && currentUser?.role === 'owner'
        && currentUser.id !== editor.id) {
      const wrap = document.createElement('div');
      wrap.className = 'field';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn';
      btn.textContent = 'Create reset link';
      btn.addEventListener('click', () => generateResetLinkForUser(editor.id));
      const hint = document.createElement('span');
      hint.className = 'field-hint';
      hint.textContent = '24-hour single-use link. Share out-of-band until Resend email is enabled.';
      wrap.appendChild(btn);
      wrap.appendChild(hint);
      $editFields.appendChild(wrap);
    }
  }

  function renderField(def, value) {
    // ownerOnly fields are hidden from non-owners completely. The server
    // rejects writes from them too; this keeps the UI honest.
    if (def.ownerOnly && currentUser?.role !== 'owner') {
      return document.createDocumentFragment();
    }

    const wrap = document.createElement('div');
    wrap.className = `field field-${def.type}`;

    const label = document.createElement('label');
    label.className = 'field-label';
    label.textContent = def.label + (def.required ? ' *' : '');
    wrap.appendChild(label);

    let input;
    switch (def.type) {
      case 'text':
      case 'email':
      case 'url':
      case 'number': {
        input = document.createElement('input');
        input.type = def.type === 'number' ? 'number' : def.type;
        input.value = value == null ? '' : String(value);
        wireInput(input, def.key, def.type === 'number' ? 'number' : 'string');
        break;
      }
      case 'datetime': {
        input = document.createElement('input');
        input.type = 'datetime-local';
        input.value = isoToLocalInput(value);
        input.addEventListener('input', () => {
          editor.pendingFields[def.key] = input.value ? localInputToIso(input.value) : null;
        });
        break;
      }
      case 'textarea': {
        input = document.createElement('textarea');
        input.value = value == null ? '' : String(value);
        wireInput(input, def.key, 'string');
        break;
      }
      case 'status': {
        input = document.createElement('div');
        input.className = 'field-chips';
        const current = value || 'draft';
        for (const s of STATUS_VALUES) {
          const chip = document.createElement('label');
          chip.className = 'chip-toggle' + (s === current ? ' is-checked' : '');
          chip.dataset.status = s;
          const cb = document.createElement('input');
          cb.type = 'radio';
          cb.name = '__status';
          cb.value = s;
          cb.checked = s === current;
          chip.appendChild(cb);
          chip.appendChild(document.createTextNode(' ' + s));
          chip.addEventListener('click', (e) => {
            e.preventDefault();
            for (const c of input.querySelectorAll('.chip-toggle')) c.classList.remove('is-checked');
            chip.classList.add('is-checked');
            cb.checked = true;
            editor.pendingFields[def.key] = s;
          });
          input.appendChild(chip);
        }
        break;
      }
      case 'chips': {
        input = document.createElement('div');
        input.className = 'field-chips';
        const selected = new Set(Array.isArray(value) ? value : []);
        for (const opt of def.options) {
          const chip = document.createElement('label');
          chip.className = 'chip-toggle' + (selected.has(opt) ? ' is-checked' : '');
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = selected.has(opt);
          chip.appendChild(cb);
          chip.appendChild(document.createTextNode(' ' + opt));
          chip.addEventListener('click', (e) => {
            e.preventDefault();
            cb.checked = !cb.checked;
            chip.classList.toggle('is-checked', cb.checked);
            const all = Array.from(input.querySelectorAll('input[type=checkbox]'))
              .map((c, i) => c.checked ? def.options[i] : null)
              .filter(Boolean);
            editor.pendingFields[def.key] = all;
          });
          input.appendChild(chip);
        }
        break;
      }
      case 'image':
      case 'video': {
        input = renderUploadField(def, value, editor.record.fields[def.urlKey]);
        break;
      }
      case 'org-picker': {
        input = renderOrgPicker(def, value);
        break;
      }
      case 'password': {
        input = document.createElement('input');
        input.type = 'password';
        input.autocomplete = 'new-password';
        input.placeholder = editor.mode === 'create' ? '' : '(leave blank to keep current)';
        wireInput(input, def.key, 'string');
        break;
      }
      case 'choice': {
        input = document.createElement('select');
        for (const opt of def.options || []) {
          const o = document.createElement('option');
          o.value = opt;
          o.textContent = opt;
          if (value === opt) o.selected = true;
          input.appendChild(o);
        }
        input.addEventListener('change', () => {
          editor.pendingFields[def.key] = input.value;
        });
        break;
      }
      default: {
        input = document.createElement('input');
        input.type = 'text';
        input.value = value == null ? '' : String(value);
        wireInput(input, def.key, 'string');
      }
    }
    wrap.appendChild(input);
    return wrap;
  }

  function wireInput(input, key, kind) {
    input.addEventListener('input', () => {
      const raw = input.value;
      if (raw === '') editor.pendingFields[key] = null;
      else if (kind === 'number') {
        const n = Number(raw);
        editor.pendingFields[key] = Number.isFinite(n) ? n : null;
      } else {
        editor.pendingFields[key] = raw;
      }
    });
  }

  function renderUploadField(def, currentKey, currentUrl) {
    const wrap = document.createElement('div');
    wrap.className = 'upload-widget';

    const preview = document.createElement('img');
    preview.className = 'upload-preview';
    preview.alt = '';
    if (currentUrl) preview.src = currentUrl;
    preview.addEventListener('error', () => { preview.style.visibility = 'hidden'; });
    wrap.appendChild(preview);

    const right = document.createElement('div');
    right.style.flex = '1';

    const file = document.createElement('input');
    file.type = 'file';
    file.accept = def.accept || '*/*';
    right.appendChild(file);

    const status = document.createElement('div');
    status.className = 'upload-status';
    // Live region — upload progress/errors are announced as the text
    // changes (the element exists before any update, so this works).
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.textContent = currentKey ? `Current: ${currentKey}` : '(no file)';
    right.appendChild(status);

    file.addEventListener('change', async () => {
      const f = file.files && file.files[0];
      if (!f) return;
      status.textContent = `Uploading ${f.name}…`;
      try {
        const form = new FormData();
        form.append('file', f);
        form.append('folder', SCHEMA[currentTab].uploadFolder);
        const res = await apiCall('/admin/upload', { method: 'POST', body: form });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          status.textContent = `Upload failed: ${j.error || res.status}`;
          return;
        }
        const j = await res.json();
        editor.pendingFields[def.key] = j.key;
        status.textContent = `Uploaded: ${j.key}`;
        preview.src = j.url;
        preview.style.visibility = 'visible';
      } catch (err) {
        if (err.message !== 'unauthorised') status.textContent = `Error: ${err.message || err}`;
      }
    });

    wrap.appendChild(right);
    return wrap;
  }

  function renderOrgPicker(def, currentId) {
    const sel = document.createElement('select');
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = '— none —';
    sel.appendChild(blank);

    // Populate from cache (or fetch in background)
    function fillFromCache() {
      while (sel.children.length > 1) sel.removeChild(sel.lastChild);
      for (const r of (orgCache || [])) {
        const o = document.createElement('option');
        o.value = String(r.id);
        o.textContent = r.fields.name;
        if (currentId != null && Number(currentId) === r.id) o.selected = true;
        sel.appendChild(o);
      }
    }

    if (orgCache) {
      fillFromCache();
    } else {
      apiCall('/admin/organisations?status=all').then(async (res) => {
        if (!res.ok) return;
        const data = await res.json();
        orgCache = data.records || [];
        fillFromCache();
      }).catch(() => {});
    }

    sel.addEventListener('change', () => {
      editor.pendingFields[def.key] = sel.value === '' ? null : Number(sel.value);
    });
    return sel;
  }

  // ── Date conversion (D1 stores ISO 8601 UTC) ───────────────────────

  function isoToLocalInput(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const pad = n => String(n).padStart(2, '0');
    // datetime-local expects YYYY-MM-DDTHH:MM (in local time)
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function localInputToIso(localStr) {
    if (!localStr) return null;
    // Treat input as local time, convert to UTC ISO string.
    return new Date(localStr).toISOString();
  }

  // ── Save / delete ──────────────────────────────────────────────────

  $editForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!editor) return;

    // Editing with no changes → treat as cancel. Avoids the server's
    // no_op error and matches user expectation ("Save with nothing
    // changed" = close).
    if (editor.mode === 'edit' && Object.keys(editor.pendingFields).length === 0) {
      closeEditModal();
      return;
    }

    $editError.hidden = true;
    $editSave.disabled = true;

    const payload = { fields: editor.pendingFields };

    // For create, the pendingFields must include required ones — also merge
    // the empty record so the server sees the shape it expects.
    if (editor.mode === 'create') {
      // Fold in any defaulted values the user didn't touch
      const merged = { ...editor.record.fields, ...editor.pendingFields };
      payload.fields = merged;
    }

    try {
      const path = editor.mode === 'create'
        ? `/admin/${currentTab}`
        : `/admin/${currentTab}/${editor.id}`;
      // Users use PATCH for updates (partial); orgs/events/videos use PUT.
      const method = editor.mode === 'create'
        ? 'POST'
        : currentTab === 'users' ? 'PATCH' : 'PUT';
      const res = await apiCall(path, {
        method,
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        $editError.textContent = `Save failed: ${j.error || res.status}${j.message ? ` — ${j.message}` : ''}`;
        $editError.hidden = false;
        return;
      }
      closeEditModal();
      await loadTable();
    } catch (err) {
      if (err.message !== 'unauthorised') {
        $editError.textContent = `Network error: ${err.message || err}`;
        $editError.hidden = false;
      }
    } finally {
      $editSave.disabled = false;
    }
  });

  $editDelete.addEventListener('click', () => {
    if (!editor || editor.mode !== 'edit') return;
    confirmDelete(editor.id);
  });

  // ── Delete (with confirm) ──────────────────────────────────────────

  function confirmDelete(id) {
    const label = SCHEMA[currentTab].label.toLowerCase();
    $confirmMsg.textContent = `Delete this ${label}? This cannot be undone.`;
    $confirmYes.textContent = 'Delete';
    $confirmModal.hidden = false;
    document.body.style.overflow = 'hidden';
    modalOpened($confirmModal);
    // Land on the safe default — Delete is one deliberate Tab away.
    setTimeout(() => $confirmNo.focus(), 0);

    const onYes = async () => {
      cleanup();
      try {
        const res = await apiCall(`/admin/${currentTab}/${id}`, { method: 'DELETE' });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          alert(`Delete failed: ${j.error || res.status}`);
          return;
        }
        if (!$editModal.hidden) closeEditModal();
        await loadTable();
      } catch (err) {
        if (err.message !== 'unauthorised') alert(`Network error: ${err.message || err}`);
      }
    };
    const onNo = () => cleanup();
    function cleanup() {
      $confirmModal.hidden = true;
      document.body.style.overflow = $editModal.hidden ? '' : 'hidden';
      modalClosed($confirmModal);
      $confirmYes.removeEventListener('click', onYes);
      $confirmNo.removeEventListener('click', onNo);
      $confirmModal.removeEventListener('click', backdropClose);
    }
    function backdropClose(e) {
      if (e.target && e.target.dataset && 'confirmClose' in e.target.dataset) onNo();
    }
    $confirmYes.addEventListener('click', onYes);
    $confirmNo.addEventListener('click', onNo);
    $confirmModal.addEventListener('click', backdropClose);
  }

  // ── Forgot password flow ────────────────────────────────────────────

  document.getElementById('forgot-link').addEventListener('click', (e) => {
    e.preventDefault();
    showForgot();
  });
  document.getElementById('forgot-back').addEventListener('click', (e) => {
    e.preventDefault();
    showLogin();
  });

  $forgotForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = ($forgotEmail.value || '').trim();
    if (!email) return;
    $forgotInfo.hidden = true;
    $forgotError.hidden = true;
    const btn = $forgotForm.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      await fetch(`${WORKER_URL}/admin/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      // ALWAYS the same response — don't leak whether the email exists.
      $forgotInfo.textContent = 'If that email is registered, a reset link has been sent. Check your inbox in a minute or two.';
      $forgotInfo.hidden = false;
    } catch (err) {
      $forgotError.textContent = `Network error: ${err.message || err}`;
      $forgotError.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });

  // ── Reset password flow (entered via ?reset=<token> URL) ────────────

  $resetForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const token = $resetForm.dataset.token || '';
    const newPw = $resetPw.value;
    const conf  = $resetConfirm.value;
    $resetInfo.hidden = true;
    $resetError.hidden = true;
    if (newPw.length < 8) {
      $resetError.textContent = 'Password must be at least 8 characters.';
      $resetError.hidden = false;
      return;
    }
    if (newPw !== conf) {
      $resetError.textContent = 'Passwords do not match.';
      $resetError.hidden = false;
      return;
    }
    const btn = $resetForm.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const res = await fetch(`${WORKER_URL}/admin/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, new_password: newPw }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        $resetError.textContent = data.error === 'invalid_or_expired'
          ? 'This reset link is invalid, already used, or has expired. Request a new one from the sign-in page.'
          : `Reset failed: ${data.error || res.status}`;
        $resetError.hidden = false;
        return;
      }
      // Strip ?reset=… from the URL so the user can't accidentally re-use it.
      history.replaceState({}, '', window.location.pathname);
      $resetInfo.textContent = 'Password updated. You can now sign in with your new password.';
      $resetInfo.hidden = false;
      setTimeout(() => showLogin(), 1500);
    } catch (err) {
      $resetError.textContent = `Network error: ${err.message || err}`;
      $resetError.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });

  // ── Change password (header link → modal) ───────────────────────────

  function openChangePw() {
    $changePwError.hidden = true;
    $changePwOk.hidden    = true;
    $changePwCurrent.value = '';
    $changePwNew.value     = '';
    $changePwConfirm.value = '';
    $changePwModal.hidden  = false;
    document.body.style.overflow = 'hidden';
    modalOpened($changePwModal);
    setTimeout(() => $changePwCurrent.focus(), 0);
  }
  function closeChangePw() {
    if ($changePwModal.hidden) return;
    $changePwModal.hidden = true;
    document.body.style.overflow = '';
    modalClosed($changePwModal);
  }
  $changePwBtn.addEventListener('click', openChangePw);
  $changePwModal.addEventListener('click', (e) => {
    if (e.target.dataset && 'changepwClose' in e.target.dataset) closeChangePw();
  });

  $changePwForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const current = $changePwCurrent.value;
    const next    = $changePwNew.value;
    const conf    = $changePwConfirm.value;
    $changePwError.hidden = true;
    $changePwOk.hidden    = true;
    if (next.length < 8) {
      $changePwError.textContent = 'New password must be at least 8 characters.';
      $changePwError.hidden = false;
      return;
    }
    if (next !== conf) {
      $changePwError.textContent = 'New passwords do not match.';
      $changePwError.hidden = false;
      return;
    }
    const btn = $changePwForm.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const res = await apiCall('/admin/me/change-password', {
        method: 'POST',
        body: JSON.stringify({ current_password: current, new_password: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 && data.error === 'wrong_current_password') {
        $changePwError.textContent = 'Current password is wrong.';
        $changePwError.hidden = false;
        return;
      }
      if (!res.ok) {
        $changePwError.textContent = `Update failed: ${data.error || res.status}`;
        $changePwError.hidden = false;
        return;
      }
      $changePwOk.textContent = 'Password updated.';
      $changePwOk.hidden = false;
      setTimeout(closeChangePw, 1200);
    } catch (err) {
      if (err.message !== 'unauthorised') {
        $changePwError.textContent = `Network error: ${err.message || err}`;
        $changePwError.hidden = false;
      }
    } finally {
      btn.disabled = false;
    }
  });

  // ── Reset-link modal (owner opens from user edit modal) ─────────────

  function openResetLinkModal(url, expiresEpoch) {
    $resetLinkUrl.value = url;
    if (expiresEpoch) {
      const d = new Date(expiresEpoch * 1000);
      const fmt = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
      $resetLinkExpiry.textContent = `Expires ${fmt.format(d)}.`;
    } else {
      $resetLinkExpiry.textContent = '';
    }
    $resetLinkModal.hidden = false;
    document.body.style.overflow = 'hidden';
    modalOpened($resetLinkModal);
    setTimeout(() => { $resetLinkUrl.select(); }, 0);
  }
  function closeResetLinkModal() {
    $resetLinkModal.hidden = true;
    // The user-edit modal may still be open underneath.
    document.body.style.overflow = $editModal.hidden ? '' : 'hidden';
    modalClosed($resetLinkModal);
  }
  $resetLinkModal.addEventListener('click', (e) => {
    if (e.target.dataset && 'resetlinkClose' in e.target.dataset) closeResetLinkModal();
  });
  $resetLinkCopy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($resetLinkUrl.value);
      $resetLinkCopy.textContent = 'Copied!';
      setTimeout(() => { $resetLinkCopy.textContent = 'Copy link'; }, 1500);
    } catch {
      $resetLinkUrl.select();
      document.execCommand?.('copy');
    }
  });

  async function generateResetLinkForUser(userId) {
    try {
      const res = await apiCall(`/admin/users/${userId}/create-reset-link`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(`Could not create reset link: ${data.error || res.status}`);
        return;
      }
      openResetLinkModal(data.reset_url, data.expires_at);
    } catch (err) {
      if (err.message !== 'unauthorised') alert(`Network error: ${err.message || err}`);
    }
  }

  // ── Boot ────────────────────────────────────────────────────────────

  (async function init() {
    // Highest priority: a reset-token URL param takes you straight to
    // the reset screen, regardless of whether you have a stale token.
    const params = new URLSearchParams(window.location.search);
    const resetToken = params.get('reset');
    if (resetToken) {
      showReset(resetToken);
      return;
    }

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
      // whoami returns { user: { id, fields: {...} }, expires }
      const u = data.user;
      currentUser = u ? { id: u.id, ...(u.fields || {}) } : null;
      applyRoleVisibility();
      renderSessionInfo(data.expires);
      showShell();
      await loadTable();
    } catch (err) {
      showLogin(`Network error: ${err.message || err}`);
    }
  })();

}());
