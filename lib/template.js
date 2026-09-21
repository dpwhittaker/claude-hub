const fs = require('fs');
const path = require('path');

// Replace `<KEY>` placeholders in `s` with `vars[KEY]`. Unknown placeholders
// are left intact — important so React's <FooBar> JSX-ish patterns inside
// .tsx aren't mangled when a placeholder happens to be uppercase. Only
// matches all-caps + underscore so `<HTMLElement>` etc. are also untouched.
function replaceVars(s, vars) {
  return String(s).replace(/<([A-Z][A-Z0-9_]*)>/g, (m, k) => {
    return Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m;
  });
}

// Recursively copy every file under templates/<name>/ into destDir.
// - Replaces <KEY> placeholders both in file contents and in basename.
// - Strips a trailing `.template` from any output filename so we can ship
//   AGENTS.md.template inside the template tree without shadowing the
//   real one in this repo.
// Files are read and written as UTF-8, so a template tree holds TEXT only — a
// PNG dropped in here comes out the other side corrupted. Ship an SVG (see
// templates/evenhub/public/icon.svg) or generate the binary after scaffolding.
function copyTemplate(srcDir, destDir, vars) {
  const stack = [{ rel: '' }];
  while (stack.length) {
    const { rel } = stack.pop();
    const sub = path.join(srcDir, rel);
    let entries;
    try {
      entries = fs.readdirSync(sub, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const childRel = rel ? path.join(rel, e.name) : e.name;
      let outName = e.name;
      if (outName.endsWith('.template')) {
        outName = outName.slice(0, -'.template'.length);
      }
      outName = replaceVars(outName, vars);
      const outPath = path.join(destDir, rel || '', outName);
      if (e.isDirectory()) {
        fs.mkdirSync(outPath, { recursive: true });
        stack.push({ rel: childRel });
      } else {
        const content = fs.readFileSync(path.join(srcDir, childRel), 'utf8');
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, replaceVars(content, vars));
      }
    }
  }
}

// `<NAMESLUG>`: the project name reduced to what an Even Hub `package_id`
// segment allows — lowercase letters and digits only, and it must START with a
// letter. Project names are looser than that (`PROJECT_ID_RE` admits `-`, `_`,
// `.`, digits and uppercase), so `3d-hud` would otherwise yield the segment
// `3dhud`, which `evenhub pack` rejects. Every template gets the var; only the
// ones with a reverse-domain id to fill in use it.
function nameSlug(name) {
  const s = String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
  return /^[a-z]/.test(s) ? s : 'app' + s;
}

module.exports = { replaceVars, copyTemplate, nameSlug };
