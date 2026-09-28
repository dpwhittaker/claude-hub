// g2mirror-backed hub terminals: what replaces tmux for new sessions.
//
// services/ttyd-attach-hub.sh starts each session as a detached g2mirror
// session running `env HUB_TERM_KEY=<key> … <agent>` in the session folder.
// That key is how everything finds it again:
//   - the hub: every session socket in ~/.g2mirror (or $G2MIRROR_DIR) greets
//     a new connection with its wrapped command, pid, size and last-output
//     time, so listing is one short connect per socket;
//   - the browser tab: `g2mirror -a "HUB_TERM_KEY=<key> "` (the trailing
//     space keeps `proj__s1` from matching `proj__s10`);
//   - Claude's registry entries and the glasses hook: the key is in the
//     agent's environment.
//
// Reading the screen (term-capture) views the session as a lowest-ranked
// viewer declaring the session's current size, so it never resizes the app,
// and renders the snapshot with @xterm/headless.
'use strict';

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const KEY_IN_COMMAND = /(?:^|\s)HUB_TERM_KEY=([A-Za-z0-9][A-Za-z0-9._-]{0,127})(?=\s|$)/;
const SOCKET_NAME = /^\d+(-[A-Za-z0-9._-]*)?$/;
const TIMEOUT_MS = 2000;
// u32::MAX: ranks below every other viewer, so it never sets the app's size.
const SIZE_RANK_LAST = 4294967295;

function runtimeDir() {
  return process.env.G2MIRROR_DIR || path.join(os.homedir(), '.g2mirror');
}

function keyOfCommand(command) {
  const m = KEY_IN_COMMAND.exec(String(command || ''));
  return m ? m[1] : null;
}

// One newline-delimited-JSON connection to a session socket. The whole
// exchange must finish within `timeoutMs`, or the socket is destroyed.
function connect(socket, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socket);
    const messages = [];
    let waiter = null;
    let ended = null;
    let buf = '';
    const timer = setTimeout(() => sock.destroy(new Error('g2mirror session timed out')), timeoutMs);
    const settle = () => {
      if (!waiter) return;
      const w = waiter;
      if (messages.length) { waiter = null; w.resolve(messages.shift()); }
      else if (ended) { waiter = null; w.reject(ended); }
    };
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try { messages.push(JSON.parse(line)); } catch {}
      }
      settle();
    });
    sock.on('error', (e) => { ended = e; settle(); });
    sock.on('close', () => {
      clearTimeout(timer);
      ended = ended || new Error('g2mirror session closed');
      settle();
    });
    const conn = {
      next: () => new Promise((res, rej) => { waiter = { resolve: res, reject: rej }; settle(); }),
      async until(type) {
        for (;;) {
          const m = await conn.next();
          if (m.type === type) return m;
          if (m.type === 'error') throw new Error(m.message || 'g2mirror error');
        }
      },
      send: (msg) => new Promise((res, rej) => sock.write(JSON.stringify(msg) + '\n', (e) => (e ? rej(e) : res()))),
      close: () => { clearTimeout(timer); sock.end(); },
    };
    sock.once('connect', () => resolve(conn));
    sock.once('error', reject);
  });
}

// Connect and read the greeting; null for anything that isn't a live session.
async function greet(socket) {
  let conn;
  try {
    conn = await connect(socket);
    const greeting = await conn.next();
    if (greeting.type !== 'connect') { conn.close(); return null; }
    return { conn, greeting };
  } catch {
    if (conn) conn.close();
    return null;
  }
}

function entryOf(socket, g) {
  return {
    name: keyOfCommand(g.command),
    backend: 'g2mirror',
    socket,
    pid: g.pid,
    activity: Number(g.last_output_at) || 0,
    detached: !!g.detached,
    cols: g.host_width,
    rows: g.host_height,
    title: g.title || null,
  };
}

// [{name, backend, socket, pid, activity, detached, cols, rows, title}] for
// every live hub session (sessions without a HUB_TERM_KEY are not ours).
async function list({ dir = runtimeDir() } = {}) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const entries = await Promise.all(names.filter((n) => SOCKET_NAME.test(n)).map(async (n) => {
    const socket = path.join(dir, n);
    const hello = await greet(socket);
    if (!hello) return null;
    hello.conn.close();
    const entry = entryOf(socket, hello.greeting);
    return entry.name ? entry : null;
  }));
  return entries.filter(Boolean);
}

// Where each key was last seen, so per-request lookups skip the full scan.
const lastSeen = new Map();

// A connection to the session for `key`, greeting read, or null.
async function open(key, opts = {}) {
  const cached = lastSeen.get(key);
  if (cached) {
    const hello = await greet(cached);
    if (hello && keyOfCommand(hello.greeting.command) === key) return hello;
    if (hello) hello.conn.close();
    lastSeen.delete(key);
  }
  const found = (await list(opts)).find((e) => e.name === key);
  if (!found) return null;
  lastSeen.set(key, found.socket);
  const hello = await greet(found.socket);
  if (hello && keyOfCommand(hello.greeting.command) === key) return hello;
  if (hello) hello.conn.close();
  return null;
}

async function has(key, opts) {
  const hello = await open(key, opts);
  if (hello) hello.conn.close();
  return !!hello;
}

function initMsg(g) {
  return {
    type: 'init', version: 1, device: 'claude-hub',
    width: g.host_width || 80, height: g.host_height || 24, size_rank: SIZE_RANK_LAST,
  };
}

// Type bytes into the session. `delays` pauses mid-write ([{at, ms}], byte
// offsets): Claude Code reads text + Enter arriving together as a paste.
async function input(key, data, { delays = [], ...opts } = {}) {
  const hello = await open(key, opts);
  if (!hello) return false;
  const { conn, greeting } = hello;
  try {
    await conn.send(initMsg(greeting));
    await conn.send({ type: 'input', data: Buffer.from(data).toString('base64'), delays });
  } finally { conn.close(); }
  return true;
}

// Text of the visible screen, wrapped rows joined (like capture-pane -J).
function screenText(bytes, cols, rows) {
  const { Terminal } = require('@xterm/headless');
  return new Promise((resolve) => {
    const term = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
    term.write(bytes, () => {
      const buffer = term.buffer.active;
      const out = [];
      for (let i = 0; i < rows; i++) {
        const line = buffer.getLine(buffer.viewportY + i);
        if (!line) continue;
        const text = line.translateToString(false);
        if (line.isWrapped && out.length) out[out.length - 1] += text;
        else out.push(text);
      }
      term.dispose();
      resolve(out.map((l) => l.replace(/\s+$/, '')).join('\n'));
    });
  });
}

// → {text, cols, rows} of the session's screen, or null.
async function capture(key, opts) {
  const hello = await open(key, opts);
  if (!hello) return null;
  const { conn, greeting } = hello;
  try {
    await conn.send(initMsg(greeting));
    await conn.send({ type: 'view' });
    const snap = await conn.until('snapshot');
    const text = await screenText(Buffer.from(snap.data, 'base64'), snap.width, snap.height);
    return { text, cols: snap.width, rows: snap.height };
  } finally { conn.close(); }
}

function childrenOf(pid) {
  const kids = new Set();
  try {
    for (const tid of fs.readdirSync(`/proc/${pid}/task`)) {
      const raw = fs.readFileSync(`/proc/${pid}/task/${tid}/children`, 'utf8');
      for (const c of raw.split(/\s+/).filter(Boolean)) kids.add(Number(c));
    }
  } catch {}
  return [...kids];
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return !!e && e.code === 'EPERM'; }
}

// Close the session the way closing a terminal would (tmux kill-session
// did the same): hang up the agent's process group; the wrapper exits once
// the pty's last writer is gone. SIGTERM to the wrapper is the fallback.
async function kill(key, { graceMs = 3000, ...opts } = {}) {
  const hello = await open(key, opts);
  if (!hello) return false;
  hello.conn.close();
  const wrapper = hello.greeting.pid;
  for (const child of childrenOf(wrapper)) {
    try { process.kill(-child, 'SIGHUP'); } catch { try { process.kill(child, 'SIGHUP'); } catch {} }
  }
  const deadline = Date.now() + graceMs;
  while (alive(wrapper) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  if (alive(wrapper)) { try { process.kill(wrapper, 'SIGTERM'); } catch {} }
  lastSeen.delete(key);
  return true;
}

module.exports = { list, has, input, capture, kill, keyOfCommand, screenText, runtimeDir, SIZE_RANK_LAST };
