const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseFrontmatter } = require('../lib/readme-meta');

// SPEC §V73 — the tag vocabulary stays small because every onboarding doc
// tells the agent to reuse a tag already on the hub, and nothing the hub
// scaffolds seeds a status flag. Twenty projects had grown twenty chips
// before this; the leak was the docs, so the docs are what is pinned.

const ROOT = path.join(__dirname, '..');
const TEMPLATES = path.join(ROOT, 'templates');
const templateIds = fs.readdirSync(TEMPLATES, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
  .map((e) => e.name);

const STATUS_TAG = /^(wip|stable|todo|done)$/i;

test('V73: every template README seeds a category tag or none — never a status flag', () => {
  assert.ok(templateIds.length >= 6, 'expected the six templates');
  for (const id of templateIds) {
    const file = path.join(TEMPLATES, id, 'README.md.template');
    const { meta } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    const tags = Array.isArray(meta.tags) ? meta.tags : [];
    for (const t of tags) {
      assert.doesNotMatch(String(t), STATUS_TAG, `${id}: seeds status tag "${t}"`);
      assert.doesNotMatch(String(t), /^(game|3d|2d|pwa|site|tool)$/i,
        `${id}: seeds the pre-V73 tag "${t}"`);
    }
  }
});

test('V73: the bare-project README template seeds no tags at all', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const m = src.match(/function readmeTemplate\(name\) \{\n {2}return `---\ntags: \[([^\]]*)\]/);
  assert.ok(m, 'readmeTemplate frontmatter not found');
  assert.equal(m[1].trim(), '', `bare README seeds tags: [${m[1]}]`);
});

test('V73: every scaffolded AGENTS.md tells the agent to reuse a tag already on the hub', () => {
  const needle = /already on the hub/;
  for (const id of templateIds) {
    const file = path.join(TEMPLATES, id, 'AGENTS.md.template');
    const txt = fs.readFileSync(file, 'utf8');
    assert.match(txt, needle, `${id}/AGENTS.md.template`);
    assert.doesNotMatch(txt, /short tags like/, `${id}/AGENTS.md.template still lists example tags`);
  }
  // The bare path's AGENTS.md is an inline template in server.js.
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const agents = src.slice(src.indexOf('function agentsTemplate('), src.indexOf('function readmeTemplate('));
  assert.match(agents, needle, 'server.js agentsTemplate()');
  assert.doesNotMatch(agents, /short tags like/, 'server.js agentsTemplate() still lists example tags');
});

test('V73: every bootstrap-prompt call site hands over the hub\'s current tags', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const calls = src.match(/writeBootstrapPrompt\([^;]*\);|bootstrapOnboard\(dir, name[^;]*\);/g) || [];
  assert.ok(calls.length >= 5, `expected 5 call sites, found ${calls.length}`);
  for (const call of calls) {
    assert.match(call, /hubTags: currentHubTags\(\)/, call);
  }
});
