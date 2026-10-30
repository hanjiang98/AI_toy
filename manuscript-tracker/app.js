(function () {
  'use strict';

  const STORE = 'mstracker.records.v1';
  const LANG = 'mstracker.lang';
  const { parseEmail, splitId, REVISION_TYPES } = window.MSParser;

  const TYPES = ['submitted', 'with_editor', 'under_review', 'reviews_complete', 'major_revision', 'minor_revision', 'revise',
    'reject_resubmit', 'revision_submitted', 'accepted', 'proofs', 'published', 'rejected', 'transferred', 'withdrawn', 'other'];
  const GROUP = {
    submitted: 'active', with_editor: 'active', under_review: 'active', reviews_complete: 'active', revision_submitted: 'active', other: 'active',
    major_revision: 'action', minor_revision: 'action', revise: 'action', reject_resubmit: 'action',
    accepted: 'accepted', proofs: 'accepted', published: 'accepted',
    rejected: 'rejected', withdrawn: 'closed', transferred: 'closed',
  };
  const FILTERS = [['all', 'all'], ['active', 'groupActive'], ['action', 'groupAction'], ['accepted', 'groupAccepted'], ['closed', 'groupClosed']];

  const EXAMPLE = `IEEE Transactions on Sustainable Energy - Manuscript ID TSTE-01234-2026
IEEE Transactions on Sustainable Energy<onbehalfof@manuscriptcentral.com>

corresponding.author@university.edu
co.author@example.org

05-Sep-2026

Dear Prof. Smith:

Your manuscript entitled "Data-Driven Frequency Regulation for Low-Inertia Power Systems" has been successfully submitted online and is presently being given full consideration for publication in the IEEE Transactions on Sustainable Energy.

Your manuscript ID is TSTE-01234-2026.

Please mention the above manuscript ID in all future correspondence or when calling the office for questions. If there are any changes in your street address or e-mail address, please log in to ScholarOne Manuscripts at https://mc.manuscriptcentral.com/tste-pes and edit your user information as appropriate.

Thank you for submitting your manuscript to the IEEE Transactions on Sustainable Energy.

Sincerely,
IEEE Transactions on Sustainable Energy Editorial Office`;

  /* ---------- helpers ---------- */

  const $ = (s, el = document) => el.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const todayISO = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
  const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9一-鿿]+/g, '');
  const clone = o => JSON.parse(JSON.stringify(o));
  const capability = name => (window.claude && window.claude.use ? window.claude.use(name).catch(() => null) : Promise.resolve(null));

  function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } }

  let lang = lsGet(LANG) === 'zh' ? 'zh' : 'en';
  let records = loadLocal();
  let filter = 'all', query = '', sortBy = 'updated', openId = null, pending = null;
  const openRaw = new Set();

  function t(key, vars) {
    const pick = dict => key.split('.').reduce((o, k) => (o == null ? o : o[k]), dict);
    let s = pick(I18N[lang]);
    if (s == null) s = pick(I18N.en);
    if (typeof s === 'string' && vars) s = s.replace(/\{(\w+)\}/g, (_, k) => vars[k]);
    return s == null ? key : s;
  }

  function fmtDate(iso) {
    if (!iso) return '–';
    if (lang === 'zh') return iso;
    return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
  }

  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
  }

  // The artifact viewer has no confirm() dialog, so destructive buttons need a second click.
  function confirmed(btn) {
    if (btn.dataset.armed) return true;
    btn.dataset.armed = '1';
    const label = btn.textContent;
    btn.textContent = t('clickAgain');
    setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = label; } }, 4000);
    return false;
  }

  /* ---------- storage ----------
   * Each person only ever sees their own records:
   *  - 'account': the viewer's private db subtree data/users/<id>/ (signed-in viewers who may write);
   *    nobody else on the artifact, the owner included, can read it.
   *  - 'browser': localStorage in this browser, for everyone else (signed out, outside visitors,
   *    or the page opened as a plain file). */

  function loadLocal() {
    try { return JSON.parse(lsGet(STORE) || '[]'); } catch { return []; }
  }

  const store = {
    mode: 'browser',
    col: null,
    unsub: null,
    queue: new Map(),

    saveLocal() {
      if (!lsSet(STORE, JSON.stringify(records))) toast(t('saveFailed'));
    },

    // One write at a time per document, as the db contract asks.
    write(id, op) {
      const next = (this.queue.get(id) || Promise.resolve())
        .then(() => (this.mode === 'account' ? op(this.col.doc(id)) : this.saveLocal()))
        .catch(e => this.fail(e));
      this.queue.set(id, next);
      return next;
    },

    put(r) { return this.mode === 'account' ? this.write(r.id, ref => ref.set(clone(r))) : Promise.resolve(this.saveLocal()); },
    remove(r) { return this.mode === 'account' ? this.write(r.id, ref => ref.delete()) : Promise.resolve(this.saveLocal()); },

    fail(e) {
      const code = e && e.code;
      if (code === 'quota_exceeded') return toast(t('quotaFull'));
      if (code === 'invalid_argument' || code === 'not_granted' || code === 'revoked' || code === 'capability_disabled' || code === 'capability_removed') {
        this.toBrowser();
        return toast(t('fellBack'));
      }
      toast(t('saveFailed'));
    },

    toBrowser() {
      if (this.unsub) this.unsub();
      this.mode = 'browser';
      this.unsub = null;
      this.saveLocal();
      storageNote();
    },
  };

  async function connectAccount() {
    const [db, user] = await Promise.all([capability('db'), capability('user')]);
    if (!db || !user) return;
    const id = await user.id();
    if (!id || (await user.can('data.write')) === false) return;
    store.col = db.collection('data/users/' + id);
    store.mode = 'account';
    storageNote();
    let migrated = false;
    store.unsub = store.col.onSnapshot(snap => {
      const remote = snap.docs.map(d => clone(d.data()));
      if (!migrated && !snap.metadata.fromCache) {
        migrated = true;
        // Records made in this browser before signing in move into the account once.
        const known = new Set(remote.map(r => r.id));
        const moving = loadLocal().filter(r => !known.has(r.id));
        if (moving.length) {
          remote.push(...moving);
          Promise.all(moving.map(r => store.put(r))).then(() => { if (store.mode === 'account') lsDel(STORE); });
        } else {
          lsDel(STORE);
        }
      }
      const before = JSON.stringify(records);
      records = remote;
      records.forEach(recompute);
      if (JSON.stringify(records) !== before) render();
    }, e => store.fail(e));
  }

  function storageNote() {
    $('#storageNote').textContent = t(store.mode === 'account' ? 'storageAccount' : 'storageBrowser');
  }

  /* ---------- records ---------- */

  function recompute(r) {
    r.events.sort((a, b) => a.date.localeCompare(b.date) || a.at - b.at);
    const real = r.events.filter(e => e.type !== 'other');
    const last = real[real.length - 1] || r.events[r.events.length - 1];
    r.status = last ? last.type : 'submitted';
    r.updated = r.events.length ? r.events[r.events.length - 1].date : r.created;
    const sub = r.events.find(e => e.type === 'submitted');
    r.submitted = sub ? sub.date : (r.events[0] ? r.events[0].date : '');
    r.due = last && REVISION_TYPES.has(last.type) ? (last.due || '') : '';
  }

  function findMatch(p) {
    if (p.baseId) {
      const r = records.find(x => x.baseId === p.baseId);
      if (r) return r;
    }
    const nt = norm(p.title);
    if (nt.length < 12) return null;
    return records.find(x => norm(x.title) === nt && (!p.journal || !x.journal || norm(x.journal) === norm(p.journal))) || null;
  }

  function setId(r, msId) {
    const { base, round } = splitId(msId);
    r.msId = msId;
    r.baseId = base;
    r.round = round;
  }

  /* ---------- i18n ---------- */

  function applyI18n() {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    document.title = t('appTitle');
    document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
    document.querySelectorAll('[data-lang]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));
    const typeSel = $('#review select[name=type]');
    typeSel.innerHTML = typeOptions(typeSel.value);
    if (!$('#review').hidden) fillAttach($('#review select[name=attach]').value);
    storageNote();
    render();
  }

  const typeOptions = sel => TYPES.map(k => `<option value="${k}"${k === sel ? ' selected' : ''}>${esc(t('status.' + k))}</option>`).join('');

  /* ---------- review form ---------- */

  const form = $('#review');

  function fillAttach(selected) {
    const opts = [`<option value="new">${esc(t('newRecord'))}</option>`].concat(records.map(r => {
      const label = [r.msId, r.title].filter(Boolean).join(' · ') || r.journal || r.id;
      return `<option value="${r.id}"${r.id === selected ? ' selected' : ''}>${esc(label.length > 90 ? label.slice(0, 88) + '…' : label)}</option>`;
    }));
    form.elements.attach.innerHTML = opts.join('');
    if (!selected || selected === 'new') form.elements.attach.value = 'new';
  }

  function toggleDue() {
    form.querySelector('.due-field').hidden = !REVISION_TYPES.has(form.elements.type.value);
  }

  function showReview(p, raw) {
    pending = { raw, portal: p.portal, addressee: p.addressee };
    const f = form.elements;
    f.title.value = p.title;
    f.journal.value = p.journal;
    f.msId.value = p.msId;
    f.type.innerHTML = typeOptions(p.type);
    f.date.value = p.date;
    f.publisher.value = p.publisher;
    f.due.value = p.due;
    const match = raw ? findMatch(p) : null;
    fillAttach(match ? match.id : 'new');
    $('#matchNote').hidden = !match;
    $('#keepWrap').hidden = !raw;
    ['title', 'journal', 'msId'].forEach(n => f[n].classList.toggle('missing', !!raw && !f[n].value));
    f.title.title = f.title.value ? '' : t('notFound');
    toggleDue();
    form.hidden = false;
    form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function hideReview() {
    form.hidden = true;
    pending = null;
  }

  function saveReview(e) {
    e.preventDefault();
    const f = form.elements;
    const msId = f.msId.value.trim();
    const ev = {
      id: uid(), at: Date.now(), type: f.type.value, date: f.date.value || todayISO(),
      msId, round: splitId(msId).round,
      due: REVISION_TYPES.has(f.type.value) ? f.due.value : '',
      raw: pending.raw && f.keep.checked ? pending.raw : '',
    };
    let r = records.find(x => x.id === f.attach.value);
    if (!r) {
      r = {
        id: uid(), created: todayISO(), title: f.title.value.trim(), journal: f.journal.value.trim(),
        publisher: f.publisher.value, portal: pending.portal || '', addressee: pending.addressee || '', notes: '', events: [],
      };
      setId(r, msId);
      records.unshift(r);
    } else {
      if (!r.title) r.title = f.title.value.trim();
      if (!r.journal) r.journal = f.journal.value.trim();
      if (!r.portal && pending.portal) r.portal = pending.portal;
      if (msId && (ev.round >= (r.round || 0) || !r.msId)) setId(r, msId);
    }
    r.events.push(ev);
    recompute(r);
    store.put(r);
    hideReview();
    $('#emailInput').value = '';
    openId = r.id;
    render();
    toast(t('savedToast'));
  }

  /* ---------- list ---------- */

  function groupOf(r) { return GROUP[r.status] || 'active'; }
  function inGroup(r, key) {
    if (key === 'all') return true;
    const g = groupOf(r);
    return key === 'closed' ? g === 'closed' || g === 'rejected' : g === key;
  }

  function visible() {
    const q = query.trim().toLowerCase();
    const list = records.filter(r => inGroup(r, filter) && (!q || [r.title, r.journal, r.msId, r.notes].join(' ').toLowerCase().includes(q)));
    const cmp = {
      updated: (a, b) => (b.updated || '').localeCompare(a.updated || ''),
      submitted: (a, b) => (b.submitted || '').localeCompare(a.submitted || ''),
      journal: (a, b) => (a.journal || '').localeCompare(b.journal || ''),
      due: (a, b) => (a.due || '9999').localeCompare(b.due || '9999'),
    }[sortBy];
    return list.sort(cmp);
  }

  function renderChips() {
    $('#chips').innerHTML = FILTERS.map(([key, label]) =>
      `<button type="button" class="chip" role="tab" data-filter="${key}" aria-selected="${filter === key}">${esc(t(label))}<b>${records.filter(r => inGroup(r, key)).length}</b></button>`).join('');
  }

  function dueHTML(r) {
    if (!r.due) return '';
    const n = daysBetween(todayISO(), r.due);
    if (n < 0) return `<span class="due late">${esc(t('overdue', { n: -n }))}</span>`;
    if (n === 0) return `<span class="due late">${esc(t('dueToday'))}</span>`;
    return `<span class="due${n <= 7 ? ' late' : ''}">${esc(t('dueIn', { n }))}</span>`;
  }

  function itemHTML(r) {
    const g = groupOf(r);
    const ongoing = g === 'active' || g === 'action';
    const meta = [esc(r.journal) || '—', r.msId ? `<span class="mono">${esc(r.msId)}</span>` : ''].filter(Boolean).join(' · ');
    const since = r.submitted ? daysBetween(r.submitted, todayISO()) : null;
    const side = ongoing
      ? `${dueHTML(r)}${since != null ? `<span>${t('sinceSub', { n: `<span class="days">${since}</span>` })}</span>` : ''}<span>${esc(t('submittedOn'))} ${fmtDate(r.submitted)}</span>`
      : `<span>${esc(t('updated'))} ${fmtDate(r.updated)}</span>`;
    return `<li class="item${openId === r.id ? ' open' : ''}" data-id="${r.id}">
      <button type="button" class="item-head" aria-expanded="${openId === r.id}">
        <span class="badge g-${g}">${esc(t('status.' + r.status))}</span>
        <span style="min-width:0"><span class="item-title">${esc(r.title) || '<i>Untitled</i>'}</span><span class="item-meta">${meta}</span></span>
        <span class="item-side">${side}</span>
      </button>
      ${openId === r.id ? detailHTML(r) : ''}
    </li>`;
  }

  function detailHTML(r) {
    const field = (name, label, value, opts = '') => `<label${opts.includes('span2') ? ' class="span2"' : ''}><span>${esc(t(label))}</span>${
      opts.includes('area') ? `<textarea id="f-${name}" data-field="${name}" rows="${name === 'notes' ? 3 : 2}">${esc(value)}</textarea>`
        : `<input id="f-${name}" data-field="${name}" value="${esc(value)}"${opts.includes('mono') ? ' class="mono"' : ''}>`}</label>`;
    const pubSel = `<label><span>${esc(t('fPublisher'))}</span><select id="f-publisher" data-field="publisher">${['IEEE', 'Elsevier', 'Nature', 'Other'].map(p => `<option${p === r.publisher ? ' selected' : ''}>${p}</option>`).join('')}</select></label>`;
    const events = r.events.slice().reverse().map(e => `<li>
        <div class="t-row">
          <span class="badge g-${GROUP[e.type] || 'active'}">${esc(t('status.' + e.type))}</span>
          <span class="t-date">${fmtDate(e.date)}</span>
          ${e.msId && e.msId !== r.msId ? `<span class="mono t-date">${esc(e.msId)}</span>` : ''}
          ${e.due ? `<span class="t-date">→ ${esc(t('fDue'))} ${fmtDate(e.due)}</span>` : ''}
          <span class="t-tools">
            ${e.raw ? `<button type="button" data-act="raw" data-ev="${e.id}">${esc(t(openRaw.has(e.id) ? 'hideEmail' : 'showEmail'))}</button>` : ''}
            <button type="button" data-act="del-ev" data-ev="${e.id}">${esc(t('delete'))}</button>
          </span>
        </div>
        ${e.raw && openRaw.has(e.id) ? `<pre>${esc(e.raw)}</pre>` : ''}
      </li>`).join('');
    return `<div class="detail">
      <div>
        <div class="grid">
          ${field('title', 'fTitle', r.title, 'area span2')}
          ${field('journal', 'fJournal', r.journal)}
          ${field('msId', 'fId', r.msId, 'mono')}
          ${pubSel}
          ${field('portal', 'fPortal', r.portal)}
          ${field('notes', 'fNotes', r.notes, 'area span2')}
        </div>
        <div class="detail-actions">
          ${/^https?:\/\//.test(r.portal || '') ? `<a class="btn small" href="${esc(r.portal)}" target="_blank" rel="noopener noreferrer">${esc(t('openPortal'))} ↗</a>` : ''}
          <button type="button" class="btn small danger" data-act="del-rec">${esc(t('deleteRecord'))}</button>
        </div>
      </div>
      <div>
        <h3>${esc(t('timeline'))}</h3>
        <ul class="timeline">${events}</ul>
        <div class="add-event">
          <select id="new-ev-type" data-new="type">${typeOptions('under_review')}</select>
          <input id="new-ev-date" type="date" data-new="date" value="${todayISO()}">
          <button type="button" class="btn small" data-act="add-ev">${esc(t('addEvent'))}</button>
        </div>
      </div>
    </div>`;
  }

  function render() {
    renderChips();
    const items = visible();
    $('#list').innerHTML = items.map(itemHTML).join('');
    const empty = $('#empty');
    empty.hidden = items.length > 0;
    empty.innerHTML = records.length
      ? `<p>${esc(t('noMatch'))}</p>`
      : `<h3>${esc(t('emptyTitle'))}</h3><p>${esc(t('emptyBody'))}</p>`;
  }

  /* ---------- export / import ---------- */

  async function download(name, text, type) {
    const downloads = await capability('downloads');
    if (downloads) {
      try { await downloads.save({ filename: name, data: text }); } catch (e) { if (e && e.code !== 'declined') toast(t('exportFail')); }
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function exportJson() {
    download(`manuscripts-${todayISO()}.json`, JSON.stringify({ app: 'manuscript-tracker', version: 1, exported: new Date().toISOString(), records }, null, 2), 'application/json');
  }

  function exportCsv() {
    const cols = ['Title', 'Journal', 'Publisher', 'Manuscript ID', 'Status', 'Submitted', 'Last update', 'Revision due', 'Days since submission', 'Notes'];
    const cell = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const rows = records.map(r => [r.title, r.journal, r.publisher, r.msId, I18N.en.status[r.status], r.submitted, r.updated, r.due,
      r.submitted ? daysBetween(r.submitted, todayISO()) : '', r.notes].map(cell).join(','));
    download(`manuscripts-${todayISO()}.csv`, '﻿' + [cols.map(cell).join(',')].concat(rows).join('\r\n'), 'text/csv');
  }

  function importJson(file) {
    file.text().then(text => {
      const data = JSON.parse(text);
      const incoming = Array.isArray(data) ? data : data.records;
      if (!Array.isArray(incoming) || !incoming.every(r => r && r.id && Array.isArray(r.events))) throw new Error('bad');
      incoming.forEach(r => {
        recompute(r);
        const i = records.findIndex(x => x.id === r.id);
        if (i >= 0) records[i] = r; else records.push(r);
        store.put(r);
      });
      render();
      toast(t('importDone', { n: incoming.length }));
    }).catch(() => toast(t('importFail')));
  }

  /* ---------- wiring ---------- */

  $('#parseBtn').addEventListener('click', () => {
    const raw = $('#emailInput').value.trim();
    if (!raw) return $('#emailInput').focus();
    const p = parseEmail(raw, todayISO());
    if (!p.title && !p.msId && !p.journal) toast(t('parsedNothing'));
    showReview(p, raw);
  });
  $('#manualBtn').addEventListener('click', () => showReview({ type: 'submitted', date: todayISO(), title: '', journal: '', msId: '', publisher: 'IEEE', due: '' }, ''));
  $('#exampleBtn').addEventListener('click', () => { $('#emailInput').value = EXAMPLE; $('#parseBtn').click(); });
  $('#cancelReview').addEventListener('click', hideReview);
  form.addEventListener('submit', saveReview);
  form.elements.type.addEventListener('change', toggleDue);
  form.addEventListener('input', e => e.target.classList.remove('missing'));

  document.querySelectorAll('[data-lang]').forEach(b => b.addEventListener('click', () => {
    lang = b.dataset.lang;
    lsSet(LANG, lang);
    applyI18n();
  }));

  $('#chips').addEventListener('click', e => {
    const c = e.target.closest('[data-filter]');
    if (c) { filter = c.dataset.filter; render(); }
  });
  $('#search').addEventListener('input', e => { query = e.target.value; render(); });
  $('#sort').addEventListener('change', e => { sortBy = e.target.value; render(); });

  const list = $('#list');
  list.addEventListener('click', e => {
    const li = e.target.closest('.item');
    if (!li) return;
    const r = records.find(x => x.id === li.dataset.id);
    if (e.target.closest('.item-head')) { openId = openId === r.id ? null : r.id; return render(); }
    const act = e.target.closest('[data-act]');
    if (!act) return;
    const a = act.dataset.act;
    if ((a === 'del-ev' || a === 'del-rec') && !confirmed(act)) return;
    if (a === 'raw') { openRaw.has(act.dataset.ev) ? openRaw.delete(act.dataset.ev) : openRaw.add(act.dataset.ev); }
    if (a === 'del-ev') { r.events = r.events.filter(ev => ev.id !== act.dataset.ev); recompute(r); store.put(r); }
    if (a === 'del-rec') { records = records.filter(x => x !== r); openId = null; store.remove(r); }
    if (a === 'add-ev') {
      const type = li.querySelector('[data-new=type]').value;
      const date = li.querySelector('[data-new=date]').value || todayISO();
      r.events.push({ id: uid(), at: Date.now(), type, date, msId: '', round: 0, due: '', raw: '' });
      recompute(r);
      store.put(r);
    }
    render();
  });
  list.addEventListener('change', e => {
    const el = e.target.closest('[data-field]');
    if (!el) return;
    const r = records.find(x => x.id === el.closest('.item').dataset.id);
    const v = el.value.trim();
    if (el.dataset.field === 'msId') setId(r, v); else r[el.dataset.field] = v;
    store.put(r);
    render();
  });

  $('#exportJson').addEventListener('click', () => { exportJson(); $('.menu').open = false; });
  $('#exportCsv').addEventListener('click', () => { exportCsv(); $('.menu').open = false; });
  $('#importFile').addEventListener('change', e => { if (e.target.files[0]) importJson(e.target.files[0]); e.target.value = ''; });
  document.addEventListener('click', e => { const m = $('.menu'); if (m.open && !m.contains(e.target)) m.open = false; });

  records.forEach(recompute);
  applyI18n();
  connectAccount();
})();
