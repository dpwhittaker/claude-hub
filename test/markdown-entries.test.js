const test = require('node:test');
const assert = require('node:assert/strict');
const { renderMarkdownPage, entryLinesAsItems } = require('../lib/v2-routes');

const NOTEBOOK = [
  '# Church', '', 'Summary line.', '', '## 2026-10-04',
  '◆ 10:49 David · Out of D&D today <!-- n:4 --> (from 2026-10-04)',
  '- 16:15 · D&D · Class roll note',
  '‼ 12:34 Dylan · Cancelled',
  '○ 10-04 12:34 Weston · Out a month',
  '', '```', '◆ in code', '```', '',
].join('\n');

test("Cue's ‼ ◆ ○ entry lines render one per line, each icon as its bullet", () => {
  const html = renderMarkdownPage(null, 'orgs/church/notebook.md', NOTEBOOK);
  const items = [...html.matchAll(/<li[^>]*>(.*?)<\/li>/g)].map((m) => m[0]);
  assert.deepEqual(items, [
    '<li class="entry"><span class="icon" title="to do">◆</span>10:49 David · Out of D&amp;D today <!-- n:4 --> (from 2026-10-04)</li>',
    '<li>16:15 · D&amp;D · Class roll note</li>',
    '<li class="entry"><span class="icon" title="urgent">‼</span>12:34 Dylan · Cancelled</li>',
    '<li class="entry"><span class="icon" title="status">○</span>10-04 12:34 Weston · Out a month</li>',
  ]);
  assert.match(html, /<pre><code>◆ in code\n<\/code><\/pre>/, 'fenced code is left alone');
});

test('only a line led by an icon and a space becomes an item', () => {
  assert.equal(entryLinesAsItems('◆ a\n◆b\n  ◆ c\n~~~\n○ d\n~~~'), '- ◆ a\n◆b\n  ◆ c\n~~~\n○ d\n~~~');
});
