// Long-press → select terminal text on touch screens; lifting the finger
// copies it. SPEC §V103.
//
// A finger drag scrolls (touch-wheel.js) and xterm.js has no touch selection
// of its own, so on a phone there was no way to pick text out of a terminal.
// Holding still for HOLD_MS selects the word under the finger; dragging then
// extends the selection instead of scrolling (touch-wheel stands down while
// `doc.__touchSelecting` is set; dragging past the top or bottom edge scrolls
// a line per move), and lifting the finger copies it. The touchend is a user
// gesture, so the clipboard write is allowed where writes from socket data
// may not be. A tap clears the selection.
//
// Selection goes through xterm's public API (select / getSelection), which
// works whether or not the app has mouse tracking on, and the touch is kept
// from becoming a click (touchend's default is prevented, the long-press
// context menu and any straggling mouse events are swallowed), so selecting
// never clicks into the app — nor takes back a session this tab is watching.
//
// Server inlines `installTouchSelect.toString()` like installTouchWheel;
// keep the body self-contained — no closures over module scope.
function installTouchSelect(doc) {
  if (!doc || doc.__touchSelectInstalled) return;
  doc.__touchSelectInstalled = true;
  const HOLD_MS = 450;
  const SLOP_PX = 10;
  const SWALLOW_MS = 700;
  let timer = null;
  let start = null;       // where the current touch began
  let anchor = null;      // {row, start, end}: the word the selection grew from
  let selecting = false;
  let swallowUntil = 0;

  const view = () => doc.defaultView || {};
  const term = () => view().term;
  const now = () => Date.now();

  function cellAt(t, x, y) {
    const screen = doc.querySelector && doc.querySelector('.xterm-screen');
    if (!screen || !t.cols || !t.rows) return null;
    const r = screen.getBoundingClientRect();
    const cw = r.width / t.cols;
    const ch = r.height / t.rows;
    const col = Math.max(0, Math.min(t.cols - 1, Math.floor((x - r.left) / cw)));
    const vrow = Math.floor((y - r.top) / ch);
    const edge = vrow < 0 ? -1 : vrow >= t.rows ? 1 : 0;
    const row = t.buffer.active.viewportY + Math.max(0, Math.min(t.rows - 1, vrow));
    return { col, row, edge };
  }

  // The run of non-blank cells around `cell` (wide characters count as the
  // cell they start in plus their empty trailing half).
  function wordAt(t, cell) {
    const line = t.buffer.active.getLine(cell.row);
    const blank = (col) => {
      const c = line && line.getCell(col);
      if (!c) return true;
      if (c.getWidth() === 0) return false;
      return /^\s*$/.test(c.getChars());
    };
    if (blank(cell.col)) return { row: cell.row, start: cell.col, end: cell.col };
    let s = cell.col;
    let e = cell.col;
    while (s > 0 && !blank(s - 1)) s--;
    while (e < t.cols - 1 && !blank(e + 1)) e++;
    return { row: cell.row, start: s, end: e };
  }

  function selectRange(t, a, b) {
    if (b.row < a.row || (b.row === a.row && b.col < a.col)) { const x = a; a = b; b = x; }
    t.select(a.col, a.row, (b.row - a.row) * t.cols + (b.col - a.col) + 1);
  }

  function extendTo(t, cell) {
    const before = cell.row < anchor.row || (cell.row === anchor.row && cell.col < anchor.start);
    const after = cell.row > anchor.row || (cell.row === anchor.row && cell.col > anchor.end);
    if (before) selectRange(t, cell, { col: anchor.end, row: anchor.row });
    else if (after) selectRange(t, { col: anchor.start, row: anchor.row }, cell);
    else selectRange(t, { col: anchor.start, row: anchor.row }, { col: anchor.end, row: anchor.row });
  }

  function toast(text) {
    if (!doc.body || !doc.createElement) return;
    const el = doc.createElement('div');
    el.textContent = text;
    el.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:99;'
      + 'padding:6px 12px;border-radius:14px;background:rgba(40,40,40,.92);color:#fff;'
      + 'font:13px system-ui,sans-serif;pointer-events:none';
    doc.body.appendChild(el);
    setTimeout(() => el.remove(), 1400);
  }

  function copyFallback(text) {
    const ta = doc.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    doc.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = doc.execCommand('copy'); } catch {}
    ta.remove();
    return ok;
  }

  function copy(text) {
    const done = (ok) => toast(ok ? `Copied ${text.length} character${text.length === 1 ? '' : 's'}` : 'Copy failed');
    const clip = view().navigator && view().navigator.clipboard;
    if (clip && clip.writeText) {
      clip.writeText(text).then(() => done(true), () => done(copyFallback(text)));
    } else {
      done(copyFallback(text));
    }
  }

  function cancelHold() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function begin() {
    timer = null;
    const t = term();
    if (!t || !start || typeof t.select !== 'function') return;
    const cell = cellAt(t, start.x, start.y);
    if (!cell) return;
    selecting = true;
    doc.__touchSelecting = true;
    anchor = wordAt(t, cell);
    extendTo(t, cell);
    const nav = view().navigator;
    if (nav && typeof nav.vibrate === 'function') { try { nav.vibrate(12); } catch {} }
  }

  function finish(copyIt) {
    cancelHold();
    start = null;
    if (!selecting) return false;
    selecting = false;
    doc.__touchSelecting = false;
    swallowUntil = now() + SWALLOW_MS;
    const t = term();
    const text = t && t.getSelection ? t.getSelection() : '';
    if (copyIt && text) copy(text);
    return true;
  }

  doc.addEventListener('touchstart', (e) => {
    cancelHold();
    if (!e.touches || e.touches.length !== 1) { finish(false); return; }
    const t = term();
    if (t && !selecting && t.hasSelection && t.hasSelection()) t.clearSelection();
    start = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    timer = setTimeout(begin, HOLD_MS);
  }, { passive: true, capture: true });

  doc.addEventListener('touchmove', (e) => {
    if (!e.touches || e.touches.length !== 1) return;
    const x = e.touches[0].clientX;
    const y = e.touches[0].clientY;
    if (!selecting) {
      if (start && Math.hypot(x - start.x, y - start.y) > SLOP_PX) cancelHold();
      return;
    }
    if (typeof e.preventDefault === 'function') e.preventDefault();
    const t = term();
    if (!t) return;
    let cell = cellAt(t, x, y);
    if (!cell) return;
    if (cell.edge && typeof t.scrollLines === 'function') {
      t.scrollLines(cell.edge);
      cell = cellAt(t, x, y);
    }
    extendTo(t, cell);
  }, { passive: false, capture: true });

  doc.addEventListener('touchend', (e) => {
    if (finish(true) && typeof e.preventDefault === 'function') e.preventDefault();
  }, { passive: false, capture: true });
  doc.addEventListener('touchcancel', () => { finish(false); }, { passive: true, capture: true });

  // The long-press menu, and any mouse events the browser still synthesizes
  // from the touch, would reach xterm (a right-click or click into the app).
  const swallow = (e) => {
    if (!selecting && now() > swallowUntil) return;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    if (typeof e.stopPropagation === 'function') e.stopPropagation();
  };
  for (const type of ['contextmenu', 'mousedown', 'mouseup', 'click']) {
    doc.addEventListener(type, swallow, { capture: true });
  }
}

module.exports = { installTouchSelect };
