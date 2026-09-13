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
import { ChatGPTProtectionSession } from '../spikes/browser/chatgpt/session.mjs';
import { MemoryKeyStore } from '../spikes/vault/key-lifecycle.mjs';
import { ManagedSponsorship, DEFAULT_LIMITS } from '../spikes/managed/service.mjs';
import { ManagedAnchoringClient } from '../spikes/managed/client.mjs';
import { startManagedServer } from '../spikes/managed/http.mjs';
import { MANAGED_NETWORK } from '../spikes/managed/protocol.mjs';
import { FAST_CONFIRM_PROFILE } from '../spikes/anchor/algorand/fast-confirm.mjs';

// Every vault, browser profile, key and download is created by this run. Only
// loopback fixture servers are available; no real browser/provider account opens.
const root = await mkdtemp(join(tmpdir(), 'provenance-recipient-browser-test-'));
let chrome, socket, composer, recipient, vault, managedServer, managedService, protection;
try {
  vault = new Vault(join(root, 'vault'), randomBytes(32), undefined, { create: true });
  const malicious = '<img src="https://never.example/tracker" onerror="globalThis.ACTIVE_CONTENT=true"><script>globalThis.ACTIVE_CONTENT=true</script> PRIVATE ORIGINAL';
  const text = vault.capture(Buffer.from(malicious));
  vault.capture(Buffer.from(canonical({ profile: 'pap-chatgpt-observation/1', kind: 'frozen-text-version', mode: 'Sealed',
    textRecord: text.manifest.eventId, textObject: text.manifest.evidence[0].objectDigest })), { type: 'observation' });
  composer = await startProductComposer({ session: { receipts: new LocalReceipts(vault), status: () => ({ versions: [] }),
    managedStatus: () => ({ state: 'NOT_CONFIGURED' }) }, browserState: () => ({ tabs: [] }) });
  recipient = await startRecipient();
  chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', `--user-data-dir=${join(root, 'profile')}`,
    '--remote-debugging-port=0', '--no-first-run', '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--disable-default-apps', '--use-mock-keychain', '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', 'about:blank'],
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
  assert.equal(await evaluate('document.title'), 'Attestamp · Verify evidence');
  assert.equal(await evaluate("document.querySelector('h1').textContent"), 'Attestamp Verifier');
  assert.doesNotMatch(await evaluate('document.body.innerText'), /private[ -]?provenance/i);
  await setFile('#bundle', exported); await click('verify'); await wait("document.querySelector('#status').textContent.startsWith('Local verification finished')");
  const report = JSON.parse(await evaluate("document.querySelector('#report').textContent"));
  assert.equal(report.records[0].integrity, 'VALID'); assert.equal(report.records[0].anchor, 'INDETERMINATE');
  assert.equal(report.records[0].derivative.length, 1);
  assert.equal(await evaluate("document.querySelectorAll('#results tr').length"), 7);
  const hostile = join(root, 'hostile.json'); await writeFile(hostile, '{"profile":1,"profile":2}');
  await setFile('#bundle', hostile); await click('verify'); await wait("document.querySelector('#status').textContent.startsWith('Verification unavailable')");
  assert.equal(await evaluate("document.querySelectorAll('#results tr').length"), 0);

  await composer.close();
  const now = Date.parse('2026-09-11T12:00:00Z'), submitted = [], released = [], keyStore = new MemoryKeyStore();
  managedService = new ManagedSponsorship(join(root, 'managed-service'), {
    now: () => now, limits: { ...DEFAULT_LIMITS, accountMonth: 1, accountDay: 1 }, sponsor: {
      async prepare(payload) { submitted.push(payload); return { transactionId: 'A'.repeat(52), network: MANAGED_NETWORK,
        feeMicroAlgos: 1000, signedTransaction: Buffer.from('isolated-browser-transaction').toString('base64') }; },
      async broadcast() {},
    },
  });
  managedServer = await startManagedServer(managedService);
  const account = managedService.provision({ paidThrough: now + 86400000 });
  const client = new ManagedAnchoringClient({ origin: managedServer.origin, keyStore, allowLoopbackForTests: true });
  const scope = 'isolated-managed-browser-scope';
  protection = await new ChatGPTProtectionSession(await mkdtemp(join(root, 'managed-client-')), {
    enroll: () => ({ scope, destination: 'new-chat' }), assertEligible: value => assert.equal(value, scope),
    dispatch: async attempt => { released.push(attempt.payload.text); return 'SUBMISSION_OBSERVED'; },
  }, { vaultKey: randomBytes(32), managed: client, fastTrust: { profile: FAST_CONFIRM_PROFILE },
    collectFast: async () => ({ synthetic: true }), verifyFast: () => ({ authorized: true,
      anchor: 'SOURCE_CORROBORATED', timestamp: 'SOURCE_REPORTED', assurance: FAST_CONFIRM_PROFILE, round: 42 }),
  }).init();
  composer = await startProductComposer({ session: protection, browserState: () => ({ tabs: [{
    id: 17, active: true, surfaceSupported: true, composerEmpty: true, attachmentsPresent: false, destination: 'new-chat',
  }] }) });
  await call('Page.navigate', { url: composer.url });
  await wait("document.querySelector('#account')?.textContent.includes('access code') && !document.querySelector('#enroll').disabled");
  await evaluate(`document.querySelector('#access-code').value=${JSON.stringify(account.accessCode)}`);
  await click('connect-account'); await wait("document.querySelector('#account').textContent.startsWith('Account connected')");
  assert.equal(await evaluate("document.querySelector('#access-code').value"), '');
  await click('enroll'); await wait("!document.querySelector('#freeze').disabled");
  const draft = async (text, mode) => evaluate(`document.querySelector('#mode').value=${JSON.stringify(mode)};
    document.querySelector('#mode').dispatchEvent(new Event('change'));
    document.querySelector('#draft').value=${JSON.stringify(text)};
    document.querySelector('#draft').dispatchEvent(new Event('input'));`);
  await draft('managed browser exact text', 'Sealed'); await click('freeze');
  await wait("!document.querySelector('#release').disabled");
  assert.equal(released.length, 0); assert.equal(submitted.length, 1);
  assert.equal(await evaluate("document.querySelector('#transaction').value"), '', 'managed path requires no transaction entry');
  await click('release'); await wait("!document.querySelector('#freeze').disabled && document.querySelector('#status').textContent.includes('SUBMISSION_OBSERVED')");
  assert.deepEqual(released, ['managed browser exact text']);
  await draft('quota fallback', 'Always Protect'); await click('freeze');
  await wait("!document.querySelector('#freeze').disabled && document.querySelector('#status').textContent.includes('allowance is used up')");
  assert.equal(released.length, 1);
  managedService.setSubscription(account.accountId, now);
  await draft('unpaid fallback', 'Sealed'); await click('freeze');
  await wait("!document.querySelector('#freeze').disabled && document.querySelector('#status').textContent.includes('subscription has expired')");
  assert.equal(released.length, 1);
  await draft('continuous remains usable', 'Continuous'); await click('freeze');
  await wait("!document.querySelector('#freeze').disabled && document.querySelector('#status').textContent.includes('Local evidence remains')");
  assert.deepEqual(released, ['managed browser exact text', 'continuous remains usable']);
  await managedServer.close(); managedServer = null;
  await draft('outage fallback', 'Sealed'); await click('freeze');
  await wait("!document.querySelector('#freeze').disabled && document.querySelector('#status').textContent.includes('Managed anchoring is unavailable')");
  assert.equal(released.length, 2);
  await click('disconnect-account'); await wait("document.querySelector('#account').textContent.includes('access code')");
  assert.equal(keyStore.accounts().length, 0);
  assert.ok(requests.every(url => url.startsWith('http://127.0.0.1:') || url.startsWith('blob:http://127.0.0.1:')), `Unexpected remote requests: ${JSON.stringify(requests)}`);
  console.log('PASS: isolated receipt/recipient flow and wallet-free managed browser flow; quota, unpaid and outage fallbacks preserve strict release. No remote requests.');
} finally {
  socket?.close();
  if (chrome && chrome.exitCode === null) { const stopped = new Promise(resolve => chrome.once('exit', resolve)); chrome.kill('SIGKILL'); await stopped; }
  await composer?.close(); await recipient?.close(); await managedServer?.close(); managedService?.close();
  protection?.close(); vault?.close(); await rm(root, { recursive: true, force: true });
}
