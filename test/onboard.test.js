const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startFixture } = require('./helpers/fixture');

function scratchProjectsRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hub-onboard-'));
  process.env.PROJECTS_ROOT = root;
  // Force the server module to re-read PROJECTS_ROOT so direct exports
  // (bootstrapOnboard, listOrphanFolderNames) target this scratch dir.
  delete require.cache[require.resolve('../server.js')];
  const reloaded = require('../server.js');
  return { root, mod: reloaded };
}

test('bootstrapOnboard stamps meta + writes scan-existing prompt without touching pre-existing files (V36)', async () => {
  const { root, mod } = scratchProjectsRoot();
  try {
    const dir = path.join(root, 'legacy');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'README.md'), '# pre-existing\n');
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'pre-existing agent doc\n');
    fs.writeFileSync(path.join(dir, 'src.js'), '// keep me\n');

    await mod.bootstrapOnboard(dir, 'legacy');

    const meta = JSON.parse(fs.readFileSync(path.join(dir, '.project-meta.json'), 'utf8'));
    assert.equal(meta.name, 'legacy');
    assert.ok(meta.createdAt, 'createdAt stamped');
    assert.ok(!('github' in meta), 'no github field on onboard');
    assert.ok(!('template' in meta), 'no template field on onboard');

    assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), '# pre-existing\n');
    assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), 'pre-existing agent doc\n');
    assert.equal(fs.readFileSync(path.join(dir, 'src.js'), 'utf8'), '// keep me\n');

    const prompt = fs.readFileSync(path.join(dir, '.claude-bootstrap.txt'), 'utf8');
    assert.match(prompt, /Walk the tree/);
    assert.match(prompt, /never overwrite/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootstrapOnboard returns 404 when folder is missing (V36)', async () => {
  const { root, mod } = scratchProjectsRoot();
  try {
    await assert.rejects(
      mod.bootstrapOnboard(path.join(root, 'nope'), 'nope'),
      (e) => e.statusCode === 404 && /not found/i.test(e.message),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootstrapOnboard returns 409 when .project-meta.json already exists (V36)', async () => {
  const { root, mod } = scratchProjectsRoot();
  try {
    const dir = path.join(root, 'taken');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, '.project-meta.json'), '{"name":"taken"}');
    await assert.rejects(
      mod.bootstrapOnboard(dir, 'taken'),
      (e) => e.statusCode === 409 && /already managed/i.test(e.message),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('listOrphanFolderNames returns dirs without sentinel, excludes hidden + managed (V37)', () => {
  const { root, mod } = scratchProjectsRoot();
  try {
    fs.mkdirSync(path.join(root, 'orphan-a'));
    fs.mkdirSync(path.join(root, 'orphan-b'));
    fs.mkdirSync(path.join(root, 'managed'));
    fs.writeFileSync(path.join(root, 'managed', '.project-meta.json'), '{}');
    fs.mkdirSync(path.join(root, '.hidden'));
    fs.writeFileSync(path.join(root, 'a-file.txt'), 'not a dir');

    const orphans = mod.listOrphanFolderNames();
    assert.deepEqual(orphans, ['orphan-a', 'orphan-b']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('GET /api/projects/orphans returns the orphan list', async () => {
  const fx = await startFixture();
  try {
    fs.mkdirSync(path.join(fx.projectsRoot, 'a-orphan'));
    fs.mkdirSync(path.join(fx.projectsRoot, 'b-managed'));
    fs.writeFileSync(path.join(fx.projectsRoot, 'b-managed', '.project-meta.json'), '{}');
    const r = await fetch(fx.url + '/api/projects/orphans');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.deepEqual(body, { folders: ['a-orphan'] });
  } finally {
    await fx.close();
  }
});

test('POST /api/projects onboard → 404 when folder missing', async () => {
  const fx = await startFixture();
  try {
    const r = await fetch(fx.url + '/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ghost', github: { mode: 'onboard' } }),
    });
    assert.equal(r.status, 404);
    const body = await r.json();
    assert.match(body.error, /not found/i);
  } finally {
    await fx.close();
  }
});

test('POST /api/projects onboard → 409 when .project-meta.json already exists', async () => {
  const fx = await startFixture();
  try {
    const dir = path.join(fx.projectsRoot, 'taken');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, '.project-meta.json'), '{"name":"taken"}');
    const r = await fetch(fx.url + '/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'taken', github: { mode: 'onboard' } }),
    });
    assert.equal(r.status, 409);
    const body = await r.json();
    assert.match(body.error, /already managed/i);
  } finally {
    await fx.close();
  }
});
