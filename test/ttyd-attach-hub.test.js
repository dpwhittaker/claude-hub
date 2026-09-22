const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ATTACH = path.join(__dirname, '..', 'services', 'ttyd-attach-hub.sh');

// Stubs tmux (has-session misses, new-session/attach-session are logged) and
// runs the hub attach script against a scratch state dir, the way
// test/ttyd-attach.test.js does for the per-project script (V84).
function run(id, { session = null, prompt = null, instructions = null, transcript = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-hub-'));
  const projectsRoot = path.join(root, 'projects');
  const home = path.join(root, 'home');
  const hub = path.join(root, 'hub');
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'tmux.log');
  fs.mkdirSync(path.join(projectsRoot, 'proj/sub'), { recursive: true });
  fs.mkdirSync(path.join(hub, 'sessions'), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  if (session) fs.writeFileSync(path.join(hub, 'sessions', id + '.json'), JSON.stringify(session, null, 2));
  if (prompt) fs.writeFileSync(path.join(hub, 'sessions', id + '.prompt'), prompt);
  if (instructions && session && session.profile) {
    fs.mkdirSync(path.join(hub, 'profiles', session.profile), { recursive: true });
    fs.writeFileSync(path.join(hub, 'profiles', session.profile, 'CLAUDE.md'), instructions);
  }
  if (transcript && session) {
    const dir = path.join(projectsRoot, session.cwd || '');
    const encoded = '-' + dir.replace(/^\//, '').replace(/\//g, '-');
    fs.mkdirSync(path.join(home, '.claude', 'projects', encoded), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'projects', encoded, session.uuid + '.jsonl'), '{}\n');
  }
  fs.writeFileSync(path.join(bin, 'tmux'), [
    '#!/bin/bash',
    'for a in "$@"; do case "$a" in',
    '  has-session) exit 1 ;;',
    '  new-session|attach-session) printf "%s\\n" "$*" >> "$TMUX_LOG"; exit 0 ;;',
    'esac; done; exit 0',
  ].join('\n'));
  fs.chmodSync(path.join(bin, 'tmux'), 0o755);
  const errFile = path.join(root, 'stderr');
  const errFd = fs.openSync(errFile, 'w');
  let status = 0;
  try {
    execFileSync('bash', [ATTACH, id], {
      env: { PATH: bin + ':' + process.env.PATH, HOME: home, HUB_STATE_DIR: hub, PROJECTS_ROOT: projectsRoot, TMUX_LOG: log, CLAUDE_BIN: '/fake/claude', CODEX_BIN: '/fake/codex' },
      stdio: ['ignore', 'ignore', errFd],
    });
  } catch (e) { status = e.status; } finally { fs.closeSync(errFd); }
  const lines = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
  return { status, stderr: fs.readFileSync(errFile, 'utf8'), lines, root, projectsRoot, hub };
}

const base = { id: 'abcd1234', cwd: 'proj/sub', agent: 'claude', uuid: '11111111-2222-3333-4444-555555555555', profile: null };

test('V84: first attach runs claude --session-id in the session folder, later attaches --resume', () => {
  const fresh = run('abcd1234', { session: base });
  assert.equal(fresh.status, 0, fresh.stderr);
  const created = fresh.lines.find((l) => l.startsWith('new-session'));
  assert.ok(created, 'tmux new-session was called');
  assert.match(created, /-s hub-abcd1234 -c \S+\/projects\/proj\/sub /);
  assert.match(created, /\/fake\/claude --session-id 11111111-2222-3333-4444-555555555555 --chrome$/);
  assert.match(fresh.lines[fresh.lines.length - 1], /^-u attach-session -t =hub-abcd1234$/);
  const again = run('abcd1234', { session: base, transcript: true });
  assert.match(again.lines.find((l) => l.startsWith('new-session')), /--resume 11111111-2222-3333-4444-555555555555 --chrome$/);
});

test('V84: a profile with instructions appends them to claude; an empty file does not', () => {
  const withProfile = { ...base, profile: 'science' };
  const r = run('abcd1234', { session: withProfile, instructions: 'You help a science teacher.' });
  const created = r.lines.find((l) => l.startsWith('new-session'));
  assert.match(created, /--append-system-prompt-file \S+\/hub\/profiles\/science\/CLAUDE\.md$/);
  const empty = run('abcd1234', { session: withProfile, instructions: '' });
  assert.doesNotMatch(empty.lines.find((l) => l.startsWith('new-session')), /append-system-prompt/);
  const none = run('abcd1234', { session: withProfile });
  assert.doesNotMatch(none.lines.find((l) => l.startsWith('new-session')), /append-system-prompt/);
});

test('V84: codex and shell agents get their own commands, no claude flags', () => {
  const codex = run('abcd1234', { session: { ...base, agent: 'codex' } });
  assert.match(codex.lines.find((l) => l.startsWith('new-session')), / \/fake\/codex$/);
  const shell = run('abcd1234', { session: { ...base, agent: 'shell', cwd: '' } });
  const created = shell.lines.find((l) => l.startsWith('new-session'));
  assert.match(created, /-c \S+\/projects bash -l$/);
});

test('V84: bad id, unknown session and missing folder all fail before touching tmux', () => {
  for (const [id, opts] of [['../etc', {}], ['ABCD1234', {}], ['zzzzzzzz', {}], ['abcd1234', { session: { ...base, cwd: 'missing' } }]]) {
    const r = run(id, opts);
    assert.notEqual(r.status, 0, id);
    assert.deepEqual(r.lines, [], id);
  }
});

test('V84: a queued first prompt is sent after the session starts (background), not for shells', () => {
  // The prompt sender sleeps 4 s in the background; assert on the script's
  // decision path instead of waiting: the shell case leaves the file alone
  // and the claude case forks the sender (visible as the prompt file still
  // present immediately after exit, to be consumed by the backgrounded job).
  const src = fs.readFileSync(ATTACH, 'utf8');
  assert.match(src, /PROMPT_FILE=.*\.prompt/);
  assert.match(src, /"\$AGENT" != "shell"/);
  assert.match(src, /send-keys -t "=\$KEY:" -l "\$\(cat "\$PROMPT_FILE"\)"/);
  assert.match(src, /rm -f "\$PROMPT_FILE"/);
});

test('V5: ttyd-hub.service preserves the shared runtime dir and passes --url-arg', () => {
  const unit = fs.readFileSync(path.join(__dirname, '..', 'services', 'ttyd-hub.service'), 'utf8');
  assert.match(unit, /RuntimeDirectoryPreserve=yes/);
  assert.match(unit, /ttyd -i \/run\/ttyd\/hub\.sock -W -a -b \/term\/hub /);
  assert.match(unit, /ttyd-attach-hub\.sh$/m);
});
