const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { copyTemplate, nameSlug } = require('../lib/template');

// The `evenhub` template (V70). It rides the vite family — one `vite@` unit,
// one allocated port, `base` = the proxy prefix — but it answers to two
// consumers at once: the Even App's WebView, which drives the glasses, and a
// plain phone browser, where the same page is an installable PWA. The
// assertions below pin the handful of rules that make both true at once;
// every one of them is silent when broken (a blank installed app, a stale
// bundle on the glasses, a package id `evenhub pack` rejects).

const REPO_TEMPLATES = path.join(__dirname, '..', 'templates');

function scaffold(vars) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-evenhub-'));
  copyTemplate(path.join(REPO_TEMPLATES, 'evenhub'), dest, vars);
  return dest;
}

function withScaffold(vars, fn) {
  const dest = scaffold(vars);
  try {
    fn(dest);
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
}

const DEMO = { NAME: 'demo', PORT: '5400', NAMESLUG: nameSlug('demo') };

test('evenhub scaffolds with every placeholder resolved (V43)', () => {
  withScaffold(DEMO, (dest) => {
    const pkg = JSON.parse(fs.readFileSync(path.join(dest, 'package.json'), 'utf8'));
    assert.equal(pkg.name, 'demo', 'package.json name placeholder replaced');

    const viteCfg = fs.readFileSync(path.join(dest, 'vite.config.ts'), 'utf8');
    assert.ok(viteCfg.includes("base: '/demo/'"), 'vite base = proxy prefix (V20)');
    assert.ok(viteCfg.includes('port: 5400'), 'vite port placeholder replaced');

    // One sweep over the whole tree: `<NAMESLUG>` is easy to add to a template
    // file and forget to pass, and the result is a package id that only fails
    // later, inside `evenhub pack`.
    const unresolved = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (e.name.endsWith('.template')) unresolved.push(p + ' (.template suffix)');
        const hit = /<[A-Z][A-Z0-9_]*>/.exec(fs.readFileSync(p, 'utf8'));
        if (hit) unresolved.push(p + ' (' + hit[0] + ')');
      }
    })(dest);
    assert.deepEqual(unresolved, [], 'no placeholder or .template suffix survives');
  });
});

test('the PWA scope, the vite base and the proxy prefix are one string (V70)', () => {
  withScaffold(DEMO, (dest) => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(dest, 'public', 'manifest.webmanifest'), 'utf8'));
    assert.equal(manifest.start_url, '/demo/', 'start_url = proxy prefix');
    assert.equal(manifest.scope, '/demo/', 'scope = proxy prefix');
    assert.equal(manifest.display, 'standalone', 'installs as an app, not a tab');
    assert.ok(manifest.icons.length > 0, 'an icon is required to be installable');

    const viteCfg = fs.readFileSync(path.join(dest, 'vite.config.ts'), 'utf8');
    const base = /base:\s*'([^']+)'/.exec(viteCfg)[1];
    assert.equal(base, manifest.scope, 'vite base and manifest scope must not drift');

    const html = fs.readFileSync(path.join(dest, 'index.html'), 'utf8');
    assert.ok(html.includes('rel="manifest"'), 'page links its manifest');
    assert.ok(html.includes('name="theme-color"'), 'page declares a theme colour');
  });
});

test('the service worker exists and caches nothing (V70)', () => {
  withScaffold(DEMO, (dest) => {
    const sw = fs.readFileSync(path.join(dest, 'public', 'sw.js'), 'utf8');
    assert.ok(/addEventListener\(['"]fetch['"]/.test(sw),
      'a fetch listener is what makes the page installable');
    assert.equal(/caches\./.test(sw), false,
      'this page is a live view onto a dev server — a cache would serve the glasses a stale bundle');

    const main = fs.readFileSync(path.join(dest, 'src', 'main.ts'), 'utf8');
    assert.ok(main.includes("navigator.serviceWorker.register('sw.js')"),
      'sw registered relative to the page, so its scope is the proxy prefix');
  });
});

test('a missing Even App host is a state, not a failure — the PWA renders regardless (V70)', () => {
  withScaffold(DEMO, (dest) => {
    const main = fs.readFileSync(path.join(dest, 'src', 'main.ts'), 'utf8');
    const glasses = fs.readFileSync(path.join(dest, 'src', 'glasses.ts'), 'utf8');

    // With no bridge object on window, waitForEvenAppBridge() never settles;
    // awaited at module scope that hangs the installed app on a blank page
    // forever, so it is confined to the timeout race in glasses.ts.
    assert.equal(main.includes('waitForEvenAppBridge'), false,
      'the entry module must go through connectBridge(), never the raw SDK call');
    assert.ok(glasses.includes('Promise.race'), 'connectBridge races the bridge against a timeout');
    assert.ok(/connectBridge\([^)]*\)\s*:\s*Promise<EvenAppBridge \| null>/.test(glasses),
      'connectBridge resolves to null rather than never resolving');

    // A bridge object is NOT proof of glasses: the SDK installs one on window
    // in any browser and force-readies it, so the host's absence only surfaces
    // as a non-zero result from the first call across it. That is the ordinary
    // standalone visit, so it must be a return value, not an exception — a
    // throw here renders an error state on every plain-browser load.
    assert.ok(/Promise<GlassesSession \| null>/.test(glasses),
      'startGlassesPage reports a host-less bridge by returning null');
    assert.ok(/result !== 0[\s\S]{0,200}return null/.test(glasses),
      'a non-zero container result falls back to companion-only');
    assert.equal(/throw new Error/.test(glasses), false,
      'no bridge failure is raised as an error — companion-only is a normal state');

    // Registration happens before the bridge is asked for: installability
    // cannot depend on the glasses being present.
    assert.ok(main.indexOf('serviceWorker.register') < main.indexOf('connectBridge()'),
      'the service worker registers before the bridge is awaited');
  });
});

test('packaging is not in the dev loop — delivery is the live URL (V70)', () => {
  withScaffold(DEMO, (dest) => {
    const pkg = JSON.parse(fs.readFileSync(path.join(dest, 'package.json'), 'utf8'));
    const packing = Object.entries(pkg.scripts).filter(([, cmd]) => /evenhub\s+pack/.test(cmd));
    assert.deepEqual(packing, [],
      'no script may require `evenhub pack`: the app is served, not installed');
    assert.ok(/evenhub qr/.test(pkg.scripts.qr), 'the QR at the live URL is the delivery path');
  });
});

test('app.json satisfies the rules `evenhub pack` enforces (V70)', () => {
  // A name that is legal for a claude-hub project and illegal for a package id
  // segment: it starts with a digit and carries a hyphen.
  withScaffold({ NAME: '3d-hud', PORT: '5401', NAMESLUG: nameSlug('3d-hud') }, (dest) => {
    const app = JSON.parse(fs.readFileSync(path.join(dest, 'app.json'), 'utf8'));
    assert.match(app.package_id, /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/,
      'lowercase alnum segments, each starting with a letter, no hyphens');
    assert.equal(app.package_id, 'com.example.app3dhud');
    assert.equal(app.edition, '202601', 'edition is a fixed string');
    assert.ok(app.name.length <= 20, 'name is capped at 20 characters');
    assert.ok(Array.isArray(app.permissions), 'permissions is an array, [] when none');
  });
});

test('nameSlug reduces a project name to a legal package-id segment', () => {
  assert.equal(nameSlug('demo'), 'demo');
  assert.equal(nameSlug('my-cool-app'), 'mycoolapp');
  assert.equal(nameSlug('Some_Project.v2'), 'someprojectv2');
  // Must start with a letter — a digit-leading segment is rejected by the CLI.
  assert.equal(nameSlug('3d-hud'), 'app3dhud');
  assert.equal(nameSlug('42'), 'app42');
  assert.equal(nameSlug('---'), 'app');
});
