#!/usr/bin/env node
// Wire (or unwire) services/glasses-relay-hook.mjs into ~/.claude/settings.json.
//
//   node services/install-glasses-hooks.mjs            # add the four hook entries (idempotent)
//   node services/install-glasses-hooks.mjs --remove   # take exactly those entries out again
//
// Merges by command string, so existing hooks (yours) are left
// untouched and running it twice changes nothing. Timeouts: the two held
// events get Claude Code's 600 s default explicitly; the two fire-and-forget
// events get 5 s so a stuck hub can never slow a turn down.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SETTINGS = process.env.CLAUDE_SETTINGS || path.join(os.homedir(), '.claude', 'settings.json');
const HOOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'glasses-relay-hook.mjs');
const COMMAND = `node "${HOOK}"`;
const ENTRIES = {
  PreToolUse: { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: COMMAND, timeout: 600 }] },
  PermissionRequest: { hooks: [{ type: 'command', command: COMMAND, timeout: 600 }] },
  Stop: { hooks: [{ type: 'command', command: COMMAND, timeout: 5 }] },
  Notification: { hooks: [{ type: 'command', command: COMMAND, timeout: 5 }] },
};

const remove = process.argv.includes('--remove');
const settings = fs.existsSync(SETTINGS) ? JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) : {};
settings.hooks = settings.hooks || {};
for (const [event, entry] of Object.entries(ENTRIES)) {
  const list = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
  const ours = (e) => Array.isArray(e.hooks) && e.hooks.some((h) => h.command === COMMAND);
  const kept = list.filter((e) => !ours(e));
  settings.hooks[event] = remove ? kept : [...kept, entry];
  if (settings.hooks[event].length === 0) delete settings.hooks[event];
}
fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
console.log(`${remove ? 'removed' : 'installed'} glasses relay hooks in ${SETTINGS} (${COMMAND})`);
