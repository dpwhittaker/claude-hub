#!/usr/bin/env node
// Claude Code hook → tell claude-hub whether this session is working,
// waiting on the user, or idle (SPEC §V92), so its dot can pulse on the
// dashboard. One POST to localhost, 2 s cap, always exits 0 with no output.
// Installed by services/install-session-hooks.mjs for UserPromptSubmit,
// PostToolUse, PreToolUse(AskUserQuestion), Notification and Stop.
//
// Inert on SESSION_TITLES=0 (shares the switch with the title hook) and on
// HUB_TITLE_WORKER=1 (the title worker's own `claude -p`).
const HUB = process.env.CLAUDE_HUB_URL || 'http://127.0.0.1:8002';

function quit() { process.exit(0); }
if (process.env.SESSION_TITLES === '0' || process.env.HUB_TITLE_WORKER === '1') quit();

let raw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) raw += chunk;
let data;
try { data = JSON.parse(raw); } catch { quit(); }
if (!data.session_id) quit();

const ev = data.hook_event_name;
let state = null;
if (ev === 'UserPromptSubmit' || ev === 'PostToolUse') state = 'busy';
else if (ev === 'Stop' && !data.stop_hook_active) state = 'idle';
else if (ev === 'PreToolUse' && data.tool_name === 'AskUserQuestion') state = 'waiting';
else if (ev === 'Notification' && data.notification_type === 'permission_prompt') state = 'waiting';
if (!state) quit();

try {
  await fetch(`${HUB}/api/v2/activity`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uuid: data.session_id, state }), signal: AbortSignal.timeout(2000),
  });
} catch {}
quit();
