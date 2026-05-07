const test = require('node:test');
const assert = require('node:assert/strict');
const { tabKey } = require('../lib/tab-key');

test('view and render modes for the same path produce distinct keys', () => {
  const p = 'src/App.tsx';
  assert.notEqual(tabKey(p, 'view'), tabKey(p, 'render'),
    'view and render keys must differ for the same path');
});

test('tabKey is deterministic and reversible enough for routing', () => {
  // The exact format is internal, but the same (path, mode) pair must always
  // map to the same key — otherwise tab persistence breaks across reloads.
  for (const p of ['a.md', 'src/main.tsx', 'a/b/c.html', 'spaces ok.md']) {
    for (const m of ['view', 'render']) {
      assert.equal(tabKey(p, m), tabKey(p, m));
    }
  }
});

test('no collision: a file literally named like the render-mode prefix (V15)', () => {
  // Pathological filenames must not collide with the render-mode key for an
  // unrelated file. This covers the "filename contains the mode separator"
  // edge case — Linux filesystems allow ':' in filenames, so the colon-based
  // prefix scheme is unsafe.
  const collisionCandidate = tabKey('render:foo.html', 'view'); // path = "render:foo.html"
  const renderForFoo = tabKey('foo.html', 'render');            // render-mode for foo.html
  assert.notEqual(collisionCandidate, renderForFoo,
    'tabKey collides: a file named "render:foo.html" cannot share a key with the render-mode tab for "foo.html"');
});
