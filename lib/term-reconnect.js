// Automatic reconnect for ttyd terminals (V63, B19).
//
// ttyd 1.7.7's client already knows how to reconnect. Two things in it stop
// that from happening on a phone, and both are visible in the bundle:
//
//   connect() {
//     ...
//     register(addEventListener(socket, 'close', this.onSocketClose));
//     register(addEventListener(socket, 'error', () => this.doReconnect = false));
//   }
//
//   onSocketClose(event) {
//     overlay('Connection Closed');
//     this.dispose();
//     if (event.code !== 1000 && doReconnect) { overlay('Reconnecting...'); refreshToken().then(connect); }
//     else { terminal.onKey(e => e.key === 'Enter' && reconnect()); overlay('Press ⏎ to Reconnect'); }
//   }
//
// 1. ANY WebSocket `error` clears `doReconnect`. A sleeping phone, a
//    wifi→cellular handoff or a tailnet blip fires `error` immediately before
//    `close`, so the drop always lands in the `else` branch — the terminal
//    parks on "Press ⏎ to Reconnect" and waits for a keystroke. The automatic
//    branch is effectively reachable only on a close with no preceding error,
//    which is not how a network goes away.
//
// 2. `dispose()` runs BEFORE the reconnect, and among the disposables is
//    `initListeners()`'s `addEventListener(window, 'resize', () => fitAddon.fit())`.
//    So no fit happens for as long as the socket is down: rotate the phone,
//    open the keyboard, or resize the pane while disconnected and xterm keeps
//    the old cols/rows. `onSocketOpen` then handshakes with
//    `{AuthToken, columns: terminal.cols, rows: terminal.rows}` — the STALE
//    pair — and nothing corrects it, because the refit listener it re-registers
//    needs a resize event that has already been and gone. The session comes
//    back the wrong shape and stays that way until something resizes again.
//
// This shim fixes both from outside the bundle, using only the socket the
// bundle asks us for:
//
//   - ttyd's `error` listener is dropped on the floor. Its sole effect is
//     `doReconnect = false`, so without it a dropped connection takes the
//     automatic branch it was always meant to take.
//   - ttyd's `close` listener is held and called by us, which is where the
//     backoff comes from: ttyd reconnects the instant it hears about the
//     close, so delaying the close IS delaying the reconnect. No timer of
//     ttyd's is patched.
//   - After the socket reopens we refit, via the `window.term.fit` hook ttyd
//     installs in `open()` and never tears down. If the viewport did move
//     while we were down, xterm's `onResize` — re-registered by the
//     `initListeners()` inside `onSocketOpen` — sends RESIZE_TERMINAL and the
//     pty is SIGWINCHed to the right shape. If it did not, `FitAddon.fit()`
//     compares its proposed dimensions against the current ones and returns
//     without touching the terminal, so an extra refit costs nothing.
//
// Deliberately NOT changed: a close with code 1000 still parks on
// "Press ⏎ to Reconnect". That is a clean server-side close — the command
// exited, the tmux session is gone — and retrying it would spawn a fresh
// attach in a loop. Only abnormal closes reconnect.
//
// Holding the close handler has a second, free benefit: ttyd's `dispose()` is
// deferred with it, so the `window resize → fit()` listener stays live for the
// whole backoff window and the terminal keeps tracking the viewport while it
// waits.
//
// Server inlines installTermReconnect.toString() into <head> with no
// DOMContentLoaded gate, AFTER installOsc52Bridge — both wrap
// window.WebSocket, and this one has to see the socket object osc52 hands
// back so ttyd and both shims are talking about the same instance. Must stay
// self-contained (V42) — no module-scope references.
function installTermReconnect(view) {
  if (!view || view.__termReconnectInstalled) return;
  view.__termReconnectInstalled = true;
  const Orig = view.WebSocket;
  if (typeof Orig !== 'function') return;

  // A socket that stayed open this long was a real working session, so the
  // drop that ended it is a fresh event and gets an immediate retry. Anything
  // shorter is flapping and pays the backoff.
  const SETTLED_MS = 5000;
  const MIN_DELAY = 1000;
  const MAX_DELAY = 15000;
  // Refit twice: once on the next task (ttyd's onSocketOpen has run by then,
  // so the onResize → RESIZE_TERMINAL binding is back and a size change can
  // actually reach the pty), once after layout has had a moment. A phone
  // reconnecting on wake may not have settled its orientation when the first
  // one lands, and a fit that changes nothing is free.
  const REFIT_DELAYS = [0, 300];

  // Consecutive failures across sockets, so the backoff survives ttyd tearing
  // one down and building the next.
  let failures = 0;

  function backoffDelay() {
    if (failures === 0) return 0;
    return Math.min(MAX_DELAY, MIN_DELAY * Math.pow(2, failures - 1));
  }

  function Wrapped(url, protocols) {
    const ws = protocols === undefined ? new Orig(url) : new Orig(url, protocols);
    const realAdd = ws.addEventListener.bind(ws);
    const realRemove = ws.removeEventListener.bind(ws);
    let openedAt = 0;
    let ttydClose = null;
    let fired = false;

    function fireClose(ev) {
      if (fired || !ttydClose) return;
      fired = true;
      const fn = ttydClose;
      ttydClose = null;
      try { fn.call(ws, ev); } catch (_) { /* ttyd's own handler threw; nothing we can do */ }
    }

    function scheduleClose(ev) {
      const lived = openedAt ? Date.now() - openedAt : 0;
      if (lived >= SETTLED_MS) failures = 0;
      const delay = backoffDelay();
      failures++;
      const doc = view.document;
      if (doc && doc.visibilityState === 'hidden') {
        // Backgrounded — a phone asleep in a pocket. Retrying there burns the
        // backoff on attempts nobody can see and that the browser throttles
        // anyway. Wait for the tab to be looked at again; that is a new
        // situation, so the count starts over and the retry is immediate.
        const onVis = function () {
          if (doc.visibilityState === 'hidden') return;
          doc.removeEventListener('visibilitychange', onVis);
          failures = 0;
          fireClose(ev);
        };
        doc.addEventListener('visibilitychange', onVis);
        return;
      }
      if (delay <= 0) fireClose(ev);
      else view.setTimeout(function () { fireClose(ev); }, delay);
    }

    // ttyd's open() does `window.term = terminal; window.term.fit = () => this.fitAddon.fit()`
    // and never tears that down, unlike the window 'resize' → fit() binding,
    // which sits on the per-connection disposables. Calling it directly is
    // shorter than a synthetic resize and immune to installKeyboardFit's
    // dedupe (V62), which drops a forwarded resize when neither dimension
    // changed — exactly the case where we still need a refit, because the
    // dimensions that went stale are xterm's, not the viewport's. The event is
    // kept as a fallback in case a future ttyd stops exposing the hook.
    function refit() {
      const term = view.term;
      if (term && typeof term.fit === 'function') {
        try { term.fit(); return; } catch (_) { /* fall through to the event */ }
      }
      try { view.dispatchEvent(new view.Event('resize')); } catch (_) { /* old browsers — skip */ }
    }

    realAdd('open', function () {
      openedAt = Date.now();
      for (let i = 0; i < REFIT_DELAYS.length; i++) view.setTimeout(refit, REFIT_DELAYS[i]);
    });
    realAdd('close', scheduleClose);

    ws.addEventListener = function (type, fn, opts) {
      // Swallowed: ttyd's only 'error' listener is `() => doReconnect = false`,
      // which is precisely what turns a dropped connection into a manual
      // "Press ⏎ to Reconnect".
      if (type === 'error') return undefined;
      // Held, not registered — we call it once the backoff has elapsed.
      if (type === 'close' && typeof fn === 'function') {
        if (!ttydClose) ttydClose = fn;
        return undefined;
      }
      return realAdd(type, fn, opts);
    };
    ws.removeEventListener = function (type, fn, opts) {
      if (type === 'error') return undefined;
      if (type === 'close' && fn === ttydClose) {
        // ttyd disposed its handler (page teardown) — drop it rather than
        // calling something it has finished with.
        ttydClose = null;
        return undefined;
      }
      return realRemove(type, fn, opts);
    };

    return ws;
  }

  Wrapped.prototype = Orig.prototype;
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
    try { Wrapped[k] = Orig[k]; } catch (_) { /* frozen ctor — labels are cosmetic */ }
  }
  view.WebSocket = Wrapped;
}

module.exports = { installTermReconnect };
