const test = require('node:test');
const assert = require('node:assert/strict');

const { makeHubTerms, ENTER_PAUSE_MS } = require('../lib/hub-terms');

// tmux holds `old__s1` (a session from before the switch); everything else
// is g2mirror's. Both backends are fakes that record what they were asked.
function fixture() {
  const tmuxCalls = [];
  const g2Calls = [];
  const execFileP = async (cmd, args) => {
    assert.equal(cmd, 'tmux');
    tmuxCalls.push(args);
    const target = args[args.indexOf('-t') + 1];
    if (args[0] === 'list-sessions') return { stdout: 'old__s1\t1700000000\n' };
    if (target && !target.startsWith('=old__s1')) throw new Error("can't find session");
    if (args[0] === 'capture-pane') return { stdout: 'tmux screen\n' };
    if (args[0] === 'display-message') return { stdout: '120 40\n' };
    return { stdout: '' };
  };
  const g2 = {
    list: async () => [{ name: 'hub-new00001', backend: 'g2mirror', activity: 5 }],
    capture: async (key) => { g2Calls.push(['capture', key]); return key === 'hub-new00001' ? { text: 'g2 screen', cols: 90, rows: 30 } : null; },
    input: async (key, data, opts) => { g2Calls.push(['input', key, data, opts]); return key === 'hub-new00001'; },
    kill: async (key) => { g2Calls.push(['kill', key]); return key === 'hub-new00001'; },
  };
  return { terms: makeHubTerms({ execFileP, g2 }), tmuxCalls, g2Calls };
}

test('list merges both backends, tagged', async () => {
  const { terms } = fixture();
  assert.deepEqual(await terms.list(), [
    { name: 'old__s1', activity: 1700000000000, backend: 'tmux' },
    { name: 'hub-new00001', backend: 'g2mirror', activity: 5 },
  ]);
});

test('a key tmux holds stays on tmux; any other goes to g2mirror', async () => {
  const { terms, tmuxCalls, g2Calls } = fixture();
  assert.deepEqual(await terms.capture('old__s1'), { text: 'tmux screen\n', cols: 120, rows: 40 });
  assert.deepEqual(await terms.capture('hub-new00001'), { text: 'g2 screen', cols: 90, rows: 30 });
  assert.equal(await terms.capture('hub-none0000'), null);

  assert.equal(await terms.type('old__s1', 'hi there', true), true);
  assert.deepEqual(tmuxCalls.filter((a) => a[0] === 'send-keys'), [
    ['send-keys', '-t', '=old__s1:', '-l', '--', 'hi there'],
    ['send-keys', '-t', '=old__s1:', 'Enter'],
  ]);
  assert.equal(await terms.kill('old__s1'), true);
  assert.deepEqual(tmuxCalls.at(-1), ['kill-session', '-t', '=old__s1']);
  assert.equal(g2Calls.filter((c) => c[1] === 'old__s1').length, 0);

  assert.equal(await terms.kill('hub-new00001'), true);
  assert.equal(await terms.kill('hub-none0000'), false);
  assert.equal(await terms.type('hub-none0000', 'x', true), false);
});

test('g2mirror input pauses before Enter (a submit, not a paste), at a byte offset', async () => {
  const { terms, g2Calls } = fixture();
  await terms.type('hub-new00001', 'héllo', true);
  await terms.type('hub-new00001', 'no enter', false);
  await terms.type('hub-new00001', '', true);
  await terms.sendRaw('hub-new00001', ['\x1b[<64;10;10M', '\x1b[<64;10;10M']);
  assert.deepEqual(g2Calls.filter((c) => c[0] === 'input').map((c) => c.slice(2)), [
    ['héllo\r', { delays: [{ at: 6, ms: ENTER_PAUSE_MS }] }],
    ['no enter', { delays: [] }],
    ['\r', { delays: [] }],
    ['\x1b[<64;10;10M\x1b[<64;10;10M', undefined],
  ]);
});
