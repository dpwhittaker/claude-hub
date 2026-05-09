const test = require('node:test');
const assert = require('node:assert/strict');
const { installTouchWheel } = require('../lib/touch-wheel');

function makeDoc({ viewport } = {}) {
  const handlers = {};
  const dispatched = [];
  const view = {
    WheelEvent: function (type, init) {
      return { type, deltaY: init.deltaY, deltaMode: init.deltaMode, bubbles: init.bubbles };
    },
  };
  const viewportEl = viewport === undefined
    ? { dispatchEvent(e) { dispatched.push({ where: 'viewport', e }); return true; } }
    : viewport;
  const doc = {
    defaultView: view,
    addEventListener(type, h) { handlers[type] = h; },
    dispatchEvent(e) { dispatched.push({ where: 'doc', e }); return true; },
    querySelector(sel) { return sel === '.xterm-viewport' ? viewportEl : null; },
  };
  const target = { dispatchEvent(e) { dispatched.push({ where: 'target', e }); return true; } };
  return { doc, handlers, dispatched, target, viewportEl };
}

test('touchmove dispatches wheel on .xterm-viewport with deltaY = lastY - currY (V40)', () => {
  const { doc, handlers, dispatched, target } = makeDoc();
  installTouchWheel(doc);
  handlers.touchstart({ touches: [{ clientY: 100 }] });
  let prevented = false;
  handlers.touchmove({
    touches: [{ clientY: 70 }],
    target,
    preventDefault() { prevented = true; },
  });
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].where, 'viewport');
  assert.equal(dispatched[0].e.type, 'wheel');
  assert.equal(dispatched[0].e.deltaY, 30);
  assert.equal(dispatched[0].e.deltaMode, 0);
  assert.equal(dispatched[0].e.bubbles, true);
  assert.equal(prevented, true);
});

test('falls back to event target when .xterm-viewport not in DOM yet', () => {
  const { doc, handlers, dispatched, target } = makeDoc({ viewport: null });
  installTouchWheel(doc);
  handlers.touchstart({ touches: [{ clientY: 100 }] });
  handlers.touchmove({ touches: [{ clientY: 80 }], target, preventDefault() {} });
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].where, 'target');
  assert.equal(dispatched[0].e.deltaY, 20);
});

test('finger drag down (y increases) → negative deltaY (scroll up)', () => {
  const { doc, handlers, dispatched, target } = makeDoc();
  installTouchWheel(doc);
  handlers.touchstart({ touches: [{ clientY: 100 }] });
  handlers.touchmove({ touches: [{ clientY: 130 }], target, preventDefault() {} });
  assert.equal(dispatched[0].e.deltaY, -30);
});

test('multi-touch ignored (no wheel dispatched)', () => {
  const { doc, handlers, dispatched, target } = makeDoc();
  installTouchWheel(doc);
  handlers.touchstart({ touches: [{ clientY: 100 }, { clientY: 200 }] });
  handlers.touchmove({
    touches: [{ clientY: 90 }, { clientY: 190 }],
    target, preventDefault() {},
  });
  assert.equal(dispatched.length, 0);
});

test('touchend clears state — touchmove without touchstart is no-op', () => {
  const { doc, handlers, dispatched, target } = makeDoc();
  installTouchWheel(doc);
  handlers.touchstart({ touches: [{ clientY: 100 }] });
  handlers.touchend({});
  handlers.touchmove({ touches: [{ clientY: 50 }], target, preventDefault() {} });
  assert.equal(dispatched.length, 0);
});

test('idempotent install: second call on same doc is a no-op', () => {
  const { doc, handlers, dispatched, target } = makeDoc();
  installTouchWheel(doc);
  const firstStart = handlers.touchstart;
  installTouchWheel(doc);
  // Handler reference unchanged → only one listener registered.
  assert.equal(handlers.touchstart, firstStart);
  handlers.touchstart({ touches: [{ clientY: 100 }] });
  handlers.touchmove({ touches: [{ clientY: 80 }], target, preventDefault() {} });
  assert.equal(dispatched.length, 1);
});

test('zero delta drag (same y) dispatches nothing', () => {
  const { doc, handlers, dispatched, target } = makeDoc();
  installTouchWheel(doc);
  handlers.touchstart({ touches: [{ clientY: 100 }] });
  handlers.touchmove({ touches: [{ clientY: 100 }], target, preventDefault() {} });
  assert.equal(dispatched.length, 0);
});

test('missing WheelEvent constructor → no dispatch, no throw', () => {
  const { doc, handlers, target } = makeDoc();
  doc.defaultView = {}; // no WheelEvent
  installTouchWheel(doc);
  handlers.touchstart({ touches: [{ clientY: 100 }] });
  assert.doesNotThrow(() => {
    handlers.touchmove({ touches: [{ clientY: 70 }], target, preventDefault() {} });
  });
});
