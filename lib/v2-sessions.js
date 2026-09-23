// Hub v2 sessions (SPEC §V83, §V84).
//
// A session is an agent (claude, codex or a plain shell) running in a tmux
// session in some folder under PROJECTS_ROOT — no project needed. Every
// session is one small JSON file, so the attach script can read exactly one
// record per connection without parsing a growing map:
//
//   <dir>/sessions/<id>.json     { id, cwd, agent, uuid, profile, title, createdAt }
//   <dir>/sessions/<id>.prompt   optional first prompt, consumed by the attach script
//
// One ttyd unit serves them all (`ttyd-hub.service`, `--url-arg`): the tab
// loads /term/hub/?arg=<id>, ttyd runs `ttyd-attach-hub.sh <id>`, and that
// attaches to tmux session `hub-<id>` — creating it on first use. So creating
// a session here is a file write, not a `sudo systemctl enable`.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolveUnder } = require('./v2-paths');

const ID_RE = /^[a-z0-9]{8}$/;
const TERM_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const AGENTS = Object.freeze(['claude', 'codex', 'shell']);
const TERM_UNIT_KEY = 'hub';
const MAX_PROMPT = 8192;

function httpError(status, message) { const e = new Error(message); e.statusCode = status; return e; }

function newId() {
  let s = '';
  while (s.length < 8) s += crypto.randomBytes(8).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '');
  return s.slice(0, 8);
}

function termKey(id) { return 'hub-' + id; }
function termUrl(id) { return `/term/${TERM_UNIT_KEY}/?arg=${encodeURIComponent(id)}`; }

function makeSessionStore({ dir, projectsRoot }) {
  const base = path.join(dir, 'sessions');
  const file = (id) => path.join(base, id + '.json');
  const promptFile = (id) => path.join(base, id + '.prompt');

  function readOne(id) {
    try {
      const s = JSON.parse(fs.readFileSync(file(id), 'utf8'));
      return s && s.id === id ? s : null;
    } catch { return null; }
  }

  function write(s) {
    fs.mkdirSync(base, { recursive: true });
    const tmp = file(s.id) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
    fs.renameSync(tmp, file(s.id));
  }

  // `termKey` = the tmux session name. New sessions get `hub-<id>`; a
  // session migrated from v1 keeps the name its tmux session already has
  // (`<project>__sN`), so nothing live was renamed (V96).
  function decorate(s) {
    return { ...s, kind: 'hub', termKey: s.termKey || termKey(s.id), termUrl: termUrl(s.id) };
  }

  function list() {
    let names;
    try { names = fs.readdirSync(base); } catch { return []; }
    return names.filter((n) => n.endsWith('.json')).map((n) => readOne(n.slice(0, -5))).filter(Boolean)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map(decorate);
  }

  function get(id) {
    if (!ID_RE.test(String(id))) throw httpError(400, 'bad session id');
    const s = readOne(id);
    if (!s) throw httpError(404, 'unknown session');
    return decorate(s);
  }

  function create({ cwd, agent, profile, title, prompt, termKey: key, uuid: fixedUuid, createdAt } = {}) {
    const a = agent === undefined ? 'claude' : agent;
    if (!AGENTS.includes(a)) throw httpError(400, 'unknown agent');
    const { rel, abs } = resolveUnder(projectsRoot, cwd || '');
    let st;
    try { st = fs.statSync(abs); } catch { throw httpError(404, 'cwd not found'); }
    if (!st.isDirectory()) throw httpError(400, 'cwd is not a directory');
    if (profile !== undefined && profile !== null && !/^[a-z0-9][a-z0-9-]{0,39}$/.test(String(profile))) throw httpError(400, 'bad profile id');
    if (prompt !== undefined && prompt !== null && (typeof prompt !== 'string' || prompt.length > MAX_PROMPT)) throw httpError(400, 'bad prompt');
    if (title !== undefined && title !== null && (typeof title !== 'string' || title.length > 120)) throw httpError(400, 'bad title');
    if (key !== undefined && key !== null && !TERM_KEY_RE.test(String(key))) throw httpError(400, 'bad termKey');
    if (fixedUuid !== undefined && fixedUuid !== null && !/^[0-9a-f-]{36}$/i.test(String(fixedUuid))) throw httpError(400, 'bad uuid');
    let id = newId();
    while (readOne(id)) id = newId();
    const s = {
      id, cwd: rel, agent: a, uuid: fixedUuid || crypto.randomUUID(), profile: profile || null,
      title: title || null, createdAt: createdAt || new Date().toISOString(),
    };
    if (key) s.termKey = key;
    write(s);
    if (prompt && prompt.trim()) fs.writeFileSync(promptFile(id), prompt);
    return decorate(s);
  }

  function update(id, patch = {}) {
    const s = get(id);
    if (patch.title !== undefined) {
      if (patch.title !== null && (typeof patch.title !== 'string' || patch.title.length > 120)) throw httpError(400, 'bad title');
      s.title = patch.title;
    }
    // A `--resume` / `/clear` moves the conversation to a new id; the hub
    // follows it (from Claude's registry) so a reboot resumes the right one.
    if (patch.uuid !== undefined) {
      if (typeof patch.uuid !== 'string' || !/^[0-9a-f-]{36}$/i.test(patch.uuid)) throw httpError(400, 'bad uuid');
      s.uuid = patch.uuid;
    }
    const { kind: _k, termKey: tk, termUrl: _tu, ...disk } = s;
    if (tk && tk !== termKey(s.id)) disk.termKey = tk;
    write(disk);
    return decorate(disk);
  }

  function remove(id) {
    const s = get(id);
    fs.rmSync(file(s.id), { force: true });
    fs.rmSync(promptFile(s.id), { force: true });
    return { id: s.id, deleted: true };
  }

  return { list, get, create, update, remove, termKey, termUrl };
}

module.exports = { makeSessionStore, ID_RE, TERM_KEY_RE, AGENTS, TERM_UNIT_KEY, termKey, termUrl, newId };
