'use strict';
/**
 * Faceclaw assistant bridge — a WebSocket server the faceclaw glasses app dials
 * out to, routing its voice-assistant turns to Claude Code on this box.
 *
 * Faceclaw is the ws CLIENT (plain ws://host:port; the tailnet is the private
 * channel). Protocol v1, one JSON object per text frame, multiplexed by `chan`:
 *
 *   ctl   {type:"hello", version, token, deviceName, capabilities[]}  → we reply
 *         {type:"hello-ack"}  (or {type:"error", message} then close on bad token)
 *         we may send {type:"ping", ts}; the phone answers {type:"pong", ts}
 *   chat  {type:"utterance", turnId, text, ctx}  → we stream back
 *         {type:"text-delta", turnId, text, replace?}, optional
 *         {type:"tool-activity", turnId, label}, then exactly one terminal
 *         {type:"turn-done", turnId, stopReason?} or {type:"turn-error", turnId, message}
 *         {type:"cancel", turnId}  → we kill the in-flight turn
 *   mcp   {msg:<JSON-RPC>}  (phone is the MCP server)
 *
 * Lockdown: a shared token is required (data/assistant-bridge-token, generated
 * if absent, 0600), and connections are IP-allowlisted to loopback + the
 * tailscale CGNAT range (100.64.0.0/10) regardless of bind address. Turns run
 * `claude -p`; nothing is exposed publicly and no proactive/tool access is
 * granted unless configured.
 *
 * Ground truth for the wire protocol: the faceclaw client at
 * app/assistant/bridge-client.ts (+ types.ts) in the faceclaw repo.
 */
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');

const PROTOCOL_VERSION = 1;
const DATA_DIR = path.join(__dirname, '..', 'data');
const TOKEN_FILE = path.join(DATA_DIR, 'assistant-bridge-token');
const CONFIG_FILE = path.join(DATA_DIR, 'assistant-bridge.json');
const PROXY_PATH = path.join(__dirname, 'mcp-stdio-proxy.js');
const PING_INTERVAL_MS = 30_000;

const DEFAULT_CONFIG = {
  port: 8013,
  // Loopback by default: nothing is exposed off-box until you deliberately set
  // host to '0.0.0.0' (the IP allowlist still limits it to loopback + tailnet)
  // or to the tailscale IP. The phone reaches it over the tailnet only once you do.
  host: '127.0.0.1',
  projectDir: os.homedir(), // cwd for `claude -p`
  continueConversation: true, // resume the same claude session per connection
  claudeBin: 'claude',
  // Locked down by default: no extra tool permissions. Widen deliberately, e.g.
  // ["--permission-mode","acceptEdits"] or ["--allowedTools","Read,Bash(git*)"] .
  claudeExtraArgs: [],
  allowProactive: false,
  // Stream the model's extended thinking. faceclaw has no separate thinking pane,
  // so it shows inline as reply text and is wiped (replace) when the answer starts.
  showThinking: false,
  mcp: { enabled: true, serverName: 'glasses', strict: true },
};

function log(...args) {
  console.log(`[assistant-bridge]`, ...args);
}

function runtimeDir() {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg) { try { fs.accessSync(xdg, fs.constants.W_OK); return xdg; } catch { /* fall through */ } }
  return os.tmpdir();
}

function loadConfig() {
  let cfg = { ...DEFAULT_CONFIG };
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      cfg = { ...cfg, ...parsed, mcp: { ...DEFAULT_CONFIG.mcp, ...(parsed.mcp || {}) } };
    }
  } catch (err) {
    log(`config parse failed, using defaults: ${err.message}`);
  }
  return cfg;
}

function loadOrCreateToken() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(TOKEN_FILE)) {
      const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
      if (t) return t;
    }
  } catch (err) {
    log(`token read failed: ${err.message}`);
  }
  const token = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(TOKEN_FILE, token + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(TOKEN_FILE, 0o600);
  } catch { /* best effort */ }
  log(`generated a new bridge token at ${TOKEN_FILE}`);
  return token;
}

/** Loopback or tailscale (100.64.0.0/10) only. Rejects LAN / public peers. */
function isAllowedRemote(addr) {
  if (!addr) return false;
  const ip = addr.replace(/^::ffff:/, '');
  if (ip === '127.0.0.1' || ip === '::1') return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(ip);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 100 && b >= 64 && b <= 127; // 100.64.0.0/10
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch { /* dropped */ }
  }
}

const mcpTurns = new Map(); // turnKey -> connection
const mcpSockPath = path.join(runtimeDir(), `claude-hub-assistant-mcp-${process.pid}.sock`);
try { fs.unlinkSync(mcpSockPath); } catch {}
const mcpSock = net.createServer((socket) => {
  let buf = '', conn = null; socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buf += chunk; let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      if (!conn) { // handshake: {turnKey}
        try { conn = mcpTurns.get(JSON.parse(line).turnKey); } catch { socket.destroy(); return; }
        if (!conn) { socket.destroy(); return; }
        conn.mcpProxy = socket; continue;
      }
      try { send(conn.ws, { chan: 'mcp', msg: JSON.parse(line) }); } catch { /* */ } // Claude -> phone
    }
  });
  socket.on('close', () => { if (conn && conn.mcpProxy === socket) conn.mcpProxy = null; });
});
mcpSock.listen(mcpSockPath, () => { try { fs.chmodSync(mcpSockPath, 0o600); } catch {} });
mcpSock.on('error', e => log(e.message));
mcpSock.unref();

// ---- claude -p turn --------------------------------------------------------

function mcpArgsForTurn(cfg, conn) {
  if (!cfg.mcp.enabled || !conn.capabilities.includes('mcp')) return [];
  const turnKey = crypto.randomBytes(16).toString('hex');
  const cfgFile = path.join(runtimeDir(), `claude-hub-mcp-${turnKey}.json`);
  fs.writeFileSync(cfgFile, JSON.stringify({ mcpServers: { [cfg.mcp.serverName]:
    { command: process.execPath, args: [PROXY_PATH], env: { BRIDGE_SOCK: mcpSockPath, BRIDGE_TURN: turnKey } } } }), { mode: 0o600 });
  conn.mcpTurnKey = turnKey; conn.mcpConfigFile = cfgFile; mcpTurns.set(turnKey, conn);
  const args = ['--mcp-config', cfgFile, '--allowedTools', `mcp__${cfg.mcp.serverName}`];
  if (cfg.mcp.strict) args.push('--strict-mcp-config');
  return args; // append to the `claude -p` args
}

/**
 * Run one turn through `claude -p --output-format stream-json`. Streams text
 * back via onDelta, resolves with {stopReason, sessionId} or rejects on error.
 * Returns the child so a cancel can kill it.
 */
function runClaudeTurn(cfg, conn, text, { onDelta, onToolActivity, onDone, onError }) {
  const args = ['-p', text, '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  if (cfg.continueConversation && conn.sessionId) args.push('--resume', conn.sessionId);
  args.push(...(cfg.claudeExtraArgs || []));
  args.push(...mcpArgsForTurn(cfg, conn));

  let child;
  try {
    child = spawn(cfg.claudeBin, args, {
      cwd: cfg.projectDir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    onError(`could not start claude: ${err.message}`);
    return null;
  }

  let stdoutBuf = '';
  let stderrBuf = '';
  let emittedAny = false;
  let resultText = '';
  let resultErr = false;
  let stopReason = null;
  let showedThinking = false;
  let answerStarted = false;

  const handleEvent = (evt) => {
    if (!evt || typeof evt !== 'object') return;
    switch (evt.type) {
      case 'system':
        if (evt.session_id) conn.sessionId = evt.session_id;
        break;
      case 'stream_event': {
        const e = evt.event;
        if (e && e.type === 'content_block_delta' && e.delta) {
          if (typeof e.delta.text === 'string' && e.delta.text) {
            emittedAny = true;
            onDelta(e.delta.text, showedThinking && !answerStarted); // wipe thinking when the answer starts
            answerStarted = true;
          } else if (cfg.showThinking && typeof e.delta.thinking === 'string' && e.delta.thinking) {
            showedThinking = true;
            onDelta(e.delta.thinking, false);
          }
        }
        break;
      }
      case 'assistant':
        // Surface tool calls as progress; faceclaw renders tool-activity.
        if (evt.message && Array.isArray(evt.message.content)) {
          for (const b of evt.message.content) {
            if (b && b.type === 'tool_use' && b.name) onToolActivity(b.name);
          }
        }
        break;
      case 'result':
        if (evt.session_id) conn.sessionId = evt.session_id;
        if (typeof evt.result === 'string') resultText = evt.result;
        resultErr = evt.is_error === true || evt.subtype === 'error';
        stopReason = typeof evt.subtype === 'string' ? evt.subtype : null;
        break;
      default:
        break;
    }
  };

  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString('utf8');
    let nl;
    while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line) continue;
      try { handleEvent(JSON.parse(line)); } catch { /* non-JSON line */ }
    }
  });
  child.stderr.on('data', (chunk) => { stderrBuf += chunk.toString('utf8'); });

  child.on('error', (err) => onError(`claude failed: ${err.message}`));
  child.on('close', (code) => {
    // If partials weren't available, deliver the aggregated result once.
    if (!emittedAny && resultText) onDelta(resultText, showedThinking);
    if (resultErr || code !== 0) {
      onError(resultErr && resultText ? resultText : (stderrBuf.trim() || `claude exited with code ${code}`));
    } else {
      onDone(stopReason);
    }
  });
  return child;
}

// ---- server ----------------------------------------------------------------

function startBridge(overrides = {}) {
  const cfg = { ...loadConfig(), ...overrides };
  const token = overrides.token || loadOrCreateToken();

  const httpServer = http.createServer((req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain' });
    res.end('assistant-bridge: WebSocket only\n');
  });

  const wss = new WebSocketServer({
    server: httpServer,
    maxPayload: 256 * 1024,
    verifyClient: ({ req }, cb) => {
      const ok = isAllowedRemote(req.socket.remoteAddress);
      if (!ok) log(`rejected connection from ${req.socket.remoteAddress}`);
      cb(ok, 1008, 'forbidden');
    },
  });

  wss.on('connection', (ws, req) => {
    const conn = { ws, authed: false, deviceName: null, capabilities: [], sessionId: null, turnId: null, child: null, mcpProxy: null, mcpTurnKey: null, mcpConfigFile: null };
    const peer = (req.socket.remoteAddress || '?').replace(/^::ffff:/, '');
    let alive = true;
    const pinger = setInterval(() => {
      if (!alive) { try { ws.terminate(); } catch { /* */ } return; }
      alive = false;
      send(ws, { chan: 'ctl', type: 'ping', ts: Date.now() });
    }, PING_INTERVAL_MS);

    const clearMcp = () => {
      if (conn.mcpTurnKey) { mcpTurns.delete(conn.mcpTurnKey); conn.mcpTurnKey = null; }
      if (conn.mcpConfigFile) { try { fs.unlinkSync(conn.mcpConfigFile); } catch {} conn.mcpConfigFile = null; }
      if (conn.mcpProxy) { try { conn.mcpProxy.destroy(); } catch {} conn.mcpProxy = null; }
    };
    const endTurn = () => {
      if (conn.child) { try { conn.child.kill('SIGTERM'); } catch {} conn.child = null; }
      conn.turnId = null;
      clearMcp();
    };

    ws.on('message', (raw) => {
      let frame;
      try { frame = JSON.parse(raw.toString('utf8')); } catch { return; }
      if (!frame || typeof frame !== 'object') return;

      if (frame.chan === 'ctl') {
        if (frame.type === 'hello') {
          if (frame.token !== token) {
            log(`bad token from ${peer}`);
            send(ws, { chan: 'ctl', type: 'error', message: 'invalid token' });
            try { ws.close(1008, 'invalid token'); } catch { /* */ }
            return;
          }
          conn.authed = true;
          conn.deviceName = String(frame.deviceName || 'glasses');
          conn.capabilities = Array.isArray(frame.capabilities) ? frame.capabilities.map(String) : [];
          log(`authed: ${conn.deviceName} @ ${peer} (protocol ${frame.version})`);
          send(ws, { chan: 'ctl', type: 'hello-ack', version: PROTOCOL_VERSION });
          return;
        }
        if (frame.type === 'pong') { alive = true; return; }
        return;
      }

      if (!conn.authed) return; // must hello first

      if (frame.chan === 'chat') {
        if (frame.type === 'utterance') {
          const turnId = frame.turnId;
          const text = typeof frame.text === 'string' ? frame.text : '';
          if (!turnId || !text.trim()) {
            send(ws, { chan: 'chat', type: 'turn-error', turnId, message: 'empty utterance' });
            return;
          }
          endTurn(); // one turn at a time
          conn.turnId = turnId;
          log(`turn ${turnId}: ${text.slice(0, 120)}`);
          send(ws, { chan: 'chat', type: 'tool-activity', turnId, label: 'thinking…' }); // instant feedback before the first token
          const cbs = {
            onDelta: (t, replace) => { if (conn.turnId === turnId) send(ws, { chan: 'chat', type: 'text-delta', turnId, text: t, replace: replace === true }); },
            onToolActivity: (label) => { if (conn.turnId === turnId) send(ws, { chan: 'chat', type: 'tool-activity', turnId, label: String(label).replace(/^mcp__[^_]+__/, '') }); },
            onDone: (stopReason) => {
              if (conn.turnId !== turnId) return;
              send(ws, { chan: 'chat', type: 'turn-done', turnId, stopReason: stopReason || null });
              conn.turnId = null; conn.child = null; clearMcp();
            },
            onError: (message) => {
              if (conn.turnId !== turnId) return;
              send(ws, { chan: 'chat', type: 'turn-error', turnId, message: String(message).slice(0, 500) });
              conn.turnId = null; conn.child = null; clearMcp();
            },
          };
          conn.child = runClaudeTurn(cfg, conn, text, cbs);
          return;
        }
        if (frame.type === 'cancel') {
          if (frame.turnId === conn.turnId) { endTurn(); log(`turn ${frame.turnId} cancelled`); }
          return;
        }
        return;
      }

      if (frame.chan === 'mcp') {
        if (conn.mcpProxy && frame.msg !== undefined) conn.mcpProxy.write(JSON.stringify(frame.msg) + '\n');
        return;
      }
    });

    ws.on('close', () => { clearInterval(pinger); endTurn(); });
    ws.on('error', () => { clearInterval(pinger); endTurn(); });
  });

  httpServer.listen(cfg.port, cfg.host, () => {
    log(`listening on ws://${cfg.host}:${cfg.port}  cwd=${cfg.projectDir}`);
    log(`token: ${TOKEN_FILE}  (allowlist: loopback + 100.64.0.0/10)`);
  });

  return { httpServer, wss, cfg, token };
}

module.exports = { startBridge, isAllowedRemote, DEFAULT_CONFIG, TOKEN_FILE, CONFIG_FILE };

if (require.main === module) {
  startBridge();
}
