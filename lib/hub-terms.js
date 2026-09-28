// Hub terminals by key, whichever backend runs them. A session started
// before the move off tmux keeps its tmux session until that ends; the
// attach script starts everything else under g2mirror (lib/g2sessions.js),
// or under tmux again when HUB_TERM_BACKEND=tmux. Callers never care which:
// they ask by key and the backend holding it answers.
'use strict';

const g2default = require('./g2sessions');

// How long Enter waits after typed text, so Claude Code reads a submit
// rather than a paste ending in a newline.
const ENTER_PAUSE_MS = 150;

function makeHubTerms({ execFileP, g2 = g2default }) {
  // Exact session-name match (`=`), no prefix search — and the trailing ':'
  // is load-bearing: has-session takes `=key`, but every pane-targeted
  // command (send-keys, capture-pane, display-message) answers "can't find
  // pane" to it and wants `=key:` = that session's active pane (B25).
  const tmuxSession = (key) => '=' + key;
  const tmuxTarget = (key) => '=' + key + ':';
  const tmux = (args) => execFileP('tmux', args, { timeout: 3000, maxBuffer: 4 * 1024 * 1024 });

  async function tmuxHas(key) {
    try { await tmux(['has-session', '-t', tmuxSession(key)]); return true; } catch { return false; }
  }

  // activity = tmux's last-activity time, the "most recent response" a
  // shell or codex session can report (V92).
  async function tmuxList() {
    try {
      const { stdout } = await tmux(['list-sessions', '-F', '#{session_name}\t#{session_activity}']);
      return stdout.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const [name, activity] = l.split('\t');
        return { name, activity: Number(activity) * 1000 || 0, backend: 'tmux' };
      });
    } catch { return []; }
  }

  // [{name, activity, backend, …}] — every live terminal of both kinds. For
  // g2mirror, activity is the app's last output.
  async function list() {
    const [t, g] = await Promise.all([tmuxList(), g2.list().catch(() => [])]);
    return [...t, ...g];
  }

  // → {text, cols, rows} of the visible screen, or null when nothing runs
  // under `key`. Throws when the terminal exists but can't be read.
  async function capture(key) {
    if (await tmuxHas(key)) {
      const { stdout } = await tmux(['capture-pane', '-p', '-J', '-t', tmuxTarget(key)]);
      let cols = 0; let rows = 0;
      try {
        const dims = await tmux(['display-message', '-p', '-t', tmuxTarget(key), '#{pane_width} #{pane_height}']);
        [cols, rows] = dims.stdout.trim().split(' ').map(Number);
      } catch {}
      return { text: stdout, cols, rows };
    }
    return g2.capture(key);
  }

  // Type `text` literally, then Enter if asked. → false when nothing runs
  // under `key`.
  async function type(key, text, enter) {
    if (await tmuxHas(key)) {
      if (text) await tmux(['send-keys', '-t', tmuxTarget(key), '-l', '--', text]);
      if (enter) await tmux(['send-keys', '-t', tmuxTarget(key), 'Enter']);
      return true;
    }
    const at = Buffer.byteLength(text || '');
    const delays = enter && at ? [{ at, ms: ENTER_PAUSE_MS }] : [];
    return g2.input(key, (text || '') + (enter ? '\r' : ''), { delays });
  }

  // Raw escape sequences (wheel ticks) straight to the app.
  async function sendRaw(key, seqs) {
    if (await tmuxHas(key)) {
      if (seqs.length) await tmux(['send-keys', '-t', tmuxTarget(key), '-l', '--', ...seqs]);
      return true;
    }
    return g2.input(key, seqs.join(''));
  }

  // Close the terminal and its agent. → false when nothing ran under `key`.
  async function kill(key) {
    if (await tmuxHas(key)) {
      try { await tmux(['kill-session', '-t', tmuxSession(key)]); return true; } catch { return false; }
    }
    return g2.kill(key);
  }

  return { list, capture, type, sendRaw, kill };
}

module.exports = { makeHubTerms, ENTER_PAUSE_MS };
