// Adopt-existing-folder + orphan-listing helpers. Pure fs operations — no
// systemd, no spawn — so they're trivially testable without a fixture.
// SPEC §V.36, §V.37.
const fs = require('fs');
const path = require('path');
const { PROJECT_ID_RE, RESERVED_PROJECT_NAMES } = require('./project-name');
const { writeBootstrapPrompt } = require('./bootstrap-prompt');

// Adopt an existing folder under PROJECTS_ROOT as a managed project. Stamps
// the sentinel + writes the scan-existing bootstrap prompt; never overwrites
// any pre-existing file in the tree (V36). Errors carry `statusCode` so the
// route handler can echo the right HTTP status.
async function bootstrapOnboard(dir, name) {
  let st;
  try { st = fs.statSync(dir); } catch { st = null; }
  if (!st || !st.isDirectory()) {
    const err = new Error('folder not found under PROJECTS_ROOT');
    err.statusCode = 404;
    throw err;
  }
  const metaPath = path.join(dir, '.project-meta.json');
  if (fs.existsSync(metaPath)) {
    const err = new Error('project already managed (.project-meta.json exists)');
    err.statusCode = 409;
    throw err;
  }
  fs.writeFileSync(
    metaPath,
    JSON.stringify({
      name,
      createdAt: new Date().toISOString(),
    }, null, 2) + '\n',
  );
  writeBootstrapPrompt(dir, name, 'scan-existing');
}

// Folders under PROJECTS_ROOT that exist but lack the sentinel — i.e.
// candidates the user could adopt via the onboard flow (V36, V37).
function listOrphanFolderNames(projectsRoot) {
  let entries;
  try {
    entries = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    if (!PROJECT_ID_RE.test(e.name)) continue;
    if (RESERVED_PROJECT_NAMES.has(e.name)) continue;
    const meta = path.join(projectsRoot, e.name, '.project-meta.json');
    if (fs.existsSync(meta)) continue;
    out.push(e.name);
  }
  out.sort();
  return out;
}

module.exports = { bootstrapOnboard, listOrphanFolderNames };
