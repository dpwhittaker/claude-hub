const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const S = require('../lib/v2-services');

test('V85: parseSystemctlShow splits blank-line blocks into records', () => {
  const recs = S.parseSystemctlShow([
    'Id=vite@a.service', 'Description=Vite dev server for project a', 'ActiveState=active', 'SubState=running', 'MainPID=123', '',
    'Id=stt.service', 'Description=whisper', 'ActiveState=inactive', 'SubState=dead', 'MainPID=0', 'ExecMainStartTimestamp=', '',
  ].join('\n'));
  assert.equal(recs.length, 2);
  assert.equal(recs[0].Id, 'vite@a.service');
  assert.equal(recs[1].SubState, 'dead');
  assert.deepEqual(S.parseSystemctlShow(''), []);
});

test('V85: parseTailscaleServeStatus reads listeners and their mounts', () => {
  const t = S.parseTailscaleServeStatus([
    'https://host.tail.ts.net:8443 (tailnet only)', '|-- / proxy http://localhost:4096', '',
    'https://host.tail.ts.net (tailnet only)', '|-- / proxy http://localhost:8002', '|-- /api proxy http://localhost:9000',
  ].join('\n'));
  assert.equal(t.length, 2);
  assert.equal(t[0].url, 'https://host.tail.ts.net:8443');
  assert.equal(t[0].scope, 'tailnet only');
  assert.deepEqual(t[0].mounts, [{ path: '/', mode: 'proxy', target: 'http://localhost:4096' }]);
  assert.equal(t[1].mounts.length, 2);
  assert.deepEqual(S.parseTailscaleServeStatus(''), []);
});

test('B33: ss listeners + cgroups map units to ports, and a tailnet mount on that port becomes the unit\'s URL', () => {
  const ss = [
    'LISTEN 0      511                      127.0.0.1:8002  0.0.0.0:* users:(("MainThread",pid=1526072,fd=21))  ',
    'LISTEN 0      512                      127.0.0.1:4096  0.0.0.0:* users:(("opencode",pid=172951,fd=17))     ',
    'LISTEN 0      4096                100.123.82.109:7788  0.0.0.0:*                                           ',
    'LISTEN 0      128                           [::]:5173     [::]:* users:(("node",pid=77,fd=3),("node",pid=78,fd=3))',
  ].join('\n');
  assert.deepEqual(S.parseSsListeners(ss), [{ port: 8002, pid: 1526072 }, { port: 4096, pid: 172951 }, { port: 5173, pid: 77 }, { port: 5173, pid: 78 }]);
  assert.equal(S.unitFromCgroup('0::/system.slice/opencode-web.service\n'), 'opencode-web.service');
  assert.equal(S.unitFromCgroup('0::/system.slice/system-vite.slice/vite@x.service'), 'vite@x.service');
  assert.equal(S.unitFromCgroup('0::/user.slice/user-1000.slice/session-3.scope'), null);
  const byPort = S.tailnetByPort([
    { url: 'https://h.ts.net', mounts: [{ path: '/', mode: 'proxy', target: 'http://localhost:8002' }] },
    { url: 'https://h.ts.net:8443', mounts: [{ path: '/', mode: 'proxy', target: 'http://localhost:4096' }] },
    { url: 'https://h.ts.net:9000', mounts: [{ path: '/api', mode: 'proxy', target: 'http://127.0.0.1:9001/x' }] },
  ]);
  assert.equal(byPort.get(4096), 'https://h.ts.net:8443/');
  assert.equal(byPort.get(8002), 'https://h.ts.net/');
  assert.equal(byPort.get(9001), 'https://h.ts.net:9000/api');
});

test('V85: discovery = local unit files + vite/jekyll instances + sentinel extraUnits, never ttyd; URLs from sentinels + overrides; actions only on known units', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v2svc-'));
  const projectsRoot = path.join(root, 'projects');
  const hubDir = path.join(root, 'hub');
  const unitDir = path.join(root, 'etc');
  fs.mkdirSync(path.join(projectsRoot, 'game'), { recursive: true });
  fs.mkdirSync(path.join(projectsRoot, 'site'), { recursive: true });
  fs.mkdirSync(hubDir); fs.mkdirSync(unitDir);
  fs.writeFileSync(path.join(projectsRoot, 'game/.project-meta.json'), JSON.stringify({ proxyTarget: 'http://127.0.0.1:5173', openUrl: '/game/', extraUnits: ['vite@game.service'] }));
  fs.writeFileSync(path.join(projectsRoot, 'site/.project-meta.json'), JSON.stringify({ proxyTarget: 'http://127.0.0.1:8000', proxyPrefix: '/theology', extraUnits: ['site.service', 'ttyd@site__s1.service'] }));
  fs.writeFileSync(path.join(unitDir, 'claude-hub.service'), '[Service]\nUser=me\n');
  fs.writeFileSync(path.join(unitDir, 'stt.service'), '[Service]\nWorkingDirectory=/home/me/projects/x\n');
  fs.writeFileSync(path.join(unitDir, 'ttyd-shell.service'), '[Service]\nUser=me\n');
  fs.writeFileSync(path.join(unitDir, 'vite@.service'), '[Service]\nUser=me\n');
  fs.writeFileSync(path.join(unitDir, 'cloud-init-network.service'), '[Service]\nExecStart=/bin/true\n');
  fs.writeFileSync(path.join(unitDir, 'ollama.service'), '[Service]\nUser=ollama\n');
  fs.symlinkSync('/lib/systemd/system/ssh.service', path.join(unitDir, 'ssh.service'));
  fs.writeFileSync(path.join(hubDir, 'services.json'), JSON.stringify({ 'stt.service': { title: 'Whisper', url: 'https://x:8012/' }, 'omni.service': { url: 'https://x:7788/' } }));

  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'systemctl' && args[0] === 'list-units') return { stdout: 'vite@game.service loaded active running Vite\nvite@other.service loaded failed failed Vite\n' };
    if (cmd === 'systemctl' && args[0] === 'show') {
      const units = args.slice(3);
      const wd = (u) => (u === 'claude-hub.service' ? projectsRoot + '/hub' : u === 'vite@other.service' ? projectsRoot + '/other' : u === 'stt.service' ? '/home/me/stt' : '');
      return { stdout: units.map((u) => `Id=${u}\nDescription=d ${u}\nActiveState=${u.startsWith('vite@other') ? 'failed' : 'active'}\nSubState=running\nMainPID=1\nWorkingDirectory=${wd(u)}\n`).join('\n') };
    }
    if (cmd === 'tailscale') return { stdout: 'https://h.ts.net:7788 (tailnet only)\n|-- / proxy http://localhost:7788\nhttps://h.ts.net:8443 (tailnet only)\n|-- / proxy http://localhost:4096\n' };
    if (cmd === 'ss') return { stdout: 'LISTEN 0 512 127.0.0.1:4096 0.0.0.0:* users:(("claude-hub",pid=500,fd=1))\nLISTEN 0 512 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=501,fd=1))\n' };
    throw new Error('unexpected ' + cmd);
  };
  const readCgroup = (pid) => ({ 500: '0::/system.slice/claude-hub.service\n', 501: '0::/system.slice/system-vite.slice/vite@game.service\n' })[pid] || '';
  const lister = S.makeServiceLister({ projectsRoot, hubDir, exec, unitDir, user: 'me', home: '/home/me', readCgroup });
  const { services, tailnet } = await lister.list();
  const units = services.map((s) => s.unit);
  assert.deepEqual(units, ['claude-hub.service', 'omni.service', 'site.service', 'stt.service', 'vite@game.service', 'vite@other.service']);
  const game = services.find((s) => s.unit === 'vite@game.service');
  assert.equal(game.project, 'game');
  assert.equal(game.url, '/game/');
  const site = services.find((s) => s.unit === 'site.service');
  assert.equal(site.url, '/theology/');
  const stt = services.find((s) => s.unit === 'stt.service');
  assert.equal(stt.title, 'Whisper');
  assert.equal(stt.url, 'https://x:8012/');
  assert.equal(services.find((s) => s.unit === 'vite@other.service').active, 'failed');
  const hub = services.find((s) => s.unit === 'claude-hub.service');
  assert.equal(hub.title, 'claude-hub');
  assert.equal(hub.project, 'hub', 'no sentinel → the unit\'s WorkingDirectory under the root is its project (V101)');
  assert.equal(services.find((s) => s.unit === 'vite@other.service').project, 'other');
  assert.equal(stt.project, null, 'a WorkingDirectory outside the root is not a project');
  assert.equal(services.find((s) => s.unit === 'omni.service').project, null);
  assert.deepEqual(hub.ports, [4096]);
  assert.equal(hub.tailnetUrl, 'https://h.ts.net:8443/');
  assert.equal(hub.url, 'https://h.ts.net:8443/', 'a unit with no sentinel URL takes the tailnet listener on its port');
  assert.deepEqual(game.ports, [5173]);
  assert.equal(game.url, '/game/', 'a sentinel URL still wins over a port match');
  assert.equal(tailnet.length, 2);
  assert.equal(await lister.isKnownUnit('vite@game.service'), true);
  assert.equal(await lister.isKnownUnit('ssh.service'), false, 'symlinked distro unit is not ours');
  assert.equal(await lister.isKnownUnit('cloud-init-network.service'), false, 'root-run distro unit dropped here is not ours');
  assert.equal(await lister.isKnownUnit('ollama.service'), false, 'another user\'s unit is not ours unless services.json opts it in');
  assert.equal(await lister.isKnownUnit('ttyd-shell.service'), false, 'ttyd family are sessions');
  assert.equal(S.isUnitName('vite@game.service'), true);
  assert.equal(S.isUnitName('../x.service'), false);
  assert.equal(S.isUnitName('x'), false);
});
