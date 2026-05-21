const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { replaceVars, copyTemplate } = require('../lib/template');

const REPO_TEMPLATES = path.join(__dirname, '..', 'templates');

// Scaffold a real shipped template into a temp dir and assert placeholders
// resolved + no .template suffixes leak through. SPEC §V43, §V44.
function scaffold(templateId, vars) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-' + templateId + '-'));
  copyTemplate(path.join(REPO_TEMPLATES, templateId), dest, vars);
  return dest;
}

for (const id of ['game-2d', 'game-3d', 'game-3d-complex']) {
  test(`template ${id} scaffolds with placeholders resolved (V43)`, () => {
    const dest = scaffold(id, { NAME: 'demo', PORT: '5300' });
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dest, 'package.json'), 'utf8'));
      assert.equal(pkg.name, 'demo', 'package.json name placeholder replaced');
      assert.ok(pkg.scripts['build:pages'].includes('--base=/demo/'), 'build:pages base baked (V46)');
      assert.ok(pkg.scripts['build:firebase'].includes('--base=/'), 'build:firebase base baked (V46)');

      const viteCfg = fs.readFileSync(path.join(dest, 'vite.config.ts'), 'utf8');
      assert.ok(viteCfg.includes("base: '/demo/'"), 'vite base = proxy prefix (V20)');
      assert.ok(viteCfg.includes('port: 5300'), 'vite port placeholder replaced');
      assert.equal(/<PORT>|<NAME>/.test(viteCfg), false, 'no unresolved placeholders');

      // No *.template files survive into the scaffolded tree.
      const leaked = [];
      (function walk(d) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.name.endsWith('.template')) leaked.push(p);
        }
      })(dest);
      assert.deepEqual(leaked, [], '.template suffix stripped everywhere');
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });
}

test('_firebase overlay drops in over a base template (V45)', () => {
  const dest = scaffold('game-3d', { NAME: 'demo', PORT: '5301' });
  try {
    copyTemplate(path.join(REPO_TEMPLATES, '_firebase'), dest, { NAME: 'demo', PORT: '5301' });
    assert.ok(fs.existsSync(path.join(dest, 'src', 'firebase.ts')), 'firebase.ts present');
    assert.ok(fs.existsSync(path.join(dest, 'firebase.json')), 'firebase.json present');
    assert.ok(fs.existsSync(path.join(dest, '.env.example')), '.env.example present');
    const rc = JSON.parse(fs.readFileSync(path.join(dest, '.firebaserc'), 'utf8'));
    assert.equal(rc.projects.default, 'demo', '.firebaserc placeholder replaced + suffix stripped');
    // Overlay must not clobber the base App.tsx.
    assert.ok(fs.existsSync(path.join(dest, 'src', 'App.tsx')), 'base App.tsx survives overlay');
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

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
