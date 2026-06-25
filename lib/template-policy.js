// Template ids = `templates/<id>/` dirnames (1:1). SPEC §V43.
const TEMPLATES = new Set(['none', 'vite', 'game-2d', 'game-3d', 'game-3d-complex', 'jekyll']);
const DEFAULT_TEMPLATE = 'vite';
// Templates the Firebase overlay can't apply to: it's an npm package merged
// into package.json, so it only fits the Vite-family templates. `jekyll` is a
// Ruby/Bundler project — no package.json to merge into. SPEC §V52.
const NON_NPM_TEMPLATES = new Set(['jekyll']);

function isCloneOrOnboard(body) {
  const mode = (body && body.github && body.github.mode) || 'skip';
  return mode === 'clone' || mode === 'onboard';
}

// Cloning brings the repo's own structure; the scaffolder would smear template
// files over it. Force `none` on clone/onboard so the tree stays intact and
// claude bootstraps docs against it (V29/V36). Otherwise honor the requested
// template if it's in the allowlist; unknown values coerce to the default
// (V43) so a typo can't bypass scaffolding or hit a missing template dir.
function effectiveTemplate(body) {
  if (isCloneOrOnboard(body)) return 'none';
  const t = body && body.template;
  return TEMPLATES.has(t) ? t : DEFAULT_TEMPLATE;
}

// Firebase overlay only makes sense when something is scaffolded into. Forced
// off for `none` and for clone/onboard (no scaffold to inject), and for
// non-npm templates like jekyll (no package.json to merge into). SPEC §V45/V52.
function firebaseEnabled(body, template) {
  if (isCloneOrOnboard(body)) return false;
  if (template === 'none') return false;
  if (NON_NPM_TEMPLATES.has(template)) return false;
  return Boolean(body && body.firebase);
}

module.exports = { effectiveTemplate, firebaseEnabled, TEMPLATES, NON_NPM_TEMPLATES };
