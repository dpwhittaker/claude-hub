/**
 * Git-worktree awareness for managed projects.
 *
 * A worktree project is an ordinary folder under ~/projects/ whose
 * `.project-meta.json` names the project it branched from:
 *
 *   { "worktreeOf": "world-builder", "branch": "avatar-lighting", ... }
 *
 * It is a real `git worktree add` checkout, so the PARENT repo holds a
 * registry entry for it under `.git/worktrees/<dir>`. Deleting the folder
 * with `rm -rf` alone leaves that entry behind: the parent keeps listing a
 * checkout that no longer exists, and `git worktree add` refuses to reuse the
 * path until someone runs `git worktree prune` by hand. So DELETE has to go
 * through git, and fall back to prune when it can't. SPEC §V56 / §B16.
 *
 * Pure — returns a plan of argv arrays; server.js runs them.
 */

const path = require('path');
const { PROJECT_ID_RE } = require('./project-name');

// `worktreeOf` is read from on-disk JSON, and we turn it into a filesystem
// path — so it gets the same name validation as a real project, never a
// trusted string. A parent that fails validation is treated as absent, which
// downgrades DELETE to a plain rm rather than letting `../..` reach a path
// outside PROJECTS_ROOT.
function parentProjectName(meta) {
  const raw = meta && typeof meta.worktreeOf === 'string' ? meta.worktreeOf.trim() : '';
  if (!raw) return null;
  if (!PROJECT_ID_RE.test(raw) || raw.startsWith('.')) return null;
  return raw;
}

function branchName(meta) {
  const raw = meta && typeof meta.branch === 'string' ? meta.branch.trim() : '';
  return raw || null;
}

/**
 * How to tear down `dir` given its sentinel.
 *
 * Returns null for a plain project (caller just removes the directory), or:
 *   {
 *     parent,      // parent project name
 *     parentDir,   // absolute path to the parent repo
 *     removeArgs,  // git argv: detach the worktree AND delete the folder
 *     pruneArgs,   // git argv: drop stale registry entries (fallback path)
 *   }
 *
 * `--force` is deliberate: the worktree is a scratch checkout for one task and
 * the user already confirmed the delete in the UI, so git refusing over
 * uncommitted changes would just strand the folder half-removed.
 */
function worktreeRemovalPlan({ dir, meta, projectsRoot }) {
  const parent = parentProjectName(meta);
  if (!parent) return null;
  const parentDir = path.join(projectsRoot, parent);
  return {
    parent,
    parentDir,
    removeArgs: ['-C', parentDir, 'worktree', 'remove', '--force', dir],
    pruneArgs: ['-C', parentDir, 'worktree', 'prune'],
  };
}

module.exports = { parentProjectName, branchName, worktreeRemovalPlan };
