// Android soft-keyboard input path for ttyd terminals (V61, B17).
//
// Gboard reports every character as a `keydown` with keyCode 229 — the IME
// sentinel — which xterm.js routes into `CompositionHelper._handleAnyTextareaChanges`:
//
//   const old = textarea.value;
//   setTimeout(() => {
//     if (!this._isComposing) {                        // <- silent drop
//       const diff = textarea.value.replace(old, ""); // <- substring replace
//       ...triggerDataEvent(diff)
//     }
//   }, 0);
//
// Two ways that loses keystrokes, both worse the faster you type:
//
//   1. Every character is deferred to a macrotask, so it competes with the
//      renderer. Under a burst — tmux repainting a full-screen TUI on each
//      echoed byte — the timer queue starves.
//   2. If Gboard opens a composition between the keydown and that macrotask,
//      the diff is discarded outright. The composed text that arrives later
//      covers only [start,end) of the composition, so a character typed
//      before it is gone for good.
//
// There is no local echo, so a dropped character simply never appears, which
// reads as the terminal "waiting for the server".
//
// This shim takes the path over, on Android only. xterm binds
// `compositionstart/update/end` on the textarea in the BUBBLE phase and
// `keydown`/`keypress`/`input` in the capture phase ON THE TEXTAREA ITSELF; a
// capture listener on `document` runs before all of them, so
// stopImmediatePropagation there suppresses xterm's handling without patching
// any private field.
//
// What replaces it: a synchronous prefix-diff of the textarea against a mirror
// of what we last sent. No setTimeout, no composition gate — a change is sent
// by the handler that observed it. Deletions become DEL bytes, so Gboard's
// mid-word autocorrect ("teh " -> "the ") turns into the two backspaces plus
// the correction the PTY expects, rather than a duplicated word.
//
// Two behaviours are deliberately preserved from xterm:
//   - Real keys (anything but 229) keep xterm's own handling, so Enter,
//     arrows and a paired hardware keyboard are untouched. `keypress` sets a
//     flag so a char xterm already sent is not sent twice from `input`.
//   - The textarea is NOT emptied per keystroke. Gboard only emits
//     `deleteContentBackward` when there is something to delete, so an empty
//     textarea silently eats backspaces. We trim to a tail instead, which
//     bounds growth without taking that content away.
//
// Server inlines installAndroidInput.toString() into the ttyd page, so this
// must stay self-contained (V42) — no module-scope references.

function installAndroidInput(doc) {
  if (!doc || doc.__androidInputInstalled) return;
  const view = doc.defaultView;
  if (!view || !view.navigator) return;
  if (!/Android/i.test(view.navigator.userAgent || '')) return;
  doc.__androidInputInstalled = true;

  const DEL = '\u007f'; // 0x7f, what a terminal expects for backspace
  const IME_KEYCODE = 229;
  // Trim the scratch textarea once it passes TRIM_AT, back down to TRIM_KEEP
  // trailing chars. The tail is what keeps `deleteContentBackward` firing.
  const TRIM_AT = 512;
  const TRIM_KEEP = 64;
  // A composition this long never happens; if one is reported it never ended,
  // so stop honouring it rather than let the mirror grow forever.
  const COMPOSITION_CAP = 4096;

  let mirror = '';
  let lastEl = null;
  let composing = false;
  let keyPressSeen = false;

  // xterm's textarea, resolved lazily — ttyd sets window.term after open().
  // Re-seed the mirror if the element is ever swapped out from under us.
  function textareaFor(ev) {
    const term = view.term;
    const el = term && term.textarea;
    if (!el || ev.target !== el) return null;
    if (el !== lastEl) {
      lastEl = el;
      mirror = el.value || '';
    }
    return el;
  }

  function send(data) {
    const term = view.term;
    if (term && typeof term.input === 'function') term.input(data, true);
  }

  // Longest common prefix, never landing between a surrogate pair — splitting
  // one would emit a lone half and corrupt an emoji edit.
  function commonPrefix(a, b) {
    const max = Math.min(a.length, b.length);
    let i = 0;
    while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++;
    if (i > 0) {
      const prev = a.charCodeAt(i - 1);
      if (prev >= 0xd800 && prev <= 0xdbff) i--;
    }
    return i;
  }

  function flush(el) {
    const now = el.value || '';
    if (now === mirror) return;
    const keep = commonPrefix(now, mirror);
    // One DEL per CODEPOINT dropped, not per UTF-16 unit — a line editor
    // erases an emoji with one backspace, not two.
    let out = '';
    for (let i = keep; i < mirror.length; i++) {
      const c = mirror.charCodeAt(i);
      if (c >= 0xdc00 && c <= 0xdfff) continue; // low half of a pair
      out += DEL;
    }
    // A newline in the textarea means Enter reached us as composed text rather
    // than as a keydown; terminals want CR.
    out += now.slice(keep).replace(/\n/g, '\r');
    mirror = now;
    if (out) send(out);
  }

  // Bound the scratch buffer without emptying it (see header note on
  // backspace). Trimming to a suffix is safe because the diff is a prefix
  // diff and the mirror is trimmed in lockstep.
  function trim(el) {
    if (composing) return;
    const v = el.value || '';
    if (v.length <= TRIM_AT) return;
    const tail = v.slice(-TRIM_KEEP);
    el.value = tail;
    mirror = tail;
  }

  doc.addEventListener('keydown', (ev) => {
    const el = textareaFor(ev);
    if (!el) return;
    keyPressSeen = false;
    if (ev.keyCode !== IME_KEYCODE) return; // real key — xterm still owns it
    ev.stopImmediatePropagation();
    // xterm's _keyDown does this before handing off to the composition
    // helper; keep it so typing still jumps out of scrollback.
    const term = view.term;
    if (term && typeof term.scrollToBottom === 'function') term.scrollToBottom();
  }, true);

  // Left to bubble into xterm, which sends the character itself. We only need
  // to know it happened so `input` does not send it a second time.
  doc.addEventListener('keypress', (ev) => {
    if (textareaFor(ev)) keyPressSeen = true;
  }, true);

  // Bind the textarea as soon as it can receive input, so the mirror is seeded
  // from an empty box. Without this, an `input` that arrives with no preceding
  // keydown — voice input, a suggestion-strip tap — would be first sight of
  // the element, and seeding the mirror from its already-updated value would
  // swallow exactly that text.
  doc.addEventListener('focusin', (ev) => { textareaFor(ev); }, true);

  doc.addEventListener('compositionstart', (ev) => {
    if (!textareaFor(ev)) return;
    ev.stopImmediatePropagation();
    composing = true;
  }, true);

  doc.addEventListener('compositionupdate', (ev) => {
    if (!textareaFor(ev)) return;
    ev.stopImmediatePropagation();
  }, true);

  doc.addEventListener('compositionend', (ev) => {
    const el = textareaFor(ev);
    if (!el) return;
    ev.stopImmediatePropagation();
    composing = false;
    flush(el);
    trim(el);
  }, true);

  doc.addEventListener('input', (ev) => {
    const el = textareaFor(ev);
    if (!el) return;
    ev.stopImmediatePropagation();
    if (keyPressSeen) {
      // xterm's keypress path already sent this one — adopt the text without
      // re-sending it, so the next diff starts from the truth.
      mirror = el.value || '';
      keyPressSeen = false;
    } else {
      flush(el);
    }
    if (composing && mirror.length > COMPOSITION_CAP) composing = false;
    trim(el);
  }, true);
}

module.exports = { installAndroidInput };
