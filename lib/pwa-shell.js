/**
 * The per-project PWA shell — GET /p/<project>/.
 *
 * A single-project wrapper around the same three views the landing card
 * offers (Open / Browse / Develop), built for a phone or tablet: installable
 * via the web manifest, a FAB that cycles views, a split layout on landscape,
 * and keyboard-fit handling so the terminal stays visible when the on-screen
 * keyboard opens.
 *
 * Pure: everything it needs arrives as arguments.
 */

const { escapeHtml } = require('./escape-html');

function renderShellHtml(name, openUrl, termUrl, initialView) {
  // browseUrl = the /view/<name>/ shell. In split-capable layouts the right
  // pane shows this instead of the live openUrl — the user can still get
  // the live preview via the eye-icon inside browse, and gains the
  // tree/tabs/git-status view at the same time.
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
  /* Split mode (landscape tablet/desktop): both panes visible side-by-side.
     Develop on the left, Open on the right. A 1px divider helps the eye. */
  body.split #pane-term { width: 50%; left: 0; border-right: 1px solid var(--fab-edge); box-sizing: border-box; }
  body.split #pane-open { width: 50%; left: 50%; }
  body.split .pane { visibility: visible; pointer-events: auto; }
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
  /* Edge swipe hint dot — barely visible, just signals the FAB exists when
     viewing terminal full-screen on a phone. */
  @media (display-mode: standalone) {
    #fab { width: 56px; height: 56px; }
  }
</style>
</head>
<body>
<iframe id="pane-open" class="pane" title="Open" allow="clipboard-read; clipboard-write; fullscreen"></iframe>
<div id="pane-term" class="pane" role="region" aria-label="Develop terminals">
  <div class="term-tabs" id="term-tabs"></div>
  <div class="term-frames" id="term-frames"></div>
</div>
<button id="fab" type="button" aria-label="Switch view"><span class="label">TERM</span><span class="hint">SWAP</span></button>
<script id="shell-data" type="application/json">${data}</script>
<script>
(function () {
  const cfg = JSON.parse(document.getElementById('shell-data').textContent);
  const panes = {
    open: document.getElementById('pane-open'),
    term: document.getElementById('pane-term'),
  };
  // Landscape tablet/desktop → 3-state cycle (split → term → open → split).
  // Anything narrower or portrait → 2-state binary (open ↔ term). matchMedia
  // re-evaluates on rotate/resize so the cycle adapts live.
  const splitMq = window.matchMedia('(min-width: 900px) and (orientation: landscape)');
  function isSplitCapable() { return splitMq.matches; }

  // The right pane shows the Browse view in split-capable layouts (so the
  // user sees tree + tabs + git-status alongside the terminal) and the live
  // openUrl on phones. Stored mutably so a rotation event can swap the src
  // of an already-mounted pane.
  function openSrcForLayout() {
    return isSplitCapable() ? cfg.browseUrl : cfg.openUrl;
  }
  const sources = { open: openSrcForLayout(), term: cfg.termUrl };
  const mounted = { open: false, term: false };
  const labels = { open: 'OPEN', term: 'TERM', split: 'SPLIT' };
  const fab = document.getElementById('fab');
  const fabLabel = fab.querySelector('.label');

  let currentView = null;

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
  function buildTermIframe(id) {
    const iframe = document.createElement('iframe');
    iframe.title = 'Develop terminal ' + id;
    iframe.setAttribute('allow', 'clipboard-read; clipboard-write; fullscreen');
    iframe.src = '/term/' + encodeURIComponent(projectTermKey(id)) + '/';
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

  function applyView(view) {
    if (view === 'split' && !isSplitCapable()) view = 'open';
    if (view === 'split') {
      mount('open'); mount('term');
      document.body.classList.add('split');
      panes.open.classList.add('active');
      panes.term.classList.add('active');
    } else {
      const other = view === 'open' ? 'term' : 'open';
      document.body.classList.remove('split');
      mount(view);
      panes[view].classList.add('active');
      panes[other].classList.remove('active');
      if (!mounted[other]) setTimeout(() => mount(other), 800);
    }
    const nextLabel = labels[nextView(view)];
    fabLabel.textContent = nextLabel;
    document.title = cfg.name + ' · ' + (view === 'split' ? 'split' : labels[view].toLowerCase()) + ' · claude-hub';
    currentView = view;
  }

  function nextView(cur) {
    if (isSplitCapable()) {
      // split → term → open → split
      if (cur === 'split') return 'term';
      if (cur === 'term') return 'open';
      return 'split';
    }
    return cur === 'open' ? 'term' : 'open';
  }

  // History model: FAB never touches history. Back button always pops the
  // shell's single entry → returns to whatever loaded the shell (the hub).
  // URL ?view= is kept in sync via replaceState so a refresh preserves the
  // visible pane without growing the back stack.
  function otherOf(v) { return v === 'open' ? 'term' : 'open'; }

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
  const valid = qv === 'term' || qv === 'open' || qv === 'split';
  // Landscape tablet/desktop always lands on split — even when the hub link
  // carried ?view=open or ?view=term — so picking either button from the
  // landing page lands the same place. ?view=split is also honored.
  // Narrow/portrait honors ?view= as before.
  let initial;
  if (isSplitCapable()) {
    initial = 'split';
  } else {
    initial = valid && qv !== 'split' ? qv : cfg.initial;
  }
  history.replaceState(null, '', '?view=' + initial);
  applyView(initial);

  function swap() {
    const next = nextView(currentView);
    history.replaceState(null, '', '?view=' + next);
    applyView(next);
  }

  // Rotation / window resize across the split-capable boundary: if we drop
  // out of split-capable layout while in 'split', fall back to 'open' so the
  // user isn't left with a half-pane on a phone. If we re-enter split-capable
  // and the URL says split, restore it. Otherwise leave the current view.
  splitMq.addEventListener('change', () => {
    // Right-pane URL flips between live Open (phone) and Browse (landscape).
    // If the pane is already mounted with the wrong src, re-assign so it
    // navigates to the new target without forcing a reload of the term pane.
    const nextOpenSrc = openSrcForLayout();
    if (sources.open !== nextOpenSrc) {
      sources.open = nextOpenSrc;
      if (mounted.open) panes.open.src = nextOpenSrc;
    }
    if (!isSplitCapable() && currentView === 'split') {
      const fallback = 'open';
      history.replaceState(null, '', '?view=' + fallback);
      applyView(fallback);
    } else {
      fabLabel.textContent = labels[nextView(currentView)];
    }
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

  // Long-press → hard-refresh the Open iframe. Append a one-shot cache-bust
  // query so HTTP cache + any service worker that keys on the full URL both
  // miss. Mount first if lazy. Re-assigning .src is preferred over
  // contentWindow.location.reload() because it works across origins and
  // forces a navigation rather than a soft reload.
  function bustedOpenUrl() {
    const sep = sources.open.includes('?') ? '&' : '?';
    return sources.open + sep + '__r=' + Date.now();
  }
  function reloadOpenPane() {
    mount('open');
    panes.open.src = bustedOpenUrl();
    if ('vibrate' in navigator) { try { navigator.vibrate(20); } catch {} }
  }

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
      reloadOpenPane();
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
