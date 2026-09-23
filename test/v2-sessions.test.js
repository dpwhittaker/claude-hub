const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeSessionStore, termKey, termUrl } = require('../lib/v2-sessions');

function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2sess-'));
  const projectsRoot = path.join(dir, 'projects');
  fs.mkdirSync(path.join(projectsRoot, 'proj/sub'), { recursive: true });
  return { dir, projectsRoot, s: makeSessionStore({ dir, projectsRoot }) };
}

test('V83: create writes one JSON file per session and an optional prompt sidecar', () => {
  const { dir, s } = store();
  const a = s.create({ cwd: 'proj/sub', agent: 'claude', profile: 'david', prompt: 'hello there' });
  assert.match(a.id, /^[a-z0-9]{8}$/);
  assert.equal(a.cwd, 'proj/sub');
  assert.equal(a.agent, 'claude');
  assert.equal(a.profile, 'david');
  assert.match(a.uuid, /^[0-9a-f-]{36}$/);
  assert.equal(a.kind, 'hub');
  assert.equal(a.termKey, 'hub-' + a.id);
  assert.equal(a.termUrl, '/term/hub/?arg=' + a.id);
  const disk = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', a.id + '.json'), 'utf8'));
  assert.equal(disk.uuid, a.uuid);
  assert.equal(disk.termUrl, undefined, 'derived fields are not persisted');
  assert.equal(fs.readFileSync(path.join(dir, 'sessions', a.id + '.prompt'), 'utf8'), 'hello there');
  const b = s.create({ cwd: '', agent: 'shell' });
  assert.equal(b.cwd, '');
  assert.equal(b.profile, null);
  assert.ok(!fs.existsSync(path.join(dir, 'sessions', b.id + '.prompt')));
  assert.deepEqual(s.list().map((x) => x.id).sort(), [a.id, b.id].sort());
});

test('V83: create validates agent, cwd, profile, prompt', () => {
  const { s } = store();
  assert.throws(() => s.create({ cwd: 'proj', agent: 'gpt' }), (e) => e.statusCode === 400);
  assert.throws(() => s.create({ cwd: '../' }), (e) => e.statusCode === 400);
  assert.throws(() => s.create({ cwd: 'missing' }), (e) => e.statusCode === 404);
  assert.throws(() => s.create({ cwd: 'proj', profile: 'Bad Id' }), (e) => e.statusCode === 400);
  assert.throws(() => s.create({ cwd: 'proj', prompt: 'x'.repeat(9000) }), (e) => e.statusCode === 400);
  assert.equal(s.create({ cwd: 'proj' }).agent, 'claude', 'agent defaults to claude');
});

test('V83: get / update / remove', () => {
  const { dir, s } = store();
  const a = s.create({ cwd: 'proj', prompt: 'p' });
  assert.equal(s.get(a.id).cwd, 'proj');
  assert.throws(() => s.get('zzzzzzzz'), (e) => e.statusCode === 404);
  assert.throws(() => s.get('../x'), (e) => e.statusCode === 400);
  assert.equal(s.update(a.id, { title: 'Refactor' }).title, 'Refactor');
  assert.equal(s.get(a.id).title, 'Refactor');
  assert.deepEqual(s.remove(a.id), { id: a.id, deleted: true });
  assert.ok(!fs.existsSync(path.join(dir, 'sessions', a.id + '.json')));
  assert.ok(!fs.existsSync(path.join(dir, 'sessions', a.id + '.prompt')));
  assert.equal(termKey('abc'), 'hub-abc');
  assert.equal(termUrl('abc'), '/term/hub/?arg=abc');
});

test('V96: an explicit termKey (a migrated v1 tab) is kept and served; a bad one is refused', () => {
  const { s } = store();
  const m = s.create({ cwd: 'proj', agent: 'codex', termKey: 'proj__s3', uuid: '11111111-2222-3333-4444-555555555555' });
  assert.equal(m.termKey, 'proj__s3');
  assert.equal(m.uuid, '11111111-2222-3333-4444-555555555555');
  assert.equal(s.get(m.id).termKey, 'proj__s3');
  assert.equal(s.update(m.id, { title: 't' }).termKey, 'proj__s3', 'update keeps it');
  assert.equal(s.create({ cwd: 'proj' }).termKey.slice(0, 4), 'hub-', 'default is hub-<id>');
  assert.throws(() => s.create({ cwd: 'proj', termKey: '../x' }), (e) => e.statusCode === 400);
  assert.throws(() => s.create({ cwd: 'proj', uuid: 'nope' }), (e) => e.statusCode === 400);
});
