const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
const { startFixture } = require('./helpers/fixture');

// fs.watch is debounced 50ms server-side; tests give it a generous window.
const SETTLE_MS = 250;

function openWS(fxUrl, project) {
  const wsUrl = fxUrl.replace('http', 'ws') + '/ws/view-tree/' + encodeURIComponent(project);
  const ws = new WebSocket(wsUrl);
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextMessages(ws, ms = SETTLE_MS) {
  return new Promise((resolve) => {
    const out = [];
    const onMsg = (data) => out.push(JSON.parse(data));
    ws.on('message', onMsg);
    setTimeout(() => {
      ws.off('message', onMsg);
      resolve(out);
    }, ms);
  });
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

test('add → {type:add, kind:file} (V10)', async () => {
  const fx = await startFixture();
  try {
    fs.mkdirSync(path.join(fx.projectsRoot, 'p1'));
    const ws = await openWS(fx.url, 'p1');
    await delay(50); // let watcher seed
    fs.writeFileSync(path.join(fx.projectsRoot, 'p1', 'a.txt'), 'hi');
    const msgs = await nextMessages(ws);
    ws.close();
    assert.ok(msgs.some((m) => m.type === 'add' && m.path === 'a.txt' && m.kind === 'file'),
      'expected add for a.txt, got: ' + JSON.stringify(msgs));
  } finally {
    await fx.close();
  }
});

test('edit known file → change event, not add (V10)', async () => {
  const fx = await startFixture();
  try {
    fs.mkdirSync(path.join(fx.projectsRoot, 'p2'));
    fs.writeFileSync(path.join(fx.projectsRoot, 'p2', 'README.md'), 'orig');
    const ws = await openWS(fx.url, 'p2');
    await delay(50);
    fs.writeFileSync(path.join(fx.projectsRoot, 'p2', 'README.md'), 'edited');
    const msgs = await nextMessages(ws);
    ws.close();
    assert.ok(msgs.some((m) => m.type === 'change' && m.path === 'README.md'),
      'expected change for README.md, got: ' + JSON.stringify(msgs));
    assert.ok(!msgs.some((m) => m.type === 'add' && m.path === 'README.md'),
      'should not classify an existing file as add: ' + JSON.stringify(msgs));
  } finally {
    await fx.close();
  }
});

test('delete known file → delete event (V12)', async () => {
  const fx = await startFixture();
  try {
    fs.mkdirSync(path.join(fx.projectsRoot, 'p3'));
    fs.writeFileSync(path.join(fx.projectsRoot, 'p3', 'doomed.txt'), 'x');
    const ws = await openWS(fx.url, 'p3');
    await delay(50);
    fs.unlinkSync(path.join(fx.projectsRoot, 'p3', 'doomed.txt'));
    const msgs = await nextMessages(ws);
    ws.close();
    assert.ok(msgs.some((m) => m.type === 'delete' && m.path === 'doomed.txt'),
      'expected delete for doomed.txt, got: ' + JSON.stringify(msgs));
  } finally {
    await fx.close();
  }
});

test('dim path (node_modules) emits zero events (V9)', async () => {
  const fx = await startFixture();
  try {
    const projDir = path.join(fx.projectsRoot, 'p4');
    fs.mkdirSync(projDir);
    fs.mkdirSync(path.join(projDir, 'node_modules'));
    const ws = await openWS(fx.url, 'p4');
    await delay(50);
    fs.writeFileSync(path.join(projDir, 'node_modules', 'churn.js'), 'x');
    fs.writeFileSync(path.join(projDir, 'node_modules', 'churn.js'), 'y');
    fs.unlinkSync(path.join(projDir, 'node_modules', 'churn.js'));
    const msgs = await nextMessages(ws);
    ws.close();
    const inDim = msgs.filter((m) => (m.path || '').startsWith('node_modules/'));
    assert.equal(inDim.length, 0, 'no events under node_modules: ' + JSON.stringify(inDim));
  } finally {
    await fx.close();
  }
});

test('dir delete cascades: descendants no longer tracked (V12)', async () => {
  const fx = await startFixture();
  try {
    const projDir = path.join(fx.projectsRoot, 'p5');
    fs.mkdirSync(projDir);
    fs.mkdirSync(path.join(projDir, 'sub'));
    fs.writeFileSync(path.join(projDir, 'sub', 'leaf.txt'), 'orig');
    const ws = await openWS(fx.url, 'p5');
    await delay(50);
    // Delete the whole subtree, then re-create a file at the same path.
    fs.rmSync(path.join(projDir, 'sub'), { recursive: true, force: true });
    await delay(150);
    fs.mkdirSync(path.join(projDir, 'sub'));
    fs.writeFileSync(path.join(projDir, 'sub', 'leaf.txt'), 'fresh');
    const msgs = await nextMessages(ws, 400);
    ws.close();
    // leaf.txt should be classified as add (not change), proving its prior
    // entry was dropped from knownFiles when sub/ was deleted.
    const leafAdd = msgs.find((m) => m.path === 'sub/leaf.txt' && m.type === 'add');
    const leafChange = msgs.find((m) => m.path === 'sub/leaf.txt' && m.type === 'change');
    assert.ok(leafAdd, 'leaf.txt should re-add after dir cascade delete: ' + JSON.stringify(msgs));
    assert.ok(!leafChange, 'leaf.txt must not be a change: ' + JSON.stringify(msgs));
  } finally {
    await fx.close();
  }
});

test('last client close tears down watcher (no inotify leak)', async () => {
  const fx = await startFixture();
  try {
    fs.mkdirSync(path.join(fx.projectsRoot, 'p6'));
    const { projectWatchers } = require('../server');
    const ws = await openWS(fx.url, 'p6');
    await delay(50);
    assert.equal(projectWatchers.has('p6'), true, 'watcher should be live while client connected');
    ws.close();
    // close handler runs async; allow it.
    await delay(100);
    assert.equal(projectWatchers.has('p6'), false, 'watcher should be torn down on last client close');
  } finally {
    await fx.close();
  }
});
