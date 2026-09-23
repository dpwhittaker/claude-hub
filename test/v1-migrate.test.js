const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { migrateV1 } = require('../lib/v1-migrate');
const { makeSessionStore } = require('../lib/v2-sessions');
const { makeProfileStore } = require('../lib/v2-profiles');
const L = require('../lib/v2-layout');

test('V96: live v1 tabs become hub sessions keeping their tmux name; dead ones expire; profiles and maps follow', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v1mig-'));
  const projectsRoot = path.join(root, 'projects');
  const hub = path.join(root, 'hub');
  for (const p of ['alpha', 'beta']) fs.mkdirSync(path.join(projectsRoot, p), { recursive: true });
  fs.writeFileSync(path.join(projectsRoot, 'alpha/.develop-sessions.json'), JSON.stringify({ sessions: { s1: { uuid: 'aaaaaaaa-1111-1111-1111-111111111111', agent: 'claude' }, s2: { uuid: 'bbbbbbbb-1111-1111-1111-111111111111', agent: 'codex' } }, lastActive: 's1' }));
  fs.writeFileSync(path.join(projectsRoot, 'beta/.develop-sessions.json'), JSON.stringify({ sessions: { s1: 'cccccccc-1111-1111-1111-111111111111' } })); // pre-agent shape
  const sessions = makeSessionStore({ dir: hub, projectsRoot });
  const profiles = makeProfileStore({ dir: hub });
  const p = profiles.create({ name: 'Me' });
  const tabs = { ...p.tabs, tterm: { kind: 'term', sessionId: null, termUrl: '/term/alpha__s1/', termKey: 'alpha__s1', cwd: 'alpha', agent: 'claude', title: null }, tdead: { kind: 'term', sessionId: null, termUrl: '/term/beta__s1/', termKey: 'beta__s1', cwd: 'beta', agent: 'claude', title: null } };
  profiles.update(p.id, { layout: L.addTab(L.addTab(p.layout, p.layout.id, 'tterm'), p.layout.id, 'tdead'), tabs });

  const liveTmux = new Set(['alpha__s1', 'alpha__s2']);
  const registry = new Map([['alpha__s1', { sessionId: 'dddddddd-1111-1111-1111-111111111111' }]]);
  const r = migrateV1({ projectsRoot, sessions, profiles, liveTmux, registry, now: () => '2026-09-23T00:00:00.000Z' });
  assert.deepEqual(r.migrated.map((m) => [m.key, m.agent, m.reused]), [['alpha__s1', 'claude', false], ['alpha__s2', 'codex', false]]);
  assert.deepEqual(r.expired, ['beta__s1']);
  assert.equal(r.retargeted, 1);
  const list = sessions.list();
  const a1 = list.find((s) => s.termKey === 'alpha__s1');
  assert.equal(a1.uuid, 'dddddddd-1111-1111-1111-111111111111', 'the live id from the registry, not the launch id');
  assert.equal(a1.cwd, 'alpha');
  assert.equal(list.find((s) => s.termKey === 'alpha__s2').uuid, 'bbbbbbbb-1111-1111-1111-111111111111');
  assert.ok(!list.some((s) => s.cwd === 'beta'), 'a dead tab is not migrated');
  const after = profiles.get(p.id);
  assert.equal(after.tabs.tterm.sessionId, a1.id);
  assert.equal(after.tabs.tterm.termUrl, a1.termUrl);
  assert.equal(after.tabs.tterm.termKey, 'alpha__s1');
  assert.equal(after.tabs.tdead.sessionId, null, 'a tab on an expired session is left alone');
  assert.ok(fs.existsSync(path.join(projectsRoot, 'alpha/.develop-sessions.json.v1')));
  assert.ok(!fs.existsSync(path.join(projectsRoot, 'alpha/.develop-sessions.json')));
  // Idempotent: a second run reuses what exists and migrates nothing new.
  fs.renameSync(path.join(projectsRoot, 'alpha/.develop-sessions.json.v1'), path.join(projectsRoot, 'alpha/.develop-sessions.json'));
  const r2 = migrateV1({ projectsRoot, sessions, profiles, liveTmux, registry });
  assert.deepEqual(r2.migrated.map((m) => m.reused), [true, true]);
  assert.equal(sessions.list().length, 2);
});
