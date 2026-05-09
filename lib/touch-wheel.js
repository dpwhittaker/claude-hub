// Touch-drag → synthetic wheel translator. Attached to the develop-pane
// terminal iframe document so xterm.js (which only listens for wheel) scrolls
// under finger drag on phones/tablets. SPEC §V.40.
//
// xterm.js v5 registers its wheel handler on `.xterm-viewport`, so synthetic
// wheel events MUST be dispatched on that element (or a descendant) — a
// dispatch on document/body never bubbles down. We resolve the viewport per
// touchmove because xterm may not exist yet at iframe `load` time.
//
// Server inlines `installTouchWheel.toString()` into the client template (see
// renderViewShell in server.js). Tests import directly with a stub doc/view.
// Keep body self-contained — no closures over module scope, no helper calls.
function installTouchWheel(doc) {
  if (!doc || doc.__touchWheelInstalled) return;
  doc.__touchWheelInstalled = true;
  let lastY = null;
  doc.addEventListener('touchstart', (e) => {
    if (!e.touches || e.touches.length !== 1) { lastY = null; return; }
    lastY = e.touches[0].clientY;
  }, { passive: true });
  doc.addEventListener('touchmove', (e) => {
    if (!e.touches || e.touches.length !== 1 || lastY == null) return;
    const y = e.touches[0].clientY;
    const dy = lastY - y;
    lastY = y;
    if (dy === 0) return;
    const view = doc.defaultView;
    if (!view || typeof view.WheelEvent !== 'function') return;
    const viewport = doc.querySelector && doc.querySelector('.xterm-viewport');
    const target = viewport || e.target || doc;
    const wheel = new view.WheelEvent('wheel', {
      deltaY: dy, deltaMode: 0, bubbles: true, cancelable: true,
    });
    target.dispatchEvent(wheel);
    if (typeof e.preventDefault === 'function') e.preventDefault();
  }, { passive: false });
  const clear = () => { lastY = null; };
  doc.addEventListener('touchend', clear, { passive: true });
  doc.addEventListener('touchcancel', clear, { passive: true });
}

module.exports = { installTouchWheel };
