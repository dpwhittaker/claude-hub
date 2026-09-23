/**
 * claude-hub — one page over everything under ~/projects, plus the reverse
 * proxy in front of each project's dev server.
 *
 *   /                    → the workspace (v2/: profiles, panels, tabs)
 *   /v2/*, /api/v2/*     → its files and its JSON API (lib/v2-routes.js)
 *   /term/hub/?arg=<id>  → ttyd terminal for a hub session, attached to a
 *                          long-lived tmux session (ttyd-hub.service; one
 *                          unit serves every session, the id picks the tmux)
 *   /<p>(/|$)            → reverse-proxy to a project's backend if its
 *                          .project-meta.json declares `proxyTarget`. Prefix
 *                          and stripPrefix come from the same file (defaults:
 *                          prefix = "/<name>", stripPrefix = true).
 *   /api/projects (POST) → new repo: template scaffold / clone / onboard
 *   /api/term-*          → the glasses relay (tmux capture / input / prompts)
 *   /api/projects (GET), /api/term-sessions, /api/view-tree, /view/*
 *                        → read-only shims for the glasses app (lib/g2-compat.js)
 *
 * WebSocket upgrades are forwarded so Vite HMR (and ttyd) keep working.
 *
 * Run as a systemd service or directly: `node server.js`.
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const httpProxy = require('http-proxy');
const { allocatePort } = require('./lib/port-alloc');
const { copyTemplate, nameSlug } = require('./lib/template');
const { makeGhRepos, filterReposByFolders } = require('./lib/gh-repos');
const { PROJECT_ID_RE, RESERVED_PROJECT_NAMES } = require('./lib/project-name');
const { writeBootstrapPrompt } = require('./lib/bootstrap-prompt');
const { effectiveTemplate, firebaseEnabled } = require('./lib/template-policy');
const { bootstrapOnboard, listOrphanFolderNames } = require('./lib/onboard');
const termRelayLib = require('./lib/term-relay');
const scaffoldInstall = require('./lib/scaffold-install');
const { makeV2Router } = require('./lib/v2-routes');
const { makeG2Compat } = require('./lib/g2-compat');
const { findSentinels } = require('./lib/sentinels');
const { systemdEscapePath } = require('./lib/systemd-escape');
const { resolveUnder } = require('./lib/v2-paths');

const PORT = Number(process.env.PROXY_PORT) || 8002;

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
  for (const { name, meta } of findSentinels(PROJECTS_ROOT)) {
    const target = typeof meta.proxyTarget === 'string' ? meta.proxyTarget.trim() : '';
    if (!target) continue;
    const prefix = typeof meta.proxyPrefix === 'string' && meta.proxyPrefix.startsWith('/')
      ? meta.proxyPrefix
      : `/${name}`;
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
// Each terminal "key" (project name, or 'develop' / 'shell' for the admin
// terminals) is served by a systemd-managed ttyd unit that binds a unix
// socket under /run/ttyd/. SPEC §V.13, §V.36 — claude-hub never spawns ttyd
// itself; it just proxies /term/<key>/ to the systemd-bound socket.
//   - ttyd@<name>.service      → /run/ttyd/<name>.sock     (per project)
//   - ttyd-develop.service     → /run/ttyd/develop.sock    (admin: fresh claude)
//   - ttyd-shell.service       → /run/ttyd/shell.sock      (admin: raw bash)
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
  // We self-handle responses so we can inject the touch-wheel translator
  // into bare /term/<key>/ HTML pages (V40). Non-injecting routes still get
  // a transparent pipe via the proxyRes handler below.
  selfHandleResponse: true,
});

proxy.on('error', (err, _req, res) => {
  if (res && res.writeHead && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Bad gateway: ' + err.message);
  } else if (res && res.end) {
    res.end();
  }
});

// True iff `url` is the ttyd index for a term key — i.e. /term/<key>/ or
// /term/<key> (no extra path, optional query). Anything deeper (asset, ws,
// token endpoint) is not the HTML index and must pass through verbatim.
const TERM_INDEX_RE = /^\/term\/[A-Za-z0-9_.-]+\/?(?:\?.*)?$/;
// Inject installTouchWheel into bare ttyd /term/<key>/ pages so touch-drag
// scrolls history on phones/tablets. Lives in <head> (runs before body
// parses) since ttyd's preact mount replaces body children, which would
// strip a body-end script before it could run.
const TOUCH_WHEEL_INJECT = `<script>document.addEventListener('DOMContentLoaded',function(){(${require('./lib/touch-wheel').installTouchWheel.toString()})(document);});</script>`;
const { patchViewportMeta, installKeyboardFit } = require('./lib/keyboard-fit');
const KEYBOARD_FIT_INJECT = `<script>document.addEventListener('DOMContentLoaded',function(){(${installKeyboardFit.toString()})(document);});</script>`;
// Android-only: take the IME input path off xterm's CompositionHelper, which
// defers every keystroke to a setTimeout(0) and drops it outright if Gboard
// opens a composition in the meantime (V61, B17). Self-gating on the UA, so
// it is inert everywhere else. DOMContentLoaded is enough — the listeners sit
// on `document` and resolve window.term lazily, so they can be installed
// before ttyd has constructed the terminal.
const { installAndroidInput } = require('./lib/android-input');
const ANDROID_INPUT_INJECT = `<script>document.addEventListener('DOMContentLoaded',function(){(${installAndroidInput.toString()})(document);});</script>`;
// OSC 52 → navigator.clipboard. Runs synchronously at <head> parse time (no
// DOMContentLoaded gate) so it wraps window.WebSocket BEFORE ttyd's bundle
// constructs its socket. tmux `set-clipboard on` emits OSC 52 on mouse
// selections; this turns those into actual host clipboard writes.
const { installOsc52Bridge } = require('./lib/osc52');
const OSC52_INJECT = `<script>(${installOsc52Bridge.toString()})(window);</script>`;
// Automatic reconnect (V63, B18). Also wraps window.WebSocket, so it runs at
// head-parse time like OSC52 — and AFTER it, since it has to see the socket
// object that wrapper hands back. Undoes ttyd's `error → doReconnect = false`
// so a dropped connection retries itself instead of parking on
// "Press ⏎ to Reconnect", and refits after reopen so the pty is not resized
// to whatever shape the viewport had before the drop.
const { installTermReconnect } = require('./lib/term-reconnect');
const TERM_RECONNECT_INJECT = `<script>(${installTermReconnect.toString()})(window);</script>`;
// xterm.js's .xterm-viewport sets overflow-y:scroll, so a scrollbar is always
// painted on the right edge of the term pane even when scrollback fits. Hide
// the bar without disabling scroll (touch-wheel + wheel events still drive
// xterm's internal scrollback). Also zero the outer document scrollbar in
// case any browser/OS combo reserves a gutter there.
const SCROLLBAR_HIDE_INJECT = '<style>html,body{scrollbar-width:none;-ms-overflow-style:none;overflow:hidden}html::-webkit-scrollbar,body::-webkit-scrollbar{display:none;width:0;height:0}.xterm-viewport{scrollbar-width:none;-ms-overflow-style:none}.xterm-viewport::-webkit-scrollbar{display:none;width:0;height:0}</style>';

proxy.on('proxyRes', (proxyRes, req, res) => {
  const wantsInject = req.method === 'GET'
    && TERM_INDEX_RE.test(req.url || '')
    && (proxyRes.headers['content-type'] || '').toLowerCase().includes('text/html')
    && !proxyRes.headers['content-encoding']; // ttyd doesn't gzip; bail if it ever does
  if (!wantsInject) {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
    return;
  }
  const chunks = [];
  proxyRes.on('data', (c) => chunks.push(c));
  proxyRes.on('end', () => {
    let html = Buffer.concat(chunks).toString('utf8');
    // Patch viewport meta first so interactive-widget=resizes-content lands on
    // Chrome/Android before layout. Then inject scripts into <head> (runs
    // before body parses) so ttyd's preact mount can't wipe us.
    html = patchViewportMeta(html);
    const injectBlob = OSC52_INJECT + TERM_RECONNECT_INJECT + SCROLLBAR_HIDE_INJECT
      + TOUCH_WHEEL_INJECT + KEYBOARD_FIT_INJECT + ANDROID_INPUT_INJECT;
    if (html.includes('</head>')) {
      html = html.replace('</head>', injectBlob + '</head>');
    } else if (html.includes('</body>')) {
      html = html.replace('</body>', injectBlob + '</body>');
    } else {
      html += injectBlob;
    }
    const out = Buffer.from(html, 'utf8');
    const headers = { ...proxyRes.headers };
    headers['content-length'] = String(out.length);
    delete headers['transfer-encoding'];
    res.writeHead(proxyRes.statusCode, headers);
    res.end(out);
  });
  proxyRes.on('error', () => { try { res.end(); } catch {} });
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


// ---------- New repos (the Explorer's "+ repo" dialog) ----------
// A folder under ~/projects with a .project-meta.json is a project the proxy
// knows about (dev-server port, prefix, units). The create flow:
//   1. POST /api/projects { name, template, github } — mkdir, scaffold, sentinel
//   2. a hub session in the folder, seeded with the bootstrap prompt
//
// AGENTS.md is the agent-facing brief; humans get README.md (its H1 and first
// paragraph are what the hub and the glasses app show as the folder's title
// and description).
function agentsTemplate(name) {
  return `# ${name} — AGENTS.md

This is the orientation doc for any agent (you) working in this project.
Human-facing details — the project's title and one-sentence summary — live in
\`README.md\` (its H1 and first paragraph). Keep README current.

## Workflow rule: commit + push every turn

Every turn that changes code, config, assets, or docs ends with a commit —
and a push if this project has a remote. Don't wait to be asked. One commit
per logical change; run whatever tests exist first and fix what fails before
committing. Skip only when the turn produced no working-tree changes.

**Commit explicit paths, never \`-A\`.** Several Claude sessions can share this
checkout (one per terminal tab), so \`git add -A\` sweeps up whatever a peer
session has half-written. Name what you wrote:
\`git commit -m "…" -- path/one path/two\`.

## Workflow rule: git worktrees

Parallel work goes in a worktree, not in this checkout — two agents editing
one tree is the "peer swept my files" problem above, at feature scale. Claude
Code's \`isolation: "worktree"\` drops a checkout at
\`~/projects/${name}_<task>/\`; give it a \`.project-meta.json\` naming
\`worktreeOf: "${name}"\` and its \`branch\` and the hub treats it as its own
folder, with its own terminal sessions and, if it has one, its own dev server.

**Never \`rm -rf\` a worktree** — this repo's \`.git/worktrees/\` keeps the
registry entry and then refuses to reuse the path. Remove it with
\`git -C ~/projects/${name} worktree remove --force <dir>\`. A worktree checks
out this project's \`README.md\` byte-for-byte; give its sentinel a \`title\`
and \`description\` of its own so the hub can tell the two apart.

## Workflow rule: the spec is the memory (SDD)

\`SPEC.md\` at the root is this project's durable memory — goals (\`§G\`),
constraints (\`§C\`), interfaces (\`§I\`), invariants (\`§V\`), tasks (\`§T\`)
and bugs (\`§B\`), written compressed enough to reload on every request. It
exists because your context window resets and the code does not: anything
decided but not written down gets re-derived next session, differently. Read it
before you change anything; update it in the same turn as the code, never
"later". The loop is: read the spec → work against it → prove each \`§V\` you
touched with a named test → **backprop** — every bug becomes a \`§B\` row and
its class becomes a \`§V\` invariant, so the project stops re-making mistakes
it has already made.

The part that needs discipline is not writing the spec, it is retiring what a
new requirement invalidated. \`§V\`/\`§I\` describe the present and get edited;
\`§T\`/\`§B\` are logs and only get appended. Numbers are permanent addresses —
never reused, even after retirement. Before appending an invariant, grep \`§V\`
for its subject: a rule that changed gets **revised in place at its existing
number**, tagged \`(revised)\` and carrying \`⊥ <the old rule>\` so nobody walks
back into it — a rule whose concern is gone gets **deleted**, its retirement
logged in the \`§T\` row that did the work.

**Full protocol: \`~/projects/claude-hub/SDD.md\`** — section reference, the
encoding and its symbol table, backprop, and the maintenance rules for keeping
the spec true as the project grows.

## Bootstrap

This folder was just created from the hub's "+ repo" dialog. Your terminal is
a hub session in this folder (a long-lived tmux session; the conversation
resumes across reconnects and reboots). The hub's file browser, editor and
diff views sit beside it on the same page.

## What to do first

1. Ask the user what they want to build here.
2. Update \`README.md\`: rewrite the H1 (the project's title) and the first
   paragraph (a one-sentence description) — the hub shows both.
3. Fill in \`SPEC.md\`: rewrite \`§G\` to the goal you just agreed, add the
   \`§C\` constraints the stack imposes, and flip \`§T.1\` to \`x\`.
4. Start scaffolding.
`;
}

// SPEC.md is the project's durable memory — the SDD file every project gets,
// bare template included. Format + maintenance protocol live in
// ~/projects/claude-hub/SDD.md; this is just the empty skeleton with the
// sections in their fixed order, so the first session has somewhere to write.
function specTemplate(name) {
  return `# SPEC

Durable memory for ${name} — reload it at the start of every session.
Format, encoding & the maintenance protocol (how a new requirement retires an
old one): \`~/projects/claude-hub/SDD.md\`.

## §G GOAL

? one line — what this project must do. agree it w/ the user & rewrite before
the first feature (§T.1). ⊥ leave this placeholder standing.

## §C CONSTRAINTS

- ? stack, runtime floor, locked deps — fill in once §G is agreed.
- terminals, files and (when it has one) the dev server are served by claude-hub at \`/\`.

## §I INTERFACES

- \`README.md\` H1 → the project's title, ¶1 → its one-sentence description (the hub and the glasses app show both)

## §V INVARIANTS

- V1: \`README.md\` H1/¶1 = the project's title/description. ⊥ let them drift from §G.

## §T TASKS

id|status|task|cites
---|---|---|---
T1|.|agree §G w/ user; rewrite §G + \`README.md\` H1/¶1 to match|V1
T2|.|pick the stack → §C. add §I rows for surface it exposes|-

## §B BUGS

id|date|cause|fix
---|---|---|---
`;
}

function readmeTemplate(name) {
  return `# ${name}

Replace this paragraph with a one-sentence description of what this project is. \
The hub shows it beside the folder's name.
`;
}

// ---------- Glasses relay + speech-to-text ----------
const termRelay = termRelayLib.makeRelay({
  watchTtlMs: Number(process.env.TERM_WATCH_TTL_MS) || undefined,
});
const STT_URL = process.env.STT_URL || 'http://127.0.0.1:8012';
const execFileAsync = require('node:util').promisify(require('node:child_process').execFile);

// Exact session-name match (`=`), no prefix search — and the trailing ':' is
// load-bearing: has-session takes `=key`, but every pane-targeted command
// (send-keys, capture-pane, display-message) answers "can't find pane" to it
// and wants `=key:` = that session's active pane (B25).
function tmuxSession(key) { return '=' + key; }
function tmuxTarget(key) { return '=' + key + ':'; }

async function tmuxHasSession(key) {
  try { await execFileAsync('tmux', ['has-session', '-t', tmuxSession(key)], { timeout: 3000 }); return true; }
  catch { return false; }
}

function readRawBody(req, res, maxBytes) {
  return new Promise((resolve) => {
    let bytes = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        res.writeHead(413, { 'Content-Type': 'text/plain' });
        res.end('payload too large');
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(res.headersSent ? null : Buffer.concat(chunks)));
    req.on('error', () => {
      if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('read error'); }
      resolve(null);
    });
  });
}

// The glasses compose a key as `<project>__<id>`; for a hub session whose
// tmux name is `hub-<id>` that prefix is noise — strip it (V97).
function canonicalTermKey(key) {
  const m = /^[A-Za-z0-9][A-Za-z0-9._-]*__(hub-[a-z0-9]{8})$/.exec(String(key || ''));
  return m ? m[1] : key;
}

function relayKeyOr400(res, key) {
  if (termRelayLib.isTermKey(key)) return true;
  sendJson(res, 400, { error: 'invalid terminal key' });
  return false;
}

// GET → the visible pane as text. Polling this is what makes a terminal
// "watched": only then may a hook hold a prompt for the glasses (V75).
async function handleTermCapture(_req, res, key) {
  if (!relayKeyOr400(res, key)) return;
  if (!(await tmuxHasSession(key))) return sendJson(res, 404, { error: 'no such terminal' });
  termRelay.markWatched(key);
  let capture;
  try {
    capture = await execFileAsync('tmux', ['capture-pane', '-p', '-J', '-t', tmuxTarget(key)],
      { timeout: 3000, maxBuffer: 4 * 1024 * 1024 });
  } catch (e) {
    return sendJson(res, 500, { error: 'capture failed: ' + e.message });
  }
  let cols = 0; let rows = 0;
  try {
    const dims = await execFileAsync('tmux', ['display-message', '-p', '-t', tmuxTarget(key), '#{pane_width} #{pane_height}'], { timeout: 3000 });
    [cols, rows] = dims.stdout.trim().split(' ').map(Number);
  } catch {}
  sendJson(res, 200, {
    key, cols, rows,
    lines: termRelayLib.parseCapture(capture.stdout),
    pending: termRelay.getPending(key),
    state: termRelay.getState(key),
  });
}

// POST {text, enter?} → typed into the pane literally (`send-keys -l`), then
// Enter when asked. This is how a spoken prompt lands in a Claude session.
function handleTermInput(req, res, key) {
  if (!relayKeyOr400(res, key)) return;
  readJsonBody(req, res, 16384, (body, err) => {
    if (err) return;
    if (!body || typeof body.text !== 'string' || body.text.length > 8192) {
      return sendJson(res, 400, { error: 'text required (≤ 8192 chars)' });
    }
    (async () => {
      if (!(await tmuxHasSession(key))) return sendJson(res, 404, { error: 'no such terminal' });
      if (body.text) await execFileAsync('tmux', ['send-keys', '-t', tmuxTarget(key), '-l', '--', body.text], { timeout: 3000 });
      if (body.enter) await execFileAsync('tmux', ['send-keys', '-t', tmuxTarget(key), 'Enter'], { timeout: 3000 });
      sendJson(res, 200, { ok: true });
    })().catch((e) => { if (!res.headersSent) sendJson(res, 500, { error: 'send-keys failed: ' + e.message }); });
  });
}

// POST {lines} → SGR wheel ticks typed into the pane; negative scrolls toward
// older output. Claude Code consumes them as transcript scroll (V77).
function handleTermScroll(req, res, key) {
  if (!relayKeyOr400(res, key)) return;
  readJsonBody(req, res, 4096, (body, err) => {
    if (err) return;
    const lines = body && Number(body.lines);
    if (!Number.isFinite(lines)) return sendJson(res, 400, { error: 'lines required' });
    const seqs = termRelayLib.wheelSequences(lines);
    (async () => {
      if (!(await tmuxHasSession(key))) return sendJson(res, 404, { error: 'no such terminal' });
      if (seqs.length) await execFileAsync('tmux', ['send-keys', '-t', tmuxTarget(key), '-l', '--', ...seqs], { timeout: 3000 });
      sendJson(res, 200, { ok: true, ticks: seqs.length });
    })().catch((e) => { if (!res.headersSent) sendJson(res, 500, { error: 'send-keys failed: ' + e.message }); });
  });
}

// Hook side. POST {kind, session_id, payload}: `stop` / `notification` are
// recorded and answered at once; `question` / `permission` are HELD until the
// glasses answer or release them, the watcher goes away, or the hold ages out
// — and only if the key is watched when they arrive (V75).
function handleTermPendingPost(req, res, key) {
  if (!relayKeyOr400(res, key)) return;
  readJsonBody(req, res, 256 * 1024, (body, err) => {
    if (err) return;
    if (!body || !termRelayLib.KINDS.includes(body.kind)) return sendJson(res, 400, { error: 'unknown kind' });
    const payload = body.payload && typeof body.payload === 'object' ? body.payload : {};
    if (body.kind === 'stop') {
      termRelay.setState(key, { lastMessage: String(payload.last_assistant_message || ''), lastMessageAt: Date.now() });
      return sendJson(res, 200, { ok: true, relay: false, reason: 'recorded' });
    }
    if (body.kind === 'notification') {
      termRelay.setState(key, { notification: payload, notificationAt: Date.now() });
      return sendJson(res, 200, { ok: true, relay: false, reason: 'recorded' });
    }
    termRelay.hold(key, body.kind, payload).then((result) => sendJson(res, 200, { ok: true, ...result }));
  });
}

function handleTermPendingGet(_req, res, key) {
  if (!relayKeyOr400(res, key)) return;
  sendJson(res, 200, { pending: termRelay.getPending(key), state: termRelay.getState(key) });
}

// Glasses side. POST {id, answer} resolves the held prompt; {id, release:true}
// hands it back to the TUI.
function handleTermPendingAnswer(req, res, key) {
  if (!relayKeyOr400(res, key)) return;
  readJsonBody(req, res, 64 * 1024, (body, err) => {
    if (err) return;
    if (!body || typeof body.id !== 'string') return sendJson(res, 400, { error: 'id required' });
    const result = body.release
      ? termRelay.release(key, body.id)
      : termRelay.answer(key, body.id, body.answer && typeof body.answer === 'object' ? body.answer : {});
    if (!result.ok) return sendJson(res, result.status, { error: result.error });
    sendJson(res, 200, { ok: true });
  });
}

// POST raw PCM (16 kHz s16le mono) → forwarded to the whisper service
// (services/stt/, STT_URL) → {text}. 503 when the service is down.
async function handleStt(req, res) {
  const body = await readRawBody(req, res, 16 * 1024 * 1024);
  if (body === null) return;
  let upstream;
  try {
    upstream = await fetch(STT_URL + '/transcribe', {
      method: 'POST',
      headers: { 'content-type': req.headers['content-type'] || 'application/octet-stream' },
      body,
      signal: AbortSignal.timeout(60000),
    });
  } catch (e) {
    return sendJson(res, 503, { error: 'stt unavailable: ' + e.message });
  }
  const text = await upstream.text();
  res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' });
  res.end(text);
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
  fs.writeFileSync(path.join(dir, 'SPEC.md'), specTemplate(name));
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

// Vite-based template scaffold (vite | game-2d | game-3d | game-3d-complex |
// evenhub).
// Copies templates/<templateId>/ → project dir with `<NAME>`/`<PORT>`
// placeholders replaced, stamps .project-meta.json, optionally overlays the
// _firebase template + installs firebase, runs `npm install`, then enables the
// per-project vite@<name>.service. All templates are vite projects so they
// reuse the one unit — no per-template service (SPEC §V43). Cleans up on any
// failure so the caller's "doesn't exist" precondition is restored on retry.
// SPEC §V21–V26, §V43–V45.
// The dev-server unit for a project folder: a top-level folder rides the
// plain template (`vite@<name>`), a nested one the path template
// (`vite-path@<escaped rel>`, whose %I unescapes to the folder) (V99).
function devServerUnit(kind, dir) {
  const rel = path.relative(PROJECTS_ROOT, dir).split(path.sep).join('/');
  return rel.includes('/') ? `${kind}-path@${systemdEscapePath(rel)}.service` : `${kind}@${path.basename(dir)}.service`;
}

async function bootstrapTemplate(dir, name, templateId, { firebase = false } = {}) {
  fs.mkdirSync(dir, { recursive: false });
  const port = allocatePort(PROJECTS_ROOT);
  const unit = devServerUnit('vite', dir);
  const templateDir = path.join(__dirname, 'templates', templateId);
  try {
    copyTemplate(templateDir, dir, { NAME: name, PORT: String(port), NAMESLUG: nameSlug(name) });
    // Firebase overlay copied over the base tree before install so `npm
    // install firebase` and the base install can be folded into one step.
    // npm merges firebase into package.json — avoids JSON-merge-via-placeholder
    // (SPEC §V45).
    if (firebase) {
      copyTemplate(path.join(__dirname, 'templates', '_firebase'), dir, { NAME: name, PORT: String(port), NAMESLUG: nameSlug(name) });
    }
    // Write meta before npm install so a failed install still leaves a
    // recognizable managed project that DELETE /api/projects can clean up.
    fs.writeFileSync(
      path.join(dir, '.project-meta.json'),
      JSON.stringify({
        name,
        createdAt: new Date().toISOString(),
        template: templateId,
        proxyTarget: 'http://127.0.0.1:' + port,
        proxyPrefix: '/' + name,
        stripPrefix: false,
        openUrl: '/' + name + '/',
        extraUnits: [unit],
      }, null, 2) + '\n',
    );
    // Command AND env both come from lib/scaffold-install.js — the hub runs
    // under NODE_ENV=production, which npm reads as --omit=dev and which would
    // otherwise skip every devDependency (vite included) while still exiting 0.
    // See B20 / V65 for why it takes both a flag and an env override.
    const installCmd = scaffoldInstall.installCommand({ firebase });
    await execFileP('/bin/bash', ['-lc', 'export NVM_DIR=$HOME/.nvm && . $NVM_DIR/nvm.sh && ' + installCmd, dir], {
      timeout: 5 * 60 * 1000,
      env: scaffoldInstall.installEnv(process.env),
    });
    // sudoers grant for `sudo -n systemctl enable --now vite@<name>.service`
    // mirrors the existing ttyd@ grant — see services/ install instructions.
    await execFileP('sudo', ['-n', 'systemctl', 'enable', '--now', unit], {
      timeout: 30000,
    });
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(templateId + ' scaffold failed: ' + e.message, { cause: e });
  }
  writeBootstrapPrompt(dir, name, 'greenfield', { templateId, firebase });
  return port;
}

// Jekyll/Bundler template scaffold. Unlike bootstrapTemplate (npm + vite@),
// this is a Ruby project: copy templates/jekyll/ → project dir with
// <NAME>/<PORT> filled, make serve-local.sh executable (copyTemplate writes
// 0644), stamp .project-meta.json (port allocated from the 4000s so it never
// collides with the Vite 5173+ range), `bundle install` against Gemfile.local
// into a project-local vendor/bundle, then enable jekyll@<name>.service. Cleans
// up on any failure so the caller's "doesn't exist" precondition holds on
// retry. SPEC §V52.
async function bootstrapJekyll(dir, name) {
  fs.mkdirSync(dir, { recursive: false });
  const port = allocatePort(PROJECTS_ROOT, 4000);
  const unit = devServerUnit('jekyll', dir);
  try {
    copyTemplate(path.join(__dirname, 'templates', 'jekyll'), dir, { NAME: name, PORT: String(port) });
    // copyTemplate writes files 0644; the systemd unit execs serve-local.sh
    // directly, so it must be marked executable.
    fs.chmodSync(path.join(dir, 'serve-local.sh'), 0o755);
    // Write meta before bundle install so a failed install still leaves a
    // recognizable managed project that DELETE /api/projects can clean up.
    fs.writeFileSync(
      path.join(dir, '.project-meta.json'),
      JSON.stringify({
        name,
        createdAt: new Date().toISOString(),
        template: 'jekyll',
        proxyTarget: 'http://127.0.0.1:' + port,
        proxyPrefix: '/' + name,
        stripPrefix: false,
        openUrl: '/' + name + '/',
        extraUnits: [unit],
        // Default-permalink Jekyll → URL mapping, so Browse shows a preview
        // eye-icon on .md files that render via the live preview (SPEC §V54).
        // README → site index; index.md → pretty dir URL; other .md → .html.
        routes: [
          { match: 'README.md', to: '/' },
          { match: '**/index.md', to: '/:dir/' },
          { match: '**/*.md', to: '/:dir/:name.html' },
        ],
      }, null, 2) + '\n',
    );
    // Gemfile.local (not Gemfile) + project-local vendor/bundle via .bundle/config.
    await execFileP('/bin/bash', ['-lc', 'cd "$0" && BUNDLE_GEMFILE=Gemfile.local bundle install', dir], {
      timeout: 5 * 60 * 1000,
    });
    await execFileP('sudo', ['-n', 'systemctl', 'enable', '--now', unit], {
      timeout: 30000,
    });
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error('jekyll scaffold failed: ' + e.message, { cause: e });
  }
  writeBootstrapPrompt(dir, name, 'greenfield', { templateId: 'jekyll' });
  return port;
}

// Dispatch to the right scaffolder for the template family. jekyll is a
// Ruby/Bundler project (its own unit + bundle install); everything else is a
// Vite project sharing vite@<name>.service. SPEC §V52.
function scaffoldProject(dir, name, template, { firebase = false } = {}) {
  return template === 'jekyll'
    ? bootstrapJekyll(dir, name)
    : bootstrapTemplate(dir, name, template, { firebase });
}

// Folders under `?dir=` (default the root) that have no sentinel yet (V99).
function handleListOrphans(_req, res, query) {
  let parent;
  try { parent = resolveUnder(PROJECTS_ROOT, query.get('dir') || '').abs; }
  catch (e) { return sendJson(res, e.statusCode || 400, { error: e.message }); }
  sendJson(res, 200, { dir: path.relative(PROJECTS_ROOT, parent).split(path.sep).join('/'), folders: listOrphanFolderNames(parent) });
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
    // `dir` = the folder the repo goes in, relative to the root; '' = the root (V99).
    let parent;
    try { parent = resolveUnder(PROJECTS_ROOT, body.dir || ''); }
    catch (e) { return sendJson(res, e.statusCode || 400, { error: 'bad dir: ' + e.message }); }
    let parentStat;
    try { parentStat = fs.statSync(parent.abs); } catch { parentStat = null; }
    if (!parentStat || !parentStat.isDirectory()) return sendJson(res, 404, { error: 'dir not found' });
    const dir = path.join(parent.abs, name);
    const relDir = parent.rel ? parent.rel + '/' + name : name;
    const gh = body.github || { mode: 'skip' };
    // Onboard adopts an existing folder, so its 404/409 logic lives in
    // bootstrapOnboard. Every other mode requires `dir` not yet exist.
    if (gh.mode !== 'onboard' && fs.existsSync(dir)) {
      return sendJson(res, 409, { error: 'project already exists' });
    }

    const template = effectiveTemplate(body);
    const firebase = firebaseEnabled(body, template);
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
        if (template !== 'none') {
          await scaffoldProject(dir, name, template, { firebase });
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
        if (template !== 'none') await scaffoldProject(dir, name, template, { firebase });
        else await bootstrapNoGithub(dir, name);
      }
    } catch (e) {
      const status = Number.isInteger(e && e.statusCode) ? e.statusCode : 500;
      return sendJson(res, status, { error: e.message });
    }

    // The project's first terminal is a hub session in its folder, seeded
    // with the bootstrap prompt the scaffold wrote (V96). No unit, no sudo.
    let session;
    try {
      let prompt;
      const bootstrapFile = path.join(dir, '.claude-bootstrap.txt');
      try { prompt = fs.readFileSync(bootstrapFile, 'utf8'); fs.unlinkSync(bootstrapFile); } catch {}
      session = v2Router.sessions.create({ cwd: relDir, agent: 'claude', profile: body.profile || null, prompt });
    } catch (e) {
      return sendJson(res, 500, { error: 'session create failed: ' + e.message });
    }
    refreshStaticRoutes();
    sendJson(res, 200, {
      name,
      path: relDir,
      sessionId: session.id,
      termKey: session.termKey,
      termUrl: session.termUrl,
      browseUrl: '/',
    });
  });
}

// PWA assets: manifest, service worker, icons. All static, all served from
// /assets/<name>. Service worker MUST be served from the root scope so it can
// control the whole site — see /sw.js handler below.
const ASSETS_DIR = path.join(__dirname, 'assets');
const ASSET_MIME = {
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
};
const ASSET_FILE_RE = /^[A-Za-z0-9._-]+$/;

function serveAsset(res, filename, cacheControl) {
  if (!ASSET_FILE_RE.test(filename) || filename.startsWith('.')) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('bad asset name');
    return;
  }
  const full = path.join(ASSETS_DIR, filename);
  fs.readFile(full, (err, body) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('asset not found');
      return;
    }
    const ext = path.extname(filename).toLowerCase();
    res.writeHead(200, {
      'Content-Type': ASSET_MIME[ext] || 'application/octet-stream',
      'Cache-Control': cacheControl,
    });
    res.end(body);
  });
}

// ---------- File upload ----------
// POST /api/upload/<project> — multipart/form-data with fields:
//   path     — folder relative to project root (created if missing). Optional.
//   filename — override saved name. Optional; defaults to client filename.
//   file     — the file bytes (required).
// Query: ?overwrite=1 — replace existing file. Default refuses with 409.
const UPLOAD_MAX_BYTES = 500 * 1024 * 1024; // 500 MB

// Parse a multipart/form-data body. Hand-rolled because the only dep we'd
// otherwise need (busboy) is overkill for one-file uploads.
function parseMultipart(body, boundary) {
  const delim = Buffer.from('\r\n--' + boundary);
  // Prepend \r\n so the first boundary (which has no leading newline) matches.
  const buf = Buffer.concat([Buffer.from('\r\n'), body]);
  const parts = [];
  let idx = 0;
  while (true) {
    const start = buf.indexOf(delim, idx);
    if (start < 0) break;
    const after = start + delim.length;
    // "--" terminator (last boundary).
    if (buf[after] === 0x2d && buf[after + 1] === 0x2d) break;
    // Expect \r\n after boundary, then headers, then \r\n\r\n, then content.
    if (buf[after] !== 0x0d || buf[after + 1] !== 0x0a) break;
    const headerStart = after + 2;
    const headerEnd = buf.indexOf('\r\n\r\n', headerStart);
    if (headerEnd < 0) break;
    const headers = buf.slice(headerStart, headerEnd).toString('utf8');
    const contentStart = headerEnd + 4;
    const next = buf.indexOf(delim, contentStart);
    if (next < 0) break;
    parts.push({ headers, content: buf.slice(contentStart, next) });
    idx = next;
  }
  return parts;
}

function parsePartDisposition(headers) {
  const m = /content-disposition:\s*form-data\s*;\s*([^\r\n]+)/i.exec(headers);
  if (!m) return null;
  const out = {};
  const re = /([a-zA-Z0-9_*-]+)\s*=\s*"((?:\\.|[^"\\])*)"/g;
  let mm;
  while ((mm = re.exec(m[1])) !== null) {
    out[mm[1].toLowerCase()] = mm[2].replace(/\\"/g, '"');
  }
  return out;
}

async function readBodyCapped(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const err = new Error('upload too large');
      err.tooLarge = true;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readMultipartParts(req, res) {
  const ct = req.headers['content-type'] || '';
  const bm = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
  if (!bm) {
    sendJson(res, 400, { error: 'expected multipart/form-data' });
    return null;
  }
  const boundary = (bm[1] || bm[2]).trim();
  let body;
  try {
    body = await readBodyCapped(req, UPLOAD_MAX_BYTES);
  } catch (e) {
    if (e.tooLarge) sendJson(res, 413, { error: 'upload too large (max ' + UPLOAD_MAX_BYTES + ' bytes)' });
    else sendJson(res, 400, { error: 'read error: ' + e.message });
    return null;
  }
  return parseMultipart(body, boundary);
}

function extractUploadFields(parts) {
  let relPath = '';
  let filename = null;
  let fileBuf = null;
  for (const p of parts) {
    const disp = parsePartDisposition(p.headers);
    if (!disp || !disp.name) continue;
    if (disp.name === 'path') {
      relPath = p.content.toString('utf8').trim();
    } else if (disp.name === 'filename') {
      const v = p.content.toString('utf8').trim();
      if (v) filename = v;
    } else if (disp.name === 'file') {
      if (filename == null && disp.filename) filename = disp.filename;
      fileBuf = p.content;
    }
  }
  return { relPath, filename, fileBuf };
}

function sanitizeFilename(name) {
  let n = name || '';
  n = n.replace(/^.*[\\/]/, '');
  if (!n || n === '.' || n === '..' || n.includes('\0')) return null;
  return n;
}

// Writes file to <rootDir>/<relPath>/<filename>, mkdir-p'ing the dir.
// scope is the human-facing label used in error messages ("project root" /
// "projects root"). Returns final path relative to rootDir on success.
function writeUploadToDir(res, rootDir, scope, relPath, filename, fileBuf, overwrite) {
  relPath = (relPath || '').replace(/^\/+|\/+$/g, '');
  if (relPath.split('/').some((seg) => seg === '..')) {
    return sendJson(res, 403, { error: `path escapes ${scope}` });
  }
  const targetDir = relPath ? path.resolve(rootDir, relPath) : rootDir;
  if (targetDir !== rootDir && !targetDir.startsWith(rootDir + path.sep)) {
    return sendJson(res, 403, { error: `path escapes ${scope}` });
  }
  const targetFile = path.join(targetDir, filename);
  if (!targetFile.startsWith(rootDir + path.sep)) {
    return sendJson(res, 403, { error: `path escapes ${scope}` });
  }

  if (fs.existsSync(targetDir)) {
    if (!fs.statSync(targetDir).isDirectory()) {
      return sendJson(res, 400, { error: 'target path is not a directory' });
    }
  } else {
    try { fs.mkdirSync(targetDir, { recursive: true }); } catch (e) {
      return sendJson(res, 500, { error: 'mkdir failed: ' + e.message });
    }
  }

  const finalRel = relPath ? `${relPath}/${filename}` : filename;
  if (!overwrite && fs.existsSync(targetFile)) {
    return sendJson(res, 409, { error: 'file exists', path: finalRel });
  }
  try {
    fs.writeFileSync(targetFile, fileBuf);
  } catch (e) {
    return sendJson(res, 500, { error: 'write failed: ' + e.message });
  }
  return { finalRel };
}

async function handleUploadAnywhere(req, res, query) {
  const parts = await readMultipartParts(req, res);
  if (!parts) return;
  const { relPath, filename: rawFilename, fileBuf } = extractUploadFields(parts);
  if (!fileBuf) return sendJson(res, 400, { error: 'missing "file" part' });
  const filename = sanitizeFilename(rawFilename || 'upload.bin');
  if (!filename) return sendJson(res, 400, { error: 'bad filename' });

  // Must target at least one segment — uploading directly into ~/projects/
  // itself would litter the root, and there's no view URL for that case.
  const cleanRel = (relPath || '').replace(/^\/+|\/+$/g, '');
  if (!cleanRel) {
    return sendJson(res, 400, { error: 'path is required (pick a folder under ~/projects)' });
  }

  const result = writeUploadToDir(
    res, PROJECTS_ROOT, 'projects root', cleanRel, filename, fileBuf,
    query.get('overwrite') === '1',
  );
  if (!result) return;
  const finalRel = result.finalRel; // e.g. "claude-hub/uploads/file.txt"
  sendJson(res, 200, { ok: true, path: finalRel, size: fileBuf.length });
}

// ---------- Roots ----------
const PROJECTS_ROOT = process.env.PROJECTS_ROOT || path.join(process.env.HOME || '/', 'projects');
// Publish PROJECTS_ROOT + CLAUDE_BIN so ttyd-attach.sh and any other child
// scripts inherit the same values (no per-spawn env wiring needed).
process.env.PROJECTS_ROOT = PROJECTS_ROOT;
process.env.CLAUDE_BIN = CLAUDE_BIN;

// `project` = a sentinel folder's path relative to the root (any depth, V99).
function readProjectProxyPrefix(project) {
  try {
    const meta = JSON.parse(fs.readFileSync(
      path.join(PROJECTS_ROOT, project, '.project-meta.json'), 'utf8'));
    const target = typeof meta.proxyTarget === 'string' ? meta.proxyTarget.trim() : '';
    if (!target) return null;
    const prefix = typeof meta.proxyPrefix === 'string' && meta.proxyPrefix.startsWith('/')
      ? meta.proxyPrefix
      : '/' + path.basename(project);
    if (!/^\/[A-Za-z0-9_./-]+$/.test(prefix)) return null;
    return prefix;
  } catch {
    return null;
  }
}

// Read + sanitize the `routes` array from .project-meta.json. Each rule is
// {match, to} of strings; `to` must be a root-relative URL path (starts with
// `/`). Anything malformed is dropped, so a bad rule can't inject a weird
// iframe src. The Browse view inlines `routeForPath` against this array to map
// source files → served pages (preview icons + render iframe). SPEC §V54.
function readProjectRoutes(project) {
  try {
    const meta = JSON.parse(fs.readFileSync(
      path.join(PROJECTS_ROOT, project, '.project-meta.json'), 'utf8'));
    if (!Array.isArray(meta.routes)) return [];
    const out = [];
    for (const r of meta.routes) {
      if (!r || typeof r.match !== 'string' || typeof r.to !== 'string') continue;
      if (r.match.length > 256 || r.to.length > 256) continue;
      // `to` is appended to PROXY_PREFIX and used as an iframe src — keep it a
      // root-relative path (optionally with a #fragment), no scheme/host/CRLF.
      if (!/^\/[^\s"'<>\\]*$/.test(r.to)) continue;
      out.push({ match: r.match, to: r.to });
    }
    return out;
  } catch {
    return [];
  }
}


// ---------- Hub v2 (/v2/ shell + /api/v2/*) ----------
// State (profiles, sessions) lives OUTSIDE the projects tree so it is never a
// file a tab could browse into or a repo could commit. Published to the
// environment so ttyd-attach-hub.sh reads the same records.
const HUB_STATE_DIR = process.env.HUB_STATE_DIR || path.join(os.homedir(), '.claude-hub');
process.env.HUB_STATE_DIR = HUB_STATE_DIR;

// [{name, activity}] — activity = tmux's last-activity epoch seconds, the
// "most recent response" a shell or codex session can report (V92).
async function tmuxListSessions() {
  try {
    const { stdout } = await execFileP('tmux', ['list-sessions', '-F', '#{session_name}\t#{session_activity}'], { timeout: 3000 });
    return stdout.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const [name, activity] = l.split('\t');
      return { name, activity: Number(activity) * 1000 || 0 };
    });
  } catch { return []; }
}

const v2Router = makeV2Router({
  projectsRoot: PROJECTS_ROOT, hubDir: HUB_STATE_DIR, sendJson, readJsonBody, execFileP,
  readProjectRoutes, readProjectProxyPrefix, tmuxListSessions, claudeBin: CLAUDE_BIN,
});
// The glasses app's four read-only v1 routes, served from v2 data (V97).
const g2Compat = makeG2Compat({ projectsRoot: PROJECTS_ROOT, sendJson, fsApi: v2Router.fs, listSessions: v2Router.listSessions });

const server = http.createServer(async (req, res) => {
  let url = req.url || '/';
  const q = url.indexOf('?');
  const urlPath = q < 0 ? url : url.slice(0, q);
  const query = q < 0 ? '' : url.slice(q);

  // The v2 workspace IS the site now: `/` serves it, `/v2/` keeps serving its
  // files, old `/v2/` and `/landing.html` links come home (V96).
  if (urlPath === '/' || urlPath === '/index.html') url = '/v2/' + query;
  else if (urlPath === '/v2' || urlPath === '/v2/' || urlPath === '/landing.html') {
    res.writeHead(301, { Location: '/' + query });
    res.end();
    return;
  }
  if (url.startsWith('/v2/') || url.startsWith('/api/v2/')) {
    try {
      if (await v2Router.handle(req, res, url)) return;
    } catch (e) {
      if (!res.headersSent) sendJson(res, 500, { error: e.message });
      return;
    }
  }

  // Legacy redirect: the raw-shell admin terminal was called `wsl` back when
  // this ran under WSL2. Keep old bookmarks working. 301 to the same subpath
  // under /term/shell/ — a silent socket alias would not work, since ttyd is
  // started with `-b /term/shell` and would emit asset URLs under that base.
  if (url === '/term/wsl' || url.startsWith('/term/wsl/') || url.startsWith('/term/wsl?')) {
    res.writeHead(301, { Location: '/term/shell' + url.slice('/term/wsl'.length) });
    res.end();
    return;
  }

  // Read-only v1 routes the glasses app still calls (lib/g2-compat.js).
  try {
    if (await g2Compat.handle(req, res, url)) return;
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { error: e.message });
    return;
  }

  // Repo creation (templates / clone / onboard) and its helpers.
  if (urlPath === '/api/projects') {
    if (req.method === 'POST') return handleCreateProject(req, res);
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('method not allowed');
    return;
  }
  if (urlPath === '/api/projects/orphans') {
    if (req.method === 'GET') return handleListOrphans(req, res, new URLSearchParams(query.slice(1)));
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('method not allowed');
    return;
  }
  if (urlPath === '/api/gh/repos') {
    if (req.method === 'GET') return handleGhRepos(req, res);
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('method not allowed');
    return;
  }
  if (urlPath === '/api/upload-anywhere') {
    if (req.method === 'POST') return handleUploadAnywhere(req, res, new URLSearchParams(query.slice(1)));
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('method not allowed');
    return;
  }

  // Glasses relay + speech-to-text.
  const termCaptureMatch = /^\/api\/term-capture\/([^/]+)$/.exec(urlPath);
  if (termCaptureMatch) {
    if (req.method === 'GET') return handleTermCapture(req, res, canonicalTermKey(decodeURIComponent(termCaptureMatch[1]))).catch((e) => { if (!res.headersSent) sendJson(res, 500, { error: e.message }); });
    res.writeHead(405, { 'Content-Type': 'text/plain' }); res.end('method not allowed'); return;
  }
  const termInputMatch = /^\/api\/term-input\/([^/]+)$/.exec(urlPath);
  if (termInputMatch) {
    if (req.method === 'POST') return handleTermInput(req, res, canonicalTermKey(decodeURIComponent(termInputMatch[1])));
    res.writeHead(405, { 'Content-Type': 'text/plain' }); res.end('method not allowed'); return;
  }
  const termScrollMatch = /^\/api\/term-scroll\/([^/]+)$/.exec(urlPath);
  if (termScrollMatch) {
    if (req.method === 'POST') return handleTermScroll(req, res, canonicalTermKey(decodeURIComponent(termScrollMatch[1])));
    res.writeHead(405, { 'Content-Type': 'text/plain' }); res.end('method not allowed'); return;
  }
  const termPendingAnswerMatch = /^\/api\/term-pending\/([^/]+)\/answer$/.exec(urlPath);
  if (termPendingAnswerMatch) {
    if (req.method === 'POST') return handleTermPendingAnswer(req, res, canonicalTermKey(decodeURIComponent(termPendingAnswerMatch[1])));
    res.writeHead(405, { 'Content-Type': 'text/plain' }); res.end('method not allowed'); return;
  }
  const termPendingMatch = /^\/api\/term-pending\/([^/]+)$/.exec(urlPath);
  if (termPendingMatch) {
    const key = canonicalTermKey(decodeURIComponent(termPendingMatch[1]));
    if (req.method === 'GET') return handleTermPendingGet(req, res, key);
    if (req.method === 'POST') return handleTermPendingPost(req, res, key);
    res.writeHead(405, { 'Content-Type': 'text/plain' }); res.end('method not allowed'); return;
  }
  if (urlPath === '/api/stt') {
    if (req.method === 'POST') return handleStt(req, res).catch((e) => { if (!res.headersSent) sendJson(res, 500, { error: e.message }); });
    res.writeHead(405, { 'Content-Type': 'text/plain' }); res.end('method not allowed'); return;
  }

  // PWA glue. /sw.js MUST live at the root so its default scope is "/".
  if (urlPath === '/sw.js') return serveAsset(res, 'sw.js', 'no-cache');
  if (urlPath === '/manifest.webmanifest') return serveAsset(res, 'manifest.webmanifest', 'no-cache');
  if (urlPath === '/favicon.ico' || urlPath === '/favicon.png') return serveAsset(res, 'favicon-32.png', 'public, max-age=86400');
  if (urlPath === '/apple-touch-icon.png' || urlPath === '/apple-touch-icon-precomposed.png') return serveAsset(res, 'apple-touch-icon.png', 'public, max-age=86400');
  if (urlPath.startsWith('/assets/')) return serveAsset(res, urlPath.slice('/assets/'.length), 'public, max-age=86400');

  // Bare prefix without trailing slash — redirect so relative-path resolution
  // in the upstream HTML lands correctly.
  for (const r of STATIC_ROUTES) {
    if (url === r.prefix) {
      res.writeHead(301, { Location: r.prefix + '/' });
      res.end();
      return;
    }
  }

  const route = findRoute(url);
  if (!route) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found. Try /, /api/v2/sessions, or /term/hub/?arg=<id>.');
    return;
  }

  rewriteUrl(req, route);
  // For bare /term/<key>/ HTML index requests we inject the mobile shims;
  // force identity encoding so the upstream returns plaintext we can rewrite.
  if (req.method === 'GET' && TERM_INDEX_RE.test(req.url)) {
    req.headers['accept-encoding'] = 'identity';
  }
  proxy.web(req, res, { target: routeTarget(route) });
});

server.on('upgrade', async (req, socket, head) => {
  const route = findRoute(req.url || '');
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

module.exports = { server, PROJECT_ID_RE, RESERVED_PROJECT_NAMES };
