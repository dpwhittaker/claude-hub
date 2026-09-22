// Hub v2 HTTP surface (SPEC §I "v2 routes").
//
// One router for everything the /v2/ shell talks to, kept out of server.js
// so the v1 dispatcher stays untouched. `makeV2Router` takes the few things
// only server.js owns (sendJson, readJsonBody, exec, project readers, the
// legacy tab map) and returns `handle(req, res, url)` → true when the
// request was v2's. Static shell files are served from ../v2/ with no-cache
// so edits show on reload; lib/v2-layout.js is served wrapped so the browser
// gets the exact functions the tests exercise (V42's idea, V80).
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { makeFs, RAW_MIME, TEXT_MAX_BYTES } = require('./v2-fs');
const { makeProfileStore } = require('./v2-profiles');
const { makeSessionStore, ID_RE: SESSION_ID_RE } = require('./v2-sessions');
const { makeServiceLister, isUnitName, ACTIONS } = require('./v2-services');
const { makeTitleStore } = require('./v2-titles');
const { readTranscriptTitle, encodeClaudeProjectDir } = require('./term-sessions');
const { readLiveSessions } = require('./claude-registry');
const os = require('node:os');
const { routeForPath } = require('./file-routes');
const { parseFrontmatter } = require('./readme-meta');
const { escapeHtml } = require('./escape-html');
const { parentOf, baseOf } = require('./v2-paths');
const { Marked } = require('marked');

const V2_DIR = path.join(__dirname, '..', 'v2');
const V2_MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json; charset=utf-8' };
const STATIC_RE = /^[A-Za-z0-9_-]+\.(html|js|css|svg|png|webmanifest)$/;
const COMPLETION_MODEL = process.env.HUB_COMPLETION_MODEL || 'claude-haiku-4-5-20251001';

function errStatus(e) { return Number.isInteger(e && e.statusCode) ? e.statusCode : 500; }

// Relative image/link targets in a rendered markdown file resolve against the
// file's own folder through the raw endpoint, so a README's screenshots show.
function relativeToRaw(dir, href) {
  if (!href || /^(?:[a-z]+:|\/|#|data:)/i.test(href)) return href;
  const segs = (dir ? dir.split('/') : []);
  for (const part of href.split('?')[0].split('#')[0].split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') segs.pop(); else segs.push(part);
  }
  return '/api/v2/fs/raw?path=' + encodeURIComponent(segs.join('/'));
}

// Markdown → a self-contained page in the hub's viewer style, for the file
// tab's View mode iframe. Same CSS family as the v1 viewer's embed mode.
function renderMarkdownPage(_marked, rel, content) {
  const { meta, body } = parseFrontmatter(content);
  const dir = parentOf(rel);
  const md = new Marked({
    renderer: {
      image({ href, title, text }) {
        return `<img src="${escapeHtml(relativeToRaw(dir, href))}" alt="${escapeHtml(text || '')}"${title ? ` title="${escapeHtml(title)}"` : ''}>`;
      },
      link({ href, title, tokens }) {
        const inner = this.parser.parseInline(tokens);
        const target = relativeToRaw(dir, href);
        const ext = /^(?:[a-z]+:)?\/\//i.test(href) ? ' target="_blank" rel="noopener"' : '';
        return `<a href="${escapeHtml(target)}"${title ? ` title="${escapeHtml(title)}"` : ''}${ext}>${inner}</a>`;
      },
    },
  });
  const metaKeys = Object.keys(meta || {});
  const fm = metaKeys.length
    ? `<pre class="frontmatter">${metaKeys.map((k) => `<span class="k">${escapeHtml(k)}</span>: ${escapeHtml(Array.isArray(meta[k]) ? '[' + meta[k].join(', ') + ']' : String(meta[k]))}`).join('\n')}</pre>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(baseOf(rel))}</title>
<style>
  :root { color-scheme: dark; --bg-0:#050810; --bg-1:#0d1320; --bg-2:#131b2c; --fg:#e2e8f0; --muted:#94a3b8; --accent:#7dd3fc; --edge:#1f2937; }
  * { box-sizing: border-box; }
  html, body { margin:0; background:var(--bg-0); color:var(--fg); font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  body { padding: 14px 18px 32px; max-width: 920px; margin: 0 auto; line-height: 1.55; }
  pre { background: var(--bg-1); border: 1px solid var(--edge); border-radius: 8px; padding: 12px 14px; overflow-x: auto; font-size: 13px; line-height: 1.5; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .md h1, .md h2, .md h3 { letter-spacing: -0.01em; }
  .md h1 { border-bottom: 1px solid var(--edge); padding-bottom: 8px; }
  .md a { color: var(--accent); }
  .md code { background: var(--bg-1); padding: 1px 6px; border-radius: 4px; font-size: 0.9em; }
  .md pre code { background: none; padding: 0; }
  .md blockquote { border-left: 3px solid var(--edge); margin: 0; padding: 4px 14px; color: var(--muted); }
  .md table { border-collapse: collapse; display: block; overflow-x: auto; }
  .md th, .md td { border: 1px solid var(--edge); padding: 6px 10px; }
  .md img { max-width: 100%; border-radius: 6px; }
  pre.frontmatter { background: var(--bg-2); border-left: 3px solid var(--accent); font-size: 12px; color: var(--muted); }
  pre.frontmatter .k { color: var(--accent); }
  @container (max-width: 480px) { body { padding: 10px 12px 24px; } }
</style></head>
<body>${fm}<article class="md">${md.parse(body)}</article></body></html>`;
}

// Fill-in-the-middle completion through the local claude CLI (`-p`), so it
// rides the user's own login and needs no API key. Returns the inserted text.
function completeWithClaude({ before, after, lang, pathHint }, { claudeBin, model = COMPLETION_MODEL, timeoutMs = 60000 } = {}) {
  const prompt = [
    'You are a code completion engine. Continue the file at the cursor.',
    'Output ONLY the text to insert at the cursor — no explanation, no markdown fences, no repetition of the prefix or suffix.',
    'Keep it short: finish the current statement, block or paragraph (at most ~12 lines).',
    pathHint ? `File: ${pathHint}` : '', lang ? `Language: ${lang}` : '',
    '', '<prefix>', before, '</prefix>', '<suffix>', after, '</suffix>',
  ].join('\n');
  return new Promise((resolve, reject) => {
    const child = spawn(claudeBin, ['-p', '--output-format', 'text', '--model', model, '--no-session-persistence', '--tools', ''], {
      // HUB_TITLE_WORKER keeps the session-title Stop hook from titling this
      // throwaway completion session.
      stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CLAUDECODE: '', HUB_TITLE_WORKER: '1' },
    });
    let out = ''; let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('completion timed out')); }, timeoutMs);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error('claude exited ' + code + ': ' + err.trim().slice(0, 400)));
      let text = out.replace(/\r\n/g, '\n');
      const fence = /^\s*```[\w-]*\n([\s\S]*?)\n```\s*$/.exec(text);
      if (fence) text = fence[1];
      resolve(text.replace(/\s+$/, '\n').replace(/^\n+/, ''));
    });
    child.stdin.end(prompt);
  });
}

function makeV2Router(deps) {
  const {
    projectsRoot, hubDir, sendJson, readJsonBody, execFileP, marked,
    readProjectRoutes, readProjectProxyPrefix, listLegacySessions, tmuxListSessions,
    claudeBin, unitDir,
  } = deps;
  const fsApi = makeFs({ projectsRoot });
  const profiles = makeProfileStore({ dir: hubDir });
  const sessions = makeSessionStore({ dir: hubDir, projectsRoot });
  const services = makeServiceLister({ projectsRoot, hubDir, exec: (c, a) => execFileP(c, a, { timeout: 10000, maxBuffer: 4 * 1024 * 1024 }), unitDir });
  const titles = makeTitleStore({ dir: hubDir });
  const registry = deps.readLiveSessions || readLiveSessions;

  function transcriptMtime(absCwd, uuid) {
    try { return fs.statSync(path.join(os.homedir(), '.claude', 'projects', encodeClaudeProjectDir(absCwd), uuid + '.jsonl')).mtimeMs; }
    catch { return 0; }
  }

  // Per-session title, activity, recency (V90, V92). A LIVE claude session
  // (Claude's registry names its tmux pane) is the authority on its own id,
  // status and name; the title is the NEWER of the registry name (unless it
  // is the derived placeholder) and the hook's auto title, so a `/rename`
  // and the auto-titler take turns by time instead of one burying the other.
  // A stopped session falls back to the transcript on disk. `lastActive` =
  // the latest of registry update, tmux activity, transcript mtime, creation.
  function withTitles(list, tmux, live) {
    const auto = titles.lookup();
    return list.map((s) => {
      const abs = s.cwd ? path.join(projectsRoot, s.cwd) : projectsRoot;
      const t = tmux.get(s.termKey);
      const reg = s.agent === 'claude' && t ? live.get(s.termKey) : null;
      const uuid = reg ? reg.sessionId : s.uuid;
      if (reg && s.uuid && reg.sessionId !== s.uuid) followSessionId(s, reg.sessionId);
      const times = [t ? t.activity : 0, reg ? reg.updatedAt : 0, s.agent === 'claude' ? transcriptMtime(abs, uuid) : 0, s.createdAt ? Date.parse(s.createdAt) || 0 : 0];
      const out = { ...s, uuid, running: !!t, activity: reg ? reg.status : null, lastActive: Math.max(...times) || null };
      if (s.agent === 'claude') {
        const candidates = [];
        if (s.title) candidates.push({ title: s.title, at: Infinity });
        if (reg && reg.name && reg.nameSource !== 'derived') candidates.push({ title: reg.name, at: reg.nameSince });
        const hub = auto.rec(uuid) || (uuid !== s.uuid ? auto.rec(s.uuid) : null);
        if (hub) candidates.push({ title: hub.title, at: hub.at });
        if (!candidates.length) { const tt = readTranscriptTitle(abs, uuid); if (tt) candidates.push(tt); }
        out.title = candidates.sort((a, b) => b.at - a.at)[0]?.title || null;
      }
      return out;
    });
  }

  // Persist the live id into the tab's record so a reboot resumes the
  // conversation the user was actually in, not the one the tab began with.
  function followSessionId(s, sessionId) {
    try {
      if (s.kind === 'hub') sessions.update(s.id, { uuid: sessionId });
      else if (deps.updateLegacyUuid) deps.updateLegacyUuid(s, sessionId);
    } catch {}
  }

  function fail(res, e) {
    const status = errStatus(e);
    const body = { error: e && e.message ? e.message : String(e) };
    if (e && e.mtime) body.mtime = e.mtime;
    if (e && e.rev) body.rev = e.rev;
    sendJson(res, status, body);
  }

  function body(req, res, max, fn) {
    readJsonBody(req, res, max, (b, err) => {
      if (err) return;
      Promise.resolve().then(() => fn(b || {})).catch((e) => { if (!res.headersSent) fail(res, e); });
    });
  }

  function serveStatic(res, name) {
    if (!STATIC_RE.test(name)) { res.writeHead(404); return res.end('not found'); }
    fs.readFile(path.join(V2_DIR, name), (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': V2_MIME[path.extname(name)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  }

  function serveLayoutLib(res) {
    fs.readFile(path.join(__dirname, 'v2-layout.js'), 'utf8', (err, src) => {
      if (err) { res.writeHead(500); return res.end('missing layout lib'); }
      const wrapped = `(function(){const module={exports:{}};\n${src}\nwindow.HubLayout=module.exports;})();\n`;
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(wrapped);
    });
  }

  // The live URL a file renders at, when it sits in a project with routes
  // (V54) or is an html file behind a proxied dev server.
  function previewUrlFor(rel) {
    const project = fsApi.projectOf(rel);
    if (!project) return null;
    const prefix = readProjectProxyPrefix(project);
    if (!prefix) return null;
    const inner = rel.slice(project.length + 1);
    const route = routeForPath(readProjectRoutes(project), inner);
    if (route) return prefix + route;
    if (/\.html?$/i.test(inner)) return prefix + '/' + inner.split('/').map(encodeURIComponent).join('/');
    return null;
  }

  async function tmuxMap() {
    try { return new Map((await tmuxListSessions()).filter((t) => t && t.name).map((t) => [t.name, t])); } catch { return new Map(); }
  }

  // A stamp that changes whenever any served client file does, so an open
  // page can notice it is running old code and reload itself (V94).
  function clientVersion() {
    let newest = 0;
    try {
      for (const n of fs.readdirSync(V2_DIR)) {
        const m = fs.statSync(path.join(V2_DIR, n)).mtimeMs;
        if (m > newest) newest = m;
      }
      newest = Math.max(newest, fs.statSync(path.join(__dirname, 'v2-layout.js')).mtimeMs);
    } catch {}
    return String(Math.round(newest));
  }

  async function handle(req, res, url) {
    const q = url.indexOf('?');
    const p = q < 0 ? url : url.slice(0, q);
    const query = new URLSearchParams(q < 0 ? '' : url.slice(q + 1));
    const m = req.method;

    // ---- shell ----
    if (p === '/v2') { res.writeHead(301, { Location: '/v2/' + (q < 0 ? '' : url.slice(q)) }); res.end(); return true; }
    if (p === '/v2/') { serveStatic(res, 'index.html'); return true; }
    if (p === '/v2/lib/v2-layout.js') { serveLayoutLib(res); return true; }
    if (p.startsWith('/v2/')) { serveStatic(res, p.slice(4)); return true; }
    if (!p.startsWith('/api/v2/')) return false;

    try {
      if (p === '/api/v2/version') return sendJson(res, 200, { version: clientVersion() }), true;

      // ---- profiles ----
      if (p === '/api/v2/profiles') {
        if (m === 'GET') return sendJson(res, 200, { profiles: profiles.list() }), true;
        if (m === 'POST') return body(req, res, 128 * 1024, (b) => sendJson(res, 200, profiles.create(b))), true;
        return sendJson(res, 405, { error: 'method not allowed' }), true;
      }
      let mm = /^\/api\/v2\/profiles\/([^/]+)$/.exec(p);
      if (mm) {
        const id = decodeURIComponent(mm[1]);
        if (m === 'GET') return sendJson(res, 200, profiles.get(id)), true;
        if (m === 'PUT' || m === 'PATCH') return body(req, res, 2 * 1024 * 1024, (b) => sendJson(res, 200, profiles.update(id, b))), true;
        if (m === 'DELETE') return sendJson(res, 200, profiles.remove(id)), true;
        return sendJson(res, 405, { error: 'method not allowed' }), true;
      }

      // ---- sessions ----
      if (p === '/api/v2/sessions') {
        if (m === 'GET') {
          const tmux = await tmuxMap();
          const legacy = (listLegacySessions ? listLegacySessions() : []).map((s) => ({ ...s, title: null }));
          return sendJson(res, 200, { sessions: withTitles([...sessions.list(), ...legacy], tmux, registry()) }), true;
        }
        if (m === 'POST') return body(req, res, 64 * 1024, (b) => sendJson(res, 200, sessions.create(b))), true;
        return sendJson(res, 405, { error: 'method not allowed' }), true;
      }
      mm = /^\/api\/v2\/sessions\/([^/]+)$/.exec(p);
      if (mm) {
        const id = decodeURIComponent(mm[1]);
        if (m === 'GET') return sendJson(res, 200, sessions.get(id)), true;
        if (m === 'PATCH' || m === 'PUT') return body(req, res, 16 * 1024, (b) => sendJson(res, 200, sessions.update(id, b))), true;
        if (m === 'DELETE') {
          if (!SESSION_ID_RE.test(id)) return sendJson(res, 400, { error: 'bad session id' }), true;
          const s = sessions.get(id);
          try { await execFileP('tmux', ['kill-session', '-t', '=' + s.termKey], { timeout: 5000 }); } catch {}
          return sendJson(res, 200, sessions.remove(id)), true;
        }
        return sendJson(res, 405, { error: 'method not allowed' }), true;
      }

      // ---- titles (the Stop hook's endpoint) ----
      if (p === '/api/v2/titles') {
        if (m !== 'POST') return sendJson(res, 405, { error: 'method not allowed' }), true;
        return body(req, res, 8192, (b) => sendJson(res, 200, titles.set(b.uuid, b.title, b.source))), true;
      }
      mm = /^\/api\/v2\/titles\/([^/]+)$/.exec(p);
      if (mm) {
        const uuid = decodeURIComponent(mm[1]);
        if (m === 'GET') { const t = titles.get(uuid); return sendJson(res, t ? 200 : 404, t || { error: 'no title' }), true; }
        if (m === 'DELETE') return sendJson(res, 200, titles.remove(uuid)), true;
        return sendJson(res, 405, { error: 'method not allowed' }), true;
      }

      // ---- services ----
      if (p === '/api/v2/services') {
        if (m !== 'GET') return sendJson(res, 405, { error: 'method not allowed' }), true;
        return sendJson(res, 200, await services.list()), true;
      }
      mm = /^\/api\/v2\/services\/([^/]+)\/(start|stop|restart|logs|unit)$/.exec(p);
      if (mm) {
        const unit = decodeURIComponent(mm[1]);
        const action = mm[2];
        if (!isUnitName(unit) || !(await services.isKnownUnit(unit))) return sendJson(res, 404, { error: 'unknown service' }), true;
        if (action === 'unit') {
          // The unit FILE — for `vite@x.service` that is the `vite@.service` template.
          if (m !== 'GET') return sendJson(res, 405, { error: 'method not allowed' }), true;
          const { stdout } = await execFileP('systemctl', ['show', '-p', 'FragmentPath', '--value', unit], { timeout: 5000 });
          const file = stdout.trim();
          if (!file) return sendJson(res, 404, { error: 'no unit file' }), true;
          let content;
          try { content = fs.readFileSync(file, 'utf8'); } catch (e) { return sendJson(res, 500, { error: 'cannot read ' + file + ': ' + e.message }), true; }
          return sendJson(res, 200, { unit, path: file, content }), true;
        }
        if (action === 'logs') {
          if (m !== 'GET') return sendJson(res, 405, { error: 'method not allowed' }), true;
          const n = Math.max(10, Math.min(2000, Number(query.get('n')) || 200));
          const { stdout } = await execFileP('journalctl', ['-u', unit, '-n', String(n), '--no-pager', '-o', 'short-iso'], { timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
          return sendJson(res, 200, { unit, lines: stdout.split('\n').filter(Boolean) }), true;
        }
        if (m !== 'POST') return sendJson(res, 405, { error: 'method not allowed' }), true;
        if (!ACTIONS.has(action)) return sendJson(res, 400, { error: 'bad action' }), true;
        await execFileP('sudo', ['-n', 'systemctl', action, unit], { timeout: 30000 });
        return sendJson(res, 200, { unit, action, ok: true }), true;
      }

      // ---- files ----
      const rel = query.get('path') || '';
      if (p === '/api/v2/fs/list') return sendJson(res, 200, fsApi.list(rel)), true;
      if (p === '/api/v2/fs/stat') {
        const st = fsApi.stat(rel);
        if (st.kind === 'file') st.previewUrl = previewUrlFor(st.path);
        return sendJson(res, 200, st), true;
      }
      if (p === '/api/v2/fs/text') {
        if (m === 'GET') return sendJson(res, 200, fsApi.readText(rel)), true;
        if (m === 'PUT') return body(req, res, 8 * TEXT_MAX_BYTES + 4096, (b) => sendJson(res, 200, fsApi.writeText(b.path, b.content, { baseMtime: b.baseMtime }))), true;
        return sendJson(res, 405, { error: 'method not allowed' }), true;
      }
      if (p === '/api/v2/fs/raw') {
        const { abs } = fsApi.resolve(rel);
        let st;
        try { st = fs.statSync(abs); } catch { return sendJson(res, 404, { error: 'not found' }), true; }
        if (!st.isFile()) return sendJson(res, 400, { error: 'not a file' }), true;
        const ext = path.extname(abs).toLowerCase();
        const headers = { 'Content-Type': RAW_MIME[ext] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-cache' };
        if (query.get('download') === '1') {
          const name = path.basename(abs);
          headers['Content-Disposition'] = `attachment; filename="${name.replace(/["\r\n]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;
        }
        res.writeHead(200, headers);
        if (m === 'HEAD') return res.end(), true;
        fs.createReadStream(abs).on('error', () => { try { res.end(); } catch {} }).pipe(res);
        return true;
      }
      if (p === '/api/v2/fs/render') {
        const t = fsApi.readText(rel);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(renderMarkdownPage(marked, t.path, t.content));
        return true;
      }
      if (p === '/api/v2/fs/diff') return sendJson(res, 200, fsApi.diff(rel, query.get('ref') || 'HEAD', query.get('to') || null)), true;
      if (p === '/api/v2/fs/log') return sendJson(res, 200, fsApi.log(rel, query.get('n'))), true;
      if (p === '/api/v2/fs/show') {
        const ref = query.get('ref') || 'HEAD';
        return sendJson(res, 200, { path: rel, ref, content: fsApi.showAt(rel, ref) }), true;
      }
      if (p === '/api/v2/fs/mkdir' && m === 'POST') return body(req, res, 4096, (b) => sendJson(res, 200, fsApi.mkdir(b.path))), true;
      if (p === '/api/v2/fs/create' && m === 'POST') return body(req, res, 4096, (b) => sendJson(res, 200, fsApi.createFile(b.path))), true;
      if (p === '/api/v2/fs/rename' && m === 'POST') return body(req, res, 4096, (b) => sendJson(res, 200, fsApi.rename(b.path, b.to))), true;

      // ---- ai ----
      if (p === '/api/v2/ai/complete' && m === 'POST') {
        return body(req, res, 256 * 1024, async (b) => {
          const before = String(b.before || '').slice(-6000);
          const after = String(b.after || '').slice(0, 3000);
          const text = await completeWithClaude({ before, after, lang: b.lang, pathHint: b.path }, { claudeBin });
          sendJson(res, 200, { text, model: COMPLETION_MODEL });
        }), true;
      }

      sendJson(res, 404, { error: 'unknown v2 route' });
      return true;
    } catch (e) {
      if (!res.headersSent) fail(res, e);
      return true;
    }
  }

  return { handle, profiles, sessions, services, titles, fs: fsApi, renderMarkdownPage };
}

module.exports = { makeV2Router, renderMarkdownPage, completeWithClaude };
