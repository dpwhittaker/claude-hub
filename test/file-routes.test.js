// §V54 — file→URL route resolver. Drives Browse preview icons + the render
// iframe target. Must express both a real Jekyll site (genesis) and a
// .nojekyll SPA (systematic-theology) from declarative `routes` rules.
const test = require('node:test');
const assert = require('node:assert/strict');
const { matchGlob, routeForPath } = require('../lib/file-routes');

// Plain-Jekyll rules (default page permalinks): README→/, index.md→dir URL,
// other .md→literal .html. Mirrors templates/jekyll + genesis.
const JEKYLL = [
  { match: 'README.md', to: '/' },
  { match: '**/index.md', to: '/:dir/' },
  { match: '**/*.md', to: '/:dir/:name.html' },
];

// systematic-theology SPA rules: hash-fragment routes resolved by js/app.js.
const SPA = [
  { match: 'handouts/**/*.md', to: '/#:path' },
  { match: 'storyboards/**/*.md', to: '/#:path' },
  { match: 'data/**/*.md', to: '/#:splat/:name' },
];

test('jekyll: README → /', () => {
  assert.equal(routeForPath(JEKYLL, 'README.md'), '/');
});

test('jekyll: index.md → pretty dir URL with trailing slash', () => {
  assert.equal(routeForPath(JEKYLL, 'sessions/01-the-neighbors-stories/index.md'),
    '/sessions/01-the-neighbors-stories/');
});

test('jekyll: non-index .md → literal .html under its dir', () => {
  assert.equal(routeForPath(JEKYLL, 'sessions/01-the-neighbors-stories/texts/atrahasis.md'),
    '/sessions/01-the-neighbors-stories/texts/atrahasis.html');
});

test('jekyll: root-level non-index .md → /name.html (no double slash)', () => {
  assert.equal(routeForPath(JEKYLL, 'about.md'), '/about.html');
});

test('jekyll: leading-underscore file is never routed (Jekyll skips it)', () => {
  assert.equal(routeForPath(JEKYLL, 'sessions/01-the-neighbors-stories/texts/_atrahasis-akkadian-source.md'), null);
});

test('jekyll: dot/underscore dirs never routed', () => {
  assert.equal(routeForPath(JEKYLL, '_includes/footer.md'), null);
  assert.equal(routeForPath(JEKYLL, '.claude/skills/x.md'), null);
});

test('spa: data nested → #section/article', () => {
  assert.equal(routeForPath(SPA, 'data/god/trinity.md'), '/#god/trinity');
});

test('spa: data top-level → #name (empty splat collapses cleanly)', () => {
  assert.equal(routeForPath(SPA, 'data/TOC.md'), '/#TOC');
});

test('spa: handouts/storyboards keep full path incl .md', () => {
  assert.equal(routeForPath(SPA, 'handouts/index.md'), '/#handouts/index.md');
  assert.equal(routeForPath(SPA, 'storyboards/baptism/player.md'), '/#storyboards/baptism/player.md');
});

test('no rule match → null', () => {
  assert.equal(routeForPath(JEKYLL, 'assets/main.scss'), null);
  assert.equal(routeForPath(SPA, 'css/style.css'), null);
});

test('first matching rule wins (order matters)', () => {
  // index.md must hit the index rule, not the generic **/*.md after it.
  assert.equal(routeForPath(JEKYLL, 'a/b/index.md'), '/a/b/');
});

test('matchGlob: ** spans zero or many segments; * is one segment', () => {
  assert.deepEqual(matchGlob('data/**/*.md', 'data/TOC.md'), { splat: '' });
  assert.deepEqual(matchGlob('data/**/*.md', 'data/god/trinity.md'), { splat: 'god' });
  assert.deepEqual(matchGlob('data/**/*.md', 'data/a/b/c.md'), { splat: 'a/b' });
  assert.equal(matchGlob('*/x.md', 'a/b/x.md'), null, '* must not cross a slash');
});

test('bad inputs are safe', () => {
  assert.equal(routeForPath(null, 'a.md'), null);
  assert.equal(routeForPath(JEKYLL, ''), null);
  assert.equal(routeForPath([{ match: 5, to: '/' }], 'a.md'), null);
});

// V42-style self-containment: both functions must survive `.toString()` inline
// (the Browse client gets them that way), so reconstruct via new Function and
// re-run. routeForPath calls matchGlob, so inline both together.
test('routeForPath + matchGlob round-trip through Function reconstruction', () => {
  const src = matchGlob.toString() + '\n' + routeForPath.toString()
    + '\nreturn routeForPath(arguments[0], arguments[1]);';
  const fn = new Function(src);
  assert.equal(fn(JEKYLL, 'sessions/x/index.md'), '/sessions/x/');
  assert.equal(fn(SPA, 'data/god/trinity.md'), '/#god/trinity');
  assert.equal(fn(JEKYLL, '_x/y.md'), null);
});
