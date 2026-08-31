const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFrontmatter, stripInlineMarkdown, readmeMetaFromContent } = require('../lib/readme-meta');

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

test('stripInlineMarkdown flattens emphasis, links, images and code', () => {
  assert.equal(stripInlineMarkdown('**Bold** and *em* and `code`'), 'Bold and em and code');
  assert.equal(stripInlineMarkdown('[foo](http://x) ![img](y.png)'), 'foo img');
});

test('readme meta: H1 title, first paragraph, frontmatter tags', () => {
  const r = readmeMetaFromContent(
    '---\ntags: [Game, WIP]\n---\n\n# World Forge\n\n**A 3D** world builder.\nSecond line.\n\nLater paragraph.\n'
  );
  assert.equal(r.title, 'World Forge');
  assert.equal(r.description, 'A 3D world builder. Second line.');
  assert.deepEqual(r.tags, ['Game', 'WIP']);
});

test('readme meta: description stops at the next heading', () => {
  const r = readmeMetaFromContent('# T\n\nOne line.\n## Next\n');
  assert.equal(r.description, 'One line.');
});

test('readme meta: no H1 → null title and null description', () => {
  const r = readmeMetaFromContent('just prose, no heading\n');
  assert.equal(r.title, null);
  assert.equal(r.description, null);
});

test('readme meta: missing file (null content) is not a throw', () => {
  assert.deepEqual(readmeMetaFromContent(null), { title: null, description: null, tags: [] });
});

test('readme meta: a scalar tags: value still yields a one-element list', () => {
  assert.deepEqual(readmeMetaFromContent('---\ntags: Tool\n---\n# T\n').tags, ['Tool']);
});

test('readme meta: description is capped at 400 chars', () => {
  const r = readmeMetaFromContent('# T\n\n' + 'x'.repeat(900) + '\n');
  assert.equal(r.description.length, 400);
});
