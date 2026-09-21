/**
 * Glasses-side terminal relay (SPEC §V74–§V77).
 *
 * Three small stores behind the /api/term-* routes that the G2 client uses:
 *
 *   watched  — which terminal keys a glasses client has polled recently. A key
 *              is "watched" for WATCH_TTL_MS after its last /api/term-capture
 *              poll. This is the ONLY thing that lets a hook interfere with a
 *              terminal: an unwatched terminal's prompts are never held.
 *   pending  — at most one held prompt per key (a question or a permission
 *              request), waiting for the glasses to answer it. The hook that
 *              raised it is parked on the promise `hold()` returns.
 *   state    — last things the hooks reported for a key (Claude's final
 *              message of the turn, the latest notification), so the glasses
 *              can show "waiting for you" without scraping the pane.
 *
 * Pure: no http, no tmux. `now` is injectable for tests.
 */
'use strict';

const WATCH_TTL_MS = 5000;
// Under the hook's own timeout (Claude Code default 600 s for command hooks)
// so the hold resolves cleanly and the TUI dialog appears, instead of the
// hook being killed.
const HOLD_MAX_MS = 540000;
const SWEEP_MS = 500;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const KINDS = Object.freeze(['question', 'permission', 'stop', 'notification']);
const HELD_KINDS = Object.freeze(['question', 'permission']);

function isTermKey(key) {
  return typeof key === 'string' && key.length <= 128 && KEY_RE.test(key);
}

function makeRelay(opts = {}) {
  const now = opts.now || Date.now;
  const watchTtlMs = opts.watchTtlMs ?? WATCH_TTL_MS;
  const holdMaxMs = opts.holdMaxMs ?? HOLD_MAX_MS;
  const sweepMs = opts.sweepMs ?? SWEEP_MS;
  const watched = new Map();
  const pending = new Map();
  const state = new Map();
  let seq = 0;

  function markWatched(key) { watched.set(key, now()); }
  function isWatched(key) {
    const t = watched.get(key);
    return t !== undefined && now() - t <= watchTtlMs;
  }
  function getPending(key) {
    const p = pending.get(key);
    return p ? { id: p.id, kind: p.kind, payload: p.payload, createdAt: p.createdAt } : null;
  }
  function getState(key) { return state.get(key) || null; }
  function setState(key, patch) { state.set(key, { ...(state.get(key) || {}), ...patch }); }

  // Park a hook until the glasses answer, release, stop watching, or the hold
  // ages out. Resolves {relay:true, answer} or {relay:false, reason}. Never
  // rejects — the hook must always be able to exit 0.
  function hold(key, kind, payload) {
    if (!HELD_KINDS.includes(kind)) return Promise.resolve({ relay: false, reason: 'not-held' });
    if (!isWatched(key)) return Promise.resolve({ relay: false, reason: 'unwatched' });
    const prev = pending.get(key);
    if (prev) prev.resolve({ relay: false, reason: 'superseded' });
    const id = `${key}:${++seq}`;
    return new Promise((resolvePromise) => {
      let timer;
      const entry = {
        id, kind, payload, createdAt: now(),
        resolve(result) {
          if (pending.get(key) === entry) pending.delete(key);
          clearInterval(timer);
          resolvePromise(result);
        },
      };
      pending.set(key, entry);
      timer = setInterval(() => {
        if (pending.get(key) !== entry) { clearInterval(timer); return; }
        if (!isWatched(key)) entry.resolve({ relay: false, reason: 'watcher-gone' });
        else if (now() - entry.createdAt >= holdMaxMs) entry.resolve({ relay: false, reason: 'timeout' });
      }, sweepMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
  }
  function answer(key, id, value) {
    const p = pending.get(key);
    if (!p) return { ok: false, status: 404, error: 'nothing pending' };
    if (p.id !== id) return { ok: false, status: 409, error: 'stale id' };
    p.resolve({ relay: true, answer: value });
    return { ok: true };
  }
  // The glasses hand the prompt back to the TUI (double-tap on a question).
  function release(key, id) {
    const p = pending.get(key);
    if (!p) return { ok: false, status: 404, error: 'nothing pending' };
    if (id && p.id !== id) return { ok: false, status: 409, error: 'stale id' };
    p.resolve({ relay: false, reason: 'released' });
    return { ok: true };
  }
  return { markWatched, isWatched, hold, answer, release, getPending, getState, setState };
}

// SGR-encoded mouse wheel ticks, typed into the pane with `tmux send-keys -l`.
// Claude Code requests mouse tracking, so each tick scrolls its transcript by
// one line (SPEC §R — verified 2026-09-21). Negative = older (wheel up, button
// 64), positive = newer (wheel down, button 65). Capped so a typo cannot flood
// the pane.
function wheelSequences(lines, opts = {}) {
  const n = Math.min(Math.abs(Math.trunc(Number(lines) || 0)), 200);
  const button = lines < 0 ? 64 : 65;
  const col = opts.col ?? 10;
  const row = opts.row ?? 10;
  return Array.from({ length: n }, () => `\x1b[<${button};${col};${row}M`);
}

// `tmux capture-pane -p -J` output → lines, trailing whitespace trimmed,
// trailing blank lines dropped (the pane is padded to its height).
function parseCapture(text) {
  const lines = String(text).replace(/\r/g, '').split('\n').map((l) => l.replace(/\s+$/, ''));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// AskUserQuestion's `answers` map: question text → chosen label(s). Multi-
// select joins labels with ', '; a free-text "Other" answer is the text.
function buildAnswers(questions, picks) {
  const answers = {};
  for (const q of questions || []) {
    const pick = picks && picks[q.question];
    if (pick === undefined || pick === null) continue;
    answers[q.question] = Array.isArray(pick) ? pick.join(', ') : String(pick);
  }
  return answers;
}

module.exports = {
  WATCH_TTL_MS, HOLD_MAX_MS, KINDS, HELD_KINDS,
  isTermKey, makeRelay, wheelSequences, parseCapture, buildAnswers,
};
