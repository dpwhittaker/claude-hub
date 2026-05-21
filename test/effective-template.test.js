const test = require('node:test');
const assert = require('node:assert/strict');
const { effectiveTemplate, firebaseEnabled } = require('../lib/template-policy');

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

test('game template ids pass through on non-clone (V43)', () => {
  for (const t of ['game-2d', 'game-3d', 'game-3d-complex']) {
    assert.equal(effectiveTemplate({ template: t }), t);
    assert.equal(effectiveTemplate({ template: t, github: { mode: 'create' } }), t);
  }
});

test('clone/onboard force none even for a game template (V43)', () => {
  assert.equal(effectiveTemplate({ template: 'game-3d', github: { mode: 'clone' } }), 'none');
  assert.equal(effectiveTemplate({ template: 'game-2d', github: { mode: 'onboard' } }), 'none');
});

test('firebaseEnabled true only when scaffolding + flag set (V45)', () => {
  assert.equal(firebaseEnabled({ firebase: true }, 'game-3d'), true);
  assert.equal(firebaseEnabled({ firebase: true }, 'vite'), true);
  assert.equal(firebaseEnabled({ firebase: false }, 'game-3d'), false);
  assert.equal(firebaseEnabled({}, 'game-3d'), false);
});

test('firebaseEnabled forced false on none / clone / onboard (V45)', () => {
  assert.equal(firebaseEnabled({ firebase: true }, 'none'), false);
  assert.equal(firebaseEnabled({ firebase: true, github: { mode: 'clone' } }, 'none'), false);
  assert.equal(firebaseEnabled({ firebase: true, github: { mode: 'onboard' } }, 'none'), false);
});
