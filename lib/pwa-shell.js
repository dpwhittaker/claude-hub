/**
 * The per-project PWA shell — GET /p/<project>/.
 *
 * A single-project wrapper around the same three views the landing card
 * offers (Open / Browse / Develop), built for a phone or tablet: installable
 * via the web manifest, a FAB that cycles TERM -> OPEN -> VIEW (with SPLIT
 * spliced in where split is enabled), a long-press menu carrying refresh plus
 * the sticky split preference, and keyboard-fit handling so the terminal
 * stays visible when the on-screen keyboard opens.
 *
 * Pure: everything it needs arrives as arguments.
 */

const { escapeHtml } = require('./escape-html');

function renderShellHtml(name, openUrl, termUrl, initialView) {
  // browseUrl = the /view/<name>/ shell — the VIEW pane. It is a first-class
  // third pane rather than a layout-dependent swap of the OPEN pane's src:
  // the FAB reaches it in every layout, and a split's right half just shows
  // whichever of OPEN / VIEW the user was last on.
  const browseUrl = '/view/' + encodeURIComponent(name) + '/';
  const data = JSON.stringify({
    name, openUrl, browseUrl, termUrl, initial: initialView,
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<title>${escapeHtml(name)} · claude-hub</title>
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#0d1320">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<style>
  :root { color-scheme: dark; --bg:#050810; --fab:#0d1320; --fab-edge:#1f2937; --accent:#7dd3fc; --fg:#e2e8f0; }
  html, body { margin: 0; padding: 0; height: 100%; background: var(--bg); color: var(--fg);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    overflow: hidden; }
  /* --vvh tracks visualViewport.height so panes shrink with the on-screen
     keyboard. position:absolute (not fixed) so the iframe element follows
     html/body height — fixed positioning anchors to layout viewport on iOS
     Safari and won't shrink. Fallback 100dvh for browsers without the JS
     shim path. */
  .pane {
    position: absolute; top: 0; left: 0;
    width: 100%; height: var(--vvh, 100dvh);
    border: 0; background: var(--bg);
    visibility: hidden; pointer-events: none;
  }
  .pane.active { visibility: visible; pointer-events: auto; }
  /* Term pane = tab strip + iframes (one per tmux session). Visually one
     pane; mechanically a div that wraps the per-session ttyd iframes plus
     the tab strip up top. */
  #pane-term { display: flex; flex-direction: column; }
  .term-tabs {
    display: flex; align-items: stretch; flex: 0 0 auto;
    background: #0d1320; border-bottom: 1px solid var(--fab-edge);
    overflow-x: auto; scrollbar-width: thin;
  }
  /* Home — an installed PWA has no browser chrome, so this strip is the only
     route back to the hub. Sticky so it survives the strip's own x-scroll. */
  .term-home {
    display: inline-flex; align-items: center; justify-content: center;
    flex: 0 0 auto; padding: 0 12px; color: #94a3b8;
    text-decoration: none; border-right: 1px solid var(--fab-edge);
    position: sticky; left: 0; background: #0d1320; z-index: 1;
  }
  .term-home:hover, .term-home:focus-visible { color: var(--accent); background: #131b2c; outline: none; }
  .term-tab {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 6px 6px 6px 12px; font-size: 0.78rem;
    color: #94a3b8; cursor: pointer; white-space: nowrap;
    border-right: 1px solid var(--fab-edge);
    border-top: 2px solid transparent;
  }
  .term-tab:hover { background: #131b2c; color: var(--fg); }
  .term-tab.active { background: rgba(125,211,252,0.14); border-top-color: var(--accent); color: var(--fg); }
  .term-tab .close {
    border: none; background: transparent; color: inherit;
    font-size: 0.95rem; line-height: 1; padding: 2px 4px;
    border-radius: 4px; cursor: pointer; opacity: 0.6;
  }
  .term-tab .close:hover { opacity: 1; background: rgba(252,165,165,0.15); color: #fca5a5; }
  .term-add {
    border: none; background: transparent; color: #94a3b8;
    font-size: 1.05rem; line-height: 1; padding: 0 12px; cursor: pointer;
  }
  .term-add:hover { color: var(--accent); background: #131b2c; }
  .term-frames { flex: 1 1 auto; position: relative; min-height: 0; background: var(--bg); }
  .term-frames iframe {
    position: absolute; inset: 0; width: 100%; height: 100%;
    border: 0; background: var(--bg); display: none;
  }
  .term-frames iframe.active { display: block; }
  /* Split mode: Develop on the left, OPEN or VIEW on the right, 1px divider
     between. Only .pane.active is painted (rule above) — with three panes a
     blanket "body.split .pane { visibility: visible }" would stack the idle
     right-hand pane over the live one. */
  body.split #pane-term { width: 50%; left: 0; border-right: 1px solid var(--fab-edge); box-sizing: border-box; }
  body.split #pane-open, body.split #pane-view { width: 50%; left: 50%; }
  /* Pane below active still consumes layout but is fully covered. Visibility
     hidden keeps DOM + iframe document alive (no unload) and just blocks input
     + paint. display:none would risk unloading some browsers' iframe state. */
  #fab {
    position: fixed;
    right: max(14px, env(safe-area-inset-right, 0px));
    bottom: max(14px, env(safe-area-inset-bottom, 0px));
    z-index: 9999;
    width: 52px; height: 52px;
    border-radius: 50%;
    background: var(--fab);
    border: 1px solid var(--fab-edge);
    color: var(--accent);
    box-shadow: 0 4px 14px rgba(0,0,0,0.5);
    display: grid; place-items: center;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
    transition: transform 0.12s, background 0.12s;
    font: 600 11px/1 ui-sans-serif, system-ui, sans-serif;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    padding: 0;
  }
  #fab:hover, #fab:focus-visible { background: #131b2c; outline: none; }
  #fab:active { transform: scale(0.92); }
  #fab .label { display: block; }
  #fab .hint { display: block; font-size: 8px; opacity: 0.6; margin-top: 2px; letter-spacing: 0.1em; }
  /* Long-press menu + its dismiss scrim. The scrim is what makes an outside
     tap work at all: every pane is a cross-origin-ish iframe, so a tap that
     lands in one never reaches this document. */
  #fab-scrim { position: fixed; inset: 0; z-index: 9998; }
  #fab-menu {
    position: fixed; z-index: 10000; min-width: 176px;
    display: grid; gap: 2px; padding: 4px;
    background: var(--fab); border: 1px solid var(--fab-edge);
    border-radius: 12px; box-shadow: 0 12px 30px rgba(0,0,0,0.6);
  }
  #fab-menu[hidden] { display: none; }
  .fab-menu-item {
    display: flex; align-items: center; gap: 10px; width: 100%;
    padding: 10px 12px; border: 0; border-radius: 8px;
    background: transparent; color: var(--fg); cursor: pointer;
    text-align: left; -webkit-tap-highlight-color: transparent;
    font: 500 0.84rem/1.2 ui-sans-serif, system-ui, sans-serif;
  }
  .fab-menu-item:hover, .fab-menu-item:focus-visible { background: #131b2c; color: var(--accent); outline: none; }
  .fab-menu-item .check { flex: 0 0 14px; text-align: center; opacity: 0.85; }
  /* Edge swipe hint dot — barely visible, just signals the FAB exists when
     viewing terminal full-screen on a phone. */
  @media (display-mode: standalone) {
    #fab { width: 56px; height: 56px; }
  }
</style>
</head>
<body>
<iframe id="pane-open" class="pane" title="Open" allow="clipboard-read; clipboard-write; fullscreen"></iframe>
<iframe id="pane-view" class="pane" title="Browse" allow="clipboard-read; clipboard-write; fullscreen"></iframe>
<div id="pane-term" class="pane" role="region" aria-label="Develop terminals">
  <div class="term-tabs" id="term-tabs">
    <a class="term-home" href="/" title="claude-hub home" aria-label="claude-hub home">
      <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M2 7.2 8 2.2l6 5"/>
        <path d="M3.6 6.6v6.6h8.8V6.6"/>
        <path d="M6.6 13.2V9.4h2.8v3.8"/>
      </svg>
    </a>
  </div>
  <div class="term-frames" id="term-frames"></div>
</div>
<button id="fab" type="button" aria-label="Switch view"><span class="label">TERM</span><span class="hint">SWAP</span></button>
<div id="fab-scrim" hidden></div>
<div id="fab-menu" role="menu" aria-label="View options" hidden>
  <button type="button" class="fab-menu-item" id="fab-refresh" role="menuitem">
    <span class="check" aria-hidden="true">&#8635;</span><span class="text">Refresh</span>
  </button>
  <button type="button" class="fab-menu-item" id="fab-split" role="menuitemcheckbox" aria-checked="false">
    <span class="check" aria-hidden="true"></span><span class="text">Split view</span>
  </button>
</div>
<script id="shell-data" type="application/json">${data}</script>
<script>
(function () {
  const cfg = JSON.parse(document.getElementById('shell-data').textContent);
  const panes = {
    term: document.getElementById('pane-term'),
    open: document.getElementById('pane-open'),
    view: document.getElementById('pane-view'),
  };
  // Each pane owns one fixed src for the life of the page — no layout-driven
  // swapping, so a rotation never re-navigates anything.
  const sources = { term: cfg.termUrl, open: cfg.openUrl, view: cfg.browseUrl };
  const mounted = { term: false, open: false, view: false };
  const labels = { term: 'TERM', open: 'OPEN', view: 'VIEW', split: 'SPLIT' };
  // The single-pane rotation, in FAB-tap order. SPLIT is spliced in after the
  // last entry when it is enabled — see nextView().
  const CYCLE = ['term', 'open', 'view'];
  // The two panes that can occupy the right half of a split.
  const RIGHT_VIEWS = ['open', 'view'];
  const fab = document.getElementById('fab');
  const fabLabel = fab.querySelector('.label');

  // Split is a per-device, per-project preference set from the long-press
  // menu — not a pure function of the viewport. '1'/'0' in localStorage beats
  // the media query in BOTH directions, so a phone can be forced into split
  // and a landscape tablet forced out of it. Unset ⇒ the media query decides.
  const SPLIT_PREF_KEY = 'claude-hub:split:' + cfg.name;
  const splitMq = window.matchMedia('(min-width: 900px) and (orientation: landscape)');
  let splitPref = (function readSplitPref() {
    try {
      const raw = localStorage.getItem(SPLIT_PREF_KEY);
      if (raw === '1') return true;
      if (raw === '0') return false;
    } catch {}
    return null;
  })();
  function splitEnabled() { return splitPref === null ? splitMq.matches : splitPref; }
  function setSplitPref(on) {
    splitPref = on;
    try { localStorage.setItem(SPLIT_PREF_KEY, on ? '1' : '0'); } catch {}
  }

  let currentView = null;
  // Which of OPEN / VIEW the split's right half shows: the last one the cycle
  // landed on. Defaults to VIEW so a landscape tablet still opens on
  // term + Browse the way it always has.
  let rightView = 'view';

  // ---------- term-tab strip (V47) ----------
  // Mirrors the develop-pane logic in renderViewShell: one iframe per tmux
  // session, switch is instant + state preserved, close-last auto-spawns,
  // lastActive persisted server-side (no broadcast).
  const TERM_TABS_EL = document.getElementById('term-tabs');
  const TERM_FRAMES_EL = document.getElementById('term-frames');
  const termTabs = new Map();
  let activeTermId = null;
  function projectTermKey(id) { return cfg.name + '__' + id; }
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
  function setActiveTerm(id) {
    if (!termTabs.has(id)) return;
    activeTermId = id;
    for (const [tid, info] of termTabs) {
      const isActive = tid === id;
      info.tab.classList.toggle('active', isActive);
      info.iframe.classList.toggle('active', isActive);
    }
    fetch('/api/term-sessions/' + encodeURIComponent(cfg.name) + '/active', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    }).catch(() => {});
  }
  function buildTermTab(id) {
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
  function termFrameSrc(id) {
    return '/term/' + encodeURIComponent(projectTermKey(id)) + '/';
  }
  function buildTermIframe(id) {
    const iframe = document.createElement('iframe');
    iframe.title = 'Develop terminal ' + id;
    iframe.setAttribute('allow', 'clipboard-read; clipboard-write; fullscreen');
    iframe.src = termFrameSrc(id);
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
      const r = await fetch('/api/term-sessions/' + encodeURIComponent(cfg.name));
      if (!r.ok) return;
      const data = await r.json();
      for (const s of data.sessions || []) {
        const info = termTabs.get(s.id);
        if (info) applyTermLabel(info, s.id, s.title);
      }
    } catch {}
  }
  async function createTermTab() {
    try {
      const r = await fetch('/api/term-sessions/' + encodeURIComponent(cfg.name), { method: 'POST' });
      if (!r.ok) throw new Error('POST failed: ' + r.status);
      const body = await r.json();
      addTermTab(body.id, { activate: true });
    } catch (e) { console.warn('createTermTab failed:', e); }
  }
  async function closeTermTab(id) {
    if (!termTabs.has(id)) return;
    try {
      const r = await fetch('/api/term-sessions/' + encodeURIComponent(cfg.name) + '/' + encodeURIComponent(id), { method: 'DELETE' });
      if (!r.ok) throw new Error('DELETE failed: ' + r.status);
    } catch (e) { console.warn('closeTermTab failed:', e); return; }
    const info = termTabs.get(id);
    info.tab.remove();
    info.iframe.remove();
    termTabs.delete(id);
    if (activeTermId === id) {
      activeTermId = null;
      const next = termTabs.keys().next();
      if (!next.done) setActiveTerm(next.value);
    }
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
    let data;
    try {
      const r = await fetch('/api/term-sessions/' + encodeURIComponent(cfg.name));
      if (!r.ok) throw new Error('GET failed: ' + r.status);
      data = await r.json();
    } catch (e) { console.warn('initTermTabs failed:', e); return; }
    const sessions = data.sessions || [];
    if (sessions.length === 0) { await createTermTab(); return; }
    for (const s of sessions) addTermTab(s.id, { title: s.title });
    const initialId = (data.lastActive && termTabs.has(data.lastActive))
      ? data.lastActive : sessions[0].id;
    setActiveTerm(initialId);
    if (!window.__termLabelPoll) {
      window.__termLabelPoll = setInterval(refreshTermLabels, 30000);
    }
  }

  function mount(view) {
    if (mounted[view]) return;
    if (view === 'term') {
      initTermTabs();
    } else {
      panes[view].src = sources[view];
    }
    mounted[view] = true;
  }

  // 'split' collapses to the right-half pane wherever split is switched off,
  // so no caller has to special-case the preference.
  function resolveView(view) {
    if (view === 'split') return splitEnabled() ? 'split' : rightView;
    return panes[view] ? view : 'open';
  }

  function applyView(view) {
    view = resolveView(view);
    if (view === 'split') {
      mount('term'); mount(rightView);
      document.body.classList.add('split');
      panes.term.classList.add('active');
      for (const v of RIGHT_VIEWS) panes[v].classList.toggle('active', v === rightView);
    } else {
      if (view !== 'term') rightView = view;
      document.body.classList.remove('split');
      mount(view);
      for (const v of CYCLE) panes[v].classList.toggle('active', v === view);
    }
    currentView = view;
    syncFab();
    document.title = cfg.name + ' · ' + (view === 'split' ? 'split' : labels[view].toLowerCase()) + ' · claude-hub';
  }

  // TERM → OPEN → VIEW in single-pane mode, always — the third state is what
  // makes Browse reachable on a phone, where the right half of a split never
  // existed. SPLIT rejoins the loop after VIEW wherever split is enabled.
  function nextView(cur) {
    if (splitEnabled()) {
      if (cur === 'split') return CYCLE[0];
      if (cur === CYCLE[CYCLE.length - 1]) return 'split';
    }
    const i = CYCLE.indexOf(cur);
    return CYCLE[(i + 1) % CYCLE.length];
  }

  // The FAB always advertises where the NEXT tap goes, not where you are.
  function syncFab() {
    const next = nextView(currentView);
    fabLabel.textContent = labels[next];
    fab.setAttribute('aria-label', 'Switch to ' + labels[next].toLowerCase() + ' view');
  }

  // History model: FAB never touches history. Back button always pops the
  // shell's single entry → returns to whatever loaded the shell (the hub).
  // URL ?view= is kept in sync via replaceState so a refresh preserves the
  // visible pane without growing the back stack.
  function go(view) {
    const target = resolveView(view);
    history.replaceState(null, '', '?view=' + target);
    applyView(target);
  }

  // Mobile keyboard fix — track visualViewport.height in --vvh so panes
  // (position:absolute, height:var(--vvh)) shrink when the soft keyboard
  // opens. interactive-widget=resizes-content covers Chrome/Android; this
  // shim is the iOS Safari path. Mirrors lib/keyboard-fit.js but writes a
  // CSS var instead of html/body height because panes can't inherit through
  // position:fixed on the iframe.
  (function installVvhShim() {
    const vv = window.visualViewport;
    if (!vv) return;
    const apply = () => {
      document.documentElement.style.setProperty('--vvh', vv.height + 'px');
    };
    vv.addEventListener('resize', apply);
    apply();
  })();

  const params = new URLSearchParams(location.search);
  const qv = params.get('view');
  const valid = qv === 'term' || qv === 'open' || qv === 'view' || qv === 'split';
  // A split-enabled layout always lands on split — even when the hub link
  // carried ?view=open or ?view=term — so picking either button from the
  // landing page lands the same place. Everything else honors ?view=.
  go(splitEnabled() ? 'split' : (valid && qv !== 'split' ? qv : cfg.initial));

  // Warm the panes later taps will reveal, staggered so the pane the user is
  // actually looking at isn't fighting them for the network. mount() is
  // idempotent, so cycling to one early just mounts it sooner.
  let warmDelay = 800;
  for (const v of CYCLE) {
    if (mounted[v]) continue;
    setTimeout(() => mount(v), warmDelay);
    warmDelay += 700;
  }

  function swap() {
    go(nextView(currentView));
  }

  // Rotation / resize across the split boundary. Only bites while the
  // preference is unset — once the user has chosen, the media query has no
  // say. Dropping out of split falls back to the right-half pane so nobody is
  // left staring at a half-width terminal on a phone.
  splitMq.addEventListener('change', () => {
    if (!splitEnabled() && currentView === 'split') go(rightView);
    else syncFab();
  });

  // Keyboard: Ctrl/Cmd+\` toggles. Iframe focus swallows this when the
  // terminal pane is active — keep it as a desktop niceity for the Open side.
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === '\`') {
      e.preventDefault();
      swap();
    }
  });

  // ---------- FAB drag + flick ----------
  // Pointer Events unify mouse + touch. A drag that moves more than DRAG_SLOP
  // pixels suppresses the synthetic click so swap() doesn't fire on release.
  // On pointerup we sample the last ~120ms of motion: above FLICK_THRESHOLD
  // px/ms in either axis it's a flick — snap to the nearest corner whose
  // sign matches the velocity. Position is persisted as a viewport-fractional
  // coord so resizes (rotate / install / desktop) keep it on-screen.
  const FAB_STORE_KEY = 'claude-hub:fab-pos';
  const EDGE_MARGIN = 14;
  const DRAG_SLOP = 5;
  const FLICK_THRESHOLD = 0.45; // px/ms
  const TRAIL_WINDOW_MS = 120;
  const LONG_PRESS_MS = 550;

  function clampPos(x, y) {
    const w = fab.offsetWidth, h = fab.offsetHeight;
    const maxX = Math.max(EDGE_MARGIN, window.innerWidth - w - EDGE_MARGIN);
    const maxY = Math.max(EDGE_MARGIN, window.innerHeight - h - EDGE_MARGIN);
    return {
      x: Math.max(EDGE_MARGIN, Math.min(maxX, x)),
      y: Math.max(EDGE_MARGIN, Math.min(maxY, y)),
    };
  }

  function placeFab(x, y, { animate = false, persist = true } = {}) {
    const { x: cx, y: cy } = clampPos(x, y);
    fab.style.transition = animate ? 'left 0.22s ease, top 0.22s ease, transform 0.12s' : '';
    fab.style.left = cx + 'px';
    fab.style.top = cy + 'px';
    fab.style.right = 'auto';
    fab.style.bottom = 'auto';
    if (persist) {
      try {
        localStorage.setItem(FAB_STORE_KEY, JSON.stringify({
          fx: cx / Math.max(1, window.innerWidth),
          fy: cy / Math.max(1, window.innerHeight),
        }));
      } catch {}
    }
  }

  function restoreFab() {
    try {
      const raw = localStorage.getItem(FAB_STORE_KEY);
      if (!raw) return;
      const p = JSON.parse(raw);
      if (typeof p.fx === 'number' && typeof p.fy === 'number') {
        placeFab(p.fx * window.innerWidth, p.fy * window.innerHeight, { persist: false });
      }
    } catch {}
  }
  restoreFab();
  window.addEventListener('resize', restoreFab);

  let dragState = null;
  let suppressClick = false;
  let longPressTimer = null;

  // ---------- long-press menu ----------
  // Long-press used to hard-refresh the Open pane outright. It now opens a
  // two-item menu: that same refresh (retargeted at whatever pane you are
  // looking at) plus the sticky Split toggle.
  const menu = document.getElementById('fab-menu');
  const scrim = document.getElementById('fab-scrim');
  const refreshBtn = document.getElementById('fab-refresh');
  const splitBtn = document.getElementById('fab-split');
  let menuOpen = false;

  // One-shot cache-bust so the HTTP cache and any service worker keyed on the
  // full URL both miss. Re-assigning .src is preferred over
  // contentWindow.location.reload() because it works across origins and
  // forces a navigation rather than a soft reload.
  function bust(url) {
    return url + (url.includes('?') ? '&' : '?') + '__r=' + Date.now();
  }
  // Refresh acts on what the user can see. In split that is the right half,
  // so a stray long-press never drops the terminal's ttyd connection.
  function refreshTarget() {
    return currentView === 'split' ? rightView : currentView;
  }
  function refreshCurrent() {
    const target = refreshTarget();
    if (target === 'term') {
      const info = termTabs.get(activeTermId);
      if (info) info.iframe.src = bust(termFrameSrc(activeTermId));
    } else {
      mount(target);
      panes[target].src = bust(sources[target]);
    }
    if ('vibrate' in navigator) { try { navigator.vibrate(20); } catch {} }
  }

  function syncMenu() {
    refreshBtn.querySelector('.text').textContent = 'Refresh ' + labels[refreshTarget()];
    const on = splitEnabled();
    splitBtn.setAttribute('aria-checked', on ? 'true' : 'false');
    splitBtn.querySelector('.check').textContent = on ? '✓' : '';
  }

  function openMenu() {
    syncMenu();
    scrim.hidden = false;
    menu.hidden = false;
    // Measure only once it is visible, then clamp into the viewport: the FAB
    // is draggable, so the menu has to flip below / slide sideways near an
    // edge rather than assume a bottom-right anchor.
    const r = fab.getBoundingClientRect();
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    let top = r.top - mh - 10;
    if (top < 8) top = r.bottom + 10;
    menu.style.top = Math.max(8, Math.min(window.innerHeight - mh - 8, top)) + 'px';
    menu.style.left = Math.max(8, Math.min(window.innerWidth - mw - 8, r.left + r.width / 2 - mw / 2)) + 'px';
    menuOpen = true;
    if ('vibrate' in navigator) { try { navigator.vibrate(12); } catch {} }
  }

  function closeMenu() {
    if (!menuOpen) return;
    menuOpen = false;
    menu.hidden = true;
    scrim.hidden = true;
  }

  refreshBtn.addEventListener('click', () => { closeMenu(); refreshCurrent(); });
  splitBtn.addEventListener('click', () => {
    closeMenu();
    const on = !splitEnabled();
    setSplitPref(on);
    // Turning it on enters split immediately, even on an aspect ratio that
    // would never have offered it; turning it off drops to the right half.
    go(on ? 'split' : (currentView === 'split' ? rightView : currentView));
  });
  scrim.addEventListener('pointerdown', closeMenu);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
  window.addEventListener('resize', closeMenu);

  function cancelLongPress() {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  fab.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    const r = fab.getBoundingClientRect();
    dragState = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: r.left,
      originY: r.top,
      moved: false,
      trail: [{ x: e.clientX, y: e.clientY, t: performance.now() }],
    };
    try { fab.setPointerCapture(e.pointerId); } catch {}
    fab.style.transition = '';
    cancelLongPress();
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      if (!dragState || dragState.moved) return;
      openMenu();
      suppressClick = true;
      dragState = null;
      try { fab.releasePointerCapture(e.pointerId); } catch {}
    }, LONG_PRESS_MS);
  });

  fab.addEventListener('pointermove', (e) => {
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    if (!dragState.moved && Math.hypot(dx, dy) > DRAG_SLOP) {
      dragState.moved = true;
      cancelLongPress();
    }
    if (!dragState.moved) return;
    e.preventDefault();
    placeFab(dragState.originX + dx, dragState.originY + dy, { persist: false });
    dragState.trail.push({ x: e.clientX, y: e.clientY, t: performance.now() });
    if (dragState.trail.length > 12) dragState.trail.shift();
  });

  function finishDrag(e) {
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    cancelLongPress();
    try { fab.releasePointerCapture(e.pointerId); } catch {}
    const moved = dragState.moved;
    if (!moved) { dragState = null; return; }
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);

    // Flick detection from last TRAIL_WINDOW_MS of motion.
    const now = performance.now();
    const recent = dragState.trail.filter((p) => now - p.t <= TRAIL_WINDOW_MS);
    let vx = 0, vy = 0;
    if (recent.length >= 2) {
      const a = recent[0], b = recent[recent.length - 1];
      const dt = Math.max(1, b.t - a.t);
      vx = (b.x - a.x) / dt;
      vy = (b.y - a.y) / dt;
    }
    const flick = Math.abs(vx) > FLICK_THRESHOLD || Math.abs(vy) > FLICK_THRESHOLD;
    if (flick) {
      const r = fab.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      // Use velocity sign when it's significant on an axis; otherwise fall
      // back to which half of the viewport the FAB currently sits in. This
      // makes a purely-horizontal flick still pick a vertically-sensible
      // corner (the side it was already on).
      const halfThresh = FLICK_THRESHOLD / 2;
      const goRight = vx > halfThresh ? true
        : vx < -halfThresh ? false
        : cx > window.innerWidth / 2;
      const goDown = vy > halfThresh ? true
        : vy < -halfThresh ? false
        : cy > window.innerHeight / 2;
      const w = fab.offsetWidth, h = fab.offsetHeight;
      const tx = goRight ? window.innerWidth - w - EDGE_MARGIN : EDGE_MARGIN;
      const ty = goDown ? window.innerHeight - h - EDGE_MARGIN : EDGE_MARGIN;
      placeFab(tx, ty, { animate: true });
    } else {
      // Soft drop: clamp to viewport (already clamped during move) and persist.
      const r = fab.getBoundingClientRect();
      placeFab(r.left, r.top);
    }
    dragState = null;
  }

  fab.addEventListener('pointerup', finishDrag);
  fab.addEventListener('pointercancel', finishDrag);

  fab.addEventListener('click', (e) => {
    if (suppressClick) {
      // Consume one synthesized click — drag-release and long-press both
      // arm this. Resetting here (instead of a 0ms timeout) keeps the flag
      // sticky across the gap between pointerup and click on touch, and
      // prevents a stuck-true state if no click ever follows the long-press.
      suppressClick = false;
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    // Checked after suppressClick so the synthetic click that follows the
    // long-press doesn't close the menu it just opened.
    if (menuOpen) { closeMenu(); return; }
    swap();
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
})();
</script>
</body>
</html>`;
}

module.exports = { renderShellHtml };
