const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  readSessionsMap,
  writeSessionsMap,
  allocateTabId,
  parseTermKey,
  joinTermKey,
  TAB_ID_RE,
} = require('../lib/term-sessions');

function tmpProjectDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'term-sessions-test-'));
}

test('readSessionsMap returns empty defaults when file missing', () => {
  const dir = tmpProjectDir();
  try {
    assert.deepEqual(readSessionsMap(dir), { sessions: {}, lastActive: null });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readSessionsMap survives malformed JSON', () => {
  const dir = tmpProjectDir();
  try {
    fs.writeFileSync(path.join(dir, '.develop-sessions.json'), '{not json');
    assert.deepEqual(readSessionsMap(dir), { sessions: {}, lastActive: null });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readSessionsMap drops keys that violate sN shape', () => {
  const dir = tmpProjectDir();
  try {
    fs.writeFileSync(path.join(dir, '.develop-sessions.json'), JSON.stringify({
      sessions: { s1: 'u1', 'bad/key': 'u2', s2: 'u2', '': 'u3', s0: 'leading-zero' },
      lastActive: 's1',
    }));
    const m = readSessionsMap(dir);
    assert.deepEqual(m.sessions, { s1: 'u1', s2: 'u2' });
    assert.equal(m.lastActive, 's1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readSessionsMap clears lastActive when the id is gone', () => {
  const dir = tmpProjectDir();
  try {
    fs.writeFileSync(path.join(dir, '.develop-sessions.json'), JSON.stringify({
      sessions: { s2: 'u2' },
      lastActive: 's1',
    }));
    assert.equal(readSessionsMap(dir).lastActive, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeSessionsMap → readSessionsMap roundtrip', () => {
  const dir = tmpProjectDir();
  try {
    writeSessionsMap(dir, { sessions: { s1: 'u1', s3: 'u3' }, lastActive: 's3' });
    assert.deepEqual(readSessionsMap(dir), { sessions: { s1: 'u1', s3: 'u3' }, lastActive: 's3' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('allocateTabId fills gaps so closed ids get reused', () => {
  assert.equal(allocateTabId({}), 's1');
  assert.equal(allocateTabId({ s1: 'a' }), 's2');
  assert.equal(allocateTabId({ s1: 'a', s3: 'c' }), 's2');
  assert.equal(allocateTabId({ s2: 'b' }), 's1');
});

test('parseTermKey splits on first __ to keep project underscores intact', () => {
  assert.deepEqual(parseTermKey('foo__s1'), { project: 'foo', tabId: 's1' });
  assert.deepEqual(parseTermKey('foo'), { project: 'foo', tabId: null });
  assert.deepEqual(parseTermKey('a_b__s2'), { project: 'a_b', tabId: 's2' });
  // First __ wins so a session id literally containing __ stays as-is.
  assert.deepEqual(parseTermKey('p__s1__weird'), { project: 'p', tabId: 's1__weird' });
});

test('joinTermKey is the inverse of parseTermKey', () => {
  for (const [proj, id] of [['foo', 's1'], ['a_b', 's2'], ['x', 's42']]) {
    assert.deepEqual(parseTermKey(joinTermKey(proj, id)), { project: proj, tabId: id });
  }
});

test('readSessionTitle returns the latest ai-title in a jsonl', () => {
  const { readSessionTitle, encodeClaudeProjectDir } = require('../lib/term-sessions');
  const homedir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-home-'));
  const projectDir = '/home/david/projects/demo';
  try {
    const sessDir = path.join(homedir, '.claude', 'projects', encodeClaudeProjectDir(projectDir));
    fs.mkdirSync(sessDir, { recursive: true });
    const uuid = 'aaaaaaaa-1111-2222-3333-444444444444';
    const lines = [
      JSON.stringify({ type: 'mode', mode: 'normal', sessionId: uuid }),
      JSON.stringify({ type: 'user', content: 'hi' }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'First guess', sessionId: uuid }),
      JSON.stringify({ type: 'assistant', text: 'hello' }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'Better title', sessionId: uuid }),
      JSON.stringify({ type: 'assistant', text: 'goodbye' }),
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(sessDir, uuid + '.jsonl'), lines);
    assert.equal(readSessionTitle(projectDir, uuid, { homedir }), 'Better title');
  } finally {
    fs.rmSync(homedir, { recursive: true, force: true });
  }
});

test('readSessionTitle returns null when no ai-title or no file', () => {
  const { readSessionTitle, encodeClaudeProjectDir } = require('../lib/term-sessions');
  const homedir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-home-'));
  const projectDir = '/home/david/projects/demo';
  try {
    assert.equal(readSessionTitle(projectDir, 'missing', { homedir }), null);
    const sessDir = path.join(homedir, '.claude', 'projects', encodeClaudeProjectDir(projectDir));
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(path.join(sessDir, 'u.jsonl'),
      JSON.stringify({ type: 'mode', mode: 'normal' }) + '\n');
    assert.equal(readSessionTitle(projectDir, 'u', { homedir }), null);
  } finally {
    fs.rmSync(homedir, { recursive: true, force: true });
  }
});

test('readSessionTitle finds title across chunk boundary (large file)', () => {
  const { readSessionTitle, encodeClaudeProjectDir } = require('../lib/term-sessions');
  const homedir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-home-'));
  const projectDir = '/home/david/projects/demo';
  try {
    const sessDir = path.join(homedir, '.claude', 'projects', encodeClaudeProjectDir(projectDir));
    fs.mkdirSync(sessDir, { recursive: true });
    const filler = JSON.stringify({ type: 'user', content: 'x'.repeat(2000) }) + '\n';
    let body = '';
    while (body.length < 200 * 1024) body += filler;
    body += JSON.stringify({ type: 'ai-title', aiTitle: 'Found it' }) + '\n';
    // Trailing filler so the title isn't on the very last line.
    body += filler + filler;
    fs.writeFileSync(path.join(sessDir, 'u.jsonl'), body);
    assert.equal(readSessionTitle(projectDir, 'u', { homedir }), 'Found it');
  } finally {
    fs.rmSync(homedir, { recursive: true, force: true });
  }
});

test('TAB_ID_RE accepts sN for positive N only', () => {
  for (const ok of ['s1', 's2', 's10', 's999']) assert.ok(TAB_ID_RE.test(ok));
  for (const bad of ['s0', 's01', 's', 'S1', 's-1', 's1.0', '', 'sx']) {
    assert.ok(!TAB_ID_RE.test(bad), `must reject "${bad}"`);
  }
});
