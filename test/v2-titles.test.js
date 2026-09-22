const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeTitleStore, cleanTitle } = require('../lib/v2-titles');
const { digestTranscript, buildPrompt } = require('../lib/session-title');
const { readSessionTitle, readTranscriptTitle } = require('../lib/term-sessions');
const { readLiveSessions, parseEntry } = require('../lib/claude-registry');

const U1 = '11111111-2222-3333-4444-555555555555';

test('V90: cleanTitle takes the first line, strips quotes/periods, caps length', () => {
  assert.equal(cleanTitle('"Refactor The Layout Engine."\nbecause…'), 'Refactor The Layout Engine');
  assert.equal(cleanTitle('Title: Fix Upload Path'), 'Fix Upload Path');
  assert.equal(cleanTitle('   '), '');
  assert.ok(cleanTitle('word '.repeat(40)).length <= 80);
});

test('V90: title store set/get/remove/lookup, keyed by lower-cased uuid, bad input refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2titles-'));
  const t = makeTitleStore({ dir });
  assert.equal(t.get(U1), null);
  const r = t.set(U1.toUpperCase(), ' Hub V2 Tab Strip ', 'auto');
  assert.equal(r.uuid, U1);
  assert.equal(r.title, 'Hub V2 Tab Strip');
  assert.equal(r.source, 'auto');
  assert.equal(t.get(U1).title, 'Hub V2 Tab Strip');
  assert.equal(t.lookup()(U1.toUpperCase()), 'Hub V2 Tab Strip');
  assert.equal(t.lookup()('22222222-2222-3333-4444-555555555555'), null);
  assert.throws(() => t.set('nope', 'x'), (e) => e.statusCode === 400);
  assert.throws(() => t.set(U1, '   '), (e) => e.statusCode === 400);
  assert.deepEqual(t.remove(U1), { uuid: U1, deleted: true });
  assert.equal(t.get(U1), null);
  assert.ok(fs.existsSync(path.join(dir, 'titles.json')));
});

test('V90: readTranscriptTitle — custom-title.json first, then a custom-title record over any ai-title (Claude re-appends ai-title every turn)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'v2home-'));
  const projectDir = '/srv/projects/x';
  const dir = path.join(home, '.claude', 'projects', '-srv-projects-x');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, U1 + '.jsonl');
  assert.equal(readTranscriptTitle(projectDir, U1, { homedir: home }), null);
  fs.writeFileSync(f, JSON.stringify({ type: 'ai-title', aiTitle: 'First Naming' }) + '\n');
  assert.deepEqual(readTranscriptTitle(projectDir, U1, { homedir: home }), { title: 'First Naming', source: 'ai', at: 0 });
  fs.appendFileSync(f, JSON.stringify({ type: 'custom-title', customTitle: 'my-rename' }) + '\n' + JSON.stringify({ type: 'ai-title', aiTitle: 'First Naming' }) + '\n');
  assert.equal(readSessionTitle(projectDir, U1, { homedir: home }), 'my-rename', 'a rename is not buried by the re-appended ai-title');
  fs.mkdirSync(path.join(dir, U1));
  fs.writeFileSync(path.join(dir, U1, 'custom-title.json'), JSON.stringify({ customTitle: 'renamed-again' }));
  const t = readTranscriptTitle(projectDir, U1, { homedir: home });
  assert.equal(t.title, 'renamed-again');
  assert.equal(t.source, 'custom');
  assert.ok(t.at > 0, 'the json file carries a time (its mtime)');
});

test('V92: the registry parser keeps live interactive sessions keyed by tmux session; newest wins a pane; statuses normalise', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2reg-'));
  const write = (pid, o) => fs.writeFileSync(path.join(dir, pid + '.json'), JSON.stringify({ pid, sessionId: U1, cwd: '/x', tmux: 'proj__s1:@1.%1', name: 'proj-1a', nameSource: 'derived', status: 'idle', updatedAt: 10, ...o }));
  write(11, { status: 'shell', updatedAt: 5 });
  write(12, { sessionId: '22222222-2222-3333-4444-555555555555', status: 'busy', name: 'Real Name', nameSource: 'user', nameSince: 7, updatedAt: 20 });
  write(13, { tmux: '', status: 'waiting' });                 // no tmux → not a hub tab
  write(14, { tmux: 'other__s2:@2.%2', status: 'waiting' });
  fs.writeFileSync(path.join(dir, '15.json'), 'not json');
  fs.writeFileSync(path.join(dir, '16.key'), 'x');
  const live = readLiveSessions({ dir, isAlive: (pid) => pid !== 14 });
  assert.deepEqual([...live.keys()], ['proj__s1'], 'dead pids and pane-less entries are dropped');
  const e = live.get('proj__s1');
  assert.equal(e.pid, 12, 'the most recently updated claimant of the pane wins');
  assert.equal(e.sessionId, '22222222-2222-3333-4444-555555555555');
  assert.equal(e.status, 'busy');
  assert.equal(e.name, 'Real Name');
  assert.equal(e.nameSource, 'user');
  assert.equal(e.nameSince, 7);
  assert.equal(parseEntry(JSON.stringify({ pid: 1, sessionId: 'a', status: 'shell', nameSource: 'weird' })).status, 'idle');
  assert.equal(parseEntry(JSON.stringify({ pid: 1, sessionId: 'a', nameSource: 'weird' })).nameSource, 'derived');
  assert.equal(parseEntry('{}'), null);
  assert.deepEqual([...readLiveSessions({ dir: path.join(dir, 'missing') }).keys()], []);
});

test('V90: the hook is inert for its own worker and the installer merges by command', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'session-title-hook.mjs'), 'utf8');
  assert.match(src, /process\.env\.HUB_TITLE_WORKER === '1'\) quit\(\)/, 'worker recursion guard');
  assert.match(src, /detached: true, stdio: 'ignore'/, 'the hook never waits on the model');
  assert.match(src, /stop_hook_active\) quit\(\)/);
  assert.match(src, /--no-session-persistence/);
  const inst = fs.readFileSync(path.join(__dirname, '..', 'services', 'install-session-hooks.mjs'), 'utf8');
  assert.match(inst, /timeout: 5/);
  assert.match(inst, /const kept = list\.filter\(\(e\) => !ours\(e\)\)/);
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'services', 'session-activity-hook.mjs')), 'the activity hook is retired (the registry has status)');
});


test('V90: digestTranscript keeps human/assistant text only, skips sidechains, tool blocks and command echoes, and finds the latest title', () => {
  const lines = [
    { type: 'ai-title', aiTitle: 'Old Title' },
    { type: 'user', message: { role: 'user', content: '<local-command-stdout></local-command-stdout>' } },
    { type: 'user', message: { role: 'user', content: 'Please fix the upload path bug' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Fixed: the path was doubled.' }] } },
    { type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'subagent noise' }] } },
    { type: 'custom-title', customTitle: 'upload-fix' },
    { type: 'user', message: { role: 'user', content: 'x'.repeat(2000) } },
  ].map((o) => JSON.stringify(o)).join('\n');
  const d = digestTranscript(lines + '\nnot json\n');
  assert.equal(d.title, 'upload-fix');
  assert.equal(d.assistantTurns, 1);
  assert.deepEqual(d.turns.map((t) => t.role), ['user', 'assistant', 'user']);
  assert.equal(d.turns[1].text, 'Fixed: the path was doubled.');
  assert.ok(d.turns[2].text.length <= 601, 'long turns are truncated');
  const prompt = buildPrompt({ turns: d.turns, current: d.title, cwd: 'claude-hub' });
  assert.match(prompt, /Current title: upload-fix/);
  assert.match(prompt, /USER: Please fix the upload path bug/);
  assert.match(prompt, /3 to 7 words/);
  assert.doesNotMatch(prompt, /subagent noise/);
  // Empty transcript → nothing to title.
  assert.deepEqual(digestTranscript(''), { turns: [], title: null, assistantTurns: 0 });
  // A user-chosen name is presented as such, to be kept verbatim.
  const p2 = buildPrompt({ turns: d.turns, current: 'my-own-name', userNamed: true });
  assert.match(p2, /chosen by the USER, keep it VERBATIM[^\n]*: my-own-name/);
  assert.doesNotMatch(p2, /Current title: my-own-name/);
});

test('V90: the worker treats a /rename newer than the last auto title as user-named', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'session-title-hook.mjs'), 'utf8');
  assert.match(src, /reg\.nameSource === 'user' && reg\.name && \(!current \|\| Number\(reg\.nameSince\) > Number\(current\.at\)\)/);
  assert.match(src, /buildPrompt\(\{ turns: digest\.turns, current: title0, cwd, userNamed \}\)/);
});


