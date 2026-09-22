const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startFixture } = require('./helpers/fixture');

async function json(url, init) {
  const r = await fetch(url, init);
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body, headers: r.headers };
}
const post = (url, body, method = 'POST') => json(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function seed(root) {
  fs.mkdirSync(path.join(root, 'proj/src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'proj/.project-meta.json'), JSON.stringify({ name: 'proj', proxyTarget: 'http://127.0.0.1:59999', routes: [{ match: '**/*.md', to: '/:dir/:name.html' }] }));
  fs.writeFileSync(path.join(root, 'proj/README.md'), '---\ntags: [AI]\n---\n# Proj\n\nHello *world*.\n');
  fs.writeFileSync(path.join(root, 'proj/src/a.js'), 'const a = 1;\n');
  fs.writeFileSync(path.join(root, 'proj/.develop-sessions.json'), JSON.stringify({ sessions: { s1: { uuid: '11111111-1111-1111-1111-111111111111', agent: 'claude' } }, lastActive: 's1' }));
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'root notes\n');
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  execFileSync('git', ['-C', path.join(root, 'proj'), 'init', '-q'], { env });
  execFileSync('git', ['-C', path.join(root, 'proj'), 'add', '.'], { env });
  execFileSync('git', ['-C', path.join(root, 'proj'), 'commit', '-q', '-m', 'init'], { env });
}

test('v2 shell + layout lib are served; /v2 redirects to /v2/', async () => {
  const fx = await startFixture({ seed });
  try {
    const r = await fetch(fx.url + '/v2/');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    const html = await r.text();
    assert.match(html, /<title>claude-hub<\/title>/);
    assert.match(html, /\/v2\/lib\/v2-layout\.js/);
    for (const f of ['app.js', 'app.css', 'tabs.js', 'tab-home.js', 'tab-file.js']) {
      const a = await fetch(fx.url + '/v2/' + f);
      assert.equal(a.status, 200, f);
      assert.equal(a.headers.get('cache-control'), 'no-cache');
    }
    const lib = await (await fetch(fx.url + '/v2/lib/v2-layout.js')).text();
    assert.match(lib, /window\.HubLayout=module\.exports/);
    assert.match(lib, /function splitPanel/);
    const redir = await fetch(fx.url + '/v2', { redirect: 'manual' });
    assert.equal(redir.status, 301);
    assert.equal(redir.headers.get('location'), '/v2/');
    assert.equal((await fetch(fx.url + '/v2/../server.js')).status, 404);
    assert.equal((await fetch(fx.url + '/v2/nope.txt')).status, 404);
  } finally { await fx.close(); }
});

test('V82: profiles round-trip through the API with rev conflicts', async () => {
  const fx = await startFixture({ seed });
  try {
    assert.deepEqual((await json(fx.url + '/api/v2/profiles')).body, { profiles: [] });
    const c = await post(fx.url + '/api/v2/profiles', { name: 'David', instructions: 'Be terse.' });
    assert.equal(c.status, 200);
    assert.equal(c.body.id, 'david');
    assert.equal(c.body.instructions, 'Be terse.');
    assert.ok(fs.existsSync(path.join(fx.hubStateDir, 'profiles/david/CLAUDE.md')));
    const g = await json(fx.url + '/api/v2/profiles/david');
    assert.equal(g.body.rev, 1);
    const home = g.body.layout.tabs[0];
    const tabs = { ...g.body.tabs, tf: { kind: 'file', path: 'proj/README.md', mode: 'view' } };
    const layout = { type: 'split', dir: 'row', sizes: [0.5, 0.5], children: [g.body.layout, { type: 'panel', id: 'p2', tabs: ['tf'], active: 'tf' }] };
    const u = await post(fx.url + '/api/v2/profiles/david', { layout, tabs, rev: 1 }, 'PUT');
    assert.equal(u.status, 200, JSON.stringify(u.body));
    assert.equal(u.body.rev, 2);
    assert.equal(u.body.tabs[home].kind, 'home');
    const stale = await post(fx.url + '/api/v2/profiles/david', { layout, tabs, rev: 1 }, 'PUT');
    assert.equal(stale.status, 409);
    assert.equal(stale.body.rev, 2);
    const bad = await post(fx.url + '/api/v2/profiles/david', { layout: { type: 'panel', id: 'p', tabs: ['ghost'] }, tabs, rev: 2 }, 'PUT');
    assert.equal(bad.status, 400);
    assert.equal((await json(fx.url + '/api/v2/profiles/nope')).status, 404);
    assert.equal((await json(fx.url + '/api/v2/profiles/david', { method: 'DELETE' })).status, 200);
    assert.deepEqual((await json(fx.url + '/api/v2/profiles')).body, { profiles: [] });
  } finally { await fx.close(); }
});

test('V83: sessions API creates records anywhere under the root and lists legacy tabs beside them', async () => {
  const fx = await startFixture({ seed });
  try {
    const before = await json(fx.url + '/api/v2/sessions');
    assert.equal(before.status, 200);
    const legacy = before.body.sessions.find((s) => s.kind === 'legacy');
    assert.ok(legacy, 'legacy tab listed');
    assert.equal(legacy.id, 'proj__s1');
    assert.equal(legacy.termUrl, '/term/proj__s1/');
    assert.equal(typeof legacy.running, 'boolean');
    const c = await post(fx.url + '/api/v2/sessions', { cwd: 'proj/src', agent: 'shell', profile: 'david' });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal(c.body.kind, 'hub');
    assert.equal(c.body.cwd, 'proj/src');
    assert.equal(c.body.termUrl, '/term/hub/?arg=' + c.body.id);
    assert.ok(fs.existsSync(path.join(fx.hubStateDir, 'sessions', c.body.id + '.json')));
    const after = await json(fx.url + '/api/v2/sessions');
    assert.ok(after.body.sessions.some((s) => s.id === c.body.id && s.running === false));
    assert.equal((await post(fx.url + '/api/v2/sessions', { cwd: '../x' })).status, 400);
    assert.equal((await post(fx.url + '/api/v2/sessions', { cwd: 'proj', agent: 'gpt' })).status, 400);
    assert.equal((await post(fx.url + '/api/v2/sessions', { cwd: 'missing' })).status, 404);
    const del = await json(fx.url + '/api/v2/sessions/' + c.body.id, { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.equal((await json(fx.url + '/api/v2/sessions/' + c.body.id)).status, 404);
    assert.equal((await json(fx.url + '/api/v2/sessions/..%2Fx', { method: 'DELETE' })).status, 400);
  } finally { await fx.close(); }
});

test('V79/V81: file API — list, stat with previewUrl, text read/write with 409, raw, render, diff, log, mkdir, create; traversal refused', async () => {
  const fx = await startFixture({ seed });
  try {
    const root = await json(fx.url + '/api/v2/fs/list');
    assert.equal(root.status, 200);
    assert.deepEqual(root.body.entries.map((e) => e.name), ['proj', 'AGENTS.md']);
    assert.equal(root.body.entries[0].project, true);
    assert.equal(root.body.entries[0].repo, true);
    const st = await json(fx.url + '/api/v2/fs/stat?path=proj/README.md');
    assert.equal(st.body.fileKind, 'markdown');
    assert.equal(st.body.previewUrl, '/proj/README.html', 'routes rule maps the file to its live URL');
    assert.equal((await json(fx.url + '/api/v2/fs/stat?path=proj/src/a.js')).body.previewUrl, null);
    const t = await json(fx.url + '/api/v2/fs/text?path=proj/src/a.js');
    assert.equal(t.body.content, 'const a = 1;\n');
    assert.equal(t.body.lang, 'javascript');
    const w = await post(fx.url + '/api/v2/fs/text', { path: 'proj/src/a.js', content: 'const a = 2;\n', baseMtime: t.body.mtime }, 'PUT');
    assert.equal(w.status, 200, JSON.stringify(w.body));
    const stale = await post(fx.url + '/api/v2/fs/text', { path: 'proj/src/a.js', content: 'const a = 3;\n', baseMtime: t.body.mtime - 10000 }, 'PUT');
    assert.equal(stale.status, 409);
    assert.equal(typeof stale.body.mtime, 'number');
    const raw = await fetch(fx.url + '/api/v2/fs/raw?path=proj/src/a.js');
    assert.equal(raw.status, 200);
    assert.match(raw.headers.get('content-type'), /javascript/);
    assert.equal(await raw.text(), 'const a = 2;\n');
    const dl = await fetch(fx.url + '/api/v2/fs/raw?path=proj/src/a.js&download=1');
    assert.match(dl.headers.get('content-disposition'), /attachment; filename="a\.js"/);
    const rendered = await fetch(fx.url + '/api/v2/fs/render?path=proj/README.md');
    assert.match(rendered.headers.get('content-type'), /text\/html/);
    const html = await rendered.text();
    assert.match(html, /<em>world<\/em>/);
    assert.match(html, /tags/);
    const d = await json(fx.url + '/api/v2/fs/diff?path=proj/src/a.js');
    assert.equal(d.body.repo, 'proj');
    assert.match(d.body.diff, /-const a = 1;\n\+const a = 2;/);
    const lg = await json(fx.url + '/api/v2/fs/log?path=proj/src/a.js');
    assert.equal(lg.body.commits.length, 1);
    const show = await json(fx.url + '/api/v2/fs/show?path=proj/src/a.js&ref=HEAD');
    assert.equal(show.body.content, 'const a = 1;\n');
    assert.equal((await post(fx.url + '/api/v2/fs/mkdir', { path: 'proj/docs' })).status, 200);
    assert.equal((await post(fx.url + '/api/v2/fs/mkdir', { path: 'proj/docs' })).status, 409);
    assert.equal((await post(fx.url + '/api/v2/fs/create', { path: 'proj/docs/new.md' })).status, 200);
    assert.equal((await post(fx.url + '/api/v2/fs/rename', { path: 'proj/docs/new.md', to: 'proj/docs/renamed.md' })).status, 200);
    assert.ok(fs.existsSync(path.join(fx.projectsRoot, 'proj/docs/renamed.md')));
    for (const u of ['/api/v2/fs/list?path=..', '/api/v2/fs/text?path=../../etc/passwd', '/api/v2/fs/raw?path=..%2F..%2Fetc%2Fpasswd']) {
      const r = await json(fx.url + u);
      assert.ok(r.status === 400 || r.status === 403, u + ' → ' + r.status);
    }
    assert.equal((await post(fx.url + '/api/v2/fs/mkdir', { path: '../escape' })).status, 400);
    assert.equal((await json(fx.url + '/api/v2/fs/text?path=nope.txt')).status, 404);
    assert.equal((await json(fx.url + '/api/v2/nope')).status, 404);
  } finally { await fx.close(); }
});

test('V90: titles API round-trips and the sessions list prefers hub title → transcript title', async () => {
  const fx = await startFixture({ seed });
  try {
    const uuid = '11111111-1111-1111-1111-111111111111'; // the seeded legacy tab's uuid
    let r = await json(fx.url + '/api/v2/sessions');
    let legacy = r.body.sessions.find((s) => s.id === 'proj__s1');
    assert.equal(legacy.title, null, 'no transcript, no hub title → null');
    assert.equal((await json(fx.url + '/api/v2/titles/' + uuid)).status, 404);
    const set = await post(fx.url + '/api/v2/titles', { uuid, title: '"Refactor The Tab Strip."', source: 'auto' });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(set.body.title, 'Refactor The Tab Strip');
    assert.equal((await json(fx.url + '/api/v2/titles/' + uuid)).body.title, 'Refactor The Tab Strip');
    r = await json(fx.url + '/api/v2/sessions');
    legacy = r.body.sessions.find((s) => s.id === 'proj__s1');
    assert.equal(legacy.title, 'Refactor The Tab Strip');
    assert.equal((await post(fx.url + '/api/v2/titles', { uuid: 'nope', title: 'x' })).status, 400);
    assert.equal((await post(fx.url + '/api/v2/titles', { uuid, title: '' })).status, 400);
    assert.equal((await json(fx.url + '/api/v2/titles/' + uuid, { method: 'DELETE' })).status, 200);
    assert.equal((await json(fx.url + '/api/v2/titles/' + uuid)).status, 404);
    assert.ok(fs.existsSync(path.join(fx.hubStateDir, 'titles.json')));
  } finally { await fx.close(); }
});

test('V92: activity API sets busy/waiting/idle and the sessions list carries activity + lastActive', async () => {
  const fx = await startFixture({ seed });
  try {
    const uuid = '11111111-1111-1111-1111-111111111111';
    let s = (await json(fx.url + '/api/v2/sessions')).body.sessions.find((x) => x.id === 'proj__s1');
    assert.equal(s.activity, null);
    assert.equal(typeof s.running, 'boolean');
    assert.equal((await post(fx.url + '/api/v2/activity', { uuid, state: 'busy' })).status, 200);
    s = (await json(fx.url + '/api/v2/sessions')).body.sessions.find((x) => x.id === 'proj__s1');
    assert.equal(s.activity, 'busy');
    assert.ok(s.lastActive > Date.now() - 5000, 'a hook event counts as activity');
    assert.equal((await post(fx.url + '/api/v2/activity', { uuid, state: 'waiting' })).body.state, 'waiting');
    assert.equal((await post(fx.url + '/api/v2/activity', { uuid, state: 'idle' })).body.state, 'idle');
    assert.equal((await post(fx.url + '/api/v2/activity', { uuid, state: 'nope' })).status, 400);
    assert.equal((await post(fx.url + '/api/v2/activity', { uuid: 'x', state: 'busy' })).status, 400);
    // a shell session with no transcript: lastActive falls back to createdAt
    const c = await post(fx.url + '/api/v2/sessions', { cwd: 'proj', agent: 'shell' });
    const sh = (await json(fx.url + '/api/v2/sessions')).body.sessions.find((x) => x.id === c.body.id);
    assert.equal(sh.activity, null);
    assert.ok(sh.lastActive >= Date.parse(c.body.createdAt));
  } finally { await fx.close(); }
});

test('V85: services API lists {services, tailnet}; actions on unknown units are 404 before any sudo', async () => {
  const fx = await startFixture({ seed });
  try {
    const r = await json(fx.url + '/api/v2/services');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.services));
    assert.ok(Array.isArray(r.body.tailnet));
    for (const s of r.body.services) {
      assert.match(s.unit, /\.service$/);
      assert.doesNotMatch(s.unit, /^ttyd/);
      assert.equal(typeof s.active, 'string');
    }
    assert.equal((await post(fx.url + '/api/v2/services/definitely-not-a-unit.service/restart', {})).status, 404);
    assert.equal((await post(fx.url + '/api/v2/services/..%2Fx.service/restart', {})).status, 404);
    assert.equal((await json(fx.url + '/api/v2/services/definitely-not-a-unit.service/logs')).status, 404);
    assert.equal((await json(fx.url + '/api/v2/services/definitely-not-a-unit.service/unit')).status, 404);
  } finally { await fx.close(); }
});
