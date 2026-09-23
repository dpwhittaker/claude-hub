const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { makeFs, classify } = require('../lib/v2-fs');

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v2fs-'));
  return { root, api: makeFs({ projectsRoot: root }) };
}

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
}

test('V79: list at the root and in a folder; dotfiles + noise dirs are dim; dirs first', () => {
  const { root, api } = scratch();
  fs.mkdirSync(path.join(root, 'proj/node_modules'), { recursive: true });
  fs.mkdirSync(path.join(root, 'proj/src'));
  fs.writeFileSync(path.join(root, 'proj/.env'), 'x');
  fs.writeFileSync(path.join(root, 'proj/README.md'), '# hi');
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'root');
  const top = api.list('');
  assert.equal(top.path, '');
  assert.deepEqual(top.entries.map((e) => e.name), ['proj', 'AGENTS.md']);
  assert.equal(top.entries[1].kind, 'file');
  assert.equal(top.entries[1].defaultMode, 'view');
  const inner = api.list('proj');
  assert.deepEqual(inner.entries.map((e) => [e.name, e.kind, e.dim]), [
    ['node_modules', 'dir', true], ['src', 'dir', false], ['.env', 'file', true], ['README.md', 'file', false],
  ]);
  assert.equal(inner.entries[3].path, 'proj/README.md');
});

test('V79: every disk call refuses to leave the root', () => {
  const { api } = scratch();
  for (const fn of ['list', 'stat', 'readText', 'mkdir', 'createFile', 'log']) {
    assert.throws(() => api[fn]('../x'), (e) => e.statusCode === 400, fn);
  }
  assert.throws(() => api.writeText('../x', 'a'), (e) => e.statusCode === 400);
  assert.throws(() => api.rename('a', '../b'), (e) => e.statusCode === 400);
});

test('V81: writeText refuses a stale baseMtime with 409 and reports the disk mtime', () => {
  const { root, api } = scratch();
  fs.writeFileSync(path.join(root, 'a.txt'), 'one');
  const first = api.readText('a.txt');
  assert.equal(first.content, 'one');
  // Someone else writes meanwhile (bump the mtime well past the original).
  fs.writeFileSync(path.join(root, 'a.txt'), 'two');
  fs.utimesSync(path.join(root, 'a.txt'), new Date(first.mtime + 5000), new Date(first.mtime + 5000));
  assert.throws(() => api.writeText('a.txt', 'three', { baseMtime: first.mtime }), (e) => e.statusCode === 409 && typeof e.mtime === 'number');
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'two', 'the conflict never clobbers');
  const cur = api.readText('a.txt');
  const w = api.writeText('a.txt', 'three', { baseMtime: cur.mtime });
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'three');
  assert.equal(typeof w.mtime, 'number');
  // No baseMtime → unconditional write (the "overwrite anyway" path).
  api.writeText('a.txt', 'four');
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'four');
  // New file in a new folder is created.
  api.writeText('deep/er/new.md', '# new');
  assert.equal(fs.readFileSync(path.join(root, 'deep/er/new.md'), 'utf8'), '# new');
});

test('V81: mkdir / createFile / rename with 409 on collisions', () => {
  const { root, api } = scratch();
  assert.deepEqual(api.mkdir('a/b'), { path: 'a/b' });
  assert.ok(fs.statSync(path.join(root, 'a/b')).isDirectory());
  assert.throws(() => api.mkdir('a/b'), (e) => e.statusCode === 409);
  assert.throws(() => api.mkdir(''), (e) => e.statusCode === 400);
  assert.deepEqual(api.createFile('a/b/c.ts'), { path: 'a/b/c.ts' });
  assert.equal(fs.readFileSync(path.join(root, 'a/b/c.ts'), 'utf8'), '');
  assert.throws(() => api.createFile('a/b/c.ts'), (e) => e.statusCode === 409);
  assert.deepEqual(api.rename('a/b/c.ts', 'a/d.ts'), { path: 'a/d.ts' });
  assert.ok(fs.existsSync(path.join(root, 'a/d.ts')));
  assert.throws(() => api.rename('a/d.ts', 'a/b'), (e) => e.statusCode === 409);
  assert.throws(() => api.rename('nope', 'x'), (e) => e.statusCode === 404);
});

test('V81: diff + log find the nearest enclosing repo (never above the root); untracked files diff as added', () => {
  const { root, api } = scratch();
  const repo = path.join(root, 'group/repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  git(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, 'src/a.js'), 'const a = 1;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'first');
  fs.writeFileSync(path.join(repo, 'src/a.js'), 'const a = 2;\n');
  git(repo, 'commit', '-q', '-am', 'second');
  fs.writeFileSync(path.join(repo, 'src/a.js'), 'const a = 3;\n');

  const d = api.diff('group/repo/src/a.js');
  assert.equal(d.repo, 'group/repo');
  assert.equal(d.ref, 'HEAD');
  assert.match(d.diff, /-const a = 2;\n\+const a = 3;/);
  const lg = api.log('group/repo/src/a.js');
  assert.equal(lg.commits.length, 2);
  assert.equal(lg.commits[0].subject, 'second');
  assert.match(lg.commits[0].short, /^[0-9a-f]{7,}$/);
  const older = api.diff('group/repo/src/a.js', lg.commits[1].sha);
  assert.match(older.diff, /-const a = 1;\n\+const a = 3;/);
  const between = api.diff('group/repo/src/a.js', lg.commits[1].sha, lg.commits[0].sha);
  assert.match(between.diff, /-const a = 1;\n\+const a = 2;/);
  assert.equal(api.showAt('group/repo/src/a.js', lg.commits[1].sha), 'const a = 1;\n');

  fs.writeFileSync(path.join(repo, 'src/new.js'), 'new\n');
  const added = api.diff('group/repo/src/new.js');
  assert.match(added.diff, /\+new/);

  assert.throws(() => api.diff('group/repo/src/a.js', 'nope;rm'), (e) => e.statusCode === 400);
  assert.throws(() => api.diff('group/repo/src/a.js', 'no-such-ref'), (e) => e.statusCode === 404);

  // A file outside any repo: no repo, empty log, diff is a 404.
  fs.writeFileSync(path.join(root, 'loose.txt'), 'x');
  assert.equal(api.log('loose.txt').repo, null);
  assert.throws(() => api.diff('loose.txt'), (e) => e.statusCode === 404);

  // list() flags git state per entry.
  const l = api.list('group/repo/src');
  assert.equal(l.repo, 'group/repo');
  assert.equal(l.entries.find((e) => e.name === 'a.js').git, 'M');
  assert.equal(l.entries.find((e) => e.name === 'new.js').git, '??');
  const st = api.stat('group/repo/src/a.js');
  assert.equal(st.git, 'M');
  assert.equal(st.lang, 'javascript');
  assert.equal(st.textual, true);
});

test('V81: classify picks the default mode per file kind', () => {
  assert.equal(classify('README.md').defaultMode, 'view');
  assert.equal(classify('a.png').defaultMode, 'view');
  assert.deepEqual(classify('a.png').modes, ['view', 'raw']);
  assert.equal(classify('a.ts').defaultMode, 'raw');
  assert.deepEqual(classify('a.ts').modes, ['raw', 'edit', 'diff']);
  assert.equal(classify('a.zip').fileKind, 'binary');
  assert.equal(classify('index.html').fileKind, 'html');
});

test('V98: remove deletes a file or a whole folder, never the root', () => {
  const { root, api } = scratch();
  fs.mkdirSync(path.join(root, 'd/sub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'd/sub/x.txt'), 'x');
  fs.writeFileSync(path.join(root, 'f.txt'), 'f');
  assert.deepEqual(api.remove('f.txt'), { path: 'f.txt', kind: 'file', deleted: true });
  assert.ok(!fs.existsSync(path.join(root, 'f.txt')));
  assert.deepEqual(api.remove('d'), { path: 'd', kind: 'dir', deleted: true });
  assert.ok(!fs.existsSync(path.join(root, 'd')));
  assert.throws(() => api.remove(''), (e) => e.statusCode === 400);
  assert.throws(() => api.remove('../x'), (e) => e.statusCode === 400);
  assert.throws(() => api.remove('gone'), (e) => e.statusCode === 404);
});
