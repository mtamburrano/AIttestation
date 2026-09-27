// Real Firefox loads the generated extension in a fresh, network-isolated
// profile. The native-host name is replaced with a unique nonexistent test name;
// this checks browser APIs/manifest/sidebar isolation, not native ancestry.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const root = await mkdtemp('/private/tmp/attestamp-firefox-browser-test-');
const profile = join(root, 'profile'), extension = join(root, 'extension');
const application = join(root, 'Firefox.app');
let browser, socket, server, browserOutput = '';
const pending = new Map(); let sequence = 0, packet = Buffer.alloc(0), ready = false, report;
const wait = async (check, attempts = 200) => { for (let n = 0; n < attempts; n++) { if (await check()) return; await delay(50); } throw Error('FIREFOX_TEST_TIMEOUT'); };
const command = (name, args = {}) => new Promise((resolve, reject) => {
  const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error(`FIREFOX_COMMAND_TIMEOUT:${name}`)); }, 10000);
  pending.set(id, { resolve, reject, timer });
  const text = JSON.stringify([0, id, name, args]); socket.write(`${Buffer.byteLength(text)}:${text}`);
});
try {
  await mkdir(profile); await cp(new URL('../spikes/browser/firefox/extension', import.meta.url), extension, { recursive: true });
  // Validate before any launch, including startup updater execution. A profile
  // alone does not isolate installation-level update state.
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '/Applications/Firefox.app'], { stdio: 'pipe' });
  execFileSync('/bin/cp', ['-cR', '/Applications/Firefox.app', application]);
  server = createServer(async (request, response) => {
    const chunks = []; for await (const bytes of request) chunks.push(bytes);
    if (request.url === '/probe') report = JSON.parse(Buffer.concat(chunks));
    response.writeHead(200, { 'Access-Control-Allow-Origin': '*' }); response.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json')));
  manifest.host_permissions.push(`${origin}/*`);
  manifest.content_security_policy.extension_pages += `; connect-src ${origin}`;
  manifest.background.scripts.push('probe.js');
  await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(extension, 'service-worker.js'), (await readFile(join(extension, 'service-worker.js'), 'utf8'))
    .replace("'ai.provenance.consumer.firefox'", JSON.stringify(`test.attestamp.${randomUUID().replaceAll('-', '')}`)));
  await writeFile(join(extension, 'probe.js'), `
    async function reportProbe() { await fetch(${JSON.stringify(origin + '/probe')}, {method:'POST',body:JSON.stringify({
      browser:await browser.runtime.getBrowserInfo(), profile:ADAPTER_PROFILE, worker:typeof inspectTabs,
      sidebarAPI:typeof browser.sidebarAction.open, sidebar:browser.runtime.getURL('sidepanel.html'),
      probe:browser.runtime.getURL('probe.html'), views:browser.extension.getViews({type:'sidebar'}).length
    })}); }
    reportProbe(); let probes=0; const timer=setInterval(()=>{reportProbe();if(++probes===20)clearInterval(timer)},250);
  `);
  await writeFile(join(extension, 'probe.html'), '<!doctype html><button id="open">Open sidebar</button><script src="probe-button.js"></script>');
  await writeFile(join(extension, 'probe-button.js'), "document.getElementById('open').onclick=()=>browser.sidebarAction.open();");
  const preferences = { 'marionette.port': 0, 'marionette.log.level': 'Trace', 'browser.shell.checkDefaultBrowser': false,
    'browser.startup.homepage': 'about:blank', 'browser.startup.page': 0,
    'browser.newtabpage.enabled': false, 'network.proxy.type': 1, 'network.proxy.http': '127.0.0.1',
    'network.proxy.http_port': 9, 'network.proxy.ssl': '127.0.0.1', 'network.proxy.ssl_port': 9,
    'network.proxy.no_proxies_on': '127.0.0.1,localhost', 'network.trr.mode': 5,
    'network.dns.disablePrefetch': true, 'network.prefetch-next': false,
    'app.update.auto': false, 'extensions.update.enabled': false,
    'datareporting.healthreport.uploadEnabled': false, 'toolkit.telemetry.enabled': false,
    'browser.safebrowsing.downloads.enabled': false, 'browser.safebrowsing.phishing.enabled': false,
    'browser.safebrowsing.malware.enabled': false, 'network.captive-portal-service.enabled': false,
    'network.connectivity-service.enabled': false };
  await writeFile(join(profile, 'user.js'), Object.entries(preferences).map(([key, value]) => `user_pref(${JSON.stringify(key)},${JSON.stringify(value)});`).join('\n'));
  // Application updates are installation-scoped and can run before prefs load.
  // Keep Firefox's sandbox. An outer Seatbelt profile prevents its child sandbox
  // from starting. Mozilla's automation guard disallows nonlocal connections.
  browser = spawn(join(application, 'Contents/MacOS/firefox'),
    ['--headless', '--no-remote', '--profile', profile, '--marionette', '-remote-allow-system-access', 'about:blank'],
    { env: { PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root, MOZ_MARIONETTE: '1', MOZ_CRASHREPORTER_DISABLE: '1',
      MOZ_DISABLE_NONLOCAL_CONNECTIONS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  for (const stream of [browser.stdout, browser.stderr]) stream.on('data', bytes => { browserOutput = (browserOutput + bytes.toString()).slice(-8192); });
  await wait(async () => {
    if (browser.exitCode !== null) throw Error(`FIREFOX_EXIT:${browser.exitCode}:${browserOutput}`);
    const port = Number(await readFile(join(profile, 'MarionetteActivePort'), 'utf8').catch(() => ''));
    if (!port) return false;
    const attempt = connect(port, '127.0.0.1');
    return new Promise(resolve => { attempt.once('error', () => { attempt.destroy(); resolve(false); });
      attempt.once('connect', () => { socket = attempt; resolve(true); }); });
  }, 800).catch(error => { throw Error(`${error.message}:${browserOutput}`); });
  socket.on('data', bytes => {
    packet = Buffer.concat([packet, bytes]);
    for (;;) {
      const colon = packet.indexOf(58); if (colon < 0) return;
      const length = Number(packet.subarray(0, colon)); if (packet.length < colon + 1 + length) return;
      const value = JSON.parse(packet.subarray(colon + 1, colon + 1 + length)); packet = packet.subarray(colon + 1 + length);
      if (!Array.isArray(value)) { ready = value.marionetteProtocol === 3; continue; }
      const operation = pending.get(value[1]); if (!operation) continue;
      pending.delete(value[1]); clearTimeout(operation.timer);
      value[2] ? operation.reject(Error(JSON.stringify(value[2]))) : operation.resolve(value[3]);
    }
  });
  await wait(() => ready);
  const session = await command('WebDriver:NewSession', { capabilities: { alwaysMatch: {} } });
  await command('Addon:Install', { path: extension, temporary: true });
  await wait(() => report);
  assert.equal(report.browser.name, 'Firefox'); assert.equal(report.profile, 'pap-chatgpt-firefox/1');
  assert.equal(report.worker, 'function'); assert.equal(report.sidebarAPI, 'function');
  await command('WebDriver:Navigate', { url: report.probe });
  const element = await command('WebDriver:FindElement', { using: 'css selector', value: '#open' });
  await command('WebDriver:ElementClick', { id: (element.value ?? element)['element-6066-11e4-a52e-4f735466cecf'] });
  await wait(() => report.views === 1);
  await command('WebDriver:Navigate', { url: report.sidebar });
  let state;
  await wait(async () => {
    const result = await command('WebDriver:ExecuteScript', { script: 'return document.body.innerText;', args: [], sandbox: 'default' });
    state = result.value ?? result;
    return state.includes('Recording control could not be verified. Close and reopen this sidebar.');
  });
  console.log(JSON.stringify({ evidence: 'REAL_FIREFOX_TEMPORARY_EXTENSION_WITH_ISOLATED_NATIVE_NAME',
    version: report.browser.version, buildID: report.browser.buildID, sidebarOpened: true,
    ordinaryTabReply: state, sessionVersion: session.capabilities?.browserVersion ?? session.value?.capabilities?.browserVersion }));
  await command('Addon:Uninstall', { id: manifest.browser_specific_settings.gecko.id });
  await command('Marionette:Quit', { flags: ['eForceQuit'] }).catch(() => {});
} finally {
  for (const operation of pending.values()) clearTimeout(operation.timer);
  socket?.destroy();
  if (browser && browser.exitCode === null) { try { process.kill(-browser.pid, 'SIGTERM'); } catch {} }
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
  if (browser && browser.exitCode === null) await Promise.race([new Promise(resolve => browser.once('close', resolve)), delay(3000)]);
  await rm(root, { recursive: true, force: true });
}
