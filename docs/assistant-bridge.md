# Faceclaw assistant bridge

Routes the faceclaw glasses voice assistant to Claude Code on this box. Faceclaw
(the phone) is the WebSocket **client**; this service is the server it dials.

- Code: `lib/assistant-bridge.js` · Service: `services/assistant-bridge.service`
- Tests: `node --test test/assistant-bridge.test.js` (protocol + IP allowlist, no
  real `claude` or network needed)

## Protocol (v1)

Plain `ws://host:port`, one JSON object per frame, multiplexed by `chan`
(ground truth: faceclaw `app/assistant/bridge-client.ts`):

| chan | in (phone → bridge) | out (bridge → phone) |
|---|---|---|
| ctl | `{type:"hello",version,token,deviceName,capabilities[]}` · `{type:"pong",ts}` | `{type:"hello-ack"}` / `{type:"error",message}` (then close) · `{type:"ping",ts}` |
| chat | `{type:"utterance",turnId,text,ctx}` · `{type:"cancel",turnId}` | `{type:"text-delta",turnId,text,replace?}` · `{type:"tool-activity",turnId,label}` · `{type:"turn-done",turnId,stopReason?}` · `{type:"turn-error",turnId,message}` |
| mcp | `{msg:<JSON-RPC>}` (phone is the MCP server) | *unused in v1* |

Each utterance runs one turn; the terminal frame is always `turn-done` or
`turn-error` (the phone times a turn out after 3 min otherwise).

## How a turn runs

Each utterance runs `claude -p <text> --output-format stream-json
--include-partial-messages`, streaming `content_block_delta` text back as
`text-delta`. `continueConversation:true` resumes the same claude session per
connection (`--resume`). Locked down: `claudeExtraArgs` is empty, so no non-MCP
tool permissions are granted — the assistant answers (plus the glasses MCP tools
if enabled; see below). Widen deliberately, e.g. `["--permission-mode","acceptEdits"]`.

(An early tmux-injection mode was dropped as unreliable — no clean turn boundary.
`claude -p` is the only route.)

No OpenClaw. Everything defers to `claude`.

### Progress feedback & latency

To avoid a silent gap while the model works, the bridge sends:
- an immediate `tool-activity: "thinking…"` the moment a turn starts;
- a `tool-activity` frame for **each tool call** (from the stream's `assistant`
  `tool_use` blocks), with the `mcp__glasses__` prefix stripped — faceclaw's
  assistant UI renders these via `onToolActivity`;
- answer text as `text-delta` as it streams.

**Thinking text:** set `"showThinking": true` in `data/assistant-bridge.json` to
stream the model's extended thinking. faceclaw has no separate thinking pane, so
it shows inline as reply text and is wiped (via `text-delta` `replace`) the
instant the real answer begins. Off by default; note thinking only appears if the
model/config emits it.

**Latency:** most of the wait is the model, not the bridge. The biggest lever is
the model — add e.g. `"claudeExtraArgs": ["--model","claude-haiku-4-5-20251001"]`
for snappy replies, or a Sonnet id for a middle ground. `continueConversation`
already reuses the session so turns after the first skip re-priming.

## Lockdown

- **Token required** — `data/assistant-bridge-token` (auto-generated, `0600`,
  gitignored). A wrong/absent token gets a ctl `error` and the socket is closed.
- **IP allowlist** — connections are accepted only from loopback and the
  tailscale CGNAT range `100.64.0.0/10`, regardless of bind address. LAN/public
  peers are dropped at the handshake.
- **Bind loopback by default** (`host:"127.0.0.1"`); it is not reachable off-box
  until you set `host` (see below). No `allowProactive`, no MCP tool access.
- The tailnet itself is the encrypted channel (WireGuard), so plain `ws://` over
  it is fine; faceclaw does not speak `wss://`.

## Enable it (these steps expose a network service — run them yourself)

```bash
cd ~/projects/claude-hub

# 1. Config: expose on the tailnet. Either bind all interfaces (the IP allowlist
#    still restricts it to loopback + tailnet) ...
cat > data/assistant-bridge.json <<'JSON'
{ "port": 8013, "host": "0.0.0.0",
  "projectDir": "/home/david", "continueConversation": true,
  "claudeBin": "claude", "claudeExtraArgs": [], "allowProactive": false }
JSON
#    ... or bind only the tailscale IP for a tighter surface:
#    "host": "$(tailscale ip -4)"

# 2. Generate the token (or let the service create it on first start):
node -e "require('./lib/assistant-bridge').startBridge({port:0}).httpServer.close()"
cat data/assistant-bridge-token          # you'll type this into the phone

# 3. Install + start the service (isolated; does NOT touch claude-hub.service):
sudo install -m 644 services/assistant-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now assistant-bridge.service
systemctl status assistant-bridge.service --no-pager
ss -ltn | grep 8013
```

No `tailscale serve` line is needed — faceclaw connects to the raw `ws://` port
over the tailnet; `tailscale serve` is for TLS/https and would not match.

## On the phone (faceclaw → Settings → Assistant → External bridge)

- **Host:** `<gpu-host>.<tailnet>.ts.net` (the server's tailnet FQDN)
- **Port:** `8013`
- **Token:** the contents of `data/assistant-bridge-token`
- Leave "allow proactive" off.

Then say "Hey Even, …"; the query runs through `claude -p` here and the reply
streams onto the glasses.

## Optional: MCP — letting Claude Code drive the glasses tools

**Status: designed, NOT wired into `lib/assistant-bridge.js`.** The bridge ships
chat-only. The pieces below turn the `mcp` channel on so Claude Code can call the
phone's own tools (show alerts, control media, read notifications, type into the
terminal). `lib/mcp-stdio-proxy.js` is already present; the rest is the delta you
would add to `lib/assistant-bridge.js` **only if you accept the risks below**.

### How it works

The phone is the MCP *server* (its tool registry). Per `claude -p` turn we hand
Claude a stdio MCP server (`mcp-stdio-proxy.js`) whose JSON-RPC we relay over the
turn's `mcp` channel to the phone, and pre-approve only the glasses tools:

```
Claude Code ──stdio──▶ mcp-stdio-proxy ──unix socket──▶ bridge ──ws mcp chan──▶ phone (MCP server)
```

### The delta to `lib/assistant-bridge.js`

1. Config block in `DEFAULT_CONFIG` (and merge `parsed.mcp` in `loadConfig`):

```js
mcp: { enabled: true, serverName: 'glasses', strict: true },
```

2. A loopback unix socket the proxy connects back to. First line = `{turnKey}`;
   the rest is newline-delimited MCP JSON-RPC relayed to the phone:

```js
const mcpTurns = new Map(); // turnKey -> connection
const mcpSockPath = path.join(runtimeDir(), `claude-hub-assistant-mcp-${process.pid}.sock`);
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
```

3. Capture capabilities at `hello`: `conn.capabilities = Array.isArray(frame.capabilities) ? frame.capabilities.map(String) : [];`

4. Relay the phone's replies back to the proxy — in the message handler:

```js
if (frame.chan === 'mcp') {
  if (conn.mcpProxy && frame.msg !== undefined) conn.mcpProxy.write(JSON.stringify(frame.msg) + '\n');
  return;
}
```

5. Per turn, build the claude args (and clean up the temp config + map entry on
   turn end):

```js
function mcpArgsForTurn(conn) {
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
```

### What the phone actually exposes over MCP

Read from faceclaw's registry (`app/assistant/*-tools.ts`, `app/apps/terminal/
terminal-app.worker.ts`), not guessed. The always-on tools are UI/glasses-level:

| Group | Tools | Harm if misfired |
|---|---|---|
| glasses | `get_state`, `show_alert` | push text to the lens; annoyance |
| media | `now_playing`, `play_pause`, `next` | skip/pause your music |
| notifications | `list`, `dismiss` | **read** your notifications; dismiss them |
| calendar | `list_events` | **read** your calendar |
| nav | `start_navigation`, `stop_navigation`, `route_status` | start/stop directions |
| roam | `add_todo`, `read_todos` | read/append a todo list |
| timer/alarm | `timer.*`, `alarm.*`, `stopwatch.control` | set/cancel timers & alarms |
| apps | `launch`, `list_windows`, `focus_window`, `close_window`, folder ops | open/close glasses apps |

**None of these run shell commands.** The realistic abuse of this set, via ASR
mistakes or prompt injection, is **privacy + annoyance**: reading your
notifications/calendar, spamming alerts, messing with media/timers/navigation and
app windows. Unpleasant, not code execution.

The one command-runner is contributed by the **Terminal app, and only while that
app is open on the glasses**: `send_input` (type + run a line), plus
`list_sessions` / `read_screen` / `launch_session`. It acts on **g2mirror**
sessions — terminals a g2mirror server mirrors to the glasses, "across every
connected host."

### ⚠️ The real risk of MCP here (and what it is *not*)

- **`--allowedTools mcp__glasses` pre-approves every exposed tool with no human in
  the loop** (headless `-p` has no one to prompt). The trigger is untrusted text:
  ASR mis-hears, ambient speech, or **prompt injection** from content Claude reads
  while answering. So assume any exposed tool can fire from a bad utterance.
- **`send_input` is NOT RCE on this box.** In the normal topology g2mirror runs
  *here*, so bridge-Claude → phone → `send_input` types into a terminal on the
  same machine Claude already runs on — circular, and no more than Claude's own
  Bash could do. It only becomes a real new capability if the phone is mirroring a
  terminal on a **different host**, in which case a turn could run commands *there*.
  It also requires the Terminal app to be open on the glasses.
- **`claude -p` itself is the larger surface, MCP or not.** It runs as your user
  in `projectDir`; a crafted utterance can steer Claude within whatever tools it
  has. In strict glasses-only mode its tools are just the list above, so that
  surface is bounded to the glasses actions — the reason to keep it strict.

Net: with strict glasses-only and g2mirror local (or the Terminal app closed),
this is a **privacy + annoyance** surface, not "shell on your box." The scary
version only appears if you widen `allowedTools`, drop `strict`, or mirror another
host's terminal to the glasses.

### ⚠️ Why you might still not want it on your tailnet

- The IP allowlist is `100.64.0.0/10` — *any* tailnet peer, not one device. Every
  node you own, anything you've shared a node with, or an ACL you forgot can reach
  the port and attempt the token.
- **The token is the only gate** (`data/assistant-bridge-token`, typed into the
  phone). No second factor, no per-turn confirmation; a leaked token = the tool
  surface above, driven by whoever holds it.
- **Plain `ws://`** leans entirely on WireGuard — fine against outsiders, no
  defense-in-depth against a *hostile tailnet peer*.

### If you do enable it, sensible knobs

- Keep `strict: true` (only the glasses server; no project `.mcp.json`).
- If you don't want even the remote-host `send_input` case, scope `allowedTools`
  to explicit tools (read the phone's `tools/list` once and list e.g.
  `mcp__glasses__glasses.show_alert`, `mcp__glasses__media.play_pause`) instead of
  the whole `mcp__glasses` server, or just don't open the Terminal app on the
  glasses while the bridge is live.
- Bind to the phone's **specific** tailnet IP, not `0.0.0.0` — narrow the
  allowlist to that one address.
- Keep `allowProactive` off, treat the token as a secret, and watch `journalctl -u
  assistant-bridge.service` for `tool-activity` you did not initiate.

## Troubleshooting

- `journalctl -u assistant-bridge.service -f` — bridge log (auth, each turn).
- "invalid token" on the phone → the token in the app ≠ `data/assistant-bridge-token`.
- Connects then nothing → check `claude` runs headless for `User=david`
  (`claude -p hi` in the WorkingDirectory); the service sources nvm so `node`
  and `claude` are on PATH.
- Rejected silently → the phone's tailnet IP must be in `100.64.0.0/10` (it is)
  and `host` must not be loopback-only.
