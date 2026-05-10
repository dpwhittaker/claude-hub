// Self-contained: server inlines this via `.toString()` into the client
// template, so closure references would die as ReferenceError. Keep the ext
// list inside the function body.
function isEmbedder(filePath) {
  const m = /\.([^./]+)$/.exec(filePath || '');
  if (!m) return false;
  const ext = m[1].toLowerCase();
  return ext === 'md' || ext === 'markdown' || ext === 'html' || ext === 'htm';
}

function tabsToReload(tabs, changedPath) {
  const out = [];
  for (const [, info] of tabs) {
    if (info.path === changedPath || isEmbedder(info.path)) out.push(info);
  }
  return out;
}

module.exports = { isEmbedder, tabsToReload };
