const test = require('node:test');
const assert = require('node:assert/strict');
const { installTouchSelect } = require('../lib/touch-select');
const { installTouchWheel } = require('../lib/touch-wheel');

// A 20x4 terminal drawn 10px per cell from the page origin, showing `lines`
// (buffer rows, viewport at the top). The stub records what gets selected
// and copied.
function makeDoc(lines = ['alpha bravo', 'charlie', '', '']) {
  const handlers = {};
  const copied = [];
  const body = { children: [], appendChild(el) { this.children.push(el); } };
  let selection = null;
  const term = {
    cols: 20, rows: 4,
    buffer: { active: {
      viewportY: 0,
      getLine: (row) => ({ getCell: (col) => ({ getChars: () => (lines[row] || '')[col] || '', getWidth: () => 1 }) }),
    } },
    select(col, row, length) { selection = { col, row, length }; },
    hasSelection: () => !!selection,
    clearSelection() { selection = null; },
    getSelection() {
      if (!selection) return '';
      const flat = lines.map((l) => l.padEnd(20)).join('');
      const start = selection.row * 20 + selection.col;
      return flat.slice(start, start + selection.length).match(/.{1,20}/g).map((l) => l.trimEnd()).join('\n');
    },
    scrollLines() {},
  };
  const view = { term, navigator: { clipboard: { writeText: async (t) => { copied.push(t); } } } };
  const doc = {
    defaultView: view,
    body,
    createElement: () => ({ style: {}, remove() {} }),
    addEventListener(type, h) { (handlers[type] ||= []).push(h); },
    querySelector: (sel) => (sel === '.xterm-screen' ? { getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 40 }) } : null),
  };
  const fire = (type, e = {}) => {
    let prevented = false;
    const ev = { preventDefault() { prevented = true; }, stopPropagation() {}, ...e };
    for (const h of handlers[type] || []) h(ev);
    return prevented;
  };
  const at = (col, row) => ({ touches: [{ clientX: col * 10 + 5, clientY: row * 10 + 5 }] });
  return { doc, fire, at, term, copied, sel: () => selection };
}

test('V103: holding still selects the word under the finger; lifting copies it without a click', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { doc, fire, at, copied, sel } = makeDoc();
  installTouchSelect(doc);
  fire('touchstart', at(8, 0));            // inside "bravo"
  t.mock.timers.tick(449);
  assert.equal(sel(), null, 'nothing before the hold time');
  t.mock.timers.tick(1);
  assert.deepEqual(sel(), { col: 6, row: 0, length: 5 });
  assert.equal(doc.__touchSelecting, true);
  assert.equal(fire('touchend'), true, 'touchend default prevented: no synthesized click');
  await Promise.resolve();
  assert.deepEqual(copied, ['bravo']);
  assert.equal(doc.__touchSelecting, false);
  assert.equal(fire('contextmenu'), true, 'the long-press menu is swallowed');
  t.mock.timers.tick(1000);
  assert.equal(fire('mousedown'), false, 'later mouse events pass through');
});

test('V103: moving before the hold time is a scroll, not a selection', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { doc, fire, at, sel } = makeDoc();
  installTouchSelect(doc);
  fire('touchstart', at(8, 0));
  fire('touchmove', { touches: [{ clientX: 85, clientY: 25 }] });   // 20px away
  t.mock.timers.tick(1000);
  assert.equal(sel(), null);
  assert.equal(fire('touchend'), false);
});

test('V103: dragging extends from the anchor word, forwards across rows and backwards', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { doc, fire, at, copied } = makeDoc();
  installTouchSelect(doc);
  fire('touchstart', at(1, 0)); t.mock.timers.tick(450);               // "alpha"
  assert.equal(fire('touchmove', at(3, 1)), true, 'the drag is ours, not a scroll');
  fire('touchend'); await Promise.resolve();
  fire('touchstart', at(9, 0)); t.mock.timers.tick(450);               // "bravo"
  fire('touchmove', at(2, 0));
  fire('touchend'); await Promise.resolve();
  assert.deepEqual(copied, ['alpha bravo\nchar', 'pha bravo']);
});

test('V103: a tap clears the selection; touch-wheel stands down while selecting', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { doc, fire, at, term, sel } = makeDoc();
  const wheels = [];
  doc.defaultView.WheelEvent = function (type, init) { wheels.push(init.deltaY); };
  installTouchWheel(doc);
  installTouchSelect(doc);
  fire('touchstart', at(8, 0)); t.mock.timers.tick(450);
  fire('touchmove', at(8, 3));
  assert.deepEqual(wheels, [], 'no scroll while a selection owns the drag');
  fire('touchend');
  fire('touchstart', at(1, 2)); fire('touchend');
  assert.equal(sel(), null);
  assert.equal(term.hasSelection(), false);
});
