// Hub v2 file access — everything under PROJECTS_ROOT, no project boundary
// (SPEC §V79, §V81). Listing, text read/write, folder + file creation,
// rename, and the git views (diff against a ref, per-file log) a file tab's
// Diff mode needs. Every path goes through `resolveUnder`; git runs against
// the nearest enclosing repo, found by walking up but never above the root.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { resolveUnder, isNoiseName, isHiddenName, parentOf } = require('./v2-paths');
const { langForFile } = require('./lang-map');
const { nearestSentinel } = require('./sentinels');

const TEXT_MAX_BYTES = 2 * 1024 * 1024;
const GIT_TIMEOUT = 5000;
const GIT_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/~^-]{0,80}$/;

const RAW_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.pdf': 'application/pdf', '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};
const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.mp3', '.wav', '.ogg', '.flac', '.m4a',
  '.mp4', '.webm', '.mov', '.mkv', '.pdf', '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.so', '.dylib',
  '.dll', '.exe', '.bin', '.dat', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.pyc', '.sqlite', '.db',
]);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.svg']);
const MEDIA_EXTS = new Set(['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.mp4', '.webm', '.mov']);

// What a file tab should show by default and which modes it supports.
//   fileKind: markdown | html | image | pdf | media | code | binary
function classify(name) {
  const ext = path.extname(String(name)).toLowerCase();
  if (ext === '.md' || ext === '.markdown') return { fileKind: 'markdown', ext, modes: ['view', 'raw', 'edit', 'diff'], defaultMode: 'view' };
  if (ext === '.html' || ext === '.htm' || ext === '.svg') return { fileKind: 'html', ext, modes: ['view', 'raw', 'edit', 'diff'], defaultMode: 'view' };
  if (ext === '.pdf') return { fileKind: 'pdf', ext, modes: ['view', 'raw'], defaultMode: 'view' };
  if (IMAGE_EXTS.has(ext)) return { fileKind: 'image', ext, modes: ['view', 'raw'], defaultMode: 'view' };
  if (MEDIA_EXTS.has(ext)) return { fileKind: 'media', ext, modes: ['view', 'raw'], defaultMode: 'view' };
  if (BINARY_EXTS.has(ext)) return { fileKind: 'binary', ext, modes: ['raw'], defaultMode: 'raw' };
  return { fileKind: 'code', ext, modes: ['raw', 'edit', 'diff'], defaultMode: 'raw' };
}

function httpError(status, message) {
  const e = new Error(message); e.statusCode = status; return e;
}

function git(cwd, args, opts = {}) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', timeout: GIT_TIMEOUT, maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'], ...opts,
  });
}

function makeFs({ projectsRoot }) {
  const ROOT = projectsRoot;

  function resolve(raw) { return resolveUnder(ROOT, raw); }

  // Nearest directory at or above `abs` (not above ROOT) containing `.git`.
  function gitRoot(abs) {
    let dir = abs;
    try { if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir); } catch { dir = path.dirname(dir); }
    while (dir === ROOT || dir.startsWith(ROOT + path.sep)) {
      if (fs.existsSync(path.join(dir, '.git'))) return dir;
      if (dir === ROOT) break;
      dir = path.dirname(dir);
    }
    return null;
  }

  function relToRoot(abs) {
    return abs === ROOT ? '' : path.relative(ROOT, abs).split(path.sep).join('/');
  }

  // Which of `names` (children of `absDir`) git ignores. One `check-ignore`
  // call per listing; empty when the folder is not inside a repo.
  function ignoredNames(absDir, names) {
    const repo = gitRoot(absDir);
    if (!repo || names.length === 0) return new Set();
    try {
      const out = git(repo, ['check-ignore', '--stdin', '-z', '--no-index'], { input: names.map((n) => path.join(absDir, n)).join('\0') + '\0' });
      return new Set(out.split('\0').filter(Boolean).map((p) => path.basename(p)));
    } catch (e) {
      // exit 1 = nothing ignored; anything else → treat as none.
      if (e && e.status === 1 && typeof e.stdout === 'string') {
        return new Set(e.stdout.split('\0').filter(Boolean).map((p) => path.basename(p)));
      }
      return new Set();
    }
  }

  // `git status --porcelain` for the repo, keyed by repo-relative path.
  function statusMap(repo) {
    const map = new Map();
    if (!repo) return map;
    let out;
    try { out = git(repo, ['status', '--porcelain', '-z', '--untracked-files=all']); } catch { return map; }
    const parts = out.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const line = parts[i];
      if (line.length < 4) continue;
      const code = line.slice(0, 2);
      const p = line.slice(3);
      map.set(p, code.trim() || code);
      if (code[0] === 'R' || code[0] === 'C') i++; // rename carries the old path next
    }
    return map;
  }

  function list(raw) {
    const { rel, abs } = resolve(raw);
    let st;
    try { st = fs.statSync(abs); } catch { throw httpError(404, 'not found'); }
    if (!st.isDirectory()) throw httpError(400, 'not a directory');
    const dirents = fs.readdirSync(abs, { withFileTypes: true });
    const names = dirents.map((d) => d.name);
    const ignored = ignoredNames(abs, names);
    const repo = gitRoot(abs);
    const status = statusMap(repo);
    const entries = [];
    for (const d of dirents) {
      const full = path.join(abs, d.name);
      let s;
      try { s = fs.statSync(full); } catch { continue; }
      const kind = s.isDirectory() ? 'dir' : (s.isFile() ? 'file' : 'other');
      if (kind === 'other') continue;
      const relPath = rel ? rel + '/' + d.name : d.name;
      const repoRel = repo ? path.relative(repo, full).split(path.sep).join('/') : null;
      let gitState = null;
      if (repo && repoRel) {
        if (kind === 'file') gitState = status.get(repoRel) || null;
        else {
          for (const k of status.keys()) { if (k.startsWith(repoRel + '/')) { gitState = 'dirty'; break; } }
        }
      }
      const entry = {
        name: d.name, kind, path: relPath, size: kind === 'file' ? s.size : null, mtime: s.mtimeMs,
        dim: isHiddenName(d.name) || isNoiseName(d.name) || ignored.has(d.name),
        git: gitState,
      };
      if (kind === 'dir') {
        entry.repo = fs.existsSync(path.join(full, '.git'));
        entry.project = fs.existsSync(path.join(full, '.project-meta.json'));
      } else {
        Object.assign(entry, classify(d.name));
      }
      entries.push(entry);
    }
    entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : (a.kind === 'dir' ? -1 : 1)));
    return { path: rel, repo: repo ? relToRoot(repo) : null, entries };
  }

  function stat(raw) {
    const { rel, abs } = resolve(raw);
    let s;
    try { s = fs.statSync(abs); } catch { throw httpError(404, 'not found'); }
    const kind = s.isDirectory() ? 'dir' : (s.isFile() ? 'file' : 'other');
    const repo = gitRoot(abs);
    const out = { path: rel, name: path.basename(abs) || '', kind, size: s.size, mtime: s.mtimeMs, repo: repo ? relToRoot(repo) : null };
    if (kind === 'file') {
      Object.assign(out, classify(out.name));
      out.mime = RAW_MIME[out.ext] || 'application/octet-stream';
      out.lang = langForFile(out.name);
      out.textual = !['binary', 'image', 'pdf', 'media'].includes(out.fileKind) || out.ext === '.svg';
      out.tooLarge = s.size > TEXT_MAX_BYTES;
      if (repo) {
        const repoRel = path.relative(repo, abs).split(path.sep).join('/');
        out.git = statusMap(repo).get(repoRel) || null;
      }
    }
    return out;
  }

  function readText(raw) {
    const { rel, abs } = resolve(raw);
    let s;
    try { s = fs.statSync(abs); } catch { throw httpError(404, 'not found'); }
    if (!s.isFile()) throw httpError(400, 'not a file');
    if (s.size > TEXT_MAX_BYTES) throw httpError(413, `file too large to open as text (${s.size} bytes)`);
    const content = fs.readFileSync(abs, 'utf8');
    return { path: rel, content, size: s.size, mtime: s.mtimeMs, lang: langForFile(abs), ...classify(abs) };
  }

  // `baseMtime` = the mtime the editor loaded; a mismatch means someone (an
  // agent, most likely) wrote the file meanwhile → 409, never a silent clobber.
  function writeText(raw, content, { baseMtime } = {}) {
    const { rel, abs } = resolve(raw);
    if (typeof content !== 'string') throw httpError(400, 'content must be a string');
    if (Buffer.byteLength(content) > 8 * TEXT_MAX_BYTES) throw httpError(413, 'content too large');
    let s = null;
    try { s = fs.statSync(abs); } catch {}
    if (s && !s.isFile()) throw httpError(400, 'not a file');
    if (s && Number.isFinite(baseMtime) && Math.abs(s.mtimeMs - baseMtime) > 1) {
      const e = httpError(409, 'file changed on disk since it was opened');
      e.mtime = s.mtimeMs;
      throw e;
    }
    if (!s) fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    const after = fs.statSync(abs);
    return { path: rel, size: after.size, mtime: after.mtimeMs };
  }

  function mkdir(raw) {
    const { rel, abs } = resolve(raw);
    if (!rel) throw httpError(400, 'name required');
    if (fs.existsSync(abs)) throw httpError(409, 'already exists');
    fs.mkdirSync(abs, { recursive: true });
    return { path: rel };
  }

  function createFile(raw) {
    const { rel, abs } = resolve(raw);
    if (!rel) throw httpError(400, 'name required');
    if (fs.existsSync(abs)) throw httpError(409, 'already exists');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, '');
    return { path: rel };
  }

  // Delete a file or a whole folder. The root itself is refused; nothing
  // else is protected — the UI confirms, the API obeys (V98).
  function remove(raw) {
    const { rel, abs } = resolve(raw);
    if (!rel) throw httpError(400, 'cannot delete the root');
    let st;
    try { st = fs.lstatSync(abs); } catch { throw httpError(404, 'not found'); }
    const kind = st.isDirectory() ? 'dir' : 'file';
    fs.rmSync(abs, { recursive: true, force: true });
    return { path: rel, kind, deleted: true };
  }

  // Rename within the same folder or move: `to` is a full relative path.
  function rename(raw, toRaw) {
    const from = resolve(raw);
    const to = resolve(toRaw);
    if (!from.rel || !to.rel) throw httpError(400, 'cannot rename the root');
    if (!fs.existsSync(from.abs)) throw httpError(404, 'not found');
    if (fs.existsSync(to.abs)) throw httpError(409, 'target exists');
    fs.mkdirSync(path.dirname(to.abs), { recursive: true });
    fs.renameSync(from.abs, to.abs);
    return { path: to.rel };
  }

  // Working tree vs `ref` (default HEAD). `ref` may also be `<a>..<b>`-free
  // commit-ish; two refs (`ref` + `to`) compare two commits.
  function diff(raw, ref = 'HEAD', to = null) {
    const { rel, abs } = resolve(raw);
    const repo = gitRoot(abs);
    if (!repo) throw httpError(404, 'not inside a git repository');
    if (!GIT_REF_RE.test(ref) || (to && !GIT_REF_RE.test(to))) throw httpError(400, 'bad ref');
    const repoRel = path.relative(repo, abs).split(path.sep).join('/');
    const args = ['diff', '--no-color', '--no-ext-diff'];
    if (to) args.push(ref, to); else args.push(ref);
    args.push('--', repoRel);
    let out;
    try { out = git(repo, args); }
    catch (e) {
      if (/ambiguous argument|unknown revision|bad revision/i.test(String(e.stderr || e.message))) throw httpError(404, 'unknown ref');
      throw httpError(500, 'git diff failed: ' + (e.stderr || e.message));
    }
    // An untracked file diffs as nothing against any ref; show it as added.
    if (!out && !to && fs.existsSync(abs) && !isTracked(repo, repoRel)) {
      try { out = git(repo, ['diff', '--no-color', '--no-index', '--', '/dev/null', abs]); }
      catch (e2) { out = typeof e2.stdout === 'string' ? e2.stdout : ''; }
    }
    return { path: rel, repo: relToRoot(repo), ref, to, diff: out };
  }

  function isTracked(repo, repoRel) {
    try { git(repo, ['ls-files', '--error-unmatch', '--', repoRel]); return true; } catch { return false; }
  }

  function log(raw, n = 30) {
    const { rel, abs } = resolve(raw);
    const repo = gitRoot(abs);
    if (!repo) return { path: rel, repo: null, commits: [] };
    const repoRel = path.relative(repo, abs).split(path.sep).join('/');
    const count = Math.max(1, Math.min(200, Number(n) || 30));
    let out;
    try {
      out = git(repo, ['log', `-n${count}`, '--format=%H%x1f%h%x1f%aI%x1f%an%x1f%s', '--follow', '--', repoRel || '.']);
    } catch { return { path: rel, repo: relToRoot(repo), commits: [] }; }
    const commits = out.split('\n').filter(Boolean).map((line) => {
      const [sha, short, date, author, subject] = line.split('\x1f');
      return { sha, short, date, author, subject };
    });
    return { path: rel, repo: relToRoot(repo), commits };
  }

  // Full text of the file at a commit (for the diff tab's "show that version").
  function showAt(raw, ref) {
    const { abs } = resolve(raw);
    const repo = gitRoot(abs);
    if (!repo) throw httpError(404, 'not inside a git repository');
    if (!GIT_REF_RE.test(ref)) throw httpError(400, 'bad ref');
    const repoRel = path.relative(repo, abs).split(path.sep).join('/');
    try { return git(repo, ['show', `${ref}:${repoRel}`]); }
    catch (e) { throw httpError(404, 'no such file at ' + ref); }
  }

  // The sentinel folder (itself or the nearest ancestor) a path belongs to,
  // as a path relative to the root — or null (V99).
  function projectOf(rel) {
    const hit = nearestSentinel(ROOT, rel);
    return hit ? hit.rel : null;
  }

  return { resolve, gitRoot, list, stat, readText, writeText, mkdir, createFile, rename, remove, diff, log, showAt, projectOf, relToRoot };
}

module.exports = { makeFs, classify, RAW_MIME, BINARY_EXTS, TEXT_MAX_BYTES, parentOf };
