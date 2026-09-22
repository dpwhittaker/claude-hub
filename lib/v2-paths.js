// Hub v2 path discipline (SPEC §V79).
//
// v2 has no project boundary: a tab may point at ANY file or folder under
// PROJECTS_ROOT, including the root itself. That makes one function the
// whole security story — everything that touches disk goes through
// `resolveUnder`, which turns a client-supplied relative path into an
// absolute one and refuses anything that would leave the root.
'use strict';

const path = require('node:path');

const NOISE_DIRS = new Set(['node_modules', '.git', '.serve', 'dist', 'build', '.next', '.cache', 'vendor', '__pycache__', '.venv', 'venv']);

// Normalise a client path: strip leading/trailing slashes, drop empty and
// `.` segments. Rejects `..`, NUL and backslashes outright — there is no
// legitimate reason for a browser to send them.
function cleanRel(raw) {
  const s = String(raw == null ? '' : raw);
  if (s.includes('\0') || s.includes('\\')) return null;
  const segs = s.split('/').filter((x) => x && x !== '.');
  if (segs.some((x) => x === '..')) return null;
  return segs.join('/');
}

// → { rel, abs } or throws an Error with statusCode 400/403.
function resolveUnder(root, raw) {
  const rel = cleanRel(raw);
  if (rel === null) {
    const e = new Error('bad path'); e.statusCode = 400; throw e;
  }
  const abs = rel ? path.resolve(root, rel) : root;
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    const e = new Error('path escapes projects root'); e.statusCode = 403; throw e;
  }
  return { rel, abs };
}

function isNoiseName(name) {
  return NOISE_DIRS.has(name);
}

function isHiddenName(name) {
  return typeof name === 'string' && name.startsWith('.');
}

function parentOf(rel) {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}

function baseOf(rel) {
  const i = rel.lastIndexOf('/');
  return i < 0 ? rel : rel.slice(i + 1);
}

module.exports = { NOISE_DIRS, cleanRel, resolveUnder, isNoiseName, isHiddenName, parentOf, baseOf };
