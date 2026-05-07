const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
const { startFixture } = require('./helpers/fixture');

test('WS watcher fails closed on ENOSPC, no crash, client gets close (V9, V14)', async () => {
  const fx = await startFixture();
  try {
    fs.mkdirSync(path.join(fx.projectsRoot, 'proj'));
    const origWatch = fs.watch;
    fs.watch = () => {
      const e = new Error('ENOSPC: System limit for number of file watchers reached');
      e.code = 'ENOSPC';
      throw e;
    };
    try {
      const wsUrl = fx.url.replace('http', 'ws') + '/ws/view-tree/proj';
      const ws = new WebSocket(wsUrl);
      let messages = 0;
      ws.on('message', () => { messages++; });

      const closed = await new Promise((resolve) => {
        const t = setTimeout(() => resolve(false), 2000);
        ws.on('close', () => { clearTimeout(t); resolve(true); });
        ws.on('error', () => { /* swallow — close should follow */ });
      });

      assert.equal(closed, true, 'server must close the WS when watcher init fails');
      assert.equal(messages, 0, 'no messages should arrive on a failed watcher');
    } finally {
      fs.watch = origWatch;
    }
  } finally {
    await fx.close();
  }
});
