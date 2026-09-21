#!/usr/bin/env node
// Claude Code hook → claude-hub relay, so a glasses client watching this
// terminal can answer Claude's questions and permission prompts (SPEC §V75).
//
// Wired into ~/.claude/settings.json by services/install-glasses-hooks.mjs for
// PreToolUse (AskUserQuestion), PermissionRequest, Stop and Notification.
//
// INERT BY DEFAULT. It exits 0 with no output — which Claude Code treats as
// "no decision, carry on" — unless every one of these holds:
//   1. we are inside a tmux session (claude-hub's develop tabs are), so the
//      session name is the terminal key;
//   2. claude-hub is up on CLAUDE_HUB_URL (default http://127.0.0.1:8002);
//   3. the hub says a glasses client is watching this key RIGHT NOW, and it
//      answered before the glasses stopped watching or the hold aged out.
// Anything else — hub down, no tmux, no watcher, timeout, network error —
// falls through to the ordinary TUI prompt. GLASSES_RELAY=0 disables it.
import { execFileSync } from 'node:child_process';

const HUB = process.env.CLAUDE_HUB_URL || 'http://127.0.0.1:8002';
const HELD_TIMEOUT_MS = 590000;   // just under the 600 s hook timeout
const QUICK_TIMEOUT_MS = 3000;

function quit() { process.exit(0); }

if (process.env.GLASSES_RELAY === '0' || !process.env.TMUX) quit();

let raw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) raw += chunk;
let data;
try { data = JSON.parse(raw); } catch { quit(); }

let key = '';
try {
  const args = ['display-message', '-p', '#S'];
  if (process.env.TMUX_PANE) args.splice(1, 0, '-t', process.env.TMUX_PANE);
  key = execFileSync('tmux', args, { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
} catch { quit(); }
if (!key) quit();

const ev = data.hook_event_name;
let kind; let payload;
if (ev === 'PreToolUse' && data.tool_name === 'AskUserQuestion') {
  kind = 'question';
  payload = { questions: (data.tool_input && data.tool_input.questions) || [] };
} else if (ev === 'PermissionRequest') {
  kind = 'permission';
  payload = { tool_name: data.tool_name, tool_input: data.tool_input || {} };
} else if (ev === 'Stop') {
  kind = 'stop';
  payload = { last_assistant_message: data.last_assistant_message || '' };
} else if (ev === 'Notification') {
  kind = 'notification';
  payload = { notification_type: data.notification_type, message: data.message, title: data.title };
} else {
  quit();
}

const held = kind === 'question' || kind === 'permission';
let out;
try {
  const res = await fetch(`${HUB}/api/term-pending/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind, session_id: data.session_id, payload }),
    signal: AbortSignal.timeout(held ? HELD_TIMEOUT_MS : QUICK_TIMEOUT_MS),
  });
  if (!res.ok) quit();
  out = await res.json();
} catch { quit(); }
if (!out || !out.relay || !out.answer) quit();

if (kind === 'question') {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: { ...data.tool_input, answers: out.answer.answers || {} },
    },
  }));
} else if (kind === 'permission') {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: out.answer.decision === 'allow' ? 'allow' : 'deny',
      message: 'Answered from the glasses',
    },
  }));
}
quit();
