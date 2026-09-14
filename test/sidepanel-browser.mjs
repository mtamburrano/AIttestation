import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { sidePanelFixture } from './sidepanel-fixture.mjs';

// Real rendering and clicks, synthetic Chrome APIs/provider/confirmation. All
// browser state and encrypted evidence belong to this fresh temporary run.
const root = await mkdtemp('/private/tmp/attestamp-panel-browser-test-');
let f, server, browser, socket, release;
const confirmation = new Promise(resolve => { release = resolve; });
try {
  f = await sidePanelFixture(root, { collectFast: () => confirmation });
  const panel = await f.panel();
  const assets = { '/sidepanel.html': 'text/html', '/sidepanel.js': 'text/javascript',
    '/sidepanel-model.js': 'text/javascript', '/sidepanel.css': 'text/css' };
  server = createServer(async (request, response) => {
    if (!Object.hasOwn(assets, request.url)) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Content-Type': assets[request.url],
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'" });
    response.end(await readFile(new URL(`../spikes/browser/chatgpt/extension${request.url}`, import.meta.url)));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}/sidepanel.html`;
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
    else if (message.method === 'Runtime.bindingCalled') {
      const request = JSON.parse(message.params.payload);
      panel.transport(request.message).then(result => call('Runtime.evaluate', { expression:
        `globalThis.fixtureReplies.get(${request.id})(${JSON.stringify(result)});globalThis.fixtureReplies.delete(${request.id});` })).catch(() => {});
    }
  };
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value;
  };
  const wait = async expression => {
    for (let i = 0; i < 150; i++) { if (await evaluate(expression)) return; await delay(30); }
    throw Error(`Panel UI condition failed: ${expression}; ${JSON.stringify({ exceptions,
      visible: await evaluate('document.body.innerText'), requests: f.requests.length })}`);
  };
  await call('Page.enable'); await call('Runtime.enable'); await call('Runtime.addBinding', { name: 'fixtureMessage' });
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `
    globalThis.fixtureReplies = new Map(); let fixtureId = 0;
    globalThis.chrome = { runtime: { sendMessage: message => new Promise(resolve => {
      const id = ++fixtureId; fixtureReplies.set(id, resolve); fixtureMessage(JSON.stringify({ id, message }));
    }) } };` });
  await call('Emulation.setDeviceMetricsOverride', { width: 360, height: 1050, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url });
  await wait("document.querySelector('#connection')?.textContent === 'Connected to Attestamp'");
  assert.equal(await evaluate("document.querySelector('#target').options.length"), 3);
  await evaluate("document.querySelector('#target').selectedIndex=1;document.querySelector('#target').dispatchEvent(new Event('change'))");
  await wait("!document.querySelector('#draft').disabled");
  f.pages.get(17).text = 'SYNTHETIC_EXISTING_PROVIDER_DRAFT';
  await wait("document.querySelector('#target-note').textContent.includes('already has a visible draft')");
  assert.equal(await evaluate("document.querySelector('#send').disabled"), true);
  f.pages.get(17).text = '';
  await wait("document.querySelector('#target-note').textContent.startsWith('Pinned destination')");
  await evaluate("document.querySelector('#draft').focus()");
  await call('Input.insertText', { text: 'SYNTHETIC_UI_PROMPT e\u0301 ☕' });
  await wait("!document.querySelector('#send').disabled");
  await evaluate("document.querySelector('#send').click();document.querySelector('#send').click()");
  await wait("document.querySelector('#operations').textContent.includes('Waiting for validated confirmation')");
  assert.equal(f.releases.length, 0);
  await evaluate("document.querySelector('#draft').value='SYNTHETIC_LATER_EDIT';document.querySelector('#draft').dispatchEvent(new Event('input'))");
  release({ synthetic: true });
  await wait("document.querySelector('#operations').textContent.includes('Send click observed')");
  assert.equal(f.releases.length, 1); assert.equal(f.pages.get(17).text, 'SYNTHETIC_UI_PROMPT e\u0301 ☕');
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  assert.match(await evaluate('document.body.innerText'), /Only prompts entered here use Sealed admission/);
  assert.deepEqual(exceptions, []);
  const preview = await mkdtemp('/private/tmp/attestamp-panel-preview-');
  const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await writeFile(join(preview, 'panel.png'), Buffer.from(screenshot.data, 'base64'));
  await call('Page.reload');
  await wait("document.querySelector('#operations')?.textContent.includes('Send click observed')");
  assert.equal(await evaluate("document.querySelector('#draft').value"), '');
  assert.equal(await evaluate("document.querySelector('#target').value"), '');
  assert.equal(f.releases.length, 1);
  console.log(`PASS: real panel rendering and controls, provider-draft disclosure, immutable one-action send, reopen without replay. Synthetic browser authority. Screenshot: ${join(preview, 'panel.png')}`);
} finally {
  release({ synthetic: true }); socket?.close();
  if (browser && browser.exitCode === null) { const exited = new Promise(resolve => browser.once('exit', resolve)); browser.kill(); await exited; }
  await new Promise(resolve => server ? server.close(resolve) : resolve());
  await f?.close(); await rm(root, { recursive: true, force: true });
}
