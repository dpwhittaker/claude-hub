// Single source of truth for develop-pane orientation. Server inlines
// `pickDevelopOrientation.toString()` into the client template (see
// server.js / renderViewShell). Keep body self-contained (no closures, no
// helper calls) so .toString() round-trips into the browser. Tests import
// directly. SPEC §V.38.
function pickDevelopOrientation(vw, vh) {
  return vw > 1.2 * vh ? 'side' : 'stacked';
}

module.exports = { pickDevelopOrientation };
