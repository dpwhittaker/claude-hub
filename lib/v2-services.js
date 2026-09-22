// Hub v2 services (SPEC §V85).
//
// A service is a systemd unit the user maintains on this box, optionally
// reachable at a URL. Discovery, not registration: the set is
//
//   • every regular *.service file in /etc/systemd/system that runs as the
//     hub's user or works in their home (units the user installed — the hub,
//     stt, gpu-gate, omni, …). Distro units live in /lib and are symlinked
//     here at most; cloud-init/snap drop real files here but run as root, so
//     the User=/WorkingDirectory= check is what separates "mine" from "the
//     box's". Anything else can be opted in by name in services.json,
//   • every vite@ / jekyll@ instance systemd knows about,
//   • every unit a project sentinel names in `extraUnits`,
//
// minus the ttyd family, which are sessions, not services. URLs come from the
// project sentinels (proxyPrefix / openUrl) and, for the rest, from an
// optional <hubDir>/services.json override. `tailscale serve status` is
// parsed alongside so ports exposed on the tailnet show up too.
//
// The parsers are pure; `makeServiceLister` takes an injectable exec so tests
// never touch systemctl.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const UNIT_RE = /^[A-Za-z0-9][A-Za-z0-9@._-]{0,200}\.service$/;
const SESSION_UNIT_RE = /^ttyd(@|-)/;
const ACTIONS = new Set(['start', 'stop', 'restart']);
const SHOW_PROPS = ['Id', 'Description', 'ActiveState', 'SubState', 'MainPID', 'ExecMainStartTimestamp', 'UnitFileState'];

function isUnitName(s) { return typeof s === 'string' && UNIT_RE.test(s) && !s.includes('/'); }

// `systemctl show -p … a.service b.service` → one blank-line-separated
// block of KEY=VALUE per unit.
function parseSystemctlShow(text) {
  const out = [];
  for (const block of String(text || '').split(/\n\s*\n/)) {
    const rec = {};
    for (const line of block.split('\n')) {
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      rec[line.slice(0, eq)] = line.slice(eq + 1);
    }
    if (rec.Id) out.push(rec);
  }
  return out;
}

// `tailscale serve status`:
//   https://host.ts.net:8443 (tailnet only)
//   |-- / proxy http://localhost:4096
function parseTailscaleServeStatus(text) {
  const out = [];
  let current = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const head = /^(https?:\/\/\S+)\s*(\(.*\))?$/.exec(line);
    if (head) { current = { url: head[1], scope: (head[2] || '').replace(/[()]/g, '').trim(), mounts: [] }; out.push(current); continue; }
    const mount = /^\|--\s+(\S+)\s+(\w+)\s+(.+)$/.exec(line);
    if (mount && current) current.mounts.push({ path: mount[1], mode: mount[2], target: mount[3].trim() });
  }
  return out;
}

function parseListUnits(text) {
  return String(text || '').split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((n) => n && n.endsWith('.service'));
}

function readSentinels(projectsRoot) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(projectsRoot, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(projectsRoot, e.name, '.project-meta.json'), 'utf8'));
      out.push({ name: e.name, meta: meta && typeof meta === 'object' ? meta : {} });
    } catch {}
  }
  return out;
}

function unitIsUsers(text, user, home) {
  const u = /^User=(.+)$/m.exec(text);
  if (u && u[1].trim() === user) return true;
  const w = /^WorkingDirectory=(.+)$/m.exec(text);
  return !!(w && (w[1].trim() === home || w[1].trim().startsWith(home + '/')));
}

function makeServiceLister({ projectsRoot, hubDir, exec, unitDir = '/etc/systemd/system', user = os.userInfo().username, home = os.homedir() }) {
  // exec(cmd, args) → Promise<{stdout}>; rejections are swallowed per source.
  async function run(cmd, args) {
    try { return (await exec(cmd, args)).stdout || ''; } catch { return ''; }
  }

  function readOverrides() {
    try {
      const o = JSON.parse(fs.readFileSync(path.join(hubDir, 'services.json'), 'utf8'));
      return o && typeof o === 'object' ? o : {};
    } catch { return {}; }
  }

  function localUnitFiles() {
    let names;
    try { names = fs.readdirSync(unitDir, { withFileTypes: true }); } catch { return []; }
    const out = [];
    for (const d of names) {
      if (!d.isFile() || d.isSymbolicLink() || !d.name.endsWith('.service') || d.name.includes('@')) continue;
      let text;
      try { text = fs.readFileSync(path.join(unitDir, d.name), 'utf8'); } catch { continue; }
      if (unitIsUsers(text, user, home)) out.push(d.name);
    }
    return out;
  }

  async function discoverUnits() {
    const sentinels = readSentinels(projectsRoot);
    const byUnit = new Map(); // unit → {project, url, title}
    const add = (unit, info) => {
      if (!isUnitName(unit) || SESSION_UNIT_RE.test(unit)) return;
      byUnit.set(unit, { ...(byUnit.get(unit) || {}), ...info });
    };
    for (const u of localUnitFiles()) add(u, {});
    for (const u of parseListUnits(await run('systemctl', ['list-units', 'vite@*.service', 'jekyll@*.service', '--all', '--plain', '--no-legend']))) add(u, {});
    for (const { name, meta } of sentinels) {
      const url = typeof meta.openUrl === 'string' && meta.openUrl.startsWith('/') ? meta.openUrl
        : (meta.proxyTarget ? `${typeof meta.proxyPrefix === 'string' && meta.proxyPrefix.startsWith('/') ? meta.proxyPrefix : '/' + name}/` : null);
      const info = { project: name, url };
      if (Array.isArray(meta.extraUnits)) for (const u of meta.extraUnits) if (typeof u === 'string') add(u, info);
      for (const u of byUnit.keys()) {
        const m = /^(vite|jekyll)@(.+)\.service$/.exec(u);
        if (m && m[2] === name) add(u, info);
      }
    }
    const overrides = readOverrides();
    for (const [u, o] of Object.entries(overrides)) {
      if (o && typeof o === 'object') add(u, { url: typeof o.url === 'string' ? o.url : undefined, title: typeof o.title === 'string' ? o.title : undefined });
    }
    return byUnit;
  }

  async function list() {
    const byUnit = await discoverUnits();
    const units = [...byUnit.keys()].sort();
    const shown = units.length
      ? parseSystemctlShow(await run('systemctl', ['show', '-p', SHOW_PROPS.join(','), ...units]))
      : [];
    const state = new Map(shown.map((r) => [r.Id, r]));
    const services = units.map((unit) => {
      const s = state.get(unit) || {};
      const info = byUnit.get(unit);
      return {
        unit,
        title: info.title || unit.replace(/\.service$/, ''),
        description: s.Description || '',
        active: s.ActiveState || 'unknown',
        sub: s.SubState || '',
        enabled: s.UnitFileState || '',
        pid: Number(s.MainPID) || 0,
        since: s.ExecMainStartTimestamp || '',
        project: info.project || null,
        url: info.url || null,
      };
    });
    const tailnet = parseTailscaleServeStatus(await run('tailscale', ['serve', 'status']));
    return { services, tailnet };
  }

  async function isKnownUnit(unit) {
    return (await discoverUnits()).has(unit);
  }

  return { list, isKnownUnit, discoverUnits };
}

module.exports = { makeServiceLister, unitIsUsers, parseSystemctlShow, parseTailscaleServeStatus, parseListUnits, isUnitName, ACTIONS, SESSION_UNIT_RE };
