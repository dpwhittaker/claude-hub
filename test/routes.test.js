const test = require('node:test');
const assert = require('node:assert/strict');
const { PROJECT_ID_RE, RESERVED_PROJECT_NAMES } = require('../server');

test('PROJECT_ID_RE: accepts safe names, rejects metacharacters', () => {
  for (const ok of ['foo', 'foo-bar', 'a.b', 'a_b', 'A1', 'X.Y_z-9']) {
    assert.ok(PROJECT_ID_RE.test(ok), `should accept "${ok}"`);
  }
  for (const bad of ['foo/bar', '../etc', 'a b', 'foo$', 'foo;bar', 'foo\nbar', '']) {
    assert.ok(!PROJECT_ID_RE.test(bad), `should reject "${bad}"`);
  }
});

test('RESERVED_PROJECT_NAMES covers the route prefixes', () => {
  for (const r of ['develop', 'shell', 'wsl', 'view', 'term', 'api']) {
    assert.ok(RESERVED_PROJECT_NAMES.has(r), `${r} must be reserved`);
  }
});
