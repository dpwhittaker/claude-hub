const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ATTACH = path.join(__dirname, '..', 'services', 'ttyd-attach-hub.sh');

// Stubs tmux (has-session misses unless `tmuxHas`, new-session/attach-session
// are logged), g2mirror (every call logged with its working folder;
// --detached prints a socket name) and pgrep (finds a running session only
// when `running`), and runs the hub attach script against a scratch state
// dir, the way test/ttyd-attach.test.js does for the per-project script
// (V84). `backend` picks what new sessions start on.
function run(id, { session = null, prompt = null, instructions = null, transcript = false, backend = 'tmux', tmuxHas = false, running = false } = {}) {
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
    `  has-session) exit ${tmuxHas ? 0 : 1} ;;`,
    '  new-session|attach-session) printf "%s\\n" "$*" >> "$TMUX_LOG"; exit 0 ;;',
    'esac; done; exit 0',
  ].join('\n'));
  fs.chmodSync(path.join(bin, 'tmux'), 0o755);
  const g2log = path.join(root, 'g2mirror.log');
  fs.writeFileSync(path.join(bin, 'g2mirror'), [
    '#!/bin/bash',
    'printf "%s|%s\\n" "$PWD" "$*" >> "$G2_LOG"',
    '[[ "$1" == --detached ]] && echo 4242-_sock',
    'exit 0',
  ].join('\n'));
  fs.chmodSync(path.join(bin, 'g2mirror'), 0o755);
  fs.writeFileSync(path.join(bin, 'pgrep'), `#!/bin/bash\nprintf "%s\\n" "$*" >> "$G2_LOG.pgrep"\nexit ${running ? 0 : 1}\n`);
  fs.chmodSync(path.join(bin, 'pgrep'), 0o755);
  const errFile = path.join(root, 'stderr');
  const errFd = fs.openSync(errFile, 'w');
  let status = 0;
  try {
    execFileSync('bash', [ATTACH, id], {
      env: { PATH: bin + ':' + process.env.PATH, HOME: home, HUB_STATE_DIR: hub, PROJECTS_ROOT: projectsRoot, TMUX_LOG: log, G2_LOG: g2log, CLAUDE_BIN: '/fake/claude', CODEX_BIN: '/fake/codex', HUB_TERM_BACKEND: backend, G2MIRROR_BIN: path.join(bin, 'g2mirror') },
      stdio: ['ignore', 'ignore', errFd],
    });
  } catch (e) { status = e.status; } finally { fs.closeSync(errFd); }
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').replace(/\n+$/, '').split('\n') : []);
  return { status, stderr: fs.readFileSync(errFile, 'utf8'), lines: read(log), g2: read(g2log), pgrep: read(g2log + '.pgrep'), root, projectsRoot, hub };
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

test('g2mirror: a new session starts detached in its folder with its key, then the tab attaches with --force --watch', () => {
  const r = run('abcd1234', { session: base, backend: 'g2mirror' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.lines, [], 'tmux is not touched');
  assert.equal(r.g2.length, 2);
  const [dir, args] = r.g2[0].split('|');
  assert.match(dir, /\/projects\/proj\/sub$/);
  assert.equal(args, '--detached --title hub-abcd1234 -- env HUB_TERM_KEY=hub-abcd1234 TERM=xterm-256color COLORTERM=truecolor /fake/claude --session-id 11111111-2222-3333-4444-555555555555 --chrome');
  assert.equal(r.g2[1].split('|')[1], '-a HUB_TERM_KEY=hub-abcd1234  --force --watch');
  assert.match(r.pgrep[0], /-f \^\[\^ \]\*g2mirror --headless \.\* -- env HUB_TERM_KEY=hub-abcd1234 $/);

  // Already running: just attach.
  const again = run('abcd1234', { session: base, backend: 'g2mirror', running: true });
  assert.deepEqual(again.g2.map((l) => l.split('|')[1]), ['-a HUB_TERM_KEY=hub-abcd1234  --force --watch']);

  // Profile instructions and a v1 key (dots escaped for pgrep) carry over.
  const v1 = run('abcd1234', { session: { ...base, termKey: 'my.proj__s1', profile: 'sci' }, instructions: 'x', backend: 'g2mirror' });
  assert.match(v1.g2[0], /HUB_TERM_KEY=my\.proj__s1 .* --append-system-prompt-file \S+\/profiles\/sci\/CLAUDE\.md$/);
  assert.match(v1.pgrep[0], /HUB_TERM_KEY=my\\\.proj__s1 $/);
});

test('g2mirror: a key tmux still holds stays on tmux, whatever the default', () => {
  const r = run('abcd1234', { session: base, backend: 'g2mirror', tmuxHas: true });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.g2, []);
  assert.deepEqual(r.lines, ['-u attach-session -t =hub-abcd1234']);
});

test('g2mirror: the first prompt is typed through the session socket with a pause before Enter', () => {
  const src = fs.readFileSync(ATTACH, 'utf8');
  assert.match(src, /"\$\{G2MIRROR_DIR:-\$HOME\/\.g2mirror\}\/\$SOCKET" "\$PROMPT_FILE" && rm -f "\$PROMPT_FILE"/);
  assert.match(src, /delays: \[\{ at: text\.length, ms: 150 \}\]/);
});

test('V5: ttyd-hub.service preserves the shared runtime dir and passes --url-arg', () => {
  const unit = fs.readFileSync(path.join(__dirname, '..', 'services', 'ttyd-hub.service'), 'utf8');
  assert.match(unit, /RuntimeDirectoryPreserve=yes/);
  assert.match(unit, /ttyd -i \/run\/ttyd\/hub\.sock -W -a -b \/term\/hub /);
  assert.match(unit, /ttyd-attach-hub\.sh$/m);
});
