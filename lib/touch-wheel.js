// Touch-drag → synthetic wheel translator. Attached to the terminal iframe
// document so xterm.js (which only listens for wheel) scrolls
// under finger drag on phones/tablets. SPEC §V.40.
//
// xterm.js v5 registers its wheel handler on `.xterm-viewport`, so synthetic
// wheel events MUST be dispatched on that element (or a descendant) — a
// dispatch on document/body never bubbles down. We resolve the viewport per
// touchmove because xterm may not exist yet at iframe `load` time.
//
// QUANTIZED, not per-touchmove. When the app has mouse tracking on (Claude
// Code does) every wheel event is forwarded as ONE mouse tick regardless of
// deltaY magnitude. touchmove fires ~60Hz, so dispatching per move meant one
// swipe ≈ 60 ticks/s ≈ hundreds of lines — a wild leap into old history,
// then an overshoot past bottom. Instead we accumulate drag distance and emit
// one wheel per ONE text line of travel, because the app that consumes the
// tick (Claude Code scrolls its own transcript) moves exactly 1 line per
// tick — so content tracks the finger 1:1. Without mouse tracking (a shell)
// xterm scrolls its own viewport by deltaY px, so carrying deltaY = ±step
// keeps the total scroll distance exact regardless of the step size.
//
// Server inlines `installTouchWheel.toString()` into the /term/hub/ page
// (TOUCH_WHEEL_INJECT in server.js). Tests import directly with a stub doc/view.
// Keep body self-contained — no closures over module scope, no helper calls.
function installTouchWheel(doc) {
  if (!doc || doc.__touchWheelInstalled) return;
  doc.__touchWheelInstalled = true;
  let lastY = null;
  let acc = 0;
  doc.addEventListener('touchstart', (e) => {
    if (!e.touches || e.touches.length !== 1) { lastY = null; acc = 0; return; }
    lastY = e.touches[0].clientY;
    acc = 0;
  }, { passive: true });
  doc.addEventListener('touchmove', (e) => {
    if (!e.touches || e.touches.length !== 1 || lastY == null) return;
    // A long-press selection (touch-select.js) owns this drag.
    if (doc.__touchSelecting) {
      if (typeof e.preventDefault === 'function') e.preventDefault();
      lastY = e.touches[0].clientY;
      acc = 0;
      return;
    }
    const y = e.touches[0].clientY;
    acc += lastY - y;
    lastY = y;
    // Always suppress native page scroll/rubber-band, even below threshold.
    if (typeof e.preventDefault === 'function') e.preventDefault();
    const view = doc.defaultView;
    if (!view || typeof view.WheelEvent !== 'function') return;
    const viewport = doc.querySelector && doc.querySelector('.xterm-viewport');
    const target = viewport || e.target || doc;
    // One tick per text line of finger travel (ttyd exposes window.term;
    // fall back to a typical phone line height when it isn't up yet).
    const rows = (view.term && view.term.rows) || 24;
    const lineHeight = (viewport && viewport.clientHeight)
      ? viewport.clientHeight / rows : 16;
    const step = Math.max(8, lineHeight);
    while (Math.abs(acc) >= step) {
      const dir = acc > 0 ? 1 : -1;
      target.dispatchEvent(new view.WheelEvent('wheel', {
        deltaY: dir * step, deltaMode: 0, bubbles: true, cancelable: true,
      }));
      acc -= dir * step;
    }
  }, { passive: false });
  const clear = () => { lastY = null; acc = 0; };
  doc.addEventListener('touchend', clear, { passive: true });
  doc.addEventListener('touchcancel', clear, { passive: true });
}

module.exports = { installTouchWheel };
