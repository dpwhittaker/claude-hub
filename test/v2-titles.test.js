const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeTitleStore, cleanTitle } = require('../lib/v2-titles');
const { digestTranscript, buildPrompt } = require('../lib/session-title');
const { readSessionTitle } = require('../lib/term-sessions');
const { makeActivity } = require('../lib/v2-activity');

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

test('V90: readSessionTitle returns whichever of ai-title / custom-title was appended last', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'v2home-'));
  const projectDir = '/srv/projects/x';
  const dir = path.join(home, '.claude', 'projects', '-srv-projects-x');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, U1 + '.jsonl');
  fs.writeFileSync(f, JSON.stringify({ type: 'ai-title', aiTitle: 'First Naming' }) + '\n');
  assert.equal(readSessionTitle(projectDir, U1, { homedir: home }), 'First Naming');
  fs.appendFileSync(f, JSON.stringify({ type: 'custom-title', customTitle: 'my-rename' }) + '\n' + JSON.stringify({ type: 'assistant', message: { content: [] } }) + '\n');
  assert.equal(readSessionTitle(projectDir, U1, { homedir: home }), 'my-rename', '/rename wins when it is newer');
  fs.appendFileSync(f, JSON.stringify({ type: 'ai-title', aiTitle: 'Newer AI Title' }) + '\n');
  assert.equal(readSessionTitle(projectDir, U1, { homedir: home }), 'Newer AI Title');
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
});

test('V90: the hook is inert for its own worker and its installer merges by command', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'session-title-hook.mjs'), 'utf8');
  assert.match(src, /process\.env\.HUB_TITLE_WORKER === '1'\) quit\(\)/, 'worker recursion guard');
  assert.match(src, /detached: true, stdio: 'ignore'/, 'the hook never waits on the model');
  assert.match(src, /stop_hook_active\) quit\(\)/);
  assert.match(src, /--no-session-persistence/);
  const inst = fs.readFileSync(path.join(__dirname, '..', 'services', 'install-session-hooks.mjs'), 'utf8');
  assert.match(inst, /timeout: 5/);
  assert.match(inst, /settings\.hooks\[event\] = remove \? kept : \[\.\.\.kept, \.\.\.entries\]/);
});

test('V92: activity store — states, stale busy reads idle, bad input refused', () => {
  let t = 1000;
  const a = makeActivity({ now: () => t, staleMs: 500 });
  assert.equal(a.get(U1), null);
  assert.deepEqual(a.set(U1, 'busy'), { uuid: U1, state: 'busy', at: 1000 });
  assert.equal(a.get(U1.toUpperCase()).state, 'busy');
  t = 1400;
  assert.equal(a.get(U1).state, 'busy');
  t = 1600;
  assert.equal(a.get(U1).state, 'idle', 'a busy that never saw its Stop expires');
  assert.equal(a.get(U1).stale, true);
  a.set(U1, 'idle'); t = 99999;
  assert.equal(a.get(U1).state, 'idle', 'idle never goes stale');
  assert.throws(() => a.set(U1, 'sleeping'), (e) => e.statusCode === 400);
  assert.throws(() => a.set('nope', 'busy'), (e) => e.statusCode === 400);
});

test('V92: the activity hook maps events to states and the installer covers both hooks', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'session-activity-hook.mjs'), 'utf8');
  assert.match(src, /'UserPromptSubmit' \|\| ev === 'PostToolUse'\) state = 'busy'/);
  assert.match(src, /ev === 'Stop' && !data\.stop_hook_active\) state = 'idle'/);
  assert.match(src, /permission_prompt'\) state = 'waiting'/);
  assert.match(src, /HUB_TITLE_WORKER === '1'\) quit\(\)/);
  const inst = fs.readFileSync(path.join(__dirname, '..', 'services', 'install-session-hooks.mjs'), 'utf8');
  for (const ev of ['Stop', 'UserPromptSubmit', 'PostToolUse', 'PreToolUse', 'Notification']) assert.match(inst, new RegExp('^\\s+' + ev + ':', 'm'), ev);
  assert.match(inst, /OURS = new Set\(\[TITLE, ACTIVITY\]\)/);
});
