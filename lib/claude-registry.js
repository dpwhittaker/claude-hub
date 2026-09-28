// Claude Code's live-session registry (SPEC §V90, §V92).
//
// Every running `claude` writes ~/.claude/sessions/<pid>.json and keeps it
// current: the session id it is ACTUALLY on (a `--resume` or `/clear` mints
// a new one, so the uuid a hub tab was launched with goes stale), the tmux
// pane it lives in (if any), its name with where the name came from (`user` =
// /rename, `auto` = Claude's own title, `derived` = the folder-hash
// placeholder) and when it was set, and a status: busy | idle | waiting |
// shell. Reading that beats every hook for anything about a live session.
//
// Pure apart from the directory read and the /proc lookup; `isAlive` and
// `envKey` are injectable for tests.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STATUS = { busy: 'busy', waiting: 'waiting', idle: 'idle', shell: 'idle' };

function parseEntry(raw) {
  let o;
  try { o = JSON.parse(raw); } catch { return null; }
  if (!o || typeof o !== 'object' || !Number.isInteger(o.pid) || typeof o.sessionId !== 'string') return null;
  const tmux = typeof o.tmux === 'string' ? o.tmux : '';
  return {
    pid: o.pid,
    sessionId: o.sessionId,
    cwd: typeof o.cwd === 'string' ? o.cwd : '',
    tmuxKey: tmux ? tmux.split(':')[0] : null,
    name: typeof o.name === 'string' ? o.name : '',
    nameSource: ['user', 'auto', 'derived'].includes(o.nameSource) ? o.nameSource : 'derived',
    nameSince: Number(o.nameSince) || 0,
    status: STATUS[o.status] || null,
    statusUpdatedAt: Number(o.statusUpdatedAt) || 0,
    updatedAt: Number(o.updatedAt) || Number(o.startedAt) || 0,
    startedAt: Number(o.startedAt) || 0,
    kind: typeof o.kind === 'string' ? o.kind : '',
    entrypoint: typeof o.entrypoint === 'string' ? o.entrypoint : '',
  };
}

// The pane's OWN claude: interactive and launched from the command line,
// and of those the one that started first. A `claude -p` or SDK run
// spawned from inside the session inherits $TMUX and registers against the
// same pane (entrypoint `sdk-cli`), and a session's own resume starts a new
// process only after the old one is gone — so "earliest interactive cli"
// is the tab, and "most recently updated" is not (B31).
function rank(e) {
  return (e.kind === 'interactive' ? 0 : 2) + (e.entrypoint === 'cli' ? 0 : 1);
}
function better(a, b) {
  const ra = rank(a); const rb = rank(b);
  if (ra !== rb) return ra < rb;
  return (a.startedAt || a.updatedAt) < (b.startedAt || b.updatedAt);
}

function defaultIsAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}

// A g2mirror hub terminal has no tmux field to go by; its key is in the
// agent's environment instead (services/ttyd-attach-hub.sh sets it).
function defaultEnvKey(pid) {
  let env;
  try { env = fs.readFileSync(`/proc/${pid}/environ`, 'latin1'); } catch { return null; }
  const m = /(?:^|\0)HUB_TERM_KEY=([A-Za-z0-9][A-Za-z0-9._-]{0,127})(?:\0|$)/.exec(env);
  return m ? m[1] : null;
}

// → Map<terminal key, entry> of live sessions (the tmux session name, else
// the process's HUB_TERM_KEY); when two processes claim one terminal its own
// interactive cli process wins (see `better`).
function readLiveSessions({ dir = process.env.HUB_CLAUDE_SESSIONS_DIR || path.join(os.homedir(), '.claude', 'sessions'), isAlive = defaultIsAlive, envKey = defaultEnvKey } = {}) {
  const byKey = new Map();
  let names;
  try { names = fs.readdirSync(dir); } catch { return byKey; }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    let raw;
    try { raw = fs.readFileSync(path.join(dir, n), 'utf8'); } catch { continue; }
    const e = parseEntry(raw);
    if (!e || !isAlive(e.pid)) continue;
    const key = e.tmuxKey || envKey(e.pid);
    if (!key) continue;
    const prev = byKey.get(key);
    if (!prev || better(e, prev)) byKey.set(key, e);
  }
  return byKey;
}

module.exports = { readLiveSessions, parseEntry, STATUS };
