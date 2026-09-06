const test = require('node:test');
const assert = require('node:assert/strict');
const { makeSplitLayout } = require('../lib/split-layout');

// The PWA shell's split verdict (V58) used to be a live
// `(min-width: 900px) and (orientation: landscape)` media query. Under the
// shell's interactive-widget=resizes-content, Android's soft keyboard shrinks
// the layout viewport, and on a portrait tablet 900px+ wide that made
// `orientation` read landscape every time the keyboard opened — the shell
// entered split, then dropped to Browse (not the terminal being typed in)
// when it closed (B22). The judge keeps the rule but measures orientation
// against the tallest height each width has been seen at.

// Galaxy-Tab-class portrait viewport: 924 wide, keyboard takes ~45%.
const PORTRAIT = [924, 1480];
const PORTRAIT_KB = [924, 820];
const LANDSCAPE = [1480, 924];
const LANDSCAPE_KB = [1480, 420];

test('B22: the keyboard opening on a portrait tablet does not become landscape', () => {
  const judge = makeSplitLayout(900);
  assert.equal(judge(...PORTRAIT), false, 'portrait, keyboard down');
  assert.equal(judge(...PORTRAIT_KB), false, 'portrait, keyboard up — the bug');
  assert.equal(judge(...PORTRAIT), false, 'portrait, keyboard down again');
});

test('a real rotation still crosses the boundary both ways', () => {
  const judge = makeSplitLayout(900);
  assert.equal(judge(...PORTRAIT), false);
  assert.equal(judge(...LANDSCAPE), true, 'rotated into split');
  assert.equal(judge(...LANDSCAPE_KB), true, 'keyboard in landscape stays split');
  assert.equal(judge(...LANDSCAPE), true);
  assert.equal(judge(...PORTRAIT), false, 'rotated back out');
});

test('rotating back to portrait with the keyboard up remembers the portrait height', () => {
  const judge = makeSplitLayout(900);
  judge(...PORTRAIT);
  judge(...LANDSCAPE);
  judge(...LANDSCAPE_KB);
  assert.equal(judge(...PORTRAIT_KB), false, 'portrait was seen keyboard-free once, that wins');
  assert.equal(judge(...PORTRAIT), false);
});

test('a width first seen with the keyboard up self-corrects when it closes', () => {
  // Loaded in landscape, rotated to portrait while typing: portrait's first
  // height is the keyboard-shrunk one, so the verdict is briefly landscape —
  // and the keyboard closing replaces the memory.
  const judge = makeSplitLayout(900);
  assert.equal(judge(...LANDSCAPE), true);
  assert.equal(judge(...LANDSCAPE_KB), true);
  assert.equal(judge(...PORTRAIT_KB), true, 'documented: wrong until the keyboard closes');
  assert.equal(judge(...PORTRAIT), false, 'keyboard down ⇒ right');
  assert.equal(judge(...PORTRAIT_KB), false, 'and stays right on the next keyboard');
});

test('the width half of the rule is unchanged: a landscape phone never splits', () => {
  const judge = makeSplitLayout(900);
  assert.equal(judge(855, 384), false, 'landscape but < 900 wide');
  assert.equal(judge(899, 400), false);
  assert.equal(judge(900, 400), true, 'min-width is inclusive, like the media query');
});

test('orientation is strict: a square viewport is portrait, like the media query', () => {
  // Fresh judges: at one width, a shorter height would read as a keyboard.
  assert.equal(makeSplitLayout(900)(1000, 1000), false);
  assert.equal(makeSplitLayout(900)(1000, 999), true);
});

test('desktop: a corner drag tracks the live aspect; a height-only shrink keeps the old verdict', () => {
  const judge = makeSplitLayout(900);
  assert.equal(judge(1400, 900), true);
  assert.equal(judge(1000, 1200), false, 'corner drag: new width, judged live');
  assert.equal(judge(1000, 700), false, 'documented corner: height-only shrink reads as a keyboard');
  assert.equal(judge(1001, 700), true, 'the next width change re-judges');
  assert.equal(judge(1001, 1200), false, 'growing taller is always trusted');
});

// V42: the judge is inlined into the shell with .toString(), so its source has
// to work with no module scope around it.
test('makeSplitLayout survives a .toString() round-trip (V42)', () => {
  const src = makeSplitLayout.toString();
  assert.ok(!/require\(/.test(src), 'no require inside');
  const judge = new Function('return (' + src + ')(900);')();
  assert.equal(judge(...PORTRAIT), false);
  assert.equal(judge(...PORTRAIT_KB), false);
  assert.equal(judge(...LANDSCAPE), true);
});
