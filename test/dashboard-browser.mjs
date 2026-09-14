import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { continuousFixture, until } from './continuous-fixture.mjs';
import { InstallationLifecycle } from '../spikes/distribution/lifecycle.mjs';

// Real local UI, fresh browser profile/vault and synthetic provider and sponsor.
const root = await mkdtemp('/private/tmp/attestamp-dashboard-browser-test-');
let f, browser, socket;
try {
  const installation = await new InstallationLifecycle({ supportDirectory: join(root, 'installation'),
    chromeSupportDirectory: join(root, 'chrome'), browserHost: join(root, 'synthetic-host'), sequence: 1 }).init();
  await installation.enable();
  const installStatus = installation.status.bind(installation);
  installation.status = async () => ({ ...await installStatus(), releaseClass: 'SYNTHETIC_FIXTURE', releaseChannel: null });
  let connected = true; const opened = [];
  f = await continuousFixture(root, { installation, openDashboard: async url => { opened.push(url); }, managed: {
    status: () => ({ state: connected ? 'ACTIVE' : 'ACCOUNT_REQUIRED' }),
    disconnect: () => { connected = false; return { state: 'ACCOUNT_REQUIRED' }; },
    submit: async () => ({ transactionId: 'A'.repeat(52) }),
  } });
  await f.mode('Continuous'); f.send('<img src="https://never.invalid/tracker">SYNTHETIC_DASHBOARD_CANARY');
  await until(() => f.runtime.session.receipts.list().length === 1); await f.runtime.engine.drain();
  browser = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', `--user-data-dir=${join(root, 'profile')}`, '--remote-debugging-port=0', '--no-first-run',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps',
    '--disable-updater-scheduler', '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', 'about:blank',
  ], { env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore' });
  let launchError; browser.on('error', error => { launchError = error; });
  let port;
  for (let i = 0; i < 100; i++) {
    if (launchError) throw launchError;
    try { port = (await readFile(join(root, 'profile/DevToolsActivePort'), 'utf8')).split('\n')[0]; break; }
    catch { await delay(50); }
  }
  assert.ok(port, 'Isolated browser did not start');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  socket = new WebSocket(targets.find(value => value.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0; const pending = new Map(), exceptions = [];
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id; pending.set(n, { resolve, reject }); socket.send(JSON.stringify({ id: n, method, params }));
  });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const operation = pending.get(message.id); pending.delete(message.id);
      message.error ? operation.reject(Error(JSON.stringify(message.error))) : operation.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params);
  };
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value;
  };
  const wait = async expression => {
    for (let i = 0; i < 150; i++) { if (await evaluate(expression)) return; await delay(30); }
    throw Error(`Dashboard UI condition failed: ${expression}; ${JSON.stringify({ exceptions,
      visible: await evaluate('document.body.innerText') })}`);
  };
  await call('Page.enable'); await call('Runtime.enable'); await call('Network.enable');
  const requests = [];
  const receive = socket.onmessage;
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Network.requestWillBeSent') requests.push(message.params.request.url);
    receive(event);
  };
  await call('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: root });
  const click = id => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
  await call('Emulation.setDeviceMetricsOverride', { width: 1100, height: 950, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: f.runtime.dashboardURL });
  await wait("document.querySelector('#prompt-count')?.textContent === '1'");
  assert.equal(await evaluate('document.title'), 'Attestamp · Your prompts');
  assert.doesNotMatch(await evaluate('document.body.innerText'), /SYNTHETIC_DASHBOARD_CANARY/);
  await click('pause'); await wait("document.querySelector('#effective-state').textContent === 'Paused for all conversations'");
  await evaluate("document.querySelector('#prompts input').click()"); await click('preview-export');
  await wait("!document.querySelector('#save-export').disabled");
  assert.match(await evaluate("document.querySelector('#preview-texts').textContent"), /SYNTHETIC_DASHBOARD_CANARY/);
  assert.equal(await evaluate("document.querySelector('#preview-texts img') === null"), true);
  await click('disconnect-account'); await wait("document.querySelector('#account').textContent.startsWith('Anchoring unavailable')");
  await click('save-export');
  await until(async () => { try { return (await readFile(join(root, 'attestamp-evidence.json'))).length > 0; } catch { return false; } });
  const screenshotRoot = await mkdtemp('/private/tmp/attestamp-dashboard-preview-');
  const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await writeFile(join(screenshotRoot, 'dashboard.png'), Buffer.from(screenshot.data, 'base64'));
  await click('close'); await wait("document.querySelector('#message').textContent.startsWith('Dashboard closed.')");
  assert.equal(f.runtime.engine.state().preferences.paused, true);
  await call('Page.reload'); await wait("document.querySelector('#effective-state')?.textContent === 'Paused for all conversations'");
  assert.equal(await evaluate("document.querySelector('#prompt-count').textContent"), '1');
  await click('disable'); await wait("document.querySelector('#effective-state').textContent === 'Chrome connection disabled'");
  await click('enable'); await wait("document.querySelector('#message').textContent.startsWith('Connection enabled.')");
  await click('pause'); await wait("document.querySelector('#effective-state').textContent === 'Chrome disconnected'");
  await click('prepare-remove'); await wait("!document.querySelector('#removal').hidden");
  await click('remove'); await wait("document.querySelector('#message').textContent.startsWith('Connection removed.')");
  assert.equal(await evaluate("document.querySelector('#prompt-count').textContent"), '1');
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 850, deviceScaleFactor: 1, mobile: false });
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  await click('verifier'); await until(() => opened.length === 1);
  await call('Page.navigate', { url: opened[0] }); await wait("document.querySelector('#bundle') !== null");
  const dom = await call('DOM.getDocument'), field = await call('DOM.querySelector', { nodeId: dom.root.nodeId, selector: '#bundle' });
  await call('DOM.setFileInputFiles', { nodeId: field.nodeId, files: [join(root, 'attestamp-evidence.json')] });
  await click('verify'); await wait("document.querySelector('#status').textContent.startsWith('Local verification finished')");
  await click('close'); await wait("document.querySelector('#status').textContent.startsWith('Verifier shut down.')");
  assert.match(await evaluate("document.querySelector('#status').textContent"), /close this browser tab/);
  assert.equal(await evaluate("document.querySelector('#verify').disabled && document.querySelector('#close').disabled"), true);
  assert.deepEqual(exceptions, []);
  assert.ok(requests.every(url => url.startsWith('http://127.0.0.1:') || url.startsWith('blob:http://127.0.0.1:')));
  console.log(`PASS: dashboard rendering, privacy, pause, close/reopen, account loss, export, integration controls and free verifier shutdown. Screenshot: ${join(screenshotRoot, 'dashboard.png')}`);
} finally {
  socket?.close();
  if (browser && browser.exitCode === null) { const exited = new Promise(resolve => browser.once('exit', resolve)); browser.kill(); await exited; }
  await f?.close(); await rm(root, { recursive: true, force: true });
}
