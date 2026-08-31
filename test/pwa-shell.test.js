const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startFixture } = require('./helpers/fixture');
const { renderShellHtml } = require('../lib/pwa-shell');

// The per-project PWA shell (GET /p/<project>/) is what a phone or tablet
// installs. It had no coverage until lib/pwa-shell.js was split out of
// server.js — these pin the contract the split has to preserve.

function mkProject(root, name, meta) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.project-meta.json'), JSON.stringify({ name, ...meta }));
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n\nDesc.\n`);
  return dir;
}

test('/p/<project>/ serves the shell with all three panes wired', async () => {
  const fx = await startFixture();
  try {
    mkProject(fx.projectsRoot, 'demo', { createdAt: '2026-01-01T00:00:00Z' });
    const r = await fetch(fx.url + '/p/demo/');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    const html = await r.text();

    assert.match(html, /<iframe id="pane-open"/, 'Open pane');
    assert.match(html, /id="pane-term"/, 'Develop pane');
    assert.match(html, /<button id="fab"/, 'view-cycling FAB');
    // Installable: the manifest + service worker are the PWA half of this.
    assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
    assert.match(html, /serviceWorker/);
  } finally {
    await fx.close();
  }
});

test('shell data block carries the project\'s own URLs, not defaults', async () => {
  const fx = await startFixture();
  try {
    // A project with a live app overrides openUrl; the shell must follow it
    // rather than falling back to the rendered README.
    mkProject(fx.projectsRoot, 'app', { createdAt: '2026-01-01T00:00:00Z', openUrl: '/app/' });
    const html = await (await fetch(fx.url + '/p/app/')).text();
    assert.match(html, /"openUrl":"\/app\/"/);
    assert.match(html, /"browseUrl":"\/view\/app\/"/);
    assert.match(html, /"termUrl":"\/term\/app[^"]*\/"/);
  } finally {
    await fx.close();
  }
});

test('?view=term starts on the terminal, default starts on Open', async () => {
  const fx = await startFixture();
  try {
    mkProject(fx.projectsRoot, 'demo', { createdAt: '2026-01-01T00:00:00Z' });
    assert.match(await (await fetch(fx.url + '/p/demo/?view=term')).text(), /"initial":"term"/);
    assert.match(await (await fetch(fx.url + '/p/demo/')).text(), /"initial":"open"/);
    // Anything unrecognised falls back to Open rather than erroring.
    assert.match(await (await fetch(fx.url + '/p/demo/?view=bogus')).text(), /"initial":"open"/);
  } finally {
    await fx.close();
  }
});

test('/p/<unknown>/ is a 404, not an empty shell', async () => {
  const fx = await startFixture();
  try {
    assert.equal((await fetch(fx.url + '/p/nope/')).status, 404);
  } finally {
    await fx.close();
  }
});

test('project name is HTML-escaped into the title', () => {
  // Names are validated upstream, but the shell must not be the thing that
  // would leak markup if that ever changed.
  const html = renderShellHtml('<script>x</script>', '/o/', '/t/', 'open');
  assert.ok(!html.includes('<title><script>'), 'raw tag must not reach the title');
  assert.match(html, /&lt;script&gt;/);
});
