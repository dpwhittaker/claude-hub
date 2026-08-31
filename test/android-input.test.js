const test = require('node:test');
const assert = require('node:assert/strict');
const { installAndroidInput } = require('../lib/android-input');

const DEL = '\u007f';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36';
const DESKTOP_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140 Safari/537.36';

// Minimal stand-in for the ttyd page: a `document` that records capture-phase
// listeners, a `window.term` exposing the three public xterm APIs the shim
// uses, and its hidden textarea.
function makePage({ ua = ANDROID_UA, withTerm = true } = {}) {
  const handlers = {};
  const sent = [];
  const scrolls = [];
  const textarea = { value: '' };
  const view = {
    navigator: { userAgent: ua },
    term: withTerm ? {
      textarea,
      input(data) { sent.push(data); },
      scrollToBottom() { scrolls.push(true); },
    } : undefined,
  };
  const doc = {
    defaultView: view,
    addEventListener(type, h, capture) {
      handlers[type] = { h, capture };
    },
  };
  // Fire `type` as if it targeted the textarea, reporting whether the shim
  // stopped it from reaching xterm.
  function fire(type, init = {}) {
    const entry = handlers[type];
    if (!entry) return { stopped: false, delivered: false };
    let stopped = false;
    entry.h({
      target: textarea,
      stopImmediatePropagation() { stopped = true; },
      ...init,
    });
    return { stopped, delivered: true };
  }
  // The Gboard sequence for one character: keydown 229, the textarea updates,
  // then `input`.
  function type(ch) {
    fire('keydown', { keyCode: 229 });
    textarea.value += ch;
    fire('input', {});
  }
  return { doc, view, handlers, sent, scrolls, textarea, fire, type };
}

test('V61: non-Android UA is a complete no-op — xterm keeps its own path', () => {
  const { doc, handlers } = makePage({ ua: DESKTOP_UA });
  installAndroidInput(doc);
  assert.deepEqual(Object.keys(handlers), []);
  assert.equal(doc.__androidInputInstalled, undefined);
});

test('V61: listeners are all capture-phase on document (must beat xterm)', () => {
  const { doc, handlers } = makePage();
  installAndroidInput(doc);
  for (const type of ['keydown', 'keypress', 'input', 'compositionstart', 'compositionupdate', 'compositionend', 'focusin']) {
    assert.equal(handlers[type].capture, true, `${type} must be capture-phase`);
  }
});

test('V61: idempotent — second install does not double-bind', () => {
  const { doc, handlers } = makePage();
  installAndroidInput(doc);
  const first = handlers.input.h;
  installAndroidInput(doc);
  assert.equal(handlers.input.h, first);
});

test('V61: keyCode 229 keydown is suppressed and scrolls to bottom', () => {
  const { doc, fire, scrolls } = makePage();
  installAndroidInput(doc);
  const { stopped } = fire('keydown', { keyCode: 229 });
  assert.equal(stopped, true);
  assert.equal(scrolls.length, 1);
});

test('V61: a real keydown is left alone — Enter/arrows/hardware keys keep xterm', () => {
  const { doc, fire, scrolls } = makePage();
  installAndroidInput(doc);
  assert.equal(fire('keydown', { keyCode: 13 }).stopped, false);
  assert.equal(fire('keydown', { keyCode: 8 }).stopped, false);
  assert.equal(fire('keydown', { keyCode: 37 }).stopped, false);
  assert.equal(scrolls.length, 0);
});

test('V61: typing sends one char per input event, in order, synchronously', () => {
  const { doc, sent, type } = makePage();
  installAndroidInput(doc);
  for (const ch of 'hello') type(ch);
  assert.deepEqual(sent, ['h', 'e', 'l', 'l', 'o']);
});

test('V61: a burst of keydowns before any input still sends every character', () => {
  // The upstream failure: xterm captures textarea.value at each keydown and
  // diffs it in a macrotask, so a starved timer queue or an interleaved
  // composition loses characters. The shim reads the textarea in the handler
  // that observed the change, so batching cannot lose anything.
  const { doc, sent, textarea, fire } = makePage();
  installAndroidInput(doc);
  fire('keydown', { keyCode: 229 });
  fire('keydown', { keyCode: 229 });
  fire('keydown', { keyCode: 229 });
  textarea.value = 'abc';
  fire('input', {});
  assert.deepEqual(sent, ['abc']);
});

test('V61: composition does not swallow characters typed before it started', () => {
  // The exact upstream drop: keydown -> compositionstart -> the deferred diff
  // sees _isComposing and discards the character for good.
  const { doc, sent, textarea, fire, type } = makePage();
  installAndroidInput(doc);
  type('a');
  fire('compositionstart', {});
  textarea.value += 'b';
  fire('input', {});
  fire('compositionend', {});
  assert.deepEqual(sent, ['a', 'b']);
});

test('V61: composition events never reach xterm', () => {
  const { doc, fire } = makePage();
  installAndroidInput(doc);
  assert.equal(fire('compositionstart', {}).stopped, true);
  assert.equal(fire('compositionupdate', {}).stopped, true);
  assert.equal(fire('compositionend', {}).stopped, true);
});

test('V61: a shrinking textarea sends one DEL per removed char', () => {
  const { doc, sent, textarea, fire, type } = makePage();
  installAndroidInput(doc);
  for (const ch of 'abc') type(ch);
  sent.length = 0;
  textarea.value = 'a';
  fire('input', {});
  assert.deepEqual(sent, [DEL + DEL]);
});

test('V61: autocorrect replacement becomes backspaces + the correction', () => {
  const { doc, sent, textarea, fire, type } = makePage();
  installAndroidInput(doc);
  for (const ch of 'teh') type(ch);
  sent.length = 0;
  textarea.value = 'the ';   // Gboard rewrites the composed word on space
  fire('input', {});
  assert.deepEqual(sent, [DEL + DEL + 'he ']);
});

test('V61: a newline in the textarea is sent as CR', () => {
  const { doc, sent, textarea, fire } = makePage();
  installAndroidInput(doc);
  fire('focusin', {});
  textarea.value = 'x\n';
  fire('input', {});
  assert.deepEqual(sent, ['x\r']);
});

test('V61: focusin seeds the mirror, so a keydown-less input is not swallowed', () => {
  // Voice input and suggestion-strip taps produce `input` with no keydown. If
  // that were first sight of the textarea the mirror would adopt the new text
  // and send nothing.
  const { doc, sent, textarea, fire } = makePage();
  installAndroidInput(doc);
  fire('focusin', {});
  textarea.value = 'dictated';
  fire('input', {});
  assert.deepEqual(sent, ['dictated']);
});

test('V61: a printable key is OURS — xterm never sees keydown or keypress', () => {
  // stopImmediatePropagation stops propagation, not the default action: Chrome
  // still fires keypress, and xterm's own keypress listener would send the
  // character on top of our diff. Both must be suppressed (B18).
  const { doc, sent, textarea, fire } = makePage();
  installAndroidInput(doc);
  assert.equal(fire('keydown', { keyCode: 65, key: 'a' }).stopped, true);
  assert.equal(fire('keypress', { keyCode: 97, key: 'a' }).stopped, true);
  textarea.value = 'a';
  fire('input', {});
  assert.deepEqual(sent, ['a'], 'exactly one sender');
});

test('V61: space is a printable key, so the autocorrect that rides it is ours (B18)', () => {
  // The doubling report: Gboard commits the corrected word together with the
  // space. If xterm owned space it would send " " BEFORE the input event, so
  // the correction would be diffed against the wrong text and land out of
  // order on top of the word already sent.
  const { doc, sent, textarea, fire, type } = makePage();
  installAndroidInput(doc);
  for (const ch of 'teh') type(ch);
  assert.deepEqual(sent, ['t', 'e', 'h']);
  sent.length = 0;
  assert.equal(fire('keydown', { keyCode: 32, key: ' ' }).stopped, true);
  assert.equal(fire('keypress', { keyCode: 32, key: ' ' }).stopped, true);
  textarea.value = 'the ';
  fire('input', {});
  assert.deepEqual(sent, [DEL + DEL + 'he '], 'one correction, no duplicate word');
});

test('V61: a control key is XTERM\'s — keydown and keypress pass through', () => {
  const { doc, fire } = makePage();
  installAndroidInput(doc);
  for (const key of ['Enter', 'Backspace', 'ArrowLeft', 'Tab', 'Escape']) {
    assert.equal(fire('keydown', { key }).stopped, false, key);
    assert.equal(fire('keypress', { key }).stopped, false, key);
  }
});

test('V61: a modifier combo is XTERM\'s (Ctrl-C must stay a control sequence)', () => {
  const { doc, fire } = makePage();
  installAndroidInput(doc);
  assert.equal(fire('keydown', { key: 'c', ctrlKey: true }).stopped, false);
  assert.equal(fire('keydown', { key: 'a', metaKey: true }).stopped, false);
  assert.equal(fire('keydown', { key: 'b', altKey: true }).stopped, false);
});

test('V61: the textarea change from an xterm-owned key is adopted, not re-sent', () => {
  // Backspace: xterm sends 0x7f itself and the textarea also shrinks. Diffing
  // that would send a second DEL.
  const { doc, sent, textarea, fire, type } = makePage();
  installAndroidInput(doc);
  for (const ch of 'ab') type(ch);
  sent.length = 0;
  fire('keydown', { key: 'Backspace', keyCode: 8 });
  textarea.value = 'a';
  fire('input', {});
  assert.deepEqual(sent, [], 'xterm already sent the DEL');
  // ...and the mirror tracked it, so the next character diffs correctly.
  type('c');
  assert.deepEqual(sent, ['c']);
});

test('V61: an IME keydown still wins even after an xterm-owned key', () => {
  const { doc, sent, textarea, fire } = makePage();
  installAndroidInput(doc);
  fire('keydown', { key: 'Enter' });
  fire('keydown', { keyCode: 229, key: 'Unidentified' });
  textarea.value = 'z';
  fire('input', {});
  assert.deepEqual(sent, ['z']);
});

test('V61: compositionstart reclaims ownership from a pending xterm key', () => {
  const { doc, sent, textarea, fire } = makePage();
  installAndroidInput(doc);
  fire('keydown', { key: 'Enter' });
  fire('compositionstart', {});
  textarea.value = 'w';
  fire('input', {});
  assert.deepEqual(sent, ['w']);
});

test('V61: emoji edits never split a surrogate pair', () => {
  const { doc, sent, textarea, fire } = makePage();
  installAndroidInput(doc);
  fire('focusin', {});
  textarea.value = '\u{1F600}';        // grinning face
  fire('input', {});
  assert.deepEqual(sent, ['\u{1F600}']);
  sent.length = 0;
  textarea.value = '\u{1F601}';        // same high surrogate, different low
  fire('input', {});
  // One DEL for the whole pair, then the whole replacement pair — never a
  // lone half.
  assert.deepEqual(sent, [DEL + '\u{1F601}']);
});

test('V61: the scratch textarea is trimmed to a tail, never emptied', () => {
  // Emptying it would break backspace: Gboard only emits
  // deleteContentBackward when there is something to delete.
  const { doc, textarea, fire } = makePage();
  installAndroidInput(doc);
  textarea.value = 'x'.repeat(600) + ' ';
  fire('input', {});
  assert.equal(textarea.value.length, 64);
  assert.ok(textarea.value.length > 0);
});

test('V61: no trimming while a composition is live', () => {
  const { doc, textarea, fire } = makePage();
  installAndroidInput(doc);
  fire('compositionstart', {});
  textarea.value = 'x'.repeat(600);
  fire('input', {});
  assert.equal(textarea.value.length, 600);
});

test('V61: trimming leaves the diff correct for the next keystroke', () => {
  const { doc, sent, textarea, fire } = makePage();
  installAndroidInput(doc);
  textarea.value = 'x'.repeat(600) + ' ';
  fire('input', {});
  sent.length = 0;
  textarea.value += 'y';
  fire('input', {});
  assert.deepEqual(sent, ['y']);
});

test('V61: events for anything but the xterm textarea are ignored', () => {
  const { doc, handlers, sent } = makePage();
  installAndroidInput(doc);
  let stopped = false;
  handlers.input.h({
    target: { value: 'other' },
    stopImmediatePropagation() { stopped = true; },
  });
  assert.equal(stopped, false);
  assert.deepEqual(sent, []);
});

test('V61: survives events fired before ttyd has constructed window.term', () => {
  const { doc, handlers } = makePage({ withTerm: false });
  installAndroidInput(doc);
  assert.doesNotThrow(() => {
    handlers.input.h({ target: {}, stopImmediatePropagation() {} });
    handlers.keydown.h({ target: {}, keyCode: 229, stopImmediatePropagation() {} });
  });
});

// V42: the server inlines this via `.toString()`, so the browser only gets the
// function body — any module-scope reference would be a ReferenceError there.
test('V61: installAndroidInput survives .toString() round-trip (no closure refs)', () => {
  const src = installAndroidInput.toString() + '\nreturn installAndroidInput;';
  const reconstructed = new Function(src)();
  const { doc, sent, type } = makePage();
  reconstructed(doc);
  for (const ch of 'hi') type(ch);
  assert.deepEqual(sent, ['h', 'i']);
});

test('V61: mid-word growth is never trimmed — Gboard tracks its region by offset', () => {
  // Rewriting the box under a live composing region desyncs the keyboard from
  // the DOM, and the next correction is computed against the wrong span (B18).
  const { doc, textarea, fire } = makePage();
  installAndroidInput(doc);
  textarea.value = 'x'.repeat(600);      // long, but mid-word
  fire('input', {});
  assert.equal(textarea.value.length, 600, 'no boundary yet, so no rewrite');
  textarea.value += ' ';                 // boundary reached
  fire('input', {});
  assert.equal(textarea.value.length, 64);
});

test('V61: HARD_CAP trims even without a boundary, so growth stays bounded', () => {
  const { doc, textarea, fire } = makePage();
  installAndroidInput(doc);
  textarea.value = 'x'.repeat(3000);
  fire('input', {});
  assert.equal(textarea.value.length, 64);
});
