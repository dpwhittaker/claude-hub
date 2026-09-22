#!/usr/bin/env node
// Wire (or unwire) services/session-title-hook.mjs into ~/.claude/settings.json.
//
//   node services/install-title-hook.mjs            # add the Stop hook (idempotent)
//   node services/install-title-hook.mjs --remove   # take exactly that entry out
//
// Same merge-by-command approach as install-glasses-hooks.mjs: other hooks
// are untouched and running it twice changes nothing. 5 s timeout — the hook
// forks its worker and exits at once, so it never holds a turn.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SETTINGS = process.env.CLAUDE_SETTINGS || path.join(os.homedir(), '.claude', 'settings.json');
const HOOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'session-title-hook.mjs');
const COMMAND = `node "${HOOK}"`;
const ENTRY = { hooks: [{ type: 'command', command: COMMAND, timeout: 5 }] };

const remove = process.argv.includes('--remove');
const settings = fs.existsSync(SETTINGS) ? JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) : {};
settings.hooks = settings.hooks || {};
const list = Array.isArray(settings.hooks.Stop) ? settings.hooks.Stop : [];
const ours = (e) => Array.isArray(e.hooks) && e.hooks.some((h) => h.command === COMMAND);
const kept = list.filter((e) => !ours(e));
settings.hooks.Stop = remove ? kept : [...kept, ENTRY];
if (settings.hooks.Stop.length === 0) delete settings.hooks.Stop;
fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
console.log(`${remove ? 'removed' : 'installed'} session title hook in ${SETTINGS} (${COMMAND})`);
