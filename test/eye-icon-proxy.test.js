// T53 / §V16 — eye-icon render mode routes through the project's proxy
// when `.project-meta.json` declares a `proxyTarget`; falls back to
// `?raw=1` otherwise. Build-tool entry-point index.html files (Vite source
// templates) cannot run from raw bytes, so the iframe must hit the live
// dev/prod server (B12).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startFixture } = require('./helpers/fixture');

async function fetchShell(fx, project) {
  const r = await fetch(fx.url + '/view/' + encodeURIComponent(project) + '/');
  assert.equal(r.status, 200);
  return r.text();
}

test('renderViewShell injects PROXY_PREFIX from .project-meta.json proxyTarget', async () => {
  const fx = await startFixture();
  try {
    const dir = path.join(fx.projectsRoot, 'lifebot');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, '.project-meta.json'), JSON.stringify({
      name: 'lifebot',
      createdAt: '2026-05-14T00:00:00Z',
      proxyTarget: 'http://127.0.0.1:8003',
      stripPrefix: true,
    }));
    const html = await fetchShell(fx, 'lifebot');
    assert.match(html, /const PROXY_PREFIX = "\/lifebot";/,
      'shell should expose proxyPrefix derived from project name');
  } finally {
    await fx.close();
  }
});

test('renderViewShell honors explicit proxyPrefix override', async () => {
  const fx = await startFixture();
  try {
    const dir = path.join(fx.projectsRoot, 'tfs');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, '.project-meta.json'), JSON.stringify({
      name: 'tfs',
      createdAt: '2026-05-14T00:00:00Z',
      proxyTarget: 'http://127.0.0.1:5173',
      proxyPrefix: '/the-first-step',
      stripPrefix: false,
    }));
    const html = await fetchShell(fx, 'tfs');
    assert.match(html, /const PROXY_PREFIX = "\/the-first-step";/);
  } finally {
    await fx.close();
  }
});

test('renderViewShell injects PROXY_PREFIX = null when project has no proxyTarget', async () => {
  const fx = await startFixture();
  try {
    const dir = path.join(fx.projectsRoot, 'static-site');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, '.project-meta.json'), JSON.stringify({
      name: 'static-site',
      createdAt: '2026-05-14T00:00:00Z',
    }));
    const html = await fetchShell(fx, 'static-site');
    assert.match(html, /const PROXY_PREFIX = null;/);
  } finally {
    await fx.close();
  }
});

test('renderViewShell injects PROXY_PREFIX = null when meta is missing', async () => {
  const fx = await startFixture();
  try {
    // No sentinel: still produces a shell (isViewableProject just requires
    // the dir to exist under PROJECTS_ROOT), but PROXY_PREFIX must be null.
    fs.mkdirSync(path.join(fx.projectsRoot, 'bare'));
    const html = await fetchShell(fx, 'bare');
    assert.match(html, /const PROXY_PREFIX = null;/);
  } finally {
    await fx.close();
  }
});

test('renderViewShell rejects malformed proxyPrefix (does not inject)', async () => {
  const fx = await startFixture();
  try {
    const dir = path.join(fx.projectsRoot, 'evil');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, '.project-meta.json'), JSON.stringify({
      name: 'evil',
      createdAt: '2026-05-14T00:00:00Z',
      proxyTarget: 'http://127.0.0.1:1234',
      proxyPrefix: '/foo bar; rm -rf /',
    }));
    const html = await fetchShell(fx, 'evil');
    assert.match(html, /const PROXY_PREFIX = null;/);
  } finally {
    await fx.close();
  }
});
