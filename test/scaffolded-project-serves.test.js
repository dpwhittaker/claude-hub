// B21: none of the four vite templates set `server.allowedHosts`, so a
// scaffolded project 403'd — "Blocked request. This host is not allowed." —
// on the tailnet URL while answering fine on 127.0.0.1. Every hand-built
// project already carried the setting; the templates never picked it up.
//
// The bug needs BOTH halves to bite, so both are pinned here:
//   1. claude-hub forwards the client's Host verbatim (changeOrigin: false).
//   2. Vite rejects a Host that is not in server.allowedHosts.
// A test for either alone would keep passing while a scaffold stayed broken.
//
// The upstream is a stub rather than a real `vite`, because standing one up
// means an `npm install` of the toolchain — the very thing B20 showed is slow
// and network-bound. The stub runs Vite's own allow-list rule against the
// allowedHosts value parsed out of the template file, so the assertion still
// fails if a template drops the setting.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { startFixture } = require('./helpers/fixture');

const TEMPLATES = ['vite', 'game-2d', 'game-3d', 'game-3d-complex'];

// A stand-in tailnet name. The real FQDN is deliberately NOT in this repo —
// the leading-dot suffix wildcard is what makes that possible.
const TAILNET_HOST = 'example-host.tailnet-abcdef.ts.net';

function templateConfig(name) {
  return fs.readFileSync(
    path.join(__dirname, '..', 'templates', name, 'vite.config.ts'), 'utf8');
}

/** Pull the literal `allowedHosts: [...]` list out of a template config. */
function parseAllowedHosts(src) {
  const m = /allowedHosts:\s*\[([^\]]*)\]/.exec(src);
  if (!m) return null;
  return m[1].split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

/**
 * Vite's `isHostAllowed` rule for list entries: a leading dot is a suffix
 * wildcard that also matches the bare domain; anything else is exact.
 */
function hostAllowed(allowedHosts, hostHeader) {
  // A template with no allowedHosts at all is the B21 state: deny, the way
  // Vite does. Never throw here — this runs inside the stub's request handler,
  // and an exception there hangs the client instead of failing the assertion.
  if (!Array.isArray(allowedHosts)) return false;
  const host = hostHeader.replace(/:\d+$/, '');
  return allowedHosts.some((entry) => entry.startsWith('.')
    ? host === entry.slice(1) || host.endsWith(entry)
    : host === entry);
}

test('B21: every vite template declares allowedHosts covering the tailnet', () => {
  for (const t of TEMPLATES) {
    const allowed = parseAllowedHosts(templateConfig(t));
    assert.ok(allowed, `templates/${t}/vite.config.ts has no allowedHosts (B21)`);
    assert.ok(allowed.includes('.ts.net'),
      `templates/${t}: allowedHosts must carry the '.ts.net' suffix wildcard, got ${JSON.stringify(allowed)}`);
    assert.ok(hostAllowed(allowed, TAILNET_HOST),
      `templates/${t}: would still 403 the tailnet host`);
  }
});

test('B21: no template hardcodes a concrete tailnet FQDN', () => {
  // The point of the suffix wildcard is that this machine's name never lands
  // in the repo. A literal `<name>.ts.net` entry would defeat it.
  for (const t of TEMPLATES) {
    for (const entry of parseAllowedHosts(templateConfig(t)) || []) {
      assert.ok(entry === '.ts.net' || !entry.endsWith('.ts.net'),
        `templates/${t}: allowedHosts pins a concrete host (${entry}) — use '.ts.net'`);
    }
  }
});

/**
 * GET with a chosen Host header. `fetch` cannot do this — undici treats Host
 * as a forbidden header and silently substitutes the connected authority —
 * and Host is the entire subject of this test.
 */
function getWithHost(base, urlPath, host) {
  const u = new URL(urlPath, base);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET',
      headers: { Host: host },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    // A broken proxy or a stub that never answers must fail this test, not
    // stall the whole suite until the runner's own timeout.
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error(`no response for ${urlPath} with Host: ${host}`));
    });
    req.on('error', reject);
    req.end();
  });
}

// Stub upstream: answers like a Vite dev server that has been handed the
// template's allowedHosts, and echoes what it actually received.
function startStubVite(allowedHosts) {
  const server = http.createServer((req, res) => {
    if (!hostAllowed(allowedHosts, req.headers.host || '')) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end(`Blocked request. This host ("${req.headers.host}") is not allowed.`);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><title>ok</title><p>url=${req.url}</p><p>host=${req.headers.host}</p>`);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

test('a scaffolded project answers through the proxy on a tailnet Host', async () => {
  const allowed = parseAllowedHosts(templateConfig('vite'));
  const { server: upstream, port } = await startStubVite(allowed);
  const name = 'scaffolded-demo';

  // The sentinel exactly as bootstrapTemplate stamps it.
  const fx = await startFixture({
    seed(root) {
      const dir = path.join(root, name);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, '.project-meta.json'), JSON.stringify({
        name,
        createdAt: new Date().toISOString(),
        template: 'vite',
        proxyTarget: 'http://127.0.0.1:' + port,
        proxyPrefix: '/' + name,
        stripPrefix: false,
        openUrl: '/' + name + '/',
        extraUnits: ['vite@' + name + '.service'],
      }, null, 2) + '\n');
    },
  });

  try {
    const { status, body } = await getWithHost(fx.url, `/${name}/`, TAILNET_HOST);
    assert.equal(status, 200, `tailnet Host was rejected — B21 regression:\n${body}`);

    // The Host really did survive the hop; that is why allowedHosts matters.
    assert.match(body, new RegExp(`host=${TAILNET_HOST}`),
      'proxy must forward the original Host (changeOrigin: false)');
    // stripPrefix:false keeps /<name>/ on the upstream path, matching the
    // template's `base: '/<NAME>/'` (V20, B4).
    assert.match(body, new RegExp(`url=/${name}/`),
      'upstream should receive the prefix, not a stripped path');
  } finally {
    await fx.close();
    await new Promise((res) => upstream.close(res));
  }
});

test('the same project still 403s a Host nobody allowed', async () => {
  // Negative control: proves the 200 above came from the allow-list matching,
  // not from the stub answering everything.
  const allowed = parseAllowedHosts(templateConfig('vite'));
  const { server: upstream, port } = await startStubVite(allowed);
  const name = 'scaffolded-demo';

  const fx = await startFixture({
    seed(root) {
      const dir = path.join(root, name);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, '.project-meta.json'), JSON.stringify({
        name, createdAt: new Date().toISOString(),
        proxyTarget: 'http://127.0.0.1:' + port,
        proxyPrefix: '/' + name, stripPrefix: false,
      }, null, 2) + '\n');
    },
  });

  try {
    const { status } = await getWithHost(fx.url, `/${name}/`, 'evil.example.com');
    assert.equal(status, 403);
  } finally {
    await fx.close();
    await new Promise((res) => upstream.close(res));
  }
});
