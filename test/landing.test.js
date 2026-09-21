const test = require('node:test');
const assert = require('node:assert/strict');
const { startFixture } = require('./helpers/fixture');

// SPEC §V72 — the served landing page carries the tag-filter helpers.
//
// landing.html is read from disk per request but is no longer byte-static:
// `serveLanding` splices lib/tag-filter.js's functions in at a marker so the
// browser groups chips exactly the way test/tag-filter.test.js pins it. A
// page that still shows the bare marker has no `collectTags` and the chip
// row silently never renders.

test('V72: GET / serves landing.html with the tag-filter helpers spliced in', async () => {
  const fx = await startFixture();
  try {
    const r = await fetch(`${fx.url}/`);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /id="tagbar"/, 'chip row container missing');
    assert.match(html, /function collectTags\(/, 'collectTags not injected');
    assert.match(html, /function hasTag\(/, 'hasTag not injected');
    assert.doesNotMatch(html, /@inject lib\/tag-filter\.js/,
      'the inject marker must be replaced, not served to the browser');
    // Every hardcoded card must be filterable, or a click on any chip
    // leaves it standing among cards that were meant to be the only ones.
    const hardcoded = html.match(/<div class="card"[^>]*>/g) || [];
    assert.ok(hardcoded.length >= 2, 'expected the Develop + claude-hub cards');
    for (const open of hardcoded) {
      assert.match(open, /data-tags=/, `hardcoded card lacks data-tags: ${open}`);
    }
  } finally {
    await fx.close();
  }
});
