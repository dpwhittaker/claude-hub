const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parentProjectName, branchName, worktreeRemovalPlan } = require('../lib/worktree');

// --- the plan (pure) ------------------------------------------------------

test('V56: a plain project has no worktree plan — caller just rm -rfs', () => {
  assert.equal(worktreeRemovalPlan({ dir: '/p/a', meta: {}, projectsRoot: '/p' }), null);
  assert.equal(worktreeRemovalPlan({ dir: '/p/a', meta: { worktreeOf: '' }, projectsRoot: '/p' }), null);
  assert.equal(worktreeRemovalPlan({ dir: '/p/a', meta: { worktreeOf: '   ' }, projectsRoot: '/p' }), null);
});

test('V56: a worktree plan targets the parent repo, not the worktree dir', () => {
  const plan = worktreeRemovalPlan({
    dir: '/p/wb_lighting', meta: { worktreeOf: 'wb' }, projectsRoot: '/p',
  });
  assert.equal(plan.parent, 'wb');
  assert.equal(plan.parentDir, '/p/wb');
  assert.deepEqual(plan.removeArgs, ['-C', '/p/wb', 'worktree', 'remove', '--force', '/p/wb_lighting']);
  assert.deepEqual(plan.pruneArgs, ['-C', '/p/wb', 'worktree', 'prune']);
});

test('V56: worktreeOf comes off disk, so it gets full name validation', () => {
  // Anything that could escape PROJECTS_ROOT degrades to "not a worktree",
  // which means a plain rm inside the already-validated project dir.
  for (const bad of ['../evil', 'a/b', '/etc', '.hidden', 'a b', 'a;rm -rf /', '..']) {
    assert.equal(parentProjectName({ worktreeOf: bad }), null, bad);
    assert.equal(
      worktreeRemovalPlan({ dir: '/p/x', meta: { worktreeOf: bad }, projectsRoot: '/p' }),
      null,
      bad,
    );
  }
  assert.equal(parentProjectName({ worktreeOf: 'world-builder-opus-5' }), 'world-builder-opus-5');
});

test('V56: non-string sentinel values are ignored', () => {
  assert.equal(parentProjectName({ worktreeOf: 42 }), null);
  assert.equal(parentProjectName(null), null);
  assert.equal(branchName({ branch: 7 }), null);
  assert.equal(branchName({ branch: ' main ' }), 'main');
});

// --- the plan, run against real git --------------------------------------
// The argv is only useful if git actually accepts it, so these drive a real
// repo rather than asserting on strings.

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

function makeRepoWithWorktree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-test-'));
  const parent = path.join(root, 'proj');
  fs.mkdirSync(parent);
  git(parent, 'init', '-q', '-b', 'main');
  git(parent, 'config', 'user.email', 'test@example.invalid');
  git(parent, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(parent, 'README.md'), '# proj\n');
  git(parent, 'add', '.');
  git(parent, 'commit', '-qm', 'init');
  const wt = path.join(root, 'proj_task');
  git(parent, 'worktree', 'add', '-q', '-b', 'task', wt);
  return { root, parent, wt };
}

test('V56: removeArgs detaches the worktree AND deletes the directory', () => {
  const { root, parent, wt } = makeRepoWithWorktree();
  try {
    assert.ok(git(parent, 'worktree', 'list').includes(wt), 'worktree should be registered first');
    const plan = worktreeRemovalPlan({ dir: wt, meta: { worktreeOf: 'proj' }, projectsRoot: root });
    execFileSync('git', plan.removeArgs, { encoding: 'utf8' });
    assert.ok(!git(parent, 'worktree', 'list').includes(wt), 'registry entry should be gone');
    assert.ok(!fs.existsSync(wt), 'directory should be gone');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('V56: --force removes a worktree with uncommitted changes', () => {
  // The UI already confirmed the delete; git refusing over a dirty tree would
  // strand the folder half-removed.
  const { root, parent, wt } = makeRepoWithWorktree();
  try {
    fs.writeFileSync(path.join(wt, 'README.md'), '# dirty\n');
    fs.writeFileSync(path.join(wt, 'untracked.txt'), 'x\n');
    const plan = worktreeRemovalPlan({ dir: wt, meta: { worktreeOf: 'proj' }, projectsRoot: root });
    execFileSync('git', plan.removeArgs, { encoding: 'utf8' });
    assert.ok(!fs.existsSync(wt));
    assert.ok(!git(parent, 'worktree', 'list').includes(wt));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('V56: rm -rf alone leaves a stale entry; pruneArgs is what clears it', () => {
  // This is the regression the plan exists for — SPEC §B16.
  const { root, parent, wt } = makeRepoWithWorktree();
  try {
    fs.rmSync(wt, { recursive: true, force: true });
    assert.ok(
      git(parent, 'worktree', 'list').includes(wt),
      'git still lists the removed checkout — the stale entry this guards against',
    );
    const plan = worktreeRemovalPlan({ dir: wt, meta: { worktreeOf: 'proj' }, projectsRoot: root });
    execFileSync('git', plan.pruneArgs, { encoding: 'utf8' });
    assert.ok(!git(parent, 'worktree', 'list').includes(wt), 'prune should clear it');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
