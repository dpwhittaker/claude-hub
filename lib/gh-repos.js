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
    // Forks sink below non-forks so the user's own repos dominate the top
    // of the dropdown. Within each group, updatedAt desc (most recently
    // touched first); missing updatedAt sinks to the bottom of its group.
    parsed.sort((a, b) => {
      const af = !!(a && a.isFork);
      const bf = !!(b && b.isFork);
      if (af !== bf) return af ? 1 : -1;
      return (b && b.updatedAt || '').localeCompare(a && a.updatedAt || '');
    });
    cache = { at: now(), repos: parsed };
    return parsed;
  }

  function invalidate() {
    cache = null;
  }

  return { list, invalidate };
}

function filterReposByFolders(repos, folders) {
  return repos.filter((r) => {
    const basename = String(r && r.nameWithOwner || '').split('/').pop();
    return basename && !folders.has(basename);
  });
}

module.exports = { makeGhRepos, DEFAULT_TTL_MS, REPO_FIELDS, filterReposByFolders };
