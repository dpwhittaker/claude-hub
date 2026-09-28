// A real detached g2mirror session keyed like a hub terminal, started in the
// fixture's $G2MIRROR_DIR (so call it after startFixture). Tests that need
// one skip where g2mirror isn't installed.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const g2sessions = require('../../lib/g2sessions');

const G2 = process.env.G2MIRROR_BIN || path.join(os.homedir(), '.local', 'bin', 'g2mirror');
const haveG2mirror = fs.existsSync(G2);

// → { stop() } for a session running `sh -c <script>` under `key`.
function startTerminal(key, script, { size = '80x24' } = {}) {
  execFileSync(G2, ['--detached', '--initial-size', size, '--', 'env', `HUB_TERM_KEY=${key}`, 'sh', '-c', script],
    { cwd: '/', stdio: 'ignore' });
  return { stop: () => g2sessions.kill(key) };
}

module.exports = { haveG2mirror, startTerminal };
