import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, chmod, writeFile, rename } from 'node:fs/promises';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { startPackagedChatGPT } from '../spikes/browser/chatgpt/runtime-main.mjs';
import { MemoryKeyStore } from '../spikes/vault/key-lifecycle.mjs';
import { CHATGPT_EXTENSION_ID, CHATGPT_ADAPTER_PROFILE, CHATGPT_PAGE_CONTRACT,
  ChatGPTChromeAdapter, SURFACE_CHURN_MS } from '../spikes/browser/chatgpt/adapter.mjs';
import { ChromeBridgeController } from '../spikes/browser/chatgpt/bridge.mjs';
import { NATIVE_BRIDGE_PROFILE, rendezvousRecord, encodeNativeFrame, NativeFrameDecoder,
  runNativeHost } from '../spikes/browser/chatgpt/native-host.mjs';
import { FAST_CONFIRM_PROFILE } from '../spikes/anchor/algorand/fast-confirm.mjs';
import { LocalDiagnostics } from '../spikes/diagnostics/local.mjs';
import { workerFixture, testTab, turn } from './chrome-worker-fixture.mjs';

const origin = `chrome-extension://${CHATGPT_EXTENSION_ID}/`;
const identity = { browser: { product: 'Google Chrome', channel: 'stable', major: 153 },
  platform: { product: 'macOS', arch: 'arm64', version: '15.7.2' } };
const hello = () => ({ kind: 'PAP_HELLO', extensionId: CHATGPT_EXTENSION_ID,
  adapterProfile: CHATGPT_ADAPTER_PROFILE, captureProfile: 'pap-chatgpt-capture/2',
  pageContract: CHATGPT_PAGE_CONTRACT, browserSessionId: 'test-browser-session', ...identity,
  permissions: ['nativeMessaging'], hostPermission: 'https://chatgpt.com/*', permissionState: 'granted', tabs: [testTab()] });
const fastTrust = { profile: FAST_CONFIRM_PROFILE };
async function until(check) {
  for (let index = 0; index < 500; index++) { if (check()) return; await delay(10); }
  assert.fail('Isolated lifecycle fixture timed out');
}
async function temporary(t) {
  const root = await realpath(await mkdtemp('/private/tmp/attestamp-bridge-test-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
function relay(t, rendezvousPath, timeout = 500) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./native-host-child.mjs', import.meta.url)), rendezvousPath, String(timeout)],
    { env: { PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  const result = { child, stderr: '', exited: false };
  child.stderr.on('data', bytes => { result.stderr += bytes.toString(); });
  child.once('exit', () => { result.exited = true; });
  t.after(async () => { if (!result.exited) { child.kill(); await once(child, 'exit'); } });
  return result;
}
async function backend(t, behavior) {
  const root = await temporary(t), socketPath = join(root, 'test.sock'), rendezvousPath = join(root, 'bridge.json');
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    socket.once('data', () => behavior(socket));
  });
  server.listen(socketPath); await once(server, 'listening'); await chmod(socketPath, 0o600);
  const publish = path => writeFile(rendezvousPath, rendezvousRecord({ extensionOrigin: origin, socketPath: path,
    token: randomBytes(32), runtimeEpoch: 'test-epoch', expiresAt: new Date(Date.now() + 60_000).toISOString() }), { mode: 0o600 });
  await publish(socketPath);
  t.after(async () => { for (const socket of sockets) socket.destroy(); if (server.listening) await new Promise(resolve => server.close(resolve)); });
  return { server, socketPath, rendezvousPath, publish };
}
const ready = (socket, runtimeEpoch = 'test-epoch') => socket.write(`${JSON.stringify({
  kind: 'PAP_BRIDGE_READY', profile: NATIVE_BRIDGE_PROFILE, runtimeEpoch })}\n`);

test('disabled integration rejects peers and re-enabling accepts only a fresh handshake without old scopes', async t => {
  const root = await temporary(t);
  const runtime = await startPackagedChatGPT({ supportDirectory: root, keyStore: new MemoryKeyStore(),
    installation: null, managed: null, fastTrust, attestPeer: () => identity,
    collectFast: () => { throw Error('NO_CONFIRMATION_IN_THIS_FIXTURE'); } });
  t.after(() => runtime.close());
  const first = relay(t, runtime.rendezvousPath); first.child.stdout.resume();
  first.child.stdin.write(encodeNativeFrame(hello())); await until(() => runtime.browserState());
  assert.equal(runtime.adapter.scopes().length, 1);
  runtime.disableIntegration(); await until(() => first.exited);
  const rejected = relay(t, runtime.rendezvousPath); rejected.child.stdout.resume();
  rejected.child.stdin.write(encodeNativeFrame(hello())); await until(() => rejected.exited);
  assert.equal(runtime.browserState(), null); assert.deepEqual(runtime.adapter.scopes(), []);
  await runtime.enableIntegration();
  const replacement = relay(t, runtime.rendezvousPath); replacement.child.stdout.resume();
  replacement.child.stdin.write(encodeNativeFrame(hello())); await until(() => runtime.browserState());
  assert.equal(runtime.adapter.scopes().length, 1); assert.equal(runtime.engine.state().operations.length, 0);
  await runtime.close(); await until(() => replacement.exited);
});

test('relay process exits with Chrome stdin still open on backend EOF, rejection, or handshake timeout', async t => {
  const cases = {
    'backend EOF after authentication': { behavior: socket => { ready(socket); socket.end(); }, code: 'NATIVE_BACKEND_EOF' },
    'backend EOF during authentication': { behavior: socket => socket.end(), code: 'NATIVE_BACKEND_EOF' },
    'stale backend epoch': { behavior: socket => ready(socket, 'old-epoch'), code: 'NATIVE_HANDSHAKE_REJECTED' },
    'malformed backend frame': { behavior: socket => { ready(socket); socket.write('invalid\n'); }, code: 'NATIVE_BACKEND_INVALID' },
    'unresponsive backend': { behavior: () => {}, code: 'NATIVE_HANDSHAKE_TIMEOUT' },
  };
  for (const [name, { behavior, code }] of Object.entries(cases)) await t.test(name, async t => {
    const { rendezvousPath } = await backend(t, behavior), process = relay(t, rendezvousPath);
    process.child.stdout.resume();
    await until(() => process.exited);
    assert.equal(process.child.stdin.writableEnded, false, 'browser never ended its input pipe');
    assert.match(process.stderr, new RegExp(code));
  });
});

test('relay refuses a detached socket and handles frontend EOF and stream errors', async t => {
  await t.test('connection refused', async t => {
    const fixture = await backend(t, () => {}), deadSocket = `${fixture.socketPath}.dead`;
    await rename(fixture.socketPath, deadSocket);
    await new Promise(resolve => fixture.server.close(resolve)); await fixture.publish(deadSocket);
    const process = relay(t, fixture.rendezvousPath); process.child.stdout.resume();
    await until(() => process.exited); assert.match(process.stderr, /NATIVE_BACKEND_ERROR/);
  });
  for (const failure of ['input-end', 'input-error', 'output-error', 'backend-error']) await t.test(failure, async t => {
    const fixture = await backend(t, socket => ready(socket));
    const input = new PassThrough(), output = new PassThrough(); let reason;
    const socket = await runNativeHost({ extensionOrigin: origin, rendezvousPath: fixture.rendezvousPath, input, output,
      onClose: code => { reason = code; } });
    if (failure === 'input-end') input.end();
    else (failure === 'input-error' ? input : failure === 'output-error' ? output : socket).emit('error', Error('PRIVATE_ERROR_CANARY'));
    await until(() => Boolean(reason));
    assert.equal(socket.destroyed, true); assert.equal(input.destroyed, true); assert.equal(output.destroyed, true);
    assert.ok(!reason.includes('PRIVATE_ERROR_CANARY'));
  });
});

test('extension backoff is bounded, handles synchronous failures, and resets only after pairing', async () => {
  const worker = await workerFixture({ onConnect() { throw Error('FIXTURE_START_FAILED'); } });
  for (const ms of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) await worker.fire(ms);
  const connected = await workerFixture(); await turn();
  const first = connected.ports[0]; first.disconnect(); await connected.fire(1000);
  connected.ports[1].disconnect(); await connected.fire(2000);
  const current = connected.ports[2]; connected.ready(current); await turn();
  current.disconnect(); await connected.fire(1000);
  const fourth = connected.ports[3];
  await connected.fire(10000);
  assert.equal(fourth.closed, true, 'an unacknowledged hello cannot hold the port indefinitely');
});

test('old port callbacks and epoch commands cannot publish through a replacement', async () => {
  let resolveInspect, blocked = true, sends = 0;
  const worker = await workerFixture({ inspect: async (_id, message) => {
    if (message.kind === 'PAP_RELEASE') { sends++; return { exposure: 'NONE', submitted: false }; }
    if (blocked) return new Promise(resolve => { resolveInspect = resolve; });
    return testTab();
  } });
  await turn(); const first = worker.ports[0]; first.disconnect(); blocked = false;
  await worker.fire(1000); const second = worker.ports[1]; worker.ready(second, 'new-epoch'); await turn();
  const count = second.messages.length; resolveInspect(testTab()); await turn();
  assert.equal(second.messages.length, count, 'old HELLO is not posted to the new port');
  const command = { kind: 'PAP_RELEASE', profile: 'pap-chatgpt-release/2', runtimeEpoch: 'old-epoch',
    browserSessionId: second.messages[0].browserSessionId, scope: 'scope', tabId: 17,
    expectedUrl: testTab().url, destination: testTab().destination, attemptId: 'old-attempt',
    payloadDigest: 'a'.repeat(64), textDigest: 'b'.repeat(64), textBytes: 'dGVzdA==' };
  first.onMessage.emit(command); second.onMessage.emit(command); await turn();
  assert.equal(sends, 0);
  assert.equal(second.closed, true);
  second.onMessage.emit({ ...command, runtimeEpoch: 'new-epoch', attemptId: 'pending-attempt' });
  second.disconnect(); await worker.fire(1000); await turn();
  assert.equal(sends, 0);
  assert.ok(worker.ports[2].messages.every(message => !message.attemptId));
});

test('an unresponsive content script times out into recoverable state on the same port', async () => {
  let stalled = false, finishOldInspection;
  const worker = await workerFixture({ inspect: async () => stalled
    ? new Promise(resolve => { finishOldInspection = resolve; }) : testTab() });
  await turn(); const port = worker.ports[0]; worker.ready(port); await turn();
  stalled = true; worker.chrome.tabs.onActivated.emit(); await worker.fire(2000);
  assert.equal(port.messages.at(-1).tabs[0].surfaceSupported, false);
  assert.equal(port.messages.at(-1).tabs[0].destination, '');
  assert.equal(port.closed, false);
  stalled = false; worker.chrome.tabs.onActivated.emit(); await turn();
  assert.equal(port.messages.at(-1).tabs[0].surfaceSupported, true);
  const count = port.messages.length;
  finishOldInspection(testTab({ destination: 'conversation:stale' })); await turn();
  assert.equal(port.messages.length, count); assert.equal(worker.ports.length, 1);
});

test('capability loss preserves a source while navigation and disconnect revoke its identity', async () => {
  const adapter = new ChatGPTChromeAdapter({ extensionId: CHATGPT_EXTENSION_ID });
  const controller = new ChromeBridgeController(adapter, () => {}, { localBrowser: identity.browser, localPlatform: identity.platform });
  controller.receive(hello()); const scope = adapter.scopes()[0].scope;
  const state = tabs => ({ ...hello(), kind: 'PAP_STATE', tabs });
  // A momentary composer/control loss keeps a followed scope eligible only inside
  // the bounded churn window, so a Send the page already observed mid-render is
  // not discarded; a sustained loss still reports unavailable.
  controller.receive(state([testTab({ surfaceSupported: false })]));
  assert.equal(adapter.observationEligible(scope), true, 'transient control churn keeps the followed scope');
  controller.receive(state([testTab()])); assert.equal(adapter.observationEligible(scope), true);
  controller.receive(state([testTab({ surfaceSupported: false })]));
  await delay(SURFACE_CHURN_MS + 50);
  assert.equal(adapter.observationEligible(scope), false, 'sustained loss expires the churn window');
  controller.receive(state([testTab()])); assert.equal(adapter.observationEligible(scope), true);
  for (const tabs of [[testTab({ destination: '', surfaceSupported: false })], [testTab({ attachmentsPresent: true })]]) {
    controller.receive(state(tabs)); assert.equal(adapter.observationEligible(scope), false);
    controller.receive(state([testTab()])); assert.equal(adapter.observationEligible(scope), true);
  }
  // Attachments are a deliberate, stable state and never inherit the churn window.
  controller.receive(state([testTab({ attachmentsPresent: true })]));
  assert.equal(adapter.observationEligible(scope), false, 'attachments revoke immediately');
  controller.receive(state([testTab()])); assert.equal(adapter.observationEligible(scope), true);
  controller.receive(state([testTab({ active: false })]));
  assert.equal(adapter.observationEligible(scope), true, 'recording does not require an empty active tab');
  controller.receive(state([testTab({ tabEpoch: 'new-document' })]));
  assert.equal(adapter.observationEligible(scope), false); assert.notEqual(adapter.scopes()[0].scope, scope);
  controller.disconnect(); assert.deepEqual(adapter.scopes(), []);
});

test('running extension recovers from normal engine stop/start without reviving or resending authority', async t => {
  const root = await temporary(t), keyStore = new MemoryKeyStore(), diagnostics = new LocalDiagnostics();
  const start = () => startPackagedChatGPT({ supportDirectory: root, keyStore, fastTrust, diagnostics,
    managed: null, installation: null, openBrowser: false,
    attestPeer: async () => structuredClone(identity), controllerTimeoutMs: 500,
    collectFast: async () => ({ fixture: true }), verifyFast: async () => ({ authorized: true,
      anchor: 'SOURCE_CORROBORATED', timestamp: 'SOURCE_REPORTED', assurance: FAST_CONFIRM_PROFILE, round: 42 }) });
  let runtime = await start(), submissions = 0, surface = testTab();
  const relays = [];
  t.after(async () => { await runtime.close(); });
  const worker = await workerFixture({
    onConnect(port) {
      const process = relay(t, runtime.rendezvousPath, 2000); relays.push(process);
      port.send = message => process.child.stdin.write(encodeNativeFrame(message));
      port.close = () => process.child.stdin.end();
      const decoder = new NativeFrameDecoder();
      process.child.stdout.on('data', bytes => { for (const message of decoder.push(bytes)) port.onMessage.emit(message); });
      process.child.once('exit', () => port.disconnect());
    },
    inspect: async (_id, message) => {
      if (message.kind !== 'PAP_RELEASE') return surface;
      submissions++; throw Error('UNEXPECTED_PROVIDER_COMMAND');
    },
  });
  await until(() => runtime.browserState() !== null);
  const firstEpoch = runtime.runtimeEpoch, browserSessionId = runtime.browserState().browserSessionId;
  const scope = runtime.adapter.scopes()[0].scope;
  surface = testTab({ surfaceSupported: false, destination: '' });
  worker.chrome.tabs.onUpdated.emit(17, { status: 'complete' });
  await until(() => runtime.adapter.scopes()[0]?.eligibility === 'TEMPORARILY_UNAVAILABLE');
  assert.equal(worker.ports.length, 1); assert.equal(relays[0].exited, false);
  surface = testTab(); worker.chrome.tabs.onUpdated.emit(17, { status: 'complete' });
  await until(() => runtime.adapter.scopes()[0]?.eligibility === 'ELIGIBLE');
  assert.equal(runtime.adapter.scopes()[0]?.scope, scope);
  await runtime.close();
  await until(() => relays[0].exited && worker.ports[0].closed);
  assert.match(relays[0].stderr, /NATIVE_BACKEND_EOF|NATIVE_BACKEND_CLOSED/);
  runtime = await start(); await worker.fire(1000);
  await until(() => runtime.browserState() !== null);
  assert.notEqual(runtime.runtimeEpoch, firstEpoch);
  assert.equal(runtime.browserState().browserSessionId, browserSessionId);
  assert.equal(runtime.adapter.scopes().length, 1);
  assert.notEqual(runtime.adapter.scopes()[0].scope, scope);
  assert.equal(runtime.engine.state().recording, false);
  assert.equal(runtime.session.runtime, undefined);
  assert.equal(runtime.session.release, undefined);
  assert.equal(submissions, 0);
  const events = diagnostics.preview().report.events;
  assert.equal(events.filter(event => event.code === 'BRIDGE_HELLO').length, 2);
  assert.equal(new Set(events.filter(event => event.code === 'BRIDGE_HELLO').map(event => event.epochId)).size, 2);
  assert.equal(events.filter(event => event.code === 'ADAPTER_DISPATCH').length, 0);
  assert.ok(events.some(event => event.code === 'BRIDGE_DISCONNECTED'));
  const report = JSON.stringify(events);
  for (const secret of [root, firstEpoch, scope, 'SYNTHETIC_PRIVATE_PROMPT', testTab().url]) assert.ok(!report.includes(secret));
});
