/**
 * claude-hub — path-routed reverse proxy that fronts your local projects.
 *
 *   /                    → static landing page (this directory's landing.html)
 *   /api/projects        → list/create/delete managed projects
 *   /api/view-tree/<p>   → recursive file tree (JSON) for the file browser
 *   /view/<p>/<file>     → read-only markdown + code viewer
 *   /<p>(/|$)            → reverse-proxy to a project's backend if its
 *                          .project-meta.json declares `proxyTarget`. Prefix
 *                          and stripPrefix come from the same file (defaults:
 *                          prefix = "/<name>", stripPrefix = true).
 *   /term/<p>(/|$)       → ttyd terminal for the project, attached to a
 *                          long-lived tmux session running Claude Code. Talks
 *                          over a Unix socket so we don't burn a TCP port.
 *                          Multi-attach: every browser sees the same tmux.
 *   /term/develop(/|$)   → admin terminal: fresh `claude` in ~/projects each
 *                          connection (no tmux, no --continue). For
 *                          cross-project chores. Backed by ttyd-develop.service.
 *   /term/wsl(/|$)       → raw bash login shell, no claude, no tmux. For
 *                          system poking that doesn't need an LLM in the loop.
 *                          Backed by ttyd-wsl.service.
 *
 * WebSocket upgrades are forwarded so Vite HMR (and ttyd) keep working.
 *
 * Run as a systemd service or directly: `node server.js`.
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const httpProxy = require('http-proxy');
const { marked } = require('marked');
const { WebSocketServer } = require('ws');
const { tabKey } = require('./lib/tab-key');
const { allocatePort } = require('./lib/port-alloc');
const { copyTemplate } = require('./lib/template');
const { makeGhRepos, filterReposByFolders } = require('./lib/gh-repos');
const { PROJECT_ID_RE, RESERVED_PROJECT_NAMES } = require('./lib/project-name');
const { writeBootstrapPrompt } = require('./lib/bootstrap-prompt');
const { effectiveTemplate } = require('./lib/template-policy');
const { bootstrapOnboard, listOrphanFolderNames } = require('./lib/onboard');

const PORT = Number(process.env.PROXY_PORT) || 8002;
const LANDING_PATH = path.join(__dirname, 'landing.html');

// Static routes are derived from each managed project's .project-meta.json.
// A project that declares `proxyTarget` (e.g. "http://127.0.0.1:5173") gets
// proxied at `/<name>/*` by default; `proxyPrefix` overrides the URL prefix
// and `stripPrefix: false` leaves it on the request (needed when the upstream
// expects the prefix, e.g. Vite with `base: "/<name>/"`). The full set is
// rebuilt on startup and after any project create/delete; per-request lookup
// stays synchronous.
let STATIC_ROUTES = [];

function buildStaticRoutes() {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const metaPath = path.join(PROJECTS_ROOT, e.name, '.project-meta.json');
    if (!fs.existsSync(metaPath)) continue;
    let meta;
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { continue; }
    const target = typeof meta.proxyTarget === 'string' ? meta.proxyTarget.trim() : '';
    if (!target) continue;
    const prefix = typeof meta.proxyPrefix === 'string' && meta.proxyPrefix.startsWith('/')
      ? meta.proxyPrefix
      : `/${e.name}`;
    if (!/^\/[A-Za-z0-9_./-]+$/.test(prefix)) continue;
    const stripPrefix = meta.stripPrefix !== false; // default true
    out.push({ prefix, target, stripPrefix });
  }
  // Longest prefix first so /foo-bar wins over /foo when both are declared.
  out.sort((a, b) => b.prefix.length - a.prefix.length);
  return out;
}

function refreshStaticRoutes() {
  STATIC_ROUTES = buildStaticRoutes();
}

// ---------- ttyd routing ----------
// Each terminal "key" (project name, or 'develop' / 'wsl' for the admin
// terminals) is served by a systemd-managed ttyd unit that binds a unix
// socket under /run/ttyd/. SPEC §V.13, §V.36 — claude-hub never spawns ttyd
// itself; it just proxies /term/<key>/ to the systemd-bound socket.
//   - ttyd@<name>.service      → /run/ttyd/<name>.sock     (per project)
//   - ttyd-develop.service     → /run/ttyd/develop.sock    (admin: fresh claude)
//   - ttyd-wsl.service         → /run/ttyd/wsl.sock        (admin: raw bash)
const CLAUDE_BIN = process.env.CLAUDE_BIN || path.join(os.homedir(), '.local', 'bin', 'claude');
const TTYD_RUNTIME_DIR = '/run/ttyd';

const TERM_KEY_RE = /^[A-Za-z0-9_.-]+$/;

function ttydSocketPath(termKey) {
  if (!TERM_KEY_RE.test(termKey) || termKey === '.' || termKey === '..') return null;
  return path.join(TTYD_RUNTIME_DIR, `${termKey}.sock`);
}

// Synchronous lookup for /term/<key>/. Returns a route object pointing at
// the systemd-managed socket if it's bound; null otherwise.
function findTermRoute(url) {
  const m = /^\/term\/([A-Za-z0-9_.-]+)(?=\/|\?|$)/.exec(url);
  if (!m) return null;
  const name = m[1];
  const sockPath = ttydSocketPath(name);
  if (!sockPath) return null;
  try {
    if (!fs.statSync(sockPath).isSocket()) return null;
  } catch {
    return null;
  }
  return { prefix: `/term/${name}`, socketPath: sockPath, stripPrefix: false };
}

const proxy = httpProxy.createProxyServer({
  // Don't follow redirects ourselves; let the upstream answer.
  changeOrigin: false,
  ws: true,
  xfwd: true,
});

proxy.on('error', (err, _req, res) => {
  if (res && res.writeHead && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Bad gateway: ' + err.message);
  } else if (res && res.end) {
    res.end();
  }
});

function findStaticRoute(url) {
  for (const r of STATIC_ROUTES) {
    if (url === r.prefix || url.startsWith(r.prefix + '/') || url.startsWith(r.prefix + '?')) {
      return r;
    }
  }
  return null;
}

function findRoute(url) {
  const r = findStaticRoute(url);
  if (r) return r;
  return findTermRoute(url);
}

function rewriteUrl(req, route) {
  if (!route.stripPrefix) return;
  // Strip the prefix; ensure remaining URL begins with '/'.
  const rest = req.url.slice(route.prefix.length) || '/';
  req.url = rest.startsWith('/') ? rest : '/' + rest;
}

// Build the http-proxy target — either a TCP URL string or an object that
// carries socketPath for Unix-socket upstreams (ttyd).
function routeTarget(route) {
  if (route.socketPath) {
    return { socketPath: route.socketPath, host: 'localhost' };
  }
  return route.target;
}

// ---------- Generic JSON request/response helpers ----------
// Used by the projects API and the view-tree endpoint. Project-specific JSON
// CRUD belongs in the project's own backend, behind its own ROUTES entry.

function readJsonBody(req, res, maxBytes, cb) {
  let bytes = 0;
  const chunks = [];
  req.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      res.writeHead(413, { 'Content-Type': 'text/plain' });
      res.end('payload too large');
      req.destroy();
      cb(null, new Error('too large'));
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (res.headersSent) return;
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text.trim()) {
      cb(null);
      return;
    }
    try {
      cb(JSON.parse(text));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('invalid JSON: ' + e.message);
      cb(null, e);
    }
  });
  req.on('error', (e) => {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('read error: ' + e.message);
    }
    cb(null, e);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}


// ---------- Managed projects (the "+" card on the landing page) ----------
// A managed project is any directory under ~/projects/ that contains a
// .project-meta.json sentinel. The create flow:
//   1. POST /api/projects { name } — mkdir, write AGENTS.md + sentinel
//   2. sudo systemctl enable --now ttyd@<name>.service
//   3. wait for /run/ttyd/<name>.sock to appear (then /term/<name>/ resolves)
//   4. card shows up on the landing page; "Open" goes to /term/<name>/

// AGENTS.md is the agent-facing brief; humans get README.md. The landing
// page derives the card title (H1), description (first paragraph) and tags
// (frontmatter) from README.md, so the prompt below points claude there for
// anything user-visible.
function agentsTemplate(name) {
  return `# ${name} — AGENTS.md

This is the orientation doc for any agent (you) working in this project.
Human-facing details — project title, one-sentence summary, and tags — live
in \`README.md\`, which is what the landing page reads. Keep README current.

## Bootstrap

This folder was just created via the landing page's "+" card. A
\`ttyd@${name}.service\` systemd unit serves a browser terminal at
\`/term/${name}/\` (long-lived tmux session, \`claude --continue\`). Browse
files at \`/view/${name}/\`.

## What to do first

1. Ask the user what they want to build here.
2. Update \`README.md\`: rewrite the H1 (card title), rewrite the first
   paragraph (card description), and set \`tags: [...]\` in the YAML
   frontmatter (card badges) — short tags like \`Game\`, \`Tool\`, \`API\`,
   \`Library\`, \`Service\`, plus status flags like \`WIP\` or \`Stable\`.
3. Start scaffolding.
`;
}

function readmeTemplate(name) {
  return `---
tags: [WIP]
---

# ${name}

Replace this paragraph with a one-sentence description of what this project is. \
The landing page reads it as the card description.
`;
}

// Parse YAML-style frontmatter at the top of a markdown file. Handles flat
// `key: value` plus simple inline-list values like `tags: [a, b, "c d"]`.
function parseFrontmatter(content) {
  if (!content.startsWith('---')) return { meta: {}, body: content };
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!m) return { meta: {}, body: content };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*$/.exec(line);
    if (!kv) continue;
    let v = kv[2];
    const list = /^\[(.*)\]$/.exec(v);
    if (list) {
      meta[kv[1]] = list[1]
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
      continue;
    }
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    meta[kv[1]] = v;
  }
  return { meta, body: content.slice(m[0].length) };
}

// Best-effort markdown → plain text for card descriptions. Strips inline
// emphasis, links, images, and inline code so a description like
// `**Live Site:** [foo](url)` doesn't render as literal asterisks.
function stripInlineMarkdown(s) {
  return s
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/(^|\W)_(.+?)_(?=\W|$)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

// Returns { title, description, tags } from README.md. README is the canonical
// human-facing doc — title is the first H1, description is the first
// paragraph after it (markdown-stripped), tags is the frontmatter `tags:`
// list. AGENTS.md is intentionally NOT used here; it's the agent-facing brief.
function parseReadmeMeta(projectDir) {
  let content;
  for (const candidate of ['README.md', 'Readme.md', 'readme.md']) {
    try {
      content = fs.readFileSync(path.join(projectDir, candidate), 'utf8');
      break;
    } catch {}
  }
  if (content == null) return { title: null, description: null, tags: [] };
  const { meta, body } = parseFrontmatter(content);
  const lines = body.split('\n');
  let i = 0;
  // Skip leading blank lines, then look for the first H1.
  while (i < lines.length && !/^#\s+\S/.test(lines[i])) i++;
  let title = null;
  let description = null;
  if (i < lines.length) {
    title = lines[i].replace(/^#\s+/, '').trim() || null;
    i++;
    while (i < lines.length && lines[i].trim() === '') i++;
    const para = [];
    while (i < lines.length && lines[i].trim() !== '' && !lines[i].trim().startsWith('#')) {
      para.push(lines[i].trim());
      i++;
    }
    const text = stripInlineMarkdown(para.join(' '));
    if (text) description = text.slice(0, 400);
  }
  let tags = [];
  if (Array.isArray(meta.tags)) tags = meta.tags;
  else if (typeof meta.tags === 'string' && meta.tags.trim()) tags = [meta.tags.trim()];
  return { title, description, tags };
}

function listManagedProjects() {
  let entries;
  try {
    entries = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const name = e.name;
    if (!PROJECT_ID_RE.test(name) || name.startsWith('.')) continue;
    const dir = path.join(PROJECTS_ROOT, name);
    const metaPath = path.join(dir, '.project-meta.json');
    if (!fs.existsSync(metaPath)) continue;
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch {}
    const { title, description: readmeDesc, tags } = parseReadmeMeta(dir);
    const description = readmeDesc || meta.description || '';
    // Open URL defaults to the rendered README. Projects with a live app
    // override it via openUrl in .project-meta.json so the card's Open
    // button jumps straight to the running app.
    const openUrl = meta.openUrl || `/view/${name}/README.md`;
    out.push({
      name,
      title: title || name,
      description,
      tags: Array.isArray(tags) ? tags : [],
      openUrl,
      createdAt: meta.createdAt || null,
      termUrl: `/term/${name}/`,
      browseUrl: `/view/${name}/`,
    });
  }
  out.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  return out;
}

function waitForSocket(sockPath, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      try {
        if (fs.statSync(sockPath).isSocket()) return resolve(true);
      } catch {}
      if (Date.now() - start >= timeoutMs) return resolve(false);
      setTimeout(tick, 100);
    };
    tick();
  });
}

function handleListProjects(_req, res) {
  sendJson(res, 200, { projects: listManagedProjects() });
}

function handleDeleteProject(req, res, name) {
  if (!PROJECT_ID_RE.test(name) || name.startsWith('.')) {
    return sendJson(res, 400, { error: 'invalid name' });
  }
  if (RESERVED_PROJECT_NAMES.has(name)) {
    return sendJson(res, 403, { error: 'reserved name' });
  }
  const dir = path.join(PROJECTS_ROOT, name);
  // Resolve real path and double-check it stays inside PROJECTS_ROOT, so a
  // weird symlink can't trick rm -rf into nuking something outside.
  let real;
  try {
    real = fs.realpathSync(dir);
  } catch {
    return sendJson(res, 404, { error: 'project not found' });
  }
  if (real !== path.join(PROJECTS_ROOT, name)) {
    return sendJson(res, 400, { error: 'project path is a symlink — refusing to delete' });
  }
  // Only delete things that look managed (have the sentinel file).
  const metaPath = path.join(real, '.project-meta.json');
  if (!fs.existsSync(metaPath)) {
    return sendJson(res, 400, { error: 'not a managed project (no .project-meta.json)' });
  }
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch {}

  // The project's ttyd is a child of claude-hub — kill it directly, no sudo
  // needed. extraUnits is for project-side systemd units that the project
  // installed itself (e.g. its own backend service); those still go through
  // sudo systemctl. Each unit name is sanity-checked against a strict regex
  // so we don't hand systemctl arbitrary strings from on-disk JSON.
  const UNIT_NAME_RE = /^[A-Za-z0-9@_.:-]+\.(service|socket|timer)$/;
  const extraUnits = [];
  if (Array.isArray(meta.extraUnits)) {
    for (const u of meta.extraUnits) {
      if (typeof u === 'string' && UNIT_NAME_RE.test(u)) extraUnits.push(u);
    }
  }

  (async () => {
    // Every managed project runs a systemd-managed ttyd@<name>.service per
    // V13/V36; tear it down unconditionally before touching extraUnits or
    // the project directory.
    try {
      await execFileP('sudo', ['-n', 'systemctl', 'disable', '--now', `ttyd@${name}.service`], { timeout: 30000 });
    } catch (e) {
      return sendJson(res, 500, { error: 'systemctl disable failed for ttyd@: ' + e.message });
    }
    if (extraUnits.length > 0) {
      try {
        await execFileP('sudo', ['-n', 'systemctl', 'disable', '--now', ...extraUnits], { timeout: 30000 });
      } catch (e) {
        return sendJson(res, 500, { error: 'systemctl disable failed for extraUnits: ' + e.message });
      }
    }
    // Best-effort: kill any lingering tmux session for this project, ignoring
    // "no such session" errors.
    try { await execFileP('tmux', ['kill-session', '-t', name], { timeout: 5000 }); } catch {}
    fs.rm(real, { recursive: true, force: true }, (rmErr) => {
      if (rmErr) return sendJson(res, 500, { error: 'rm failed: ' + rmErr.message });
      refreshStaticRoutes();
      sendJson(res, 200, { name, deleted: true });
    });
  })();
}

// Optional git identity overrides for the "create new GitHub repo" flow.
// Empty by default — let `git` fall back to whatever the user has in their
// global gitconfig (or `gh auth`-derived identity) so we never bake a
// hardcoded author into commits. Set GIT_AUTHOR_NAME / GIT_AUTHOR_EMAIL in
// the environment to override.
const GIT_AUTHOR_NAME = process.env.GIT_AUTHOR_NAME || '';
const GIT_AUTHOR_EMAIL = process.env.GIT_AUTHOR_EMAIL || '';

// `gh repo list` cache for the create-project dialog dropdown. See V32.
const ghRepos = makeGhRepos({ exec: (cmd, args) => execFileP(cmd, args, { timeout: 15000 }) });

// Existing folder names under PROJECTS_ROOT (managed or not, hidden excluded).
// Used to suppress already-cloned/already-imported repos from the dialog.
function listProjectFolderNames() {
  try {
    return new Set(
      fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name),
    );
  } catch {
    return new Set();
  }
}

async function handleGhRepos(req, res) {
  try {
    const repos = await ghRepos.list();
    sendJson(res, 200, { repos: filterReposByFolders(repos, listProjectFolderNames()) });
  } catch (e) {
    sendJson(res, 503, { error: 'gh repo list failed: ' + e.message });
  }
}

function execFileP(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) {
        const e = new Error((stderr && String(stderr).trim()) || err.message);
        e.code = err.code;
        return reject(e);
      }
      resolve({ stdout, stderr });
    });
  });
}

async function bootstrapNoGithub(dir, name) {
  fs.mkdirSync(dir, { recursive: false });
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), agentsTemplate(name));
  fs.writeFileSync(path.join(dir, 'README.md'), readmeTemplate(name));
  fs.writeFileSync(
    path.join(dir, '.project-meta.json'),
    JSON.stringify({ name, createdAt: new Date().toISOString() }, null, 2) + '\n',
  );
  writeBootstrapPrompt(dir, name, 'greenfield');
}

async function bootstrapClone(dir, name, source) {
  // Let `gh repo clone` accept either a URL or owner/repo shorthand. If clone
  // fails the directory may have been partially created — clean it up so the
  // caller's "doesn't exist" precondition is restored on retry.
  try {
    await execFileP('gh', ['repo', 'clone', source, dir, '--', '--quiet'], {
      timeout: 120000,
    });
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error('clone failed: ' + e.message, { cause: e });
  }
  // V29: pre-existing AGENTS.md / README.md are NEVER overwritten. Missing
  // ones are NOT pre-filled with boilerplate either — claude scans the
  // cloned tree on first turn and writes whichever is missing (V30).
  // .project-meta.json is our sentinel; always write it.
  fs.writeFileSync(
    path.join(dir, '.project-meta.json'),
    JSON.stringify({
      name,
      createdAt: new Date().toISOString(),
      github: { mode: 'clone', source },
    }, null, 2) + '\n',
  );
  writeBootstrapPrompt(dir, name, 'scan-existing');
}

async function ghInitPush(dir, name, visibility) {
  const visFlag = visibility === 'public' ? '--public' : '--private';
  const gitEnv = [];
  if (GIT_AUTHOR_NAME) gitEnv.push('-c', `user.name=${GIT_AUTHOR_NAME}`);
  if (GIT_AUTHOR_EMAIL) gitEnv.push('-c', `user.email=${GIT_AUTHOR_EMAIL}`);
  await execFileP('git', [...gitEnv, '-C', dir, 'init', '-b', 'main'], { timeout: 10000 });
  await execFileP('git', [...gitEnv, '-C', dir, 'add', '.'], { timeout: 10000 });
  await execFileP('git', [...gitEnv, '-C', dir, 'commit', '-m', 'Initial commit'], { timeout: 10000 });
  // gh creates the remote, sets origin, and pushes in one step.
  await execFileP('gh', ['repo', 'create', name, visFlag, '--source', dir, '--push'], { timeout: 60000 });
}

async function bootstrapCreateRepo(dir, name, visibility) {
  await bootstrapNoGithub(dir, name);
  try {
    await ghInitPush(dir, name, visibility);
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error('repo setup failed: ' + e.message, { cause: e });
  }
  // Re-stamp meta with the resulting github mode.
  fs.writeFileSync(
    path.join(dir, '.project-meta.json'),
    JSON.stringify({
      name,
      createdAt: new Date().toISOString(),
      github: { mode: 'create', visibility: visibility === 'public' ? 'public' : 'private' },
    }, null, 2) + '\n',
  );
}

// Vite (React + TS) scaffold. Copies templates/vite/ → project dir with
// `<NAME>` and `<PORT>` placeholders replaced, stamps .project-meta.json,
// runs `npm install`, then enables the per-project vite@<name>.service.
// Cleans up on any failure so the caller's "doesn't exist" precondition is
// restored on retry. SPEC §V.21–V.26.
async function bootstrapVite(dir, name) {
  fs.mkdirSync(dir, { recursive: false });
  const port = allocatePort(PROJECTS_ROOT);
  const templateDir = path.join(__dirname, 'templates', 'vite');
  try {
    copyTemplate(templateDir, dir, { NAME: name, PORT: String(port) });
    // Write meta before npm install so a failed install still leaves a
    // recognizable managed project that DELETE /api/projects can clean up.
    fs.writeFileSync(
      path.join(dir, '.project-meta.json'),
      JSON.stringify({
        name,
        createdAt: new Date().toISOString(),
        template: 'vite',
        proxyTarget: 'http://127.0.0.1:' + port,
        proxyPrefix: '/' + name,
        stripPrefix: false,
        openUrl: '/' + name + '/',
        extraUnits: ['vite@' + name + '.service'],
      }, null, 2) + '\n',
    );
    await execFileP('/bin/bash', ['-lc', 'export NVM_DIR=$HOME/.nvm && . $NVM_DIR/nvm.sh && cd "$0" && npm install', dir], {
      timeout: 5 * 60 * 1000,
    });
    // sudoers grant for `sudo -n systemctl enable --now vite@<name>.service`
    // mirrors the existing ttyd@ grant — see services/ install instructions.
    await execFileP('sudo', ['-n', 'systemctl', 'enable', '--now', `vite@${name}.service`], {
      timeout: 30000,
    });
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error('vite scaffold failed: ' + e.message, { cause: e });
  }
  writeBootstrapPrompt(dir, name, 'greenfield');
  return port;
}

function handleListOrphans(_req, res) {
  sendJson(res, 200, { folders: listOrphanFolderNames(PROJECTS_ROOT) });
}

function handleCreateProject(req, res) {
  readJsonBody(req, res, 16 * 1024, async (body, err) => {
    if (err || body == null) return;
    if (typeof body !== 'object' || Array.isArray(body)) {
      return sendJson(res, 400, { error: 'expected object body' });
    }
    const raw = String(body.name || '').trim();
    const name = raw.toLowerCase().replace(/\s+/g, '-');
    if (!PROJECT_ID_RE.test(name) || name.startsWith('.')) {
      return sendJson(res, 400, { error: 'invalid name (use letters, digits, _ . -)' });
    }
    if (RESERVED_PROJECT_NAMES.has(name)) {
      return sendJson(res, 400, { error: `"${name}" is a reserved name` });
    }
    const dir = path.join(PROJECTS_ROOT, name);
    const gh = body.github || { mode: 'skip' };
    // Onboard adopts an existing folder, so its 404/409 logic lives in
    // bootstrapOnboard. Every other mode requires `dir` not yet exist.
    if (gh.mode !== 'onboard' && fs.existsSync(dir)) {
      return sendJson(res, 409, { error: 'project already exists' });
    }

    const template = effectiveTemplate(body);
    try {
      if (gh.mode === 'onboard') {
        await bootstrapOnboard(dir, name);
      } else if (gh.mode === 'clone') {
        // Cloned repos bring their own structure; ignore the template field.
        const source = String(gh.source || '').trim();
        if (!source) return sendJson(res, 400, { error: 'github.source required for clone' });
        // Loose validation: a repo identifier or a URL — but no shell metacharacters.
        if (!/^[A-Za-z0-9_./:@~-]+$/.test(source)) {
          return sendJson(res, 400, { error: 'invalid github source' });
        }
        await bootstrapClone(dir, name, source);
      } else if (gh.mode === 'create') {
        const visibility = gh.visibility === 'public' ? 'public' : 'private';
        if (template === 'vite') {
          await bootstrapVite(dir, name);
          try {
            await ghInitPush(dir, name, visibility);
          } catch (e) {
            fs.rmSync(dir, { recursive: true, force: true });
            throw new Error('repo setup failed: ' + e.message, { cause: e });
          }
        } else {
          await bootstrapCreateRepo(dir, name, visibility);
        }
      } else {
        if (template === 'vite') await bootstrapVite(dir, name);
        else await bootstrapNoGithub(dir, name);
      }
    } catch (e) {
      const status = Number.isInteger(e && e.statusCode) ? e.statusCode : 500;
      return sendJson(res, status, { error: e.message });
    }

    // V13/V36: every project gets a systemd-managed ttyd@<name>.service.
    // Enable + start, then wait for /run/ttyd/<name>.sock to appear so the
    // first /term/<name>/ proxy hit doesn't race the unit's binding.
    try {
      await execFileP('sudo', ['-n', 'systemctl', 'enable', '--now', `ttyd@${name}.service`], { timeout: 30000 });
    } catch (e) {
      return sendJson(res, 500, { error: 'systemctl enable ttyd@ failed: ' + e.message });
    }
    const sockPath = ttydSocketPath(name);
    const sockBound = await waitForSocket(sockPath, 5000);
    if (!sockBound) {
      return sendJson(res, 500, {
        error: `ttyd@${name}.service started but /run/ttyd/${name}.sock did not appear within 5s`,
      });
    }
    refreshStaticRoutes();
    sendJson(res, 200, {
      name,
      termUrl: `/term/${name}/`,
      browseUrl: `/view/${name}/`,
    });
  });
}

function serveLanding(res) {
  fs.readFile(LANDING_PATH, (err, body) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Failed to read landing.html: ' + err.message);
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  });
}

// ---------- /view/<project>/<path> read-only file browser ----------
const PROJECTS_ROOT = process.env.PROJECTS_ROOT || path.join(process.env.HOME || '/', 'projects');
// Publish PROJECTS_ROOT + CLAUDE_BIN so ttyd-attach.sh and any other child
// scripts inherit the same values (no per-spawn env wiring needed).
process.env.PROJECTS_ROOT = PROJECTS_ROOT;
process.env.CLAUDE_BIN = CLAUDE_BIN;

function isViewableProject(name) {
  if (!PROJECT_ID_RE.test(name)) return false;
  if (name === '.' || name === '..' || name.startsWith('.')) return false;
  try {
    return fs.statSync(path.join(PROJECTS_ROOT, name)).isDirectory();
  } catch {
    return false;
  }
}

// Languages keyed off file extension. highlight.js auto-detects what it doesn't
// know, but giving it a hint produces faster, more accurate colouring.
const HLJS_LANG = {
  '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
  '.mjs': 'javascript', '.cjs': 'javascript', '.json': 'json', '.css': 'css',
  '.html': 'xml', '.xml': 'xml', '.svg': 'xml', '.yaml': 'yaml', '.yml': 'yaml',
  '.toml': 'ini', '.ini': 'ini', '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash',
  '.py': 'python', '.rs': 'rust', '.go': 'go', '.java': 'java', '.kt': 'kotlin',
  '.swift': 'swift', '.rb': 'ruby', '.sql': 'sql', '.dockerfile': 'dockerfile',
  '.gradle': 'gradle', '.gitignore': 'plaintext', '.env': 'plaintext',
  '.txt': 'plaintext', '.log': 'plaintext', '.conf': 'ini',
};

const RENDER_AS_TEXT_MAX_BYTES = 2 * 1024 * 1024; // 2 MB cap for code/text view
const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp',
  '.mp3', '.wav', '.ogg', '.flac', '.m4a',
  '.mp4', '.webm', '.mov', '.mkv',
  '.pdf', '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z',
  '.so', '.dylib', '.dll', '.exe', '.bin', '.dat',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
]);

// Serve raw bytes (no rendering) for these — image/audio/video etc. — so the
// viewer page can <img>/<audio>/<video> them by adding `?raw=1`.
const RAW_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.flac': 'audio/flac', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.pdf': 'application/pdf',
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
};

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function viewerShell(title, breadcrumb, body, extraHead, opts = {}) {
  // embed=true is used when this view is rendered inside an iframe by the
  // two-pane shell — the shell already has its own breadcrumb + chrome, so
  // we strip the header and tighten padding.
  const embed = !!opts.embed;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; --bg-0:#050810; --bg-1:#0d1320; --bg-2:#131b2c;
    --fg:#e2e8f0; --muted:#94a3b8; --accent:#7dd3fc; --edge:#1f2937; }
  * { box-sizing: border-box; }
  html, body { margin:0; background:var(--bg-0); color:var(--fg);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  body { padding: 16px 20px 40px; max-width: 1100px; margin: 0 auto; }
  header { display:flex; align-items:center; gap:8px; flex-wrap:wrap;
    padding: 10px 0 14px; border-bottom: 1px solid var(--edge); margin-bottom: 18px; }
  header a { color: var(--accent); text-decoration: none; font-size: 0.92rem; }
  header a:hover { text-decoration: underline; }
  header .sep { color: var(--muted); }
  header .home { color: var(--muted); padding-right: 6px; border-right: 1px solid var(--edge); margin-right: 4px; }
  ul.dir { list-style: none; margin: 0; padding: 0; }
  ul.dir li { padding: 4px 0; }
  ul.dir a { color: var(--fg); text-decoration: none; }
  ul.dir a:hover { color: var(--accent); }
  ul.dir .meta { color: var(--muted); font-size: 0.8rem; margin-left: 8px; }
  ul.dir .dir-icon { color: var(--accent); margin-right: 6px; }
  ul.dir .file-icon { color: var(--muted); margin-right: 6px; }
  pre { background: var(--bg-1); border: 1px solid var(--edge); border-radius: 8px;
    padding: 14px 16px; overflow-x: auto; font-size: 13px; line-height: 1.5;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  /* markdown body */
  .md h1, .md h2, .md h3 { letter-spacing: -0.01em; }
  .md h1 { border-bottom: 1px solid var(--edge); padding-bottom: 8px; }
  .md a { color: var(--accent); }
  .md code { background: var(--bg-1); padding: 1px 6px; border-radius: 4px; font-size: 0.9em; }
  .md pre code { background: none; padding: 0; }
  .md blockquote { border-left: 3px solid var(--edge); margin: 0; padding: 4px 14px; color: var(--muted); }
  .md table { border-collapse: collapse; }
  .md th, .md td { border: 1px solid var(--edge); padding: 6px 10px; }
  .md img { max-width: 100%; border-radius: 6px; }
  .empty { color: var(--muted); font-style: italic; padding: 12px 0; }
  .raw-link { color: var(--muted); font-size: 0.82rem; }
  .raw-link:hover { color: var(--accent); }
  /* YAML frontmatter shown above markdown body */
  pre.frontmatter {
    background: var(--bg-2);
    border: 1px solid var(--edge);
    border-left: 3px solid var(--accent);
    border-radius: 6px;
    padding: 10px 14px;
    margin: 0 0 18px;
    font-size: 12px;
    line-height: 1.5;
    color: var(--muted);
    overflow-x: auto;
  }
  pre.frontmatter .fm-key { color: var(--accent); }
  pre.frontmatter .fm-punct { color: var(--muted); opacity: 0.7; }
  pre.frontmatter .fm-str { color: var(--fg); }
  ${embed ? `body { padding: 12px 16px 24px; max-width: none; }` : ''}
</style>
${extraHead || ''}
</head>
<body>
${embed ? '' : `<header>
<a class="home" href="/">claude-hub</a>
${breadcrumb}
</header>`}
${body}
</body>
</html>`;
}

function renderBreadcrumb(project, relPath) {
  const parts = relPath.split('/').filter(Boolean);
  const out = [`<a href="/view/${encodeURIComponent(project)}/">${escapeHtml(project)}</a>`];
  let cur = '';
  for (let i = 0; i < parts.length; i++) {
    cur += '/' + parts[i];
    const isLast = i === parts.length - 1;
    out.push('<span class="sep">/</span>');
    if (isLast) {
      out.push(`<span>${escapeHtml(parts[i])}</span>`);
    } else {
      out.push(
        `<a href="/view/${encodeURIComponent(project)}${cur.split('/').map(encodeURIComponent).join('/')}/">${escapeHtml(parts[i])}</a>`,
      );
    }
  }
  return out.join(' ');
}

// Recursively scan a project root and return a hierarchical tree for the
// two-pane viewer's left rail. Skips noisy directories (node_modules etc.)
// and caps total node count so a runaway tree can't blow up the response.
const VIEW_TREE_HIDDEN_DIRS = new Set(['node_modules', '.git', '.serve', 'dist', 'build', '.next', '.cache']);
const VIEW_TREE_MAX_NODES = 5000;

// Returns Set of project-relative paths that git considers ignored
// (untracked + matched by .gitignore / global excludes / .git/info/exclude).
// `--directory` collapses ignored dirs to their dirname so we don't pay for
// listing the contents (especially relevant for node_modules). Returns an
// empty Set if the project isn't a git repo or the call fails.
function computeGitIgnored(projectRoot) {
  if (!fs.existsSync(path.join(projectRoot, '.git'))) return new Set();
  try {
    const out = execFileSync(
      'git',
      ['-C', projectRoot, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory'],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024 },
    );
    const set = new Set();
    for (const line of out.split('\n')) {
      const p = line.replace(/\/$/, '').trim();
      if (p) set.add(p);
    }
    return set;
  } catch {
    return new Set();
  }
}

// Build the rules deciding which entries should be rendered dim. If the
// project has gitignore output, that's the source of truth; otherwise we
// fall back to the hardcoded VIEW_TREE_HIDDEN_DIRS list (covers non-git
// projects and bare repos without a .gitignore). The .git directory itself
// is always dim — it's never in .gitignore but obviously noise to browse.
function makeDimRules(projectRoot) {
  const gitIgnored = computeGitIgnored(projectRoot);
  const useHardcoded = gitIgnored.size === 0;
  return {
    isDim(name, relPath, isDir) {
      if (isDir && name === '.git') return true;
      if (gitIgnored.has(relPath)) return true;
      if (useHardcoded && isDir && VIEW_TREE_HIDDEN_DIRS.has(name)) return true;
      return false;
    },
    // For lazy-load context, the parent path is dim if any segment is in the
    // dim set or the path itself is gitignored.
    pathIsDim(relPath) {
      if (gitIgnored.has(relPath)) return true;
      const segments = relPath.split('/').filter(Boolean);
      if (segments.includes('.git')) return true;
      if (useHardcoded && segments.some((s) => VIEW_TREE_HIDDEN_DIRS.has(s))) return true;
      return false;
    },
  };
}

function buildFileTree(rootAbs, rules) {
  let count = 0;
  function walk(dir, relPath) {
    if (count >= VIEW_TREE_MAX_NODES) return [];
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const dirs = [];
    const files = [];
    for (const e of entries) {
      count++;
      if (count > VIEW_TREE_MAX_NODES) break;
      const childRel = relPath ? `${relPath}/${e.name}` : e.name;
      const isDim = rules.isDim(e.name, childRel, e.isDirectory());
      if (e.isDirectory()) {
        // Dim dirs aren't recursed eagerly — the client lazy-loads them on
        // first expand. Stops node_modules etc. from blowing the node cap.
        dirs.push({
          name: e.name,
          type: 'dir',
          path: childRel,
          dim: isDim || undefined,
          children: isDim ? [] : walk(path.join(dir, e.name), childRel),
        });
      } else if (e.isFile()) {
        files.push({
          name: e.name, type: 'file', path: childRel,
          dim: isDim || undefined,
        });
      }
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));
    return [...dirs, ...files];
  }
  return walk(rootAbs, '');
}

function handleViewTree(req, res, project) {
  if (!isViewableProject(project)) return sendJson(res, 404, { error: 'unknown project' });
  const projectRoot = path.join(PROJECTS_ROOT, project);
  const rules = makeDimRules(projectRoot);
  const qs = req.url.split('?')[1] || '';
  const params = new URLSearchParams(qs);
  const subPath = params.get('path');

  if (subPath != null && subPath !== '') {
    // Lazy-load: one level of children for the requested subdirectory. Used
    // by the client when a dim dir is expanded — we don't walk it eagerly
    // because it may contain tens of thousands of files. Anything inside a
    // dim dir inherits dim.
    const decoded = subPath.split('/').map((s) => {
      try { return decodeURIComponent(s); } catch { return s; }
    }).join('/');
    const abs = path.resolve(projectRoot, decoded);
    if (abs !== projectRoot && !abs.startsWith(projectRoot + path.sep)) {
      return sendJson(res, 400, { error: 'path escapes project root' });
    }
    const inDimContext = rules.pathIsDim(decoded);
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return sendJson(res, 404, { error: 'not found' });
    }
    const dirs = [];
    const files = [];
    for (const e of entries) {
      const childRel = `${decoded}/${e.name}`;
      const childDim = inDimContext || rules.isDim(e.name, childRel, e.isDirectory());
      if (e.isDirectory()) {
        dirs.push({
          name: e.name, type: 'dir', path: childRel,
          dim: childDim || undefined, children: [],
        });
      } else if (e.isFile()) {
        files.push({
          name: e.name, type: 'file', path: childRel,
          dim: childDim || undefined,
        });
      }
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));
    return sendJson(res, 200, { project, path: decoded, entries: [...dirs, ...files] });
  }

  const tree = buildFileTree(projectRoot, rules);
  sendJson(res, 200, { project, tree });
}

// ---------- /ws/view-tree/<project> live tree updates ----------
// One fs.watch per project, shared across all connected clients. Started on
// the first WS connection, torn down when the last client disconnects. The
// recursive watch fires for every descendant change; we filter dim paths
// (gitignored, .git, node_modules) so the wire stays quiet on builds.
const viewTreeWss = new WebSocketServer({ noServer: true });
const projectWatchers = new Map(); // project -> { watcher, clients, pending, dimRules }

// Walk projectRoot once to seed the "what we already announced" sets so that
// subsequent fs.watch events for already-known paths can be classified as
// 'change' (file content edited, in-place) instead of 'add' (new entry).
function seedKnownPaths(projectRoot, rules) {
  const knownFiles = new Set();
  const knownDirs = new Set();
  function walk(dir, rel) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const childRel = rel ? rel + '/' + e.name : e.name;
      if (rules.isDim(e.name, childRel, e.isDirectory())) continue;
      if (e.isDirectory()) {
        knownDirs.add(childRel);
        walk(path.join(dir, e.name), childRel);
      } else if (e.isFile()) {
        knownFiles.add(childRel);
      }
    }
  }
  walk(projectRoot, '');
  return { knownFiles, knownDirs };
}

function getOrCreateWatcher(project) {
  let entry = projectWatchers.get(project);
  if (entry) return entry;
  const projectRoot = path.join(PROJECTS_ROOT, project);
  let watcher;
  try {
    watcher = fs.watch(projectRoot, { recursive: true, persistent: true });
  } catch (e) {
    console.warn('[view-tree-ws] watch failed for', project, '-', e.message);
    return null;
  }
  const clients = new Set();
  const pending = new Map();
  let dimRules = makeDimRules(projectRoot);
  const { knownFiles, knownDirs } = seedKnownPaths(projectRoot, dimRules);
  // Refresh dim rules on a slow cadence so newly-gitignored entries stop
  // pushing events without forcing the client to reconnect.
  const dimRefresh = setInterval(() => { dimRules = makeDimRules(projectRoot); }, 30_000);
  if (typeof dimRefresh.unref === 'function') dimRefresh.unref();

  watcher.on('error', (e) => {
    console.warn('[view-tree-ws] watcher error', project, '-', e.message);
  });
  watcher.on('change', (_eventType, filename) => {
    if (!filename) return;
    const rel = String(filename).split(path.sep).join('/');
    if (!rel || rel === '.') return;
    if (dimRules.pathIsDim(rel)) return;
    const segs = rel.split('/');
    if (segs.some((s) => VIEW_TREE_HIDDEN_DIRS.has(s) || s === '.git')) return;
    // Coalesce duplicate events: stat after a short delay so add+remove or
    // multi-fire renames settle to a single message.
    if (pending.has(rel)) clearTimeout(pending.get(rel));
    pending.set(rel, setTimeout(() => {
      pending.delete(rel);
      const abs = path.join(projectRoot, rel);
      let kind = null;
      let exists = false;
      try {
        const s = fs.statSync(abs);
        exists = true;
        kind = s.isDirectory() ? 'dir' : 'file';
      } catch {}
      let msg = null;
      if (exists && kind === 'file') {
        if (knownFiles.has(rel)) {
          msg = JSON.stringify({ type: 'change', path: rel });
        } else {
          knownFiles.add(rel);
          msg = JSON.stringify({ type: 'add', path: rel, kind: 'file' });
        }
      } else if (exists && kind === 'dir') {
        // A 'change' event on an already-known dir = its contents changed;
        // those mutations fire their own per-child events, so swallow it.
        if (!knownDirs.has(rel)) {
          knownDirs.add(rel);
          msg = JSON.stringify({ type: 'add', path: rel, kind: 'dir' });
        }
      } else {
        // Stat failed → entry deleted.
        const wasDir = knownDirs.delete(rel);
        const wasFile = knownFiles.delete(rel);
        if (wasDir) {
          // Drop descendants too — Linux recursive watch won't always fire
          // an event per child when the parent dir is removed wholesale.
          const pre = rel + '/';
          for (const k of knownFiles) if (k.startsWith(pre)) knownFiles.delete(k);
          for (const k of knownDirs) if (k.startsWith(pre)) knownDirs.delete(k);
        }
        if (wasDir || wasFile) {
          msg = JSON.stringify({ type: 'delete', path: rel });
        }
      }
      if (!msg) return;
      for (const ws of clients) {
        if (ws.readyState === ws.OPEN) {
          try { ws.send(msg); } catch {}
        }
      }
    }, 50));
  });

  entry = { watcher, clients, pending, dimRefresh };
  projectWatchers.set(project, entry);
  return entry;
}

function releaseWatcher(project, ws) {
  const entry = projectWatchers.get(project);
  if (!entry) return;
  entry.clients.delete(ws);
  if (entry.clients.size === 0) {
    for (const t of entry.pending.values()) clearTimeout(t);
    entry.pending.clear();
    clearInterval(entry.dimRefresh);
    try { entry.watcher.close(); } catch {}
    projectWatchers.delete(project);
  }
}

// The two-pane viewer shell. Left rail: collapsible tree from /api/view-tree.
// Right pane: tab strip + per-tab iframe pointing at the existing file-view
// endpoint with ?embed=1 (which suppresses the per-page header). README.md
// (case-insensitive) opens in the initial tab if present.
function renderViewShell(project) {
  const safeProject = escapeHtml(project);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${safeProject} — view</title>
<style>
  :root { color-scheme: dark; --bg-0:#050810; --bg-1:#0d1320; --bg-2:#131b2c;
    --fg:#e2e8f0; --muted:#94a3b8; --accent:#7dd3fc; --edge:#1f2937; }
  * { box-sizing: border-box; }
  html, body { margin:0; height:100%; background:var(--bg-0); color:var(--fg);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  body { display: flex; flex-direction: column; }
  header.bar { display:flex; align-items:center; gap:8px; padding: 8px 14px;
    border-bottom: 1px solid var(--edge); font-size: 0.9rem; flex: 0 0 auto; }
  header.bar a { color: var(--accent); text-decoration: none; }
  header.bar a:hover { text-decoration: underline; }
  header.bar .home { color: var(--muted); padding-right: 6px; border-right: 1px solid var(--edge); margin-right: 4px; }
  header.bar .sep { color: var(--muted); margin: 0 2px; }
  header.bar .spacer { flex: 1 1 auto; }
  header.bar .header-btn {
    display: inline-flex; align-items: center; justify-content: center;
    background: transparent; color: var(--muted);
    border: 1px solid var(--edge); border-radius: 6px;
    padding: 4px 8px; cursor: pointer; line-height: 1;
    transition: color 0.15s, border-color 0.15s, background 0.15s;
  }
  header.bar .header-btn:hover { color: var(--accent); border-color: var(--accent); }
  header.bar .header-btn.active { color: var(--accent); border-color: var(--accent); background: rgba(125,211,252,0.12); }
  main { flex: 1 1 auto; display: flex; min-height: 0; }
  /* Left pane */
  aside.tree-pane {
    flex: 0 0 var(--tree-width, 240px);
    min-width: 140px;
    overflow: auto;
    background: var(--bg-1);
    border-right: 1px solid var(--edge);
    padding: 10px 8px 20px;
    font-size: 0.85rem;
  }
  ul.tree, ul.tree ul { list-style: none; margin: 0; padding: 0; }
  ul.tree ul { padding-left: 14px; border-left: 1px dotted var(--edge); margin-left: 6px; }
  .tree details { margin: 0; }
  .tree summary {
    cursor: pointer; padding: 2px 4px; border-radius: 4px;
    list-style: none; user-select: none; color: var(--fg);
    display: flex; align-items: center; gap: 4px;
  }
  .tree summary::-webkit-details-marker { display: none; }
  .tree summary::before {
    content: '▸'; color: var(--muted); font-size: 0.7rem; width: 10px; display: inline-block;
    transition: transform 0.1s;
  }
  .tree details[open] > summary::before { transform: rotate(90deg); }
  .tree summary:hover, .tree .file:hover { background: var(--bg-2); }
  .tree .dim > summary, .tree .file.dim { opacity: 0.45; }
  .tree .dim > summary .dir-name { color: var(--muted); }
  .tree .file {
    display: flex; align-items: center; gap: 4px;
    padding: 2px 4px 2px 14px; border-radius: 4px;
    cursor: pointer; color: var(--fg);
  }
  .tree .file.active { background: var(--bg-2); color: var(--accent); }
  .tree .dir-name { color: var(--accent); }
  .tree .file-name { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tree .file-action {
    border: none; background: transparent; color: var(--muted);
    padding: 0 4px; border-radius: 4px; cursor: pointer;
    display: inline-flex; align-items: center; opacity: 0;
    transition: opacity 0.1s, color 0.1s, background 0.1s;
  }
  .tree .file:hover .file-action, .tree .file-action:focus-visible { opacity: 1; }
  .tree .file-action:hover { color: var(--accent); background: rgba(125,211,252,0.15); }
  .tree-empty { color: var(--muted); font-style: italic; padding: 10px 4px; font-size: 0.82rem; }
  /* Splitter */
  .splitter {
    flex: 0 0 5px; cursor: col-resize; background: transparent;
    border-left: 1px solid var(--edge); border-right: 1px solid var(--edge);
    transition: background 0.15s;
  }
  .splitter:hover, .splitter.dragging { background: var(--accent); }
  body.resizing { cursor: col-resize; user-select: none; }
  body.resizing iframe { pointer-events: none; }
  /* Right pane */
  section.viewer-pane { flex: 1 1 auto; display: flex; flex-direction: column; min-width: 0; }
  .tabs {
    display: flex; align-items: stretch; flex: 0 0 auto;
    background: var(--bg-1); border-bottom: 1px solid var(--edge);
    overflow-x: auto; scrollbar-width: thin;
  }
  .tab {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 7px 8px 7px 12px; font-size: 0.82rem;
    color: var(--muted); cursor: pointer; white-space: nowrap;
    border-right: 1px solid var(--edge);
    border-top: 2px solid transparent;
    transition: background 0.1s, color 0.1s;
  }
  .tab:hover { background: var(--bg-2); color: var(--fg); }
  .tab.active { background: var(--bg-0); color: var(--accent); border-top-color: var(--accent); }
  .tab .mode-tag {
    font-size: 0.62rem; letter-spacing: 0.06em; text-transform: uppercase;
    color: var(--muted); padding: 1px 5px; border: 1px solid var(--edge); border-radius: 4px;
  }
  .tab.active .mode-tag { color: var(--accent); border-color: var(--accent); }
  .tab .close {
    border: none; background: transparent; color: inherit;
    font-size: 0.95rem; line-height: 1; padding: 2px 4px;
    border-radius: 4px; cursor: pointer; opacity: 0.6;
  }
  .tab .close:hover { opacity: 1; background: rgba(252,165,165,0.15); color: #fca5a5; }
  .frames { flex: 1 1 auto; position: relative; min-height: 0; background: var(--bg-0); }
  .frames iframe {
    position: absolute; inset: 0; width: 100%; height: 100%;
    border: none; background: var(--bg-0);
    display: none;
  }
  .frames iframe.active { display: block; }
  .empty-state {
    position: absolute; inset: 0; display: flex; align-items: center;
    justify-content: center; color: var(--muted); font-style: italic; font-size: 0.9rem;
  }
  /* Develop pane */
  section.develop-pane {
    flex: 0 0 var(--develop-width, 50%);
    min-width: 240px;
    display: flex; flex-direction: column;
    background: var(--bg-0);
    border-left: 1px solid var(--edge);
  }
  section.develop-pane iframe {
    flex: 1 1 auto; width: 100%; border: none; background: var(--bg-0);
  }
  section.develop-pane[hidden], .splitter.develop-splitter[hidden] { display: none; }
</style>
</head>
<body>
<header class="bar">
  <a class="home" href="/">claude-hub</a>
  <a href="/view/${safeProject}/">${safeProject}</a>
  <span class="sep">·</span>
  <span style="color: var(--muted);" id="path-hint">browse</span>
  <span class="spacer"></span>
  <button id="develop-toggle" class="header-btn" type="button" title="Toggle develop pane" aria-label="Toggle develop pane">
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/>
      <path d="M4 6l2 2-2 2"/>
      <path d="M8 10h4"/>
    </svg>
  </button>
</header>
<main id="main">
  <aside class="tree-pane" id="tree-pane">
    <div class="tree-empty">loading…</div>
  </aside>
  <div class="splitter" id="splitter" title="Drag to resize"></div>
  <section class="viewer-pane">
    <div class="tabs" id="tabs"></div>
    <div class="frames" id="frames">
      <div class="empty-state" id="empty-state" hidden>No file open. Click a file in the tree.</div>
    </div>
  </section>
  <div class="splitter develop-splitter" id="develop-splitter" title="Drag to resize" hidden></div>
  <section class="develop-pane" id="develop-pane" hidden>
    <iframe id="develop-frame" title="Develop terminal"></iframe>
  </section>
</main>
<script>
const PROJECT = ${JSON.stringify(project)};
const TREE_PANE = document.getElementById('tree-pane');
const TABS = document.getElementById('tabs');
const FRAMES = document.getElementById('frames');
const EMPTY = document.getElementById('empty-state');
const PATH_HINT = document.getElementById('path-hint');
const SPLITTER = document.getElementById('splitter');
const MAIN = document.getElementById('main');
const DEVELOP_PANE = document.getElementById('develop-pane');
const DEVELOP_SPLITTER = document.getElementById('develop-splitter');
const DEVELOP_FRAME = document.getElementById('develop-frame');
const DEVELOP_TOGGLE = document.getElementById('develop-toggle');

// Tab state. Map<key, { path, mode, tab, frame }>. Composite key lets the
// same file open in both 'view' and 'render' modes side by side.
const tabs = new Map();
let activeKey = null;

const TABS_KEY = 'view-shell:tabs:' + PROJECT;
const ACTIVE_KEY = 'view-shell:active:' + PROJECT;
const TREE_WIDTH_KEY = 'view-shell:tree-width';
const DEVELOP_VISIBLE_KEY = 'view-shell:develop-visible:' + PROJECT;
const DEVELOP_WIDTH_KEY = 'view-shell:develop-width:' + PROJECT;
const SCROLL_KEY_PREFIX = 'view-shell:scroll:' + PROJECT + ':';

function scrollStorageKey(key) { return SCROLL_KEY_PREFIX + key; }
function saveTabScroll(key, x, y) {
  try { localStorage.setItem(scrollStorageKey(key), JSON.stringify([x, y])); } catch {}
}
function loadTabScroll(key) {
  try {
    const raw = localStorage.getItem(scrollStorageKey(key));
    if (!raw) return null;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length !== 2) return null;
    return { x: Number(arr[0]) || 0, y: Number(arr[1]) || 0 };
  } catch { return null; }
}
function clearTabScroll(key) {
  try { localStorage.removeItem(scrollStorageKey(key)); } catch {}
}

// Wire scroll persistence onto a freshly-loaded iframe. Throttled writes
// (250ms debounce) keep localStorage churn bounded; restore on initial load
// so refresh + tab reopen land at the previous offset.
function wireFrameScroll(frame, key) {
  let saveTimer = null;
  const onScroll = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        const w = frame.contentWindow;
        if (!w) return;
        saveTabScroll(key, w.scrollX || w.pageXOffset || 0, w.scrollY || w.pageYOffset || 0);
      } catch {}
    }, 250);
  };
  const onLoad = () => {
    try {
      const w = frame.contentWindow;
      if (!w) return;
      const saved = loadTabScroll(key);
      if (saved) w.scrollTo(saved.x, saved.y);
      w.addEventListener('scroll', onScroll, { passive: true });
    } catch {}
  };
  frame.addEventListener('load', onLoad);
}

${tabKey.toString()}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const EYE_SVG = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/>'
  + '<circle cx="8" cy="8" r="2"/>'
  + '</svg>';

function isHtmlFile(name) { return /\\.html?$/i.test(name); }

function renderNode(n) {
  const li = document.createElement('li');
  if (n.type === 'dir') {
    const det = document.createElement('details');
    det.className = 'tree-details';
    det.dataset.path = n.path;
    if (n.dim) det.classList.add('dim');
    const sum = document.createElement('summary');
    const span = document.createElement('span');
    span.className = 'dir-name';
    span.textContent = n.name;
    sum.appendChild(span);
    det.appendChild(sum);
    if (n.children && n.children.length > 0) buildTree(n.children, det);
    if (n.dim) wireDimLazyLoad(det, n.path);
    li.appendChild(det);
  } else {
    const fileEl = document.createElement('div');
    fileEl.className = 'file' + (n.dim ? ' dim' : '');
    fileEl.dataset.path = n.path;
    const nameSpan = document.createElement('span');
    nameSpan.className = 'file-name';
    nameSpan.textContent = n.name;
    fileEl.appendChild(nameSpan);
    fileEl.addEventListener('click', () => openTab(n.path, 'view'));
    if (isHtmlFile(n.name)) {
      const eyeBtn = document.createElement('button');
      eyeBtn.type = 'button';
      eyeBtn.className = 'file-action';
      eyeBtn.title = 'Render in iframe';
      eyeBtn.setAttribute('aria-label', 'Render ' + n.name + ' in iframe');
      eyeBtn.innerHTML = EYE_SVG;
      eyeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openTab(n.path, 'render');
      });
      fileEl.appendChild(eyeBtn);
    }
    li.appendChild(fileEl);
  }
  return li;
}

function buildTree(nodes, container) {
  if (!nodes || nodes.length === 0) return;
  const ul = document.createElement('ul');
  ul.className = 'tree';
  for (const n of nodes) ul.appendChild(renderNode(n));
  container.appendChild(ul);
}

// Find or create the child list of parentPath (use empty string for root).
// Returns null if the parent isn't rendered (e.g. collapsed lazy-load dim dir).
function findChildList(parentPath) {
  if (!parentPath) {
    let ul = TREE_PANE.querySelector(':scope > ul.tree');
    if (!ul) {
      ul = document.createElement('ul');
      ul.className = 'tree';
      TREE_PANE.appendChild(ul);
    }
    return ul;
  }
  const det = TREE_PANE.querySelector('details.tree-details[data-path="' + CSS.escape(parentPath) + '"]');
  if (!det) return null;
  let ul = det.querySelector(':scope > ul.tree');
  if (!ul) {
    ul = document.createElement('ul');
    ul.className = 'tree';
    det.appendChild(ul);
  }
  return ul;
}

function entryInfoFromLi(li) {
  const det = li.querySelector(':scope > details.tree-details');
  if (det) {
    const nameEl = det.querySelector(':scope > summary > .dir-name');
    return { kind: 'dir', name: nameEl ? nameEl.textContent : '' };
  }
  const file = li.querySelector(':scope > .file');
  if (file) {
    const nameEl = file.querySelector(':scope > .file-name');
    return { kind: 'file', name: nameEl ? nameEl.textContent : '' };
  }
  return null;
}

function insertSorted(ul, newLi, kind, name) {
  for (const child of ul.children) {
    const info = entryInfoFromLi(child);
    if (!info) continue;
    if (kind === 'dir' && info.kind === 'file') {
      ul.insertBefore(newLi, child);
      return;
    }
    if (kind === 'file' && info.kind === 'dir') continue;
    if (info.kind === kind && info.name.localeCompare(name) > 0) {
      ul.insertBefore(newLi, child);
      return;
    }
  }
  ul.appendChild(newLi);
}

function handleAdd(p, kind) {
  if (!p || !kind) return;
  const parts = p.split('/');
  const name = parts.pop();
  const parentPath = parts.join('/');
  const ul = findChildList(parentPath);
  if (!ul) return; // parent not rendered yet
  // Skip duplicates: if a node with this path already exists, leave it alone.
  if (TREE_PANE.querySelector('[data-path="' + CSS.escape(p) + '"]')) return;
  const node = kind === 'dir'
    ? { type: 'dir', name, path: p, children: [] }
    : { type: 'file', name, path: p };
  insertSorted(ul, renderNode(node), kind, name);
}

function handleDelete(p) {
  if (!p) return;
  const fileEl = TREE_PANE.querySelector('.file[data-path="' + CSS.escape(p) + '"]');
  if (fileEl) {
    const li = fileEl.closest('li');
    if (li) li.remove();
    closeTabsForPath(p);
    return;
  }
  const det = TREE_PANE.querySelector('details.tree-details[data-path="' + CSS.escape(p) + '"]');
  if (det) {
    closeTabsUnderPath(p);
    const li = det.closest('li');
    if (li) li.remove();
  }
}

function closeTabsForPath(p) {
  for (const key of Array.from(tabs.keys())) {
    const info = tabs.get(key);
    if (info && info.path === p) closeTab(key);
  }
}

function closeTabsUnderPath(prefix) {
  const pre = prefix + '/';
  for (const key of Array.from(tabs.keys())) {
    const info = tabs.get(key);
    if (info && (info.path === prefix || info.path.startsWith(pre))) closeTab(key);
  }
}

// File content changed on disk — reload every tab pointing at it, restoring
// scroll position so the user doesn't lose their place. Both 'view' and
// 'render' tabs reload; both come from same-origin URLs so contentWindow
// scroll access works.
function handleChange(p) {
  for (const [, info] of tabs) {
    if (info.path === p) reloadTabFrame(info);
  }
}

function reloadTabFrame(info) {
  const frame = info.frame;
  let prevX = 0;
  let prevY = 0;
  try {
    const w = frame.contentWindow;
    if (w) {
      prevX = w.scrollX || w.pageXOffset || 0;
      prevY = w.scrollY || w.pageYOffset || 0;
    }
  } catch {}
  // Cache-bust with a timestamp param so the browser actually re-fetches
  // even when its disk cache thinks the page is fresh. Strip any prior _t=
  // first so the URL doesn't grow unbounded.
  let next = frame.src.split('#')[0].replace(/([?&])_t=\\d+(?:&|$)/, (_m, sep) => sep === '?' ? '?' : '');
  next = next.replace(/[?&]$/, '');
  next += (next.includes('?') ? '&' : '?') + '_t=' + Date.now();
  const onLoad = () => {
    frame.removeEventListener('load', onLoad);
    try {
      const w = frame.contentWindow;
      if (w && (prevX || prevY)) w.scrollTo(prevX, prevY);
    } catch {}
  };
  frame.addEventListener('load', onLoad);
  frame.src = next;
}

// Fetch and inject children the first time a dim directory is expanded.
function wireDimLazyLoad(detailsEl, dirPath) {
  let loaded = false;
  detailsEl.addEventListener('toggle', async () => {
    if (!detailsEl.open || loaded) return;
    loaded = true;
    const loading = document.createElement('div');
    loading.className = 'tree-empty';
    loading.style.cssText = 'font-size:0.75rem;padding:2px 18px;';
    loading.textContent = 'loading…';
    detailsEl.appendChild(loading);
    try {
      const url = '/api/view-tree/' + encodeURIComponent(PROJECT)
        + '?path=' + encodeURIComponent(dirPath);
      const r = await fetch(url);
      const data = await r.json();
      loading.remove();
      if (!r.ok) throw new Error(data.error || r.statusText);
      if (!data.entries || data.entries.length === 0) {
        const hint = document.createElement('div');
        hint.className = 'tree-empty';
        hint.style.cssText = 'font-size:0.75rem;padding:2px 18px;';
        hint.textContent = '(empty)';
        detailsEl.appendChild(hint);
      } else {
        buildTree(data.entries, detailsEl);
      }
    } catch (err) {
      loading.remove();
      const hint = document.createElement('div');
      hint.className = 'tree-empty';
      hint.style.cssText = 'font-size:0.75rem;padding:2px 18px;color:#fca5a5;';
      hint.textContent = 'load failed: ' + err.message;
      detailsEl.appendChild(hint);
      loaded = false;
    }
  });
}

function openTab(filePath, mode) {
  mode = mode === 'render' ? 'render' : 'view';
  const key = tabKey(filePath, mode);
  if (tabs.has(key)) { setActive(key); return; }
  const tab = document.createElement('div');
  tab.className = 'tab';
  tab.dataset.key = key;
  tab.dataset.path = filePath;
  tab.dataset.mode = mode;
  const label = document.createElement('span');
  label.textContent = filePath.split('/').pop();
  label.title = filePath + (mode === 'render' ? ' (rendered)' : '');
  tab.appendChild(label);
  if (mode === 'render') {
    const tag = document.createElement('span');
    tag.className = 'mode-tag';
    tag.textContent = 'live';
    tab.appendChild(tag);
  }
  const close = document.createElement('button');
  close.className = 'close';
  close.type = 'button';
  close.textContent = '×';
  close.title = 'Close tab';
  close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(key); });
  tab.appendChild(close);
  tab.addEventListener('click', () => setActive(key));
  TABS.appendChild(tab);

  const frame = document.createElement('iframe');
  // Encode each segment so spaces / unicode survive, but keep slashes
  // between segments. ?embed=1 strips the per-file header for normal view;
  // ?raw=1 returns raw bytes (text/html for .html), so iframe runs the page.
  const segs = filePath.split('/').map(encodeURIComponent).join('/');
  const qs = mode === 'render' ? '?raw=1' : '?embed=1';
  frame.src = '/view/' + encodeURIComponent(PROJECT) + '/' + segs + qs;
  FRAMES.appendChild(frame);
  wireFrameScroll(frame, key);

  tabs.set(key, { path: filePath, mode, tab, frame });
  setActive(key);
  saveTabs();
}

function setActive(key) {
  activeKey = key;
  const info = tabs.get(key);
  for (const [k, v] of tabs) {
    const isActive = k === key;
    v.tab.classList.toggle('active', isActive);
    v.frame.classList.toggle('active', isActive);
  }
  for (const el of TREE_PANE.querySelectorAll('.file')) {
    el.classList.toggle('active', !!info && el.dataset.path === info.path);
  }
  PATH_HINT.textContent = info ? (info.path + (info.mode === 'render' ? ' · live' : '')) : 'browse';
  EMPTY.hidden = tabs.size > 0;
  if (info) info.tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  saveTabs();
}

function closeTab(key) {
  const t = tabs.get(key);
  if (!t) return;
  t.tab.remove();
  t.frame.remove();
  tabs.delete(key);
  if (activeKey === key) {
    const remaining = Array.from(tabs.keys());
    if (remaining.length > 0) setActive(remaining[remaining.length - 1]);
    else {
      activeKey = null;
      PATH_HINT.textContent = 'browse';
      EMPTY.hidden = false;
    }
  }
  saveTabs();
}

function saveTabs() {
  const list = [];
  for (const [, info] of tabs) list.push({ path: info.path, mode: info.mode });
  try {
    localStorage.setItem(TABS_KEY, JSON.stringify(list));
    if (activeKey) localStorage.setItem(ACTIVE_KEY, activeKey);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {}
}

function loadSavedTabs() {
  try {
    const raw = localStorage.getItem(TABS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr)
      ? arr.filter((x) => x && typeof x.path === 'string').map((x) => ({
          path: x.path, mode: x.mode === 'render' ? 'render' : 'view',
        }))
      : [];
  } catch { return []; }
}

function loadSavedActiveKey() {
  try { return localStorage.getItem(ACTIVE_KEY); } catch { return null; }
}

// Tree splitter: drag to resize the left pane. Width persists across reloads.
function setTreeWidth(px) {
  const clamped = Math.max(140, Math.min(window.innerWidth * 0.7, px));
  document.documentElement.style.setProperty('--tree-width', clamped + 'px');
  try { localStorage.setItem(TREE_WIDTH_KEY, String(clamped)); } catch {}
}
const savedWidth = (() => {
  try { return parseFloat(localStorage.getItem(TREE_WIDTH_KEY) || ''); } catch { return NaN; }
})();
if (Number.isFinite(savedWidth)) setTreeWidth(savedWidth);

let treeDragging = false;
SPLITTER.addEventListener('mousedown', (e) => {
  e.preventDefault();
  treeDragging = true;
  SPLITTER.classList.add('dragging');
  document.body.classList.add('resizing');
});

// Develop pane: terminal iframe to /term/<project>/. Width + visibility
// persisted per project so refresh keeps the layout.
function setDevelopWidth(px) {
  const total = MAIN.getBoundingClientRect().width;
  const clamped = Math.max(240, Math.min(total - 240, px));
  document.documentElement.style.setProperty('--develop-width', clamped + 'px');
  try { localStorage.setItem(DEVELOP_WIDTH_KEY, String(clamped)); } catch {}
}
function showDevelop(show) {
  DEVELOP_PANE.hidden = !show;
  DEVELOP_SPLITTER.hidden = !show;
  DEVELOP_TOGGLE.classList.toggle('active', show);
  if (show && !DEVELOP_FRAME.src) {
    DEVELOP_FRAME.src = '/term/' + encodeURIComponent(PROJECT) + '/';
  }
  try { localStorage.setItem(DEVELOP_VISIBLE_KEY, show ? '1' : '0'); } catch {}
}
DEVELOP_TOGGLE.addEventListener('click', () => showDevelop(DEVELOP_PANE.hidden));

const savedDevWidth = (() => {
  try { return parseFloat(localStorage.getItem(DEVELOP_WIDTH_KEY) || ''); } catch { return NaN; }
})();
if (Number.isFinite(savedDevWidth)) setDevelopWidth(savedDevWidth);
const initVisible = (() => {
  try { return localStorage.getItem(DEVELOP_VISIBLE_KEY) === '1'; } catch { return false; }
})();
// Query string override (?dev=1 / ?dev=0) wins over saved state — useful
// for share-links that want to land in a known layout, and for screenshot
// scripts that need a deterministic shot.
const devOverride = new URLSearchParams(location.search).get('dev');
if (devOverride === '1') showDevelop(true);
else if (devOverride === '0') showDevelop(false);
else if (initVisible) showDevelop(true);

let devDragging = false;
DEVELOP_SPLITTER.addEventListener('mousedown', (e) => {
  e.preventDefault();
  devDragging = true;
  DEVELOP_SPLITTER.classList.add('dragging');
  document.body.classList.add('resizing');
});

window.addEventListener('mousemove', (e) => {
  if (treeDragging) {
    setTreeWidth(e.clientX);
  } else if (devDragging) {
    const fromRight = window.innerWidth - e.clientX;
    setDevelopWidth(fromRight);
  }
});
window.addEventListener('mouseup', () => {
  if (treeDragging) {
    treeDragging = false;
    SPLITTER.classList.remove('dragging');
  }
  if (devDragging) {
    devDragging = false;
    DEVELOP_SPLITTER.classList.remove('dragging');
  }
  document.body.classList.remove('resizing');
});

// Bootstrap: fetch tree, render, restore saved tabs (or open README.md).
fetch('/api/view-tree/' + encodeURIComponent(PROJECT))
  .then((r) => r.json())
  .then((data) => {
    TREE_PANE.innerHTML = '';
    const root = data.tree || [];
    if (root.length === 0) {
      TREE_PANE.innerHTML = '<div class="tree-empty">empty project</div>';
    } else {
      buildTree(root, TREE_PANE);
    }
    const saved = loadSavedTabs();
    if (saved.length > 0) {
      for (const t of saved) openTab(t.path, t.mode);
      const sk = loadSavedActiveKey();
      if (sk && tabs.has(sk)) setActive(sk);
      EMPTY.hidden = tabs.size > 0;
    } else {
      const readme = root.find((n) => n.type === 'file' && /^readme\\.md$/i.test(n.name));
      if (readme) openTab(readme.path, 'view');
      else EMPTY.hidden = false;
    }
    connectTreeWS();
  })
  .catch((err) => {
    TREE_PANE.innerHTML = '<div class="tree-empty">tree load failed: ' + escapeHtml(err.message) + '</div>';
    EMPTY.hidden = false;
    connectTreeWS();
  });

// Live tree updates: server pushes {type:'add'|'delete', path, kind?} as
// files appear/disappear. We mutate the DOM in place — no full re-render —
// so expanded folders stay open and the active tab stays focused.
let treeWS = null;
let treeWSBackoff = 1000;
let treeWSEverConnected = false;
function connectTreeWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  try {
    treeWS = new WebSocket(proto + '//' + location.host + '/ws/view-tree/' + encodeURIComponent(PROJECT));
  } catch (e) {
    scheduleTreeWSReconnect();
    return;
  }
  treeWS.addEventListener('open', () => {
    treeWSBackoff = 1000;
    // Reconnect after a prior connection (V27): edits made during the gap
    // emit no events, so force-reload every open tab to recover. First
    // connect (page load) is skipped — tabs already show fresh content.
    if (treeWSEverConnected) {
      for (const [, info] of tabs) reloadTabFrame(info);
    }
    treeWSEverConnected = true;
  });
  treeWS.addEventListener('message', (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'add') handleAdd(msg.path, msg.kind);
    else if (msg.type === 'delete') handleDelete(msg.path);
    else if (msg.type === 'change') handleChange(msg.path);
  });
  treeWS.addEventListener('close', scheduleTreeWSReconnect);
  treeWS.addEventListener('error', () => { try { treeWS.close(); } catch {} });
}
function scheduleTreeWSReconnect() {
  setTimeout(connectTreeWS, treeWSBackoff);
  treeWSBackoff = Math.min(treeWSBackoff * 2, 30000);
}
</script>
</body>
</html>`;
}

function renderDirectory(project, relPath, absPath) {
  const entries = fs.readdirSync(absPath, { withFileTypes: true });
  // Hide a few noise dirs by default; reachable by typing the URL.
  const hidden = new Set(['node_modules', '.git', '.serve', 'dist', 'build']);
  const dirs = entries
    .filter((e) => e.isDirectory() && !hidden.has(e.name))
    .map((e) => e.name)
    .sort();
  const files = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();
  const items = [];
  if (relPath !== '') {
    const parent = relPath.split('/').slice(0, -1).join('/');
    const url = parent
      ? `/view/${encodeURIComponent(project)}/${parent.split('/').map(encodeURIComponent).join('/')}/`
      : `/view/${encodeURIComponent(project)}/`;
    items.push(`<li><a href="${url}"><span class="dir-icon">↑</span>..</a></li>`);
  }
  for (const d of dirs) {
    const url = `/view/${encodeURIComponent(project)}${relPath ? '/' + relPath : ''}/${encodeURIComponent(d)}/`;
    items.push(`<li><a href="${url}"><span class="dir-icon">▸</span>${escapeHtml(d)}/</a></li>`);
  }
  for (const f of files) {
    const url = `/view/${encodeURIComponent(project)}${relPath ? '/' + relPath : ''}/${encodeURIComponent(f)}`;
    items.push(`<li><a href="${url}"><span class="file-icon">·</span>${escapeHtml(f)}</a></li>`);
  }
  const body =
    items.length > 0
      ? `<ul class="dir">${items.join('')}</ul>`
      : '<div class="empty">empty directory</div>';
  return viewerShell(
    `${project}${relPath ? '/' + relPath : ''}`,
    renderBreadcrumb(project, relPath),
    body,
  );
}

function renderFrontmatter(meta) {
  const keys = Object.keys(meta);
  if (keys.length === 0) return '';
  // Pretty-print as syntax-highlighted YAML. Strings are escaped for HTML
  // safety since values can come from arbitrary user content.
  const lines = keys.map((k) => {
    const v = meta[k];
    let valHtml;
    if (Array.isArray(v)) {
      const items = v.map((x) => {
        const s = String(x);
        return /[\s,[\]]/.test(s) ? `"${escapeHtml(s)}"` : escapeHtml(s);
      }).join('<span class="fm-punct">, </span>');
      valHtml = `<span class="fm-punct">[</span>${items}<span class="fm-punct">]</span>`;
    } else {
      valHtml = `<span class="fm-str">${escapeHtml(String(v))}</span>`;
    }
    return `<span class="fm-key">${escapeHtml(k)}</span><span class="fm-punct">:</span> ${valHtml}`;
  });
  return `<pre class="frontmatter">${lines.join('\n')}</pre>`;
}

function renderMarkdown(project, relPath, content, embed = false) {
  const { meta, body } = parseFrontmatter(content);
  const html = marked.parse(body);
  return viewerShell(
    `${project}/${relPath}`,
    renderBreadcrumb(project, relPath) +
      ` <span class="sep">·</span> <a class="raw-link" href="?raw=1">raw</a>`,
    `${renderFrontmatter(meta)}<article class="md">${html}</article>`,
    null,
    { embed },
  );
}

function renderCode(project, relPath, content, lang, embed = false) {
  const langClass = lang ? ` class="language-${lang}"` : '';
  const HLJS_CDN_BASE = 'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build';
  const head = `
<link rel="stylesheet" href="${HLJS_CDN_BASE}/styles/atom-one-dark.min.css">
<script defer src="${HLJS_CDN_BASE}/highlight.min.js"></script>
<script defer>document.addEventListener('DOMContentLoaded',()=>hljs.highlightAll());</script>`;
  return viewerShell(
    `${project}/${relPath}`,
    renderBreadcrumb(project, relPath) +
      ` <span class="sep">·</span> <a class="raw-link" href="?raw=1">raw</a>`,
    `<pre><code${langClass}>${escapeHtml(content)}</code></pre>`,
    head,
    { embed },
  );
}

function serveRaw(res, absPath, ext) {
  const mime = RAW_MIME[ext] || 'application/octet-stream';
  fs.readFile(absPath, (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('read error: ' + err.message);
      return;
    }
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

function handleViewRequest(req, res, urlPath) {
  // urlPath like "/view/<project>/src/App.tsx" or "/view/<project>/" or "/view/"
  const rest = urlPath.slice('/view/'.length); // e.g. "<project>/src/App.tsx"
  if (rest === '' || rest === '/') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Pick a project: /view/<project>/');
    return;
  }
  const slash = rest.indexOf('/');
  const projectRaw = slash < 0 ? rest : rest.slice(0, slash);
  let relPath = slash < 0 ? '' : rest.slice(slash + 1);
  // Trim trailing slash for consistent rel path; we re-add it for directories below.
  if (relPath.endsWith('/')) relPath = relPath.slice(0, -1);

  let project;
  try {
    project = decodeURIComponent(projectRaw);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('bad project name');
    return;
  }
  if (!isViewableProject(project)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('unknown project');
    return;
  }

  let decodedRel;
  try {
    decodedRel = relPath
      .split('/')
      .map((seg) => (seg ? decodeURIComponent(seg) : seg))
      .join('/');
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('bad path');
    return;
  }

  const projectRoot = path.join(PROJECTS_ROOT, project);
  const absPath = path.resolve(projectRoot, decodedRel);
  // Ensure resolved path stays inside the project root (no ../ escapes).
  if (absPath !== projectRoot && !absPath.startsWith(projectRoot + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('path escapes project root');
    return;
  }

  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found: ' + e.message);
    return;
  }

  if (stat.isDirectory()) {
    // Force trailing slash so relative URLs in the directory listing resolve correctly.
    if (!urlPath.endsWith('/')) {
      res.writeHead(301, { Location: urlPath + '/' });
      res.end();
      return;
    }
    // Project root → two-pane shell (tree + tabbed iframes). Subdirectory
    // URLs continue to render the flat directory listing so old links still
    // work. The shell's tree renders the whole project from root, so user
    // never needs to navigate into a subdirectory URL anyway.
    try {
      const html = decodedRel === ''
        ? renderViewShell(project)
        : renderDirectory(project, decodedRel, absPath);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(html);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('render error: ' + e.message);
    }
    return;
  }

  if (!stat.isFile()) {
    res.writeHead(415, { 'Content-Type': 'text/plain' });
    res.end('not a regular file');
    return;
  }

  const ext = path.extname(absPath).toLowerCase();
  const qs = req.url.split('?')[1] || '';
  const wantRaw = qs.includes('raw=1');
  const wantEmbed = qs.includes('embed=1');

  // Raw delivery path: bypass render. Used for ?raw=1 or any binary.
  if (wantRaw || BINARY_EXTS.has(ext)) {
    serveRaw(res, absPath, ext);
    return;
  }

  if (stat.size > RENDER_AS_TEXT_MAX_BYTES) {
    res.writeHead(413, { 'Content-Type': 'text/plain' });
    res.end(`file too large to render in viewer (${stat.size} bytes); add ?raw=1 to download`);
    return;
  }

  const content = fs.readFileSync(absPath, 'utf8');
  let html;
  if (ext === '.md' || ext === '.markdown') {
    html = renderMarkdown(project, decodedRel, content, wantEmbed);
  } else {
    const lang = HLJS_LANG[ext] || (path.basename(absPath).toLowerCase() === 'dockerfile' ? 'dockerfile' : '');
    html = renderCode(project, decodedRel, content, lang, wantEmbed);
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(html);
}

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';

  // Managed-projects API — list/create/delete.
  const apiPath = url.split('?', 1)[0];
  if (apiPath === '/api/projects') {
    if (req.method === 'GET') return handleListProjects(req, res);
    if (req.method === 'POST') return handleCreateProject(req, res);
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('method not allowed');
    return;
  }
  if (apiPath === '/api/projects/orphans') {
    if (req.method === 'GET') return handleListOrphans(req, res);
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('method not allowed');
    return;
  }
  const projectMatch = /^\/api\/projects\/([^/]+)$/.exec(apiPath);
  if (projectMatch) {
    const name = projectMatch[1];
    if (req.method === 'DELETE') return handleDeleteProject(req, res, name);
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('method not allowed');
    return;
  }
  const treeMatch = /^\/api\/view-tree\/([^/]+)$/.exec(apiPath);
  if (treeMatch) {
    if (req.method === 'GET') return handleViewTree(req, res, treeMatch[1]);
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('method not allowed');
    return;
  }
  if (apiPath === '/api/gh/repos') {
    if (req.method === 'GET') return handleGhRepos(req, res);
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('method not allowed');
    return;
  }

  // Bare prefix without trailing slash — redirect so relative-path resolution
  // in the upstream HTML lands correctly.
  for (const r of STATIC_ROUTES) {
    if (url === r.prefix) {
      res.writeHead(301, { Location: r.prefix + '/' });
      res.end();
      return;
    }
  }

  // /view/<project>/<path> — markdown + code viewer (read-only).
  const urlPathOnly = url.split('?', 1)[0];

  if (urlPathOnly === '/' || urlPathOnly === '/index.html' || urlPathOnly === '/landing.html') {
    serveLanding(res);
    return;
  }
  if (urlPathOnly === '/view' || urlPathOnly === '/view/' || urlPathOnly.startsWith('/view/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('viewer is read-only');
      return;
    }
    handleViewRequest(req, res, urlPathOnly);
    return;
  }

  const route = findRoute(url);
  if (!route) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found. Try /, /api/projects, /view/<project>/, or /term/<project>/.');
    return;
  }

  rewriteUrl(req, route);
  proxy.web(req, res, { target: routeTarget(route) });
});

server.on('upgrade', async (req, socket, head) => {
  const url = req.url || '';

  // Live file-tree updates: /ws/view-tree/<project>. Handled in-process so
  // we don't proxy these to anything; they ride a dedicated WSS instance.
  const wsTreeMatch = /^\/ws\/view-tree\/([^/?]+)/.exec(url);
  if (wsTreeMatch) {
    const rawProject = wsTreeMatch[1];
    let project;
    try { project = decodeURIComponent(rawProject); } catch { socket.destroy(); return; }
    if (!isViewableProject(project)) { socket.destroy(); return; }
    viewTreeWss.handleUpgrade(req, socket, head, (ws) => {
      const entry = getOrCreateWatcher(project);
      if (!entry) { try { ws.close(); } catch {} return; }
      entry.clients.add(ws);
      ws.on('close', () => releaseWatcher(project, ws));
      ws.on('error', () => releaseWatcher(project, ws));
    });
    return;
  }

  const route = findRoute(url);
  if (!route) {
    socket.destroy();
    return;
  }
  rewriteUrl(req, route);
  proxy.ws(req, socket, head, { target: routeTarget(route) });
});

refreshStaticRoutes();

// Only auto-listen when invoked as the entry point (`node server.js`). Tests
// require this file in-process and call `server.listen` themselves on a
// random port to avoid collisions with the systemd-managed instance.
if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`claude-hub listening on http://127.0.0.1:${PORT}`);
    for (const r of STATIC_ROUTES) {
      console.log(`  ${r.prefix}/* → ${r.target}${r.stripPrefix ? ' (prefix stripped)' : ''}`);
    }
  });
}

module.exports = { server, PROJECT_ID_RE, RESERVED_PROJECT_NAMES, projectWatchers };
