/* Data model, merge logic and GitHub sync. No DOM dependencies apart from FileReader.
 *
 * All data is one flat list of records, so two devices can edit different sub-events of the
 * same event without overwriting each other:
 *   event  {id, type:'event', title, note, created, modified}
 *   item   {id, type:'item', parent:eventId, title, note, status:'todo'|'done', created, completed, modified}
 *   file   {id, type:'file', parent:eventId|itemId, name, size, mime, created, modified, path?}
 * `path` is set once the attachment is stored in the user's repository.
 *
 * With GitHub sync on, records live in events.json and attachments under attachments/ in a
 * PRIVATE repository the user owns. The browser talks to api.github.com directly with a
 * fine-grained personal access token limited to that repository. There is no server between. */
(function (root) {
  'use strict';

  const API = 'https://api.github.com';
  const DATA_FILE = 'events.json';
  const ATTACH_DIR = 'attachments';
  const TOMBSTONE_DAYS = 180;

  class GitHubError extends Error {
    constructor(status, message) { super(message || 'GitHub error ' + status); this.status = status; }
  }

  function uid() {
    const b = new Uint8Array(12);
    root.crypto.getRandomValues(b);
    return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  }

  function b64encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  function b64decode(b64) {
    return new TextDecoder().decode(b64ToBytes(b64));
  }

  function b64ToBytes(b64) {
    return Uint8Array.from(atob(b64.replace(/\s/g, '')), c => c.charCodeAt(0));
  }

  function blobToB64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  // JSON with sorted keys, so the same data always serialises the same way on every device.
  function canon(v) {
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
    return JSON.stringify(v === undefined ? null : v);
  }

  /* Merge two snapshots ({records, deleted}). Each record keeps its most recently modified
   * version. A deletion leaves a tombstone (id -> time) so a device holding an older copy
   * cannot bring the record back. A child whose parent has gone goes too. */
  function merge(a, b, now) {
    const deleted = {};
    for (const src of [a, b]) {
      for (const [id, ts] of Object.entries((src && src.deleted) || {})) deleted[id] = Math.max(deleted[id] || 0, ts);
    }
    const byId = new Map();
    for (const src of [a, b]) {
      for (const r of (src && src.records) || []) {
        const cur = byId.get(r.id);
        const rm = r.modified || 0, cm = cur ? cur.modified || 0 : -1;
        if (!cur || rm > cm || (rm === cm && canon(r) > canon(cur))) byId.set(r.id, r);
      }
    }
    for (const [id, ts] of Object.entries(deleted)) {
      const r = byId.get(id);
      if (r && (r.modified || 0) <= ts) byId.delete(id);
    }
    // Two passes reach every depth: file -> item -> event.
    for (let pass = 0; pass < 2; pass++) {
      for (const r of [...byId.values()]) {
        if (r.parent && !byId.has(r.parent)) {
          byId.delete(r.id);
          if (deleted[r.parent]) deleted[r.id] = Math.max(deleted[r.id] || 0, deleted[r.parent], r.modified || 0);
        }
      }
    }
    const cutoff = (now || Date.now()) - TOMBSTONE_DAYS * 864e5;
    for (const [id, ts] of Object.entries(deleted)) if (ts < cutoff) delete deleted[id];
    return { records: [...byId.values()].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)), deleted };
  }

  /* Delete a record and everything under it. Returns the new state and the removed records. */
  function removeCascade(state, id, now) {
    const ids = new Set([id]);
    for (let pass = 0; pass < 2; pass++) {
      for (const r of state.records) if (r.parent && ids.has(r.parent)) ids.add(r.id);
    }
    const removed = state.records.filter(r => ids.has(r.id));
    const deleted = Object.assign({}, state.deleted);
    for (const r of removed) deleted[r.id] = Math.max(now, r.modified || 0);
    return { state: { records: state.records.filter(r => !ids.has(r.id)), deleted }, removed };
  }

  /* Repository path of an attachment. The id keeps it unique; the name keeps the folder readable. */
  function attachmentPath(rec) {
    const safe = String(rec.name || 'file').replace(/[^\w.\-一-鿿]+/g, '_').slice(-80);
    return `${ATTACH_DIR}/${rec.id}-${safe}`;
  }

  /* Check a backup file before importing it. Keeps only known fields of well-formed records,
   * and drops repository paths because a backup may be restored into a different repository. */
  function sanitizeImport(obj) {
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.records)) throw new Error('bad_backup');
    const str = v => (typeof v === 'string' ? v : '');
    const num = v => (Number.isFinite(v) ? v : 0);
    const okId = v => typeof v === 'string' && /^[\w-]{1,64}$/.test(v);
    const records = [];
    for (const r of obj.records) {
      if (!r || !okId(r.id)) continue;
      const base = { id: r.id, type: r.type, created: num(r.created), modified: num(r.modified) };
      if (r.type === 'event' && str(r.title)) records.push(Object.assign(base, { title: str(r.title), note: str(r.note) }));
      else if (r.type === 'item' && str(r.title) && okId(r.parent)) {
        records.push(Object.assign(base, {
          parent: r.parent, title: str(r.title), note: str(r.note),
          status: r.status === 'done' ? 'done' : 'todo',
          completed: r.status === 'done' ? num(r.completed) : null,
        }));
      } else if (r.type === 'file' && str(r.name) && okId(r.parent)) {
        records.push(Object.assign(base, { parent: r.parent, name: str(r.name), size: num(r.size), mime: str(r.mime) }));
      }
    }
    const files = {};
    if (obj.attachments && typeof obj.attachments === 'object') {
      for (const r of records) if (r.type === 'file' && typeof obj.attachments[r.id] === 'string') files[r.id] = obj.attachments[r.id];
    }
    return { records, files };
  }

  function client(token, fetchImpl) {
    const doFetch = fetchImpl || ((...args) => root.fetch(...args));
    const contentsUrl = (full, path) => `/repos/${full}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;

    async function call(method, path, body, raw) {
      let res;
      try {
        res = await doFetch(API + path, {
          method,
          cache: 'no-store',
          headers: Object.assign({
            Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
            Authorization: 'Bearer ' + token,
            'X-GitHub-Api-Version': '2022-11-28',
          }, body ? { 'Content-Type': 'application/json' } : {}),
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (e) {
        throw new GitHubError(0, 'network');
      }
      if (res.status === 404 && method === 'GET') return null;
      if (!res.ok) {
        let msg = '';
        try { msg = (await res.json()).message || ''; } catch { /* no body */ }
        throw new GitHubError(res.status, msg);
      }
      return raw ? res.blob() : res.json();
    }

    return {
      user: () => call('GET', '/user'),
      repo: full => call('GET', '/repos/' + full),

      async readData(full) {
        const meta = await call('GET', contentsUrl(full, DATA_FILE));
        if (!meta) return { data: null, sha: null };
        let content = meta.content;
        if (!content) content = (await call('GET', `/repos/${full}/git/blobs/${meta.sha}`)).content; // files over 1 MB
        return { data: JSON.parse(b64decode(content)), sha: meta.sha };
      },

      async writeData(full, data, sha) {
        const res = await call('PUT', contentsUrl(full, DATA_FILE), Object.assign({
          message: 'Update events',
          content: b64encode(JSON.stringify(data, null, 2) + '\n'),
        }, sha ? { sha } : {}));
        return res.content.sha;
      },

      // Resolves to a Blob, or null if the file is not in the repository.
      readFile: (full, path) => call('GET', contentsUrl(full, path), undefined, true),

      async writeFile(full, path, blob) {
        const content = await blobToB64(blob);
        const put = () => call('PUT', contentsUrl(full, path), { message: 'Add attachment', content });
        try {
          await put();
        } catch (e) {
          if (e.status === 409) { await put(); return; } // the branch moved under us; once more
          if (e.status !== 422) throw e;
          // Already there, for example if an earlier sync stopped before saving the record.
          if (!(await call('GET', contentsUrl(full, path)))) throw e;
        }
      },

      async deleteFile(full, path) {
        const meta = await call('GET', contentsUrl(full, path));
        if (!meta) return;
        await call('DELETE', contentsUrl(full, path), { message: 'Remove attachment', sha: meta.sha });
      },
    };
  }

  /* Resolve "name" or "owner/name" and check that the repository exists, is reachable with the
   * token, and is private. Resolves {repo, login}; rejects GitHubError or Error(code). */
  async function verify(token, repoInput, fetchImpl) {
    const gh = client(token, fetchImpl);
    // A token limited to one repository may not be allowed to read the profile. That only
    // matters if the owner has to be worked out from it; a bad token still fails here.
    const me = await gh.user().catch(e => {
      if (!e.status || e.status === 401) throw e;
      return null;
    });
    let full = repoInput.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$|\/$/g, '');
    if (!full) throw new Error('repo_not_found');
    if (!full.includes('/')) {
      if (!me || !me.login) throw new Error('need_owner');
      full = me.login + '/' + full;
    }
    if (!/^[\w.-]+\/[\w.-]+$/.test(full)) throw new Error('repo_not_found');
    const repo = await gh.repo(full);
    if (!repo) throw new Error('repo_not_found');
    if (!repo.private) throw new Error('repo_public');
    return { repo: repo.full_name, login: me && me.login ? me.login : repo.full_name.split('/')[0] };
  }

  /* One sync at a time. A run pulls and merges, uploads new attachments, removes deleted ones,
   * then pushes if GitHub is behind. Attachments go first, so another device never sees a record
   * whose file is missing. A push that loses a race with another device is retried.
   *
   * opts: config() -> {token, repo} | null, getLocal(), setLocal(state), getBlob(id),
   *       onFilesGone(records), getPendingDeletes(), setPendingDeletes(paths), onStatus(state, info) */
  function createSyncer(opts) {
    let current = null;
    let again = false;

    async function pull(gh, cfg) {
      const remote = await gh.readData(cfg.repo);
      const now = Date.now();
      const before = opts.getLocal();
      const local = merge(before, null, now);
      const merged = merge(local, remote.data, now);
      if (canon(merged) !== canon(local)) {
        const live = new Set(merged.records.map(r => r.id));
        const gone = before.records.filter(r => r.type === 'file' && !live.has(r.id));
        opts.setLocal(merged);
        if (gone.length) opts.onFilesGone(gone);
      }
      return remote;
    }

    async function uploadPending(gh, cfg) {
      let failed = 0;
      for (const r of opts.getLocal().records.filter(x => x.type === 'file' && !x.path)) {
        const blob = await opts.getBlob(r.id);
        if (!blob) continue; // added on another device, which will upload it
        const path = attachmentPath(r);
        try {
          await gh.writeFile(cfg.repo, path, blob);
        } catch (e) {
          if (!e.status || e.status === 401 || e.status === 403) throw e;
          failed++;
          continue;
        }
        const cur = opts.getLocal();
        if (cur.records.some(x => x.id === r.id)) {
          opts.setLocal(Object.assign({}, cur, {
            records: cur.records.map(x => (x.id === r.id ? Object.assign({}, x, { path, modified: Math.max(Date.now(), (x.modified || 0) + 1) }) : x)),
          }));
        } else {
          opts.onFilesGone([Object.assign({}, r, { path })]); // deleted while it was uploading
        }
      }
      return failed;
    }

    async function flushDeletes(gh, cfg) {
      for (const path of opts.getPendingDeletes()) {
        try {
          await gh.deleteFile(cfg.repo, path);
          opts.setPendingDeletes(opts.getPendingDeletes().filter(p => p !== path));
        } catch (e) {
          if (!e.status || e.status === 401 || e.status === 403) throw e;
          // Otherwise leave it queued and try again on the next sync.
        }
      }
    }

    async function once() {
      const cfg = opts.config();
      if (!cfg) return;
      opts.onStatus('syncing');
      const gh = client(cfg.token, opts.fetch);
      try {
        let remote = await pull(gh, cfg);
        const failed = await uploadPending(gh, cfg);
        await flushDeletes(gh, cfg);
        for (let attempt = 0; ; attempt++) {
          if (attempt) remote = await pull(gh, cfg);
          const now = Date.now();
          const local = merge(opts.getLocal(), null, now);
          const merged = merge(local, remote.data, now);
          if (!remote.data && !merged.records.length && !Object.keys(merged.deleted).length) break;
          if (remote.data && canon(merged) === canon(merge(remote.data, null, now))) break;
          try {
            await gh.writeData(cfg.repo, Object.assign({ app: 'event-tracker', version: 1 }, merged), remote.sha);
            break;
          } catch (e) {
            if ((e.status === 409 || e.status === 422) && attempt < 3) continue;
            throw e;
          }
        }
        opts.onStatus('ok', { at: Date.now(), failedUploads: failed });
      } catch (e) {
        opts.onStatus('error', e);
      }
    }

    function run() {
      if (!opts.config()) return Promise.resolve();
      if (current) { again = true; return current; }
      current = (async () => {
        try {
          do { again = false; await once(); } while (again && opts.config());
        } finally {
          current = null;
        }
      })();
      return current;
    }

    return { run };
  }

  const api = {
    uid, canon, merge, removeCascade, attachmentPath, sanitizeImport,
    client, verify, createSyncer,
    b64encode, b64decode, b64ToBytes, blobToB64,
    GitHubError, DATA_FILE, ATTACH_DIR,
  };
  root.EventStore = api;
})(window);
