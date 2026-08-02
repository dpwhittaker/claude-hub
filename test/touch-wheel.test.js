const test = require('node:test');
const assert = require('node:assert/strict');
const { installTouchWheel } = require('../lib/touch-wheel');

// Stub viewport has no clientHeight and stub view has no term, so the shim
// falls back to lineHeight 16 → step = max(8, 16) = 16px per tick.
const FALLBACK_STEP = 16;

function makeDoc({ viewport, rows, viewportHeight } = {}) {
  const handlers = {};
  const dispatched = [];
  const view = {
    WheelEvent: function (type, init) {
      return { type, deltaY: init.deltaY, deltaMode: init.deltaMode, bubbles: init.bubbles };
    },
  };
  if (rows) view.term = { rows };
  const viewportEl = viewport === undefined
    ? {
      clientHeight: viewportHeight,
      dispatchEvent(e) { dispatched.push({ where: 'viewport', e }); return true; },
    }
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

test('drag of one step dispatches one wheel on .xterm-viewport, deltaY = +step (V40)', () => {
  const { doc, handlers, dispatched, target } = makeDoc();
  installTouchWheel(doc);
  handlers.touchstart({ touches: [{ clientY: 200 }] });
  let prevented = false;
  handlers.touchmove({
    touches: [{ clientY: 200 - FALLBACK_STEP }],
    target,
    preventDefault() { prevented = true; },
  });
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].where, 'viewport');
  assert.equal(dispatched[0].e.type, 'wheel');
  assert.equal(dispatched[0].e.deltaY, FALLBACK_STEP);
  assert.equal(dispatched[0].e.deltaMode, 0);
  assert.equal(dispatched[0].e.bubbles, true);
  assert.equal(prevented, true);
});

test('sub-step moves accumulate; tick fires only when total crosses step (V40)', () => {
  const { doc, handlers, dispatched, target } = makeDoc();
  installTouchWheel(doc);
  handlers.touchstart({ touches: [{ clientY: 300 }] });
  handlers.touchmove({ touches: [{ clientY: 294 }], target, preventDefault() {} }); // acc 6
  handlers.touchmove({ touches: [{ clientY: 288 }], target, preventDefault() {} }); // acc 12
  assert.equal(dispatched.length, 0);
  handlers.touchmove({ touches: [{ clientY: 282 }], target, preventDefault() {} }); // acc 18 → tick, rem 2
  assert.equal(dispatched.length, 1);
  handlers.touchmove({ touches: [{ clientY: 276 }], target, preventDefault() {} }); // acc 8
  assert.equal(dispatched.length, 1);
});

test('fast flick spanning multiple steps emits multiple ticks in one move', () => {
  const { doc, handlers, dispatched, target } = makeDoc();
  installTouchWheel(doc);
  handlers.touchstart({ touches: [{ clientY: 500 }] });
  handlers.touchmove({
    touches: [{ clientY: 500 - (2 * FALLBACK_STEP + 5) }],
    target, preventDefault() {},
  });
  assert.equal(dispatched.length, 2);
  assert.equal(dispatched[0].e.deltaY, FALLBACK_STEP);
  assert.equal(dispatched[1].e.deltaY, FALLBACK_STEP);
});

test('preventDefault fires even below threshold (suppress rubber-band)', () => {
  const { doc, handlers, dispatched, target } = makeDoc();
  installTouchWheel(doc);
  handlers.touchstart({ touches: [{ clientY: 100 }] });
  let prevented = false;
  handlers.touchmove({
    touches: [{ clientY: 95 }],
    target,
    preventDefault() { prevented = true; },
  });
  assert.equal(dispatched.length, 0);
  assert.equal(prevented, true);
});

test('step derives from viewport height / term.rows (one text line per tick)', () => {
  // clientHeight 480 / rows 24 = 20px lines → step 20.
  const { doc, handlers, dispatched, target } = makeDoc({ rows: 24, viewportHeight: 480 });
  installTouchWheel(doc);
  handlers.touchstart({ touches: [{ clientY: 100 }] });
  handlers.touchmove({ touches: [{ clientY: 80 }], target, preventDefault() {} });
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].e.deltaY, 20);
});

test('falls back to event target when .xterm-viewport not in DOM yet', () => {
  const { doc, handlers, dispatched, target } = makeDoc({ viewport: null });
  installTouchWheel(doc);
  handlers.touchstart({ touches: [{ clientY: 200 }] });
  handlers.touchmove({
    touches: [{ clientY: 200 - FALLBACK_STEP }],
    target, preventDefault() {},
  });
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].where, 'target');
  assert.equal(dispatched[0].e.deltaY, FALLBACK_STEP);
});

test('finger drag down (y increases) → negative deltaY (scroll up)', () => {
  const { doc, handlers, dispatched, target } = makeDoc();
  installTouchWheel(doc);
  handlers.touchstart({ touches: [{ clientY: 100 }] });
  handlers.touchmove({
    touches: [{ clientY: 100 + FALLBACK_STEP }],
    target, preventDefault() {},
  });
  assert.equal(dispatched[0].e.deltaY, -FALLBACK_STEP);
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
  handlers.touchstart({ touches: [{ clientY: 300 }] });
  handlers.touchend({});
  handlers.touchmove({
    touches: [{ clientY: 300 - 2 * FALLBACK_STEP }],
    target, preventDefault() {},
  });
  assert.equal(dispatched.length, 0);
});

test('touchend resets accumulator — residual drag does not leak into next gesture', () => {
  const { doc, handlers, dispatched, target } = makeDoc();
  installTouchWheel(doc);
  handlers.touchstart({ touches: [{ clientY: 200 }] });
  handlers.touchmove({ touches: [{ clientY: 190 }], target, preventDefault() {} }); // acc 10, no tick
  handlers.touchend({});
  handlers.touchstart({ touches: [{ clientY: 200 }] });
  handlers.touchmove({ touches: [{ clientY: 190 }], target, preventDefault() {} }); // fresh acc 10
  assert.equal(dispatched.length, 0);
});

test('idempotent install: second call on same doc is a no-op', () => {
  const { doc, handlers, dispatched, target } = makeDoc();
  installTouchWheel(doc);
  const firstStart = handlers.touchstart;
  installTouchWheel(doc);
  // Handler reference unchanged → only one listener registered.
  assert.equal(handlers.touchstart, firstStart);
  handlers.touchstart({ touches: [{ clientY: 200 }] });
  handlers.touchmove({
    touches: [{ clientY: 200 - FALLBACK_STEP }],
    target, preventDefault() {},
  });
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
  handlers.touchstart({ touches: [{ clientY: 200 }] });
  assert.doesNotThrow(() => {
    handlers.touchmove({
      touches: [{ clientY: 200 - FALLBACK_STEP }],
      target, preventDefault() {},
    });
  });
});
