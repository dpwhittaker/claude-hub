const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// The glasses app is ESM (glasses/package.json sets type: module); its pure
// helpers are tested here through a dynamic import (V100).
const mod = () => import(pathToFileURL(path.join(__dirname, '..', 'glasses', 'claude-hub', 'text.js')).href);

test('V100: cleanTerminal drops Claude Code chrome, collapses rules and blank runs', async () => {
  const { cleanTerminal } = await mod();
  const lines = [
    'hello', '', '', '──────────────', '════════', 'world   ',
    '  Fable 5.1 | sess 7% (3h left) | week 16% | ctx 61%', '⏵⏵ auto mode on (shift+tab to cycle)', '❯ ', '? for shortcuts', '', '────',
  ];
  assert.deepEqual(cleanTerminal(lines), ['hello', '', '────', 'world']);
  assert.deepEqual(cleanTerminal([]), []);
});

test('V100: tailBytes keeps the newest lines within the byte budget; listPage leaves room for the more row', async () => {
  const { tailBytes, listPage, LIST_MAX } = await mod();
  const lines = Array.from({ length: 100 }, (_, i) => 'line ' + i + ' ' + 'x'.repeat(40));
  const tail = tailBytes(lines, 500);
  assert.equal(tail[tail.length - 1], lines[99]);
  assert.ok(tail.length < 100 && tail.length >= 9);
  assert.ok(Buffer.byteLength(tail.join('\n')) <= 500);
  const items = Array.from({ length: 45 }, (_, i) => i);
  const p0 = listPage(items, 0);
  assert.equal(p0.slice.length, LIST_MAX - 1);
  assert.equal(p0.hasMore, true);
  assert.equal(p0.left, 45 - (LIST_MAX - 1));
  const p2 = listPage(items, 2);
  assert.equal(p2.hasMore, false);
});

test('V100: sessionLabel shows state, title and folder; labels fit the firmware limits', async () => {
  const { sessionLabel, label, truncate, summarizeInput, ITEM_MAX } = await mod();
  assert.equal(sessionLabel({ running: true, activity: 'busy', title: 'Fix the bar', cwd: 'claude-hub' }), '● Fix the bar · /claude-hub');
  assert.equal(sessionLabel({ running: true, activity: 'waiting', title: null, cwd: 'a/b' }), '◐ b · /a/b');
  assert.equal(sessionLabel({ running: false, title: 'Old', cwd: '' }), '· Old · /');
  assert.ok(label('▶', 'x'.repeat(100)).length <= ITEM_MAX);
  assert.equal(truncate('abc', 5), 'abc');
  assert.equal(truncate('abcdefgh', 5), 'abcd…');
  assert.equal(summarizeInput({ command: 'ls -la' }), 'ls -la');
  assert.equal(summarizeInput({ foo: 1 }), '{"foo":1}');
});
