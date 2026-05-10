const EMBED_EXT = new Set(['md', 'markdown', 'html', 'htm']);

function isEmbedder(filePath) {
  const m = /\.([^./]+)$/.exec(filePath || '');
  if (!m) return false;
  return EMBED_EXT.has(m[1].toLowerCase());
}

function tabsToReload(tabs, changedPath) {
  const out = [];
  for (const [, info] of tabs) {
    if (info.path === changedPath || isEmbedder(info.path)) out.push(info);
  }
  return out;
}

module.exports = { isEmbedder, tabsToReload };
