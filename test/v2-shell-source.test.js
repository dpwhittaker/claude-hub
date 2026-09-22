const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The v2 client has no DOM harness; these pin the shell decisions that a
// refactor could quietly undo (V89). They read the served sources.
const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'v2', f), 'utf8');

test('V89: Home is the one launcher — no new-tab buttons, home is deduped and never closable', () => {
  const app = read('app.js');
  const html = read('index.html');
  assert.doesNotMatch(html, /new-tab-btn/);
  assert.doesNotMatch(app, /tab-add/);
  assert.match(app, /DEDUPE_KEY = \{ home: \(\) => 'home'/);
  assert.match(app, /kind === 'home'\) return;/, 'closeTab refuses home');
  assert.match(app, /homes\.length === 0/, 'ensureNotEmpty restores a missing home tab');
  assert.match(app, /L\.addTab\(state\.layout, first\.id, id, 0\)/, 'restored home lands first in the top-left panel');
});

test('V89: the profile chip sits at the start of the top-left strip; the top bar exists only for narrow mode', () => {
  const app = read('app.js');
  const css = read('app.css');
  assert.match(app, /L\.panels\(state\.layout\)\[0\]\.id === p\.id\) strip\.append\(el\('span', \{ class: 'strip-chip' \}/);
  assert.match(css, /body:not\(\.narrow\) #topbar \{ display: none; \}/);
  // Active tab: accent on top, divider under the rest.
  assert.match(css, /\.tab\.active \{[^}]*inset 0 2px 0 var\(--accent\)/);
  assert.match(css, /\.tabstrip \{[^}]*inset 0 -1px 0 var\(--edge\)/);
});

test('V89: one SVG icon vocabulary — fork for repos, upload tray, >_ terminal; no open-folder-as-tab buttons', () => {
  const tabs = read('tabs.js');
  const home = read('tab-home.js');
  for (const name of ['folder', 'file', 'fork', 'terminal', 'upload', 'refresh', 'home']) {
    assert.match(tabs, new RegExp(`^\\s+${name}: '<`, 'm'), 'icon ' + name);
  }
  assert.match(home, /Hub\.icon\(e\.repo \? 'fork' : 'folder'\)/, 'repo folders wear the fork');
  assert.doesNotMatch(home, /'project'\)/, 'no PROJECT badge');
  assert.doesNotMatch(home, /Open (this folder )?as (its own )?tab/);
  assert.match(home, /Hub\.iconPlus\('fork'\)/, '+repo is fork + plus');
  assert.match(home, /Hub\.iconPlus\('terminal'\)/, 'new terminal is >_ + plus');
  assert.match(home, /liveHere\(e\.path\)/, 'folders with a running session are marked live');
  assert.match(home, /Already open in this folder/, 'terminal dialog lists what already runs here');
});

test('V94: the page syncs session titles at load and reloads itself when the client files change', () => {
  const app = read('app.js');
  assert.match(app, /sync\(\);\n\s+setInterval\(sync, 20000\)/, 'immediate sync then a 20 s poll');
  assert.match(app, /visibilitychange/, 'resync when the page comes back');
  assert.match(app, /api\('\/api\/v2\/version'\)/);
  assert.match(app, /some\(\(m\) => m\.dirty\)\) \{ toast\('hub updated/, 'never reloads over unsaved edits');
  assert.match(app, /await flush\(\);\n\s+location\.reload\(\)/, 'saves the layout before reloading');
});

test('B29: session titles are live per page, never written into the shared profile', () => {
  const app = read('app.js');
  const home = read('tab-home.js');
  assert.match(home, /Hub\.updateTab\(id, \{ title: s\.title \|\| null \}, \{ persist: false \}\)/);
  assert.match(app, /if \(rest\.kind === 'term'\) rest\.title = null;/, 'flush strips term titles');
  assert.match(app, /renderAll\(\);\n\s+\/\/ Whatever titles[\s\S]*?Hub\.loadSessions\(\)\.catch/, 'a profile (re)load resyncs titles at once');
});
