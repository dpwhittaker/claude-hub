/**
 * Landing-page card assembly for managed projects.
 *
 * Takes one row per project folder that carries a `.project-meta.json`
 * sentinel and returns the array the landing page renders, already ordered.
 * Pure — the caller does the directory walk and the disk reads.
 *
 * Each input row: { name, meta, readme: {title, description, tags} }
 *
 * Two things make this more than a map():
 *
 *  1. **Sentinel-over-README precedence** for `title`/`description`. A git
 *     worktree checks out its parent's README verbatim, so a README-only card
 *     is a byte-identical duplicate of the project it branched from. The
 *     sentinel is the only place a worktree can say what it actually is.
 *  2. **Worktree grouping.** A worktree sorts as though it were its parent,
 *     then immediately after it, so `foo` and `foo_some-task` sit together
 *     instead of the worktree drifting to the end of the list by age (which
 *     is what a plain createdAt sort does, and what the naming prefix alone
 *     cannot fix).
 */

const WORKTREE_TAG = 'worktree';

// SPEC §V55. Sentinel wins over README for title/description; a `worktreeOf`
// sentinel additionally earns the leading `worktree` badge.
function buildCard(row) {
  const { name, meta = {}, readme = {} } = row;
  const baseTags = Array.isArray(readme.tags) ? readme.tags : [];
  const worktreeOf = typeof meta.worktreeOf === 'string' && meta.worktreeOf ? meta.worktreeOf : null;
  return {
    name,
    title: meta.title || readme.title || name,
    description: meta.description || readme.description || '',
    // The badge leads so a transient branch checkout is never mistaken for a
    // long-lived project, even when the README's own tags are inherited.
    tags: worktreeOf ? [WORKTREE_TAG, ...baseTags] : baseTags,
    // Open URL defaults to the rendered README. Projects with a live app
    // override it via openUrl in .project-meta.json so the card's Open button
    // jumps straight to the running app.
    openUrl: meta.openUrl || `/view/${name}/README.md`,
    worktreeOf,
    branch: (typeof meta.branch === 'string' && meta.branch) || null,
    createdAt: meta.createdAt || null,
    browseUrl: `/view/${name}/`,
  };
}

// SPEC §V55. Creation order, with each worktree pulled up next to its parent.
// A worktree whose parent is absent (deleted out from under it) falls back to
// its own createdAt so it still lands somewhere deterministic.
function sortCards(cards) {
  const createdOf = new Map(cards.map((p) => [p.name, p.createdAt || '']));
  const groupKey = (p) =>
    (p.worktreeOf && createdOf.has(p.worktreeOf) ? createdOf.get(p.worktreeOf) : p.createdAt || '');
  return cards.slice().sort((a, b) => {
    const cmp = groupKey(a).localeCompare(groupKey(b));
    if (cmp !== 0) return cmp;
    // Parent before its own worktrees, then alphabetical among siblings.
    const aw = a.worktreeOf ? 1 : 0;
    const bw = b.worktreeOf ? 1 : 0;
    if (aw !== bw) return aw - bw;
    return a.name.localeCompare(b.name);
  });
}

function buildProjectCards(rows) {
  return sortCards(rows.map(buildCard));
}

module.exports = { buildCard, sortCards, buildProjectCards, WORKTREE_TAG };
