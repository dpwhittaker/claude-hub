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
      return { stdout: units.map((u) => `Id=${u}\nDescription=d ${u}\nActiveState=${u.startsWith('vite@other') ? 'failed' : 'active'}\nSubState=running\nMainPID=1\n`).join('\n') };
    }
    if (cmd === 'tailscale') return { stdout: 'https://h.ts.net:7788 (tailnet only)\n|-- / proxy http://localhost:7788\n' };
    throw new Error('unexpected ' + cmd);
  };
  const lister = S.makeServiceLister({ projectsRoot, hubDir, exec, unitDir, user: 'me', home: '/home/me' });
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
  assert.equal(services.find((s) => s.unit === 'claude-hub.service').title, 'claude-hub');
  assert.equal(tailnet.length, 1);
  assert.equal(await lister.isKnownUnit('vite@game.service'), true);
  assert.equal(await lister.isKnownUnit('ssh.service'), false, 'symlinked distro unit is not ours');
  assert.equal(await lister.isKnownUnit('cloud-init-network.service'), false, 'root-run distro unit dropped here is not ours');
  assert.equal(await lister.isKnownUnit('ollama.service'), false, 'another user\'s unit is not ours unless services.json opts it in');
  assert.equal(await lister.isKnownUnit('ttyd-shell.service'), false, 'ttyd family are sessions');
  assert.equal(S.isUnitName('vite@game.service'), true);
  assert.equal(S.isUnitName('../x.service'), false);
  assert.equal(S.isUnitName('x'), false);
});
