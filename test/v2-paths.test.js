const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const P = require('../lib/v2-paths');

const ROOT = '/srv/projects';

test('V79: resolveUnder maps the empty path to the root itself', () => {
  assert.deepEqual(P.resolveUnder(ROOT, ''), { rel: '', abs: ROOT });
  assert.deepEqual(P.resolveUnder(ROOT, '/'), { rel: '', abs: ROOT });
  assert.deepEqual(P.resolveUnder(ROOT, './'), { rel: '', abs: ROOT });
});

test('V79: resolveUnder normalises slashes and dot segments', () => {
  assert.deepEqual(P.resolveUnder(ROOT, '/a//b/./c/'), { rel: 'a/b/c', abs: path.join(ROOT, 'a/b/c') });
});

test('V79: anything that could leave the root is refused with a status', () => {
  for (const bad of ['..', 'a/../..', '../etc/passwd', 'a/..\\b', 'a\0b']) {
    assert.throws(() => P.resolveUnder(ROOT, bad), (e) => e.statusCode === 400 || e.statusCode === 403, bad);
  }
  // An absolute path is read as relative — never as an escape.
  assert.equal(P.resolveUnder(ROOT, '/etc/passwd').abs, path.join(ROOT, 'etc/passwd'));
});

test('V79: noise + hidden helpers', () => {
  assert.equal(P.isNoiseName('node_modules'), true);
  assert.equal(P.isNoiseName('src'), false);
  assert.equal(P.isHiddenName('.env'), true);
  assert.equal(P.isHiddenName('env'), false);
  assert.equal(P.parentOf('a/b/c'), 'a/b');
  assert.equal(P.parentOf('a'), '');
  assert.equal(P.baseOf('a/b/c.md'), 'c.md');
  assert.equal(P.baseOf('c.md'), 'c.md');
});
