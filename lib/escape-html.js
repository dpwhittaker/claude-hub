/**
 * The one server-side HTML escaper. Shared by the page shells (which build
 * markup as template literals) and by server.js's own renderers.
 *
 * The Browse client has its own copy inlined in the shell script — that one
 * runs in the browser and can't reach this module.
 */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = { escapeHtml };
