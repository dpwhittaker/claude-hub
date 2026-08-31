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
    assert.match(html, /<iframe id="pane-view"/, 'Browse pane');
    assert.match(html, /id="pane-term"/, 'Develop pane');
    assert.match(html, /<button id="fab"/, 'view-cycling FAB');
    // Installable: the manifest + service worker are the PWA half of this.
    assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
    assert.match(html, /serviceWorker/);
  } finally {
    await fx.close();
  }
});

// The FAB's single-pane rotation. VIEW is the third state: without it the
// Browse shell is unreachable on a phone, where the split's right half — its
// only other home — never appears. SPLIT is deliberately absent: it is a mode
// the long-press menu owns, and while split a tap swaps the right half only.
test('the FAB rotation is TERM > OPEN > VIEW, and never includes SPLIT', () => {
  const html = renderShellHtml('demo', '/demo/', '/term/demo__s1/', 'open');
  assert.match(html, /const CYCLE = \['term', 'open', 'view'\]/);
  assert.match(html, /if \(cur === 'split'\) return otherRight\(rightView\)/);
  // Each state still needs a pane and a FAB label to land on.
  for (const v of ['term', 'open', 'view', 'split']) {
    assert.match(html, new RegExp(v + ": '" + v.toUpperCase() + "'"), v + ' label');
  }
});

// An installed PWA has no browser chrome, so the terminal strip is the only
// route back to the hub — and it has to sit ahead of the tabs, which scroll.
test('a home link opens the tabstrip, ahead of the tabs and the + button', () => {
  const html = renderShellHtml('demo', '/demo/', '/term/demo__s1/', 'open');
  assert.match(
    html,
    /<div class="term-tabs" id="term-tabs">\s*<a class="term-home" href="\/"/,
    'home link is the tabstrip\'s first child',
  );
  assert.match(html, /aria-label="claude-hub home"/);
});

// Long-press stopped being a bare refresh: it opens a menu carrying that
// refresh plus the split toggle, over a scrim (every pane is an iframe, so an
// outside tap would otherwise never reach the shell document).
test('long-press menu offers refresh + a checkable split toggle', () => {
  const html = renderShellHtml('demo', '/demo/', '/term/demo__s1/', 'open');
  assert.match(html, /<div id="fab-scrim" hidden>/);
  assert.match(html, /<div id="fab-menu" role="menu"/);
  assert.match(html, /id="fab-refresh" role="menuitem"/);
  assert.match(html, /id="fab-split" role="menuitemcheckbox" aria-checked="false"/);
});

// Split is a per-device, per-project preference that beats the media query in
// both directions — a phone can be forced into split, a landscape tablet out.
test('the split preference is stored per project, not globally', () => {
  const a = renderShellHtml('alpha', '/a/', '/term/alpha__s1/', 'open');
  const b = renderShellHtml('beta', '/b/', '/term/beta__s1/', 'open');
  assert.match(a, /'claude-hub:split:' \+ cfg\.name/);
  assert.match(a, /"name":"alpha"/);
  assert.match(b, /"name":"beta"/);
  // The media query is consulted only when the stored preference is unset.
  assert.match(a, /splitPref === null \? splitMq\.matches : splitPref/);
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

test('?view= picks the starting pane, default starts on Open', async () => {
  const fx = await startFixture();
  try {
    mkProject(fx.projectsRoot, 'demo', { createdAt: '2026-01-01T00:00:00Z' });
    assert.match(await (await fetch(fx.url + '/p/demo/?view=term')).text(), /"initial":"term"/);
    // view is a bookmarkable start now that the FAB cycle reaches Browse.
    assert.match(await (await fetch(fx.url + '/p/demo/?view=view')).text(), /"initial":"view"/);
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
