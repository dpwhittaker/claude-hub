const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { copyTemplate } = require('../lib/template');

// SDD is only real if a fresh project arrives carrying it. These pin V67:
// every scaffoldable template ships a starter SPEC.md and an AGENTS.md whose
// top three sections are the workflow rules — commit, worktrees, spec — and
// the bare `none` path (server.js's own templates) does the same.

const REPO = path.join(__dirname, '..');
const TEMPLATES = ['vite', 'game-2d', 'game-3d', 'game-3d-complex', 'jekyll'];
// Fixed order: an agent reads top-down and stops early, so the order is
// part of the invariant, not decoration.
const RULES = [
  '## Workflow rule: commit + push every turn',
  '## Workflow rule: git worktrees',
  '## Workflow rule: the spec is the memory (SDD)',
];
const SPEC_SECTIONS = ['## §G GOAL', '## §C CONSTRAINTS', '## §I INTERFACES', '## §V INVARIANTS', '## §T TASKS', '## §B BUGS'];

function scaffold(templateId, vars) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-' + templateId + '-'));
  copyTemplate(path.join(REPO, 'templates', templateId), dest, vars);
  return dest;
}

// The three rules, in order, above everything else in the doc.
function assertRulesAtTop(text, where) {
  const at = RULES.map((h) => text.indexOf(h));
  at.forEach((i, n) => assert.ok(i > 0, `${where}: missing "${RULES[n]}"`));
  assert.deepEqual(at, [...at].sort((a, b) => a - b), `${where}: rules out of order`);
  const others = [...text.matchAll(/^## .*$/gm)].map((m) => m.index).filter((i) => !at.includes(i));
  assert.ok(
    others.every((i) => i > at[at.length - 1]),
    `${where}: a section precedes the three workflow rules`,
  );
}

for (const id of TEMPLATES) {
  test(`template ${id} ships SPEC.md + the three workflow rules (V67)`, () => {
    const dest = scaffold(id, { NAME: 'demo', PORT: '5300' });
    try {
      const agents = fs.readFileSync(path.join(dest, 'AGENTS.md'), 'utf8');
      assertRulesAtTop(agents, `templates/${id}/AGENTS.md`);
      assert.ok(agents.includes('SDD.md'), 'AGENTS.md points at the SDD protocol');

      const spec = fs.readFileSync(path.join(dest, 'SPEC.md'), 'utf8');
      for (const h of SPEC_SECTIONS) assert.ok(spec.includes(h), `${id} SPEC.md missing ${h}`);
      // Sections are addressable only if they stay in the fixed order.
      const at = SPEC_SECTIONS.map((h) => spec.indexOf(h));
      assert.deepEqual(at, [...at].sort((a, b) => a - b), `${id} SPEC.md sections out of order`);
      assert.ok(spec.includes('SDD.md'), `${id} SPEC.md points at the protocol`);
      assert.equal(/<PORT>|<NAME>/.test(spec), false, `${id} SPEC.md has unresolved placeholders`);
      assert.ok(spec.includes('id|status|task|cites'), `${id} §T is a pipe table`);
      assert.ok(spec.includes('id|date|cause|fix'), `${id} §B is a pipe table`);
      // Present is not rendered: Markdown needs the delimiter row under a pipe-table
      // header and one bullet per invariant, or Browse/GitHub run the rows together
      // into a paragraph (B24).
      assert.ok(spec.includes('id|status|task|cites\n---|---|---|---'), `${id} §T carries the delimiter row`);
      assert.ok(spec.includes('id|date|cause|fix\n---|---|---|---'), `${id} §B carries the delimiter row`);
      assert.ok(/^- V1:/m.test(spec), `${id} §V invariants are bullets`);
      assert.equal(/^V\d+:/m.test(spec), false, `${id} has a bare Vn: line that merges into its neighbour`);
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });
}

test('the bare `none` path gets the same three rules + a SPEC.md (V67)', () => {
  // server.js writes these inline rather than copying a template tree, so it
  // is the one place the invariant can drift silently.
  const src = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
  const agents = src.slice(src.indexOf('function agentsTemplate('), src.indexOf('function specTemplate('));
  assertRulesAtTop(agents, 'server.js agentsTemplate()');
  assert.ok(agents.includes('SDD.md'), 'bare AGENTS.md points at the SDD protocol');

  const spec = src.slice(src.indexOf('function specTemplate('), src.indexOf('function readmeTemplate('));
  for (const h of SPEC_SECTIONS) assert.ok(spec.includes(h), `bare SPEC.md missing ${h}`);
  assert.ok(spec.includes('id|status|task|cites\n---|---|---|---'), 'bare §T carries the delimiter row');
  assert.ok(spec.includes('id|date|cause|fix\n---|---|---|---'), 'bare §B carries the delimiter row');
  assert.ok(/^- V1:/m.test(spec), 'bare §V invariants are bullets');
  assert.ok(/fs\.writeFileSync\(path\.join\(dir, 'SPEC\.md'\), specTemplate\(name\)\)/.test(src),
    'bootstrapNoGithub actually writes SPEC.md');
});

test('SDD.md defines the sections, the encoding, and the maintenance moves (V67)', () => {
  const sdd = fs.readFileSync(path.join(REPO, 'SDD.md'), 'utf8');
  for (const h of ['§G', '§C', '§I', '§R', '§V', '§T', '§B']) {
    assert.ok(sdd.includes(h), `SDD.md does not define ${h}`);
  }
  // The three moves are the part of the protocol cavekit leaves implicit —
  // without them a growing spec accumulates contradictions instead of losing
  // the requirements it outgrew.
  for (const move of ['REVISE', 'RETIRE', 'MERGE']) {
    assert.ok(sdd.includes(`**${move}**`), `SDD.md missing the ${move} move`);
  }
  assert.ok(/never reused/i.test(sdd), 'SDD.md must pin that ids are never reused');
  assert.ok(sdd.includes('## Maintenance'), 'SDD.md needs the maintenance protocol');
  // The examples are what an agent copies (B24): every pipe-table example shows
  // its delimiter row, the §V example shows bullets.
  const headers = sdd.match(/^id\|[^\n]*$/gm) || [];
  assert.ok(headers.length >= 3, 'SDD.md shows §R, §T and §B examples');
  assert.equal((sdd.match(/^id\|[^\n]*\n---\|---/gm) || []).length, headers.length,
    'every SDD.md pipe-table example carries the delimiter row');
  assert.ok(/^- V13:/m.test(sdd), 'SDD.md §V example is one bullet per invariant');
});

test('AGENTS.md carries the same three rules at its top (V67)', () => {
  assertRulesAtTop(fs.readFileSync(path.join(REPO, 'AGENTS.md'), 'utf8'), 'AGENTS.md');
});
