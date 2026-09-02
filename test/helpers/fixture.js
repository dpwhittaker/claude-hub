/**
 * Boots server.js in-process on a random port against a scratch
 * PROJECTS_ROOT. Returns { url, projectsRoot, close } for the test to use.
 *
 * The server module guards `server.listen` behind `require.main === module`,
 * so requiring it here gives us the configured `http.Server` without binding
 * a port — we listen on 0 ourselves.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * @param {object}   [opts]
 * @param {function} [opts.seed] — called with the scratch PROJECTS_ROOT before
 *   server.js is required. Needed for anything touching the reverse-proxy
 *   route table: `STATIC_ROUTES` is built once at require time and refreshed
 *   only on project create/delete, so a `.project-meta.json` written after the
 *   boot is invisible to `/<proj>/*` routing.
 */
async function startFixture(opts = {}) {
  const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hub-test-'));
  process.env.PROJECTS_ROOT = projectsRoot;
  // Avoid clashing with the systemd unit on 8002.
  process.env.PROXY_PORT = '0';

  if (typeof opts.seed === 'function') opts.seed(projectsRoot);

  // Clear require cache so PROJECTS_ROOT env is read fresh on each call.
  const serverPath = require.resolve('../../server.js');
  delete require.cache[serverPath];
  const { server } = require(serverPath);

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    projectsRoot,
    server,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          fs.rmSync(projectsRoot, { recursive: true, force: true });
          resolve();
        });
      }),
  };
}

module.exports = { startFixture };
