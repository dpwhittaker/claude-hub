const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeTitleStore, cleanTitle } = require('../lib/v2-titles');
const { digestTranscript, buildPrompt } = require('../lib/session-title');
const { readSessionTitle } = require('../lib/term-sessions');

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
  const inst = fs.readFileSync(path.join(__dirname, '..', 'services', 'install-title-hook.mjs'), 'utf8');
  assert.match(inst, /timeout: 5/);
  assert.match(inst, /settings\.hooks\.Stop = remove \? kept : \[\.\.\.kept, ENTRY\]/);
});
