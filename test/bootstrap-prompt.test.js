const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeBootstrapPrompt } = require('../lib/bootstrap-prompt');

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-prompt-'));
}

test('greenfield prompt asks "what should we build" (V31)', () => {
  const d = scratch();
  try {
    writeBootstrapPrompt(d, 'demo', 'greenfield');
    const txt = fs.readFileSync(path.join(d, '.claude-bootstrap.txt'), 'utf8');
    assert.match(txt, /what i want to build/i);
    assert.match(txt, /tags:/);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('scan-existing prompt instructs claude to scan tree + write missing docs (V30)', () => {
  const d = scratch();
  try {
    writeBootstrapPrompt(d, 'cloned-thing', 'scan-existing');
    const txt = fs.readFileSync(path.join(d, '.claude-bootstrap.txt'), 'utf8');
    assert.match(txt, /Walk the tree/);
    assert.match(txt, /AGENTS\.md/);
    assert.match(txt, /README\.md/);
    assert.match(txt, /never overwrite/i);
    assert.match(txt, /tech stack/i);
    assert.ok(txt.includes('cloned-thing'), 'project name should appear in prompt');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('greenfield prompt names the template stack so claude is oriented (V31)', () => {
  const d = scratch();
  try {
    writeBootstrapPrompt(d, 'demo', 'greenfield', { templateId: 'game-3d' });
    const txt = fs.readFileSync(path.join(d, '.claude-bootstrap.txt'), 'utf8');
    assert.match(txt, /react-three-fiber/);
    assert.match(txt, /rapier/);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('greenfield prompt mentions Firebase when overlaid (V31)', () => {
  const d = scratch();
  try {
    writeBootstrapPrompt(d, 'demo', 'greenfield', { templateId: 'game-2d', firebase: true });
    const txt = fs.readFileSync(path.join(d, '.claude-bootstrap.txt'), 'utf8');
    assert.match(txt, /Phaser/);
    assert.match(txt, /Firebase/);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('greenfield prompt has no stack line for template none / no opts', () => {
  const d = scratch();
  try {
    writeBootstrapPrompt(d, 'demo', 'greenfield');
    const txt = fs.readFileSync(path.join(d, '.claude-bootstrap.txt'), 'utf8');
    assert.doesNotMatch(txt, /This project is/);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// V73 — the prompt steers a new session to the hub's existing tags. The old
// wording ("short tags like Game, Tool, API, Library, Service plus WIP or
// Stable") grew a new chip per project.

test('V73: both flavors list the hub\'s tags and say to reuse before coining', () => {
  for (const flavor of ['greenfield', 'scan-existing']) {
    const d = scratch();
    try {
      writeBootstrapPrompt(d, 'demo', flavor, { hubTags: ['AI', 'Bible', 'Games'] });
      const txt = fs.readFileSync(path.join(d, '.claude-bootstrap.txt'), 'utf8');
      assert.match(txt, /already in use on this hub are: AI, Bible, Games/, flavor);
      assert.match(txt, /add a new tag only if none/i, flavor);
      assert.doesNotMatch(txt, /short tags like/, flavor);
      assert.doesNotMatch(txt, /'Tool', 'API'/, flavor);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  }
});

test('V73: an empty hub points at the chip row instead of inventing examples', () => {
  for (const hubTags of [undefined, [], ['', '  ', 42]]) {
    const d = scratch();
    try {
      writeBootstrapPrompt(d, 'demo', 'greenfield', { hubTags });
      const txt = fs.readFileSync(path.join(d, '.claude-bootstrap.txt'), 'utf8');
      assert.match(txt, /chip row lists the tags already in use/);
      assert.doesNotMatch(txt, /already in use on this hub are:/);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  }
});

test('V73: tags are categories — the prompt never suggests a status flag', () => {
  const d = scratch();
  try {
    writeBootstrapPrompt(d, 'demo', 'greenfield', { hubTags: ['Games'] });
    const txt = fs.readFileSync(path.join(d, '.claude-bootstrap.txt'), 'utf8');
    assert.match(txt, /no 'WIP' or 'Stable'/);
    assert.doesNotMatch(txt, /plus a status flag/);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('unknown flavor falls back to greenfield', () => {
  const d = scratch();
  try {
    writeBootstrapPrompt(d, 'demo', 'random-flavor');
    const txt = fs.readFileSync(path.join(d, '.claude-bootstrap.txt'), 'utf8');
    assert.match(txt, /what i want to build/i);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});
