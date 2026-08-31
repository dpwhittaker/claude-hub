/**
 * README.md → landing-page card metadata.
 *
 * README is the canonical human-facing doc for a managed project: the card
 * title is its first H1, the description is the first paragraph after that
 * H1, and the badge pills come from the `tags:` frontmatter list. AGENTS.md
 * is deliberately NOT consulted — that's the agent-facing brief.
 *
 * Pure string in / plain object out. server.js owns the disk read so this
 * stays testable without a fixture tree.
 */

// Parse YAML-style frontmatter at the top of a markdown file. Handles flat
// `key: value` plus simple inline-list values like `tags: [a, b, "c d"]`.
function parseFrontmatter(content) {
  if (!content.startsWith('---')) return { meta: {}, body: content };
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!m) return { meta: {}, body: content };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*$/.exec(line);
    if (!kv) continue;
    let v = kv[2];
    const list = /^\[(.*)\]$/.exec(v);
    if (list) {
      meta[kv[1]] = list[1]
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
      continue;
    }
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    meta[kv[1]] = v;
  }
  return { meta, body: content.slice(m[0].length) };
}

// Best-effort markdown → plain text for card descriptions. Strips inline
// emphasis, links, images, and inline code so a description like
// `**Live Site:** [foo](url)` doesn't render as literal asterisks.
function stripInlineMarkdown(s) {
  return s
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/(^|\W)_(.+?)_(?=\W|$)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

// { title, description, tags } from README.md text. Description is capped at
// 400 chars — cards truncate visually, but the API shouldn't ship a novel.
function readmeMetaFromContent(content) {
  if (content == null) return { title: null, description: null, tags: [] };
  const { meta, body } = parseFrontmatter(content);
  const lines = body.split('\n');
  let i = 0;
  // Skip leading blank lines, then look for the first H1.
  while (i < lines.length && !/^#\s+\S/.test(lines[i])) i++;
  let title = null;
  let description = null;
  if (i < lines.length) {
    title = lines[i].replace(/^#\s+/, '').trim() || null;
    i++;
    while (i < lines.length && lines[i].trim() === '') i++;
    const para = [];
    while (i < lines.length && lines[i].trim() !== '' && !lines[i].trim().startsWith('#')) {
      para.push(lines[i].trim());
      i++;
    }
    const text = stripInlineMarkdown(para.join(' '));
    if (text) description = text.slice(0, 400);
  }
  let tags = [];
  if (Array.isArray(meta.tags)) tags = meta.tags;
  else if (typeof meta.tags === 'string' && meta.tags.trim()) tags = [meta.tags.trim()];
  return { title, description, tags };
}

module.exports = { parseFrontmatter, stripInlineMarkdown, readmeMetaFromContent };
