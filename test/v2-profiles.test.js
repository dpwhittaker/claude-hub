const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeProfileStore, slugify } = require('../lib/v2-profiles');
const L = require('../lib/v2-layout');

function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2prof-'));
  return { dir, s: makeProfileStore({ dir }) };
}

test('V82: create → a profile with one home tab, a colour, rev 1; list summarises', () => {
  const { dir, s } = store();
  const p = s.create({ name: 'David' });
  assert.equal(p.id, 'david');
  assert.equal(p.rev, 1);
  assert.match(p.color, /^#[0-9a-f]{6}$/i);
  assert.equal(p.layout.type, 'panel');
  assert.equal(p.layout.tabs.length, 1);
  assert.equal(p.tabs[p.layout.tabs[0]].kind, 'home');
  assert.equal(p.instructions, '');
  assert.ok(fs.existsSync(path.join(dir, 'profiles', 'david', 'profile.json')));
  const wife = s.create({ name: "Mrs W's Science", instructions: 'You help a science teacher.' });
  assert.equal(wife.id, 'mrs-w-s-science');
  assert.equal(wife.instructions, 'You help a science teacher.');
  assert.equal(fs.readFileSync(s.instructionsPath(wife.id), 'utf8'), 'You help a science teacher.');
  assert.notEqual(wife.color, p.color);
  assert.deepEqual(s.list().map((x) => [x.id, x.tabCount]), [['david', 1], ['mrs-w-s-science', 1]]);
  assert.throws(() => s.create({ name: 'david' }), (e) => e.statusCode === 409);
  assert.throws(() => s.create({ name: '!!!' }), (e) => e.statusCode === 400);
  assert.throws(() => s.create({}), (e) => e.statusCode === 400);
});

test('V82: update bumps rev, refuses a stale rev with 409, validates layout+tabs together', () => {
  const { s } = store();
  const p = s.create({ name: 'Me' });
  const home = p.layout.tabs[0];
  const layout = L.splitPanel(L.addTab(p.layout, p.layout.id, 'tfile1'), p.layout.id, 'right', 'p2', 'tfile1');
  const tabs = { ...p.tabs, tfile1: { kind: 'file', path: 'claude-hub/README.md', mode: 'view' } };
  const u = s.update('me', { layout, tabs, rev: 1 });
  assert.equal(u.rev, 2);
  assert.equal(u.layout.type, 'split');
  assert.throws(() => s.update('me', { layout, tabs, rev: 1 }), (e) => e.statusCode === 409 && e.rev === 2);
  // A layout naming a tab the map lacks is refused.
  assert.throws(() => s.update('me', { layout: L.addTab(layout, 'p2', 'ghost'), tabs, rev: 2 }), (e) => e.statusCode === 400);
  // Junk layout / tabs are refused.
  assert.throws(() => s.update('me', { layout: { type: 'x' }, tabs, rev: 2 }), (e) => e.statusCode === 400);
  assert.throws(() => s.update('me', { layout, tabs: { [home]: { kind: 'nope' } }, rev: 2 }), (e) => e.statusCode === 400);
  // Name / colour / instructions.
  const r = s.update('me', { name: 'Me 2', color: '#ff0000', instructions: 'be brief', rev: 2 });
  assert.equal(r.name, 'Me 2');
  assert.equal(r.color, '#ff0000');
  assert.equal(r.instructions, 'be brief');
  assert.equal(r.rev, 3);
  assert.throws(() => s.update('me', { color: 'red' }), (e) => e.statusCode === 400);
  // rev omitted → unconditional (used by the instructions editor).
  assert.equal(s.update('me', { name: 'Me 3' }).rev, 4);
});

test('V82: get / remove / bad ids', () => {
  const { s } = store();
  s.create({ name: 'x1' });
  assert.equal(s.get('x1').name, 'x1');
  assert.throws(() => s.get('../etc'), (e) => e.statusCode === 400);
  assert.throws(() => s.get('nope'), (e) => e.statusCode === 404);
  assert.deepEqual(s.remove('x1'), { id: 'x1', deleted: true });
  assert.deepEqual(s.list(), []);
  assert.throws(() => s.remove('x1'), (e) => e.statusCode === 404);
});

test('V82: slugify', () => {
  assert.equal(slugify('  Bible Study! '), 'bible-study');
  assert.equal(slugify('Émilie'), 'emilie');
  assert.equal(slugify('###'), '');
});
