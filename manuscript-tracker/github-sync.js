/* Optional sync through the user's own GitHub account.
 * Records live in manuscripts.json inside a PRIVATE repository the user owns. The browser
 * talks to api.github.com directly with a fine-grained personal access token that the user
 * limits to that one repository (Contents: read and write). There is no server in between. */
(function (root) {
  'use strict';

  const API = 'https://api.github.com';
  const FILE = 'manuscripts.json';
  const TOMBSTONE_DAYS = 180;

  class GitHubError extends Error {
    constructor(status, message) { super(message || 'GitHub error ' + status); this.status = status; }
  }

  function b64encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  function b64decode(b64) {
    const bin = atob(b64.replace(/\s/g, ''));
    return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
  }

  // JSON with sorted keys, so the same data always serialises the same way on every device.
  function canon(v) {
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
    return JSON.stringify(v === undefined ? null : v);
  }

  /* Merge two snapshots ({records, deleted}). Each manuscript keeps its most recently modified
   * version; a deletion leaves a tombstone (id -> time) so a device holding an older copy
   * cannot bring the manuscript back. Tombstones are dropped after TOMBSTONE_DAYS. */
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
    const cutoff = (now || Date.now()) - TOMBSTONE_DAYS * 864e5;
    for (const [id, ts] of Object.entries(deleted)) {
      const r = byId.get(id);
      if (r && (r.modified || 0) <= ts) byId.delete(id);
      if (ts < cutoff) delete deleted[id];
    }
    return { records: [...byId.values()].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)), deleted };
  }

  function client(token, fetchImpl) {
    const doFetch = fetchImpl || root.fetch.bind(root);

    async function call(method, path, body) {
      let res;
      try {
        res = await doFetch(API + path, {
          method,
          cache: 'no-store',
          headers: Object.assign({
            Accept: 'application/vnd.github+json',
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
      return res.json();
    }

    return {
      user: () => call('GET', '/user'),
      repo: full => call('GET', '/repos/' + full),

      async read(full) {
        const meta = await call('GET', `/repos/${full}/contents/${FILE}`);
        if (!meta) return { data: null, sha: null };
        let content = meta.content;
        if (!content) content = (await call('GET', `/repos/${full}/git/blobs/${meta.sha}`)).content; // files over 1 MB
        return { data: JSON.parse(b64decode(content)), sha: meta.sha };
      },

      async write(full, data, sha) {
        const res = await call('PUT', `/repos/${full}/contents/${FILE}`, Object.assign({
          message: 'Update manuscripts',
          content: b64encode(JSON.stringify(data, null, 2) + '\n'),
        }, sha ? { sha } : {}));
        return res.content.sha;
      },
    };
  }

  /* Resolve "name" or "owner/name" and check that the repository exists, is reachable with
   * the token, and is private. Resolves the full name; rejects GitHubError or Error(code). */
  async function verify(token, repoInput, fetchImpl) {
    const gh = client(token, fetchImpl);
    let full = repoInput.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$|\/$/g, '');
    if (!full.includes('/')) {
      const me = await gh.user().catch(() => null);
      if (!me || !me.login) throw new Error('need_owner');
      full = me.login + '/' + full;
    }
    const repo = await gh.repo(full);
    if (!repo) throw new Error('repo_not_found');
    if (!repo.private) throw new Error('repo_public');
    return repo.full_name;
  }

  /* One sync at a time: pull, merge into the local copy, push if GitHub is behind.
   * A write that loses a race with another device (409/422) is retried from a fresh read. */
  function createSyncer(opts) {
    let running = false;
    let again = false;

    async function run() {
      const cfg = opts.config();
      if (!cfg) return;
      if (running) { again = true; return; }
      running = true;
      opts.onStatus('syncing');
      const gh = client(cfg.token, opts.fetch);
      try {
        for (let attempt = 0; ; attempt++) {
          const remote = await gh.read(cfg.repo);
          const now = Date.now();
          const local = merge(opts.getLocal(), null, now);
          const merged = merge(local, remote.data, now);
          if (canon(merged) !== canon(local)) opts.setLocal(merged);
          if (remote.data && canon(merged) === canon(merge(remote.data, null, now))) break;
          try {
            await gh.write(cfg.repo, Object.assign({ app: 'manuscript-tracker', version: 1 }, merged), remote.sha);
            break;
          } catch (e) {
            if ((e.status === 409 || e.status === 422) && attempt < 3) continue;
            throw e;
          }
        }
        opts.onStatus('ok', { at: Date.now() });
      } catch (e) {
        opts.onStatus('error', e);
      } finally {
        running = false;
        if (again) { again = false; run(); }
      }
    }

    return { run };
  }

  const api = { merge, canon, client, verify, createSyncer, b64encode, b64decode, GitHubError, FILE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GitHubSync = api;
})(typeof window !== 'undefined' ? window : this);
