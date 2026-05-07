const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { replaceVars, copyTemplate } = require('../lib/template');

test('replaceVars substitutes known KEYs, leaves unknown intact', () => {
  assert.equal(replaceVars('<NAME> on port <PORT>', { NAME: 'foo', PORT: '5173' }), 'foo on port 5173');
  assert.equal(replaceVars('keep <UNKNOWN> alone', { NAME: 'x' }), 'keep <UNKNOWN> alone');
});

test('replaceVars does not mangle JSX-ish PascalCase tags or HTML element types', () => {
  assert.equal(replaceVars('<Component prop>', {}), '<Component prop>');
  assert.equal(replaceVars('Map<HTMLElement, number>', {}), 'Map<HTMLElement, number>');
});

test('copyTemplate replaces placeholders in contents AND filenames, strips .template', () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-src-'));
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-dst-'));
  try {
    fs.writeFileSync(path.join(src, 'hello-<NAME>.txt'), 'project=<NAME>, port=<PORT>');
    fs.mkdirSync(path.join(src, 'sub'));
    fs.writeFileSync(path.join(src, 'sub', 'README.md.template'), '# <NAME>\n');
    copyTemplate(src, dest, { NAME: 'demo', PORT: '5200' });
    assert.equal(fs.readFileSync(path.join(dest, 'hello-demo.txt'), 'utf8'), 'project=demo, port=5200');
    assert.equal(fs.readFileSync(path.join(dest, 'sub', 'README.md'), 'utf8'), '# demo\n');
    assert.equal(fs.existsSync(path.join(dest, 'sub', 'README.md.template')), false,
      '.template suffix should be stripped on output');
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
  }
});
