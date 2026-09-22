#!/usr/bin/env node
// Wire (or unwire) services/session-title-hook.mjs (Stop → auto-title, V90)
// into ~/.claude/settings.json.
//
//   node services/install-session-hooks.mjs            # add (idempotent)
//   node services/install-session-hooks.mjs --remove   # take exactly it out
//
// Same merge-by-command approach as install-glasses-hooks.mjs: other hooks
// are untouched and running it twice changes nothing. 5 s timeout — the hook
// forks its worker and returns at once, so a turn never waits. (Activity —
// busy / waiting / idle — needs no hook: the hub reads Claude Code's own
// session registry, lib/claude-registry.js.)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SETTINGS = process.env.CLAUDE_SETTINGS || path.join(os.homedir(), '.claude', 'settings.json');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TITLE = `node "${path.resolve(HERE, 'session-title-hook.mjs')}"`;
const ACTIVITY = `node "${path.resolve(HERE, 'session-activity-hook.mjs')}"`; // retired; still removed if present
const OURS = new Set([TITLE, ACTIVITY]);
const ENTRIES = { Stop: [{ hooks: [{ type: 'command', command: TITLE, timeout: 5 }] }] };

const remove = process.argv.includes('--remove');
const settings = fs.existsSync(SETTINGS) ? JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) : {};
settings.hooks = settings.hooks || {};
const ours = (e) => Array.isArray(e.hooks) && e.hooks.some((h) => OURS.has(h.command));
for (const event of new Set([...Object.keys(settings.hooks), ...Object.keys(ENTRIES)])) {
  const list = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
  const kept = list.filter((e) => !ours(e));
  settings.hooks[event] = remove ? kept : [...kept, ...(ENTRIES[event] || [])];
  if (settings.hooks[event].length === 0) delete settings.hooks[event];
}
fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
console.log(`${remove ? 'removed' : 'installed'} session hooks in ${SETTINGS}`);
