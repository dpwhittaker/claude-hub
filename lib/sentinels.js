// Project sentinels (`.project-meta.json`) anywhere under the root (V99).
// A project used to be a top-level folder; now a repo can sit in any folder,
// so everything that reads sentinels walks the tree (bounded, skipping the
// usual noise) and everything that maps a file to its project takes the
// nearest ancestor with one.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isNoiseName, isHiddenName } = require('./v2-paths');

const MAX_DEPTH = 4;

function readMeta(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, '.project-meta.json'), 'utf8'));
    return m && typeof m === 'object' && !Array.isArray(m) ? m : null;
  } catch { return null; }
}

// → [{ rel, dir, name, meta }] in path order; a folder with a sentinel is not
// searched further (a repo's subfolders are its own business).
function findSentinels(root, { maxDepth = MAX_DEPTH } = {}) {
  const out = [];
  const walk = (dir, rel, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || isHiddenName(e.name) || isNoiseName(e.name)) continue;
      const sub = path.join(dir, e.name);
      const subRel = rel ? rel + '/' + e.name : e.name;
      const meta = readMeta(sub);
      if (meta) { out.push({ rel: subRel, dir: sub, name: e.name, meta }); continue; }
      if (depth + 1 < maxDepth) walk(sub, subRel, depth + 1);
    }
  };
  walk(root, '', 0);
  return out;
}

// The sentinel folder a relative path belongs to (itself or the nearest
// ancestor), or null.
function nearestSentinel(root, rel) {
  const segs = String(rel || '').split('/').filter(Boolean);
  for (let n = segs.length; n >= 1; n--) {
    const cand = segs.slice(0, n).join('/');
    const meta = readMeta(path.join(root, cand));
    if (meta) return { rel: cand, dir: path.join(root, cand), name: segs[n - 1], meta };
  }
  return null;
}

module.exports = { findSentinels, nearestSentinel, readMeta, MAX_DEPTH };
