const test = require('node:test');
const assert = require('node:assert/strict');
const { isEmbedder, tabsToReload } = require('../lib/tab-reload-targets');

function makeTabs(infos) {
  const m = new Map();
  for (const i of infos) m.set(i.key || i.path + ':' + (i.mode || 'view'), i);
  return m;
}

test('isEmbedder true for md / markdown / html / htm', () => {
  assert.equal(isEmbedder('README.md'), true);
  assert.equal(isEmbedder('docs/notes.markdown'), true);
  assert.equal(isEmbedder('index.html'), true);
  assert.equal(isEmbedder('legacy.htm'), true);
});

test('isEmbedder false for code / image / unknown', () => {
  assert.equal(isEmbedder('src/main.js'), false);
  assert.equal(isEmbedder('docs/img/foo.png'), false);
  assert.equal(isEmbedder('LICENSE'), false);
  assert.equal(isEmbedder(''), false);
  assert.equal(isEmbedder(null), false);
});

test('isEmbedder case-insensitive', () => {
  assert.equal(isEmbedder('A.MD'), true);
  assert.equal(isEmbedder('B.HTML'), true);
});

// V41: tab reload on WS change must include embedder tabs (.md/.html), not
// only tabs whose path equals the changed path. README.md embedding an image
// must re-fetch when the image changes.
test('V41: image change reloads README.md tab', () => {
  const readme = { path: 'README.md', mode: 'view' };
  const py = { path: 'src/foo.py', mode: 'view' };
  const tabs = makeTabs([readme, py]);
  const reload = tabsToReload(tabs, 'docs/img/screenshot.png');
  assert.deepEqual(reload, [readme]);
});

test('V41: js change reloads rendered index.html tab', () => {
  const html = { path: 'public/index.html', mode: 'render' };
  const tabs = makeTabs([html]);
  const reload = tabsToReload(tabs, 'public/app.js');
  assert.deepEqual(reload, [html]);
});

test('V41: direct path match still reloads non-embedder tab', () => {
  const py = { path: 'src/foo.py', mode: 'view' };
  const tabs = makeTabs([py]);
  const reload = tabsToReload(tabs, 'src/foo.py');
  assert.deepEqual(reload, [py]);
});

test('V41: unrelated change to non-embedder tab → no reload', () => {
  const py = { path: 'src/foo.py', mode: 'view' };
  const tabs = makeTabs([py]);
  const reload = tabsToReload(tabs, 'src/bar.py');
  assert.deepEqual(reload, []);
});

test('V41: empty tabs → empty result', () => {
  assert.deepEqual(tabsToReload(new Map(), 'anything'), []);
});

// Server inlines isEmbedder + tabsToReload into the client via `.toString()`
// — closure references (e.g. a hoisted EMBED_EXT const) would become
// ReferenceError on the client. Round-trip the source through Function() to
// catch any future closure leak.
test('V41: isEmbedder + tabsToReload survive .toString() round-trip (no closure refs)', () => {
  const src = isEmbedder.toString() + '\n' + tabsToReload.toString() + '\nreturn { isEmbedder, tabsToReload };';
  const reconstructed = new Function(src)();
  assert.equal(reconstructed.isEmbedder('README.md'), true);
  assert.equal(reconstructed.isEmbedder('foo.png'), false);
  const tabs = new Map([
    ['k1', { path: 'README.md', mode: 'view' }],
    ['k2', { path: 'foo.png', mode: 'view' }],
  ]);
  const out = reconstructed.tabsToReload(tabs, 'foo.png');
  assert.equal(out.length, 2);
});

test('V41: multiple embedder tabs all reload on any change', () => {
  const a = { path: 'A.md', mode: 'view' };
  const b = { path: 'B.html', mode: 'render' };
  const tabs = makeTabs([a, b]);
  const reload = tabsToReload(tabs, 'asset.png');
  assert.equal(reload.length, 2);
  assert.ok(reload.includes(a));
  assert.ok(reload.includes(b));
});
