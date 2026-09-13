import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const bundleIndex = process.argv.indexOf('--bundle');
const serverModule = bundleIndex < 0 ? new URL('../spikes/demonstrator/server.mjs', import.meta.url)
  : pathToFileURL(join(process.argv[bundleIndex + 1], 'Contents/Resources/spikes/demonstrator/server.mjs'));
const { startDemo } = await import(serverModule);

// All files, downloads, keys and the browser profile belong to this test run.
// The provider is synthetic loopback; DNS for external hosts is disabled.
const root = await mkdtemp(join(tmpdir(), 'provenance-consumer-browser-test-'));
let chrome, socket, app;
const measurements = { source: 'SYNTHETIC_LOCAL_DEMO', chainLatencyMs: null, chainFeeMicroAlgos: null };
try {
  app = await startDemo(root);
  const binary = process.env.PROVENANCE_TEST_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  chrome = spawn(binary, ['--headless=new', `--user-data-dir=${join(root, 'profile')}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--disable-default-apps', '--use-mock-keychain', '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', 'about:blank'], { env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore' });
  let launchError; chrome.on('error', e => { launchError = e; });
  let port;
  for (let i = 0; i < 100; i++) {
    if (launchError) throw launchError;
    try { port = (await readFile(join(root, 'profile', 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; } catch { await delay(50); }
  }
  assert.ok(port, 'Isolated Chrome failed to start');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  socket = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0; const pending = new Map();
  socket.onmessage = e => { const v = JSON.parse(e.data); if (v.id) { const p = pending.get(v.id); pending.delete(v.id); v.error ? p.reject(Error(v.error.message)) : p.resolve(v.result); } };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id; pending.set(n, { resolve, reject }); socket.send(JSON.stringify({ id: n, method, params }));
  });
  const evaluate = async expression => {
    const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails)); return r.result.value;
  };
  const wait = async expression => {
    for (let i = 0; i < 150; i++) { if (await evaluate(expression)) return; await delay(30); }
    throw Error(`Timed out: ${expression}; status=${await evaluate("document.querySelector('#status')?.textContent")}`);
  };
  const click = id => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
  const setFile = async (selector, path) => {
    const dom = await call('DOM.getDocument'); const node = await call('DOM.querySelector', { nodeId: dom.root.nodeId, selector });
    await call('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [path] });
  };
  const downloaded = async name => { const path = join(root, name); for (let i = 0; i < 100; i++) { try { if ((await stat(path)).size > 0) return path; } catch {} await delay(30); } throw Error(`Missing download ${name}`); };
  await call('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: root });
  await call('Emulation.setDeviceMetricsOverride', { width: 1200, height: 950, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: app.url }); await wait("document.querySelector('#start') !== null");
  await evaluate("document.querySelector('#policy').value='fixture';document.querySelector('#enrollment').click()");
  await click('start'); await wait("!document.querySelector('#freeze').disabled");
  await evaluate("document.querySelector('#draft').focus()");
  await call('Input.insertText', { text: 'new synthetic browser draft e\u0301 ☕' });
  const attachment = join(root, 'synthetic-attachment.bin'); await writeFile(attachment, Buffer.from([0, 255, 13, 10]));
  await setFile('#files', attachment); assert.equal(app.egress.size, 0);
  const sealStart = performance.now();
  await click('freeze'); await wait("document.querySelector('#status').textContent.startsWith('PENDING_ANCHOR')");
  assert.equal(app.egress.size, 0);
  await click('confirm'); await wait("document.querySelector('#status').textContent.startsWith('SEALED_NOT_SENT')");
  measurements.fixtureSealMs = performance.now() - sealStart; assert.equal(app.egress.size, 0);
  await click('release'); await wait("document.querySelector('#status').textContent.startsWith('Submission observed and visible response captured')");
  assert.equal(app.egress.size, 1);
  assert.deepEqual([...app.egress.values()][0].payload, { text: 'new synthetic browser draft e\u0301 ☕', attachments: [{ name: 'synthetic-attachment.bin', bytes: 'AP8NCg==' }] });
  await evaluate("document.querySelector('#mode').value='Continuous';document.querySelector('#mode').dispatchEvent(new Event('change'));document.querySelector('#draft').value='new Continuous synthetic draft';document.querySelector('#draft').dispatchEvent(new Event('input'))");
  await click('freeze'); await wait("document.querySelector('#status').textContent.startsWith('Submission observed and visible response captured')");
  assert.equal(app.egress.size, 2); assert.equal(app.session.status().versions[1].anchor, 'PENDING');
  await click('confirm'); await wait("document.querySelector('#status').textContent.startsWith('Continuous evidence confirmed')");
  await evaluate("document.querySelector('#mode').value='Always Protect';document.querySelector('#mode').dispatchEvent(new Event('change'));document.querySelector('#draft').value='new scoped automatic synthetic draft';document.querySelector('#draft').dispatchEvent(new Event('input'))");
  await click('supported'); await click('freeze'); await wait("document.querySelector('#status').textContent.startsWith('UNSUPPORTED_PATH')");
  assert.equal(app.egress.size, 2);
  await click('supported'); await click('freeze'); await wait("document.querySelector('#status').textContent.startsWith('Submission observed and visible response captured')");
  assert.equal(app.egress.size, 3); assert.ok(app.session.status().versions.every(v => v.response));
  await click('export'); const exportPath = await downloaded('evidence-export.json');
  await wait("!document.querySelector('#freeze').disabled");
  await click('saveTrust'); const trustPath = await downloaded('separate-trust.json');
  await wait("!document.querySelector('#freeze').disabled");
  await click('backup'); const backupPath = await downloaded('encrypted-recovery.json');
  await wait("!document.querySelector('#secret').disabled && !document.querySelector('#freeze').disabled");
  await click('secret'); const secretPath = await downloaded('separate-recovery-secret.txt');
  await setFile('#recoveryPackage', backupPath); await setFile('#recoverySecret', secretPath);
  const restoreStart = performance.now(); await click('restore'); await wait("document.querySelector('#recoveryStatus').textContent.includes('COMPLETE')");
  measurements.restoreMs = performance.now() - restoreStart;
  assert.match(await evaluate("document.querySelector('#recoveryStatus').textContent"), /NONE; restored history never authorizes sending/);
  assert.equal(app.egress.size, 3);
  await click('saveRestored'); const restoredPath = await downloaded('restored-evidence-export.json');
  await setFile('#verifyExport', exportPath); await setFile('#verifyTrust', trustPath);
  await click('verify'); await wait("document.querySelector('#status').textContent.startsWith('Local verification finished')");
  const report = JSON.parse(await evaluate("document.querySelector('#verification').textContent"));
  assert.equal(report.valid, true); assert.equal(report.anchors.length, 3);
  assert.ok(report.anchors.every(a => a.anchor === 'FIXTURE_VERIFIED'));
  await setFile('#verifyExport', restoredPath); await click('verify');
  await wait("document.querySelector('#status').textContent.startsWith('Local verification finished') && !document.querySelector('#freeze').disabled");
  const restoredReport = JSON.parse(await evaluate("document.querySelector('#verification').textContent"));
  assert.equal(restoredReport.valid, true); assert.equal(restoredReport.anchors.length, 3);
  measurements.exportBytes = (await stat(exportPath)).size; measurements.recoveryBytes = (await stat(backupPath)).size;
  await writeFile(join(root, 'measurements.json'), JSON.stringify(measurements, null, 2));
  await evaluate('window.scrollTo(0,0)');
  const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await writeFile(join(root, 'demonstrator.png'), Buffer.from(screenshot.data, 'base64'));
  console.log(`PASS: Chrome Sealed, Continuous, scoped automatic protection, unsupported path, visible DOM response, evidence/recovery downloads, fresh restore and offline verification.\n${JSON.stringify(measurements)}\nTest artifacts: ${root}`);
} finally {
  socket?.close();
  if (chrome && chrome.exitCode === null) { const exited = new Promise(r => chrome.once('exit', r)); chrome.kill(); await exited; }
  await app?.close();
  if (!process.argv.includes('--keep-artifacts')) await rm(root, { recursive: true, force: true });
}
