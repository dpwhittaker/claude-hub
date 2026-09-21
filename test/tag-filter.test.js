const test = require('node:test');
const assert = require('node:assert/strict');
const { collectTags, hasTag } = require('../lib/tag-filter');

// SPEC §V72 — the landing page's tag chips.
//
// Tags are typed by hand into README frontmatter across many projects, so
// the same tag shows up as `Game` and `game`, `3D` and `3d`. The badge CSS
// upper-cases them, so on the cards they already look identical; the chip
// row has to agree or a click on "GAME" hides half the games.

test('V72: one chip per tag, case-insensitive, counted per card', () => {
  const chips = collectTags([
    { tags: ['Game', 'WIP'] },
    { tags: ['game', '3d'] },
    { tags: ['Tool', '3D', 'WIP'] },
  ]);
  assert.deepEqual(chips, [
    { key: '3d', label: '3d', count: 2 },
    { key: 'game', label: 'Game', count: 2 },
    { key: 'tool', label: 'Tool', count: 1 },
    { key: 'wip', label: 'WIP', count: 2 },
  ]);
});

test('V72: a chip shows the spelling the first card used', () => {
  const [chip] = collectTags([{ tags: ['3D'] }, { tags: ['3d'] }]);
  assert.equal(chip.label, '3D');
  const [chip2] = collectTags([{ tags: ['3d'] }, { tags: ['3D'] }]);
  assert.equal(chip2.label, '3d');
});

test('V72: a card listing the same tag twice counts once', () => {
  const chips = collectTags([{ tags: ['WIP', 'wip', ' WIP '] }]);
  assert.deepEqual(chips, [{ key: 'wip', label: 'WIP', count: 1 }]);
});

test('V72: chips sort alphabetically by key regardless of case', () => {
  const keys = collectTags([{ tags: ['zeta', 'Alpha', 'beta', 'Gamma'] }]).map((c) => c.key);
  assert.deepEqual(keys, ['alpha', 'beta', 'gamma', 'zeta']);
});

test('V72: junk tag lists produce no chips and never throw', () => {
  assert.deepEqual(collectTags([]), []);
  assert.deepEqual(collectTags([{ tags: [] }, {}, null, { tags: 'WIP' }]), []);
  assert.deepEqual(collectTags([{ tags: ['', '   ', 42, null] }]), []);
});

test('V72: hasTag matches with the same normalisation collectTags keys on', () => {
  const cards = [{ tags: ['Game', 'WIP'] }, { tags: ['game'] }, { tags: ['Tool'] }];
  const [gameChip] = collectTags(cards).filter((c) => c.key === 'game');
  const matching = cards.filter((c) => hasTag(c.tags, gameChip.key));
  assert.equal(matching.length, gameChip.count,
    'a chip must select exactly the cards it was counted from');
  assert.equal(hasTag(['3D'], '3d'), true);
  assert.equal(hasTag(['3D'], ' 3D '), true);
});

test('V72: hasTag is false for an empty key, a missing list, or a non-string entry', () => {
  assert.equal(hasTag(['Game'], ''), false);
  assert.equal(hasTag(['Game'], '   '), false);
  assert.equal(hasTag(undefined, 'game'), false);
  assert.equal(hasTag([42, null, 'Game'], 'game'), true);
  assert.equal(hasTag([42, null], '42'), false);
});

test('V72: the injected helpers are self-contained (no free identifiers)', () => {
  // Both functions are stringified into landing.html, so they can only use
  // their own arguments and JS built-ins. Evaluating the source in a bare
  // scope catches a stray closure over module state.
  for (const fn of [collectTags, hasTag]) {
    const src = fn.toString();
    assert.doesNotMatch(src, /\brequire\(/);
    const rebuilt = new Function(`return (${src});`)();
    assert.equal(typeof rebuilt, 'function');
  }
  const rebuilt = new Function(`return (${collectTags.toString()});`)();
  assert.deepEqual(rebuilt([{ tags: ['A'] }]), [{ key: 'a', label: 'A', count: 1 }]);
});
