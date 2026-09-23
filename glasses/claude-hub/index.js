// claude-hub on the Even Realities G2, as an Omni app (SPEC §V100).
//
// Everything comes from the running claude-hub on this box through its v2
// API: the sessions list (recency, state, title), the file explorer, a live
// terminal read through tmux, spoken prompts via the hub's STT, and Claude's
// questions / permission prompts through the glasses relay. The design
// mirrors the web workspace: no projects, sessions and folders and files.
//
//   Sessions ─▶ terminal  (hold = speak · swipe = scroll · double-tap = back)
//            └▶ Explorer / ─▶ folders ─▶ files (swipe = scroll)
//                          └ "terminal here" starts a Claude session in the folder
//
// Load it by listing this folder's parent (`~/projects/claude-hub/glasses`)
// in omnieven's data/app-roots. Env: CLAUDE_HUB_URL (default 127.0.0.1:8002).
import { ICON, cleanTerminal, label, listPage, sessionLabel, summarizeInput, tailBytes, truncate } from './text.js';

const HUB = () => process.env.CLAUDE_HUB_URL || 'http://127.0.0.1:8002';
const POLL_MS = 1000;
const MIN_PCM_BYTES = 3200;   // < 0.1 s of 16 kHz s16le: a slip, not a prompt

// ---------- hub client ----------
async function hub(ctx, path, init) {
  const res = await ctx.fetch(HUB() + path, init);
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = { error: text.slice(0, 120) }; }
  if (!res.ok) throw new Error((body && body.error) || `${res.status} ${path}`);
  return body;
}
const post = (ctx, path, body) => hub(ctx, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// ---------- state ----------
function mem(ctx) {
  const m = ctx.mem;
  m.nav ??= [{ kind: 'sessions', page: 0 }];
  m.cache ??= {};            // sessions list, folder listings, file texts
  m.term ??= null;           // { key, capture, frozen, pending }
  m.items ??= [];            // what the list on screen maps to
  m.pcm ??= [];
  m.status ??= '';           // one-line note shown on the next render
  return m;
}
const top = (ctx) => mem(ctx).nav[mem(ctx).nav.length - 1];
function push(ctx, screen) { mem(ctx).nav.push(screen); }
function pop(ctx) { const m = mem(ctx); if (m.nav.length > 1) m.nav.pop(); }
function replace(ctx, screen) { const m = mem(ctx); m.nav[m.nav.length - 1] = screen; }

// ---------- data ----------
async function loadSessions(ctx) {
  const m = mem(ctx);
  const { sessions } = await hub(ctx, '/api/v2/sessions');
  m.cache.sessions = sessions.filter((s) => s.agent !== 'shell' || s.running).sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
  return m.cache.sessions;
}
async function loadFolder(ctx, path) {
  const m = mem(ctx);
  const key = 'dir:' + path;
  if (!m.cache[key]) m.cache[key] = (await hub(ctx, '/api/v2/fs/list?path=' + encodeURIComponent(path))).entries.filter((e) => !e.dim);
  return m.cache[key];
}
async function loadFile(ctx, path) {
  const m = mem(ctx);
  const key = 'file:' + path;
  if (!m.cache[key]) {
    const st = await hub(ctx, '/api/v2/fs/stat?path=' + encodeURIComponent(path));
    if (!st.textual || st.tooLarge) m.cache[key] = `${st.fileKind} · ${st.size} bytes`;
    else m.cache[key] = (await hub(ctx, '/api/v2/fs/text?path=' + encodeURIComponent(path))).content;
  }
  return m.cache[key];
}
async function capture(ctx, key) {
  return hub(ctx, '/api/term-capture/' + encodeURIComponent(key));
}

// ---------- navigation actions ----------
async function openTerm(ctx, s) {
  const m = mem(ctx);
  m.term = { key: s.termKey, session: s, capture: null, frozen: false, pending: null, error: null };
  push(ctx, { kind: 'term', key: s.termKey });
  await pollOnce(ctx);
}

async function terminalHere(ctx, cwd) {
  const s = await post(ctx, '/api/v2/sessions', { cwd, agent: 'claude' });
  delete mem(ctx).cache.sessions;
  await openTerm(ctx, s);
}

async function pollOnce(ctx) {
  const m = mem(ctx);
  const t = top(ctx);
  if (!m.term || !['term', 'question', 'permission', 'listen', 'confirm'].includes(t.kind)) return;
  let cap;
  try { cap = await capture(ctx, m.term.key); m.term.error = null; }
  catch (e) { if (m.term.error !== e.message) { m.term.error = e.message; ctx.render(); } return; }
  const changed = !m.term.capture || cap.lines.join('\n') !== m.term.capture.lines.join('\n');
  const pendingBefore = m.term.pending ? m.term.pending.id : null;
  m.term.capture = cap;
  m.term.pending = cap.pending;
  if (cap.pending && t.kind === 'term') {
    if (cap.pending.kind === 'question') push(ctx, { kind: 'question', key: m.term.key, pendingId: cap.pending.id, index: 0, picks: {} });
    else push(ctx, { kind: 'permission', key: m.term.key, pendingId: cap.pending.id });
    ctx.render();
  } else if ((t.kind === 'question' || t.kind === 'permission') && (cap.pending ? cap.pending.id : null) !== pendingBefore) {
    if (!cap.pending) pop(ctx);   // answered elsewhere, released, or timed out
    ctx.render();
  } else if (t.kind === 'term' && changed && !m.term.frozen) {
    ctx.render();
  }
}

// ---------- speech ----------
async function startListening(ctx, purpose) {
  const m = mem(ctx);
  if (m.listening) return;
  m.listening = true;
  m.pcm = [];
  push(ctx, { kind: 'listen', key: m.term.key, purpose });
  ctx.render();
  try { await ctx.audio(true, 'glasses'); } catch (e) { m.status = 'mic: ' + e.message; }
}
async function stopListening(ctx) {
  const m = mem(ctx);
  if (!m.listening) return;
  m.listening = false;
  try { await ctx.audio(false, 'glasses'); } catch {}
  const t = top(ctx);
  if (t.kind !== 'listen') return;
  const total = m.pcm.reduce((n, c) => n + c.length, 0);
  const pcm = Buffer.concat(m.pcm.map((c) => Buffer.from(c)), total);
  m.pcm = [];
  if (total < MIN_PCM_BYTES) { pop(ctx); ctx.render(); return; }
  replace(ctx, { kind: 'confirm', key: t.key, purpose: t.purpose, text: '', busy: `transcribing ${(total / 32000).toFixed(1)} s…` });
  ctx.render();
  let text = '';
  try {
    const r = await ctx.fetch(HUB() + '/api/stt', { method: 'POST', headers: { 'content-type': 'audio/L16; rate=16000' }, body: pcm });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'stt failed');
    text = (j.text || '').trim();
  } catch (e) { m.status = 'stt: ' + e.message; }
  if (!text) { pop(ctx); ctx.render(); return; }
  replace(ctx, { kind: 'confirm', key: t.key, purpose: t.purpose, text });
  ctx.render();
}
async function cancelListening(ctx) {
  const m = mem(ctx);
  if (m.listening) { m.listening = false; try { await ctx.audio(false, 'glasses'); } catch {} }
  m.pcm = [];
  if (top(ctx).kind === 'listen') pop(ctx);
}

// ---------- prompts ----------
function currentQuestions(ctx, s) {
  const p = mem(ctx).term && mem(ctx).term.pending;
  if (!p || p.id !== s.pendingId || p.kind !== 'question') return null;
  return p.payload.questions || [];
}
async function advance(ctx, s, picks) {
  const questions = currentQuestions(ctx, s) || [];
  if (s.index + 1 < questions.length) { replace(ctx, { ...s, index: s.index + 1, picks }); return; }
  const answers = {};
  for (const q of questions) if (picks[q.question] && picks[q.question].length) answers[q.question] = picks[q.question].join(', ');
  await post(ctx, '/api/term-pending/' + encodeURIComponent(s.key) + '/answer', { id: s.pendingId, answer: { answers } });
  mem(ctx).term.pending = null;
  pop(ctx);
}
async function applySpokenAnswer(ctx, text) {
  const s = top(ctx);
  if (s.kind !== 'question') return;
  const questions = currentQuestions(ctx, s);
  if (!questions || !questions[s.index]) return;
  await advance(ctx, s, { ...s.picks, [questions[s.index].question]: [text] });
}
async function release(ctx, s) {
  try { await post(ctx, '/api/term-pending/' + encodeURIComponent(s.key) + '/answer', { id: s.pendingId, release: true }); } catch {}
  if (mem(ctx).term) mem(ctx).term.pending = null;
  pop(ctx);
}

// ---------- views ----------
function list(ctx, items, page, more) {
  const m = mem(ctx);
  const { slice, hasMore, left } = listPage(items, page);
  m.items = slice.slice();
  if (hasMore) m.items.push({ text: `${ICON.more} ${left} more`, run: more });
  return m.items.map((i) => i.text);
}

function sessionsView(ctx, s) {
  const m = mem(ctx);
  const sessions = m.cache.sessions;
  if (!sessions) { loadSessions(ctx).then(() => ctx.render()).catch((e) => fail(ctx, e)); return { text: 'Loading sessions…' }; }
  const items = sessions.map((x) => ({ text: sessionLabel(x), run: () => openTerm(ctx, x) }));
  items.push({ text: `${ICON.dir} Explorer /`, run: () => { push(ctx, { kind: 'folder', path: '', page: 0 }); } });
  return { list: list(ctx, items, s.page, () => replace(ctx, { ...s, page: s.page + 1 })), menu: [{ id: 'refresh', label: 'Refresh' }, { id: 'explorer', label: 'Explorer' }] };
}

function folderView(ctx, s) {
  const m = mem(ctx);
  const entries = m.cache['dir:' + s.path];
  if (!entries) { loadFolder(ctx, s.path).then(() => ctx.render()).catch((e) => fail(ctx, e)); return { text: `Loading /${s.path}…` }; }
  const items = [{ text: `${ICON.term}+ terminal here`, run: () => terminalHere(ctx, s.path) }];
  for (const e of entries) {
    items.push(e.kind === 'dir'
      ? { text: label(ICON.dir, e.name), run: () => { push(ctx, { kind: 'folder', path: e.path, page: 0 }); } }
      : { text: label(ICON.file, e.name), run: () => { push(ctx, { kind: 'file', path: e.path }); } });
  }
  return { list: list(ctx, items, s.page, () => replace(ctx, { ...s, page: s.page + 1 })), menu: [{ id: 'here', label: 'Terminal here' }, { id: 'sessions', label: 'Sessions' }, { id: 'refresh', label: 'Refresh' }] };
}

function fileView(ctx, s) {
  const m = mem(ctx);
  const text = m.cache['file:' + s.path];
  if (text === undefined) { loadFile(ctx, s.path).then(() => ctx.render()).catch((e) => fail(ctx, e)); return { text: `Loading ${s.path}…` }; }
  const lines = text.split('\n');
  const start = s.offset || 0;
  const body = tailBytes(lines.slice(start).slice(0, 400)).length ? blockFrom(lines, start) : '(empty)';
  return { containers: ctx.ui.headerBody(truncate(`${ICON.file} ${s.path}`, 60), body), menu: [{ id: 'sessions', label: 'Sessions' }, { id: 'explorer', label: 'Explorer' }] };
}
// A block of a file starting at `start`, within the byte budget.
function blockFrom(lines, start) {
  const out = [];
  let used = 0;
  for (let i = start; i < lines.length; i++) {
    const n = Buffer.byteLength(lines[i], 'utf8') + 1;
    if (used + n > 1800) break;
    out.push(lines[i]); used += n;
  }
  return out.join('\n');
}

function termView(ctx, s) {
  const m = mem(ctx);
  const t = m.term;
  if (!t || t.key !== s.key) return { text: 'no terminal' };
  const sess = t.session || {};
  const state = t.capture && t.capture.state && t.capture.state.notification ? 'waiting' : (sess.activity || '');
  const head = truncate(`${ICON.term} ${sess.title || sess.cwd || s.key}${state ? ' · ' + state : ''}${t.frozen ? ' · ↑' : ''}`, 60);
  const body = t.error ? `! ${t.error}` : t.capture ? tailBytes(cleanTerminal(t.capture.lines)).join('\n') || '(empty)' : 'Loading…';
  // headerBody → [header, body] containers (Omni server/ui.ts).
  return { containers: ctx.ui.headerBody(head, body), menu: [{ id: 'sessions', label: 'Sessions' }, { id: 'suspend', label: 'Suspend terminal' }, { id: 'refresh', label: 'Refresh' }] };
}

function questionView(ctx, s) {
  const m = mem(ctx);
  const questions = currentQuestions(ctx, s);
  if (!questions || !questions[s.index]) { pop(ctx); return render(ctx); }
  const q = questions[s.index];
  const picked = new Set(s.picks[q.question] || []);
  const items = q.options.map((o) => ({
    text: truncate(q.multiSelect ? `${picked.has(o.label) ? '[x]' : '[ ]'} ${o.label}` : o.label, 64),
    run: async () => {
      if (q.multiSelect) {
        const next = picked.has(o.label) ? [...picked].filter((x) => x !== o.label) : [...picked, o.label];
        replace(ctx, { ...s, picks: { ...s.picks, [q.question]: next } });
      } else await advance(ctx, s, { ...s.picks, [q.question]: [o.label] });
    },
  }));
  items.push({ text: 'Other… (hold to speak)', run: () => {} });
  if (q.multiSelect) items.push({ text: 'Done with this question', run: () => advance(ctx, s, s.picks) });
  m.items = items;
  const head = q.header ? `${q.header} · ` : '';
  return { containers: [
    { type: 'text', name: 'q', x: 0, y: 0, w: 576, h: 62, text: truncate(`${head}${s.index + 1}/${questions.length}: ${q.question}`, 120), textColor: 3 },
    { type: 'list', name: 'opts', x: 0, y: 62, w: 576, h: 226, items: items.map((i) => i.text), capture: true },
  ], menu: [{ id: 'back', label: 'Back to the terminal' }] };
}

function permissionView(ctx, s) {
  const m = mem(ctx);
  const p = m.term && m.term.pending;
  if (!p || p.id !== s.pendingId || p.kind !== 'permission') { pop(ctx); return render(ctx); }
  const decide = (decision) => async () => {
    await post(ctx, '/api/term-pending/' + encodeURIComponent(s.key) + '/answer', { id: s.pendingId, answer: { decision } });
    m.term.pending = null;
    pop(ctx);
  };
  m.items = [
    { text: 'Allow', run: decide('allow') },
    { text: 'Deny', run: decide('deny') },
    { text: 'Ask on the terminal', run: () => release(ctx, s) },
  ];
  return { containers: [
    { type: 'text', name: 'q', x: 0, y: 0, w: 576, h: 62, text: truncate(`Allow ${p.payload.tool_name}? ${summarizeInput(p.payload.tool_input)}`, 120), textColor: 3 },
    { type: 'list', name: 'opts', x: 0, y: 62, w: 576, h: 226, items: m.items.map((i) => i.text), capture: true },
  ] };
}

function render(ctx) {
  const m = mem(ctx);
  const s = top(ctx);
  let view;
  switch (s.kind) {
    case 'sessions': view = sessionsView(ctx, s); break;
    case 'folder': view = folderView(ctx, s); break;
    case 'file': view = fileView(ctx, s); break;
    case 'term': view = termView(ctx, s); break;
    case 'listen': view = { text: `${ICON.busy} Listening…\n\n${s.purpose === 'answer' ? 'Speak your answer.' : 'Speak your prompt.'}\n\nrelease to stop` }; break;
    case 'confirm': view = { text: s.busy ? s.busy : `${s.purpose === 'answer' ? 'Answer with this?' : 'Send this?'}\n\n${s.text}\n\ntap = send · double-tap = discard` }; break;
    case 'question': view = questionView(ctx, s); break;
    case 'permission': view = permissionView(ctx, s); break;
    default: view = { text: 'claude-hub' };
  }
  if (m.status) {
    const note = m.status; m.status = '';
    if (typeof view === 'string') view = `! ${note}\n${view}`;
    else if (view.text !== undefined) view = { ...view, text: `! ${note}\n${view.text}` };
    else ctx.notify(note, { ms: 2500 });
  }
  return view;
}

function fail(ctx, e) {
  mem(ctx).status = e && e.message ? e.message : String(e);
  ctx.render();
}

// ---------- the app ----------
/** @type {import('../../../omnieven/shared/app.ts').OmniApp} */
export default {
  title: 'claude-hub',
  order: 1,
  menu: [{ id: 'sessions', label: 'Sessions' }, { id: 'explorer', label: 'Explorer' }],

  init(ctx) {
    mem(ctx);
    ctx.setInterval(() => { if (ctx.mem.open) pollOnce(ctx).catch(() => {}); }, POLL_MS);
  },

  render(ctx) { return render(ctx); },

  onOpen(ctx) { ctx.mem.open = true; delete mem(ctx).cache.sessions; },
  onClose(ctx) { ctx.mem.open = false; cancelListening(ctx); },

  onAudio(ctx, pcm) { const m = mem(ctx); if (m.listening) m.pcm.push(pcm); },

  // POST /api/apps/claude-hub/message — push a view onto the glasses from
  // outside (the hub, a script, a test): {open: {session|file|folder}} or
  // {nav: 'sessions'}. Returns what is now on top.
  async onMessage(ctx, msg) {
    const m = mem(ctx);
    const o = (msg && msg.open) || {};
    if (msg && msg.nav === 'sessions') { m.nav = [{ kind: 'sessions', page: 0 }]; delete m.cache.sessions; }
    else if (typeof o.session === 'string') {
      const sessions = await loadSessions(ctx);
      const s = sessions.find((x) => x.termKey === o.session || x.id === o.session);
      if (!s) return { ok: false, error: 'no such session' };
      m.nav = [{ kind: 'sessions', page: 0 }];
      await openTerm(ctx, s);
    } else if (typeof o.file === 'string') { m.nav = [{ kind: 'sessions', page: 0 }, { kind: 'file', path: o.file }]; }
    else if (typeof o.folder === 'string') { m.nav = [{ kind: 'sessions', page: 0 }, { kind: 'folder', path: o.folder, page: 0 }]; }
    else return { ok: false, error: 'nothing to open' };
    ctx.render();
    return { ok: true, top: top(ctx) };
  },

  // Omni reads the return value synchronously: a Promise is not `true`, so
  // an async handler would let the default binding (double-tap → home) run
  // on every gesture. Decide here, do the work in the background (B34).
  onEvent(ctx, ev) {
    const m = mem(ctx);
    const s = top(ctx);
    const go = (p) => { Promise.resolve(p).then(() => ctx.render()).catch((e) => fail(ctx, e)); return true; };
    switch (ev.type) {
      case 'select': {
        const item = m.items[ev.index];
        return item ? go(item.run()) : true;
      }
      case 'tap': {
        if (s.kind === 'confirm' && s.text) {
          return go((async () => {
            if (s.purpose === 'prompt') { await post(ctx, '/api/term-input/' + encodeURIComponent(s.key), { text: s.text, enter: true }); pop(ctx); }
            else { pop(ctx); await applySpokenAnswer(ctx, s.text); }
            if (m.term) m.term.frozen = false;
          })());
        }
        if (s.kind === 'term') { m.term.frozen = false; return go(pollOnce(ctx)); }
        return false;
      }
      case 'double': {
        if (s.kind === 'question' || s.kind === 'permission') return go(release(ctx, s));
        if (s.kind === 'listen') return go(cancelListening(ctx));
        if (m.nav.length > 1) { pop(ctx); if (top(ctx).kind === 'sessions') delete m.cache.sessions; ctx.render(); return true; }
        return false;   // at the root: Omni's default (home)
      }
      case 'up':
      case 'down': {
        if (s.kind === 'term') {
          // Native scrolling reports the edges: at the top the reader is
          // looking back — freeze the capture and let tmux scroll the app's
          // own history; at the bottom go live again.
          const wasFrozen = m.term.frozen;
          m.term.frozen = ev.type === 'up';
          return go((async () => {
            if (ev.type === 'up' && wasFrozen) await post(ctx, '/api/term-scroll/' + encodeURIComponent(s.key), { lines: -10 });
            if (ev.type === 'down' && !wasFrozen) await post(ctx, '/api/term-scroll/' + encodeURIComponent(s.key), { lines: 10 });
            await pollOnce(ctx);
          })());
        }
        if (s.kind === 'file') {
          const lines = (m.cache['file:' + s.path] || '').split('\n');
          const step = 20;
          const offset = Math.max(0, Math.min(lines.length - 1, (s.offset || 0) + (ev.type === 'down' ? step : -step)));
          if (offset !== (s.offset || 0)) { replace(ctx, { ...s, offset }); ctx.render(); }
          return true;
        }
        return false;
      }
      case 'longpress': {
        if (s.kind === 'term') return go(startListening(ctx, 'prompt'));
        if (s.kind === 'question') return go(startListening(ctx, 'answer'));
        return false;
      }
      case 'release': {
        return m.listening ? go(stopListening(ctx)) : false;
      }
      case 'exit': { ctx.mem.open = false; void cancelListening(ctx); return false; }
      case 'enter': { ctx.mem.open = true; return false; }
      default: return false;
    }
  },

  async onMenu(ctx, id) {
    const m = mem(ctx);
    const s = top(ctx);
    try {
      if (id === 'sessions') { m.nav = [{ kind: 'sessions', page: 0 }]; delete m.cache.sessions; }
      else if (id === 'explorer') { m.nav = [{ kind: 'sessions', page: 0 }, { kind: 'folder', path: '', page: 0 }]; }
      else if (id === 'refresh') { for (const k of Object.keys(m.cache)) delete m.cache[k]; }
      else if (id === 'here' && s.kind === 'folder') { await terminalHere(ctx, s.path); }
      else if (id === 'suspend' && s.kind === 'term') { await post(ctx, '/api/v2/term/' + encodeURIComponent(s.key) + '/suspend', {}); m.status = 'suspended'; pop(ctx); delete m.cache.sessions; }
      else if (id === 'back' && (s.kind === 'question' || s.kind === 'permission')) { await release(ctx, s); }
    } catch (e) { fail(ctx, e); return; }
    ctx.render();
  },
};
