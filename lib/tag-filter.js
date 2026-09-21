/**
 * Landing-page tag filter (SPEC §V72).
 *
 * The landing page shows one chip per distinct badge across every card; the
 * user clicks one to keep only the cards that carry it. This module is the
 * pure part: which chips exist, in what order, and whether a card matches.
 *
 * Tags come from README frontmatter typed by hand across many projects, so
 * the same tag arrives in several spellings — `Game`/`game`, `3D`/`3d`,
 * `Tool`/`tool`. The badge CSS upper-cases them so the cards already read as
 * identical; a chip row that split them would look broken. Everything here
 * therefore keys on the lower-cased tag, and a chip shows the spelling the
 * first card used.
 *
 * `collectTags` is injected into landing.html by `.toString()` (like the
 * Browse helpers in lib/view-shell.js) so the browser runs the same code the
 * tests do. It MUST stay self-contained: no closures over module scope, no
 * `require` inside.
 */

// One chip per distinct tag, alphabetical by key, with a count of the cards
// carrying it. `cards` is any iterable of `{tags: string[]}`; a card that lists
// the same tag twice (or in two spellings) is counted once.
function collectTags(cards) {
  const byKey = new Map();
  for (const card of cards) {
    const tags = card && Array.isArray(card.tags) ? card.tags : [];
    const seen = new Set();
    for (const raw of tags) {
      if (typeof raw !== 'string') continue;
      const label = raw.trim();
      const key = label.toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const entry = byKey.get(key);
      if (entry) entry.count += 1;
      else byKey.set(key, { key, label, count: 1 });
    }
  }
  return Array.from(byKey.values()).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

// Does a card's tag list carry `key`? Same normalisation as collectTags, so a
// chip built from one card always matches the card it came from.
function hasTag(tags, key) {
  if (!Array.isArray(tags) || typeof key !== 'string') return false;
  const want = key.trim().toLowerCase();
  if (!want) return false;
  return tags.some((t) => typeof t === 'string' && t.trim().toLowerCase() === want);
}

module.exports = { collectTags, hasTag };
