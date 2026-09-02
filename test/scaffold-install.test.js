// B20: the scaffold's `npm install` inherited NODE_ENV=production from
// claude-hub.service, npm read that as --omit=dev, and every devDependency
// (vite, typescript, @vitejs/plugin-react, @types/*) was silently skipped —
// with npm still exiting 0, so the scaffold reported success and the failure
// cleanup never ran. The project only died later, when vite@<name>.service
// crash-looped on `vite: not found`.
//
// These tests run the REAL install command against a real npm, because the
// bug was entirely in npm's behaviour: a test asserting the command string
// alone would have passed against the broken code just as happily. The
// fixture's dependencies are `file:` paths, so npm never touches the network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { installCommand, installEnv } = require('../lib/scaffold-install');

// One runtime dep and one dev dep, both local directories. If npm omits dev,
// `dev-pkg` is missing from node_modules and `dep-pkg` is not — which is
// exactly the shape claude-home-automation was found in (react, react-dom and
// scheduler present; the entire toolchain absent).
function makeProbeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hub-install-'));
  for (const name of ['dep-pkg', 'dev-pkg']) {
    fs.mkdirSync(path.join(dir, name));
    fs.writeFileSync(
      path.join(dir, name, 'package.json'),
      JSON.stringify({ name, version: '1.0.0' }) + '\n',
    );
  }
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'scaffold-probe',
      version: '0.0.0',
      private: true,
      dependencies: { 'dep-pkg': 'file:./dep-pkg' },
      devDependencies: { 'dev-pkg': 'file:./dev-pkg' },
    }, null, 2) + '\n',
  );
  return dir;
}

// Mirrors server.js's call shape: `bash -lc <cmd> <dir>`, with the dir as
// argv0 so the command can `cd "$0"`. The npm_config_* keys keep the fixture
// off the network; they are additive and never touch NODE_ENV, which is what
// is actually under test.
function runInstall(dir, cmd, env) {
  return new Promise((resolve) => {
    execFile('/bin/bash', ['-lc', cmd, dir], {
      timeout: 120000,
      env: { ...env, npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false' },
    }, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
  });
}

const installed = (dir, pkg) => fs.existsSync(path.join(dir, 'node_modules', pkg));

// The environment the hub actually runs under (services/claude-hub.service).
const HUB_ENV = { ...process.env, NODE_ENV: 'production' };

test('B20 repro: the pre-fix install skips devDependencies under the hub env', async () => {
  const dir = makeProbeProject();
  try {
    // The exact command bootstrapTemplate used to build, with the env it
    // inherited. This is the negative control: if it ever stops reproducing,
    // the tests below stop proving anything.
    const { err } = await runInstall(dir, 'cd "$0" && npm install', HUB_ENV);
    assert.equal(err, null, 'the broken install still EXITS 0 — that is the bug');
    assert.ok(installed(dir, 'dep-pkg'), 'runtime dependency should install');
    assert.ok(!installed(dir, 'dev-pkg'), 'devDependency silently skipped (B20)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('V65: the fixed install places devDependencies despite the hub env', async () => {
  const dir = makeProbeProject();
  try {
    const { err, stderr } = await runInstall(dir, installCommand({}), installEnv(HUB_ENV));
    assert.equal(err, null, `install failed: ${stderr}`);
    assert.ok(installed(dir, 'dep-pkg'), 'runtime dependency should install');
    assert.ok(installed(dir, 'dev-pkg'), 'devDependency MUST install — vite lives here');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('V65: --include=dev survives a login profile re-exporting NODE_ENV', async () => {
  // installEnv hands over NODE_ENV=development, but the command runs through
  // `bash -lc`, which sources the user's profile AFTER that. Force the value
  // back to production to stand in for a profile that exports it: the flag,
  // not the env, is what has to carry this case.
  const dir = makeProbeProject();
  try {
    const { err } = await runInstall(dir, installCommand({}), HUB_ENV);
    assert.ok(installed(dir, 'dev-pkg'), 'flag must win over a hostile NODE_ENV');
    assert.equal(err, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('V65: installEnv overrides NODE_ENV and preserves everything else', () => {
  const env = installEnv({ NODE_ENV: 'production', PATH: '/usr/bin', HOME: '/home/x' });
  assert.equal(env.NODE_ENV, 'development');
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/x');
  // Must not mutate the caller's object — server.js passes process.env.
  const src = { NODE_ENV: 'production' };
  installEnv(src);
  assert.equal(src.NODE_ENV, 'production');
});

test('V65: the firebase variant carries the flag on BOTH installs', () => {
  // `npm install <pkg>` re-resolves the whole tree, so a production-flavoured
  // second install would prune the dev packages the first one just placed.
  const cmd = installCommand({ firebase: true });
  const installs = cmd.split('&&').filter((s) => s.includes('npm install'));
  assert.equal(installs.length, 2, 'firebase overlay adds a second install');
  for (const step of installs) {
    assert.match(step, /--include=dev/, `missing flag: ${step.trim()}`);
  }
  assert.match(cmd, /npm install firebase/);
});

test('V65: server.js passes the scaffold env to the install child', () => {
  // The behavioural tests above prove the lib is right; this one catches the
  // call site quietly dropping it, which is how the bug would come back.
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const at = src.indexOf('scaffoldInstall.installCommand');
  assert.notEqual(at, -1, 'install call site not found — did it get renamed?');
  // The execFileP call and its options object follow within a few lines.
  const window = src.slice(at, at + 600);
  assert.match(window, /execFileP\('\/bin\/bash'/, 'install should still shell out via bash -lc');
  assert.match(window, /env:\s*scaffoldInstall\.installEnv\(/,
    'the install execFileP must be handed installEnv(process.env)');
});
