// Mobile soft-keyboard viewport fix. Injected into ttyd /term/<key>/ HTML so
// the terminal input line stays visible when the on-screen keyboard opens.
// SPEC §V.40 sibling — same proxyRes injection path as touch-wheel.
//
// Two layers, since neither covers all platforms alone:
//  1. <meta name=viewport interactive-widget=resizes-content> — Chrome/Android
//     109+ shrinks the layout viewport when the keyboard opens. Pure HTML, no
//     JS. iOS Safari ignores it.
//  2. visualViewport JS shim — iOS Safari path. Pin html/body to vv.height on
//     every vv 'resize', then fire window 'resize' so xterm.js FitAddon
//     recomputes rows/cols. Idempotent via __kbdFitInstalled.
//
// patchViewportMeta runs at proxy time on the HTML string; installKeyboardFit
// is serialised into the page and runs at DOMContentLoaded.

function patchViewportMeta(html) {
  const metaRe = /<meta\s+name=["']viewport["'][^>]*>/i;
  const desired = '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">';
  if (metaRe.test(html)) {
    return html.replace(metaRe, desired);
  }
  if (html.includes('<head>')) {
    return html.replace('<head>', '<head>' + desired);
  }
  return desired + html;
}

function installKeyboardFit(doc) {
  if (!doc || doc.__kbdFitInstalled) return;
  doc.__kbdFitInstalled = true;
  const view = doc.defaultView;
  const vv = view && view.visualViewport;
  if (!view || !vv) return;
  let lastH = -1;
  let lastW = -1;
  let pending = 0;
  const fire = () => {
    pending = 0;
    try {
      view.dispatchEvent(new view.Event('resize'));
    } catch (_) { /* old browsers — skip */ }
  };
  const apply = () => {
    const h = vv.height;
    const w = vv.width;
    // Gboard fires vv 'resize' for things that change nothing here (the
    // suggestion strip toggling as you type). Forwarding those is not free:
    // ttyd binds window 'resize' straight to fitAddon.fit() with no debounce,
    // and a fit() that lands on new rows/cols sends RESIZE_TERMINAL, which
    // SIGWINCHes the pty and repaints the whole TUI — right while the Android
    // input path is trying to get a keystroke out (V61, B17).
    if (h === lastH && w === lastW) return;
    lastH = h;
    lastW = w;
    if (doc.documentElement) doc.documentElement.style.height = h + 'px';
    if (doc.body) doc.body.style.height = h + 'px';
    // Coalesce to one refit per frame so a keyboard open/close animation
    // costs one, not one per animated step.
    if (pending) return;
    if (typeof view.requestAnimationFrame === 'function') {
      pending = view.requestAnimationFrame(fire) || 1;
    } else {
      fire();
    }
  };
  vv.addEventListener('resize', apply);
  apply();
}

module.exports = { patchViewportMeta, installKeyboardFit };
