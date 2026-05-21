const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startFixture } = require('./helpers/fixture');
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
  for (const r of ['develop', 'wsl', 'view', 'term', 'api']) {
    assert.ok(RESERVED_PROJECT_NAMES.has(r), `${r} must be reserved`);
  }
});

test('viewer rejects path traversal vectors with 4xx, never 200', async () => {
  const fx = await startFixture();
  try {
    fs.mkdirSync(path.join(fx.projectsRoot, 'demo'));
    fs.writeFileSync(path.join(fx.projectsRoot, 'demo', 'hello.txt'), 'hi\n');
    // Sentinel a sibling so the traversal target is real and would render
    // if the guard ever broke.
    fs.writeFileSync(path.join(fx.projectsRoot, 'secret.txt'), 'leak\n');

    const vectors = [
      '/view/demo/../secret.txt',
      '/view/demo/%2e%2e/secret.txt',
      '/view/demo/%2e%2e%2fsecret.txt',
      '/view/demo/foo%00.txt',
      '/view/demo//etc/passwd',
      '/view/demo/' + encodeURIComponent('/etc/passwd'),
    ];
    for (const v of vectors) {
      const r = await fetch(fx.url + v, { redirect: 'manual' });
      // Must fail closed: never a 200 leak. 3xx redirect is OK iff it lands
      // on a 4xx target — easier rule: status must NOT be 200.
      assert.notEqual(r.status, 200, `${v} returned 200 (potential leak)`);
      // Body must not contain the sibling's contents.
      const body = await r.text();
      assert.ok(!body.includes('leak'), `${v} body leaks secret.txt`);
    }
  } finally {
    await fx.close();
  }
});

test('viewer rejects non-GET/HEAD with 405 (V3)', async () => {
  const fx = await startFixture();
  try {
    fs.mkdirSync(path.join(fx.projectsRoot, 'demo'));
    fs.writeFileSync(path.join(fx.projectsRoot, 'demo', 'README.md'), '# hi\n');
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const r = await fetch(fx.url + '/view/demo/README.md', { method });
      assert.equal(r.status, 405, `${method} should be 405`);
    }
  } finally {
    await fx.close();
  }
});

test('reserved project names cannot be created', async () => {
  const fx = await startFixture();
  try {
    for (const r of RESERVED_PROJECT_NAMES) {
      const res = await fetch(fx.url + '/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: r }),
      });
      assert.ok(res.status >= 400, `creating "${r}" must fail (got ${res.status})`);
    }
  } finally {
    await fx.close();
  }
});

// game template + firebase fields must not bypass name validation: rejection
// happens before any scaffold runs (so the test never shells out to npm).
// SPEC §V43, §V45.
test('game template + firebase payload still rejects invalid names', async () => {
  const fx = await startFixture();
  try {
    for (const name of ['../escape', 'bad name!', '']) {
      const res = await fetch(fx.url + '/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, template: 'game-3d', firebase: true }),
      });
      assert.ok(res.status >= 400, `"${name}" w/ game-3d+firebase must fail (got ${res.status})`);
    }
  } finally {
    await fx.close();
  }
});
