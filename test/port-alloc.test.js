const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { allocatePort } = require('../lib/port-alloc');

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hub-port-'));
}

function project(root, name, meta) {
  fs.mkdirSync(path.join(root, name));
  if (meta != null) {
    fs.writeFileSync(path.join(root, name, '.project-meta.json'), JSON.stringify(meta, null, 2));
  }
}

test('returns 5173 when no projects exist', () => {
  const root = scratch();
  try {
    assert.equal(allocatePort(root), 5173);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('skips ports already claimed by another project', () => {
  const root = scratch();
  try {
    project(root, 'a', { name: 'a', proxyTarget: 'http://127.0.0.1:5173' });
    project(root, 'b', { name: 'b', proxyTarget: 'http://127.0.0.1:5174' });
    assert.equal(allocatePort(root), 5175);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ignores projects with no meta or no proxyTarget', () => {
  const root = scratch();
  try {
    project(root, 'a', null); // no meta
    project(root, 'b', { name: 'b' }); // no proxyTarget
    project(root, 'c', { name: 'c', proxyTarget: 'http://127.0.0.1:5173' });
    assert.equal(allocatePort(root), 5174);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('does not crash on malformed meta', () => {
  const root = scratch();
  try {
    fs.mkdirSync(path.join(root, 'a'));
    fs.writeFileSync(path.join(root, 'a', '.project-meta.json'), '{not json');
    assert.equal(allocatePort(root), 5173);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
