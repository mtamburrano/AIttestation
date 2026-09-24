import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { recordingFixture, until } from './recording-fixture.mjs';
import { InstallationLifecycle } from '../spikes/distribution/lifecycle.mjs';
import { disclosureRegressions } from './dashboard-disclosure-browser.mjs';
import { scaleObservation } from './vault-scale-fixture.mjs';
import { OwnerDebugSession } from '../spikes/development/debug-session.mjs';

// Real local UI, fresh browser profile/vault and synthetic provider and sponsor.
const root = await mkdtemp('/private/tmp/attestamp-dashboard-browser-test-');
let f, browser, socket, debugSession;
try {
  const installation = await new InstallationLifecycle({ supportDirectory: join(root, 'installation'),
    chromeSupportDirectory: join(root, 'chrome'), browserHost: join(root, 'synthetic-host'), sequence: 1 }).init();
  await installation.enable();
  const installStatus = installation.status.bind(installation);
  installation.status = async () => ({ ...await installStatus(), releaseClass: 'SYNTHETIC_FIXTURE', releaseChannel: null });
  let connected = true, accountState = { state: 'ACTIVE', remaining: 7, month: '2026-09' }; const opened = [];
  debugSession = new OwnerDebugSession(root);
  f = await recordingFixture(root, { installation, debugSession, diagnostics: debugSession.diagnostics,
    openDashboard: async url => { opened.push(url); }, managed: {
    status: () => connected ? { ...accountState, token: 'SYNTHETIC_ACCOUNT_SECRET' } : { state: 'ACCOUNT_REQUIRED' },
    disconnect: () => { connected = false; return { state: 'ACCOUNT_REQUIRED' }; },
    submit: async (_payload, { beforeSubmit }) => { beforeSubmit(); return { transactionId: 'A'.repeat(52) }; },
  } });
  await f.recording(true); f.send('<img src="https://never.invalid/tracker">SYNTHETIC_DASHBOARD_CANARY');
  await until(() => f.runtime.session.receipts.list().length === 1); await f.runtime.engine.drain();
  browser = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', `--user-data-dir=${join(root, 'profile')}`, '--remote-debugging-port=0', '--no-first-run',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps',
    '--disable-updater-scheduler', '--use-mock-keychain', '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', 'about:blank',
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
    for (let i = 0; i < 150; i++) {
      try { if (await evaluate(expression)) return; }
      catch (error) {
        // Page.reload invalidates the old evaluation context before the new
        // document is available; keep polling the same bounded condition.
        if (!/Inspected target navigated or closed|Execution context was destroyed|Cannot find context/.test(error.message)) throw error;
      }
      await delay(30);
    }
    throw Error(`Dashboard UI condition failed: ${expression}; ${JSON.stringify({ exceptions,
      feedback: await evaluate(`(()=>{const node=document.querySelector('#feedback-debug-session-save');return {rect:node?.getBoundingClientRect().toJSON(),active:document.activeElement?.id,scrollY,innerHeight};})()`), visible: await evaluate('document.body.innerText') })}`);
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
  for (const [value, expected] of [
    [{ state: 'ACTIVE', remaining: 7, month: '2026-09' }, '7 anchors remaining. Period: 2026-09.'],
    [{ state: 'ACTIVE', remaining: 0, month: '2026-09' }, 'Anchoring quota exhausted.'],
    [{ state: 'ACCOUNT_REQUIRED' }, 'No anchoring account connected.'],
    [{ state: 'UNPAID' }, 'Anchoring account unpaid or expired.'],
    [{ state: 'QUOTA_EXHAUSTED' }, 'Anchoring quota exhausted.'],
    [{ state: 'SERVICE_UNAVAILABLE' }, 'Anchoring service unavailable.'],
    [{ state: '__proto__', remaining: 'SYNTHETIC_ACCOUNT_SECRET', month: 'SYNTHETIC_ACCOUNT_SECRET' }, 'Anchoring service unavailable.'],
  ]) {
    accountState = value; await click('refresh-account');
    await wait(`document.querySelector('#account').textContent.includes(${JSON.stringify(expected)})`);
    assert.doesNotMatch(await evaluate('document.body.innerText'), /SYNTHETIC_ACCOUNT_SECRET/);
    assert.equal(await evaluate('document.activeElement.id'), 'feedback-refresh-account');
  }
  const page = f.runtime.session.receipts.page.bind(f.runtime.session.receipts);
  f.runtime.session.receipts.page = options => {
    const result = page(options), extra = ['OUTCOME_UNKNOWN', 'FAILED_BEFORE_EGRESS'].map((outcome, index) => ({
      id: `synthetic-history-${index}`, prompt: { mode: 'Historical', outcome, anchor: 'PENDING' },
    }));
    return { ...result, receipts: [...result.receipts, ...extra],
      counts: { ...result.counts, needsAttention: 2, prompts: result.counts.prompts + 2 } };
  };
  await click('refresh'); await wait("document.querySelector('#attention-count').textContent === '2'");
  await click('filter-attention'); await wait("document.querySelector('#filter-attention').getAttribute('aria-pressed') === 'true'");
  assert.equal(await evaluate("document.querySelectorAll('#prompts article').length"), 2);
  assert.equal(await evaluate("document.querySelectorAll('#prompts article.attention').length"), 2);
  assert.match(await evaluate("document.querySelector('#prompts').textContent"), /Do not resend automatically/);
  assert.match(await evaluate("document.querySelector('#history-filter').textContent"), /2 shown · 2 retained/);
  f.runtime.session.receipts.page = page;
  await click('all-prompts'); await wait("document.querySelectorAll('#prompts article').length === 1");
  assert.equal(await evaluate("document.querySelector('#debug-session-banner').hidden"), true);
  assert.equal(await evaluate("document.querySelector('#debug-session-new').disabled"), true);
  await click('debug-session-toggle'); await wait("document.querySelector('#debug-session-status').textContent.startsWith('Debug recording active')");
  const firstDebugId = debugSession.status().sessionId;
  assert.equal(await evaluate("document.querySelector('#debug-session-toggle').textContent"), 'Pause debug recording');
  assert.equal(await evaluate("document.querySelector('#debug-session-banner').hidden"), false);
  await click('debug-session-toggle'); await wait("document.querySelector('#debug-session-status').textContent.startsWith('Debug recording paused')");
  assert.equal(await evaluate("document.querySelector('#debug-session-toggle').textContent"), 'Resume debug recording');
  assert.equal(debugSession.status().sessionId, firstDebugId);
  await click('debug-session-toggle'); await wait("document.querySelector('#debug-session-status').textContent.startsWith('Debug recording active')");
  assert.equal(debugSession.status().sessionId, firstDebugId);
  await click('recording'); await wait("document.querySelector('#effective-state').textContent === 'Attestamp is OFF'");
  await disclosureRegressions({ call, evaluate, wait, click, root });
  await evaluate("document.querySelector('#prompts input').click()"); await click('preview-export');
  await wait("!document.querySelector('#save-export').disabled");
  assert.match(await evaluate("document.querySelector('#preview-texts').textContent"), /SYNTHETIC_DASHBOARD_CANARY/);
  assert.equal(await evaluate("document.querySelector('#preview-texts img') === null"), true);
  await click('disconnect-account'); await wait("document.querySelector('#account').textContent.startsWith('No anchoring account connected')");
  await click('save-export');
  await until(async () => { try { return (await readFile(join(root, 'attestamp-evidence.json'))).length > 0; } catch { return false; } });
  const screenshotRoot = await mkdtemp('/private/tmp/attestamp-dashboard-preview-');
  const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await writeFile(join(screenshotRoot, 'dashboard.png'), Buffer.from(screenshot.data, 'base64'));
  await click('close'); await wait("document.querySelector('#message').textContent.startsWith('Dashboard closed.')");
  assert.equal(f.runtime.engine.state().recording, false);
  await evaluate('globalThis.__departingDashboard = true');
  await call('Page.reload'); await wait("!globalThis.__departingDashboard && document.querySelector('#effective-state')?.textContent === 'Attestamp is OFF'");
  assert.equal(await evaluate("document.querySelector('#debug-session-banner').hidden"), false);
  assert.equal(await evaluate("document.querySelector('#prompt-count').textContent"), '1');
  await click('disable'); await wait("document.querySelector('#effective-state').textContent === 'Chrome connection disabled'");
  await click('enable'); await wait("document.querySelector('#message').textContent.startsWith('Connection enabled.')");
  await click('recording'); await wait("document.querySelector('#effective-state').textContent === 'Chrome disconnected'");
  await click('prepare-remove'); await wait("!document.querySelector('#removal').hidden");
  await click('remove'); await wait("document.querySelector('#message').textContent.startsWith('Connection removed.')");
  assert.equal(await evaluate("document.querySelector('#prompt-count').textContent"), '1');
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 850, deviceScaleFactor: 1, mobile: false });
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  await click('debug-session-save');
  await until(async () => { try { return (await readFile(join(root, 'attestamp-debug-session.json'))).length > 0; } catch { return false; } });
  const debugExport = await readFile(join(root, 'attestamp-debug-session.json'), 'utf8');
  await wait("document.querySelector('#feedback-debug-session-save')?.textContent.startsWith('Private debug session saved.')");
  await wait(`(()=>{const node=document.querySelector('#feedback-debug-session-save'), rect=node.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= innerHeight && document.activeElement === node;})()`);
  assert.ok(JSON.parse(debugExport).segments.flatMap(segment => segment.events).some(event => event.code === 'BRIDGE_DISCONNECTED'));
  assert.doesNotMatch(debugExport, /SYNTHETIC_DASHBOARD_CANARY|SYNTHETIC_ACCOUNT_SECRET|https:\/\/|token|digest|DOM/);
  assert.equal(await evaluate("document.querySelector('#debug-session-new').disabled && document.querySelector('#debug-session-acknowledge').disabled"), true);
  const engineBeforeFresh = f.runtime.engine.state(), vaultBeforeFresh = f.runtime.session.vault.inspect();
  const installationBeforeFresh = await installation.status();
  await click('debug-session-toggle'); await wait("document.querySelector('#debug-session-status').textContent.startsWith('Debug recording paused')");
  await click('debug-session-new'); assert.equal(debugSession.status().sessionId, firstDebugId);
  await click('debug-session-acknowledge'); await wait("!document.querySelector('#debug-session-new').disabled");
  await click('refresh'); await wait("!document.querySelector('#debug-session-new').disabled");
  await click('debug-session-new');
  await wait("document.querySelector('#feedback-debug-session-new')?.textContent.startsWith('Fresh debug session created')");
  const freshDebugId = debugSession.status().sessionId;
  assert.notEqual(freshDebugId, firstDebugId); assert.equal(debugSession.status().retainedEvents, 0);
  assert.equal(debugSession.status().state, 'STOPPED');
  assert.match(await evaluate("document.querySelector('#debug-session-status').textContent"), /paused · 0 retained events · 0 segments/);
  assert.equal(await evaluate("document.querySelector('#debug-session-new').disabled && !document.querySelector('#debug-session-acknowledge').checked"), true);
  assert.deepEqual(f.runtime.engine.state(), engineBeforeFresh); assert.deepEqual(f.runtime.session.vault.inspect(), vaultBeforeFresh);
  assert.deepEqual(await installation.status(), installationBeforeFresh);
  assert.equal(await readFile(join(root, 'attestamp-debug-session.json'), 'utf8'), debugExport);
  await writeFile(join(screenshotRoot, 'debug-session-fresh.png'), Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await click('debug-session-toggle'); await wait("document.querySelector('#debug-session-status').textContent.startsWith('Debug recording active')");
  assert.equal(debugSession.status().sessionId, freshDebugId);
  debugSession.diagnostics.record('BRIDGE_TIMEOUT', { epochId: 'synthetic-after-fresh-session' });
  await click('debug-session-toggle'); await wait("document.querySelector('#debug-session-status').textContent.startsWith('Debug recording paused')");
  await click('debug-session-acknowledge'); await wait("!document.querySelector('#debug-session-new').disabled");
  await click('debug-session-toggle'); await wait("document.querySelector('#debug-session-status').textContent.startsWith('Debug recording active')");
  assert.equal(await evaluate("document.querySelector('#debug-session-acknowledge').checked"), false);
  await click('debug-session-toggle'); await wait("document.querySelector('#debug-session-status').textContent.startsWith('Debug recording paused')");
  await click('debug-session-acknowledge'); await click('debug-session-new');
  await wait("document.querySelector('#feedback-debug-session-new')?.textContent.startsWith('Fresh debug session created')");
  assert.notEqual(debugSession.status().sessionId, freshDebugId); assert.equal(debugSession.status().retainedEvents, 0);
  assert.equal(await readFile(join(root, 'attestamp-debug-session.json'), 'utf8'), debugExport);
  for (let n = 0; n < 12; n++) f.runtime.session.observeNormal(scaleObservation(n, `UI_HISTORY_NEEDLE_${n}`));
  await click('refresh'); await wait("document.querySelector('#prompt-count').textContent === '13'");
  assert.equal(await evaluate("document.querySelectorAll('#prompts article').length"), 5);
  await click('history-older'); await wait("!document.querySelector('#history-newer').hidden");
  assert.equal(await evaluate("document.querySelectorAll('#prompts article').length"), 5);
  await click('history-older'); await wait("document.querySelectorAll('#prompts article').length === 3");
  await evaluate("document.querySelector('#history-search').value = 'SYNTHETIC_DASHBOARD_CANARY'");
  await click('history-search-button'); await wait("document.querySelectorAll('#prompts article').length === 1");
  assert.equal(await evaluate("document.querySelector('#history-older').hidden"), true);
  await writeFile(join(screenshotRoot, 'history-search.png'), Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
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
  console.log(`PASS: dashboard rendering, privacy, ON/OFF, close/reopen, account loss, export, acknowledged fresh debug sessions, integration controls and free verifier shutdown. Screenshots: ${screenshotRoot}`);
} finally {
  socket?.close();
  if (browser && browser.exitCode === null) { const exited = new Promise(resolve => browser.once('exit', resolve)); browser.kill(); await exited; }
  await f?.close(); debugSession?.close(); await rm(root, { recursive: true, force: true });
}
