const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCard, sortCards, buildProjectCards } = require('../lib/project-cards');

// SPEC §V55 — sentinel-over-README precedence.
//
// A git worktree checks out its parent's README byte-for-byte. If the card
// only ever read README.md, every worktree card would be an exact duplicate
// of the project it branched from and the landing page would be unusable.

test('V55: sentinel title/description win over README', () => {
  const card = buildCard({
    name: 'proj_wt',
    meta: { title: 'Forge — lighting', description: 'Worktree on branch lighting.' },
    readme: { title: 'Forge', description: 'The parent README paragraph.', tags: ['Game'] },
  });
  assert.equal(card.title, 'Forge — lighting');
  assert.equal(card.description, 'Worktree on branch lighting.');
});

test('V55: README fills in whatever the sentinel leaves unset', () => {
  const card = buildCard({
    name: 'proj',
    meta: {},
    readme: { title: 'Forge', description: 'A world builder.', tags: ['Game'] },
  });
  assert.equal(card.title, 'Forge');
  assert.equal(card.description, 'A world builder.');
  assert.deepEqual(card.tags, ['Game']);
});

test('V55: folder name is the last-resort title; description may be empty', () => {
  const card = buildCard({ name: 'bare', meta: {}, readme: {} });
  assert.equal(card.title, 'bare');
  assert.equal(card.description, '');
  assert.deepEqual(card.tags, []);
});

test('V55: worktree badge leads, README tags kept behind it', () => {
  const card = buildCard({
    name: 'proj_wt',
    meta: { worktreeOf: 'proj', branch: 'lighting' },
    readme: { tags: ['Game', 'WIP'] },
  });
  assert.deepEqual(card.tags, ['worktree', 'Game', 'WIP']);
  assert.equal(card.worktreeOf, 'proj');
  assert.equal(card.branch, 'lighting');
});

test('V55: a plain project gets no worktree badge and null worktree fields', () => {
  const card = buildCard({ name: 'proj', meta: {}, readme: { tags: ['Tool'] } });
  assert.deepEqual(card.tags, ['Tool']);
  assert.equal(card.worktreeOf, null);
  assert.equal(card.branch, null);
});

test('V55: empty-string worktreeOf is not a worktree', () => {
  const card = buildCard({ name: 'proj', meta: { worktreeOf: '', branch: '' }, readme: {} });
  assert.equal(card.worktreeOf, null);
  assert.equal(card.branch, null);
  assert.deepEqual(card.tags, []);
});

test('openUrl defaults to the rendered README, sentinel overrides it', () => {
  assert.equal(buildCard({ name: 'p', meta: {}, readme: {} }).openUrl, '/view/p/README.md');
  assert.equal(buildCard({ name: 'p', meta: { openUrl: '/p/' }, readme: {} }).openUrl, '/p/');
});

// --- ordering -------------------------------------------------------------

const card = (name, createdAt, worktreeOf) => ({
  name, createdAt, worktreeOf: worktreeOf || null,
});

test('V55: plain projects stay in creation order', () => {
  const out = sortCards([
    card('c', '2026-03-01'), card('a', '2026-01-01'), card('b', '2026-02-01'),
  ]);
  assert.deepEqual(out.map((p) => p.name), ['a', 'b', 'c']);
});

test('V55: a worktree sorts beside its parent, not at the end by age', () => {
  // The worktree is the newest thing on disk by a wide margin — a plain
  // createdAt sort would drop it after `zeta`.
  const out = sortCards([
    card('alpha', '2026-01-01'),
    card('zeta', '2026-02-01'),
    card('alpha_lighting', '2026-08-09', 'alpha'),
  ]);
  assert.deepEqual(out.map((p) => p.name), ['alpha', 'alpha_lighting', 'zeta']);
});

test('V55: parent leads its worktrees, siblings alphabetical', () => {
  const out = sortCards([
    card('wb_grade', '2026-08-11', 'wb'),
    card('wb_avatar', '2026-08-10', 'wb'),
    card('wb', '2026-01-01'),
    card('other', '2026-02-01'),
  ]);
  assert.deepEqual(out.map((p) => p.name), ['wb', 'wb_avatar', 'wb_grade', 'other']);
});

test('V55: orphaned worktree (parent deleted) falls back to its own createdAt', () => {
  const out = sortCards([
    card('b', '2026-05-01'),
    card('ghost_wt', '2026-09-01', 'ghost'),
    card('a', '2026-01-01'),
  ]);
  assert.deepEqual(out.map((p) => p.name), ['a', 'b', 'ghost_wt']);
});

test('V55: missing createdAt sorts first and stays deterministic', () => {
  const out = sortCards([card('z', '2026-01-01'), card('m', null), card('k', null)]);
  assert.deepEqual(out.map((p) => p.name), ['k', 'm', 'z']);
});

test('buildProjectCards maps then sorts in one pass', () => {
  const out = buildProjectCards([
    { name: 'p_wt', meta: { createdAt: '2026-08-01', worktreeOf: 'p' }, readme: { tags: ['Game'] } },
    { name: 'later', meta: { createdAt: '2026-02-01' }, readme: {} },
    { name: 'p', meta: { createdAt: '2026-01-01' }, readme: { title: 'Parent' } },
  ]);
  assert.deepEqual(out.map((p) => p.name), ['p', 'p_wt', 'later']);
  assert.deepEqual(out[1].tags, ['worktree', 'Game']);
  assert.equal(out[0].title, 'Parent');
});
