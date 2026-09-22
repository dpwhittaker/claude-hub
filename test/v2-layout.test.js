const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../lib/v2-layout');

function sum(a) { return a.reduce((x, y) => x + y, 0); }

test('V80: createLayout makes a single panel whose first tab is active', () => {
  const t = L.createLayout('p1', ['a', 'b']);
  assert.equal(t.type, 'panel');
  assert.deepEqual(t.tabs, ['a', 'b']);
  assert.equal(t.active, 'a');
  assert.ok(L.isConsistent(t));
});

test('V80: operations never mutate their input', () => {
  const t = L.createLayout('p1', ['a', 'b']);
  const frozen = JSON.stringify(t);
  L.addTab(t, 'p1', 'c');
  L.removeTab(t, 'a');
  L.splitPanel(t, 'p1', 'right', 'p2', 'b');
  L.splitRoot(t, 'bottom', 'p3');
  L.setActive(t, 'p1', 'b');
  L.moveTab(t, 'b', 'p1', 0);
  assert.equal(JSON.stringify(t), frozen);
});

test('V80: splitPanel on an edge wraps the panel and halves the space; sizes stay fractions summing to 1', () => {
  let t = L.createLayout('p1', ['a', 'b']);
  t = L.splitPanel(t, 'p1', 'right', 'p2', 'b');
  assert.equal(t.type, 'split');
  assert.equal(t.dir, 'row');
  assert.deepEqual(t.sizes, [0.5, 0.5]);
  assert.deepEqual(t.children.map((c) => c.id), ['p1', 'p2']);
  assert.deepEqual(L.findPanel(t, 'p1').tabs, ['a']);
  assert.deepEqual(L.findPanel(t, 'p2').tabs, ['b']);
  assert.equal(L.findPanel(t, 'p2').active, 'b');
  // Same direction again → sibling, target's share halves, no nesting.
  t = L.addTab(t, 'p2', 'c');
  t = L.splitPanel(t, 'p2', 'right', 'p3', 'c');
  assert.equal(t.children.length, 3);
  assert.deepEqual(t.children.map((c) => c.id), ['p1', 'p2', 'p3']);
  assert.deepEqual(t.sizes, [0.5, 0.25, 0.25]);
  assert.ok(Math.abs(sum(t.sizes) - 1) < 1e-9);
  // Cross direction → nested split of the other dir.
  t = L.addTab(t, 'p3', 'd');
  t = L.splitPanel(t, 'p3', 'top', 'p4', 'd');
  const nested = t.children[2];
  assert.equal(nested.type, 'split');
  assert.equal(nested.dir, 'col');
  assert.deepEqual(nested.children.map((c) => c.id), ['p4', 'p3']);
  assert.ok(L.isConsistent(t));
});

test('V80: dragging the lone tab of a panel to its own edge is a no-op', () => {
  let t = L.createLayout('p1', ['a', 'b']);
  t = L.splitPanel(t, 'p1', 'right', 'p2', 'b');
  const before = JSON.stringify(t);
  assert.equal(JSON.stringify(L.splitPanel(t, 'p2', 'left', 'p9', 'b')), before);
});

test('V80: removing the last tab of a non-root panel collapses the split back', () => {
  let t = L.createLayout('p1', ['a', 'b']);
  t = L.splitPanel(t, 'p1', 'bottom', 'p2', 'b');
  t = L.removeTab(t, 'b');
  assert.equal(t.type, 'panel');
  assert.equal(t.id, 'p1');
  // Only panel left: emptying it keeps an empty panel for the client to refill.
  t = L.removeTab(t, 'a');
  assert.equal(t.type, 'panel');
  assert.deepEqual(t.tabs, []);
  assert.equal(t.active, null);
});

test('V80: removing a middle sibling hands its share to the survivors proportionally', () => {
  let t = L.createLayout('p1', ['a', 'b', 'c']);
  t = L.splitPanel(t, 'p1', 'right', 'p2', 'b');
  t = L.splitPanel(t, 'p2', 'right', 'p3', 'c'); // [0.5, 0.25, 0.25]
  t = L.removeTab(t, 'b');
  assert.deepEqual(t.children.map((c) => c.id), ['p1', 'p3']);
  assert.ok(Math.abs(t.sizes[0] - 2 / 3) < 1e-9);
  assert.ok(Math.abs(t.sizes[1] - 1 / 3) < 1e-9);
});

test('V80: moveTab honours the pre-move index, including a same-panel move past its own slot', () => {
  let t = L.createLayout('p1', ['a', 'b', 'c']);
  t = L.moveTab(t, 'a', 'p1', 3); // to the end
  assert.deepEqual(t.tabs, ['b', 'c', 'a']);
  t = L.moveTab(t, 'a', 'p1', 0);
  assert.deepEqual(t.tabs, ['a', 'b', 'c']);
  t = L.moveTab(t, 'c', 'p1', 1);
  assert.deepEqual(t.tabs, ['a', 'c', 'b']);
  t = L.splitPanel(t, 'p1', 'right', 'p2', 'b');
  t = L.moveTab(t, 'a', 'p2', 0);
  assert.deepEqual(L.findPanel(t, 'p2').tabs, ['a', 'b']);
  assert.equal(L.findPanel(t, 'p2').active, 'a');
  assert.deepEqual(L.findPanel(t, 'p1').tabs, ['c']);
  assert.equal(L.findPanel(t, 'p1').active, 'c');
  // Moving the last tab out of a panel removes that panel.
  t = L.moveTab(t, 'c', 'p2', 9);
  assert.equal(t.type, 'panel');
  assert.deepEqual(t.tabs, ['a', 'b', 'c']);
});

test('V80: splitRoot spans the whole workspace edge at a quarter share', () => {
  let t = L.createLayout('p1', ['a', 'b', 'c']);
  t = L.splitPanel(t, 'p1', 'right', 'p2', 'b'); // row [p1, p2]
  t = L.splitRoot(t, 'bottom', 'p3', 'c');
  assert.equal(t.dir, 'col');
  assert.deepEqual(t.sizes, [0.75, 0.25]);
  assert.equal(t.children[1].id, 'p3');
  assert.equal(t.children[0].type, 'split');
  // Same-dir root: joins as a sibling and rescales the rest.
  t = L.addTab(t, 'p3', 'd');
  t = L.splitRoot(t, 'top', 'p4', 'd');
  assert.equal(t.dir, 'col');
  assert.deepEqual(t.children.map((c) => c.id || c.type), ['p4', 'split', 'p3']);
  assert.ok(Math.abs(sum(t.sizes) - 1) < 1e-9);
  assert.ok(Math.abs(t.sizes[0] - 0.25) < 1e-9);
});

test('V80: resizeSplit moves one gutter, keeps the sum at 1 and respects MIN_SIZE', () => {
  let t = L.createLayout('p1', ['a', 'b']);
  t = L.splitPanel(t, 'p1', 'right', 'p2', 'b');
  let r = L.resizeSplit(t, [], 0, 0.2);
  assert.deepEqual(r.sizes.map((s) => Math.round(s * 100) / 100), [0.7, 0.3]);
  r = L.resizeSplit(r, [], 0, 0.5); // would push p2 below MIN_SIZE → clamped
  assert.ok(r.sizes[1] >= L.MIN_SIZE - 1e-9);
  assert.ok(Math.abs(sum(r.sizes) - 1) < 1e-9);
  assert.equal(L.resizeSplit(t, [], 5, 0.1), t, 'bad gutter index is a no-op');
  assert.equal(L.resizeSplit(t, [0], 0, 0.1), t, 'path to a panel is a no-op');
});

test('V80: normalize flattens same-direction nesting and drops empty panels', () => {
  const t = {
    type: 'split', dir: 'row', sizes: [0.5, 0.5],
    children: [
      { type: 'panel', id: 'p1', tabs: ['a'], active: 'zzz' },
      { type: 'split', dir: 'row', sizes: [0.5, 0.5], children: [
        { type: 'panel', id: 'p2', tabs: [], active: null },
        { type: 'panel', id: 'p3', tabs: ['b'], active: 'b' },
      ] },
    ],
  };
  const n = L.normalize(t);
  assert.equal(n.type, 'split');
  assert.deepEqual(n.children.map((c) => c.id), ['p1', 'p3']);
  assert.equal(n.children[0].active, 'a', 'active outside the tab list resets to first tab');
  assert.ok(Math.abs(sum(n.sizes) - 1) < 1e-9);
  // p3 inherits the whole nested share once its empty sibling is gone.
  assert.deepEqual(n.sizes, [0.5, 0.5]);
});

test('V80: isValidLayout / isConsistent reject junk a client could PUT', () => {
  assert.equal(L.isValidLayout(null), false);
  assert.equal(L.isValidLayout({ type: 'panel', id: 'p1', tabs: 'nope' }), false);
  assert.equal(L.isValidLayout({ type: 'split', dir: 'diag', sizes: [1], children: [L.panel('p1', [])] }), false);
  assert.equal(L.isValidLayout({ type: 'split', dir: 'row', sizes: [1, 1], children: [L.panel('p1', [])] }), false);
  assert.equal(L.isValidLayout({ type: 'panel', id: '../x', tabs: [] }), false);
  assert.equal(L.isConsistent({ type: 'split', dir: 'row', sizes: [1, 1], children: [L.panel('p1', ['a']), L.panel('p1', ['b'])] }), false, 'duplicate panel id');
  assert.equal(L.isConsistent({ type: 'split', dir: 'row', sizes: [1, 1], children: [L.panel('p1', ['a']), L.panel('p2', ['a'])] }), false, 'tab in two panels');
  assert.equal(L.isConsistent({ type: 'split', dir: 'row', sizes: [1, 1], children: [L.panel('p1', ['a']), L.panel('p2', ['b'])] }), true);
});

test('V80: panels() order is depth-first left-to-right (the narrow-menu group order)', () => {
  let t = L.createLayout('p1', ['a', 'b', 'c', 'd']);
  t = L.splitPanel(t, 'p1', 'right', 'p2', 'b');
  t = L.splitPanel(t, 'p1', 'bottom', 'p3', 'c');
  t = L.splitPanel(t, 'p2', 'top', 'p4', 'd');
  assert.deepEqual(L.panels(t).map((p) => p.id), ['p1', 'p3', 'p4', 'p2']);
  assert.deepEqual(L.allTabs(t), ['a', 'c', 'd', 'b']);
  assert.deepEqual(L.locate(t, 'p3').path, [0, 1]);
  assert.equal(L.nodeAtPath(t, [0, 1]).id, 'p3');
});
