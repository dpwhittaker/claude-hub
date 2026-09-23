const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
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

const U1 = '11111111-1111-1111-1111-111111111111';
// A session the v1 migration would have produced: keeps the tmux name proj__s1.
async function migratedSession(url) {
  const r = await post(url + '/api/v2/sessions', { cwd: 'proj', agent: 'claude', termKey: 'proj__s1', uuid: U1 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

function seed(root) {
  fs.mkdirSync(path.join(root, 'proj/src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'proj/.project-meta.json'), JSON.stringify({ name: 'proj', proxyTarget: 'http://127.0.0.1:59999', routes: [{ match: '**/*.md', to: '/:dir/:name.html' }] }));
  fs.writeFileSync(path.join(root, 'proj/README.md'), '---\ntags: [AI]\n---\n# Proj\n\nHello *world*.\n');
  fs.writeFileSync(path.join(root, 'proj/src/a.js'), 'const a = 1;\n');
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'root notes\n');
  // A project below the top level (V99).
  fs.mkdirSync(path.join(root, 'group/site/docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'group/site/.project-meta.json'), JSON.stringify({ name: 'site', proxyTarget: 'http://127.0.0.1:59998', routes: [{ match: '**/*.md', to: '/:dir/:name.html' }] }));
  fs.writeFileSync(path.join(root, 'group/site/docs/a.md'), '# a\n');
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  execFileSync('git', ['-C', path.join(root, 'proj'), 'init', '-q'], { env });
  execFileSync('git', ['-C', path.join(root, 'proj'), 'add', '.'], { env });
  execFileSync('git', ['-C', path.join(root, 'proj'), 'commit', '-q', '-m', 'init'], { env });
}

test('V96: the workspace is served at /, /v2/ comes home, and its files stay under /v2/', async () => {
  const fx = await startFixture({ seed });
  try {
    const r = await fetch(fx.url + '/');
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
    for (const old of ['/v2', '/v2/', '/landing.html']) {
      const redir = await fetch(fx.url + old + '?profile=x', { redirect: 'manual' });
      assert.equal(redir.status, 301, old);
      assert.equal(redir.headers.get('location'), '/?profile=x', old);
    }
    assert.equal((await fetch(fx.url + '/p/proj/')).status, 404, 'the PWA shell is gone');
    assert.equal((await fetch(fx.url + '/api/view-tree/proj')).status, 404, 'and so is the glasses shim (T109)');
    assert.equal((await fetch(fx.url + '/v2/../server.js')).status, 404);
    assert.equal((await fetch(fx.url + '/v2/nope.txt')).status, 404);
  } finally { await fx.close(); }
});

test('V94: /api/v2/version changes when a served client file changes', async () => {
  const fx = await startFixture({ seed });
  try {
    const a = (await json(fx.url + '/api/v2/version')).body.version;
    assert.match(a, /^\d+$/);
    const f = path.join(__dirname, '..', 'v2', 'app.css');
    const st = fs.statSync(f);
    // Well into the future: any other client file may have been edited more
    // recently than this one, and the stamp is the NEWEST mtime.
    fs.utimesSync(f, st.atime, new Date(Date.now() + 600000));
    try {
      const b = (await json(fx.url + '/api/v2/version')).body.version;
      assert.notEqual(b, a);
    } finally { fs.utimesSync(f, st.atime, st.mtime); }
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

test('V83/V96: sessions API creates records anywhere under the root; a migrated session keeps its tmux name', async () => {
  const fx = await startFixture({ seed });
  try {
    const before = await json(fx.url + '/api/v2/sessions');
    assert.equal(before.status, 200);
    assert.deepEqual(before.body.sessions, []);
    const mig = await migratedSession(fx.url);
    assert.equal(mig.termKey, 'proj__s1');
    assert.equal(mig.termUrl, '/term/hub/?arg=' + mig.id);
    assert.equal(mig.uuid, U1);
    assert.equal((await post(fx.url + '/api/v2/sessions', { cwd: 'proj', termKey: '../x' })).status, 400);
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
    assert.deepEqual(root.body.entries.map((e) => e.name), ['group', 'proj', 'AGENTS.md']);
    const proj = root.body.entries.find((e) => e.name === 'proj');
    assert.equal(proj.project, true);
    assert.equal(proj.repo, true);
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
    assert.equal((await post(fx.url + '/api/v2/fs/delete', { path: 'proj/docs' })).status, 200);
    assert.ok(!fs.existsSync(path.join(fx.projectsRoot, 'proj/docs')), 'a folder is deleted whole');
    assert.equal((await post(fx.url + '/api/v2/fs/delete', { path: '' })).status, 400, 'the root cannot be deleted');
    for (const u of ['/api/v2/fs/list?path=..', '/api/v2/fs/text?path=../../etc/passwd', '/api/v2/fs/raw?path=..%2F..%2Fetc%2Fpasswd']) {
      const r = await json(fx.url + u);
      assert.ok(r.status === 400 || r.status === 403, u + ' → ' + r.status);
    }
    assert.equal((await post(fx.url + '/api/v2/fs/mkdir', { path: '../escape' })).status, 400);
    assert.equal((await json(fx.url + '/api/v2/fs/text?path=nope.txt')).status, 404);
    assert.equal((await json(fx.url + '/api/v2/nope')).status, 404);
  } finally { await fx.close(); }
});

test('V99: a repo can be created in any folder — sentinel, session and preview follow the nested path', async () => {
  const fx = await startFixture({ seed });
  try {
    const bad = await post(fx.url + '/api/projects', { name: 'x', dir: '../etc', template: 'none', github: { mode: 'skip' } });
    assert.equal(bad.status, 400);
    assert.equal((await post(fx.url + '/api/projects', { name: 'x', dir: 'nope', template: 'none', github: { mode: 'skip' } })).status, 404);
    const r = await post(fx.url + '/api/projects', { name: 'Nested One', dir: 'group', template: 'none', github: { mode: 'skip' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.name, 'nested-one');
    assert.equal(r.body.path, 'group/nested-one');
    assert.match(r.body.termUrl, /^\/term\/hub\/\?arg=/);
    assert.ok(fs.existsSync(path.join(fx.projectsRoot, 'group/nested-one/.project-meta.json')));
    assert.ok(fs.existsSync(path.join(fx.projectsRoot, 'group/nested-one/SPEC.md')));
    const sess = (await json(fx.url + '/api/v2/sessions')).body.sessions.find((s) => s.id === r.body.sessionId);
    assert.equal(sess.cwd, 'group/nested-one', 'the first session runs in the nested folder');
    assert.ok(fs.existsSync(path.join(fx.hubStateDir, 'sessions', sess.id + '.prompt')), 'seeded with the bootstrap prompt');
    assert.equal((await post(fx.url + '/api/projects', { name: 'nested-one', dir: 'group', template: 'none', github: { mode: 'skip' } })).status, 409);
    // Orphans are listed per folder.
    fs.mkdirSync(path.join(fx.projectsRoot, 'group/plain'));
    const orphans = await json(fx.url + '/api/projects/orphans?dir=group');
    assert.deepEqual(orphans.body, { dir: 'group', folders: ['plain'] });
    assert.equal((await json(fx.url + '/api/projects/orphans?dir=..')).status, 400);
    // A file inside a nested sentinel previews through that project's proxy.
    const st = await json(fx.url + '/api/v2/fs/stat?path=group/site/docs/a.md');
    assert.equal(st.body.previewUrl, '/site/docs/a.html');
    assert.equal((await json(fx.url + '/api/v2/fs/stat?path=group/nested-one/SPEC.md')).body.previewUrl, null, 'no proxy target → no preview');
  } finally { await fx.close(); }
});

test('V90: titles API round-trips and the sessions list prefers hub title → transcript title', async () => {
  const fx = await startFixture({ seed });
  try {
    const uuid = U1;
    const mig = await migratedSession(fx.url);
    let r = await json(fx.url + '/api/v2/sessions');
    let legacy = r.body.sessions.find((s) => s.id === mig.id);
    assert.equal(legacy.title, null, 'no transcript, no hub title → null');
    assert.equal((await json(fx.url + '/api/v2/titles/' + uuid)).status, 404);
    const set = await post(fx.url + '/api/v2/titles', { uuid, title: '"Refactor The Tab Strip."', source: 'auto' });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(set.body.title, 'Refactor The Tab Strip');
    assert.equal((await json(fx.url + '/api/v2/titles/' + uuid)).body.title, 'Refactor The Tab Strip');
    r = await json(fx.url + '/api/v2/sessions');
    legacy = r.body.sessions.find((s) => s.id === mig.id);
    assert.equal(legacy.title, 'Refactor The Tab Strip');
    assert.equal((await post(fx.url + '/api/v2/titles', { uuid: 'nope', title: 'x' })).status, 400);
    assert.equal((await post(fx.url + '/api/v2/titles', { uuid, title: '' })).status, 400);
    assert.equal((await json(fx.url + '/api/v2/titles/' + uuid, { method: 'DELETE' })).status, 200);
    assert.equal((await json(fx.url + '/api/v2/titles/' + uuid)).status, 404);
    assert.ok(fs.existsSync(path.join(fx.hubStateDir, 'titles.json')));
  } finally { await fx.close(); }
});

test('V92/V90: a live claude session (Claude registry) supplies status, its current id and the newest name; the hub follows the id', async () => {
  const regDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2reg-'));
  process.env.HUB_CLAUDE_SESSIONS_DIR = regDir;
  const fx = await startFixture({ seed });
  try {
    const LIVE = '33333333-3333-3333-3333-333333333333';
    const mig = await migratedSession(fx.url);
    // Pretend the seeded v1 tab's tmux session runs THIS process (alive pid) and moved to a new id after a /clear.
    const statusAt = Date.now() - 3600000; // an hour ago: tmux will be "active" right now, and must not win
    fs.writeFileSync(path.join(regDir, process.pid + '.json'), JSON.stringify({ pid: process.pid, sessionId: LIVE, cwd: '/x', tmux: 'proj__s1:@1.%1', name: 'renamed-by-user', nameSource: 'user', nameSince: Date.now(), status: 'waiting', statusUpdatedAt: statusAt, updatedAt: statusAt }));
    // The tab must count as running for the registry to apply: seed a tmux entry by name.
    let tmuxOk = true;
    try { execFileSync('tmux', ['new-session', '-d', '-s', 'proj__s1', 'sleep 30']); } catch { tmuxOk = false; }
    if (!tmuxOk) return; // no tmux on this box — nothing to assert
    let s = (await json(fx.url + '/api/v2/sessions')).body.sessions.find((x) => x.id === mig.id);
    assert.equal(s.running, true);
    assert.equal(s.activity, 'waiting');
    assert.equal(s.uuid, LIVE, 'the live id replaces the launch id');
    assert.equal(s.title, 'renamed-by-user');
    assert.equal(s.lastActive, statusAt, 'a live claude session\'s recency is the registry\'s status change (B32), not tmux activity');
    const rec = JSON.parse(fs.readFileSync(path.join(fx.hubStateDir, 'sessions', mig.id + '.json'), 'utf8'));
    assert.equal(rec.uuid, LIVE, 'the record follows so a reboot resumes the right conversation');
    assert.equal(rec.termKey, 'proj__s1', 'and keeps its tmux name');
    // A newer hub auto-title beats the user's older name; an older one does not.
    await post(fx.url + '/api/v2/titles', { uuid: LIVE, title: 'Auto Title Later' });
    s = (await json(fx.url + '/api/v2/sessions')).body.sessions.find((x) => x.id === mig.id);
    assert.equal(s.title, 'Auto Title Later');
    fs.writeFileSync(path.join(regDir, process.pid + '.json'), JSON.stringify({ pid: process.pid, sessionId: LIVE, cwd: '/x', tmux: 'proj__s1:@1.%1', name: 'renamed-again', nameSource: 'user', nameSince: Date.now() + 60000, status: 'idle', updatedAt: Date.now() }));
    s = (await json(fx.url + '/api/v2/sessions')).body.sessions.find((x) => x.id === mig.id);
    assert.equal(s.title, 'renamed-again', 'a /rename after the auto title wins');
    assert.equal(s.activity, 'idle');
    // A derived placeholder name never shows.
    fs.writeFileSync(path.join(regDir, process.pid + '.json'), JSON.stringify({ pid: process.pid, sessionId: LIVE, cwd: '/x', tmux: 'proj__s1:@1.%1', name: 'proj-1a', nameSource: 'derived', nameSince: Date.now() + 120000, status: 'busy', updatedAt: Date.now() }));
    s = (await json(fx.url + '/api/v2/sessions')).body.sessions.find((x) => x.id === mig.id);
    assert.equal(s.title, 'Auto Title Later');
    assert.equal(s.activity, 'busy');
  } finally {
    try { execFileSync('tmux', ['kill-session', '-t', '=proj__s1']); } catch {}
    delete process.env.HUB_CLAUDE_SESSIONS_DIR;
    await fx.close();
  }
});

test('V95: POST /api/v2/term/<key>/suspend kills a known tmux session and refuses unknown keys', async () => {
  const fx = await startFixture({ seed });
  try {
    let tmuxOk = true;
    try { execFileSync('tmux', ['new-session', '-d', '-s', 'proj__s1', 'sleep 30']); } catch { tmuxOk = false; }
    if (!tmuxOk) return;
    const mig = await migratedSession(fx.url);
    assert.equal((await post(fx.url + '/api/v2/term/nope__s9/suspend', {})).status, 404, 'not a session the hub knows');
    assert.equal((await post(fx.url + '/api/v2/term/..%2Fx/suspend', {})).status, 400);
    const r = await post(fx.url + '/api/v2/term/proj__s1/suspend', {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { key: 'proj__s1', suspended: true });
    assert.throws(() => execFileSync('tmux', ['has-session', '-t', '=proj__s1'], { stdio: 'ignore' }), 'the tmux session is gone');
    assert.equal((await post(fx.url + '/api/v2/term/proj__s1/suspend', {})).status, 404, 'already stopped');
    const s = (await json(fx.url + '/api/v2/sessions')).body.sessions.find((x) => x.id === mig.id);
    assert.ok(s, 'the record survives a suspend');
    assert.equal(s.running, false);
  } finally {
    try { execFileSync('tmux', ['kill-session', '-t', '=proj__s1']); } catch {}
    await fx.close();
  }
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
