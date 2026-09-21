const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isTermKey, makeRelay, wheelSequences, parseCapture, buildAnswers,
} = require('../lib/term-relay');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('V74: term keys are tmux session names, nothing path-shaped', () => {
  assert.equal(isTermKey('claude-hub__s1'), true);
  assert.equal(isTermKey('develop'), true);
  assert.equal(isTermKey('world-builder-opus-5_avatar-model__s12'), true);
  assert.equal(isTermKey('../etc'), false);
  assert.equal(isTermKey('a b'), false);
  assert.equal(isTermKey(''), false);
  assert.equal(isTermKey('-x'), false);
  assert.equal(isTermKey('x'.repeat(129)), false);
});

test('V75: an unwatched terminal is never held — the hook falls through at once', async () => {
  const relay = makeRelay();
  const r = await relay.hold('k', 'question', { questions: [] });
  assert.deepEqual(r, { relay: false, reason: 'unwatched' });
  assert.equal(relay.getPending('k'), null);
});

test('V75: a watched terminal holds the prompt until the glasses answer it', async () => {
  const relay = makeRelay({ sweepMs: 10 });
  relay.markWatched('k');
  const held = relay.hold('k', 'question', { questions: [{ question: 'Which?', options: [{ label: 'A' }] }] });
  await sleep(5);
  const p = relay.getPending('k');
  assert.equal(p.kind, 'question');
  assert.equal(relay.answer('k', 'wrong-id', {}).status, 409);
  assert.equal(relay.answer('other', p.id, {}).status, 404);
  assert.deepEqual(relay.answer('k', p.id, { answers: { 'Which?': 'A' } }), { ok: true });
  assert.deepEqual(await held, { relay: true, answer: { answers: { 'Which?': 'A' } } });
  assert.equal(relay.getPending('k'), null);
});

test('V75: release hands the prompt back to the TUI', async () => {
  const relay = makeRelay({ sweepMs: 10 });
  relay.markWatched('k');
  const held = relay.hold('k', 'permission', { tool_name: 'Bash' });
  await sleep(5);
  assert.deepEqual(relay.release('k', relay.getPending('k').id), { ok: true });
  assert.deepEqual(await held, { relay: false, reason: 'released' });
});

test('V75: the hold ends when the watcher stops polling', async () => {
  let t = 1000;
  const relay = makeRelay({ now: () => t, watchTtlMs: 50, sweepMs: 5 });
  relay.markWatched('k');
  const held = relay.hold('k', 'question', {});
  t += 100;                       // no poll for longer than the TTL
  assert.deepEqual(await held, { relay: false, reason: 'watcher-gone' });
  assert.equal(relay.getPending('k'), null);
});

test('V75: the hold ages out before the hook timeout would kill it', async () => {
  let t = 0;
  const relay = makeRelay({ now: () => t, watchTtlMs: 10_000, holdMaxMs: 100, sweepMs: 5 });
  relay.markWatched('k');
  const held = relay.hold('k', 'question', {});
  t += 60; relay.markWatched('k');
  t += 60;                        // watcher still polling, but 120 ms > holdMax
  assert.deepEqual(await held, { relay: false, reason: 'timeout' });
});

test('V75: a second prompt on the same key supersedes the first', async () => {
  const relay = makeRelay({ sweepMs: 10 });
  relay.markWatched('k');
  const first = relay.hold('k', 'question', { n: 1 });
  const second = relay.hold('k', 'question', { n: 2 });
  assert.deepEqual(await first, { relay: false, reason: 'superseded' });
  assert.equal(relay.getPending('k').payload.n, 2);
  relay.release('k');
  assert.equal((await second).relay, false);
});

test('V75: stop/notification kinds are never held', async () => {
  const relay = makeRelay();
  relay.markWatched('k');
  assert.deepEqual(await relay.hold('k', 'stop', {}), { relay: false, reason: 'not-held' });
  relay.setState('k', { lastMessage: 'done' });
  relay.setState('k', { notification: { notification_type: 'idle_prompt' } });
  assert.deepEqual(relay.getState('k'), { lastMessage: 'done', notification: { notification_type: 'idle_prompt' } });
  assert.equal(relay.getState('nope'), null);
});

test('V77: wheel ticks are SGR mouse sequences, negative = older, capped', () => {
  assert.deepEqual(wheelSequences(-3), ['\x1b[<64;10;10M', '\x1b[<64;10;10M', '\x1b[<64;10;10M']);
  assert.deepEqual(wheelSequences(2), ['\x1b[<65;10;10M', '\x1b[<65;10;10M']);
  assert.deepEqual(wheelSequences(0), []);
  assert.deepEqual(wheelSequences('x'), []);
  assert.equal(wheelSequences(1000).length, 200);
  assert.equal(wheelSequences(-1, { col: 3, row: 4 })[0], '\x1b[<64;3;4M');
});

test('V76: parseCapture trims trailing whitespace and trailing blank rows only', () => {
  assert.deepEqual(parseCapture('a  \n\nb\r\n   \n\n'), ['a', '', 'b']);
  assert.deepEqual(parseCapture(''), []);
});

test('buildAnswers: label per question, multi-select joined, unanswered omitted', () => {
  const qs = [{ question: 'A?' }, { question: 'B?' }, { question: 'C?' }];
  assert.deepEqual(buildAnswers(qs, { 'A?': 'x', 'B?': ['y', 'z'] }), { 'A?': 'x', 'B?': 'y, z' });
});
