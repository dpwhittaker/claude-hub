const test = require('node:test');
const assert = require('node:assert/strict');
const { patchViewportMeta, installKeyboardFit } = require('../lib/keyboard-fit');

test('patchViewportMeta rewrites existing viewport meta with interactive-widget', () => {
  const html = '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head></html>';
  const out = patchViewportMeta(html);
  assert.match(out, /interactive-widget=resizes-content/);
  assert.equal(out.match(/<meta\s+name="viewport"/g).length, 1);
});

test('patchViewportMeta injects meta when missing', () => {
  const html = '<html><head><title>x</title></head></html>';
  const out = patchViewportMeta(html);
  assert.match(out, /<meta name="viewport"[^>]*interactive-widget=resizes-content/);
});

test('patchViewportMeta handles single-quoted attr', () => {
  const html = `<head><meta name='viewport' content='width=device-width'></head>`;
  const out = patchViewportMeta(html);
  assert.match(out, /interactive-widget=resizes-content/);
});

function makeDoc({ vvHeight = 400 } = {}) {
  const listeners = {};
  const vv = {
    height: vvHeight,
    addEventListener(type, h) { listeners[type] = h; },
  };
  const dispatched = [];
  const view = {
    visualViewport: vv,
    Event: function (type) { return { type }; },
    dispatchEvent(e) { dispatched.push(e); return true; },
  };
  const htmlEl = { style: {} };
  const bodyEl = { style: {} };
  const doc = {
    defaultView: view,
    documentElement: htmlEl,
    body: bodyEl,
  };
  return { doc, view, vv, listeners, dispatched, htmlEl, bodyEl };
}

test('installKeyboardFit pins html+body height to vv.height and fires window resize', () => {
  const { doc, listeners, dispatched, htmlEl, bodyEl } = makeDoc({ vvHeight: 350 });
  installKeyboardFit(doc);
  assert.equal(htmlEl.style.height, '350px');
  assert.equal(bodyEl.style.height, '350px');
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].type, 'resize');
  assert.equal(typeof listeners.resize, 'function');
});

test('vv resize re-applies new height', () => {
  const { doc, vv, listeners, htmlEl, bodyEl } = makeDoc({ vvHeight: 600 });
  installKeyboardFit(doc);
  vv.height = 250;
  listeners.resize();
  assert.equal(htmlEl.style.height, '250px');
  assert.equal(bodyEl.style.height, '250px');
});

test('idempotent: second install is a no-op', () => {
  const { doc, listeners } = makeDoc();
  installKeyboardFit(doc);
  const first = listeners.resize;
  installKeyboardFit(doc);
  assert.equal(listeners.resize, first);
});

test('no visualViewport → silent no-op', () => {
  const doc = {
    defaultView: {},
    documentElement: { style: {} },
    body: { style: {} },
  };
  assert.doesNotThrow(() => installKeyboardFit(doc));
  assert.equal(doc.documentElement.style.height, undefined);
});
