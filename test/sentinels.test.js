const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findSentinels, nearestSentinel } = require('../lib/sentinels');
const { systemdEscapePath } = require('../lib/systemd-escape');
const { allocatePort } = require('../lib/port-alloc');

function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sent-'));
  const mk = (rel, meta) => { fs.mkdirSync(path.join(root, rel), { recursive: true }); if (meta) fs.writeFileSync(path.join(root, rel, '.project-meta.json'), JSON.stringify(meta)); };
  mk('top', { proxyTarget: 'http://127.0.0.1:5173' });
  mk('top/inner', { name: 'inner' });                 // inside a sentinel folder → not searched
  mk('glasses');                                      // a plain folder
  mk('glasses/my-app', { proxyTarget: 'http://127.0.0.1:5174' });
  mk('glasses/node_modules/pkg', { name: 'noise' });  // noise → skipped
  mk('.hidden/x', { name: 'hidden' });                // hidden → skipped
  mk('a/b/c/d/e', { name: 'too-deep' });              // beyond MAX_DEPTH
  mk('loose');
  return root;
}

test('V99: findSentinels walks every folder (bounded), skips noise and hidden dirs, and stops at a sentinel', () => {
  const root = tree();
  const found = findSentinels(root);
  assert.deepEqual(found.map((s) => s.rel).sort(), ['glasses/my-app', 'top']);
  assert.equal(found.find((s) => s.rel === 'glasses/my-app').name, 'my-app');
  assert.deepEqual(findSentinels(path.join(root, 'missing')), []);
});

test('V99: nearestSentinel is the path itself or its closest ancestor with a sentinel', () => {
  const root = tree();
  assert.equal(nearestSentinel(root, 'glasses/my-app/src/x.ts').rel, 'glasses/my-app');
  assert.equal(nearestSentinel(root, 'glasses/my-app').rel, 'glasses/my-app');
  assert.equal(nearestSentinel(root, 'top/inner/deep.md').rel, 'top/inner', 'an inner sentinel wins over its parent');
  assert.equal(nearestSentinel(root, 'glasses'), null);
  assert.equal(nearestSentinel(root, ''), null);
});

test('V99: allocatePort sees sentinels at any depth', () => {
  const root = tree();
  assert.equal(allocatePort(root), 5175, '5173 (top) and 5174 (glasses/my-app) are taken');
  assert.equal(allocatePort(root, 4000), 4000);
});

test('V99: systemdEscapePath matches `systemd-escape --path`', () => {
  assert.equal(systemdEscapePath('glasses/my-app'), 'glasses-my\\x2dapp');
  assert.equal(systemdEscapePath('a/b.c'), 'a-b.c');
  assert.equal(systemdEscapePath('x_y/z'), 'x_y-z');
  assert.equal(systemdEscapePath('claude-hub'), 'claude\\x2dhub');
  assert.equal(systemdEscapePath('deep/er/.hidden'), 'deep-er-.hidden');
  assert.equal(systemdEscapePath('sp ace/ü'), 'sp\\x20ace-\\xc3\\xbc');
  assert.equal(systemdEscapePath('/leading/and/trailing/'), 'leading-and-trailing');
  assert.equal(systemdEscapePath(''), '-');
});
