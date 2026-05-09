const test = require('node:test');
const assert = require('node:assert/strict');
const { pickDevelopOrientation } = require('../lib/orientation');

test('side-by-side when width clearly exceeds 1.2× height (landscape desktop)', () => {
  assert.equal(pickDevelopOrientation(1920, 1080), 'side');
  assert.equal(pickDevelopOrientation(2560, 1440), 'side');
  assert.equal(pickDevelopOrientation(1366, 768), 'side');
});

test('stacked when width ≤ 1.2× height (portrait phone, near-square tablet)', () => {
  assert.equal(pickDevelopOrientation(390, 844), 'stacked');     // iPhone portrait
  assert.equal(pickDevelopOrientation(820, 1180), 'stacked');    // iPad portrait
  assert.equal(pickDevelopOrientation(1024, 1024), 'stacked');   // square
});

test('threshold boundary: vw == 1.2 * vh → stacked (V38: side iff strict >)', () => {
  // "≤" lives on the stacked side per spec phrasing "width <= 1.2 * height"
  assert.equal(pickDevelopOrientation(1200, 1000), 'stacked');
});

test('one pixel above threshold flips to side', () => {
  assert.equal(pickDevelopOrientation(1201, 1000), 'side');
});
