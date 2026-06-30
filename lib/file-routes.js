// Map a source file's repo-relative path → the URL it renders at, relative to
// the project's proxy prefix. Driven by `routes` rules in .project-meta.json so
// a project declares how its files map to served pages — works for a real
// Jekyll site (source .md → built HTML path) AND a .nojekyll SPA (source .md →
// a `#fragment` route the client router resolves). The Browse view inlines
// these two functions via `.toString()` to (a) show a preview icon on any
// routable file and (b) target the render iframe (PROXY_PREFIX + route). Tests
// import them directly — keep both bodies self-contained (no closures, no
// module-scope refs) so the `.toString()` round-trip survives. SPEC §V54.
//
// A rule = { match: <glob>, to: <template> }, evaluated in order; first hit
// wins. Glob: `*` = exactly one path segment, `**` = zero or more segments
// (captured as :splat), everything else literal. Template vars expanded in
// `to`: :dir (dirname, '' at root) · :name (basename minus final ext) · :ext ·
// :path (full rel path) · :pathnoext (full rel path minus final ext) · :splat
// (the `**` capture, '' if none). The result is slash-normalized: runs of `/`
// collapse and an empty segment right after `#` is dropped (so `/#/TOC` →
// `/#TOC`, `//x.html` → `/x.html`).
//
// Files with any path segment starting with `_` or `.` are never routed —
// Jekyll and most static hosts don't serve them, so they'd be false positives.

// Glob → anchored match. The single `**` (if present) is captured as splat
// ('' when it spans zero segments). Plain `*` segments are matched but not
// captured (templates use :dir/:name/:splat instead). Returns {splat} or null.
function matchGlob(glob, p) {
  let re = '^';
  let splatGroup = -1;
  let group = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      // Absorb an immediately following '/' so `a/**/b` also matches `a/b`
      // (the `**` spanning zero segments).
      if (glob[i + 1] === '/') { i++; re += '(?:(.*)/)?'; } else { re += '(.*)'; }
      group++; splatGroup = group;
    } else if (c === '*') {
      re += '[^/]*';
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  re += '$';
  const m = new RegExp(re).exec(p);
  if (!m) return null;
  return { splat: splatGroup >= 0 ? (m[splatGroup] || '') : '' };
}

function routeForPath(rules, relPath) {
  if (!Array.isArray(rules) || !relPath || typeof relPath !== 'string') return null;
  const segs = relPath.split('/');
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (!s || s.charAt(0) === '_' || s.charAt(0) === '.') return null;
  }
  const slash = relPath.lastIndexOf('/');
  const dir = slash < 0 ? '' : relPath.slice(0, slash);
  const base = slash < 0 ? relPath : relPath.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  const name = dot <= 0 ? base : base.slice(0, dot);
  const ext = dot <= 0 ? '' : base.slice(dot + 1);
  const pathnoext = dir ? dir + '/' + name : name;
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if (!rule || typeof rule.match !== 'string' || typeof rule.to !== 'string') continue;
    const m = matchGlob(rule.match, relPath);
    if (!m) continue;
    const vars = { dir: dir, name: name, ext: ext, path: relPath, pathnoext: pathnoext, splat: m.splat };
    let url = rule.to.replace(/:(dir|name|ext|pathnoext|path|splat)/g, function (_, k) { return vars[k]; });
    url = url.replace(/\/{2,}/g, '/').replace(/#\/+/g, '#');
    return url;
  }
  return null;
}

module.exports = { matchGlob, routeForPath };
