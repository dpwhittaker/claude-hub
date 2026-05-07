const test = require('node:test');
const assert = require('node:assert/strict');
const { filterReposByFolders } = require('../lib/gh-repos');

function repos(...nwos) {
  return nwos.map((nameWithOwner) => ({ nameWithOwner }));
}

test('filterReposByFolders drops repos whose basename matches an existing folder (V32)', () => {
  const taken = new Set(['claude-hub', 'the-first-step']);
  const out = filterReposByFolders(
    repos('me/claude-hub', 'me/something-new', 'other/the-first-step', 'me/another'),
    taken,
  );
  assert.deepEqual(
    out.map((r) => r.nameWithOwner),
    ['me/something-new', 'me/another'],
  );
});

test('filterReposByFolders matches by basename across owners (forks vs originals)', () => {
  // Cloning the user's fork of someone else's repo should still suppress the
  // upstream entry once the local folder exists.
  const out = filterReposByFolders(
    repos('upstream/cool-thing', 'me/cool-thing'),
    new Set(['cool-thing']),
  );
  assert.equal(out.length, 0);
});

test('filterReposByFolders is a no-op when folder set is empty', () => {
  const all = repos('a/x', 'b/y');
  const out = filterReposByFolders(all, new Set());
  assert.deepEqual(out, all);
});

test('filterReposByFolders skips malformed entries without crashing', () => {
  const out = filterReposByFolders(
    [{ nameWithOwner: 'me/ok' }, null, { nameWithOwner: '' }, { nameWithOwner: 'no-slash' }],
    new Set(['skip-me']),
  );
  // 'no-slash' has no '/' but split().pop() returns 'no-slash' which doesn't
  // match any folder, so it survives.
  assert.deepEqual(out.map((r) => r.nameWithOwner), ['me/ok', 'no-slash']);
});
