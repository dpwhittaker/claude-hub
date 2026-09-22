// Hub v2 — the workspace: profile → layout tree → panels of tabs.
//
// Rendering has two layers (V86): #layout is rebuilt from the tree (tab
// strips, gutters, empty panel bodies) and #stage holds one element per
// opened tab, absolutely positioned over its panel body by place(). Tab
// contents therefore never move in the DOM, so a terminal or a dev server
// iframe survives every split, drag and resize without reloading.
//
// Sizes are fractions (lib/v2-layout.js); the window's shape only decides
// wide vs narrow (V88): narrow = width ≤ 75% of height, where panels become
// tab groups in the ☰ menu and one tab fills the screen.
(function () {
  'use strict';
  const Hub = window.Hub;
  const L = window.HubLayout;
  const { el, api, toast } = Hub;

  const state = Hub.state = { profile: null, layout: null, tabs: {}, focusedPanel: null, narrow: false, narrowPanel: null, saving: false };
  const mounted = new Map(); // tabId → { el, handle, dirty }
  const workspace = document.getElementById('workspace');
  const layoutEl = document.getElementById('layout');
  const stage = document.getElementById('stage');
  const overlay = document.getElementById('drop-overlay');
  const topTitle = document.getElementById('topbar-title');
  // Home is a singleton: it is where every other tab gets opened from, so it
  // can neither be closed nor duplicated (V89). The rest dedupe on their target.
  const DEDUPE_KEY = { home: () => 'home', file: (t) => t.path, browse: (t) => t.path, term: (t) => t.termKey, service: (t) => t.unit, url: (t) => t.url };

  // ---------- viewport ----------
  function installVvh() {
    const vv = window.visualViewport;
    const apply = () => { document.documentElement.style.setProperty('--vvh', (vv ? vv.height : window.innerHeight) + 'px'); place(); };
    if (vv) vv.addEventListener('resize', apply);
    window.addEventListener('resize', () => { apply(); updateNarrow(); });
    apply();
  }
  function isNarrow() { return window.innerWidth <= window.innerHeight * 0.75; }
  function updateNarrow() {
    const n = isNarrow();
    if (n === state.narrow) return;
    state.narrow = n;
    document.body.classList.toggle('narrow', n);
    renderAll();
  }

  // ---------- profile ----------
  async function boot() {
    checkVersion();
    state.narrow = isNarrow();
    document.body.classList.toggle('narrow', state.narrow);
    installVvh();
    // ?profile=<id> or #profile=<id> wins for this page load and is NOT
    // remembered, so a shared link or a test browser never switches the
    // device's own pick.
    const forced = new URLSearchParams(location.search).get('profile') || new URLSearchParams(location.hash.replace(/^#/, '')).get('profile');
    const saved = localStorage.getItem('hub.profile');
    let profiles = [];
    try { profiles = (await api('/api/v2/profiles')).profiles; } catch (e) { toast(e.message, true); }
    if (forced && profiles.some((p) => p.id === forced)) await loadProfile(forced, { persist: false });
    else if (forced) { toast('no profile "' + forced + '"', true); showPicker(profiles); }
    else if (saved && profiles.some((p) => p.id === saved)) await loadProfile(saved);
    else showPicker(profiles);
    // Titles/activity follow the sessions list: at load, every 20 s while
    // visible, and the moment the page comes back into view.
    const sync = () => { if (!document.hidden && state.profile && Hub.loadSessions) Hub.loadSessions().catch(() => {}); };
    sync();
    setInterval(sync, 20000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { sync(); checkVersion(); } });
    setInterval(checkVersion, 60000);
  }

  // An open page keeps running the code it loaded; when the hub's client
  // files change, reload — unless an editor holds unsaved work, in which
  // case say so and try again later (V94).
  let loadedVersion = null;
  async function checkVersion() {
    if (document.hidden) return;
    let v;
    try { v = (await api('/api/v2/version')).version; } catch { return; }
    if (loadedVersion === null) { loadedVersion = v; return; }
    if (v === loadedVersion) return;
    if ([...mounted.values()].some((m) => m.dirty)) { toast('hub updated — reload when your edits are saved'); return; }
    clearTimeout(saveTimer);
    await flush();
    location.reload();
  }

  async function loadProfile(id, { persist = true } = {}) {
    const p = await api('/api/v2/profiles/' + encodeURIComponent(id));
    for (const m of mounted.values()) { try { m.handle?.destroy?.(); } catch {} m.el.remove(); }
    mounted.clear();
    state.profile = { id: p.id, name: p.name, color: p.color, rev: p.rev, instructions: p.instructions };
    state.layout = p.layout; state.tabs = p.tabs || {};
    state.focusedPanel = L.panels(state.layout)[0]?.id || null;
    state.narrowPanel = state.focusedPanel;
    document.documentElement.style.setProperty('--profile', p.color);
    document.title = p.name + ' · claude-hub';
    if (persist) localStorage.setItem('hub.profile', p.id);
    document.getElementById('picker').hidden = true;
    ensureNotEmpty();
    renderAll();
  }

  function showPicker(profiles) {
    const host = document.getElementById('picker');
    host.innerHTML = '';
    host.hidden = false;
    const COLORS = ['#7dd3fc', '#f9a8d4', '#86efac', '#fbbf24', '#c4b5fd', '#fca5a5', '#fdba74', '#67e8f9'];
    let color = COLORS[profiles.length % COLORS.length];
    const list = el('div', { class: 'plist' }, ...profiles.map((p) => el('button', { class: 'pbtn', onclick: () => loadProfile(p.id).catch((e) => toast(e.message, true)) },
      el('span', { class: 'dot', style: { background: p.color } }), el('span', null, p.name, el('span', { class: 'sub' }, `${p.tabCount} tab${p.tabCount === 1 ? '' : 's'} · updated ${Hub.fmtAgo(Date.parse(p.updatedAt))}`)))));
    const name = el('input', { class: 'inp', type: 'text', placeholder: 'Name — e.g. David, Science, Bible study' });
    const instr = el('textarea', { class: 'inp', rows: 4, placeholder: 'Optional instructions appended to every Claude session this profile launches — who you are, what you work on, how you like answers.' });
    const err = el('div', { class: 'err' });
    const colors = el('div', { class: 'colors' }, ...COLORS.map((c) => el('button', { type: 'button', class: c === color ? 'on' : '', style: { background: c }, onclick: (e) => { color = c; for (const b of colors.children) b.classList.toggle('on', b === e.currentTarget); } })));
    const form = el('form', { hidden: profiles.length > 0, onsubmit: async (e) => {
      e.preventDefault(); err.textContent = '';
      try { const p = await api('/api/v2/profiles', { method: 'POST', body: { name: name.value, color, instructions: instr.value } }); await loadProfile(p.id); }
      catch (e2) { err.textContent = e2.message; }
    } },
      el('label', { class: 'field' }, el('span', null, 'Profile name'), name),
      el('label', { class: 'field' }, el('span', null, 'Colour'), colors),
      el('label', { class: 'field' }, el('span', null, 'Instructions for Claude'), instr),
      err,
      el('div', { class: 'buttons' }, el('button', { class: 'btn', type: 'submit' }, 'Create profile')));
    const newBtn = el('button', { class: 'pbtn new', hidden: profiles.length === 0, onclick: () => { form.hidden = false; newBtn.hidden = true; name.focus(); } }, '+ New profile');
    host.append(el('div', { class: 'wrap' },
      el('h1', null, 'Who is this?'),
      el('p', null, 'A profile keeps its own open tabs, layout and instructions for Claude. This device remembers your pick.'),
      list, newBtn, form));
    if (profiles.length === 0) setTimeout(() => name.focus(), 0);
  }

  function profileSheet() {
    Hub.sheet(async (card, close) => {
      const p = state.profile;
      const name = el('input', { class: 'inp', type: 'text', value: p.name });
      const color = el('input', { class: 'inp', type: 'color', value: p.color, style: { width: '60px', padding: '2px' } });
      const instr = el('textarea', { class: 'inp', rows: 8 }); instr.value = p.instructions || '';
      const err = el('div', { class: 'err' });
      const others = el('div', { class: 'plist' });
      try {
        const all = (await api('/api/v2/profiles')).profiles.filter((x) => x.id !== p.id);
        for (const o of all) others.append(el('button', { class: 'pbtn', onclick: () => { close(); loadProfile(o.id).catch((e) => toast(e.message, true)); } }, el('span', { class: 'dot', style: { background: o.color } }), o.name));
      } catch {}
      card.append(
        el('h2', null, 'Profile'),
        el('label', { class: 'field' }, el('span', null, 'Name'), name),
        el('label', { class: 'field' }, el('span', null, 'Colour'), color),
        el('label', { class: 'field' }, el('span', null, 'Instructions appended to every Claude session (saved to ~/.claude-hub/profiles/' + p.id + '/CLAUDE.md)'), instr),
        err,
        el('div', { class: 'buttons' },
          el('button', { class: 'btn danger', onclick: async () => {
            if (!(await Hub.confirm('Delete profile "' + p.name + '"?', 'Its tabs and layout are forgotten. Sessions and files are untouched.', 'Delete', true))) return;
            try { await api('/api/v2/profiles/' + p.id, { method: 'DELETE' }); localStorage.removeItem('hub.profile'); close(); location.reload(); }
            catch (e) { err.textContent = e.message; }
          } }, 'Delete'),
          el('span', { class: 'spacer', style: { flex: 1 } }),
          el('button', { class: 'btn muted', onclick: close }, 'Cancel'),
          el('button', { class: 'btn', onclick: async () => {
            try {
              const r = await api('/api/v2/profiles/' + p.id, { method: 'PUT', body: { name: name.value, color: color.value, instructions: instr.value } });
              state.profile = { ...state.profile, name: r.name, color: r.color, rev: r.rev, instructions: r.instructions };
              document.documentElement.style.setProperty('--profile', r.color);
              renderAll();
              close(); toast('profile saved');
            } catch (e) { err.textContent = e.message; }
          } }, 'Save')),
        el('h4', null, 'Switch to'), others,
        el('button', { class: 'pbtn new', style: { marginTop: '8px' }, onclick: async () => { close(); showPicker((await api('/api/v2/profiles')).profiles); } }, '+ New profile / pick another'),
      );
    });
  }

  // ---------- persistence ----------
  let saveTimer = null;
  function persist(delay = 400) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, delay);
  }
  async function flush() {
    if (!state.profile || state.saving) { if (state.saving) persist(600); return; }
    state.saving = true;
    const tabs = {};
    for (const [id, t] of Object.entries(state.tabs)) { const { _dirty, ...rest } = t; tabs[id] = rest; }
    try {
      const r = await api('/api/v2/profiles/' + state.profile.id, { method: 'PUT', body: { layout: state.layout, tabs, rev: state.profile.rev } });
      state.profile.rev = r.rev;
    } catch (e) {
      if (e.status === 409) { toast('layout changed on another device — reloading it'); try { await loadProfile(state.profile.id); } catch {} }
      else toast('save failed: ' + e.message, true);
    } finally { state.saving = false; }
  }

  // ---------- tabs ----------
  function newTabId() { let id; do { id = L.randomId('t'); } while (state.tabs[id]); return id; }

  // Exactly one Home tab, first in the top-left panel. Restores it if a
  // profile somehow lost it, and folds any duplicates from older saves.
  function ensureNotEmpty() {
    const live = new Set(L.allTabs(state.layout));
    for (const id of Object.keys(state.tabs)) if (!live.has(id)) delete state.tabs[id];
    const homes = L.allTabs(state.layout).filter((id) => state.tabs[id] && state.tabs[id].kind === 'home');
    for (const extra of homes.slice(1)) { state.layout = L.removeTab(state.layout, extra); delete state.tabs[extra]; }
    if (homes.length === 0) {
      const first = L.panels(state.layout)[0];
      const id = newTabId();
      state.tabs[id] = { kind: 'home', title: 'Home' };
      const wasActive = first.active;
      state.layout = L.addTab(state.layout, first.id, id, 0);
      if (wasActive) state.layout = L.setActive(state.layout, first.id, wasActive);
    }
  }

  // New tabs land in the panel with the LARGEST area (V93) — not the one
  // last clicked, which is usually the Home panel the click came from.
  function largestPanelId() {
    let best = null; let bestArea = -1;
    for (const body of layoutEl.querySelectorAll('.panel-body')) {
      const r = body.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) { bestArea = area; best = body.dataset.panel; }
    }
    return best;
  }
  function targetPanelId(prefer) {
    const ps = L.panels(state.layout);
    if (prefer && ps.some((p) => p.id === prefer)) return prefer;
    if (state.narrow && state.narrowPanel && ps.some((p) => p.id === state.narrowPanel)) return state.narrowPanel;
    const largest = largestPanelId();
    if (largest && ps.some((p) => p.id === largest)) return largest;
    if (state.focusedPanel && ps.some((p) => p.id === state.focusedPanel)) return state.focusedPanel;
    return ps[0].id;
  }

  Hub.openTab = function openTab(def, { panelId, index, edge } = {}) {
    const key = DEDUPE_KEY[def.kind];
    if (key) {
      const k = key(def);
      const existing = Object.entries(state.tabs).find(([, t]) => t.kind === def.kind && key(t) === k);
      if (existing) {
        const [id] = existing;
        if (def.kind === 'file' && def.mode && def.mode !== state.tabs[id].mode) Hub.updateTab(id, { mode: def.mode });
        focusTab(id);
        return id;
      }
    }
    const id = newTabId();
    state.tabs[id] = { ...def };
    const target = targetPanelId(panelId);
    if (edge) state.layout = L.splitPanel(L.addTab(state.layout, target, id), target, edge, L.randomId('p'), id);
    else state.layout = L.addTab(state.layout, target, id, index);
    const owner = L.findTab(state.layout, id).panel.id;
    state.focusedPanel = owner; state.narrowPanel = owner;
    renderAll(); persist();
    return id;
  };

  Hub.updateTab = function updateTab(id, patch, { silent } = {}) {
    if (!state.tabs[id]) return;
    Object.assign(state.tabs[id], patch);
    refreshTabLabels();
    persist(silent ? 2000 : 400);
  };

  Hub.closeTab = async function closeTab(id) {
    if (state.tabs[id] && state.tabs[id].kind === 'home') return;
    const m = mounted.get(id);
    if (m && m.dirty && !(await Hub.confirm('Discard unsaved changes?', Hub.basename(state.tabs[id]?.path || ''), 'Discard', true))) return;
    if (m) { try { m.handle?.destroy?.(); } catch {} m.el.remove(); mounted.delete(id); }
    state.layout = L.removeTab(state.layout, id);
    delete state.tabs[id];
    ensureNotEmpty();
    renderAll(); persist();
  };

  Hub.closeTabsWhere = function closeTabsWhere(pred) {
    for (const [id, t] of Object.entries(state.tabs)) if (pred(t)) Hub.closeTab(id);
  };

  function focusTab(id) {
    const hit = L.findTab(state.layout, id);
    if (!hit) return;
    state.layout = L.setActive(state.layout, hit.panel.id, id);
    state.focusedPanel = hit.panel.id; state.narrowPanel = hit.panel.id;
    renderAll(); persist(1500);
  }

  function tabTitle(t) {
    const def = Hub.kinds[t.kind];
    return (def && def.title ? def.title(t) : t.title) || t.kind;
  }
  // An icon name from Hub.ICONS becomes an SVG; anything else is a literal glyph.
  function tabIcon(t) {
    const ic = (Hub.kinds[t.kind] || {}).icon || '•';
    return Hub.ICONS[ic] ? Hub.icon(ic) : ic;
  }

  function mountTab(id) {
    if (mounted.has(id)) return mounted.get(id);
    const t = state.tabs[id];
    const def = Hub.kinds[t.kind];
    const node = el('div', { class: 'tabcontent', dataset: { tab: id } });
    stage.append(node);
    const rec = { el: node, handle: null, dirty: false };
    mounted.set(id, rec);
    const ctx = {
      tabId: id,
      update: (patch, o) => Hub.updateTab(id, patch, o),
      setDirty: (d) => { rec.dirty = !!d; refreshTabLabels(); },
    };
    try { rec.handle = def ? def.mount(t, node, ctx) : null; }
    catch (e) { node.append(el('div', { class: 'err' }, 'failed to open: ' + e.message)); }
    if (!def) node.append(el('div', { class: 'err' }, 'unknown tab kind ' + t.kind));
    return rec;
  }

  // ---------- render ----------
  function profileChip() {
    const p = state.profile || { name: '…' };
    return el('button', { class: 'chip', title: 'Profile: ' + p.name + ' — click to switch or edit', onclick: profileSheet },
      el('span', { class: 'dot' }), el('span', { class: 'name' }, p.name));
  }

  function renderAll() {
    if (!state.layout) return;
    layoutEl.innerHTML = '';
    if (!state.narrow) layoutEl.append(buildNode(state.layout, []));
    const bar = document.getElementById('topbar-chip');
    bar.replaceChildren(profileChip());
    refreshTopbar();
    place();
  }

  function buildNode(node, path) {
    if (node.type === 'panel') return buildPanel(node);
    const split = el('div', { class: 'split dir-' + node.dir, dataset: { path: JSON.stringify(path) } });
    node.children.forEach((child, i) => {
      if (i > 0) split.append(el('div', { class: 'gutter', dataset: { path: JSON.stringify(path), index: String(i - 1) }, onpointerdown: (e) => startResize(e, path, i - 1) }));
      split.append(el('div', { class: 'node', style: { flex: `${node.sizes[i]} 1 0` } }, buildNode(child, path.concat(i))));
    });
    return split;
  }

  function buildPanel(p) {
    const strip = el('div', { class: 'tabstrip', dataset: { panel: p.id } });
    // The profile chip lives at the start of the top-left strip (V89).
    if (L.panels(state.layout)[0].id === p.id) strip.append(el('span', { class: 'strip-chip' }, profileChip()));
    for (const id of p.tabs) strip.append(buildTabEl(p, id));
    strip.addEventListener('wheel', (e) => { if (!e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX)) { strip.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
    const body = el('div', { class: 'panel-body' + (p.tabs.length ? '' : ' empty'), dataset: { panel: p.id } });
    const panel = el('div', { class: 'panel' + (p.id === state.focusedPanel ? ' focused' : ''), dataset: { panel: p.id } }, strip, body);
    panel.addEventListener('pointerdown', () => { if (state.focusedPanel !== p.id) { state.focusedPanel = p.id; for (const x of layoutEl.querySelectorAll('.panel')) x.classList.toggle('focused', x.dataset.panel === p.id); } }, true);
    return panel;
  }

  function buildTabEl(p, id) {
    const t = state.tabs[id];
    if (!t) return el('span');
    const m = mounted.get(id);
    const closable = t.kind !== 'home';
    const tabEl = el('div', { class: 'tab' + (p.active === id ? ' active' : '') + (m && m.dirty ? ' dirty' : '') + (closable ? '' : ' pinned'), dataset: { tab: id, panel: p.id }, title: t.path || t.cwd || t.url || tabTitle(t) },
      el('span', { class: 'ico' }, tabIcon(t)),
      el('span', { class: 'label' }, tabTitle(t)),
      closable ? el('button', { class: 'close', title: 'Close', onpointerdown: (e) => e.stopPropagation(), onclick: (e) => { e.stopPropagation(); Hub.closeTab(id); } }, '×') : null);
    tabEl.addEventListener('pointerdown', (e) => onTabPointerDown(e, id, p.id));
    tabEl.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); Hub.closeTab(id); } });
    tabEl.addEventListener('contextmenu', (e) => { e.preventDefault(); if (drag) return; tabContextMenu(id, e.clientX, e.clientY); });
    return tabEl;
  }

  // Right-click / long-press on a tab. The only place a session can be ended
  // now that rows carry no buttons (V93).
  function tabContextMenu(id, x, y) {
    const t = state.tabs[id];
    if (!t) return;
    const items = [];
    if (t.kind === 'term' && t.sessionId) {
      items.push(['End session', async () => {
        if (!(await Hub.confirm('End session?', 'The tmux session and its agent are killed. A Claude conversation can be resumed later by its id.', 'End', true))) return;
        try { await api('/api/v2/sessions/' + t.sessionId, { method: 'DELETE' }); Hub.closeTabsWhere((x) => x.kind === 'term' && x.termKey === t.termKey); if (Hub.sessions) Hub.sessions.at = 0; }
        catch (e) { toast(e.message, true); }
      }]);
    }
    if (t.kind === 'term' && !t.sessionId) items.push(['v1 tab — end it from the old Develop pane', null]);
    if (t.kind !== 'home') items.push(['Close tab', () => Hub.closeTab(id)]);
    if (!items.length) return;
    const menu = el('div', { class: 'ctx-menu', style: { left: Math.min(x, innerWidth - 220) + 'px', top: Math.min(y, innerHeight - 40 * items.length) + 'px' } },
      ...items.map(([label, fn]) => el('button', { class: 'ctx-item', disabled: !fn, onclick: () => { close(); if (fn) fn(); } }, label)));
    const close = () => { menu.remove(); document.removeEventListener('pointerdown', onDown, true); };
    const onDown = (e) => { if (!menu.contains(e.target)) close(); };
    document.body.append(menu);
    setTimeout(() => document.addEventListener('pointerdown', onDown, true), 0);
  }

  function refreshTabLabels() {
    for (const tabEl of layoutEl.querySelectorAll('.tab')) {
      const t = state.tabs[tabEl.dataset.tab];
      if (!t) continue;
      tabEl.querySelector('.label').textContent = tabTitle(t);
      tabEl.classList.toggle('dirty', !!mounted.get(tabEl.dataset.tab)?.dirty);
    }
    refreshTopbar();
  }

  function refreshTopbar() {
    if (!state.narrow) { topTitle.replaceChildren(); return; }
    const p = L.findPanel(state.layout, state.narrowPanel) || L.panels(state.layout)[0];
    const t = p && state.tabs[p.active];
    topTitle.replaceChildren(...(t ? [el('span', { class: 'ico' }, tabIcon(t)), ' ', tabTitle(t)] : []));
  }

  // Position every shown tab over its panel body; hide the rest.
  function place() {
    if (!state.layout) return;
    const ws = workspace.getBoundingClientRect();
    const shown = new Map(); // tabId → rect
    if (state.narrow) {
      const p = L.findPanel(state.layout, state.narrowPanel) || L.panels(state.layout)[0];
      if (p && p.active) shown.set(p.active, { left: 0, top: 0, width: ws.width, height: ws.height });
    } else {
      for (const body of layoutEl.querySelectorAll('.panel-body')) {
        const p = L.findPanel(state.layout, body.dataset.panel);
        if (!p || !p.active) continue;
        const r = body.getBoundingClientRect();
        shown.set(p.active, { left: r.left - ws.left, top: r.top - ws.top, width: r.width, height: r.height });
      }
    }
    for (const [id, rect] of shown) {
      const m = mountTab(id);
      Object.assign(m.el.style, { left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px' });
      if (!m.el.classList.contains('shown')) { m.el.classList.add('shown'); try { m.handle?.onShow?.(); } catch {} }
    }
    for (const [id, m] of mounted) if (!shown.has(id)) m.el.classList.remove('shown');
  }
  new ResizeObserver(() => place()).observe(workspace);

  // ---------- gutters ----------
  function startResize(e, path, index) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    const gutter = e.currentTarget;
    const split = gutter.parentElement;
    const node = L.nodeAtPath(state.layout, path);
    if (!node) return;
    const horizontal = node.dir === 'row';
    const total = horizontal ? split.getBoundingClientRect().width : split.getBoundingClientRect().height;
    let last = horizontal ? e.clientX : e.clientY;
    gutter.setPointerCapture(e.pointerId);
    gutter.classList.add('active');
    document.body.classList.add('resizing');
    const move = (ev) => {
      const cur = horizontal ? ev.clientX : ev.clientY;
      const delta = (cur - last) / total;
      const next = L.resizeSplit(state.layout, path, index, delta);
      if (next === state.layout) return;
      last = cur;
      state.layout = next;
      const sizes = L.nodeAtPath(next, path).sizes;
      const kids = Array.from(split.children).filter((c) => c.classList.contains('node'));
      kids.forEach((k, i) => { k.style.flex = `${sizes[i]} 1 0`; });
      place();
    };
    const up = () => {
      gutter.releasePointerCapture(e.pointerId);
      gutter.classList.remove('active');
      document.body.classList.remove('resizing');
      gutter.removeEventListener('pointermove', move);
      gutter.removeEventListener('pointerup', up);
      gutter.removeEventListener('pointercancel', up);
      persist();
    };
    gutter.addEventListener('pointermove', move);
    gutter.addEventListener('pointerup', up);
    gutter.addEventListener('pointercancel', up);
  }

  // ---------- tab drag & drop ----------
  let drag = null;
  function onTabPointerDown(e, tabId, panelId) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const tabEl = e.currentTarget;
    const startX = e.clientX; const startY = e.clientY;
    let started = false; let pressTimer = null;
    // Capture at pointerdown, not at the first move: a quick flick's first
    // pointermove already lands outside the tab, and an uncaptured tab never
    // hears it (or the pointerup), so the drag would silently do nothing.
    try { tabEl.setPointerCapture(e.pointerId); } catch {}
    const begin = () => {
      started = true;
      beginDrag(tabId, panelId, tabEl, e.clientX, e.clientY);
    };
    if (e.pointerType === 'touch') pressTimer = setTimeout(begin, 320);
    const move = (ev) => {
      if (started) { dragMove(ev.clientX, ev.clientY); return; }
      const d = Math.hypot(ev.clientX - startX, ev.clientY - startY);
      if (e.pointerType === 'touch') { if (d > 10) { clearTimeout(pressTimer); cleanup(); } return; }
      if (d > 6) { begin(); dragMove(ev.clientX, ev.clientY); }
    };
    const up = (ev) => {
      clearTimeout(pressTimer);
      if (started) endDrag(ev.clientX, ev.clientY);
      else focusTab(tabId);
      cleanup();
    };
    const cancel = () => { clearTimeout(pressTimer); if (started) cancelDrag(); cleanup(); };
    const cleanup = () => {
      tabEl.removeEventListener('pointermove', move); tabEl.removeEventListener('pointerup', up); tabEl.removeEventListener('pointercancel', cancel);
      try { tabEl.releasePointerCapture(e.pointerId); } catch {}
    };
    tabEl.addEventListener('pointermove', move);
    tabEl.addEventListener('pointerup', up);
    tabEl.addEventListener('pointercancel', cancel);
  }

  function beginDrag(tabId, panelId, tabEl, x, y) {
    if (state.narrow) return;
    const ghost = tabEl.cloneNode(true);
    ghost.classList.add('ghost'); ghost.classList.remove('active');
    document.body.append(ghost);
    tabEl.classList.add('dragging');
    document.body.classList.add('dragging');
    drag = { tabId, panelId, tabEl, ghost, target: null, marker: null };
    dragMove(x, y);
  }

  function dragMove(x, y) {
    if (!drag) return;
    drag.ghost.style.left = (x + 10) + 'px'; drag.ghost.style.top = (y - 12) + 'px';
    const t = computeDrop(x, y);
    drag.target = t;
    showDropHint(t);
  }

  function computeDrop(x, y) {
    const ws = workspace.getBoundingClientRect();
    if (x < ws.left || x > ws.right || y < ws.top || y > ws.bottom) return null;
    // Tab strips first — precise ordering.
    for (const strip of layoutEl.querySelectorAll('.tabstrip')) {
      const r = strip.getBoundingClientRect();
      if (y < r.top || y > r.bottom || x < r.left || x > r.right) continue;
      const tabs = Array.from(strip.querySelectorAll('.tab')).filter((t) => !t.classList.contains('dragging'));
      let index = tabs.length; let markerX = r.left + 4;
      for (let i = 0; i < tabs.length; i++) {
        const tr = tabs[i].getBoundingClientRect();
        if (x < tr.left + tr.width / 2) { index = i; markerX = tr.left; break; }
        markerX = tr.right;
      }
      // index is in the strip minus the dragged tab; translate to the pre-move index the layout expects.
      const panel = L.findPanel(state.layout, strip.dataset.panel);
      let preIndex = index;
      if (panel && panel.id === drag.panelId) { const from = panel.tabs.indexOf(drag.tabId); if (from >= 0 && index >= from) preIndex = index + 1; }
      return { type: 'strip', panelId: strip.dataset.panel, index: preIndex, rect: { left: markerX - ws.left, top: r.top - ws.top, width: 2, height: r.height } };
    }
    // Workspace edges → a new panel along the whole side.
    const EDGE = 14;
    const rootEdge = x - ws.left < EDGE ? 'left' : ws.right - x < EDGE ? 'right' : y - ws.top < EDGE ? 'top' : ws.bottom - y < EDGE ? 'bottom' : null;
    if (rootEdge) {
      const q = { left: { left: 0, top: 0, width: ws.width / 4, height: ws.height }, right: { left: ws.width * 3 / 4, top: 0, width: ws.width / 4, height: ws.height },
        top: { left: 0, top: 0, width: ws.width, height: ws.height / 4 }, bottom: { left: 0, top: ws.height * 3 / 4, width: ws.width, height: ws.height / 4 } }[rootEdge];
      return { type: 'root', edge: rootEdge, rect: q };
    }
    for (const body of layoutEl.querySelectorAll('.panel-body')) {
      const r = body.getBoundingClientRect();
      if (y < r.top || y > r.bottom || x < r.left || x > r.right) continue;
      const rx = (x - r.left) / r.width; const ry = (y - r.top) / r.height;
      const d = { left: rx, right: 1 - rx, top: ry, bottom: 1 - ry };
      const edge = Object.keys(d).reduce((a, b) => (d[a] < d[b] ? a : b));
      const base = { left: r.left - ws.left, top: r.top - ws.top, width: r.width, height: r.height };
      const panelId = body.dataset.panel;
      if (d[edge] < 0.25) {
        const rect = edge === 'left' ? { ...base, width: r.width / 2 } : edge === 'right' ? { ...base, left: base.left + r.width / 2, width: r.width / 2 }
          : edge === 'top' ? { ...base, height: r.height / 2 } : { ...base, top: base.top + r.height / 2, height: r.height / 2 };
        return { type: 'panel', panelId, edge, rect };
      }
      return { type: 'panel', panelId, edge: 'center', rect: base };
    }
    return null;
  }

  function showDropHint(t) {
    if (drag.marker) { drag.marker.remove(); drag.marker = null; }
    if (!t) { overlay.hidden = true; return; }
    if (t.type === 'strip') {
      overlay.hidden = true;
      drag.marker = el('div', { class: 'drop-marker', style: { left: t.rect.left + 'px', top: t.rect.top + 'px', height: t.rect.height + 'px' } });
      workspace.append(drag.marker);
      return;
    }
    overlay.hidden = false;
    Object.assign(overlay.style, { left: t.rect.left + 'px', top: t.rect.top + 'px', width: t.rect.width + 'px', height: t.rect.height + 'px' });
  }

  function endDrag(x, y) {
    if (!drag) return;
    const t = computeDrop(x, y);
    const { tabId, panelId } = drag;
    cancelDrag();
    if (!t) return;
    let next = state.layout;
    if (t.type === 'strip') next = L.moveTab(state.layout, tabId, t.panelId, t.index);
    else if (t.type === 'root') next = L.splitRoot(state.layout, t.edge, L.randomId('p'), tabId);
    else if (t.edge === 'center') { if (t.panelId !== panelId) next = L.moveTab(state.layout, tabId, t.panelId); }
    else next = L.splitPanel(state.layout, t.panelId, t.edge, L.randomId('p'), tabId);
    if (next === state.layout) { focusTab(tabId); return; }
    state.layout = next;
    const owner = L.findTab(next, tabId)?.panel.id;
    if (owner) state.focusedPanel = owner;
    ensureNotEmpty();
    renderAll(); persist();
  }

  function cancelDrag() {
    if (!drag) return;
    drag.ghost.remove();
    drag.tabEl.classList.remove('dragging');
    if (drag.marker) drag.marker.remove();
    overlay.hidden = true;
    document.body.classList.remove('dragging');
    drag = null;
  }

  // ---------- narrow-mode menu ----------
  function tabMenu() {
    Hub.sheet((card, close) => {
      card.append(el('h2', null, 'Tabs'));
      L.panels(state.layout).forEach((p, i, arr) => {
        const g = el('div', { class: 'menu-group' });
        if (arr.length > 1) g.append(el('div', { class: 'gh' }, 'Group ' + (i + 1)));
        for (const id of p.tabs) {
          const t = state.tabs[id];
          if (!t) continue;
          g.append(Hub.append(el('div', { class: 'menu-tab' + (p.id === state.narrowPanel && p.active === id ? ' active' : ''), onclick: () => { close(); focusTab(id); } }),
            el('span', { class: 'ico' }, tabIcon(t)), el('span', { class: 'label' }, tabTitle(t)),
            t.kind === 'home' ? null : el('button', { class: 'close', onclick: (e) => { e.stopPropagation(); close(); Hub.closeTab(id); } }, '×')));
        }
        card.append(g);
      });
      card.append(el('div', { class: 'buttons' },
        el('button', { class: 'btn muted', onclick: () => { close(); profileSheet(); } }, 'Profile…'),
        el('button', { class: 'btn', onclick: () => { close(); Hub.openTab({ kind: 'home', title: 'Home' }); } }, Hub.icon('home'), ' Home')));
    });
  }

  // ---------- wiring ----------
  document.getElementById('menu-btn').addEventListener('click', tabMenu);
  window.addEventListener('beforeunload', (e) => {
    if ([...mounted.values()].some((m) => m.dirty)) { e.preventDefault(); e.returnValue = ''; }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

  boot().catch((e) => toast('failed to start: ' + e.message, true));
})();
