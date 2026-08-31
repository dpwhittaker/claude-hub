const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startFixture } = require('./helpers/fixture');

function mkProject(root, name, meta, readme) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.project-meta.json'), JSON.stringify({ name, ...meta }));
  if (readme != null) fs.writeFileSync(path.join(dir, 'README.md'), readme);
}

// The parent README is what a `git worktree add` checkout inherits verbatim.
const PARENT_README = '---\ntags: [Game, WIP]\n---\n\n# World Forge\n\nA 3D world builder.\n';

test('V55: /api/projects surfaces worktree provenance and groups it under its parent', async () => {
  const fx = await startFixture();
  try {
    mkProject(fx.projectsRoot, 'wb', { createdAt: '2026-01-01T00:00:00Z' }, PARENT_README);
    mkProject(fx.projectsRoot, 'other', { createdAt: '2026-02-01T00:00:00Z' }, '# Other\n\nElse.\n');
    // Created seven months after its parent — a plain createdAt sort would
    // strand it at the end of the list, away from the project it belongs to.
    mkProject(
      fx.projectsRoot,
      'wb_lighting',
      {
        createdAt: '2026-08-09T00:00:00Z',
        worktreeOf: 'wb',
        branch: 'avatar-lighting',
        title: 'World Forge — lighting',
        description: 'Worktree on branch avatar-lighting.',
      },
      PARENT_README, // inherited byte-for-byte, as a real worktree would
    );

    const r = await fetch(fx.url + '/api/projects');
    assert.equal(r.status, 200);
    const { projects } = await r.json();
    assert.deepEqual(projects.map((p) => p.name), ['wb', 'wb_lighting', 'other']);

    const [parent, wt] = projects;
    assert.equal(parent.worktreeOf, null);
    assert.deepEqual(parent.tags, ['Game', 'WIP']);

    assert.equal(wt.worktreeOf, 'wb');
    assert.equal(wt.branch, 'avatar-lighting');
    assert.deepEqual(wt.tags, ['worktree', 'Game', 'WIP']);
    // The whole point: it must not read as a duplicate of its parent.
    assert.notEqual(wt.title, parent.title);
    assert.notEqual(wt.description, parent.description);
    assert.equal(wt.title, 'World Forge — lighting');
  } finally {
    await fx.close();
  }
});

test('V55: a project with no sentinel overrides still reads from README', async () => {
  const fx = await startFixture();
  try {
    mkProject(fx.projectsRoot, 'plain', { createdAt: '2026-01-01T00:00:00Z' }, PARENT_README);
    const { projects } = await (await fetch(fx.url + '/api/projects')).json();
    assert.equal(projects.length, 1);
    assert.equal(projects[0].title, 'World Forge');
    assert.equal(projects[0].description, 'A 3D world builder.');
    assert.equal(projects[0].worktreeOf, null);
    assert.equal(projects[0].branch, null);
  } finally {
    await fx.close();
  }
});
