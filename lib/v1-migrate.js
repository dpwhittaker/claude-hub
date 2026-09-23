// One-shot migration of v1 develop tabs into hub sessions (SPEC §V96).
//
// v1 kept one `.develop-sessions.json` per project (`sN: {uuid, agent}`),
// one `ttyd@<project>__sN.service` per tab, and a tmux session named
// `<project>__sN`. A hub session is one JSON record under
// ~/.claude-hub/sessions/ served by the single ttyd-hub unit. The move:
//
//   • every tab whose tmux session is still alive becomes a hub session that
//     KEEPS that tmux name (`termKey`), so nothing running is touched — the
//     registry, the glasses relay and the browser all keep working;
//   • a tab whose tmux session is gone is not migrated: it expires, exactly
//     as if it had been ended (the conversation stays resumable by uuid);
//   • profile tabs that pointed at a migrated key get the new session id and
//     the /term/hub/ URL;
//   • each map is renamed `.develop-sessions.json.v1` so nothing reads it
//     again (they are untracked everywhere).
//
// Pure apart from the disk reads/writes it is told about: tmux liveness and
// the registry are injected.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TAB_ID_RE = /^s[1-9][0-9]*$/;

function readMap(file) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
  const out = {};
  for (const [k, v] of Object.entries((parsed && parsed.sessions) || {})) {
    if (!TAB_ID_RE.test(k)) continue;
    if (typeof v === 'string' && v) out[k] = { uuid: v, agent: 'claude' };
    else if (v && typeof v.uuid === 'string' && v.uuid) out[k] = { uuid: v.uuid, agent: v.agent === 'codex' ? 'codex' : 'claude' };
  }
  return out;
}

// → { migrated: [{key, id, cwd, agent}], expired: [key], maps: [file] }
function migrateV1({ projectsRoot, sessions, profiles, liveTmux, registry = new Map(), rename = true, now = () => new Date().toISOString() }) {
  const migrated = []; const expired = []; const maps = [];
  const byKey = new Map();
  let entries;
  try { entries = fs.readdirSync(projectsRoot, { withFileTypes: true }); } catch { return { migrated, expired, maps, retargeted: 0 }; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const file = path.join(projectsRoot, e.name, '.develop-sessions.json');
    if (!fs.existsSync(file)) continue;
    maps.push(file);
    for (const [tab, entry] of Object.entries(readMap(file))) {
      const key = `${e.name}__${tab}`;
      if (!liveTmux.has(key)) { expired.push(key); continue; }
      const reg = registry.get(key);
      const already = sessions.list().find((s) => s.termKey === key);
      const s = already || sessions.create({ cwd: e.name, agent: entry.agent, termKey: key, uuid: (reg && reg.sessionId) || entry.uuid, createdAt: now() });
      byKey.set(key, s);
      migrated.push({ key, id: s.id, cwd: e.name, agent: entry.agent, reused: !!already });
    }
    if (rename) fs.renameSync(file, file + '.v1');
  }
  // Profile tabs: a term tab keyed by a migrated tmux name becomes that session's tab.
  let retargeted = 0;
  for (const summary of profiles.list()) {
    const p = profiles.get(summary.id);
    let changed = false;
    for (const t of Object.values(p.tabs || {})) {
      if (t.kind !== 'term' || !byKey.has(t.termKey)) continue;
      const s = byKey.get(t.termKey);
      if (t.sessionId === s.id && t.termUrl === s.termUrl) continue;
      t.sessionId = s.id; t.termUrl = s.termUrl; changed = true; retargeted += 1;
    }
    if (changed) profiles.update(p.id, { layout: p.layout, tabs: p.tabs });
  }
  return { migrated, expired, maps, retargeted };
}

module.exports = { migrateV1, readMap };
