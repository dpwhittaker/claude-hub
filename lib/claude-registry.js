// Claude Code's live-session registry (SPEC §V90, §V92).
//
// Every running `claude` writes ~/.claude/sessions/<pid>.json and keeps it
// current: the session id it is ACTUALLY on (a `--resume` or `/clear` mints
// a new one, so the uuid a hub tab was launched with goes stale), the tmux
// pane it lives in, its name with where the name came from (`user` =
// /rename, `auto` = Claude's own title, `derived` = the folder-hash
// placeholder) and when it was set, and a status: busy | idle | waiting |
// shell. Reading that beats every hook for anything about a live session.
//
// Pure apart from the directory read; `isAlive` is injectable for tests.
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
  };
}

function defaultIsAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}

// → Map<tmuxKey, entry> of live interactive sessions; when two processes
// claim one pane (a nested claude, a not-yet-reaped old one) the most
// recently updated wins.
function readLiveSessions({ dir = process.env.HUB_CLAUDE_SESSIONS_DIR || path.join(os.homedir(), '.claude', 'sessions'), isAlive = defaultIsAlive } = {}) {
  const byKey = new Map();
  let names;
  try { names = fs.readdirSync(dir); } catch { return byKey; }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    let raw;
    try { raw = fs.readFileSync(path.join(dir, n), 'utf8'); } catch { continue; }
    const e = parseEntry(raw);
    if (!e || !e.tmuxKey || !isAlive(e.pid)) continue;
    const prev = byKey.get(e.tmuxKey);
    if (!prev || e.updatedAt > prev.updatedAt) byKey.set(e.tmuxKey, e);
  }
  return byKey;
}

module.exports = { readLiveSessions, parseEntry, STATUS };
