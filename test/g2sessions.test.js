const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const g2 = require('../lib/g2sessions');

// Drives a real detached g2mirror session, the way the hub does. Skipped
// where g2mirror isn't installed.
const G2 = process.env.G2MIRROR_BIN || path.join(os.homedir(), '.local', 'bin', 'g2mirror');
const haveG2 = fs.existsSync(G2);

test('keyOfCommand finds the key only as a whole env assignment', () => {
  assert.equal(g2.keyOfCommand('env HUB_TERM_KEY=hub-abcd1234 TERM=xterm-256color claude'), 'hub-abcd1234');
  assert.equal(g2.keyOfCommand('env XHUB_TERM_KEY=hub-abcd1234 sh'), null);
  assert.equal(g2.keyOfCommand('env HUB_TERM_KEY=../x sh'), null);
  assert.equal(g2.keyOfCommand('bash -l'), null);
  assert.equal(g2.keyOfCommand(undefined), null);
});

test('screenText renders a snapshot to text lines', async () => {
  const text = await g2.screenText(Buffer.from('\x1b[H\x1b[2J\x1b[1;1H\x1b[1mbold\x1b[0m  \x1b[3;5Hthird'), 20, 4);
  assert.equal(text, 'bold\n\n    third\n');
});

test('a hub session is listed, typed into, read without being resized, and closed', { skip: !haveG2 && 'g2mirror not installed' }, async () => {
  // Socket paths are capped near 108 bytes: keep the runtime dir short.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g2h-'));
  const opts = { dir };
  const key = 'hub-test0001';
  const app = 'while IFS= read -r l; do echo "got:$l"; stty size; done';
  try {
    execFileSync(G2, ['--detached', '--', 'env', `HUB_TERM_KEY=${key}`, 'sh', '-c', app],
      { cwd: '/', env: { ...process.env, G2MIRROR_DIR: dir }, stdio: 'ignore' });
    execFileSync(G2, ['--detached', '--', 'sh', '-c', 'sleep 30'],
      { cwd: '/', env: { ...process.env, G2MIRROR_DIR: dir }, stdio: 'ignore' });

    const listed = await g2.list(opts);
    assert.equal(listed.length, 1, 'only sessions carrying a key are the hub\'s');
    assert.equal(listed[0].name, key);
    assert.equal(listed[0].backend, 'g2mirror');
    assert.equal(listed[0].detached, true);
    assert.deepEqual([listed[0].cols, listed[0].rows], [80, 24]);

    assert.equal(await g2.input(key, 'hello\r', opts), true);
    let shot;
    for (let i = 0; i < 20; i++) {
      shot = await g2.capture(key, opts);
      if (shot.text.includes('24 80')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.match(shot.text, /^got:hello$/m);
    assert.deepEqual([shot.cols, shot.rows], [80, 24]);
    assert.equal(await g2.input(key, 'again\r', opts), true);
    await new Promise((r) => setTimeout(r, 300));
    shot = await g2.capture(key, opts);
    assert.deepEqual(shot.text.split('\n').filter((l) => /^\d+ \d+$/.test(l)), ['24 80', '24 80'],
      'reading the screen must not resize the app');

    assert.equal(await g2.type(key, 'typed', true, opts), true, 'type() adds Enter after a pause');
    for (let i = 0; i < 20 && !/^got:typed$/m.test(shot.text); i++) {
      await new Promise((r) => setTimeout(r, 100));
      shot = await g2.capture(key, opts);
    }
    assert.match(shot.text, /^got:typed$/m);

    assert.equal(await g2.capture('hub-missing1', opts), null);
    assert.equal(await g2.input('hub-missing1', 'x', opts), false);

    const pid = listed[0].pid;
    assert.equal(await g2.kill(key, opts), true);
    assert.throws(() => process.kill(pid, 0), 'the wrapper exited');
    assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith(pid + '-') || n === String(pid)).length, 0,
      'and removed its socket (a clean exit, not a SIGTERM)');
    assert.equal(await g2.has(key, opts), false);
  } finally {
    for (const e of await g2.list(opts)) { try { process.kill(e.pid, 'SIGTERM'); } catch {} }
    for (const n of fs.readdirSync(dir)) {
      const pid = Number(n.split('-')[0]);
      if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
