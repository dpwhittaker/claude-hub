/**
 * The Browse two-pane shell — GET /view/<project>/.
 *
 * One self-contained HTML document: collapsible file tree on the left,
 * tabbed iframes on the right, an optional Develop pane with its own tab
 * strip below, and the client script that wires the WebSocket tree updates,
 * git-status colouring, scroll restore and preview eye-icons.
 *
 * Six pure helpers are shared with the server by injecting their source with
 * `.toString()` rather than duplicating them — so they must stay
 * self-contained (no closures over module scope).
 *
 * Pure: the caller resolves `proxyPrefix` and `routes` from the project's
 * .project-meta.json and passes them in.
 */

const { tabKey } = require('./tab-key');
const { installTouchWheel } = require('./touch-wheel');
const { isEmbedder, tabsToReload } = require('./tab-reload-targets');
const { matchGlob, routeForPath } = require('./file-routes');
const { escapeHtml } = require('./escape-html');

function renderViewShell(project, { proxyPrefix = null, routes = [] } = {}) {
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
  header.bar .header-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  header.bar .header-btn:disabled:hover { color: var(--muted); border-color: var(--edge); background: transparent; }
  main { flex: 1 1 auto; display: flex; flex-direction: column; min-height: 0; }
  .top-row { flex: 1 1 auto; display: flex; min-height: 0; min-width: 0; }
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
  /* Active row — contrast comes from background only so git-* foreground
     colours stay readable on the selected file. */
  .tree .file.active { background: rgba(125,211,252,0.18); }
  /* Git status classes — shared with tab labels. Uncommitted dirty work is
     yellow; HEAD/HEAD~1/HEAD~2/HEAD~3 fade from bright cyan to muted. Tab
     and file rules co-located so behaviour stays in sync. */
  .tree .file.git-uncommitted, .tab.git-uncommitted { color: #fde68a; }
  .tree .file.git-c0, .tab.git-c0 { color: #67e8f9; }
  .tree .file.git-c1, .tab.git-c1 { color: hsl(190, 55%, 70%); }
  .tree .file.git-c2, .tab.git-c2 { color: hsl(190, 35%, 62%); }
  .tree .file.git-c3, .tab.git-c3 { color: hsl(190, 22%, 56%); }
  /* Folder rollup — aggregates highest-precedence descendant status. Green
     (uncommitted descendant) is distinct from the file-level yellow so a
     glance separates "this folder has dirty work" from "this file is the
     dirty one". Cyan shades mirror the file scale. */
  .tree .tree-details.git-uncommitted > summary .dir-name { color: #86efac; }
  .tree .tree-details.git-c0 > summary .dir-name { color: #67e8f9; }
  .tree .tree-details.git-c1 > summary .dir-name { color: hsl(190, 55%, 70%); }
  .tree .tree-details.git-c2 > summary .dir-name { color: hsl(190, 35%, 62%); }
  .tree .tree-details.git-c3 > summary .dir-name { color: hsl(190, 22%, 56%); }
  .tree .dir-name { color: var(--fg); }
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
  body.resizing { user-select: none; }
  body.resizing.col { cursor: col-resize; }
  body.resizing.row { cursor: row-resize; }
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
  /* Active tab: keep the cyan top border as the affordance, but contrast
     comes from background only — foreground stays whatever the file's
     git-* class painted, so the user can still see status while it's
     selected. */
  .tab.active { background: rgba(125,211,252,0.14); border-top-color: var(--accent); }
  .tab .mode-tag {
    font-size: 0.62rem; letter-spacing: 0.06em; text-transform: uppercase;
    color: var(--muted); padding: 1px 5px; border: 1px solid var(--edge); border-radius: 4px;
  }
  .tab.active .mode-tag { border-color: var(--accent); }
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
  /* Work area = viewer pane only. Sits inside top-row (tree | work-area). */
  .work-area { flex: 1 1 auto; display: flex; min-width: 0; min-height: 0; }
  /* Develop pane: full <main> width, stacked below the top row (V38). */
  section.develop-pane {
    flex: 0 0 var(--develop-height, 40%);
    min-height: 180px;
    display: flex; flex-direction: column;
    background: var(--bg-0);
    border-top: 1px solid var(--edge);
  }
  /* Term-tabs strip — sits above the iframes inside the develop pane. */
  .term-tabs {
    display: flex; align-items: stretch; flex: 0 0 auto;
    background: var(--bg-1); border-bottom: 1px solid var(--edge);
    overflow-x: auto; scrollbar-width: thin;
  }
  .term-tab {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 6px 6px 6px 12px; font-size: 0.78rem;
    color: var(--muted); cursor: pointer; white-space: nowrap;
    border-right: 1px solid var(--edge);
    border-top: 2px solid transparent;
    transition: background 0.1s, color 0.1s;
  }
  .term-tab:hover { background: var(--bg-2); color: var(--fg); }
  .term-tab.active { background: rgba(125,211,252,0.14); border-top-color: var(--accent); color: var(--fg); }
  .term-tab .close {
    border: none; background: transparent; color: inherit;
    font-size: 0.95rem; line-height: 1; padding: 2px 4px;
    border-radius: 4px; cursor: pointer; opacity: 0.6;
  }
  .term-tab .close:hover { opacity: 1; background: rgba(252,165,165,0.15); color: #fca5a5; }
  .term-add {
    border: none; background: transparent; color: var(--muted);
    font-size: 1.05rem; line-height: 1; padding: 0 12px; cursor: pointer;
    transition: color 0.1s, background 0.1s;
  }
  .term-add:hover { color: var(--accent); background: var(--bg-2); }
  .term-frames { flex: 1 1 auto; position: relative; min-height: 0; background: var(--bg-0); }
  .term-frames iframe {
    position: absolute; inset: 0; width: 100%; height: 100%;
    border: none; background: var(--bg-0);
    display: none;
  }
  .term-frames iframe.active { display: block; }
  section.develop-pane[hidden], .splitter.develop-splitter[hidden] { display: none; }
  .splitter.develop-splitter {
    flex: 0 0 5px; cursor: row-resize;
    border-left: none; border-right: none;
    border-top: 1px solid var(--edge); border-bottom: 1px solid var(--edge);
  }
</style>
</head>
<body>
<header class="bar">
  <a class="home" href="/">claude-hub</a>
  <a href="/view/${safeProject}/">${safeProject}</a>
  <span class="sep">·</span>
  <span style="color: var(--muted);" id="path-hint">browse</span>
  <span class="spacer"></span>
  <button id="upload-btn" class="header-btn" type="button" title="Upload file" aria-label="Upload file">
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M8 11V2"/>
      <path d="M4 6l4-4 4 4"/>
      <path d="M2 13h12"/>
    </svg>
  </button>
  <button id="download-btn" class="header-btn" type="button" title="Download active file" aria-label="Download active file" disabled>
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M8 2v9"/>
      <path d="M4 7l4 4 4-4"/>
      <path d="M2 13h12"/>
    </svg>
  </button>
  <button id="develop-toggle" class="header-btn" type="button" title="Toggle develop pane" aria-label="Toggle develop pane">
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/>
      <path d="M4 6l2 2-2 2"/>
      <path d="M8 10h4"/>
    </svg>
  </button>
</header>
<main id="main">
  <div class="top-row" id="top-row">
    <aside class="tree-pane" id="tree-pane">
      <div class="tree-empty">loading…</div>
    </aside>
    <div class="splitter" id="splitter" title="Drag to resize"></div>
    <div class="work-area" id="work-area">
      <section class="viewer-pane">
        <div class="tabs" id="tabs"></div>
        <div class="frames" id="frames">
          <div class="empty-state" id="empty-state" hidden>No file open. Click a file in the tree.</div>
        </div>
      </section>
    </div>
  </div>
  <div class="splitter develop-splitter" id="develop-splitter" title="Drag to resize" hidden></div>
  <section class="develop-pane" id="develop-pane" hidden>
    <div class="term-tabs" id="term-tabs"></div>
    <div class="term-frames" id="term-frames"></div>
  </section>
</main>
<script>
const PROJECT = ${JSON.stringify(project)};
// Reverse-proxy prefix for this project (e.g. "/lifebot"), or null when the
// project has no proxyTarget. SPEC §V16 — eye-icon render mode routes through
// the proxy when set, since build-tool index.html files (Vite etc.) are
// source templates that can't run from raw bytes.
const PROXY_PREFIX = ${JSON.stringify(proxyPrefix)};
// File→URL route rules from .project-meta.json (SPEC §V54). routeForPath maps a
// source file → the page it renders at (relative to PROXY_PREFIX): a real
// Jekyll site's built HTML path, or a .nojekyll SPA's #fragment. Drives the
// preview eye-icon on .md (and any other routable file) + the render iframe.
const ROUTES = ${JSON.stringify(routes)};
const TREE_PANE = document.getElementById('tree-pane');
const TABS = document.getElementById('tabs');
const FRAMES = document.getElementById('frames');
const EMPTY = document.getElementById('empty-state');
const PATH_HINT = document.getElementById('path-hint');
const SPLITTER = document.getElementById('splitter');
const MAIN = document.getElementById('main');
const WORK_AREA = document.getElementById('work-area');
const DEVELOP_PANE = document.getElementById('develop-pane');
const DEVELOP_SPLITTER = document.getElementById('develop-splitter');
const TERM_TABS_EL = document.getElementById('term-tabs');
const TERM_FRAMES_EL = document.getElementById('term-frames');
const DEVELOP_TOGGLE = document.getElementById('develop-toggle');

// Tab state. Map<key, { path, mode, tab, frame }>. Composite key lets the
// same file open in both 'view' and 'render' modes side by side.
const tabs = new Map();
let activeKey = null;

// Map of project-relative path -> git tag ('uncommitted' | 'c0' | 'c1' | 'c2' |
// 'c3'). Seeded by the initial /api/view-tree fetch and replaced wholesale on
// each {type:'git-status'} push from the watcher. Tree rows and tab labels
// pull their git-* class from this map; whenever the map changes we re-walk
// .file and .tab elements and swap classes.
let CURRENT_GIT_STATUS = {};
const GIT_CLASSES = ['git-uncommitted', 'git-c0', 'git-c1', 'git-c2', 'git-c3'];

function gitClassFor(p) {
  const tag = CURRENT_GIT_STATUS[p];
  return tag ? 'git-' + tag : null;
}

function applyGitClass(el, p) {
  if (!el) return;
  el.classList.remove(...GIT_CLASSES);
  const cls = gitClassFor(p);
  if (cls) el.classList.add(cls);
}

const GIT_RANK = { uncommitted: 5, c0: 4, c1: 3, c2: 2, c3: 1 };

function tagFromClasses(el) {
  for (const c of GIT_CLASSES) {
    if (el.classList.contains(c)) return c.slice(4);
  }
  return null;
}

function applyGitStatusToAll() {
  for (const el of TREE_PANE.querySelectorAll('.file')) {
    applyGitClass(el, el.dataset.path);
  }
  for (const [, info] of tabs) {
    applyGitClass(info.tab, info.path);
  }
  // Directory aggregate: a folder takes the highest-precedence git status of
  // any descendant. uncommitted (green) beats c0..c3 (cyan, brightest = HEAD).
  // Deepest-first so parents read already-computed child <details> classes.
  const dirs = Array.from(TREE_PANE.querySelectorAll('.tree-details'));
  dirs.sort((a, b) =>
    (b.dataset.path || '').split('/').length - (a.dataset.path || '').split('/').length,
  );
  for (const det of dirs) {
    let best = null;
    const children = det.querySelectorAll(
      ':scope > ul > li > .file, :scope > ul > li > .tree-details',
    );
    for (const ch of children) {
      const tag = ch.classList.contains('file')
        ? CURRENT_GIT_STATUS[ch.dataset.path]
        : tagFromClasses(ch);
      if (!tag) continue;
      if (!best || GIT_RANK[tag] > GIT_RANK[best]) best = tag;
    }
    det.classList.remove(...GIT_CLASSES);
    if (best) det.classList.add('git-' + best);
  }
}

const TABS_KEY = 'view-shell:tabs:' + PROJECT;
const ACTIVE_KEY = 'view-shell:active:' + PROJECT;
const TREE_WIDTH_KEY = 'view-shell:tree-width';
const DEVELOP_VISIBLE_KEY = 'view-shell:develop-visible:' + PROJECT;
const DEVELOP_HEIGHT_KEY = 'view-shell:develop-height:' + PROJECT;
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

${installTouchWheel.toString()}

${isEmbedder.toString()}

${tabsToReload.toString()}

${matchGlob.toString()}

${routeForPath.toString()}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const EYE_SVG = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/>'
  + '<circle cx="8" cy="8" r="2"/>'
  + '</svg>';

function isHtmlFile(name) { return /\\.html?$/i.test(name); }
function isSvgFile(name) { return /\\.svg$/i.test(name); }
// Files the eye-icon can render in an iframe instead of showing source.
function isRenderable(name) { return isHtmlFile(name) || isSvgFile(name); }

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
    applyGitClass(fileEl, n.path);
    const nameSpan = document.createElement('span');
    nameSpan.className = 'file-name';
    nameSpan.textContent = n.name;
    fileEl.appendChild(nameSpan);
    fileEl.addEventListener('click', () => openTab(n.path, 'view'));
    // A file gets the preview eye-icon if it can be rendered in an iframe
    // (html/svg, raw or via proxy) OR it maps to a served page through the
    // project's routes (Jekyll-built HTML / SPA #fragment), which needs a
    // running backend (PROXY_PREFIX). SPEC §V16/§V54.
    const hasRoute = !!(PROXY_PREFIX && routeForPath(ROUTES, n.path));
    if (isRenderable(n.name) || hasRoute) {
      const eyeBtn = document.createElement('button');
      eyeBtn.type = 'button';
      eyeBtn.className = 'file-action';
      eyeBtn.title = isSvgFile(n.name) ? 'Render SVG'
        : (isHtmlFile(n.name) ? 'Render in iframe' : 'Preview rendered page');
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
  applyGitStatusToAll();
}

function handleDelete(p) {
  if (!p) return;
  const fileEl = TREE_PANE.querySelector('.file[data-path="' + CSS.escape(p) + '"]');
  if (fileEl) {
    const li = fileEl.closest('li');
    if (li) li.remove();
    closeTabsForPath(p);
    applyGitStatusToAll();
    return;
  }
  const det = TREE_PANE.querySelector('details.tree-details[data-path="' + CSS.escape(p) + '"]');
  if (det) {
    closeTabsUnderPath(p);
    const li = det.closest('li');
    if (li) li.remove();
    applyGitStatusToAll();
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

// File content changed on disk — reload every tab whose iframe content may
// have gone stale (V41): direct path match, OR embedder docs (.md/.html)
// that may transitively reference the changed asset (image/js/css).
// Scroll preserved per V11.
function handleChange(p) {
  for (const info of tabsToReload(tabs, p)) reloadTabFrame(info);
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
  applyGitClass(tab, filePath);
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
  // between segments. Render mode for HTML prefers the live proxy URL when
  // the project declares a proxyTarget (build-tool entry points like Vite's
  // index.html reference /src/main.tsx and cannot run from raw bytes);
  // falls back to ?raw=1 for projects with no proxy. SVG render is always
  // ?raw=1 — the browser renders the image/svg+xml bytes natively, and an
  // .svg is a source file, not a proxy app entry point. View mode always
  // goes through /view/ with ?embed=1 (per-file header stripped).
  const routeUrl = (mode === 'render' && PROXY_PREFIX) ? routeForPath(ROUTES, filePath) : null;
  if (routeUrl) {
    // The file maps to a served page (Jekyll-built HTML or SPA #fragment).
    // routeUrl already carries its own leading slash + any #fragment; encodeURI
    // keeps '/', '#', ':' intact while escaping spaces/unicode. SPEC §V54.
    frame.src = PROXY_PREFIX + encodeURI(routeUrl);
  } else if (mode === 'render' && PROXY_PREFIX && isHtmlFile(filePath)) {
    // index.html at any depth → trailing slash (let the upstream serve
    // its own root index). Other paths pass through verbatim so e.g.
    // public/foo.html lands on <proxyPrefix>/public/foo.html.
    const lower = filePath.toLowerCase();
    const isIndex = lower === 'index.html' || lower === 'index.htm'
      || lower.endsWith('/index.html') || lower.endsWith('/index.htm');
    let tail;
    if (isIndex) {
      const lastSlash = filePath.lastIndexOf('/');
      tail = lastSlash < 0 ? '' : filePath.slice(0, lastSlash + 1);
    } else {
      tail = filePath;
    }
    const segs = tail.split('/').map(encodeURIComponent).join('/');
    frame.src = PROXY_PREFIX + '/' + segs;
  } else {
    const segs = filePath.split('/').map(encodeURIComponent).join('/');
    const qs = mode === 'render' ? '?raw=1' : '?embed=1';
    frame.src = '/view/' + encodeURIComponent(PROJECT) + '/' + segs + qs;
  }
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
  refreshDownloadBtn();
  saveTabs();
}

function refreshDownloadBtn() {
  const btn = document.getElementById('download-btn');
  if (!btn) return;
  const info = activeKey ? tabs.get(activeKey) : null;
  btn.disabled = !info;
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
      refreshDownloadBtn();
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
  document.body.classList.add('resizing', 'col');
});

// Develop pane: terminal iframe to /term/<project>/. Sits below the
// tree+viewer row, spanning the full <main> width (V38). Height persisted
// per-project so refresh keeps the layout.
function setDevelopHeight(px) {
  const total = MAIN.getBoundingClientRect().height;
  const clamped = Math.max(180, Math.min(Math.max(180, total - 180), px));
  document.documentElement.style.setProperty('--develop-height', clamped + 'px');
  try { localStorage.setItem(DEVELOP_HEIGHT_KEY, String(clamped)); } catch {}
}
function loadDevHeight() {
  try { return parseFloat(localStorage.getItem(DEVELOP_HEIGHT_KEY) || ''); } catch { return NaN; }
}
const _h0 = loadDevHeight();
if (Number.isFinite(_h0)) setDevelopHeight(_h0);

// Term-tabs state (V47/V48). Map<tabId, {tab, iframe, uuid}>. Server is the
// source of truth via /api/term-sessions/<project>; this map mirrors the
// live DOM. Switching tabs PUTs lastActive but does NOT broadcast — other
// devices stay on whatever tab they're on.
const termTabs = new Map();
let activeTermId = null;
let termTabsInitialised = false;

function termKey(id) { return PROJECT + '__' + id; }

function setActiveTerm(id) {
  if (!termTabs.has(id)) return;
  activeTermId = id;
  for (const [tid, info] of termTabs) {
    const isActive = tid === id;
    info.tab.classList.toggle('active', isActive);
    info.iframe.classList.toggle('active', isActive);
  }
  // Persist lastActive — server-side only, no broadcast.
  fetch('/api/term-sessions/' + encodeURIComponent(PROJECT) + '/active', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  }).catch(() => {});
}

function formatTermLabel(id, title) {
  if (!title) return id;
  const trimmed = title.trim();
  if (!trimmed) return id;
  return trimmed.length > 24 ? trimmed.slice(0, 23) + '…' : trimmed;
}

function applyTermLabel(info, id, title) {
  info.title = title || null;
  info.tab.querySelector('.label').textContent = formatTermLabel(id, title);
  info.tab.title = title ? id + ' — ' + title : 'Tab ' + id;
}

function buildTermTab(id, title) {
  const tab = document.createElement('div');
  tab.className = 'term-tab';
  tab.dataset.id = id;
  tab.innerHTML = '<span class="label"></span><button type="button" class="close" title="Close tab" aria-label="Close tab">×</button>';
  tab.addEventListener('click', (e) => {
    if (e.target.closest('.close')) return;
    setActiveTerm(id);
  });
  tab.querySelector('.close').addEventListener('click', (e) => {
    e.stopPropagation();
    closeTermTab(id);
  });
  return tab;
}

function buildTermIframe(id) {
  const iframe = document.createElement('iframe');
  iframe.title = 'Develop terminal ' + id;
  iframe.src = '/term/' + encodeURIComponent(termKey(id)) + '/';
  iframe.addEventListener('load', () => {
    try {
      const doc = iframe.contentDocument;
      if (doc) installTouchWheel(doc);
    } catch {}
  });
  return iframe;
}

function addTermTab(id, opts) {
  const tab = buildTermTab(id);
  const iframe = buildTermIframe(id);
  const info = { tab, iframe, title: null };
  termTabs.set(id, info);
  applyTermLabel(info, id, (opts && opts.title) || null);
  TERM_ADD_BTN.before(tab);
  TERM_FRAMES_EL.appendChild(iframe);
  if (opts && opts.activate) setActiveTerm(id);
}

async function refreshTermLabels() {
  try {
    const r = await fetch('/api/term-sessions/' + encodeURIComponent(PROJECT));
    if (!r.ok) return;
    const data = await r.json();
    for (const s of data.sessions || []) {
      const info = termTabs.get(s.id);
      if (info) applyTermLabel(info, s.id, s.title);
    }
  } catch {}
}

async function createTermTab() {
  let body;
  try {
    const r = await fetch('/api/term-sessions/' + encodeURIComponent(PROJECT), { method: 'POST' });
    if (!r.ok) throw new Error('POST failed: ' + r.status);
    body = await r.json();
  } catch (e) {
    console.warn('createTermTab failed:', e);
    return;
  }
  addTermTab(body.id, { activate: true });
}

async function closeTermTab(id) {
  if (!termTabs.has(id)) return;
  try {
    const r = await fetch('/api/term-sessions/' + encodeURIComponent(PROJECT) + '/' + encodeURIComponent(id), {
      method: 'DELETE',
    });
    if (!r.ok) throw new Error('DELETE failed: ' + r.status);
  } catch (e) {
    console.warn('closeTermTab failed:', e);
    return;
  }
  const info = termTabs.get(id);
  info.tab.remove();
  info.iframe.remove();
  termTabs.delete(id);
  if (activeTermId === id) {
    activeTermId = null;
    const next = termTabs.keys().next();
    if (!next.done) setActiveTerm(next.value);
  }
  // Spec: closing last tab spawns a fresh one.
  if (termTabs.size === 0) createTermTab();
}

const TERM_ADD_BTN = document.createElement('button');
TERM_ADD_BTN.type = 'button';
TERM_ADD_BTN.className = 'term-add';
TERM_ADD_BTN.title = 'New terminal tab';
TERM_ADD_BTN.setAttribute('aria-label', 'New terminal tab');
TERM_ADD_BTN.textContent = '+';
TERM_ADD_BTN.addEventListener('click', createTermTab);
TERM_TABS_EL.appendChild(TERM_ADD_BTN);

async function initTermTabs() {
  if (termTabsInitialised) return;
  termTabsInitialised = true;
  let data;
  try {
    const r = await fetch('/api/term-sessions/' + encodeURIComponent(PROJECT));
    if (!r.ok) throw new Error('GET failed: ' + r.status);
    data = await r.json();
  } catch (e) {
    console.warn('initTermTabs failed:', e);
    termTabsInitialised = false;
    return;
  }
  const sessions = data.sessions || [];
  if (sessions.length === 0) {
    await createTermTab();
    return;
  }
  for (const s of sessions) addTermTab(s.id, { title: s.title });
  const initialId = (data.lastActive && termTabs.has(data.lastActive))
    ? data.lastActive : sessions[0].id;
  setActiveTerm(initialId);
  // Poll for AI-generated title updates while the develop pane is open.
  // Claude writes one ai-title record per assistant turn; latest wins.
  if (!window.__termLabelPoll) {
    window.__termLabelPoll = setInterval(refreshTermLabels, 30000);
  }
}

function showDevelop(show) {
  DEVELOP_PANE.hidden = !show;
  DEVELOP_SPLITTER.hidden = !show;
  DEVELOP_TOGGLE.classList.toggle('active', show);
  if (show) initTermTabs();
  try { localStorage.setItem(DEVELOP_VISIBLE_KEY, show ? '1' : '0'); } catch {}
}
DEVELOP_TOGGLE.addEventListener('click', () => showDevelop(DEVELOP_PANE.hidden));

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
  document.body.classList.add('resizing', 'row');
});

window.addEventListener('mousemove', (e) => {
  if (treeDragging) {
    setTreeWidth(e.clientX);
  } else if (devDragging) {
    const rect = MAIN.getBoundingClientRect();
    setDevelopHeight(rect.bottom - e.clientY);
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
  document.body.classList.remove('resizing', 'col', 'row');
});

// Bootstrap: fetch tree, render, restore saved tabs (or open README.md).
fetch('/api/view-tree/' + encodeURIComponent(PROJECT))
  .then((r) => r.json())
  .then((data) => {
    CURRENT_GIT_STATUS = data.gitStatus || {};
    TREE_PANE.innerHTML = '';
    const root = data.tree || [];
    if (root.length === 0) {
      TREE_PANE.innerHTML = '<div class="tree-empty">empty project</div>';
    } else {
      buildTree(root, TREE_PANE);
      applyGitStatusToAll();
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
    else if (msg.type === 'git-status') {
      CURRENT_GIT_STATUS = msg.gitStatus || {};
      applyGitStatusToAll();
    }
  });
  treeWS.addEventListener('close', scheduleTreeWSReconnect);
  treeWS.addEventListener('error', () => { try { treeWS.close(); } catch {} });
}
function scheduleTreeWSReconnect() {
  setTimeout(connectTreeWS, treeWSBackoff);
  treeWSBackoff = Math.min(treeWSBackoff * 2, 30000);
}
</script>
<script src="/static/upload-dialog.js"></script>
<script>
(function () {
  const btn = document.getElementById('upload-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    // The /ws/view-tree socket auto-refreshes after the file lands, so no
    // explicit tree reload is needed.
    window.UploadDialog.open({ project: PROJECT, path: '', lockProject: true });
  });

  const dl = document.getElementById('download-btn');
  if (dl) {
    dl.addEventListener('click', async () => {
      const info = activeKey ? tabs.get(activeKey) : null;
      if (!info) return;
      const parts = info.path.split('/').map(encodeURIComponent).join('/');
      const url = '/view/' + encodeURIComponent(PROJECT) + '/' + parts + '?download=1';
      const name = info.path.split('/').pop() || 'download';
      // File System Access API → real OS Save-As dialog (Chrome/Edge desktop
      // and Chrome Android 121+). The <a download> path lands silently in the
      // Downloads folder. Try the picker first, fall back on no-support or
      // SecurityError (cross-origin iframe etc.).
      if (typeof window.showSaveFilePicker === 'function') {
        try {
          const handle = await window.showSaveFilePicker({ suggestedName: name });
          const r = await fetch(url);
          if (!r.ok) throw new Error('fetch ' + r.status);
          const w = await handle.createWritable();
          if (r.body && typeof r.body.pipeTo === 'function') {
            await r.body.pipeTo(w);
          } else {
            await w.write(await r.blob());
            await w.close();
          }
          return;
        } catch (e) {
          if (e && e.name === 'AbortError') return; // user cancelled
          // Anything else → fall through to anchor download.
        }
      }
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
  }
})();
</script>
</body>
</html>`;
}

module.exports = { renderViewShell };
