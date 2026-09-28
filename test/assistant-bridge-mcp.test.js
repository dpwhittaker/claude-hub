'use strict';
// End-to-end MCP relay test: a fake `claude` drives the REAL mcp-stdio-proxy,
// whose JSON-RPC the bridge relays over the ws `mcp` channel to a fake phone
// (the MCP server). Exercises proxy -> unix socket -> bridge -> ws -> phone and
// back, with no real claude and no network beyond loopback.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { startBridge } = require('../lib/assistant-bridge');

// Fake `claude`: parses --mcp-config, spawns the real proxy, does the MCP
// initialize + tools/list handshake through it, and reports the tool names as
// its stream-json result. Mirrors what Claude Code would do with the server.
const FAKE_CLAUDE = path.join(os.tmpdir(), `fake-claude-mcp-${process.pid}.js`);
fs.writeFileSync(
  FAKE_CLAUDE,
  `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const { spawn } = require('child_process');
const args = process.argv.slice(2);
const ci = args.indexOf('--mcp-config');
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
emit({ type: 'system', subtype: 'init', session_id: 's1' });
if (ci < 0) { emit({ type: 'result', subtype: 'success', is_error: false, result: 'no-mcp', session_id: 's1' }); process.exit(0); }
const srv = JSON.parse(fs.readFileSync(args[ci + 1], 'utf8')).mcpServers.glasses;
const proxy = spawn(srv.command, srv.args, { env: Object.assign({}, process.env, srv.env), stdio: ['pipe', 'pipe', 'inherit'] });
const rpc = (o) => proxy.stdin.write(JSON.stringify(o) + '\\n');
let buf = '';
const fail = setTimeout(() => { emit({ type: 'result', subtype: 'error', is_error: true, result: 'mcp-timeout', session_id: 's1' }); process.exit(1); }, 8000);
proxy.stdout.on('data', (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === 1) { rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }); }
    else if (m.id === 2) {
      const names = ((m.result && m.result.tools) || []).map((t) => t.name).join(',');
      clearTimeout(fail);
      emit({ type: 'result', subtype: 'success', is_error: false, result: 'TOOLS=' + names, session_id: 's1' });
      try { proxy.stdin.end(); } catch (e) {}
      process.exit(0);
    }
  }
});
rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
`,
  { mode: 0o755 },
);

function listeningPort(bridge) {
  return new Promise((resolve) => {
    const addr = bridge.httpServer.address();
    if (addr) return resolve(addr.port);
    bridge.httpServer.once('listening', () => resolve(bridge.httpServer.address().port));
  });
}

test('mcp round-trip: proxy -> bridge -> phone -> Claude sees the tools', async () => {
  const bridge = startBridge({
    port: 0,
    host: '127.0.0.1',
    token: 'test-token',
    claudeBin: FAKE_CLAUDE,
    projectDir: os.tmpdir(),
    mcp: { enabled: true, serverName: 'glasses', strict: true },
  });
  const port = await listeningPort(bridge);
  try {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      let deltas = '';
      let sawInit = false;
      let sawList = false;
      const timer = setTimeout(() => reject(new Error('timeout')), 12000);

      // Fake phone = the MCP server.
      const answerMcp = (msg) => {
        if (msg.method === 'initialize') {
          sawInit = true;
          ws.send(JSON.stringify({ chan: 'mcp', msg: { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'glasses', version: '1' } } } }));
        } else if (msg.method === 'tools/list') {
          sawList = true;
          ws.send(JSON.stringify({ chan: 'mcp', msg: { jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'glasses.show_alert', description: 'x', inputSchema: { type: 'object' } }] } } }));
        }
      };

      ws.on('open', () => {
        ws.send(JSON.stringify({ chan: 'ctl', type: 'hello', version: 1, token: 'test-token', deviceName: 'test', capabilities: ['chat', 'mcp'] }));
      });
      ws.on('message', (raw) => {
        const f = JSON.parse(raw.toString());
        if (f.chan === 'ctl' && f.type === 'hello-ack') {
          ws.send(JSON.stringify({ chan: 'chat', type: 'utterance', turnId: 't1', text: 'what can you do', ctx: {} }));
        } else if (f.chan === 'mcp') {
          answerMcp(f.msg);
        } else if (f.chan === 'chat' && f.type === 'text-delta' && f.turnId === 't1') {
          deltas += f.text;
        } else if (f.chan === 'chat' && f.type === 'turn-done' && f.turnId === 't1') {
          clearTimeout(timer);
          try {
            assert.ok(sawInit, 'phone received MCP initialize');
            assert.ok(sawList, 'phone received tools/list');
            assert.match(deltas, /glasses\.show_alert/, 'Claude saw the phone tool through the relay');
            ws.close();
            resolve();
          } catch (e) { reject(e); }
        } else if (f.chan === 'chat' && f.type === 'turn-error') {
          clearTimeout(timer);
          reject(new Error(`turn-error: ${f.message}`));
        }
      });
      ws.on('error', reject);
    });
  } finally {
    bridge.httpServer.close();
  }
});

test.after(() => { try { fs.unlinkSync(FAKE_CLAUDE); } catch { /* */ } });
