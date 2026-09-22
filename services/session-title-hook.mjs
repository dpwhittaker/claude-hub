#!/usr/bin/env node
// Claude Code `Stop` hook → keep the hub's tab title in step with what the
// session is actually doing (SPEC §V90). Installed into ~/.claude/settings.json
// by services/install-title-hook.mjs.
//
// The hook itself returns in a few ms: it forks a detached worker and exits 0
// with no output, so a turn never waits on a model call. The worker reads the
// transcript tail, asks Haiku for a 3–7 word title (told to keep the current
// one unless the purpose drifted) and POSTs it to the hub, keyed by the
// conversation uuid that hub sessions, v1 tabs and this hook all share.
//
// Inert when: SESSION_TITLES=0; HUB_TITLE_WORKER=1 (we are the `claude -p`
// the worker itself spawned — this is what stops the recursion); the Stop is a
// forced continuation (stop_hook_active); no transcript on disk; the hub is
// down; or the hub titled this session under 20 s ago.
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { digestTranscript, buildPrompt, parseReply, TITLE_MODEL, USER_NAME_FLOOR } = require('../lib/session-title.js');

const HUB = process.env.CLAUDE_HUB_URL || 'http://127.0.0.1:8002';
const REGISTRY = process.env.HUB_CLAUDE_SESSIONS_DIR || `${process.env.HOME}/.claude/sessions`;
const CLAUDE_BIN = process.env.CLAUDE_BIN || `${process.env.HOME}/.local/bin/claude`;
const MIN_GAP_MS = 20000;
const SELF = fileURLToPath(import.meta.url);

function quit() { process.exit(0); }
if (process.env.SESSION_TITLES === '0' || process.env.HUB_TITLE_WORKER === '1') quit();

if (process.argv[2] === '--work') {
  await work(process.argv[3], process.argv[4], process.argv[5] || '');
  quit();
}

let raw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) raw += chunk;
let data;
try { data = JSON.parse(raw); } catch { quit(); }
if (data.hook_event_name !== 'Stop' || data.stop_hook_active) quit();
if (!data.session_id || !data.transcript_path || !fs.existsSync(data.transcript_path)) quit();

// The worker runs with the plain environment; only the `claude -p` it spawns
// gets HUB_TITLE_WORKER=1, so that child's own Stop hook is the one that quits.
const child = spawn(process.execPath, [SELF, '--work', data.transcript_path, data.session_id, data.cwd || ''], {
  detached: true, stdio: 'ignore',
});
child.unref();
quit();

function registryEntry(uuid) {
  try {
    for (const n of fs.readdirSync(REGISTRY)) {
      if (!n.endsWith('.json')) continue;
      try {
        const o = JSON.parse(fs.readFileSync(`${REGISTRY}/${n}`, 'utf8'));
        if (o && o.sessionId === uuid) return o;
      } catch {}
    }
  } catch {}
  return null;
}

async function work(transcriptPath, uuid, cwd) {
  let current = null;
  try {
    const r = await fetch(`${HUB}/api/v2/titles/${encodeURIComponent(uuid)}`, { signal: AbortSignal.timeout(3000) });
    if (r.status === 200) {
      current = await r.json();
      if (current && Date.now() - Number(current.at) < MIN_GAP_MS) return;
    } else if (r.status !== 404) return;
  } catch { return; }                       // hub down → nothing to update

  let jsonl;
  try {
    // Only the tail matters; 512 KB covers dozens of turns.
    const st = fs.statSync(transcriptPath);
    const fd = fs.openSync(transcriptPath, 'r');
    const len = Math.min(st.size, 512 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    jsonl = buf.toString('utf8');
    if (len < st.size) jsonl = jsonl.slice(jsonl.indexOf('\n') + 1);
  } catch { return; }
  const digest = digestTranscript(jsonl);
  if (digest.assistantTurns === 0 || digest.turns.length === 0) return;
  // A name the user typed with /rename (Claude's registry says so) is the
  // current title when it is newer than our last auto title, and the model
  // is told to keep it verbatim unless the work has clearly changed.
  const reg = registryEntry(uuid);
  let title0 = (current && current.title) || digest.title;
  let userNamed = false;
  if (reg && reg.nameSource === 'user' && reg.name && (!current || Number(reg.nameSince) > Number(current.at))) {
    // Not even asked until the user has moved on by USER_NAME_FLOOR prompts.
    if (digest.userTurnsSince(Number(reg.nameSince)) < USER_NAME_FLOOR) return;
    title0 = reg.name; userNamed = true;
  }
  const prompt = buildPrompt({ turns: digest.turns, current: title0, cwd, userNamed });

  const reply = await new Promise((resolve) => {
    const p = execFile(CLAUDE_BIN, ['-p', '--model', TITLE_MODEL, '--output-format', 'text', '--no-session-persistence'], {
      timeout: 60000, maxBuffer: 1024 * 1024, env: { ...process.env, HUB_TITLE_WORKER: '1', CLAUDECODE: '' },
    }, (err, stdout) => resolve(err ? '' : String(stdout)));
    p.stdin.end(prompt);
  });
  const title = parseReply(reply);
  if (!title || title === title0) return;               // KEEP → nothing to post
  try {
    await fetch(`${HUB}/api/v2/titles`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uuid, title, source: 'auto' }), signal: AbortSignal.timeout(3000),
    });
  } catch {}
}
