// Pure helpers for services/session-title-hook.mjs (SPEC §V90): turn a
// Claude Code transcript tail into the prompt Haiku titles from, and read the
// title the transcript already carries. CommonJS so the ESM hook can
// `createRequire` it and the tests can require it directly.
'use strict';

const MAX_TURNS = 14;
const MAX_TEXT = 600;
const MAX_TOTAL = 9000;
const TITLE_MODEL = process.env.HUB_TITLE_MODEL || 'claude-haiku-4-5-20251001';

function textOf(message) {
  if (!message) return '';
  const c = message.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

// { turns: [{role, text}], title: latest ai/custom title | null, assistantTurns }
function digestTranscript(jsonl) {
  const turns = [];
  let title = null;
  let assistantTurns = 0;
  for (const line of String(jsonl || '').split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;
    if (obj.type === 'custom-title' && typeof obj.customTitle === 'string' && obj.customTitle.trim()) { title = obj.customTitle.trim(); continue; }
    if (obj.type === 'ai-title' && typeof obj.aiTitle === 'string') { title = obj.aiTitle; continue; }
    if (obj.isSidechain) continue;
    if (obj.type !== 'user' && obj.type !== 'assistant') continue;
    const text = textOf(obj.message).replace(/\s+/g, ' ').trim();
    if (!text) continue;                     // tool_use / tool_result only
    if (obj.type === 'user' && /^<(local-command|command-name|system-reminder)/.test(text)) continue;
    if (obj.type === 'assistant') assistantTurns += 1;
    turns.push({ role: obj.type, text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '…' : text });
  }
  let tail = turns.slice(-MAX_TURNS);
  let total = tail.reduce((n, t) => n + t.text.length, 0);
  while (tail.length > 2 && total > MAX_TOTAL) { total -= tail[0].text.length; tail = tail.slice(1); }
  return { turns: tail, title, assistantTurns };
}

function buildPrompt({ turns, current, cwd, userNamed = false }) {
  return [
    'You name coding sessions for a dashboard tab. Reply with ONLY the title: 3 to 7 words, Title Case, no quotes, no trailing period, no explanation.',
    'The title says what the session is working on NOW. Keep the current title exactly when the work has not moved on; change it only when the purpose has clearly drifted to something else.',
    userNamed
      ? `Current title (chosen by the USER, keep it VERBATIM — including its casing and hyphens — unless the conversation since then is plainly about a different task): ${current}`
      : (current ? `Current title: ${current}` : 'Current title: (none yet)'),
    cwd ? `Working folder: ${cwd}` : '',
    '', 'Recent conversation, oldest first:',
    ...turns.map((t) => `${t.role === 'user' ? 'USER' : 'ASSISTANT'}: ${t.text}`),
  ].filter((l) => l !== '').join('\n');
}

module.exports = { digestTranscript, buildPrompt, textOf, TITLE_MODEL, MAX_TURNS };
