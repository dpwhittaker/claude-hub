const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startFixture } = require('./helpers/fixture');
const { readSessionsMap } = require('../lib/term-sessions');

// These tests target the JSON map + route plumbing only — the sudo /
// systemctl branches return 500 because no real systemd is available in the
// test env. We assert ordering: map is mutated BEFORE the systemctl call,
// then rolled back on failure for create / left in place for delete.
//
// To keep map-mutation visible without a working sudo, we seed `.develop-
// sessions.json` directly and call the GET / PUT endpoints which don't shell
// out, then verify POST does its rollback and DELETE removes the entry.

function seedProject(fx, name, mapBody) {
  const dir = path.join(fx.projectsRoot, name);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '.project-meta.json'), JSON.stringify({ name }));
  if (mapBody !== undefined) {
    fs.writeFileSync(path.join(dir, '.develop-sessions.json'), JSON.stringify(mapBody));
  }
  return dir;
}

test('GET /api/term-sessions/<proj> reflects the on-disk map', async () => {
  const fx = await startFixture();
  try {
    seedProject(fx, 'demo', {
      sessions: { s1: 'uuid-1', s2: 'uuid-2' },
      lastActive: 's2',
    });
    const r = await fetch(fx.url + '/api/term-sessions/demo');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.deepEqual(body, {
      sessions: [
        { id: 's1', uuid: 'uuid-1', title: null },
        { id: 's2', uuid: 'uuid-2', title: null },
      ],
      lastActive: 's2',
    });
  } finally {
    await fx.close();
  }
});

test('GET sorts sessions by numeric id, not lexical', async () => {
  const fx = await startFixture();
  try {
    seedProject(fx, 'demo', {
      sessions: { s10: 'u10', s2: 'u2', s1: 'u1' },
      lastActive: null,
    });
    const r = await fetch(fx.url + '/api/term-sessions/demo');
    const body = await r.json();
    assert.deepEqual(body.sessions.map((s) => s.id), ['s1', 's2', 's10']);
  } finally {
    await fx.close();
  }
});

test('GET returns empty list when no map file', async () => {
  const fx = await startFixture();
  try {
    seedProject(fx, 'demo');
    const r = await fetch(fx.url + '/api/term-sessions/demo');
    const body = await r.json();
    assert.deepEqual(body, { sessions: [], lastActive: null });
  } finally {
    await fx.close();
  }
});

test('GET returns 404 for unknown project', async () => {
  const fx = await startFixture();
  try {
    const r = await fetch(fx.url + '/api/term-sessions/nope');
    assert.equal(r.status, 404);
  } finally {
    await fx.close();
  }
});

test('PUT /active updates lastActive iff id is in the map', async () => {
  const fx = await startFixture();
  try {
    const dir = seedProject(fx, 'demo', {
      sessions: { s1: 'u1', s2: 'u2' },
      lastActive: 's1',
    });
    const r = await fetch(fx.url + '/api/term-sessions/demo/active', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 's2' }),
    });
    assert.equal(r.status, 200);
    assert.equal(readSessionsMap(dir).lastActive, 's2');

    const bad = await fetch(fx.url + '/api/term-sessions/demo/active', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 's9' }),
    });
    assert.equal(bad.status, 404);
    assert.equal(readSessionsMap(dir).lastActive, 's2');
  } finally {
    await fx.close();
  }
});

test('PUT /active rejects bad payload shape', async () => {
  const fx = await startFixture();
  try {
    seedProject(fx, 'demo', { sessions: { s1: 'u1' }, lastActive: 's1' });
    for (const body of [
      JSON.stringify({}),
      JSON.stringify({ id: '' }),
      JSON.stringify({ id: 'S1' }),
      JSON.stringify({ id: 's0' }),
      JSON.stringify({ id: 'foo' }),
    ]) {
      const r = await fetch(fx.url + '/api/term-sessions/demo/active', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      assert.equal(r.status, 400, `body ${body} should 400`);
    }
  } finally {
    await fx.close();
  }
});

// POST/DELETE intentionally not covered here — they shell out to
// `sudo systemctl` against the host's real systemd, and exercising them in
// a unit-test fixture would install actual ttyd@<temp-name>.service units.
// The pure logic (id allocation, map mutation, lastActive rollback) is
// exercised in test/term-sessions.test.js.

test('405 on unsupported methods', async () => {
  const fx = await startFixture();
  try {
    seedProject(fx, 'demo', { sessions: { s1: 'u1' }, lastActive: 's1' });
    const a = await fetch(fx.url + '/api/term-sessions/demo', { method: 'PUT' });
    assert.equal(a.status, 405);
    const b = await fetch(fx.url + '/api/term-sessions/demo/active', { method: 'GET' });
    assert.equal(b.status, 405);
    const c = await fetch(fx.url + '/api/term-sessions/demo/s1', { method: 'GET' });
    assert.equal(c.status, 405);
  } finally {
    await fx.close();
  }
});
