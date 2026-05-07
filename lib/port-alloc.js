const fs = require('fs');
const path = require('path');

// Pick the lowest free port ≥ start (default 5173) that isn't already
// claimed by another managed project's `.project-meta.json` proxyTarget.
// Pure scan of disk meta — no probing — so it's safe to call before
// scaffolding the new project's directory.
function allocatePort(projectsRoot, start = 5173) {
  const used = new Set();
  let entries;
  try {
    entries = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return start;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const meta = path.join(projectsRoot, e.name, '.project-meta.json');
    if (!fs.existsSync(meta)) continue;
    let m;
    try { m = JSON.parse(fs.readFileSync(meta, 'utf8')); } catch { continue; }
    if (!m.proxyTarget) continue;
    let port;
    try { port = parseInt(new URL(m.proxyTarget).port, 10); } catch { continue; }
    if (Number.isFinite(port) && port > 0) used.add(port);
  }
  let p = start;
  while (used.has(p)) p++;
  return p;
}

module.exports = { allocatePort };
