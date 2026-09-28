const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ATTACH = path.join(__dirname, '..', 'services', 'ttyd-attach-hub.sh');

// Stubs g2mirror (every call logged with its working folder; --detached
// prints a socket name) and pgrep (finds a running session only when
// `running`), and runs the hub attach script against a scratch state dir
// (V84, V102).
function run(id, { session = null, prompt = null, instructions = null, transcript = false, running = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-hub-'));
  const projectsRoot = path.join(root, 'projects');
  const home = path.join(root, 'home');
  const hub = path.join(root, 'hub');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(path.join(projectsRoot, 'proj/sub'), { recursive: true });
  fs.mkdirSync(path.join(hub, 'sessions'), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  if (session) fs.writeFileSync(path.join(hub, 'sessions', id + '.json'), JSON.stringify(session, null, 2));
  if (prompt) fs.writeFileSync(path.join(hub, 'sessions', id + '.prompt'), prompt);
  if (instructions !== null && session && session.profile) {
    fs.mkdirSync(path.join(hub, 'profiles', session.profile), { recursive: true });
    fs.writeFileSync(path.join(hub, 'profiles', session.profile, 'CLAUDE.md'), instructions);
  }
  if (transcript && session) {
    const dir = path.join(projectsRoot, session.cwd || '');
    const encoded = '-' + dir.replace(/^\//, '').replace(/\//g, '-');
    fs.mkdirSync(path.join(home, '.claude', 'projects', encoded), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'projects', encoded, session.uuid + '.jsonl'), '{}\n');
  }
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
      env: { PATH: bin + ':' + process.env.PATH, HOME: home, HUB_STATE_DIR: hub, PROJECTS_ROOT: projectsRoot, G2_LOG: g2log, CLAUDE_BIN: '/fake/claude', CODEX_BIN: '/fake/codex', G2MIRROR_BIN: path.join(bin, 'g2mirror') },
      stdio: ['ignore', 'ignore', errFd],
    });
  } catch (e) { status = e.status; } finally { fs.closeSync(errFd); }
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').replace(/\n+$/, '').split('\n') : []);
  const g2 = read(g2log).map((l) => { const [dir, args] = l.split('|'); return { dir, args }; });
  return { status, stderr: fs.readFileSync(errFile, 'utf8'), g2, pgrep: read(g2log + '.pgrep') };
}

const base = { id: 'abcd1234', cwd: 'proj/sub', agent: 'claude', uuid: '11111111-2222-3333-4444-555555555555', profile: null };
const ATTACH_ARGS = '-a HUB_TERM_KEY=hub-abcd1234  --force --watch';
const started = (r) => r.g2.find((c) => c.args.startsWith('--detached'));

test('V84/V102: first attach starts claude --session-id detached in the session folder with its key, later ones --resume', () => {
  const fresh = run('abcd1234', { session: base });
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.equal(fresh.g2.length, 2);
  assert.match(fresh.g2[0].dir, /\/projects\/proj\/sub$/);
  assert.equal(fresh.g2[0].args, '--detached --title hub-abcd1234 -- env HUB_TERM_KEY=hub-abcd1234 TERM=xterm-256color COLORTERM=truecolor /fake/claude --session-id 11111111-2222-3333-4444-555555555555 --chrome');
  assert.equal(fresh.g2[1].args, ATTACH_ARGS, 'then the tab attaches, taking over and watching when displaced');
  assert.match(fresh.pgrep[0], /-f \^\[\^ \]\*g2mirror --headless \.\* -- env HUB_TERM_KEY=hub-abcd1234 $/);
  const again = run('abcd1234', { session: base, transcript: true });
  assert.match(started(again).args, /--resume 11111111-2222-3333-4444-555555555555 --chrome$/);
});

test('V102: a session that is already running is only attached', () => {
  const r = run('abcd1234', { session: base, running: true });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.g2.map((c) => c.args), [ATTACH_ARGS]);
});

test('V84: a profile with instructions appends them to claude; an empty file does not', () => {
  const withProfile = { ...base, profile: 'science' };
  const r = run('abcd1234', { session: withProfile, instructions: 'You help a science teacher.' });
  assert.match(started(r).args, /--append-system-prompt-file \S+\/hub\/profiles\/science\/CLAUDE\.md$/);
  const empty = run('abcd1234', { session: withProfile, instructions: '' });
  assert.doesNotMatch(started(empty).args, /append-system-prompt/);
  const none = run('abcd1234', { session: withProfile });
  assert.doesNotMatch(started(none).args, /append-system-prompt/);
});

test('V84: codex and shell agents get their own commands, no claude flags', () => {
  const codex = run('abcd1234', { session: { ...base, agent: 'codex' } });
  assert.match(started(codex).args, / COLORTERM=truecolor \/fake\/codex$/);
  const shell = run('abcd1234', { session: { ...base, agent: 'shell', cwd: '' } });
  assert.match(started(shell).dir, /\/projects$/);
  assert.match(started(shell).args, / COLORTERM=truecolor bash -l$/);
});

test('V84: bad id, unknown session and missing folder all fail before touching g2mirror', () => {
  for (const [id, opts] of [['../etc', {}], ['ABCD1234', {}], ['zzzzzzzz', {}], ['abcd1234', { session: { ...base, cwd: 'missing' } }]]) {
    const r = run(id, opts);
    assert.notEqual(r.status, 0, id);
    assert.deepEqual(r.g2, [], id);
  }
});

test('V84/V102: a queued first prompt is typed through the session socket with a pause before Enter, not for shells', () => {
  // The sender sleeps 4 s in the background; assert on the script instead of
  // waiting for it.
  const src = fs.readFileSync(ATTACH, 'utf8');
  assert.match(src, /PROMPT_FILE=.*\.prompt/);
  assert.match(src, /"\$AGENT" != "shell"/);
  assert.match(src, /"\$\{G2MIRROR_DIR:-\$HOME\/\.g2mirror\}\/\$SOCKET" "\$PROMPT_FILE" && rm -f "\$PROMPT_FILE"/);
  assert.match(src, /delays: \[\{ at: text\.length, ms: 150 \}\]/);
});

test('V5: ttyd-hub.service preserves the shared runtime dir and passes --url-arg', () => {
  const unit = fs.readFileSync(path.join(__dirname, '..', 'services', 'ttyd-hub.service'), 'utf8');
  assert.match(unit, /RuntimeDirectoryPreserve=yes/);
  assert.match(unit, /ttyd -i \/run\/ttyd\/hub\.sock -W -a -b \/term\/hub /);
  assert.match(unit, /ttyd-attach-hub\.sh$/m);
});
