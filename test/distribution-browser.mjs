import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { startProductComposer } from '../spikes/browser/chatgpt/product-server.mjs';
import { InstallationLifecycle } from '../spikes/distribution/lifecycle.mjs';

// All browser state, downloads and registrations belong to this run. The local
// fixture supplies no external store, updater, provider account or key authority.
const root = await realpath(await mkdtemp('/private/tmp/provenance-distribution-browser-test-'));
let browser, socket, server;
try {
  let lifecycle = await new InstallationLifecycle({ supportDirectory: join(root, 'support'),
    chromeSupportDirectory: join(root, 'fake-chrome'), browserHost: join(root, 'Test.app/Contents/MacOS/host'), sequence: 2 }).init();
  const state = { eligibility: 'UNENROLLED' };
  server = await startProductComposer({ browserState: () => null,
    session: { status: () => state, receipts: { list: () => [] }, managedStatus: () => ({ state: 'NOT_CONFIGURED' }) },
    maintenance: { status: () => lifecycle.status(), enable: () => lifecycle.enable(),
      store: () => ({ opened: false }), offerExport: async () => { await lifecycle.record('exportOffered'); return {}; },
      remove: data => lifecycle.remove(data), diagnostics: () => lifecycle.diagnostics(),
      checkUpdate: () => ({ state: 'AVAILABLE', version: '1.2.0' }),
      downloadUpdate: () => ({ state: 'DOWNLOADED', instruction: 'Synthetic verified-update fixture. No installer opened.' }),
    } });
  const downloads = join(root, 'downloads'); await mkdir(downloads);
  browser = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', `--user-data-dir=${join(root, 'profile')}`, '--remote-debugging-port=0', '--no-first-run',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps',
    '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', 'about:blank',
  ], { env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore' });
  let launchError; browser.on('error', error => { launchError = error; });
  let port;
  for (let i = 0; i < 100; i++) {
    if (launchError) throw launchError;
    try { port = (await readFile(join(root, 'profile/DevToolsActivePort'), 'utf8')).split('\n')[0]; break; } catch { await delay(50); }
  }
  assert.ok(port, 'Isolated Chrome failed to start');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0; const pending = new Map();
  socket.onmessage = event => {
    const value = JSON.parse(event.data); if (!value.id) return;
    const request = pending.get(value.id); pending.delete(value.id);
    value.error ? request.reject(Error(JSON.stringify(value.error))) : request.resolve(value.result);
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id; pending.set(n, { resolve, reject }); socket.send(JSON.stringify({ id: n, method, params }));
  });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value;
  };
  const wait = async expression => {
    for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await delay(30); }
    throw Error(`Local distribution UI timed out: ${expression}`);
  };
  const click = id => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
  await call('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  await call('Page.navigate', { url: server.url });
  await wait("document.querySelector('#installation-state')?.textContent.includes('disabled') && !document.querySelector('#enable-integration').disabled");
  assert.equal(await evaluate('document.title'), 'Attestamp · ChatGPT');
  assert.equal(await evaluate("document.querySelector('header span').textContent"), 'ATTESTAMP');
  const visible = await evaluate('document.body.innerText');
  assert.match(visible, /Attestamp Verifier app/);
  assert.doesNotMatch(visible, /private[ -]?provenance/i);
  await click('enable-integration'); await wait("document.querySelector('#installation-state').textContent.includes('enabled')");
  assert.equal((await lifecycle.status()).integration, 'ENABLED');
  await click('check-update'); await wait("!document.querySelector('#download-update').disabled");
  await click('download-update'); await wait("document.querySelector('#update-state').textContent.startsWith('Synthetic')");
  await click('offer-export'); await wait("!document.querySelector('#removal-options').hidden && !document.querySelector('#remove-integration').disabled");
  await click('remove-integration'); await wait("document.querySelector('#status').textContent.includes('Evidence and keys retained')");
  assert.equal((await lifecycle.status()).integration, 'DISABLED');
  await click('save-diagnostics');
  let report;
  for (let i = 0; i < 100; i++) {
    try { report = JSON.parse(await readFile(join(downloads, 'provenance-support.json'), 'utf8')); break; } catch { await delay(30); }
  }
  assert.equal(report?.profile, 'pap-support/1'); assert.equal(report.events.integrationRemoved, 1);
  assert.doesNotMatch(JSON.stringify(report), /Test\.app|fake-chrome|127\.0\.0\.1|supportDirectory/);
  state.eligibility = 'REVOKED'; await click('refresh');
  await wait("document.querySelector('#scope').textContent.includes('eligibility revoked')");
  assert.equal(await evaluate("document.querySelector('#freeze').disabled && document.querySelector('#release').disabled"), true);
  lifecycle = await new InstallationLifecycle({ supportDirectory: join(root, 'candidate-support'),
    chromeSupportDirectory: join(root, 'candidate-chrome'), browserHost: join(root, 'Attestamp.app/Contents/MacOS/host'),
    sequence: 2, releaseChannel: 'release-candidate' }).init();
  // The composer clears its pairing fragment. Re-enter through a new document
  // so navigation cannot become a same-document hash change with stale state.
  await call('Page.navigate', { url: 'about:blank' });
  await wait("location.href === 'about:blank'");
  await call('Page.navigate', { url: server.url });
  await wait("document.querySelector('#release-channel')?.textContent.startsWith('ATTESTAMP RELEASE CANDIDATE')");
  assert.equal(await evaluate("document.querySelector('#check-update').disabled && document.querySelector('#download-update').disabled"), true);
  assert.doesNotMatch(await evaluate('document.body.innerText'), /private[ -]?provenance/i);
  await click('close'); await wait("document.querySelector('#status').textContent === 'Local runtime closed.'");
  console.log(JSON.stringify({ localSetupUI: 'PASS', diagnostics: 'CONTENT_FREE', network: 'LOOPBACK_FIXTURES_ONLY',
    storeInstall: 'NOT_RUN', osPermissions: 'NOT_RUN', signedProviderPairing: 'NOT_RUN' }));
} finally {
  socket?.close();
  if (browser && browser.exitCode === null) {
    const stopped = new Promise(resolve => browser.once('exit', resolve)); browser.kill('SIGKILL'); await stopped;
  }
  await server?.close(); await rm(root, { recursive: true, force: true });
}
