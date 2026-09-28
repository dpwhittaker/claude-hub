'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { startBridge, isAllowedRemote } = require('../lib/assistant-bridge');

// A stand-in `claude` that emits the stream-json shapes the bridge parses, so
// the protocol + routing are exercised without the real CLI or any network.
const FAKE_CLAUDE = path.join(os.tmpdir(), `fake-claude-${process.pid}.js`);
fs.writeFileSync(
  FAKE_CLAUDE,
  `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello ' } } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'world' } } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Hello world', session_id: 'sess-1' }) + '\\n');
`,
  { mode: 0o755 },
);

// The bridge spawns cfg.claudeBin with ['-p', text, ...]; the fake is an
// executable node script that ignores those args and emits the fixture stream.
function startFakeBridge() {
  return startBridge({
    port: 0,
    host: '127.0.0.1',
    token: 'test-token',
    mode: 'claude-p',
    claudeBin: FAKE_CLAUDE,
    projectDir: os.tmpdir(),
  });
}

function connect(port) {
  return new WebSocket(`ws://127.0.0.1:${port}`);
}

function listeningPort(bridge) {
  return new Promise((resolve) => {
    const addr = bridge.httpServer.address();
    if (addr) return resolve(addr.port);
    bridge.httpServer.once('listening', () => resolve(bridge.httpServer.address().port));
  });
}

test('isAllowedRemote: loopback + tailnet only', () => {
  assert.ok(isAllowedRemote('127.0.0.1'));
  assert.ok(isAllowedRemote('::1'));
  assert.ok(isAllowedRemote('::ffff:127.0.0.1'));
  assert.ok(isAllowedRemote('100.101.102.103')); // tailnet
  assert.ok(isAllowedRemote('100.64.0.1'));
  assert.ok(!isAllowedRemote('192.168.1.5')); // LAN
  assert.ok(!isAllowedRemote('8.8.8.8')); // public
  assert.ok(!isAllowedRemote('100.200.0.1')); // outside 100.64/10
});

test('handshake + streamed turn via claude-p', async () => {
  const bridge = startFakeBridge();
  const port = await listeningPort(bridge);
  try {
    await new Promise((resolve, reject) => {
      const ws = connect(port);
      let acked = false;
      let deltas = '';
      const timer = setTimeout(() => reject(new Error('timeout')), 8000);
      ws.on('open', () => {
        ws.send(JSON.stringify({ chan: 'ctl', type: 'hello', version: 1, token: 'test-token', deviceName: 'test', capabilities: ['chat'] }));
      });
      ws.on('message', (raw) => {
        const f = JSON.parse(raw.toString());
        if (f.chan === 'ctl' && f.type === 'hello-ack') {
          acked = true;
          ws.send(JSON.stringify({ chan: 'chat', type: 'utterance', turnId: 't1', text: 'hi', ctx: {} }));
        } else if (f.chan === 'chat' && f.type === 'text-delta' && f.turnId === 't1') {
          deltas += f.text;
        } else if (f.chan === 'chat' && f.type === 'turn-done' && f.turnId === 't1') {
          clearTimeout(timer);
          try {
            assert.ok(acked, 'got hello-ack');
            assert.strictEqual(deltas, 'Hello world', 'streamed the full reply');
            ws.close();
            resolve();
          } catch (e) { reject(e); }
        } else if (f.chan === 'chat' && f.type === 'turn-error') {
          clearTimeout(timer);
          reject(new Error(`unexpected turn-error: ${f.message}`));
        }
      });
      ws.on('error', reject);
    });
  } finally {
    bridge.httpServer.close();
  }
});

test('bad token is rejected with a ctl error', async () => {
  const bridge = startFakeBridge();
  const port = await listeningPort(bridge);
  try {
    await new Promise((resolve, reject) => {
      const ws = connect(port);
      const timer = setTimeout(() => reject(new Error('timeout')), 5000);
      ws.on('open', () => ws.send(JSON.stringify({ chan: 'ctl', type: 'hello', version: 1, token: 'WRONG', deviceName: 'x' })));
      ws.on('message', (raw) => {
        const f = JSON.parse(raw.toString());
        if (f.chan === 'ctl' && f.type === 'error') {
          clearTimeout(timer);
          assert.match(f.message, /token/i);
          resolve();
        }
      });
      ws.on('error', reject);
    });
  } finally {
    bridge.httpServer.close();
  }
});

test.after(() => { try { fs.unlinkSync(FAKE_CLAUDE); } catch { /* */ } });
