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

test('result sorted: non-forks first then forks, updatedAt desc within each group (V32)', async () => {
  // Construct an explicit fork/non-fork mix so the ordering is unambiguous.
  // fork=true items must sink below every fork=false item regardless of
  // their updatedAt.
  const day = (n) => new Date(Date.now() - n * 86400_000).toISOString();
  const repos = [
    { nameWithOwner: 'me/old-own',    isFork: false, updatedAt: day(30) },
    { nameWithOwner: 'me/fresh-fork', isFork: true,  updatedAt: day(1) },
    { nameWithOwner: 'me/new-own',    isFork: false, updatedAt: day(2) },
    { nameWithOwner: 'me/old-fork',   isFork: true,  updatedAt: day(20) },
  ];
  const exec = async () => ({ stdout: JSON.stringify(repos) });
  const g = makeGhRepos({ exec });
  const out = await g.list();
  assert.deepEqual(
    out.map((r) => r.nameWithOwner),
    ['me/new-own', 'me/old-own', 'me/fresh-fork', 'me/old-fork'],
  );
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
