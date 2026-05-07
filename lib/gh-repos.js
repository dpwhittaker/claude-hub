// Tiny in-process cache around `gh repo list --json ...`. The dialog calls
// /api/gh/repos every time the user opens it, so we don't want to shell out
// to gh on every click. TTL is short enough (10 min default) that newly
// created/forked repos still appear without restarting claude-hub.

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const REPO_FIELDS = 'nameWithOwner,description,isFork,isPrivate,updatedAt';

function makeGhRepos(opts) {
  const exec = opts && opts.exec;
  if (typeof exec !== 'function') throw new Error('makeGhRepos: opts.exec(cmd, args) required');
  const ttlMs = opts && Number.isFinite(opts.ttlMs) ? opts.ttlMs : DEFAULT_TTL_MS;
  const now = (opts && opts.now) || (() => Date.now());

  let cache = null; // { at, repos }

  async function list() {
    if (cache && now() - cache.at < ttlMs) return cache.repos;
    const { stdout } = await exec('gh', ['repo', 'list', '--json', REPO_FIELDS, '--limit', '200']);
    const parsed = JSON.parse(stdout);
    if (!Array.isArray(parsed)) throw new Error('gh repo list returned non-array');
    // Sort by updatedAt desc (most recently touched first). Items without
    // updatedAt sink to the bottom rather than throwing.
    parsed.sort((a, b) => (b && b.updatedAt || '').localeCompare(a && a.updatedAt || ''));
    cache = { at: now(), repos: parsed };
    return parsed;
  }

  function invalidate() {
    cache = null;
  }

  return { list, invalidate };
}

module.exports = { makeGhRepos, DEFAULT_TTL_MS, REPO_FIELDS };
