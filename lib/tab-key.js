// Single source of truth for the two-pane viewer's tab keying. The server
// imports this module and inlines `tabKey.toString()` into the client-side
// template literal in renderViewShell (see server.js). Tests import the
// function directly to verify the keying contract — keep the body
// self-contained (no closures, no helper calls) so .toString() round-trips
// cleanly into the browser.
function tabKey(p, mode) {
  // NUL separator — the only byte POSIX forbids in path segments. Stops a
  // pathological filename like "render:foo.html" from colliding with the
  // render-mode key for "foo.html". See SPEC §V.15 / §B.6.
  return (mode === 'render' ? 'render' : 'view') + '\0' + p;
}

module.exports = { tabKey };
