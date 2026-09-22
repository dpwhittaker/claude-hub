// Hub v2 layout tree (SPEC §V80).
//
// A profile's workspace is a tree of splits and panels:
//
//   split: { type: 'split', dir: 'row' | 'col', sizes: [f, f, …], children: [node, …] }
//   panel: { type: 'panel', id: 'p…', tabs: ['t…', …], active: 't…' | null }
//
// `sizes` are FRACTIONS of the parent that always sum to 1 — never pixels —
// so the same tree renders on a phone, a quarter-width side panel and a
// 4K monitor without a per-device layout. Every operation here is pure:
// it takes a tree and returns a new one, leaving the input untouched, so the
// client can render optimistically and the server can validate what a client
// sends back with the same code.
//
// This file is shared with the browser: server.js serves it wrapped as
// `window.HubLayout`, so it must stay dependency-free and CommonJS-only.
'use strict';

const MIN_SIZE = 0.08;
const EDGE_DIR = { left: 'row', right: 'row', top: 'col', bottom: 'col' };
const EDGE_BEFORE = { left: true, top: true, right: false, bottom: false };

function clone(x) { return JSON.parse(JSON.stringify(x)); }

function randomId(prefix) {
  let s = '';
  while (s.length < 8) s += Math.random().toString(36).slice(2);
  return prefix + s.slice(0, 8);
}

function panel(id, tabs, active) {
  const list = Array.isArray(tabs) ? tabs.slice() : [];
  return {
    type: 'panel',
    id: id || randomId('p'),
    tabs: list,
    active: active && list.includes(active) ? active : (list[0] || null),
  };
}

function createLayout(panelId, tabs) { return panel(panelId, tabs); }

// Depth-first, left-to-right — the order tab groups appear in the narrow menu.
function panels(tree, out = []) {
  if (!tree) return out;
  if (tree.type === 'panel') { out.push(tree); return out; }
  for (const c of tree.children) panels(c, out);
  return out;
}

function findPanel(tree, id) {
  return panels(tree).find((p) => p.id === id) || null;
}

function findTab(tree, tabId) {
  for (const p of panels(tree)) {
    const index = p.tabs.indexOf(tabId);
    if (index >= 0) return { panel: p, index };
  }
  return null;
}

function allTabs(tree) {
  const out = [];
  for (const p of panels(tree)) out.push(...p.tabs);
  return out;
}

function nodeAtPath(tree, path) {
  let node = tree;
  for (const i of path) {
    if (!node || node.type !== 'split') return null;
    node = node.children[i];
  }
  return node || null;
}

// Parent split + index of the panel with `id`, or null when it is the root.
function locate(tree, id, parent = null, index = -1, path = []) {
  if (tree.type === 'panel') {
    return tree.id === id ? { node: tree, parent, index, path } : null;
  }
  for (let i = 0; i < tree.children.length; i++) {
    const hit = locate(tree.children[i], id, tree, i, path.concat(i));
    if (hit) return hit;
  }
  return null;
}

function equalize(n) {
  return Array.from({ length: n }, () => 1 / n);
}

function fixSizes(sizes, n) {
  let out = Array.isArray(sizes) ? sizes.slice(0, n).map(Number) : [];
  if (out.length !== n || out.some((s) => !Number.isFinite(s) || s <= 0)) out = equalize(n);
  const sum = out.reduce((a, b) => a + b, 0);
  return out.map((s) => s / sum);
}

// Collapse what the operations leave behind: one-child splits, empty panels
// (unless it is the only panel left), same-direction nesting, bad sizes. Every
// exported mutation ends here so callers never see a degenerate tree.
function normalize(tree) {
  const root = normalizeNode(clone(tree));
  if (root) return root;
  return panel(null, []);
}

function normalizeNode(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'panel') {
    if (!Array.isArray(node.tabs)) node.tabs = [];
    node.tabs = node.tabs.filter((t) => typeof t === 'string');
    if (!node.tabs.includes(node.active)) node.active = node.tabs[0] || null;
    return node;
  }
  if (node.type !== 'split' || !Array.isArray(node.children)) return null;
  const dir = node.dir === 'col' ? 'col' : 'row';
  const sizes = fixSizes(node.sizes, node.children.length);
  const children = [];
  const outSizes = [];
  node.children.forEach((child, i) => {
    const n = normalizeNode(child);
    if (!n) return;
    if (n.type === 'panel' && n.tabs.length === 0) return; // empty panel → gone
    if (n.type === 'split' && n.dir === dir) {
      // Flatten same-direction nesting so gutters stay first-class.
      n.children.forEach((gc, j) => { children.push(gc); outSizes.push(sizes[i] * n.sizes[j]); });
      return;
    }
    children.push(n);
    outSizes.push(sizes[i]);
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return { type: 'split', dir, sizes: fixSizes(outSizes, children.length), children };
}

function addTab(tree, panelId, tabId, index) {
  const out = clone(tree);
  const p = findPanel(out, panelId) || panels(out)[0];
  if (!p) return tree;
  if (p.tabs.includes(tabId)) return normalize(out);
  const at = Number.isInteger(index) ? Math.max(0, Math.min(index, p.tabs.length)) : p.tabs.length;
  p.tabs.splice(at, 0, tabId);
  p.active = tabId;
  return normalize(out);
}

function setActive(tree, panelId, tabId) {
  const out = clone(tree);
  const p = findPanel(out, panelId);
  if (p && p.tabs.includes(tabId)) p.active = tabId;
  return out;
}

// Closing the last tab of the only panel leaves an empty panel — the client
// fills it with a home tab. Anywhere else an emptied panel disappears and its
// siblings absorb the space proportionally.
function removeTab(tree, tabId) {
  const out = clone(tree);
  const hit = findTab(out, tabId);
  if (!hit) return out;
  const { panel: p, index } = hit;
  p.tabs.splice(index, 1);
  if (p.active === tabId) p.active = p.tabs[Math.min(index, p.tabs.length - 1)] || null;
  if (p.tabs.length === 0 && panels(out).length === 1) return out;
  return normalize(out);
}

// `index` is the slot in the target's strip as it looks BEFORE the move (that
// is what the drop indicator showed the user), so a same-panel move that
// crosses its own old slot shifts left by one after the removal.
function moveTab(tree, tabId, toPanelId, index) {
  const out = clone(tree);
  const hit = findTab(out, tabId);
  const target = findPanel(out, toPanelId);
  if (!hit || !target) return tree;
  const from = hit.panel;
  from.tabs.splice(hit.index, 1);
  let at = Number.isInteger(index) ? index : target.tabs.length + (from === target ? 1 : 0);
  if (from === target && hit.index < at) at -= 1;
  at = Math.max(0, Math.min(at, target.tabs.length));
  target.tabs.splice(at, 0, tabId);
  target.active = tabId;
  if (from !== target && from.active === tabId) from.active = from.tabs[Math.min(hit.index, from.tabs.length - 1)] || null;
  if (from !== target && from.tabs.length === 0 && panels(out).length === 1) return out;
  return normalize(out);
}

// Put a new panel on one edge of an existing one. When the parent already
// runs that direction the new panel is a sibling and takes half the target's
// share; otherwise the target is wrapped in a new split. `tabId` (optional)
// is moved into the new panel — dropping a tab on an edge is this call.
function splitPanel(tree, panelId, edge, newPanelId, tabId) {
  const dir = EDGE_DIR[edge];
  if (!dir) return tree;
  let out = clone(tree);
  if (tabId) {
    const hit = findTab(out, tabId);
    if (hit) {
      // A lone tab dragged to its own panel's edge would just delete and
      // recreate the panel — treat as a no-op.
      if (hit.panel.id === panelId && hit.panel.tabs.length === 1) return tree;
      hit.panel.tabs.splice(hit.index, 1);
      if (hit.panel.active === tabId) hit.panel.active = hit.panel.tabs[Math.min(hit.index, hit.panel.tabs.length - 1)] || null;
    }
  }
  const loc = locate(out, panelId);
  if (!loc) return tree;
  const fresh = panel(newPanelId || randomId('p'), tabId ? [tabId] : [], tabId || null);
  const before = EDGE_BEFORE[edge];
  if (loc.parent && loc.parent.dir === dir) {
    const share = loc.parent.sizes[loc.index] / 2;
    loc.parent.sizes[loc.index] = share;
    const at = before ? loc.index : loc.index + 1;
    loc.parent.children.splice(at, 0, fresh);
    loc.parent.sizes.splice(at, 0, share);
  } else {
    const wrapped = {
      type: 'split', dir, sizes: [0.5, 0.5],
      children: before ? [fresh, loc.node] : [loc.node, fresh],
    };
    if (loc.parent) loc.parent.children[loc.index] = wrapped;
    else out = wrapped;
  }
  // The new panel may be empty (caller fills it) — normalize would drop it,
  // so only normalize when it holds a tab.
  return tabId ? normalize(out) : out;
}

// A panel along the whole edge of the workspace, a quarter of the axis wide.
function splitRoot(tree, edge, newPanelId, tabId) {
  const dir = EDGE_DIR[edge];
  if (!dir) return tree;
  let out = clone(tree);
  if (tabId) {
    const hit = findTab(out, tabId);
    if (hit) {
      if (panels(out).length === 1 && hit.panel.tabs.length === 1) return tree;
      hit.panel.tabs.splice(hit.index, 1);
      if (hit.panel.active === tabId) hit.panel.active = hit.panel.tabs[Math.min(hit.index, hit.panel.tabs.length - 1)] || null;
    }
  }
  const fresh = panel(newPanelId || randomId('p'), tabId ? [tabId] : [], tabId || null);
  const before = EDGE_BEFORE[edge];
  const SHARE = 0.25;
  if (out.type === 'split' && out.dir === dir) {
    out.sizes = out.sizes.map((s) => s * (1 - SHARE));
    if (before) { out.children.unshift(fresh); out.sizes.unshift(SHARE); }
    else { out.children.push(fresh); out.sizes.push(SHARE); }
  } else {
    out = {
      type: 'split', dir,
      sizes: before ? [SHARE, 1 - SHARE] : [1 - SHARE, SHARE],
      children: before ? [fresh, out] : [out, fresh],
    };
  }
  return tabId ? normalize(out) : out;
}

// Drag the gutter after child `i` of the split at `path` by `delta` (a
// fraction of the split's length). Neither neighbour shrinks below MIN_SIZE.
function resizeSplit(tree, path, i, delta) {
  const out = clone(tree);
  const split = nodeAtPath(out, path);
  if (!split || split.type !== 'split' || i < 0 || i + 1 >= split.children.length) return tree;
  const a = split.sizes[i];
  const b = split.sizes[i + 1];
  let d = Number(delta) || 0;
  d = Math.max(-(a - MIN_SIZE), Math.min(b - MIN_SIZE, d));
  if (a + d < MIN_SIZE || b - d < MIN_SIZE) return tree;
  split.sizes[i] = a + d;
  split.sizes[i + 1] = b - d;
  return out;
}

function isValidLayout(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 32) return false;
  if (node.type === 'panel') {
    return typeof node.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(node.id)
      && Array.isArray(node.tabs) && node.tabs.length <= 200
      && node.tabs.every((t) => typeof t === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(t))
      && (node.active === null || node.active === undefined || typeof node.active === 'string');
  }
  if (node.type !== 'split') return false;
  if (node.dir !== 'row' && node.dir !== 'col') return false;
  if (!Array.isArray(node.children) || node.children.length < 1 || node.children.length > 32) return false;
  if (!Array.isArray(node.sizes) || node.sizes.length !== node.children.length) return false;
  if (!node.sizes.every((s) => typeof s === 'number' && Number.isFinite(s) && s > 0)) return false;
  return node.children.every((c) => isValidLayout(c, depth + 1));
}

// Panel ids must be unique and no tab may sit in two panels.
function isConsistent(tree) {
  if (!isValidLayout(tree)) return false;
  const ps = panels(tree);
  const ids = new Set(ps.map((p) => p.id));
  if (ids.size !== ps.length) return false;
  const tabs = allTabs(tree);
  return new Set(tabs).size === tabs.length;
}

module.exports = {
  MIN_SIZE, EDGE_DIR, randomId, panel, createLayout, panels, findPanel, findTab, allTabs,
  nodeAtPath, locate, normalize, addTab, setActive, removeTab, moveTab, splitPanel,
  splitRoot, resizeSplit, isValidLayout, isConsistent,
};
