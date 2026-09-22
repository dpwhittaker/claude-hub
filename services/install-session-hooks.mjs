#!/usr/bin/env node
// Wire (or unwire) the two session hooks into ~/.claude/settings.json:
//   services/session-title-hook.mjs     Stop → auto-title (V90)
//   services/session-activity-hook.mjs  busy / waiting / idle (V92)
//
//   node services/install-session-hooks.mjs            # add (idempotent)
//   node services/install-session-hooks.mjs --remove   # take exactly these out
//
// Same merge-by-command approach as install-glasses-hooks.mjs: other hooks
// are untouched and running it twice changes nothing. 5 s timeouts — both
// hooks return at once (the titler forks its worker), so a turn never waits.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SETTINGS = process.env.CLAUDE_SETTINGS || path.join(os.homedir(), '.claude', 'settings.json');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TITLE = `node "${path.resolve(HERE, 'session-title-hook.mjs')}"`;
const ACTIVITY = `node "${path.resolve(HERE, 'session-activity-hook.mjs')}"`;
const OURS = new Set([TITLE, ACTIVITY]);
const hook = (command) => ({ type: 'command', command, timeout: 5 });
const ENTRIES = {
  Stop: [{ hooks: [hook(TITLE)] }, { hooks: [hook(ACTIVITY)] }],
  UserPromptSubmit: [{ hooks: [hook(ACTIVITY)] }],
  PostToolUse: [{ hooks: [hook(ACTIVITY)] }],
  PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [hook(ACTIVITY)] }],
  Notification: [{ hooks: [hook(ACTIVITY)] }],
};

const remove = process.argv.includes('--remove');
const settings = fs.existsSync(SETTINGS) ? JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) : {};
settings.hooks = settings.hooks || {};
for (const [event, entries] of Object.entries(ENTRIES)) {
  const list = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
  const ours = (e) => Array.isArray(e.hooks) && e.hooks.some((h) => OURS.has(h.command));
  const kept = list.filter((e) => !ours(e));
  settings.hooks[event] = remove ? kept : [...kept, ...entries];
  if (settings.hooks[event].length === 0) delete settings.hooks[event];
}
fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
console.log(`${remove ? 'removed' : 'installed'} session hooks in ${SETTINGS}`);
