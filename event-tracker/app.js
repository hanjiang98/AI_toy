/* Interface, browser storage and sync wiring. All user text goes in through textContent. */
(function () {
  'use strict';

  const S = window.EventStore;
  const STRINGS = window.EVENT_I18N;
  const MAX_FILE_MB = 25;
  const SYNC_DELAY_MS = 1200;
  const DEFAULT_REPO = 'event-tracker-data';
  const NEW_REPO_URL = `https://github.com/new?name=${DEFAULT_REPO}&visibility=private`;
  const NEW_TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new?name=Event%20Tracker&contents=write&expires_in=365';

  /* Records are kept per scope: 'local' for this browser, 'gh:owner/repo' for a GitHub repository.
   * Two people sharing a browser therefore never see or merge each other's records. */
  const KEY = {
    lang: 'eventtracker.lang',
    github: 'eventtracker.github',
    data: scope => 'eventtracker.data.' + scope,
    pending: scope => 'eventtracker.pendingDeletes.' + scope,
  };

  const $ = id => document.getElementById(id);
  const shell = $('shell'), listEl = $('list'), detailEl = $('detail'), dlg = $('dlg'), toastEl = $('toast');

  const ICONS = {
    clip: '<path d="M14 7.5 8.3 13.2a2 2 0 0 0 2.8 2.8l6.4-6.4a3.8 3.8 0 0 0-5.4-5.4L5.6 10.7a5.6 5.6 0 0 0 7.9 7.9L19 13" />',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16zM13 7l4 4" />',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />',
    x: '<path d="M6 6l12 12M18 6 6 18" />',
    back: '<path d="M15 5l-7 7 7 7" />',
  };

  function icon(name) {
    const wrap = document.createElement('span');
    wrap.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
    return wrap.firstChild;
  }

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'value' || k === 'checked') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
    return el;
  }

  /* ---------- browser storage ---------- */

  const store = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) {
      try { localStorage.setItem(key, value); return true; } catch { toast(t('toastStorage')); return false; }
    },
    del(key) { try { localStorage.removeItem(key); } catch { /* nothing to remove */ } },
    json(key, fallback) { try { return JSON.parse(store.get(key)) || fallback; } catch { return fallback; } },
  };

  // Attachments are too big for localStorage, so they go in IndexedDB, keyed by record id.
  const blobs = (function () {
    let opened = null;
    function db() {
      if (!opened) {
        opened = new Promise((resolve, reject) => {
          const req = indexedDB.open('eventtracker', 1);
          req.onupgradeneeded = () => req.result.createObjectStore('files');
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        opened.catch(() => { opened = null; });
      }
      return opened;
    }
    function tx(mode, op) {
      return db().then(d => new Promise((resolve, reject) => {
        const t = d.transaction('files', mode);
        const req = op(t.objectStore('files'));
        t.oncomplete = () => resolve(req.result);
        t.onerror = t.onabort = () => reject(t.error);
      }));
    }
    return {
      get: id => tx('readonly', s => s.get(id)).catch(() => null),
      put: (id, blob) => tx('readwrite', s => s.put(blob, id)),
      del: id => tx('readwrite', s => s.delete(id)).catch(() => {}),
    };
  })();

  /* ---------- state ---------- */

  let lang = store.get(KEY.lang) === 'zh' ? 'zh' : 'en';
  let github = store.json(KEY.github, null);
  let scope = github ? 'gh:' + github.repo : 'local';
  let data = loadScope(scope);

  const ui = {
    query: '',
    drafts: {},
    pickTarget: null,
    downloading: new Set(),
    sync: { state: github ? 'idle' : 'off', at: Number(store.get('eventtracker.lastSync')) || null, error: null, failedUploads: 0 },
  };

  function loadScope(sc) {
    const d = store.json(KEY.data(sc), null);
    return { records: (d && d.records) || [], deleted: (d && d.deleted) || {} };
  }

  function save() { store.set(KEY.data(scope), JSON.stringify(data)); }

  function getPending() { return store.json(KEY.pending(scope), []); }
  function setPending(paths) {
    if (paths.length) store.set(KEY.pending(scope), JSON.stringify(paths));
    else store.del(KEY.pending(scope));
  }

  function t(key, vars) {
    let s = STRINGS[lang][key];
    if (s === undefined) s = STRINGS.en[key] || key;
    return s.replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] !== undefined ? vars[k] : m));
  }

  const byId = id => data.records.find(r => r.id === id) || null;
  const eventsNewestFirst = () => data.records.filter(r => r.type === 'event').sort((a, b) => b.created - a.created || (a.id < b.id ? -1 : 1));
  const itemsOf = id => data.records.filter(r => r.type === 'item' && r.parent === id);
  const filesOf = id => data.records.filter(r => r.type === 'file' && r.parent === id).sort((a, b) => a.created - b.created);
  const allFilesOf = id => [...filesOf(id), ...itemsOf(id).flatMap(i => filesOf(i.id))];

  function formatTime(ms) {
    return new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(ms);
  }
  function formatClock(ms) {
    return new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en-GB', { timeStyle: 'short' }).format(ms);
  }
  function formatSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  /* ---------- changes ---------- */

  function commit() {
    save();
    render();
    scheduleSync();
  }

  function addRecord(rec) {
    const now = Date.now();
    const full = Object.assign({ id: S.uid(), created: now, modified: now }, rec);
    data = Object.assign({}, data, { records: [...data.records, full] });
    return full;
  }

  function patchRecord(id, patch) {
    data = Object.assign({}, data, {
      records: data.records.map(r => (r.id === id ? Object.assign({}, r, patch, { modified: Math.max(Date.now(), (r.modified || 0) + 1) }) : r)),
    });
  }

  function setItemStatus(id, status) {
    const item = byId(id);
    if (!item || item.status === status) return;
    patchRecord(id, { status, completed: status === 'done' ? Date.now() : null });
    commit();
  }

  function filesGone(files) {
    const paths = files.filter(f => f.path).map(f => f.path);
    if (paths.length) setPending([...new Set([...getPending(), ...paths])]);
    for (const f of files) blobs.del(f.id);
  }

  function removeRecord(id) {
    const { state, removed } = S.removeCascade(data, id, Date.now());
    data = state;
    filesGone(removed.filter(r => r.type === 'file'));
    commit();
  }

  async function addFiles(parentId, fileList) {
    const max = MAX_FILE_MB * 1024 * 1024;
    let added = 0;
    for (const file of Array.from(fileList)) {
      if (file.size > max) { toast(t('toastTooLarge', { name: file.name, max: MAX_FILE_MB })); continue; }
      const id = S.uid();
      try {
        await blobs.put(id, file);
      } catch {
        toast(t('toastFileBlocked'));
        continue;
      }
      if (!byId(parentId)) { blobs.del(id); return; } // the parent was deleted meanwhile
      addRecord({ id, type: 'file', parent: parentId, name: file.name, size: file.size, mime: file.type || '' });
      added++;
    }
    if (added) {
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      commit();
    }
  }

  async function fileBlob(rec) {
    const cached = await blobs.get(rec.id);
    if (cached) return cached;
    if (!github || !rec.path) return null;
    const remote = await S.client(github.token).readFile(github.repo, rec.path);
    if (remote) await blobs.put(rec.id, remote).catch(() => {});
    return remote;
  }

  function saveAs(blob, name) {
    // Always a download, never opened in this page: an attachment could be an HTML file.
    const url = URL.createObjectURL(new Blob([blob], { type: 'application/octet-stream' }));
    const a = h('a', { href: url, download: name, hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  async function downloadFile(rec) {
    if (ui.downloading.has(rec.id)) return;
    ui.downloading.add(rec.id);
    render();
    try {
      const blob = await fileBlob(rec);
      if (blob) saveAs(blob, rec.name);
      else toast(t('toastFileMissing'));
    } catch (e) {
      toast(describeError(e));
    } finally {
      ui.downloading.delete(rec.id);
      render();
    }
  }

  /* ---------- sync ---------- */

  const syncer = S.createSyncer({
    config: () => (github ? { token: github.token, repo: github.repo } : null),
    getLocal: () => data,
    setLocal: state => { data = state; save(); render(); },
    getBlob: id => blobs.get(id),
    onFilesGone: filesGone,
    getPendingDeletes: getPending,
    setPendingDeletes: setPending,
    onStatus(state, info) {
      ui.sync.state = state;
      if (state === 'ok') {
        ui.sync.at = info.at;
        ui.sync.error = null;
        ui.sync.failedUploads = info.failedUploads;
        store.set('eventtracker.lastSync', String(info.at));
      } else if (state === 'error') {
        ui.sync.error = info;
      }
      renderChrome();
    },
  });

  let syncTimer = null;
  function scheduleSync() {
    if (!github) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => syncer.run(), SYNC_DELAY_MS);
  }

  function describeError(e) {
    const code = e && e.message;
    if (code === 'repo_not_found') return t('errRepoNotFound');
    if (code === 'repo_public') return t('errRepoPublic');
    if (code === 'need_owner') return t('errNeedOwner');
    if (e && e.status === 0) return t('errNetwork');
    if (e && e.status === 401) return t('errToken');
    if (e && e.status === 403) return t('errForbidden');
    if (e && e.status === 404) return t('errRepoNotFound');
    return t('errGeneric', { msg: code || String(e) });
  }

  /* ---------- dialogs ---------- */

  function modal(build) {
    return new Promise(resolve => {
      const close = value => {
        dlg.oncancel = null;
        dlg.close();
        dlg.replaceChildren();
        resolve(value);
      };
      dlg.replaceChildren();
      dlg.oncancel = e => { e.preventDefault(); close(null); };
      build(close);
      dlg.showModal();
    });
  }

  function confirmDialog({ title, text, ok, cancel, danger }) {
    return modal(close => {
      dlg.append(
        h('h2', null, title),
        h('p', { class: 'dlg-text' }, text),
        h('div', { class: 'dlg-actions' },
          h('button', { type: 'button', class: 'btn dlg-cancel', onclick: () => close(false) }, cancel || t('cancel')),
          h('button', { type: 'button', class: 'btn dlg-ok ' + (danger ? 'danger-solid' : 'primary'), onclick: () => close(true) }, ok)));
    });
  }

  function recordForm({ title, submit, record, hint }) {
    return modal(close => {
      const titleInput = h('input', { type: 'text', name: 'title', required: true, maxlength: 300, value: record ? record.title : '', autocomplete: 'off' });
      const noteInput = h('textarea', { name: 'note', rows: 4, value: '' });
      noteInput.value = record ? record.note || '' : '';
      dlg.append(h('form', {
        onsubmit(e) {
          e.preventDefault();
          const value = titleInput.value.trim();
          if (!value) { titleInput.focus(); return; }
          close({ title: value, note: noteInput.value.trim() });
        },
      },
      h('h2', null, title),
      h('label', { class: 'field' }, h('span', null, t('fieldTitle')), titleInput),
      h('label', { class: 'field' }, h('span', null, t('fieldNote')), noteInput),
      hint ? h('p', { class: 'hint' }, hint) : null,
      h('div', { class: 'dlg-actions' },
        h('button', { type: 'button', class: 'btn dlg-cancel', onclick: () => close(null) }, t('cancel')),
        h('button', { type: 'submit', class: 'btn primary dlg-ok' }, submit))));
    });
  }

  async function newEvent() {
    const values = await recordForm({ title: t('dlgNewEvent'), submit: t('create'), hint: t('createdAuto') });
    if (!values) return;
    const rec = addRecord(Object.assign({ type: 'event' }, values));
    location.hash = rec.id;
    commit();
    const input = detailEl.querySelector('[data-fk="add:todo"]');
    if (input) input.focus();
  }

  async function editEvent(rec) {
    const values = await recordForm({ title: t('dlgEditEvent'), submit: t('save'), record: rec });
    if (values && byId(rec.id)) { patchRecord(rec.id, values); commit(); }
  }

  async function deleteEvent(rec) {
    const ok = await confirmDialog({
      title: t('delEventTitle'),
      text: t('delEventText', { title: rec.title, items: itemsOf(rec.id).length, files: allFilesOf(rec.id).length }),
      ok: t('remove'),
      danger: true,
    });
    if (ok) removeRecord(rec.id);
  }

  async function editItem(rec) {
    const values = await recordForm({ title: t('dlgEditItem'), submit: t('save'), record: rec });
    if (values && byId(rec.id)) { patchRecord(rec.id, values); commit(); }
  }

  async function deleteItem(rec) {
    const ok = await confirmDialog({
      title: t('delItemTitle'),
      text: t('delItemText', { title: rec.title, files: filesOf(rec.id).length }),
      ok: t('remove'),
      danger: true,
    });
    if (ok) removeRecord(rec.id);
  }

  async function deleteFile(rec) {
    const ok = await confirmDialog({ title: t('delFileTitle'), text: t('delFileText', { name: rec.name }), ok: t('remove'), danger: true });
    if (ok) removeRecord(rec.id);
  }

  /* ---------- GitHub connection ---------- */

  function githubDialog() {
    return github ? connectedDialog() : connectDialog();
  }

  async function connectDialog() {
    const result = await modal(close => {
      const repoInput = h('input', { type: 'text', name: 'repo', value: DEFAULT_REPO, autocomplete: 'off', spellcheck: 'false' });
      const tokenInput = h('input', { type: 'password', name: 'token', autocomplete: 'off', spellcheck: 'false', autofocus: true });
      const errorEl = h('p', { class: 'dlg-error', role: 'alert', hidden: true });
      const submitBtn = h('button', { type: 'submit', class: 'btn primary dlg-ok' }, t('ghConnect'));
      const link = (href, label) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, label);
      const showError = msg => { errorEl.textContent = msg; errorEl.hidden = false; };
      dlg.append(h('form', {
        async onsubmit(e) {
          e.preventDefault();
          const token = tokenInput.value.trim(), repo = repoInput.value.trim();
          if (!token || !repo) { showError(t('errTokenMissing')); return; }
          errorEl.hidden = true;
          submitBtn.disabled = true;
          submitBtn.textContent = t('ghConnecting');
          try {
            const who = await S.verify(token, repo);
            close(Object.assign({ token }, who));
          } catch (err) {
            showError(describeError(err));
            submitBtn.disabled = false;
            submitBtn.textContent = t('ghConnect');
          }
        },
      },
      h('h2', null, t('ghTitle')),
      h('p', { class: 'dlg-text' }, t('ghIntro')),
      h('ol', { class: 'steps' },
        h('li', null, t('ghStep1') + ' ', link(NEW_REPO_URL, t('ghStep1Link'))),
        h('li', null, t('ghStep2') + ' ', link(NEW_TOKEN_URL, t('ghStep2Link'))),
        h('li', null, t('ghStep3'))),
      h('label', { class: 'field' }, h('span', null, t('ghRepo')), repoInput),
      h('label', { class: 'field' }, h('span', null, t('ghToken')), tokenInput),
      h('p', { class: 'hint' }, t('ghTokenNote')),
      errorEl,
      h('div', { class: 'dlg-actions' },
        h('button', { type: 'button', class: 'btn dlg-cancel', onclick: () => close(null) }, t('cancel')),
        submitBtn)));
    });
    if (result) await connect(result);
  }

  async function connect(conn) {
    const local = loadScope('local');
    const localCount = local.records.filter(r => r.type === 'event').length;
    let move = false;
    if (localCount) {
      move = await confirmDialog({
        title: t('moveTitle'),
        text: t('moveText', { n: localCount, repo: conn.repo }),
        ok: t('moveOk'),
        cancel: t('moveKeep'),
      });
    }
    github = conn;
    store.set(KEY.github, JSON.stringify(conn));
    scope = 'gh:' + conn.repo;
    data = loadScope(scope);
    if (move) {
      data = S.merge(data, local);
      store.del(KEY.data('local'));
    }
    save();
    ui.sync = { state: 'idle', at: null, error: null, failedUploads: 0 };
    render();
    await syncer.run();
  }

  function connectedDialog() {
    return modal(close => {
      const lastSync = h('dd', null, ui.sync.at ? formatTime(ui.sync.at) : t('ghNever'));
      dlg.append(
        h('h2', null, t('ghConnected')),
        h('dl', { class: 'facts' },
          h('dt', null, t('ghAccount')), h('dd', null, '@' + github.login),
          h('dt', null, t('ghRepository')), h('dd', null, h('a', { href: 'https://github.com/' + github.repo, target: '_blank', rel: 'noopener noreferrer' }, github.repo)),
          h('dt', null, t('ghLastSync')), lastSync),
        ui.sync.error ? h('p', { class: 'dlg-error' }, describeError(ui.sync.error)) : null,
        h('div', { class: 'dlg-actions' },
          h('button', { type: 'button', class: 'btn danger dlg-disconnect', onclick: () => close('disconnect') }, t('ghDisconnect')),
          h('span', { class: 'spacer' }),
          h('button', { type: 'button', class: 'btn dlg-sync', onclick: () => close('sync') }, t('ghSyncNow')),
          h('button', { type: 'button', class: 'btn primary dlg-cancel', onclick: () => close(null) }, t('close'))));
    }).then(action => {
      if (action === 'sync') return syncer.run();
      if (action === 'disconnect') return disconnect();
      return undefined;
    });
  }

  async function disconnect() {
    clearTimeout(syncTimer);
    await syncer.run(); // send anything not yet pushed
    const failed = ui.sync.state === 'error';
    const ok = await confirmDialog({
      title: t('disconnectTitle'),
      text: failed ? t('disconnectUnsynced') : t('disconnectText'),
      ok: t('ghDisconnect'),
      danger: true,
    });
    if (!ok) return;
    for (const r of data.records) if (r.type === 'file') blobs.del(r.id);
    store.del(KEY.data(scope));
    store.del(KEY.pending(scope));
    store.del(KEY.github);
    store.del('eventtracker.lastSync');
    github = null;
    scope = 'local';
    data = loadScope(scope);
    ui.sync = { state: 'off', at: null, error: null, failedUploads: 0 };
    render();
  }

  /* ---------- backup ---------- */

  async function exportBackup() {
    const attachments = {};
    let missing = 0;
    for (const r of data.records.filter(x => x.type === 'file')) {
      let blob = null;
      try { blob = await fileBlob(r); } catch { /* counted below */ }
      if (blob) attachments[r.id] = await S.blobToB64(blob);
      else missing++;
    }
    const backup = { app: 'event-tracker', version: 1, exported: Date.now(), records: data.records, attachments };
    const stamp = new Date().toISOString().slice(0, 10);
    saveAs(new Blob([JSON.stringify(backup)]), `event-tracker-backup-${stamp}.json`);
    toast(missing ? t('toastExportMissing', { n: missing }) : t('toastExported'));
  }

  async function importBackup(file) {
    let parsed;
    try {
      parsed = S.sanitizeImport(JSON.parse(await file.text()));
    } catch {
      toast(t('toastBadBackup'));
      return;
    }
    const count = parsed.records.filter(r => r.type === 'event').length;
    const ok = await confirmDialog({ title: t('importTitle'), text: t('importText', { n: count }), ok: t('importOk') });
    if (!ok) return;
    for (const r of parsed.records) {
      if (r.type === 'file' && parsed.files[r.id]) {
        await blobs.put(r.id, new Blob([S.b64ToBytes(parsed.files[r.id])], { type: r.mime })).catch(() => {});
      }
    }
    // Restoring a backup brings back records deleted here since it was made.
    const now = Date.now();
    const deleted = Object.assign({}, data.deleted);
    const records = parsed.records.map(r => {
      if (deleted[r.id] === undefined) return r;
      delete deleted[r.id];
      return Object.assign({}, r, { modified: now });
    });
    data = S.merge(Object.assign({}, data, { deleted }), { records, deleted: {} });
    commit();
    toast(t('toastImported', { n: count }));
  }

  /* ---------- rendering ---------- */

  function selectedEvent() {
    const id = location.hash.slice(1);
    const rec = id ? byId(id) : null;
    if (rec && rec.type === 'event') return rec;
    return eventsNewestFirst()[0] || null;
  }

  function matches(ev, q) {
    const inText = s => (s || '').toLowerCase().includes(q);
    return inText(ev.title) || inText(ev.note) || itemsOf(ev.id).some(i => inText(i.title) || inText(i.note));
  }

  function renderList(current) {
    const q = ui.query.trim().toLowerCase();
    const events = eventsNewestFirst().filter(ev => !q || matches(ev, q));
    const scrollTop = listEl.scrollTop;
    listEl.replaceChildren(...events.map(ev => {
      const items = itemsOf(ev.id);
      const done = items.filter(i => i.status === 'done').length;
      const bar = h('i');
      bar.style.width = items.length ? (100 * done / items.length) + '%' : '0';
      return h('button', {
        type: 'button',
        class: 'event-row',
        'data-fk': 'row:' + ev.id,
        'aria-current': current && current.id === ev.id ? 'true' : null,
        onclick: () => { location.hash = ev.id; },
      },
      h('span', { class: 'event-row-title' }, ev.title),
      h('span', { class: 'event-row-time' }, formatTime(ev.created)),
      h('span', { class: 'bar' }, bar),
      h('span', { class: 'event-row-state' },
        !items.length ? t('noSub') : done === items.length ? t('allDone') : t('progress', { done, total: items.length })));
    }));
    if (!events.length && q) listEl.append(h('p', { class: 'list-empty' }, t('noMatch')));
    listEl.scrollTop = scrollTop;
  }

  function fileChip(rec) {
    const busy = ui.downloading.has(rec.id);
    return h('span', { class: 'file' },
      h('button', {
        type: 'button',
        class: 'file-open',
        'data-fk': 'file:' + rec.id,
        title: rec.name,
        'aria-label': t('downloadFile', { name: rec.name }),
        onclick: () => downloadFile(rec),
      },
      icon('clip'),
      h('span', { class: 'file-name' }, rec.name),
      h('span', { class: 'file-size' }, formatSize(rec.size)),
      busy ? h('span', { class: 'file-state' }, t('downloading')) : null,
      !busy && github && !rec.path ? h('span', { class: 'file-state', 'data-pending': rec.id }, t('notUploaded')) : null),
      h('button', {
        type: 'button',
        class: 'icon-btn danger',
        title: t('removeFile', { name: rec.name }),
        'aria-label': t('removeFile', { name: rec.name }),
        onclick: () => deleteFile(rec),
      }, icon('x')));
  }

  function pickFor(parentId) {
    ui.pickTarget = parentId;
    $('filePicker').click();
  }

  function fileDragTarget(el, parentId) {
    const isFiles = e => e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
    el.addEventListener('dragover', e => {
      if (!isFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      el.classList.add('drop');
    });
    el.addEventListener('dragleave', e => { if (!el.contains(e.relatedTarget)) el.classList.remove('drop'); });
    el.addEventListener('drop', e => {
      el.classList.remove('drop');
      if (!isFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      addFiles(parentId, e.dataTransfer.files);
    });
  }

  function itemCard(item) {
    const done = item.status === 'done';
    const files = filesOf(item.id);
    const card = h('li', {
      class: 'item',
      draggable: 'true',
      'data-id': item.id,
      ondragstart(e) {
        e.dataTransfer.setData('application/x-event-item', item.id);
        e.dataTransfer.effectAllowed = 'move';
        card.classList.add('dragging');
      },
      ondragend() { card.classList.remove('dragging'); },
    },
    h('div', { class: 'item-main' },
      h('input', {
        type: 'checkbox',
        checked: done,
        'data-fk': 'check:' + item.id,
        'aria-label': t(done ? 'markTodo' : 'markDone', { title: item.title }),
        onchange: () => setItemStatus(item.id, done ? 'todo' : 'done'),
      }),
      h('div', { class: 'item-body' },
        h('div', { class: 'item-title' }, item.title),
        item.note ? h('div', { class: 'item-note' }, item.note) : null,
        h('div', { class: 'item-time' }, done && item.completed
          ? t('itemDone', { time: formatTime(item.completed) })
          : t('itemAdded', { time: formatTime(item.created) }))),
      h('div', { class: 'item-tools' },
        h('button', { type: 'button', class: 'icon-btn', 'data-fk': 'attach:' + item.id, title: t('attachTo', { title: item.title }), 'aria-label': t('attachTo', { title: item.title }), onclick: () => pickFor(item.id) }, icon('clip')),
        h('button', { type: 'button', class: 'icon-btn', 'data-fk': 'edit:' + item.id, title: t('editItem', { title: item.title }), 'aria-label': t('editItem', { title: item.title }), onclick: () => editItem(item) }, icon('edit')),
        h('button', { type: 'button', class: 'icon-btn danger', title: t('removeItem', { title: item.title }), 'aria-label': t('removeItem', { title: item.title }), onclick: () => deleteItem(item) }, icon('trash')))),
    files.length ? h('div', { class: 'files' }, files.map(fileChip)) : null);
    fileDragTarget(card, item.id);
    return card;
  }

  function column(ev, status) {
    const items = itemsOf(ev.id).filter(i => i.status === status);
    items.sort(status === 'done'
      ? (a, b) => (b.completed || b.created) - (a.completed || a.created)
      : (a, b) => a.created - b.created);
    const draftKey = ev.id + ':' + status;
    const isItem = e => e.dataTransfer && Array.from(e.dataTransfer.types).includes('application/x-event-item');
    const input = h('input', {
      type: 'text',
      maxlength: 300,
      'data-fk': 'add:' + status,
      placeholder: t(status === 'done' ? 'addDonePh' : 'addTodoPh'),
      'aria-label': t(status === 'done' ? 'addDonePh' : 'addTodoPh'),
      value: ui.drafts[draftKey] || '',
      oninput(e) { ui.drafts[draftKey] = e.target.value; },
    });
    const col = h('section', {
      class: 'column col-' + status,
      'data-status': status,
      ondragover(e) { if (isItem(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; col.classList.add('over'); } },
      ondragleave(e) { if (!col.contains(e.relatedTarget)) col.classList.remove('over'); },
      ondrop(e) {
        col.classList.remove('over');
        if (!isItem(e)) return;
        e.preventDefault();
        setItemStatus(e.dataTransfer.getData('application/x-event-item'), status);
      },
    },
    h('div', { class: 'col-head' },
      h('h3', null, t(status === 'done' ? 'colDone' : 'colTodo')),
      h('span', { class: 'col-badge' }, String(items.length))),
    h('form', {
      class: 'add-form',
      onsubmit(e) {
        e.preventDefault();
        const title = input.value.trim();
        if (!title) return;
        const now = Date.now();
        addRecord({ type: 'item', parent: ev.id, title, note: '', status, completed: status === 'done' ? now : null });
        delete ui.drafts[draftKey];
        commit();
      },
    }, input, h('button', { type: 'submit', class: 'btn' }, t('add'))),
    items.length
      ? h('ul', { class: 'items' }, items.map(itemCard))
      : h('p', { class: 'col-empty' }, t(status === 'done' ? 'emptyDone' : 'emptyTodo')));
    return col;
  }

  function renderDetail(ev) {
    if (!ev) {
      detailEl.replaceChildren(h('div', { class: 'welcome' },
        h('h2', null, t('welcomeTitle')),
        h('p', null, t('welcomeText')),
        h('button', { type: 'button', class: 'btn primary', onclick: newEvent }, t('newEvent'))));
      return;
    }
    const files = filesOf(ev.id);
    const box = h('div', { class: 'attach-box' },
      h('div', { class: 'attach-head' },
        h('h3', null, t('attachments')),
        h('button', { type: 'button', class: 'btn-text', 'data-fk': 'attach:event', onclick: () => pickFor(ev.id) }, icon('clip'), t('addAttachment'))),
      files.length ? h('div', { class: 'files' }, files.map(fileChip)) : h('p', { class: 'hint' }, t('noAttachments')));
    fileDragTarget(box, ev.id);
    detailEl.replaceChildren(
      h('button', { type: 'button', class: 'btn back', onclick: () => { location.hash = ''; } }, icon('back'), t('back')),
      h('div', { class: 'detail-head' },
        h('div', null,
          h('h2', null, ev.title),
          h('p', { class: 'detail-meta' }, h('time', { datetime: new Date(ev.created).toISOString() }, t('created', { time: formatTime(ev.created) })))),
        h('div', { class: 'detail-actions' },
          h('button', { type: 'button', class: 'btn', 'data-fk': 'edit:event', onclick: () => editEvent(ev) }, icon('edit'), t('edit')),
          h('button', { type: 'button', class: 'btn danger', onclick: () => deleteEvent(ev) }, icon('trash'), t('remove')))),
      ev.note ? h('p', { class: 'note' }, ev.note) : null,
      box,
      h('div', { class: 'columns' }, column(ev, 'done'), column(ev, 'todo')));
    // Files dropped anywhere else on the event attach to the event itself.
    detailEl.ondragover = e => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) { e.preventDefault(); box.classList.add('drop'); }
    };
    detailEl.ondragleave = e => { if (!detailEl.contains(e.relatedTarget)) box.classList.remove('drop'); };
    detailEl.ondrop = e => {
      box.classList.remove('drop');
      if (e.dataTransfer && e.dataTransfer.files.length) { e.preventDefault(); addFiles(ev.id, e.dataTransfer.files); }
    };
  }

  function renderChrome() {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    document.title = t('appTitle');
    document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
    document.querySelectorAll('[data-i18n-aria]').forEach(el => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
    document.querySelectorAll('[data-lang]').forEach(b => { b.setAttribute('aria-pressed', String(b.dataset.lang === lang)); });

    $('githubLabel').textContent = github ? '@' + github.login : t('connectGitHub');
    $('syncDot').dataset.state = ui.sync.state === 'idle' ? 'syncing' : ui.sync.state;

    const note = $('storageNote');
    note.classList.remove('error');
    if (!github) {
      note.textContent = t('storedLocal') + ' ' + t('storedLocalMore');
    } else if (ui.sync.state === 'error') {
      note.textContent = t('storedFailed', { reason: describeError(ui.sync.error) });
      note.classList.add('error');
    } else if (ui.sync.state === 'syncing') {
      note.textContent = t('storedSyncing', { repo: github.repo });
    } else if (ui.sync.failedUploads) {
      note.textContent = t('storedUploadsFailed', { n: ui.sync.failedUploads });
      note.classList.add('error');
    } else if (ui.sync.at) {
      note.textContent = t('storedSynced', { repo: github.repo, time: formatClock(ui.sync.at) });
    } else {
      note.textContent = t('storedConnected', { repo: github.repo });
    }
  }

  function render() {
    const active = document.activeElement;
    const fk = active && shell.contains(active) ? active.dataset.fk : null;
    const caret = fk && active.tagName === 'INPUT' && active.type === 'text' ? active.selectionStart : null;

    const ev = selectedEvent();
    shell.dataset.view = location.hash.length > 1 && ev ? 'detail' : 'list';
    renderChrome();
    renderList(ev);
    renderDetail(ev);

    if (fk) {
      const again = shell.querySelector(`[data-fk="${CSS.escape(fk)}"]`);
      if (again) {
        again.focus({ preventScroll: true });
        if (caret !== null) again.setSelectionRange(caret, caret);
      }
    }
  }

  let toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 4500);
  }

  /* ---------- wiring ---------- */

  document.querySelectorAll('[data-lang]').forEach(btn => {
    btn.addEventListener('click', () => {
      lang = btn.dataset.lang;
      store.set(KEY.lang, lang);
      render();
    });
  });

  $('newEventBtn').addEventListener('click', newEvent);
  $('githubBtn').addEventListener('click', githubDialog);
  $('search').addEventListener('input', e => { ui.query = e.target.value; renderList(selectedEvent()); });

  $('filePicker').addEventListener('change', e => {
    const target = ui.pickTarget;
    const files = Array.from(e.target.files);
    e.target.value = '';
    if (target && files.length) addFiles(target, files);
  });

  $('exportBtn').addEventListener('click', () => { $('backupMenu').open = false; exportBackup(); });
  $('importBtn').addEventListener('click', () => { $('backupMenu').open = false; $('importFile').click(); });
  $('importFile').addEventListener('change', e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) importBackup(file);
  });

  document.addEventListener('click', e => {
    const menu = $('backupMenu');
    if (menu.open && !menu.contains(e.target)) menu.open = false;
  });

  // A file dropped outside the drop zones must not navigate away from the page.
  window.addEventListener('dragover', e => { if (Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault(); });
  window.addEventListener('drop', e => { if (Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault(); });

  window.addEventListener('hashchange', () => { window.scrollTo(0, 0); render(); });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncer.run();
  });

  // Another tab changed this browser's data: follow it instead of overwriting it later.
  window.addEventListener('storage', e => {
    if (e.key === KEY.github) { location.reload(); return; }
    if (e.key === KEY.data(scope)) { data = loadScope(scope); render(); }
    if (e.key === KEY.lang) { lang = e.newValue === 'zh' ? 'zh' : 'en'; render(); }
  });

  render();
  syncer.run();
})();
