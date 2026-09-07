const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ATTACH = path.join(__dirname, '..', 'services', 'ttyd-attach.sh');

// ttyd-attach.sh is the one place that turns a tab's map entry into a command
// line, and until now nothing exercised it (V4/V48/V69). These runs stub tmux
// so the script's `tmux new-session … "<cmd>"` is captured instead of run:
// the log line IS the assertion.
function runAttach(key, { sessions = null, home = {}, env = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-test-'));
  try {
    const projectsRoot = path.join(root, 'projects');
    const fakeHome = path.join(root, 'home');
    const bin = path.join(root, 'bin');
    const log = path.join(root, 'tmux.log');
    fs.mkdirSync(bin, { recursive: true });

    // The project the key points at. Split on the first `__` the way the
    // script does so a bad key still lands somewhere sane.
    const project = key.includes('__') ? key.slice(0, key.indexOf('__')) : key;
    const projectDir = path.join(projectsRoot, project);
    fs.mkdirSync(projectDir, { recursive: true });
    if (sessions) {
      fs.writeFileSync(
        path.join(projectDir, '.develop-sessions.json'),
        JSON.stringify(sessions, null, 2) + '\n',
      );
    }
    // `home.transcripts` = uuids that already have a claude jsonl on disk.
    const encoded = '-' + projectDir.replace(/^\//, '').replace(/\//g, '-');
    const claudeDir = path.join(fakeHome, '.claude', 'projects', encoded);
    fs.mkdirSync(claudeDir, { recursive: true });
    for (const uuid of home.transcripts || []) {
      fs.writeFileSync(path.join(claudeDir, uuid + '.jsonl'), '{}\n');
    }

    // Stub tmux: has-session always misses (so the script creates), every
    // other subcommand is a no-op, and the interesting ones are logged.
    fs.writeFileSync(path.join(bin, 'tmux'), [
      '#!/bin/bash',
      'for a in "$@"; do',
      '  case "$a" in',
      '    has-session) exit 1 ;;',
      '    new-session|attach-session) printf "%s\\n" "$*" >> "$TMUX_LOG"; exit 0 ;;',
      '  esac',
      'done',
      'exit 0',
    ].join('\n'));
    fs.chmodSync(path.join(bin, 'tmux'), 0o755);

    // stdio goes to files, not pipes: on a first launch the script leaves a
    // backgrounded `sleep 4` holding the bootstrap prompt, and a pipe would
    // keep execFileSync blocked on it for the full four seconds per run.
    const outFile = path.join(root, 'stdout');
    const errFile = path.join(root, 'stderr');
    const outFd = fs.openSync(outFile, 'w');
    const errFd = fs.openSync(errFile, 'w');
    let status = 0;
    try {
      execFileSync('bash', [ATTACH, key], {
        env: {
          PATH: bin + ':' + process.env.PATH,
          HOME: fakeHome,
          PROJECTS_ROOT: projectsRoot,
          TMUX_LOG: log,
          CLAUDE_BIN: '/fake/claude',
          CODEX_BIN: '/fake/codex',
          ...env,
        },
        stdio: ['ignore', outFd, errFd],
      });
    } catch (e) {
      status = e.status;
    } finally {
      fs.closeSync(outFd);
      fs.closeSync(errFd);
    }
    const stderr = fs.readFileSync(errFile, 'utf8');
    const lines = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
    return { status, stderr, lines, projectDir };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const newSession = (r) => r.lines.find((l) => l.startsWith('new-session')) || '';

test('V48: a claude tab with no transcript yet starts --session-id', () => {
  const r = runAttach('demo__s1', {
    sessions: { sessions: { s1: { uuid: 'uuid-a', agent: 'claude' } }, lastActive: 's1' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(newSession(r), /\/fake\/claude --session-id uuid-a --chrome/);
});

test('V48: a claude tab whose transcript exists resumes it', () => {
  const r = runAttach('demo__s1', {
    sessions: { sessions: { s1: { uuid: 'uuid-a', agent: 'claude' } }, lastActive: 's1' },
    home: { transcripts: ['uuid-a'] },
  });
  assert.match(newSession(r), /\/fake\/claude --resume uuid-a --chrome/);
});

test('V68: a pre-agent bare-string entry still resolves as a claude tab', () => {
  const r = runAttach('demo__s1', {
    sessions: { sessions: { s1: 'legacy-uuid' }, lastActive: 's1' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(newSession(r), /\/fake\/claude --session-id legacy-uuid --chrome/);
});

test('V69: a codex tab launches codex — no claude flags, no uuid', () => {
  const r = runAttach('demo__s2', {
    sessions: {
      sessions: {
        s1: { uuid: 'uuid-a', agent: 'claude' },
        s2: { uuid: 'uuid-b', agent: 'codex' },
      },
      lastActive: 's2',
    },
  });
  assert.equal(r.status, 0, r.stderr);
  const cmd = newSession(r);
  assert.match(cmd, /\/fake\/codex/);
  assert.doesNotMatch(cmd, /claude/);
  assert.doesNotMatch(cmd, /--session-id|--resume|uuid-b/);
});

test('V69: the tab id picks its own block — s1 next to s2 never crosses over', () => {
  // Both probes run against one isolated `"sN": { … }` block, so a codex s2
  // sitting above a claude s1 cannot leak its agent into s1's command.
  const sessions = {
    sessions: {
      s2: { uuid: 'uuid-b', agent: 'codex' },
      s1: { uuid: 'uuid-a', agent: 'claude' },
    },
    lastActive: 's1',
  };
  assert.match(newSession(runAttach('demo__s1', { sessions })), /\/fake\/claude --session-id uuid-a/);
  assert.match(newSession(runAttach('demo__s2', { sessions })), /\/fake\/codex/);
});

test('V69: s1 and s10 are distinct blocks, not a prefix match', () => {
  const sessions = {
    sessions: {
      s1: { uuid: 'uuid-one', agent: 'claude' },
      s10: { uuid: 'uuid-ten', agent: 'codex' },
    },
    lastActive: 's1',
  };
  assert.match(newSession(runAttach('demo__s1', { sessions })), /--session-id uuid-one/);
  assert.match(newSession(runAttach('demo__s10', { sessions })), /\/fake\/codex/);
});

test('V48: a tab id absent from the map fails loudly instead of starting a shell', () => {
  const r = runAttach('demo__s3', {
    sessions: { sessions: { s1: { uuid: 'uuid-a', agent: 'claude' } }, lastActive: 's1' },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no session uuid for tab s3/);
  assert.deepEqual(r.lines, [], 'nothing was started');
});

test('V4: a legacy bare key with no prior session gets plain claude (exit-loop guard)', () => {
  const r = runAttach('demo');
  assert.equal(r.status, 0, r.stderr);
  const cmd = newSession(r);
  assert.match(cmd, /\/fake\/claude/);
  assert.doesNotMatch(cmd, /--continue/);
});

test('V4: a legacy bare key with a prior session gets --continue', () => {
  const r = runAttach('demo', { home: { transcripts: ['whatever'] } });
  assert.match(newSession(r), /\/fake\/claude --continue --chrome/);
});

test('V48: an unknown project exits before touching tmux', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-test-'));
  try {
    const errFile = path.join(root, 'stderr');
    const errFd = fs.openSync(errFile, 'w');
    let status = 0;
    try {
      execFileSync('bash', [ATTACH, 'nope__s1'], {
        env: { PATH: process.env.PATH, HOME: root, PROJECTS_ROOT: path.join(root, 'projects') },
        stdio: ['ignore', 'ignore', errFd],
      });
    } catch (e) {
      status = e.status;
    } finally {
      fs.closeSync(errFd);
    }
    const stderr = fs.readFileSync(errFile, 'utf8');
    assert.equal(status, 1);
    assert.match(stderr, /project dir not found/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
