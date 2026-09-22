// Hub-side session titles (SPEC §V90).
//
// Claude Code names a session once (`ai-title`) and again only when the user
// runs `/rename`; a long session's purpose drifts away from either. The
// Stop hook in services/session-title-hook.mjs asks Haiku for a fresh title
// after each turn and POSTs it here, keyed by the conversation uuid — the one
// id a hub session, a v1 tab and the hook all share. Stored at
// <HUB_STATE_DIR>/titles.json: { "<uuid>": { title, at, source } }.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TITLE = 80;
const MAX_ENTRIES = 2000;
const MAX_AGE_MS = 90 * 24 * 3600 * 1000;

function httpError(status, message) { const e = new Error(message); e.statusCode = status; return e; }

// One line, no wrapping quotes, no trailing period, ≤ MAX_TITLE chars.
function cleanTitle(raw) {
  let t = String(raw == null ? '' : raw).split('\n').map((l) => l.trim()).find(Boolean) || '';
  t = t.replace(/^(title:\s*)/i, '').replace(/^["'`“”]+|["'`“”]+$/g, '').replace(/[.\s]+$/g, '').trim();
  if (t.length > MAX_TITLE) t = t.slice(0, MAX_TITLE - 1).replace(/\s+\S*$/, '') + '…';
  return t;
}

function makeTitleStore({ dir }) {
  const file = path.join(dir, 'titles.json');

  function readAll() {
    try {
      const o = JSON.parse(fs.readFileSync(file, 'utf8'));
      return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
    } catch { return {}; }
  }

  function writeAll(map) {
    const cutoff = Date.now() - MAX_AGE_MS;
    let entries = Object.entries(map).filter(([k, v]) => UUID_RE.test(k) && v && typeof v.title === 'string' && Number(v.at) > cutoff);
    entries.sort((a, b) => Number(b[1].at) - Number(a[1].at));
    entries = entries.slice(0, MAX_ENTRIES);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(entries), null, 2) + '\n');
    fs.renameSync(tmp, file);
  }

  function get(uuid) {
    if (!UUID_RE.test(String(uuid))) throw httpError(400, 'bad uuid');
    const v = readAll()[uuid.toLowerCase()];
    return v ? { uuid: uuid.toLowerCase(), ...v } : null;
  }

  function set(uuid, title, source = 'auto') {
    if (!UUID_RE.test(String(uuid))) throw httpError(400, 'bad uuid');
    const t = cleanTitle(title);
    if (!t) throw httpError(400, 'title required');
    const map = readAll();
    const rec = { title: t, at: Date.now(), source: source === 'user' ? 'user' : 'auto' };
    map[uuid.toLowerCase()] = rec;
    writeAll(map);
    return { uuid: uuid.toLowerCase(), ...rec };
  }

  function remove(uuid) {
    if (!UUID_RE.test(String(uuid))) throw httpError(400, 'bad uuid');
    const map = readAll();
    delete map[uuid.toLowerCase()];
    writeAll(map);
    return { uuid: uuid.toLowerCase(), deleted: true };
  }

  // Cheap lookup for list views: one read, many gets.
  function lookup() {
    const map = readAll();
    return (uuid) => (uuid && map[String(uuid).toLowerCase()]) ? map[String(uuid).toLowerCase()].title : null;
  }

  return { get, set, remove, lookup, cleanTitle };
}

module.exports = { makeTitleStore, cleanTitle, UUID_RE, MAX_TITLE };
