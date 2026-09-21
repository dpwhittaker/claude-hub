const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { startFixture } = require('./helpers/fixture');

// These routes shell out to tmux, which is a hard dependency of the hub
// (every develop tab is a tmux session), so the tests use a real throwaway
// session rather than a stub.
let haveTmux = true;
try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); } catch { haveTmux = false; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEY = `hubtest-${process.pid}-${Math.floor(Math.random() * 1e6)}`;

function tmux(...args) { return execFileSync('tmux', args, { encoding: 'utf8' }); }

async function withSession(fn) {
  // `cat` echoes what we type, so send-keys is observable in the capture.
  tmux('new-session', '-d', '-s', KEY, '-x', '60', '-y', '8', 'printf "hello glasses\\n"; exec cat');
  await sleep(300);
  try { await fn(); } finally { try { tmux('kill-session', '-t', '=' + KEY); } catch {} }
}

async function json(url, init) {
  const r = await fetch(url, init);
  let body = null;
  try { body = await r.json(); } catch {}
  return { status: r.status, body };
}
const post = (url, body) => json(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('V76: GET /api/term-capture/<key> returns the visible pane and marks it watched', { skip: !haveTmux }, async () => {
  const fx = await startFixture();
  try {
    await withSession(async () => {
      const r = await json(`${fx.url}/api/term-capture/${KEY}`);
      assert.equal(r.status, 200);
      assert.equal(r.body.key, KEY);
      assert.equal(r.body.cols, 60);
      assert.equal(r.body.rows, 8);
      assert.equal(r.body.lines[0], 'hello glasses');
      assert.equal(r.body.pending, null);
      assert.equal(r.body.state, null);
    });
    assert.equal((await json(`${fx.url}/api/term-capture/${KEY}`)).status, 404);
    assert.equal((await json(`${fx.url}/api/term-capture/..%2Fetc`)).status, 400);
    assert.equal((await fetch(`${fx.url}/api/term-capture/${KEY}`, { method: 'POST' })).status, 405);
  } finally {
    await fx.close();
  }
});

test('V76/V77: term-input types into the pane, term-scroll sends wheel ticks', { skip: !haveTmux }, async () => {
  const fx = await startFixture();
  try {
    await withSession(async () => {
      const r = await post(`${fx.url}/api/term-input/${KEY}`, { text: 'ping from glasses', enter: true });
      assert.deepEqual(r, { status: 200, body: { ok: true } });
      await sleep(300);
      const cap = await json(`${fx.url}/api/term-capture/${KEY}`);
      assert.ok(cap.body.lines.includes('ping from glasses'), JSON.stringify(cap.body.lines));
      assert.equal((await post(`${fx.url}/api/term-input/${KEY}`, {})).status, 400);
      const s = await post(`${fx.url}/api/term-scroll/${KEY}`, { lines: -3 });
      assert.deepEqual(s, { status: 200, body: { ok: true, ticks: 3 } });
      assert.equal((await post(`${fx.url}/api/term-scroll/${KEY}`, {})).status, 400);
    });
    assert.equal((await post(`${fx.url}/api/term-input/${KEY}`, { text: 'x' })).status, 404);
  } finally {
    await fx.close();
  }
});

test('V75: a question is held only while the glasses are watching, and the answer flows back to the hook', { skip: !haveTmux }, async () => {
  const fx = await startFixture();
  try {
    await withSession(async () => {
      const q = { kind: 'question', session_id: 's', payload: { questions: [{ question: 'Which drink?', options: [{ label: 'Tea' }, { label: 'Water' }] }] } };
      // Nobody watching → the hook gets its answer immediately: fall through.
      const cold = await post(`${fx.url}/api/term-pending/${KEY}`, q);
      assert.deepEqual(cold.body, { ok: true, relay: false, reason: 'unwatched' });

      // A glasses poll makes the key watched; now the same POST is held.
      await json(`${fx.url}/api/term-capture/${KEY}`);
      const heldPromise = post(`${fx.url}/api/term-pending/${KEY}`, q);
      await sleep(100);
      const pend = await json(`${fx.url}/api/term-pending/${KEY}`);
      assert.equal(pend.body.pending.kind, 'question');
      assert.equal(pend.body.pending.payload.questions[0].question, 'Which drink?');
      // The capture poll carries the same pending object.
      const cap = await json(`${fx.url}/api/term-capture/${KEY}`);
      assert.equal(cap.body.pending.id, pend.body.pending.id);

      assert.equal((await post(`${fx.url}/api/term-pending/${KEY}/answer`, { id: 'nope', answer: {} })).status, 409);
      const ans = await post(`${fx.url}/api/term-pending/${KEY}/answer`, { id: pend.body.pending.id, answer: { answers: { 'Which drink?': 'Water' } } });
      assert.deepEqual(ans, { status: 200, body: { ok: true } });
      const held = await heldPromise;
      assert.deepEqual(held.body, { ok: true, relay: true, answer: { answers: { 'Which drink?': 'Water' } } });
      assert.equal((await json(`${fx.url}/api/term-pending/${KEY}`)).body.pending, null);
      assert.equal((await post(`${fx.url}/api/term-pending/${KEY}/answer`, { id: 'x', answer: {} })).status, 404);

      // Release → the hook falls through to the TUI dialog.
      await json(`${fx.url}/api/term-capture/${KEY}`);
      const held2 = post(`${fx.url}/api/term-pending/${KEY}`, { kind: 'permission', payload: { tool_name: 'Bash', tool_input: { command: 'ls' } } });
      await sleep(100);
      const id2 = (await json(`${fx.url}/api/term-pending/${KEY}`)).body.pending.id;
      await post(`${fx.url}/api/term-pending/${KEY}/answer`, { id: id2, release: true });
      assert.deepEqual((await held2).body, { ok: true, relay: false, reason: 'released' });

      // stop / notification are recorded, never held, and show up in state.
      const stop = await post(`${fx.url}/api/term-pending/${KEY}`, { kind: 'stop', payload: { last_assistant_message: 'All done.' } });
      assert.equal(stop.body.relay, false);
      const note = await post(`${fx.url}/api/term-pending/${KEY}`, { kind: 'notification', payload: { notification_type: 'idle_prompt', message: 'waiting' } });
      assert.equal(note.body.relay, false);
      const st = (await json(`${fx.url}/api/term-pending/${KEY}`)).body.state;
      assert.equal(st.lastMessage, 'All done.');
      assert.equal(st.notification.notification_type, 'idle_prompt');
      assert.equal((await post(`${fx.url}/api/term-pending/${KEY}`, { kind: 'bogus' })).status, 400);
    });
  } finally {
    await fx.close();
  }
});

test('V75: the hold ends on its own once the glasses stop polling', { skip: !haveTmux }, async () => {
  process.env.TERM_WATCH_TTL_MS = '300';
  const fx = await startFixture();
  try {
    await withSession(async () => {
      await json(`${fx.url}/api/term-capture/${KEY}`);
      const t0 = Date.now();
      const held = await post(`${fx.url}/api/term-pending/${KEY}`, { kind: 'question', payload: { questions: [] } });
      assert.deepEqual(held.body, { ok: true, relay: false, reason: 'watcher-gone' });
      assert.ok(Date.now() - t0 < 3000);
    });
  } finally {
    delete process.env.TERM_WATCH_TTL_MS;
    await fx.close();
  }
});

test('POST /api/stt → 503 when the whisper service is down', async () => {
  process.env.STT_URL = 'http://127.0.0.1:1';
  const fx = await startFixture();
  try {
    const r = await fetch(`${fx.url}/api/stt`, { method: 'POST', headers: { 'content-type': 'audio/L16; rate=16000' }, body: Buffer.alloc(3200) });
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /stt unavailable/);
    assert.equal((await fetch(`${fx.url}/api/stt`)).status, 405);
  } finally {
    delete process.env.STT_URL;
    await fx.close();
  }
});
