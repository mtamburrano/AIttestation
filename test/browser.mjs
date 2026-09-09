import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startFixture } from '../spikes/release/fixture.mjs';

// Every write and browser profile belongs to this invocation. No user profile or external service.
const root = await mkdtemp(join(tmpdir(), 'provenance-browser-test-'));
let chrome, socket, fixture;
try {
  fixture = await startFixture(root);
  const binary = process.env.PROVENANCE_TEST_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  chrome = spawn(binary, ['--headless=new', `--user-data-dir=${join(root, 'profile')}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--disable-default-apps', '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', 'about:blank'], { stdio: 'ignore' });
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
  const wait = async expression => { for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await delay(30); } throw Error(`Timed out: ${expression}`); };
  await call('Page.navigate', { url: fixture.url });
  await wait("document.querySelector('#status')?.textContent === 'Ready for synthetic local input.'");
  await evaluate("document.querySelector('#draft').focus()");
  await call('Input.insertText', { text: 'synthetic private e\u0301 ☕' });
  const attachment = join(root, 'test-attachment.bin'); await writeFile(attachment, Buffer.from([0, 255, 13, 10]));
  const dom = await call('DOM.getDocument');
  const fileNode = await call('DOM.querySelector', { nodeId: dom.root.nodeId, selector: '#files' });
  await call('DOM.setFileInputFiles', { nodeId: fileNode.nodeId, files: [attachment] });
  await delay(100); assert.equal(fixture.egress.length, 0, 'keypress and eager attachment isolation');
  await evaluate("document.querySelector('#seal').click()");
  await wait("document.querySelector('#status').textContent.startsWith('Frozen locally')");
  assert.equal(fixture.egress.length, 0);
  await evaluate("document.querySelector('#confirm').click()");
  await wait("!document.querySelector('#release').disabled");
  assert.equal(fixture.egress.length, 0);
  await evaluate("document.querySelector('#release').click()");
  await wait("document.querySelector('#status').textContent.startsWith('SUBMISSION_OBSERVED')");
  assert.equal(fixture.egress.length, 1);
  assert.equal(fixture.egress[0].payload.text, 'synthetic private e\u0301 ☕');
  assert.equal(fixture.egress[0].payload.attachments[0].bytes, 'AP8NCg==');
  await call('Page.navigate', { url: fixture.providerOrigin });
  await wait("document.querySelector('#response')?.textContent.includes('synthetic private')");
  const observed = await evaluate("document.querySelector('#response').textContent");
  assert.equal(observed, 'Observed synthetic submission: synthetic private e\u0301 ☕');
  await evaluate("document.querySelector('#draft').focus()");
  await call('Input.insertText', { text: 'unprotected provider draft' });
  await wait("document.querySelector('#draft').value === 'unprotected provider draft'");
  for (let i = 0; i < 100 && fixture.egress.length < 2; i++) await delay(20);
  assert.equal(fixture.egress[1].data.draft, 'unprotected provider draft');
  const providerDom = await call('DOM.getDocument');
  const upload = await call('DOM.querySelector', { nodeId: providerDom.root.nodeId, selector: '#upload' });
  await call('DOM.setFileInputFiles', { nodeId: upload.nodeId, files: [attachment] });
  for (let i = 0; i < 100 && fixture.egress.length < 3; i++) await delay(20);
  assert.deepEqual(fixture.egress[2].data.bytes, [0, 255, 13, 10]);
  console.log('PASS: isolated Chrome local typing/attachment containment, confirmed exact-byte release, visible text capture, eager provider draft/upload counterexample.');
} finally {
  socket?.close();
  if (chrome && chrome.exitCode === null) { const exited = new Promise(r => chrome.once('exit', r)); chrome.kill(); await exited; }
  await fixture?.close();
  await rm(root, { recursive: true, force: true });
}
