const test = require('node:test');
const assert = require('node:assert/strict');
const { effectiveTemplate } = require('../lib/template-policy');

test('default = vite when no template + no github', () => {
  assert.equal(effectiveTemplate({}), 'vite');
  assert.equal(effectiveTemplate({ github: { mode: 'skip' } }), 'vite');
});

test('explicit template none honored on non-clone', () => {
  assert.equal(effectiveTemplate({ template: 'none' }), 'none');
  assert.equal(effectiveTemplate({ template: 'none', github: { mode: 'create' } }), 'none');
});

test('clone forces template none even when body says vite (V29)', () => {
  assert.equal(effectiveTemplate({ template: 'vite', github: { mode: 'clone' } }), 'none');
  // Body without explicit template, but cloning, also resolves to none.
  assert.equal(effectiveTemplate({ github: { mode: 'clone' } }), 'none');
});

test('garbage template values fall back to vite default on non-clone', () => {
  assert.equal(effectiveTemplate({ template: 'garbage' }), 'vite');
});
