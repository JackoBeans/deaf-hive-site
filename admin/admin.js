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

  const SCHEMA = {
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

  // ── State ───────────────────────────────────────────────────────────

  let currentTab = 'organisations';
  // Editor state — null when modal closed, {mode, id, record, pendingFields} when open.
  let editor = null;
  // Cached org list for the org-picker dropdown in events/videos forms.
  let orgCache = null;

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

  function actionsCell() {
    const wrap = document.createElement('div');
    wrap.className = 'row-actions';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'icon-btn js-row-delete';
    del.title = 'Delete';
    del.setAttribute('aria-label', 'Delete row');
    del.textContent = '🗑';
    wrap.appendChild(del);
    return wrap;
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
    setTimeout(() => {
      const first = $editFields.querySelector('input,textarea,select');
      if (first && typeof first.focus === 'function') first.focus();
    }, 0);
  }

  function closeEditModal() {
    $editModal.hidden = true;
    document.body.style.overflow = '';
    editor = null;
  }

  $editModal.addEventListener('click', (e) => {
    if (e.target.dataset && 'close' in e.target.dataset) closeEditModal();
  });
  $editCancel.addEventListener('click', closeEditModal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$editModal.hidden) closeEditModal();
  });

  // ── Edit form renderer ─────────────────────────────────────────────

  function renderEditForm() {
    while ($editFields.firstChild) $editFields.removeChild($editFields.firstChild);
    const schema = SCHEMA[currentTab];
    const f = editor.record.fields || {};
    for (const def of schema.fields) {
      $editFields.appendChild(renderField(def, f[def.key]));
    }
  }

  function renderField(def, value) {
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
      const method = editor.mode === 'create' ? 'POST' : 'PUT';
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
