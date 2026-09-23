const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFrontmatter } = require('../lib/readme-meta');

test('frontmatter: flat keys and inline lists', () => {
  const { meta, body } = parseFrontmatter('---\ntags: [Hub, Tool, Stable]\ntitle: "A B"\n---\n# H\n');
  assert.deepEqual(meta.tags, ['Hub', 'Tool', 'Stable']);
  assert.equal(meta.title, 'A B');
  assert.equal(body, '# H\n');
});

test('frontmatter: absent or unterminated leaves the body untouched', () => {
  assert.deepEqual(parseFrontmatter('# H\n'), { meta: {}, body: '# H\n' });
  assert.deepEqual(parseFrontmatter('---\ntags: [a]\n'), { meta: {}, body: '---\ntags: [a]\n' });
});
