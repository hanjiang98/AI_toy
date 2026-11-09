/* In-memory stand-in for the parts of the GitHub REST API the tracker uses. It follows the real
 * behaviour the sync code depends on: 404 for files and for repositories a token cannot reach,
 * 422 for a create without sha over an existing file, 409 for a stale sha, and sha for delete.
 * Each token belongs to one user and can only reach that user's repositories. */
window.mockGitHub = function () {
  const state = {
    tokens: { 'tok-alice': 'alice', 'tok-bob': 'bob' },
    repos: {
      'alice/data': { private: true, files: {} },
      'alice/pub': { private: false, files: {} },
      'bob/data': { private: true, files: {} },
    },
    n: 0,
    requests: [],
    beforePut: null,
    failPuts: 0,
  };
  const b64 = window.EventStore.b64decode;
  const res = (status, body, blob) => ({
    ok: status < 300,
    status,
    json: async () => body,
    blob: async () => blob,
  });

  async function fetch(url, init) {
    const path = decodeURIComponent(url.replace('https://api.github.com', ''));
    state.requests.push({ method: init.method, path, auth: init.headers.Authorization });
    const login = state.tokens[(init.headers.Authorization || '').replace('Bearer ', '')];
    if (!login) return res(401, { message: 'Bad credentials' });
    if (path === '/user') return state.userForbidden ? res(403, { message: 'Forbidden' }) : res(200, { login });

    const parts = path.match(/^\/repos\/([^/]+)\/([^/]+)(?:\/contents\/(.+))?$/);
    if (!parts) return res(404, { message: 'Not Found' });
    const full = parts[1] + '/' + parts[2];
    const repo = state.repos[full];
    if (!repo || parts[1] !== login) return res(404, { message: 'Not Found' });
    if (!parts[3]) return res(200, { full_name: full, private: repo.private });

    const file = repo.files[parts[3]];
    if (init.method === 'GET') {
      if (!file) return res(404, { message: 'Not Found' });
      if (init.headers.Accept.includes('raw')) return res(200, null, new Blob([window.EventStore.b64ToBytes(file.content)]));
      return res(200, { sha: file.sha, content: file.content, encoding: 'base64' });
    }
    const body = JSON.parse(init.body);
    if (init.method === 'PUT') {
      if (state.failPuts > 0) { state.failPuts--; return res(500, { message: 'Server Error' }); }
      if (state.beforePut) { const f = state.beforePut; state.beforePut = null; f(); }
      const now = repo.files[parts[3]];
      if (now && !body.sha) return res(422, { message: "sha wasn't supplied" });
      if (body.sha && (!now || now.sha !== body.sha)) return res(409, { message: 'sha mismatch' });
      const sha = 'sha' + (++state.n);
      repo.files[parts[3]] = { sha, content: body.content };
      return res(now ? 200 : 201, { content: { sha } });
    }
    if (init.method === 'DELETE') {
      if (!file) return res(404, { message: 'Not Found' });
      if (file.sha !== body.sha) return res(409, { message: 'sha mismatch' });
      delete repo.files[parts[3]];
      return res(200, { commit: {} });
    }
    return res(405, { message: 'Method Not Allowed' });
  }

  return {
    state,
    fetch,
    data: full => {
      const f = state.repos[full].files['events.json'];
      return f ? JSON.parse(b64(f.content)) : null;
    },
    fileNames: full => Object.keys(state.repos[full].files).filter(p => p.startsWith('attachments/')),
    fileText: (full, p) => b64(state.repos[full].files[p].content),
  };
};
