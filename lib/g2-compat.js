// Read-only v1 routes the G2 glasses app (claude-hub-g2) still calls,
// re-implemented on v2 data so the v1 code could go (SPEC §V97). Delete
// this file when claude-hub-g2 is ported to /api/v2/*.
//
//   GET /api/projects                → top-level folders as "projects"
//   GET /api/term-sessions/<proj>    → hub sessions whose cwd is that folder
//   GET /api/view-tree/<proj>?path=  → one folder level, v1 tree shape
//   GET /view/<proj>/<path>?raw=1    → 302 to the v2 raw endpoint
//
// The glasses build a terminal key as `<proj>__<id>`; a migrated session's
// id is its old `sN`, and for a `hub-…` session the relay canonicalises
// `<proj>__hub-…` back to `hub-…` (server.js, canonicalTermKey).
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readmeMetaFromContent } = require('./readme-meta');
const { PROJECT_ID_RE, RESERVED_PROJECT_NAMES } = require('./project-name');

function isProjectName(name) {
  return PROJECT_ID_RE.test(name) && !name.startsWith('.') && !RESERVED_PROJECT_NAMES.has(name);
}

function makeG2Compat({ projectsRoot, sendJson, fsApi, listSessions }) {
  function listProjects() {
    let entries;
    try { entries = fs.readdirSync(projectsRoot, { withFileTypes: true }); } catch { entries = []; }
    const out = [];
    for (const e of entries) {
      if (!e.isDirectory() || !isProjectName(e.name)) continue;
      const dir = path.join(projectsRoot, e.name);
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(path.join(dir, '.project-meta.json'), 'utf8')) || {}; } catch {}
      let readme = { title: null, description: null, tags: [] };
      try { readme = readmeMetaFromContent(fs.readFileSync(path.join(dir, 'README.md'), 'utf8')); } catch {}
      let createdAt = typeof meta.createdAt === 'string' ? meta.createdAt : null;
      if (!createdAt) { try { createdAt = fs.statSync(dir).birthtime.toISOString(); } catch { createdAt = new Date(0).toISOString(); } }
      out.push({
        name: e.name,
        title: meta.title || readme.title || e.name,
        description: meta.description || readme.description || '',
        tags: Array.isArray(readme.tags) ? readme.tags : [],
        openUrl: typeof meta.openUrl === 'string' ? meta.openUrl : '/',
        worktreeOf: typeof meta.worktreeOf === 'string' ? meta.worktreeOf : null,
        branch: typeof meta.branch === 'string' ? meta.branch : null,
        createdAt,
        termUrl: '/', browseUrl: '/',
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async function handle(req, res, url) {
    const q = url.indexOf('?');
    const p = q < 0 ? url : url.slice(0, q);
    const query = new URLSearchParams(q < 0 ? '' : url.slice(q + 1));
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    if (p === '/api/projects') { sendJson(res, 200, { projects: listProjects() }); return true; }
    const exists = (proj) => { try { return fs.statSync(path.join(projectsRoot, proj)).isDirectory(); } catch { return false; } };
    let m = /^\/api\/term-sessions\/([^/]+)$/.exec(p);
    if (m) {
      const proj = decodeURIComponent(m[1]);
      if (!isProjectName(proj) || !exists(proj)) { sendJson(res, 404, { error: 'unknown project' }); return true; }
      const sessions = (await listSessions()).filter((s) => s.cwd === proj && s.agent !== 'shell').map((s) => ({
        id: s.termKey.startsWith(proj + '__') ? s.termKey.slice(proj.length + 2) : s.termKey,
        uuid: s.uuid, agent: s.agent, title: s.title || null, termKey: s.termKey, running: s.running,
      }));
      sendJson(res, 200, { sessions, lastActive: null });
      return true;
    }
    m = /^\/api\/view-tree\/([^/]+)$/.exec(p);
    if (m) {
      const proj = decodeURIComponent(m[1]);
      if (!isProjectName(proj) || !exists(proj)) { sendJson(res, 404, { error: 'unknown project' }); return true; }
      const sub = (query.get('path') || '').replace(/^\/+|\/+$/g, '');
      let listing;
      try { listing = fsApi.list(sub ? proj + '/' + sub : proj); }
      catch (e) { sendJson(res, Number.isInteger(e.statusCode) ? e.statusCode : 500, { error: e.message }); return true; }
      const entries = listing.entries.map((en) => ({
        name: en.name, type: en.kind === 'dir' ? 'dir' : 'file',
        path: en.path.slice(proj.length + 1), dim: en.dim || undefined,
        ...(en.kind === 'dir' ? { children: [] } : {}),
      }));
      sendJson(res, 200, { project: proj, path: sub, entries });
      return true;
    }
    m = /^\/view\/([^/]+)\/(.+)$/.exec(p);
    if (m) {
      const proj = decodeURIComponent(m[1]);
      if (!isProjectName(proj)) { sendJson(res, 404, { error: 'unknown project' }); return true; }
      let rel;
      try { rel = m[2].split('/').map(decodeURIComponent).join('/'); } catch { sendJson(res, 400, { error: 'bad path' }); return true; }
      res.writeHead(302, { Location: '/api/v2/fs/raw?path=' + encodeURIComponent(proj + '/' + rel) });
      res.end();
      return true;
    }
    return false;
  }

  return { handle, listProjects };
}

module.exports = { makeG2Compat };
