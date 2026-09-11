import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Vault } from '../spikes/vault/vault.mjs';
import { canonical, parseCanonical, unpack } from '../spikes/vault/format.mjs';
import { LocalReceipts } from '../spikes/recipient/local.mjs';
import { startProductComposer } from '../spikes/browser/chatgpt/product-server.mjs';
import { startRecipient } from '../spikes/recipient/server.mjs';

// Every vault, browser profile, key and download is created by this run. Only
// loopback fixture servers are available; no real browser/provider account opens.
const root = await mkdtemp(join(tmpdir(), 'provenance-recipient-browser-test-'));
let chrome, socket, composer, recipient, vault;
try {
  vault = new Vault(join(root, 'vault'), randomBytes(32), undefined, { create: true });
  const malicious = '<img src="https://never.example/tracker" onerror="globalThis.ACTIVE_CONTENT=true"><script>globalThis.ACTIVE_CONTENT=true</script> PRIVATE ORIGINAL';
  const text = vault.capture(Buffer.from(malicious));
  vault.capture(Buffer.from(canonical({ profile: 'pap-chatgpt-observation/1', kind: 'frozen-text-version', mode: 'Sealed',
    textRecord: text.manifest.eventId, textObject: text.manifest.evidence[0].objectDigest })), { type: 'observation' });
  composer = await startProductComposer({ session: { receipts: new LocalReceipts(vault), status: () => ({ versions: [] }) }, browserState: () => ({ tabs: [] }) });
  recipient = await startRecipient();
  chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', `--user-data-dir=${join(root, 'profile')}`,
    '--remote-debugging-port=0', '--no-first-run', '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--disable-default-apps', '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', 'about:blank'],
  { env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore' });
  let launchError; chrome.on('error', error => { launchError = error; });
  let port;
  for (let i = 0; i < 100; i++) {
    if (launchError) throw launchError;
    try { port = (await readFile(join(root, 'profile/DevToolsActivePort'), 'utf8')).split('\n')[0]; break; } catch { await delay(50); }
  }
  assert.ok(port, 'Isolated browser startup');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0; const pending = new Map(), requests = [];
  socket.onmessage = event => {
    const value = JSON.parse(event.data);
    if (value.method === 'Network.requestWillBeSent') requests.push(value.params.request.url);
    if (value.id) { const promise = pending.get(value.id); pending.delete(value.id); value.error ? promise.reject(Error(value.error.message)) : promise.resolve(value.result); }
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); socket.send(JSON.stringify({ id: n, method, params })); });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value;
  };
  const wait = async expression => {
    for (let i = 0; i < 150; i++) { if (await evaluate(expression)) return; await delay(30); }
    throw Error(`Timed out: ${expression}; ${await evaluate("document.querySelector('#status')?.textContent")}`);
  };
  const click = id => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
  const setFile = async (selector, path) => {
    const dom = await call('DOM.getDocument'), node = await call('DOM.querySelector', { nodeId: dom.root.nodeId, selector });
    await call('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [path] });
  };
  await call('Network.enable'); await call('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: root });
  await call('Page.navigate', { url: composer.url }); await wait("document.querySelectorAll('#history input').length === 1");
  await evaluate("document.querySelector('#history input').click()"); await click('preview-export');
  await wait("!document.querySelector('#save-export').disabled");
  assert.match(await evaluate("document.querySelector('#disclosure-preview').textContent"), /PRIVATE ORIGINAL/);
  assert.equal(await evaluate("globalThis.ACTIVE_CONTENT === true || document.querySelector('#disclosure-preview img') !== null"), false);
  await evaluate("document.querySelector('#redacted-text').value='Share this [REDACTED]'"); await click('redact');
  await wait("document.querySelectorAll('#history input').length === 2 && !document.querySelector('#redact').disabled");
  await evaluate("document.querySelectorAll('#history input').forEach((input,i)=>{input.checked=i===1;input.dispatchEvent(new Event('change'))})");
  await click('preview-export'); await wait("!document.querySelector('#save-export').disabled");
  const preview = JSON.parse(await evaluate("document.querySelector('#disclosure-preview').textContent"));
  assert.equal(preview.records.length, 1); assert.equal(preview.texts[0].derivative, true);
  assert.doesNotMatch(JSON.stringify(preview), /PRIVATE ORIGINAL/);
  await click('save-export');
  const exported = join(root, 'provenance-evidence.json');
  for (let i = 0; i < 100; i++) { try { if ((await stat(exported)).size) break; } catch {} await delay(30); }
  const bytes = await readFile(exported), bundle = parseCanonical(bytes);
  assert.equal(bundle.disclosure.records.length, 1); assert.equal(unpack(bundle.disclosure.objects[0].bytes).toString(), 'Share this [REDACTED]');
  await call('Page.navigate', { url: recipient.url }); await wait("document.querySelector('#bundle') !== null");
  await setFile('#bundle', exported); await click('verify'); await wait("document.querySelector('#status').textContent.startsWith('Local verification finished')");
  const report = JSON.parse(await evaluate("document.querySelector('#report').textContent"));
  assert.equal(report.records[0].integrity, 'VALID'); assert.equal(report.records[0].anchor, 'INDETERMINATE');
  assert.equal(report.records[0].derivative.length, 1);
  assert.equal(await evaluate("document.querySelectorAll('#results tr').length"), 7);
  const hostile = join(root, 'hostile.json'); await writeFile(hostile, '{"profile":1,"profile":2}');
  await setFile('#bundle', hostile); await click('verify'); await wait("document.querySelector('#status').textContent.startsWith('Verification unavailable')");
  assert.equal(await evaluate("document.querySelectorAll('#results tr').length"), 0);
  assert.ok(requests.every(url => url.startsWith('http://127.0.0.1:') || url.startsWith('blob:http://127.0.0.1:')), `Unexpected remote requests: ${JSON.stringify(requests)}`);
  console.log('PASS: isolated consumer preview/redaction/download, seven recipient dimensions, hostile-input recovery, no active content or remote requests.');
} finally {
  socket?.close();
  if (chrome && chrome.exitCode === null) { const stopped = new Promise(resolve => chrome.once('exit', resolve)); chrome.kill('SIGKILL'); await stopped; }
  await composer?.close(); await recipient?.close(); vault?.close(); await rm(root, { recursive: true, force: true });
}
