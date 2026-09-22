// Hub v2 profiles (SPEC §V82).
//
// A profile is one person's workspace: the tabs they have open, how those
// tabs are laid out, and the instructions every claude session they launch
// gets appended to its system prompt. Stored under the hub state dir:
//
//   <dir>/profiles/<id>/profile.json   { id, name, color, createdAt, updatedAt, rev, layout, tabs }
//   <dir>/profiles/<id>/CLAUDE.md      per-profile instructions (may be absent / empty)
//
// `rev` is a write counter: a client sends back the rev it loaded and a
// stale one is refused (409) so two devices on the same profile cannot
// silently overwrite each other's layout. WHICH profile a browser uses is
// its own business (localStorage) — the server never picks one.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const L = require('./v2-layout');

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_COLORS = ['#7dd3fc', '#f9a8d4', '#86efac', '#fbbf24', '#c4b5fd', '#fca5a5'];
const MAX_INSTRUCTIONS = 64 * 1024;
const MAX_TABS = 400;
const TAB_KINDS = new Set(['home', 'term', 'file', 'browse', 'service', 'url']);

function httpError(status, message) { const e = new Error(message); e.statusCode = status; return e; }

function slugify(name) {
  return String(name || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function isValidTabs(tabs) {
  if (!tabs || typeof tabs !== 'object' || Array.isArray(tabs)) return false;
  const keys = Object.keys(tabs);
  if (keys.length > MAX_TABS) return false;
  return keys.every((k) => /^[A-Za-z0-9_-]{1,40}$/.test(k)
    && tabs[k] && typeof tabs[k] === 'object' && TAB_KINDS.has(tabs[k].kind)
    && JSON.stringify(tabs[k]).length <= 4096);
}

function makeProfileStore({ dir }) {
  const base = path.join(dir, 'profiles');

  function profileDir(id) { return path.join(base, id); }
  function profilePath(id) { return path.join(profileDir(id), 'profile.json'); }
  function instructionsPath(id) { return path.join(profileDir(id), 'CLAUDE.md'); }

  function readOne(id) {
    let raw;
    try { raw = fs.readFileSync(profilePath(id), 'utf8'); } catch { return null; }
    try {
      const p = JSON.parse(raw);
      if (!p || p.id !== id) return null;
      return p;
    } catch { return null; }
  }

  function write(p) {
    fs.mkdirSync(profileDir(p.id), { recursive: true });
    const tmp = profilePath(p.id) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(p, null, 2) + '\n');
    fs.renameSync(tmp, profilePath(p.id));
  }

  function summary(p) {
    return { id: p.id, name: p.name, color: p.color, createdAt: p.createdAt, updatedAt: p.updatedAt, rev: p.rev, tabCount: Object.keys(p.tabs || {}).length };
  }

  function list() {
    let ids;
    try { ids = fs.readdirSync(base).filter((n) => ID_RE.test(n)); } catch { return []; }
    return ids.map(readOne).filter(Boolean).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(summary);
  }

  function get(id) {
    if (!ID_RE.test(String(id))) throw httpError(400, 'bad profile id');
    const p = readOne(id);
    if (!p) throw httpError(404, 'unknown profile');
    let instructions = '';
    try { instructions = fs.readFileSync(instructionsPath(id), 'utf8'); } catch {}
    return { ...p, instructions };
  }

  function create({ name, color, instructions } = {}) {
    const clean = String(name || '').trim();
    if (!clean || clean.length > 60) throw httpError(400, 'name required (≤ 60 chars)');
    let id = slugify(clean);
    if (!ID_RE.test(id)) throw httpError(400, 'name needs at least one letter or digit');
    if (readOne(id)) throw httpError(409, `profile "${id}" already exists`);
    const existing = list();
    const c = COLOR_RE.test(String(color)) ? color : DEFAULT_COLORS[existing.length % DEFAULT_COLORS.length];
    const now = new Date().toISOString();
    const homeTab = L.randomId('t');
    const p = {
      id, name: clean, color: c, createdAt: now, updatedAt: now, rev: 1,
      layout: L.createLayout(L.randomId('p'), [homeTab]),
      tabs: { [homeTab]: { kind: 'home', title: 'Home' } },
    };
    write(p);
    if (typeof instructions === 'string' && instructions.trim()) writeInstructions(id, instructions);
    return get(id);
  }

  // Patch: {layout?, tabs?, name?, color?, rev?}. layout + tabs always land
  // together (a layout naming tabs the map lacks is a broken workspace).
  function update(id, patch = {}) {
    const p = get(id);
    if (patch.rev !== undefined && Number(patch.rev) !== p.rev) {
      const e = httpError(409, 'profile changed elsewhere; reload'); e.rev = p.rev; throw e;
    }
    if (patch.name !== undefined) {
      const clean = String(patch.name).trim();
      if (!clean || clean.length > 60) throw httpError(400, 'bad name');
      p.name = clean;
    }
    if (patch.color !== undefined) {
      if (!COLOR_RE.test(String(patch.color))) throw httpError(400, 'bad color');
      p.color = patch.color;
    }
    if (patch.layout !== undefined || patch.tabs !== undefined) {
      const layout = patch.layout !== undefined ? patch.layout : p.layout;
      const tabs = patch.tabs !== undefined ? patch.tabs : p.tabs;
      if (!L.isConsistent(layout)) throw httpError(400, 'bad layout');
      if (!isValidTabs(tabs)) throw httpError(400, 'bad tabs');
      for (const t of L.allTabs(layout)) if (!tabs[t]) throw httpError(400, `layout references unknown tab ${t}`);
      p.layout = L.normalize(layout);
      p.tabs = tabs;
    }
    p.rev += 1;
    p.updatedAt = new Date().toISOString();
    const { instructions: _i, ...disk } = p;
    write(disk);
    if (typeof patch.instructions === 'string') writeInstructions(id, patch.instructions);
    return get(id);
  }

  function writeInstructions(id, text) {
    if (!ID_RE.test(String(id))) throw httpError(400, 'bad profile id');
    if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_INSTRUCTIONS) throw httpError(400, 'instructions too large');
    fs.mkdirSync(profileDir(id), { recursive: true });
    fs.writeFileSync(instructionsPath(id), text);
  }

  function remove(id) {
    if (!ID_RE.test(String(id))) throw httpError(400, 'bad profile id');
    if (!readOne(id)) throw httpError(404, 'unknown profile');
    fs.rmSync(profileDir(id), { recursive: true, force: true });
    return { id, deleted: true };
  }

  return { list, get, create, update, remove, writeInstructions, instructionsPath, ID_RE };
}

module.exports = { makeProfileStore, slugify, isValidTabs, ID_RE, TAB_KINDS };
