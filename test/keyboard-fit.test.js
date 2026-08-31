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

function makeDoc({ vvHeight = 400, vvWidth = 800, raf = false } = {}) {
  const listeners = {};
  const vv = {
    height: vvHeight,
    width: vvWidth,
    addEventListener(type, h) { listeners[type] = h; },
  };
  const dispatched = [];
  const frames = [];
  const view = {
    visualViewport: vv,
    Event: function (type) { return { type }; },
    dispatchEvent(e) { dispatched.push(e); return true; },
  };
  if (raf) {
    view.requestAnimationFrame = (cb) => { frames.push(cb); return frames.length; };
  }
  const htmlEl = { style: {} };
  const bodyEl = { style: {} };
  const doc = {
    defaultView: view,
    documentElement: htmlEl,
    body: bodyEl,
  };
  // Run every rAF callback queued so far, as one frame would.
  const flushFrames = () => {
    const queued = frames.splice(0, frames.length);
    for (const cb of queued) cb();
  };
  return { doc, view, vv, listeners, dispatched, htmlEl, bodyEl, frames, flushFrames };
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

// V61/B17: ttyd binds window 'resize' straight to fitAddon.fit() with no
// debounce, and a fit() that lands on new rows/cols SIGWINCHes the pty and
// repaints the whole TUI. Gboard fires vv 'resize' for things that change
// nothing here (the suggestion strip toggling while you type), so forwarding
// every one of them starves the Android input path mid-keystroke.

test('V61: a vv resize to the same size does not reach ttyd', () => {
  const { doc, vv, listeners, dispatched } = makeDoc({ vvHeight: 400, vvWidth: 800 });
  installKeyboardFit(doc);
  assert.equal(dispatched.length, 1); // the install-time apply
  listeners.resize();
  listeners.resize();
  listeners.resize();
  assert.equal(dispatched.length, 1, 'no-op vv resizes must not refit');
  vv.height = 250;
  listeners.resize();
  assert.equal(dispatched.length, 2, 'a real height change still refits');
});

test('V61: a width-only change still refits (rotation, split-screen)', () => {
  const { doc, vv, listeners, dispatched } = makeDoc({ vvHeight: 400, vvWidth: 800 });
  installKeyboardFit(doc);
  vv.width = 1200;
  listeners.resize();
  assert.equal(dispatched.length, 2);
});

test('V61: a burst of distinct heights coalesces to one resize per frame', () => {
  const { doc, vv, listeners, dispatched, flushFrames } = makeDoc({ vvHeight: 400, raf: true });
  installKeyboardFit(doc);
  flushFrames();
  assert.equal(dispatched.length, 1);
  // A keyboard open animation: many distinct heights inside one frame.
  for (const h of [380, 360, 340, 320, 300]) {
    vv.height = h;
    listeners.resize();
  }
  assert.equal(dispatched.length, 1, 'nothing dispatched until the frame runs');
  flushFrames();
  assert.equal(dispatched.length, 2, 'the whole animation costs one refit');
  // The pin always tracks the latest height, coalescing or not.
  assert.equal(doc.documentElement.style.height, '300px');
});

test('V61: coalescing re-arms after the frame runs', () => {
  const { doc, vv, listeners, dispatched, flushFrames } = makeDoc({ vvHeight: 400, raf: true });
  installKeyboardFit(doc);
  flushFrames();
  vv.height = 300;
  listeners.resize();
  flushFrames();
  vv.height = 400;
  listeners.resize();
  flushFrames();
  assert.equal(dispatched.length, 3);
});

test('V61: no requestAnimationFrame → dispatch stays synchronous', () => {
  const { doc, vv, listeners, dispatched } = makeDoc({ vvHeight: 400 });
  installKeyboardFit(doc);
  assert.equal(dispatched.length, 1);
  vv.height = 300;
  listeners.resize();
  assert.equal(dispatched.length, 2);
});
