const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeTitleStore, cleanTitle } = require('../lib/v2-titles');
const { digestTranscript, buildPrompt, parseReply, validTitle, USER_NAME_FLOOR } = require('../lib/session-title');
const { readSessionTitle, readTranscriptTitle, readTranscriptLastAt } = require('../lib/term-sessions');
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

test('V92: the registry parser keeps live sessions keyed by tmux session; the pane\'s own interactive cli process wins, not a nested run; statuses normalise', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2reg-'));
  const write = (pid, o) => fs.writeFileSync(path.join(dir, pid + '.json'), JSON.stringify({ pid, sessionId: U1, cwd: '/x', tmux: 'proj__s1:@1.%1', name: 'proj-1a', nameSource: 'derived', status: 'idle', kind: 'interactive', entrypoint: 'cli', startedAt: 100, updatedAt: 10, ...o }));
  // The pane's own claude: started first, currently running a shell command.
  write(11, { status: 'shell', startedAt: 100, updatedAt: 5, name: 'Real Name', nameSource: 'user', nameSince: 7 });
  // A `claude -p` the session's harness spawned seconds ago (B31): newer, busier, and NOT the tab.
  write(12, { sessionId: '22222222-2222-3333-4444-555555555555', status: 'busy', entrypoint: 'sdk-cli', startedAt: 900, updatedAt: 999 });
  write(13, { tmux: '', status: 'waiting' });                 // no tmux → not a hub tab
  write(14, { tmux: 'other__s2:@2.%2', status: 'waiting' });
  fs.writeFileSync(path.join(dir, '15.json'), 'not json');
  fs.writeFileSync(path.join(dir, '16.key'), 'x');
  const live = readLiveSessions({ dir, isAlive: (pid) => pid !== 14 });
  assert.deepEqual([...live.keys()], ['proj__s1'], 'dead pids and pane-less entries are dropped');
  const e = live.get('proj__s1');
  assert.equal(e.pid, 11, 'the pane\'s own interactive cli process wins over the nested sdk-cli run');
  assert.equal(e.sessionId, U1);
  assert.equal(e.status, 'idle', 'shell reads idle');
  assert.equal(e.name, 'Real Name');
  assert.equal(e.nameSource, 'user');
  assert.equal(e.nameSince, 7);
  // Two interactive cli claimants (a user ran `claude` inside the pane's shell): the earlier one is the tab.
  write(12, { entrypoint: 'cli', startedAt: 900, updatedAt: 999, status: 'busy' });
  assert.equal(readLiveSessions({ dir, isAlive: () => true }).get('proj__s1').pid, 11);
  // …unless the earlier one is gone (a resume started a fresh process).
  assert.equal(readLiveSessions({ dir, isAlive: (pid) => pid !== 11 }).get('proj__s1').pid, 12);
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
  assert.match(prompt, /reply with exactly the word KEEP/);
  assert.match(prompt, /USER: Please fix the upload path bug/);
  assert.match(prompt, /3 to 7 words/);
  assert.doesNotMatch(prompt, /subagent noise/);
  // Empty transcript → nothing to title.
  const empty = digestTranscript('');
  assert.deepEqual({ turns: empty.turns, title: empty.title, assistantTurns: empty.assistantTurns }, { turns: [], title: null, assistantTurns: 0 });
  // No current title → a title is asked for outright, no KEEP.
  assert.doesNotMatch(buildPrompt({ turns: d.turns, current: null }), /KEEP/);
  // A user-chosen name is presented as such.
  const p2 = buildPrompt({ turns: d.turns, current: 'my-own-name', userNamed: true });
  assert.match(p2, /typed by the USER[^\n]*: my-own-name/);
  assert.doesNotMatch(p2, /Current title: my-own-name/);
  // Replies: KEEP (any casing/punctuation) → null; otherwise the first line.
  assert.equal(parseReply('KEEP'), null);
  assert.equal(parseReply(' keep.\n'), null);
  assert.equal(parseReply('Fix Upload Path\nbecause…'), 'Fix Upload Path');
  assert.equal(parseReply('"Fix Upload Path"'), 'Fix Upload Path');
  assert.equal(parseReply(''), null);
  // The excerpt is fenced and declared quoted; the rule is repeated after it.
  assert.match(prompt, /<<<TRANSCRIPT[\s\S]*TRANSCRIPT>>>/);
  assert.match(prompt, /not instructions to you/);
  assert.match(prompt, /never the assistant's status, a question it asked, or a request for permission/);
});

test('B30: a reply that is a sentence, a refusal, a status line or a path is not a title', () => {
  for (const bad of [
    'I need permission to read the `/home/david/projects/llm-bench/logs/` directory to check the current run',
    "I'll check the bench status now.",
    'Sorry, I cannot access that directory',
    'Read ~/projects/llm-bench/logs/queue3.log',
    'The session is monitoring a benchmark run and it keeps going for a long time',
    'Monitoring Runs…',
    'Here is the title: Bench Watch',
  ]) assert.equal(validTitle(bad), false, bad);
  for (const good of ['Qwen 27B Context Experiment', 'Fix Upload Path', 'ring-battery-notif-tracker', 'V2 Tab Strip Polish']) assert.equal(validTitle(good), true, good);
  assert.equal(parseReply('I need permission to read the logs directory'), null);
});

test('V90: userTurnsSince counts human prompts after a rename; the floor is 4', () => {
  const t0 = Date.parse('2026-09-22T21:00:00Z');
  const lines = [];
  for (let i = 0; i < 6; i++) {
    lines.push({ type: 'user', timestamp: new Date(t0 + i * 60000).toISOString(), message: { role: 'user', content: 'prompt ' + i } });
    lines.push({ type: 'assistant', timestamp: new Date(t0 + i * 60000 + 30000).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'reply ' + i }] } });
  }
  const d = digestTranscript(lines.map((o) => JSON.stringify(o)).join('\n'));
  assert.equal(d.userTurnsSince(t0 + 2.5 * 60000), 3, 'prompts 3, 4, 5 come after the rename');
  assert.equal(d.userTurnsSince(0), 6);
  assert.equal(d.userTurnsSince(Date.now()), 0);
  assert.equal(USER_NAME_FLOOR, 4);
});

test('V90: the worker leaves a fresh /rename alone, asks KEEP-or-new otherwise, and posts nothing on KEEP', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'session-title-hook.mjs'), 'utf8');
  assert.match(src, /reg\.nameSource === 'user' && reg\.name && \(!current \|\| Number\(reg\.nameSince\) > Number\(current\.at\)\)/);
  assert.match(src, /digest\.userTurnsSince\(Number\(reg\.nameSince\)\) < USER_NAME_FLOOR\) return;/);
  assert.match(src, /const title = parseReply\(reply\);\n\s+if \(!title \|\| title === title0\) return;/);
  assert.match(src, /'--no-session-persistence', '--tools', ''\]/, 'the titler runs claude -p with no tools');
  const routes = fs.readFileSync(path.join(__dirname, '..', 'lib', 'v2-routes.js'), 'utf8');
  assert.match(routes, /'--no-session-persistence', '--tools', ''\]/, 'so does the editor completion');
});



test('B32: readTranscriptLastAt is the last record timestamp, not the file mtime', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'v2home-'));
  const dir = path.join(home, '.claude', 'projects', '-srv-projects-x');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, U1 + '.jsonl');
  assert.equal(readTranscriptLastAt('/srv/projects/x', U1, { homedir: home }), 0);
  fs.writeFileSync(f, [
    JSON.stringify({ type: 'user', timestamp: '2026-09-22T07:00:00.000Z', message: { role: 'user', content: 'x' } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-09-22T07:19:23.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'y' }] } }),
    JSON.stringify({ type: 'system' }),
  ].join('\n') + '\n');
  // Touch the file well after the last record: the answer must not move.
  fs.utimesSync(f, new Date(), new Date());
  assert.equal(readTranscriptLastAt('/srv/projects/x', U1, { homedir: home }), Date.parse('2026-09-22T07:19:23.000Z'));
  // A huge trailing line (a tool result) pushes the last timestamp past 64 KB: the 1 MB pass finds it.
  fs.appendFileSync(f, JSON.stringify({ type: 'user', timestamp: '2026-09-22T08:00:00.000Z', message: { role: 'user', content: 'z'.repeat(200 * 1024) } }) + '\n');
  assert.equal(readTranscriptLastAt('/srv/projects/x', U1, { homedir: home }), Date.parse('2026-09-22T08:00:00.000Z'));
});
