const test = require('node:test');
const assert = require('node:assert/strict');
const { TERM_AGENTS, openAgentMenu } = require('../lib/term-agents');
const { renderViewShell } = require('../lib/view-shell');
const { renderShellHtml } = require('../lib/pwa-shell');

// The develop-pane "+" no longer creates a tab outright — it opens a menu
// asking which agent the tab should run (V68). Both shells inline the menu
// factory via .toString(), so it is unit-tested here against a fake DOM and
// pinned in the rendered HTML of each shell.

// Minimal stand-in for the pieces of `document` the menu touches.
function makeDom() {
  const docListeners = [];
  const body = { children: [], appendChild(el) { this.children.push(el); el.__parent = this; } };
  const doc = {
    body,
    documentElement: { clientWidth: 1000 },
    createElement(tag) { return makeEl(tag, doc); },
    querySelector(sel) {
      const want = sel.replace('.', '');
      return body.children.find((el) => el.className === want) || null;
    },
    addEventListener(type, h, capture) { docListeners.push({ type, h, capture }); },
    removeEventListener(type, h) {
      const i = docListeners.findIndex((l) => l.type === type && l.h === h);
      if (i >= 0) docListeners.splice(i, 1);
    },
  };
  function fireDoc(type, event) {
    for (const l of [...docListeners]) if (l.type === type) l.h(event);
  }
  return { doc, body, docListeners, fireDoc };
}

function makeEl(tag, doc) {
  const el = {
    tagName: tag,
    ownerDocument: doc,
    className: '',
    style: {},
    dataset: {},
    attrs: {},
    children: [],
    listeners: {},
    focused: 0,
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    appendChild(child) { this.children.push(child); child.__parent = this; },
    addEventListener(type, h) { (this.listeners[type] ||= []).push(h); },
    focus() { this.focused++; },
    remove() {
      const p = this.__parent;
      if (p) p.children.splice(p.children.indexOf(this), 1);
      this.__parent = null;
    },
    contains(other) {
      if (other === this) return true;
      return this.children.some((c) => c.contains && c.contains(other));
    },
    querySelector(sel) {
      const want = sel.replace('.', '');
      return this.children.find((c) => c.className === want) || null;
    },
    getBoundingClientRect() { return { left: 120, bottom: 34 }; },
    click() { for (const h of this.listeners.click || []) h({ stopPropagation() {} }); },
  };
  return el;
}

function openMenu(agents = TERM_AGENTS) {
  const { doc, body, docListeners, fireDoc } = makeDom();
  const anchor = makeEl('button', doc);
  anchor.className = 'term-add';
  const picked = [];
  const menu = openAgentMenu(anchor, agents, (id) => picked.push(id));
  return { doc, body, anchor, menu, picked, docListeners, fireDoc, agents };
}

test('V68: the menu offers one item per agent, in order, id on the element', () => {
  const { menu, agents } = openMenu();
  assert.equal(menu.children.length, agents.length);
  assert.deepEqual(menu.children.map((c) => c.dataset.agent), agents.map((a) => a.id));
  assert.deepEqual(menu.children.map((c) => c.textContent), agents.map((a) => a.label));
  assert.equal(menu.getAttribute('role'), 'menu');
});

test('V68: picking an item reports its agent and closes the menu', () => {
  const { body, menu, picked, docListeners } = openMenu();
  menu.children[1].click();
  assert.deepEqual(picked, ['codex']);
  assert.equal(body.children.length, 0, 'menu removed');
  assert.equal(docListeners.length, 0, 'document listeners released');
});

test('V68: a second click on "+" closes the open menu instead of stacking one', () => {
  const { doc, body, anchor, picked, docListeners } = openMenu();
  assert.equal(body.children.length, 1);
  const again = openAgentMenu(anchor, TERM_AGENTS, () => picked.push('x'));
  assert.equal(again, null);
  assert.equal(body.children.length, 0);
  assert.equal(docListeners.length, 0);
  assert.equal(doc.querySelector('.term-agent-menu'), null);
});

test('V68: an outside click dismisses without picking; a click inside does not', () => {
  const { body, menu, picked, fireDoc } = openMenu();
  fireDoc('click', { target: menu.children[0] });
  assert.equal(body.children.length, 1, 'a click inside the menu keeps it open');
  fireDoc('click', { target: makeEl('div', null) });
  assert.deepEqual(picked, []);
  assert.equal(body.children.length, 0);
});

test('V68: the opening click cannot dismiss the menu it just opened', () => {
  // The document listener is registered while that same click is still being
  // dispatched. Even if it were delivered, target === anchor must be ignored.
  const { body, anchor, fireDoc } = openMenu();
  fireDoc('click', { target: anchor });
  assert.equal(body.children.length, 1);
});

test('V68: Escape closes and returns focus to "+"; other keys are ignored', () => {
  const { body, anchor, fireDoc } = openMenu();
  fireDoc('keydown', { key: 'a' });
  assert.equal(body.children.length, 1);
  fireDoc('keydown', { key: 'Escape' });
  assert.equal(body.children.length, 0);
  assert.equal(anchor.focused, 1);
  assert.equal(anchor.getAttribute('aria-expanded'), 'false');
});

test('V68: the menu is positioned off the "+" button itself, not the strip', () => {
  // The strip scrolls horizontally; anchoring to it would drift (position:fixed
  // + the button's own rect is what keeps the menu under the button).
  const { menu } = openMenu();
  assert.equal(menu.style.left, '120px');
  assert.equal(menu.style.top, '34px');
});

// V42: both shells inline the factory, so the browser only ever gets the
// function body — a module-scope reference would be a ReferenceError there.
test('V68: openAgentMenu survives a .toString() round-trip (no closure refs)', () => {
  const reconstructed = new Function(openAgentMenu.toString() + '\nreturn openAgentMenu;')();
  const { doc } = makeDom();
  const anchor = makeEl('button', doc);
  const picked = [];
  const menu = reconstructed(anchor, TERM_AGENTS, (id) => picked.push(id));
  menu.children[0].click();
  assert.deepEqual(picked, ['claude']);
});

test('V68: the Browse shell inlines the picker and its agent list', () => {
  const html = renderViewShell('demo', {});
  assert.match(html, /function openAgentMenu/, 'factory inlined');
  assert.match(html, /const TERM_AGENTS = \[\{"id":"claude"/, 'agent list inlined as a literal');
  assert.match(html, /openAgentMenu\(TERM_ADD_BTN, TERM_AGENTS/, '"+" opens the menu');
  assert.match(html, /body: JSON\.stringify\(\{ agent: agent \|\| 'claude' \}\)/, 'POST carries the agent');
});

test('V68: the PWA shell inlines the picker and its agent list', () => {
  const html = renderShellHtml('demo', '/demo/', '/term/demo__s1/', 'term');
  assert.match(html, /function openAgentMenu/, 'factory inlined');
  assert.match(html, /const TERM_AGENTS = \[\{"id":"claude"/, 'agent list inlined as a literal');
  assert.match(html, /openAgentMenu\(TERM_ADD_BTN, TERM_AGENTS/, '"+" opens the menu');
});
