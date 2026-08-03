// Per-project develop-pane tab map. Each tab maps to a tmux session named
// `<project>__<tabId>` and a claude conversation identified by uuid. Persisted
// at `<project>/.develop-sessions.json`:
//
//   { "sessions": { "s1": "<uuid>", "s2": "<uuid>" }, "lastActive": "s1" }
//
// The map is the single source of truth for the develop UI. `lastActive` is
// read by new browser connections to pick which tab to focus, but is never
// pushed to already-connected clients — switching tabs on one device must not
// yank another device.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SESSIONS_FILE = '.develop-sessions.json';
const TAB_ID_RE = /^s[1-9][0-9]*$/;
const TERM_KEY_SEP = '__';

// Encode a project directory the way claude stores its sessions on disk:
// leading dash, then the abs path with '/' replaced by '-'. e.g.
// /home/david/projects/claude-hub → -home-david-projects-claude-hub.
function encodeClaudeProjectDir(projectDir) {
  return '-' + projectDir.replace(/^\//, '').replace(/\//g, '-');
}

// Stream the most recent `ai-title` field out of <encoded>/<uuid>.jsonl.
// Claude writes one ai-title record per assistant turn (latest wins). We
// read the file in 64 KB chunks from the END backwards so a multi-megabyte
// session doesn't cost a full scan; the title is usually in the last few
// hundred KB. Returns null if no title is found or the file is missing.
function readSessionTitle(projectDir, uuid, opts) {
  const homedir = (opts && opts.homedir) || os.homedir();
  const sessionsDir = path.join(homedir, '.claude', 'projects', encodeClaudeProjectDir(projectDir));
  const file = path.join(sessionsDir, uuid + '.jsonl');
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const stat = fs.fstatSync(fd);
    const CHUNK = 64 * 1024;
    let pos = stat.size;
    let buffer = '';
    while (pos > 0) {
      const len = Math.min(CHUNK, pos);
      pos -= len;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, pos);
      buffer = buf.toString('utf8') + buffer;
      const lines = buffer.split('\n');
      // The first slice may be a partial line; keep it for the next loop.
      buffer = pos > 0 ? lines.shift() : '';
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line) continue;
        // Cheap filter before JSON.parse on every line.
        if (line.indexOf('"ai-title"') < 0) continue;
        try {
          const obj = JSON.parse(line);
          if (obj && obj.type === 'ai-title' && typeof obj.aiTitle === 'string') {
            return obj.aiTitle;
          }
        } catch {}
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return null;
}

function sessionsPath(projectDir) {
  return path.join(projectDir, SESSIONS_FILE);
}

function readSessionsMap(projectDir) {
  let raw;
  try { raw = fs.readFileSync(sessionsPath(projectDir), 'utf8'); }
  catch { return { sessions: {}, lastActive: null }; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { sessions: {}, lastActive: null }; }
  const sessions = {};
  if (parsed && typeof parsed.sessions === 'object' && parsed.sessions) {
    for (const [k, v] of Object.entries(parsed.sessions)) {
      if (TAB_ID_RE.test(k) && typeof v === 'string' && v) sessions[k] = v;
    }
  }
  const lastActive = parsed && typeof parsed.lastActive === 'string' && sessions[parsed.lastActive]
    ? parsed.lastActive : null;
  return { sessions, lastActive };
}

function writeSessionsMap(projectDir, map) {
  const out = {
    sessions: map.sessions || {},
    lastActive: map.lastActive || null,
  };
  fs.writeFileSync(sessionsPath(projectDir), JSON.stringify(out, null, 2) + '\n');
}

// Pick the smallest unused id of form sN. Fills gaps so deleted ids get
// reused — keeps tab labels compact across the session's lifetime.
function allocateTabId(sessions) {
  const taken = new Set(Object.keys(sessions || {}));
  for (let i = 1; ; i++) {
    const id = 's' + i;
    if (!taken.has(id)) return id;
  }
}

function joinTermKey(project, tabId) {
  return project + TERM_KEY_SEP + tabId;
}

// Parse a `/term/<key>/` key into {project, tabId}. Returns {project:key, tabId:null}
// for legacy keys with no separator (admin terminals: develop / shell).
function parseTermKey(key) {
  const idx = key.indexOf(TERM_KEY_SEP);
  if (idx < 0) return { project: key, tabId: null };
  return { project: key.slice(0, idx), tabId: key.slice(idx + TERM_KEY_SEP.length) };
}

module.exports = {
  SESSIONS_FILE,
  TAB_ID_RE,
  TERM_KEY_SEP,
  sessionsPath,
  readSessionsMap,
  writeSessionsMap,
  allocateTabId,
  joinTermKey,
  parseTermKey,
  encodeClaudeProjectDir,
  readSessionTitle,
};
