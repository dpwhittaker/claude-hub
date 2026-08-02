// Touch-drag → synthetic wheel translator. Attached to the develop-pane
// terminal iframe document so xterm.js (which only listens for wheel) scrolls
// under finger drag on phones/tablets. SPEC §V.40.
//
// xterm.js v5 registers its wheel handler on `.xterm-viewport`, so synthetic
// wheel events MUST be dispatched on that element (or a descendant) — a
// dispatch on document/body never bubbles down. We resolve the viewport per
// touchmove because xterm may not exist yet at iframe `load` time.
//
// QUANTIZED, not per-touchmove. The terminal runs inside tmux (mouse on), so
// the outer xterm sits in the alternate buffer with zero local scrollback —
// every wheel event is forwarded to tmux as ONE mouse tick regardless of
// deltaY magnitude, and tmux copy-mode scrolls 5 lines per tick. touchmove
// fires ~60Hz, so dispatching per move meant one swipe ≈ 60 ticks/s ≈ 300
// lines — a wild leap into old history, then an overshoot past bottom that
// exits copy-mode. Instead we accumulate drag distance and emit one wheel per
// 2.5-text-lines of travel — half of tmux's 5-lines-per-tick, so content moves
// ~2× the finger. (1:1 — a 5-line step — was correct but felt too slow to
// swipe back through a long transcript on a phone.) Non-tmux terminals scroll
// the viewport by deltaY pixels, so carrying deltaY = ±step keeps their total
// scroll distance exact regardless of the step size.
//
// Server inlines `installTouchWheel.toString()` into the client template (see
// renderViewShell in server.js). Tests import directly with a stub doc/view.
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
    const y = e.touches[0].clientY;
    acc += lastY - y;
    lastY = y;
    // Always suppress native page scroll/rubber-band, even below threshold.
    if (typeof e.preventDefault === 'function') e.preventDefault();
    const view = doc.defaultView;
    if (!view || typeof view.WheelEvent !== 'function') return;
    const viewport = doc.querySelector && doc.querySelector('.xterm-viewport');
    const target = viewport || e.target || doc;
    // One tick per 2.5 text lines of finger travel (ttyd exposes window.term;
    // fall back to a typical phone line height when it isn't up yet).
    const rows = (view.term && view.term.rows) || 24;
    const lineHeight = (viewport && viewport.clientHeight)
      ? viewport.clientHeight / rows : 16;
    const step = Math.max(10, 2.5 * lineHeight);
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
