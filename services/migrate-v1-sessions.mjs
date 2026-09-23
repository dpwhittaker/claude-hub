#!/usr/bin/env node
// Migrate v1 develop tabs into hub sessions (SPEC §V96) — run once, as the
// hub's user, while the old tmux sessions are still alive:
//
//   node services/migrate-v1-sessions.mjs             # dry run: prints the plan
//   node services/migrate-v1-sessions.mjs --apply     # do it
//
// Live tabs become hub sessions keeping their tmux names; dead ones expire;
// profile tabs follow; each .develop-sessions.json becomes *.v1. Nothing
// about tmux or the running agents is touched. The v1 ttyd units are NOT
// stopped here (the tmux server lives in one of their cgroups and stopping
// that one would kill every session): disable them and let them go at the
// next reboot — see AGENTS.md "Retiring v1".
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { migrateV1 } = require('../lib/v1-migrate.js');
const { makeSessionStore } = require('../lib/v2-sessions.js');
const { makeProfileStore } = require('../lib/v2-profiles.js');
const { readLiveSessions } = require('../lib/claude-registry.js');

const projectsRoot = process.env.PROJECTS_ROOT || path.join(os.homedir(), 'projects');
const hubDir = process.env.HUB_STATE_DIR || path.join(os.homedir(), '.claude-hub');
const apply = process.argv.includes('--apply');

let liveTmux = new Set();
try { liveTmux = new Set(execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' }).split('\n').filter(Boolean)); } catch {}
const registry = readLiveSessions();

if (!apply) {
  // Dry run against throwaway stores so nothing is written.
  const fs = await import('node:fs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v1-migrate-dry-'));
  const r = migrateV1({ projectsRoot, sessions: makeSessionStore({ dir: tmp, projectsRoot }), profiles: makeProfileStore({ dir: tmp }), liveTmux, registry, rename: false });
  console.log('would migrate:', r.migrated.map((m) => `${m.key} (${m.agent})`).join(', ') || '(none)');
  console.log('would expire :', r.expired.join(', ') || '(none)');
  console.log('maps         :', r.maps.length, '(profile tabs are only retargeted with --apply)');
  console.log('\nre-run with --apply to do it');
  fs.rmSync(tmp, { recursive: true, force: true });
} else {
  const r = migrateV1({ projectsRoot, sessions: makeSessionStore({ dir: hubDir, projectsRoot }), profiles: makeProfileStore({ dir: hubDir }), liveTmux, registry });
  console.log('migrated  :', r.migrated.map((m) => `${m.key} → ${m.id}${m.reused ? ' (existing)' : ''}`).join('\n            ') || '(none)');
  console.log('expired   :', r.expired.join(', ') || '(none)');
  console.log('maps moved:', r.maps.length, '| profile tabs retargeted:', r.retargeted);
}
