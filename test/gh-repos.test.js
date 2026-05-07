const test = require('node:test');
const assert = require('node:assert/strict');
const { makeGhRepos, REPO_FIELDS } = require('../lib/gh-repos');

function fakeRepos(updatedDays = [3, 1, 5]) {
  return updatedDays.map((d, i) => ({
    nameWithOwner: 'owner/r' + i,
    description: 'desc' + i,
    isFork: i % 2 === 0,
    isPrivate: i === 0,
    updatedAt: new Date(Date.now() - d * 86400_000).toISOString(),
  }));
}

test('list shells out to gh repo list with the right fields (V32)', async () => {
  let calls = 0;
  let capturedArgs = null;
  const repos = fakeRepos([2, 1, 3]);
  const exec = async (cmd, args) => {
    calls++;
    capturedArgs = { cmd, args };
    return { stdout: JSON.stringify(repos) };
  };
  const g = makeGhRepos({ exec });
  await g.list();
  assert.equal(calls, 1);
  assert.equal(capturedArgs.cmd, 'gh');
  assert.deepEqual(capturedArgs.args, ['repo', 'list', '--json', REPO_FIELDS, '--limit', '200']);
});

test('result sorted by updatedAt desc', async () => {
  const repos = fakeRepos([5, 1, 3]); // r0=5d ago, r1=1d ago, r2=3d ago
  const exec = async () => ({ stdout: JSON.stringify(repos) });
  const g = makeGhRepos({ exec });
  const out = await g.list();
  assert.deepEqual(out.map((r) => r.nameWithOwner), ['owner/r1', 'owner/r2', 'owner/r0']);
});

test('cache hit within TTL — exec called once across multiple list() calls (V32)', async () => {
  let calls = 0;
  const exec = async () => { calls++; return { stdout: JSON.stringify(fakeRepos()) }; };
  const g = makeGhRepos({ exec, ttlMs: 60_000 });
  await g.list();
  await g.list();
  await g.list();
  assert.equal(calls, 1);
});

test('cache expires after TTL — exec called again', async () => {
  let calls = 0;
  let nowMs = 1_000_000;
  const exec = async () => { calls++; return { stdout: JSON.stringify(fakeRepos()) }; };
  const g = makeGhRepos({ exec, ttlMs: 1000, now: () => nowMs });
  await g.list();
  nowMs += 500;
  await g.list();
  nowMs += 600; // total 1100 > ttl 1000
  await g.list();
  assert.equal(calls, 2);
});

test('invalidate forces refetch', async () => {
  let calls = 0;
  const exec = async () => { calls++; return { stdout: JSON.stringify(fakeRepos()) }; };
  const g = makeGhRepos({ exec });
  await g.list();
  g.invalidate();
  await g.list();
  assert.equal(calls, 2);
});

test('throws on non-array stdout (so route returns 503)', async () => {
  const exec = async () => ({ stdout: '{"unexpected":true}' });
  const g = makeGhRepos({ exec });
  await assert.rejects(g.list(), /non-array/);
});

test('propagates exec errors so route can 503', async () => {
  const exec = async () => { throw new Error('gh: not authenticated'); };
  const g = makeGhRepos({ exec });
  await assert.rejects(g.list(), /not authenticated/);
});
