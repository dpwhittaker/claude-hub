// Claude Code's on-disk transcripts (SPEC §V90, §V92): where a session's
// jsonl lives for a working folder, and what can be read off it for a
// session that is not live — its title, when it last gained a record, and
// where its conversation moved if Claude continued it under a new id.
// (A live session is read from Claude's registry, lib/claude-registry.js.)
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Encode a project directory the way claude stores its sessions on disk:
// leading dash, then the abs path with '/' replaced by '-'. e.g.
// /home/david/projects/claude-hub → -home-david-projects-claude-hub.
function encodeClaudeProjectDir(projectDir) {
  return '-' + projectDir.replace(/^\//, '').replace(/\//g, '-');
}

// The title a transcript on disk carries, for a session that is NOT live
// (a live one is read from Claude's session registry, lib/claude-registry.js).
// Two places, in precedence order (V90):
//   1. <encoded>/<uuid>/custom-title.json — what `/rename` writes now; its
//      mtime is when the user renamed;
//   2. the jsonl: a `custom-title` record (older Claude versions) beats the
//      `ai-title`, whatever the order — Claude re-appends `ai-title` every
//      turn, so "latest record" would let the stale AI name bury a rename.
// The jsonl is read in 64 KB chunks from the END so a multi-megabyte session
// doesn't cost a full scan. → {title, source: 'custom'|'ai', at} | null.
function readTranscriptTitle(projectDir, uuid, opts) {
  const homedir = (opts && opts.homedir) || os.homedir();
  const sessionsDir = path.join(homedir, '.claude', 'projects', encodeClaudeProjectDir(projectDir));
  try {
    const jsonPath = path.join(sessionsDir, uuid, 'custom-title.json');
    const o = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    if (o && typeof o.customTitle === 'string' && o.customTitle.trim()) {
      return { title: o.customTitle.trim(), source: 'custom', at: fs.statSync(jsonPath).mtimeMs };
    }
  } catch {}
  const file = path.join(sessionsDir, uuid + '.jsonl');
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  let ai = null;
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
        if (line.indexOf('"ai-title"') < 0 && line.indexOf('"custom-title"') < 0) continue;
        try {
          const obj = JSON.parse(line);
          if (obj && obj.type === 'custom-title' && typeof obj.customTitle === 'string' && obj.customTitle.trim()) {
            return { title: obj.customTitle.trim(), source: 'custom', at: 0 };
          }
          if (!ai && obj && obj.type === 'ai-title' && typeof obj.aiTitle === 'string') ai = { title: obj.aiTitle, source: 'ai', at: 0 };
        } catch {}
      }
      // The newest ai-title is found in the first chunk; only keep reading
      // for a custom-title record, and give up once a full read would be
      // needed for a session that big.
      if (ai && stat.size - pos > 4 * CHUNK) break;
    }
  } finally {
    fs.closeSync(fd);
  }
  return ai;
}

// When the transcript last gained a record — the last `"timestamp"` in its
// tail — for a session that is not live. NOT the file's mtime: the file is
// touched without a new turn (B32). 0 when unreadable.
function readTranscriptLastAt(projectDir, uuid, opts) {
  const homedir = (opts && opts.homedir) || os.homedir();
  const file = path.join(homedir, '.claude', 'projects', encodeClaudeProjectDir(projectDir), uuid + '.jsonl');
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return 0; }
  try {
    const size = fs.fstatSync(fd).size;
    const RE = /"timestamp":"([^"]+)"/g;
    for (const len of [64 * 1024, 1024 * 1024]) {
      const n = Math.min(size, len);
      const buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, size - n);
      const text = buf.toString('utf8');
      let m; let last = null;
      while ((m = RE.exec(text))) last = m[1];
      if (last) { const t = Date.parse(last); if (t) return t; }
      if (n === size) break;
    }
  } catch {} finally { fs.closeSync(fd); }
  return 0;
}

// The id this transcript's conversation moved to, or null. Backgrounding a
// session (Claude's daemon forks it into a worker outside the hub's terminal)
// mints a new id and appends `{"type":"continued-in","continuedInSessionId"}`
// to the old transcript; the registry never sees the move (B36). It counts
// only while the marker is the NEWEST timestamped record — a later turn means
// the conversation went on in this id after all (a resume of the old id) —
// and only when the target's transcript is in the same folder, where
// `claude --resume` will look for it.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function readContinuedIn(projectDir, uuid, opts) {
  const homedir = (opts && opts.homedir) || os.homedir();
  const dir = path.join(homedir, '.claude', 'projects', encodeClaudeProjectDir(projectDir));
  let fd;
  try { fd = fs.openSync(path.join(dir, uuid + '.jsonl'), 'r'); } catch { return null; }
  let next = null;
  try {
    const size = fs.fstatSync(fd).size;
    for (const len of [64 * 1024, 1024 * 1024]) {
      const n = Math.min(size, len);
      const buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, size - n);
      const lines = buf.toString('utf8').split('\n');
      if (n < size) lines.shift();   // partial first line
      let decided = false;
      for (let i = lines.length - 1; i >= 0 && !decided; i--) {
        const line = lines[i];
        if (line.indexOf('"continued-in"') >= 0) {
          try { const o = JSON.parse(line); if (o && o.type === 'continued-in') { next = o.continuedInSessionId; decided = true; } } catch {}
        } else if (line.indexOf('"timestamp":') >= 0) {
          try { if (typeof JSON.parse(line).timestamp === 'string') decided = true; } catch {}
        }
      }
      if (decided || n === size) break;
    }
  } catch {} finally { fs.closeSync(fd); }
  if (typeof next !== 'string' || !UUID_RE.test(next) || next === uuid) return null;
  return fs.existsSync(path.join(dir, next + '.jsonl')) ? next : null;
}

// Follow `continued-in` markers to the id the conversation is on now (the
// input when it never moved). Bounded, and a cycle stops where it closes.
function followContinuation(projectDir, uuid, opts) {
  const seen = new Set([uuid]);
  let cur = uuid;
  for (let hops = 0; hops < 16; hops++) {
    const next = readContinuedIn(projectDir, cur, opts);
    if (!next || seen.has(next)) break;
    seen.add(next);
    cur = next;
  }
  return cur;
}

// Back-compat string form.
function readSessionTitle(projectDir, uuid, opts) {
  const t = readTranscriptTitle(projectDir, uuid, opts);
  return t ? t.title : null;
}

module.exports = { encodeClaudeProjectDir, readTranscriptTitle, readTranscriptLastAt, readContinuedIn, followContinuation, readSessionTitle };
