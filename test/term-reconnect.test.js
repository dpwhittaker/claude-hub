const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { installTermReconnect } = require('../lib/term-reconnect');

// Stand-in for the ttyd page. `view` carries only what the shim touches:
// WebSocket, Event, setTimeout, dispatchEvent and a document with a
// visibilityState. Timers are queued rather than run so a test can assert the
// delay the shim asked for, which IS the reconnect backoff.
function makePage({ visibility = 'visible' } = {}) {
  const timers = [];
  const dispatched = [];
  const docListeners = {};
  const sockets = [];

  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.native = {};
      sockets.push(this);
    }
    addEventListener(type, fn) { (this.native[type] = this.native[type] || []).push(fn); }
    removeEventListener(type, fn) {
      const a = this.native[type];
      if (!a) return;
      const i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    }
    emit(type, ev) { for (const fn of (this.native[type] || []).slice()) fn(ev); }
  }

  const doc = {
    visibilityState: visibility,
    addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const a = docListeners[type];
      if (!a) return;
      const i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    },
  };

  const view = {
    WebSocket: FakeSocket,
    Event: function Event(type) { this.type = type; },
    document: doc,
    setTimeout(fn, delay) { timers.push({ fn, delay }); return timers.length; },
    dispatchEvent(ev) { dispatched.push(ev.type); },
  };

  // Run every queued timer whose delay is <= `upTo` (default: all).
  function runTimers(upTo = Infinity) {
    const due = timers.filter((t) => t.delay <= upTo);
    for (const t of due) timers.splice(timers.indexOf(t), 1);
    for (const t of due) t.fn();
  }
  function becomeVisible() {
    doc.visibilityState = 'visible';
    for (const fn of (docListeners.visibilitychange || []).slice()) fn();
  }
  return { view, sockets, timers, dispatched, docListeners, runTimers, becomeVisible };
}

// Stand-in for ttyd's connect(): registers exactly the four listeners the
// bundle registers, in the bundle's order, and models `doReconnect` the way
// onSocketClose reads it.
function connectLikeTtyd(view) {
  const state = { doReconnect: true, closes: [], opened: 0 };
  const ws = new view.WebSocket('ws://x/ws');
  ws.addEventListener('open', () => { state.opened++; });
  ws.addEventListener('message', () => {});
  ws.addEventListener('close', (ev) => { state.closes.push(ev); });
  ws.addEventListener('error', () => { state.doReconnect = false; });
  return { ws, state };
}

test('V63: ttyd\'s error listener never lands — doReconnect survives the drop', () => {
  const page = makePage();
  installTermReconnect(page.view);
  const { ws, state } = connectLikeTtyd(page.view);
  // An error immediately before close is exactly what a sleeping phone or a
  // wifi handoff produces; upstream that is what forces the manual branch.
  ws.emit('error', {});
  assert.equal(state.doReconnect, true, 'doReconnect must not be cleared');
  assert.equal((ws.native.error || []).length, 0, 'nothing registered for error');
});

test('V63: a settled session that drops reconnects with no delay', () => {
  const page = makePage();
  installTermReconnect(page.view);
  const { ws, state } = connectLikeTtyd(page.view);
  ws.emit('open', {});
  // Age the socket past SETTLED_MS so it counts as a real working session.
  const realNow = Date.now;
  Date.now = () => realNow() + 6000;
  try {
    ws.emit('close', { code: 1006 });
  } finally {
    Date.now = realNow;
  }
  assert.equal(state.closes.length, 1, 'ttyd hears about the close immediately');
  assert.equal(page.timers.filter((t) => t.delay >= 1000).length, 0, 'no backoff timer');
});

test('V63: consecutive failures back off, and a good session resets it', () => {
  const page = makePage();
  installTermReconnect(page.view);
  const delays = [];
  // Each attempt fails without ever opening — server down.
  for (let i = 0; i < 6; i++) {
    const { ws, state } = connectLikeTtyd(page.view);
    ws.emit('close', { code: 1006 });
    if (state.closes.length) {
      delays.push(0);
    } else {
      const t = page.timers.pop();
      delays.push(t.delay);
      t.fn();
    }
  }
  assert.deepEqual(delays, [0, 1000, 2000, 4000, 8000, 15000], 'doubling, capped at 15s');

  // A session that stays up past SETTLED_MS clears the streak, so its own drop
  // retries immediately instead of inheriting the 15s cap the run just hit.
  const good = connectLikeTtyd(page.view);
  good.ws.emit('open', {});
  const realNow = Date.now;
  Date.now = () => realNow() + 6000;
  try {
    good.ws.emit('close', { code: 1006 });
  } finally {
    Date.now = realNow;
  }
  assert.equal(good.state.closes.length, 1, 'settled session reconnects at once');

  // ...and the streak restarts from there: if THAT retry also fails, the
  // backoff begins again at the minimum rather than resuming at the cap.
  const after = connectLikeTtyd(page.view);
  after.ws.emit('close', { code: 1006 });
  assert.equal(after.state.closes.length, 0, 'held');
  assert.equal(page.timers.pop().delay, 1000, 'restarts at MIN_DELAY, not MAX');
});

test('V63: reopening refits through ttyd\'s window.term.fit hook', () => {
  const page = makePage();
  const fits = [];
  page.view.term = { fit() { fits.push(1); } };
  installTermReconnect(page.view);
  const { ws } = connectLikeTtyd(page.view);
  ws.emit('open', {});
  // Deferred, not synchronous: ttyd's onSocketOpen runs after ours in the same
  // dispatch, and only it re-registers the onResize -> RESIZE_TERMINAL binding
  // that carries a size change to the pty.
  assert.deepEqual(fits, [], 'nothing refit during the open event itself');
  page.runTimers();
  assert.equal(fits.length, 2, 'one refit per delay');
  assert.deepEqual(page.dispatched, [], 'the direct hook, not a synthetic resize');
});

test('V63: without the hook it falls back to a real window resize', () => {
  // Older/other ttyd builds may not expose window.term.fit; the event still
  // reaches the window 'resize' -> fitAddon.fit() binding that onSocketOpen
  // re-registers.
  const page = makePage();
  installTermReconnect(page.view);
  const { ws } = connectLikeTtyd(page.view);
  ws.emit('open', {});
  page.runTimers();
  assert.deepEqual(page.dispatched, ['resize', 'resize']);
});

test('V63: a throwing fit hook still falls back rather than losing the refit', () => {
  const page = makePage();
  page.view.term = { fit() { throw new Error('detached'); } };
  installTermReconnect(page.view);
  const { ws } = connectLikeTtyd(page.view);
  ws.emit('open', {});
  page.runTimers();
  assert.deepEqual(page.dispatched, ['resize', 'resize']);
});

test('V63: a backgrounded page waits for visibility instead of burning retries', () => {
  const page = makePage({ visibility: 'hidden' });
  installTermReconnect(page.view);
  const { ws, state } = connectLikeTtyd(page.view);
  ws.emit('open', {});
  const timersAfterOpen = page.timers.length;   // the refit nudges
  ws.emit('close', { code: 1006 });
  assert.equal(state.closes.length, 0, 'held while hidden');
  assert.equal(page.timers.length, timersAfterOpen, 'no retry timer armed while hidden');
  page.becomeVisible();
  assert.equal(state.closes.length, 1, 'delivered the moment the tab is looked at');
  assert.equal((page.docListeners.visibilitychange || []).length, 0, 'listener cleaned up');
});

test('V63: a clean code-1000 close is still handed to ttyd untouched', () => {
  // The command exited / tmux went away. ttyd parks on "Press ⏎ to Reconnect"
  // for that, and it must keep doing so — retrying would loop a fresh attach.
  const page = makePage();
  installTermReconnect(page.view);
  const { ws, state } = connectLikeTtyd(page.view);
  ws.emit('open', {});
  ws.emit('close', { code: 1000 });
  const ev = state.closes[0];
  assert.ok(ev, 'ttyd still receives the close');
  assert.equal(ev.code, 1000, 'code passed through unchanged — ttyd picks the branch');
});

test('V63: teardown drops the held close handler rather than calling it later', () => {
  const page = makePage();
  installTermReconnect(page.view);
  const ws = new page.view.WebSocket('ws://x/ws');
  const seen = [];
  const onClose = (ev) => seen.push(ev);
  ws.addEventListener('close', onClose);
  ws.removeEventListener('close', onClose);   // ttyd's dispose() on unmount
  ws.emit('close', { code: 1006 });
  assert.deepEqual(seen, [], 'a disposed handler is never invoked');
});

test('V63: the shim returns the socket it was handed, so wrappers compose', () => {
  // installOsc52Bridge wraps window.WebSocket first and returns the real
  // socket; this one must hand back that same object or ttyd, osc52 and this
  // shim end up talking about different instances.
  const page = makePage();
  const Inner = page.view.WebSocket;
  const handedBack = [];
  page.view.WebSocket = function Outer(url) {
    const s = new Inner(url);
    handedBack.push(s);
    return s;
  };
  installTermReconnect(page.view);
  const ws = new page.view.WebSocket('ws://x/ws');
  assert.equal(ws, handedBack[0], 'same object all the way through');
});

test('V63: idempotent — a second install does not double-wrap', () => {
  const page = makePage();
  installTermReconnect(page.view);
  const once = page.view.WebSocket;
  installTermReconnect(page.view);
  assert.equal(page.view.WebSocket, once);
});

test('V63: no WebSocket in the view is a no-op, not a throw', () => {
  const view = {};
  assert.doesNotThrow(() => installTermReconnect(view));
  assert.doesNotThrow(() => installTermReconnect(null));
});

// V42: helpers inlined into the page via .toString() must be self-contained.
test('V42: installTermReconnect survives the round-trip through new Function', () => {
  const src = installTermReconnect.toString();
  const fn = new Function('return (' + src + ')')();
  const page = makePage();
  fn(page.view);
  const { ws, state } = connectLikeTtyd(page.view);
  ws.emit('error', {});
  assert.equal(state.doReconnect, true, 'the inlined copy behaves identically');
});

// Ordering constraint: both shims wrap window.WebSocket, and this one has to
// wrap osc52's wrapper (not the other way round) so it sees the socket ttyd
// will actually use.
test('V63: the injected blob puts OSC52 ahead of the reconnect shim', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const m = /const injectBlob = ([\s\S]*?);/.exec(src);
  assert.ok(m, 'injectBlob assignment found');
  const blob = m[1];
  assert.ok(blob.includes('TERM_RECONNECT_INJECT'), 'reconnect shim is injected');
  assert.ok(
    blob.indexOf('OSC52_INJECT') < blob.indexOf('TERM_RECONNECT_INJECT'),
    'OSC52_INJECT must come first',
  );
});
