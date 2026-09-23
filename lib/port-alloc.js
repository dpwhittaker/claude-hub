const { findSentinels } = require('./sentinels');

// Pick the lowest free port ≥ start (default 5173) that isn't already
// claimed by another project's `.project-meta.json` proxyTarget, wherever
// that project sits under the root (V99). Pure scan of disk meta — no
// probing — so it's safe to call before scaffolding the new project's dir.
function allocatePort(projectsRoot, start = 5173) {
  const used = new Set();
  for (const { meta } of findSentinels(projectsRoot)) {
    if (!meta.proxyTarget) continue;
    let port;
    try { port = parseInt(new URL(meta.proxyTarget).port, 10); } catch { continue; }
    if (Number.isFinite(port) && port > 0) used.add(port);
  }
  let p = start;
  while (used.has(p)) p++;
  return p;
}

module.exports = { allocatePort };
