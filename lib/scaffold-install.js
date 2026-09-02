/**
 * The environment and command line for a scaffold's `npm install`.
 *
 * Extracted from `bootstrapTemplate` because the interesting part is not the
 * shelling-out — it is the environment, and an environment is testable without
 * booting a server.
 *
 * Why this exists (B20): `services/claude-hub.service` starts the hub with
 * `Environment=NODE_ENV=production`. The scaffold's install runs as a child of
 * that process and inherits it, and npm treats `NODE_ENV=production` as
 * `--omit=dev`. So only `dependencies` install: vite, typescript,
 * `@vitejs/plugin-react` and every `@types/*` are silently skipped. npm still
 * exits 0, so the scaffold reports success, the failure cleanup never fires,
 * and the project only dies later when `vite@<name>.service` crash-loops on
 * `sh: 1: vite: not found`.
 *
 * TWO independent guards, because either one alone has a hole:
 *
 *   `installEnv`   — overrides the inherited value. Fixes the root cause, and
 *                    covers anything else in the install that reads NODE_ENV
 *                    (postinstall scripts, node-gyp), which a flag would not.
 *   `--include=dev` — survives a login shell re-exporting NODE_ENV. The install
 *                    runs through `bash -lc`, which sources the user's profile
 *                    AFTER we hand over our env, so the env fix alone is not
 *                    actually the last word. A command-line flag is.
 *
 * `development` rather than deleting the variable, to match
 * `services/vite@.service`, which already pins `NODE_ENV=development` for the
 * dev server the install is preparing.
 */

// Kept as one string so the command and the reason for it stay together.
const INCLUDE_DEV = '--include=dev';

/**
 * The shell command run inside the scaffolded directory. `$0` is the dir,
 * passed as bash's argv0 so the path never has to be quoted into the script.
 *
 * The firebase overlay is installed in the same step, and needs the same flag:
 * `npm install <pkg>` re-resolves the whole tree, so a production-flavoured
 * second install would prune the dev packages the first one just placed.
 */
function installCommand({ firebase = false } = {}) {
  const base = `npm install ${INCLUDE_DEV}`;
  return firebase
    ? `cd "$0" && ${base} && npm install firebase ${INCLUDE_DEV}`
    : `cd "$0" && ${base}`;
}

/** The child env: the parent's, with NODE_ENV forced away from production. */
function installEnv(env = process.env) {
  return { ...env, NODE_ENV: 'development' };
}

module.exports = { installCommand, installEnv, INCLUDE_DEV };
