// Cloning brings the repo's own structure; the Vite scaffolder would
// smear template files over it. Force `template = 'none'` on clone so the
// cloned tree stays intact and claude bootstraps docs against it (V29).
// Onboard adopts an existing tree the same way — never scaffold (V36).
function effectiveTemplate(body) {
  const ghMode = (body && body.github && body.github.mode) || 'skip';
  if (ghMode === 'clone' || ghMode === 'onboard') return 'none';
  return body && body.template === 'none' ? 'none' : 'vite';
}

module.exports = { effectiveTemplate };
