// §V16 (extended) — the eye-icon also renders .svg files. SVG render is
// always ?raw=1 (browser renders image/svg+xml natively; an .svg is a source
// file, not a proxy app entry point), so the proxy-render branch must be
// gated to HTML even when the project declares a proxyTarget.
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

test('view shell recognizes .svg as renderable and gates the eye-icon on it', async () => {
  const fx = await startFixture();
  try {
    fs.mkdirSync(path.join(fx.projectsRoot, 'art'));
    const html = await fetchShell(fx, 'art');
    assert.match(html, /function isSvgFile/, 'shell defines isSvgFile');
    assert.match(html, /isRenderable\(n\.name\)/, 'eye-icon gate uses isRenderable (html OR svg)');
  } finally {
    await fx.close();
  }
});

test('SVG render forced to ?raw=1 even when project has a proxyTarget', async () => {
  const fx = await startFixture();
  try {
    const dir = path.join(fx.projectsRoot, 'app');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, '.project-meta.json'), JSON.stringify({
      name: 'app',
      createdAt: '2026-06-24T00:00:00Z',
      proxyTarget: 'http://127.0.0.1:5173',
      stripPrefix: false,
    }));
    const html = await fetchShell(fx, 'app');
    // Proxy-render branch must require isHtmlFile, so .svg falls through to raw.
    assert.match(html, /mode === 'render' && PROXY_PREFIX && isHtmlFile\(filePath\)/);
  } finally {
    await fx.close();
  }
});

test('?raw=1 serves an .svg inline as image/svg+xml (iframe renders it)', async () => {
  const fx = await startFixture();
  try {
    const dir = path.join(fx.projectsRoot, 'art2');
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, 'logo.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>\n',
    );
    const r = await fetch(fx.url + '/view/art2/logo.svg?raw=1');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/svg+xml');
    assert.equal(r.headers.get('content-disposition'), null, 'inline, not an attachment');
  } finally {
    await fx.close();
  }
});
