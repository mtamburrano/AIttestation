import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { recordingFixture, until } from './recording-fixture.mjs';
import { pageFixture } from './chatgpt-page-fixture.mjs';
import { workerFixture, turn } from './chrome-worker-fixture.mjs';
import { OwnerDebugSession } from '../spikes/development/debug-session.mjs';
import { LocalDiagnostics } from '../spikes/diagnostics/local.mjs';
import { ChromeBridgeController } from '../spikes/browser/chatgpt/bridge.mjs';
import { CHATGPT_CAPTURE_DIAGNOSTIC_PROFILE, TRANSPORT_DIAGNOSTIC_CODES } from '../spikes/browser/chatgpt/capture.mjs';

const wrap = delegate => function () { return delegate.apply(this, arguments); };
const codes = session => JSON.parse(session.export()).segments.flatMap(segment => segment.events).map(event => event.code);
async function fixture(t, options = {}) {
  const root = await mkdtemp('/private/tmp/attestamp-readiness-test-');
  const debugSession = new OwnerDebugSession(root); debugSession.setEnabled(true);
  let f;
  t.after(async () => { await f?.close(); debugSession.close(); await rm(root, { recursive: true, force: true }); });
  f = await recordingFixture(root, { tabs: 1, debugSession, diagnostics: debugSession.diagnostics, ...options });
  return { f, debugSession, root };
}

test('late wrapper preserves empty/type/clear and SPA readiness, capture and saved transport diagnostics', async t => {
  const { f, debugSession } = await fixture(t);
  await f.recording(true);
  const page = f.pages.get(17);
  page.wrapFetch(wrap);
  await until(async () => (await page.inspect()).observerState === 'wrapped');
  page.buttons = [];
  for (const text of ['', 'PRIVATE_TYPING_CANARY', '']) {
    page.text = text; await f.refresh();
    assert.equal((await page.inspect()).surfaceSupported, true);
    assert.equal(page.feedback, 'Attestamp · ON');
  }
  f.navigate(17, 'https://chatgpt.com/');
  await until(async () => (await f.refresh()).policy?.destination === 'new-chat');
  assert.equal((await page.inspect()).observerState, 'wrapped');
  assert.equal(page.requests.length, 0); assert.equal(f.deliveries.length, 0);
  f.send('PRIVATE_PROMPT_CANARY', { method: 'enter' });
  await until(() => page.feedback === 'Attestamp · Prompt saved');
  assert.equal(page.requests.length, 1); assert.equal(f.runtime.session.receipts.list().length, 1);
  await f.recording(false);
  for (const code of ['TRANSPORT_OBSERVER_READY', 'TRANSPORT_OBSERVER_WRAPPED', 'TRANSPORT_RELAY_READY',
    'TRANSPORT_POLICY_READY', 'TRANSPORT_POLICY_OFF']) await until(() => codes(debugSession).includes(code));
  for (let i = 0; i < 10; i++) { await page.inspect(); await f.refresh(); }
  const messages = f.port.messages.filter(value => value.kind === 'PAP_CAPTURE_DIAGNOSTIC');
  assert.equal(new Set(messages.map(value => value.code)).size, messages.length);
  assert.ok(messages.every(value => Object.keys(value).sort().join(',') === 'code,kind,profile'));
  assert.doesNotMatch(debugSession.export(), /PRIVATE_TYPING_CANARY|PRIVATE_PROMPT_CANARY|chatgpt\.com|fixture-17/);
});

test('a reachable relay with a genuinely replaced observer withdraws policy and records the failed stage', async t => {
  const { f, debugSession } = await fixture(t); await f.recording(true);
  const page = f.pages.get(17); page.bypassObserver();
  await until(async () => (await page.inspect()).observerState === 'replaced');
  await until(async () => (await f.refresh()).state === 'RECORDING_UNAVAILABLE');
  assert.equal((await page.inspect()).surfaceSupported, false);
  assert.equal(page.feedback, 'Attestamp · Recording unavailable');
  assert.equal(page.requests.length, 0);
  f.send('BYPASS_CANARY'); await turn();
  assert.equal(page.requests.length, 1); assert.equal(f.deliveries.length, 0);
  for (const code of ['TRANSPORT_RELAY_READY', 'TRANSPORT_OBSERVER_REPLACED', 'TRANSPORT_POLICY_UNAVAILABLE']) {
    await until(() => codes(debugSession).includes(code));
  }
  assert.doesNotMatch(debugSession.export(), /BYPASS_CANARY/);
});

test('an injected isolated relay alone does not establish transport readiness', async t => {
  const { f, debugSession } = await fixture(t, { transport: false });
  await f.command('SET_RECORDING', { enabled: true });
  const page = f.pages.get(17);
  assert.equal((await f.refresh()).policy, null);
  assert.equal(f.runtime.engine.state().recording, true);
  assert.equal((await page.inspect()).observerState, 'unavailable');
  assert.equal((await page.inspect()).surfaceSupported, false);
  for (const code of ['TRANSPORT_RELAY_READY', 'TRANSPORT_OBSERVER_UNAVAILABLE', 'TRANSPORT_POLICY_UNAVAILABLE']) {
    await until(() => codes(debugSession).includes(code));
  }
});

test('fixed transport stages survive debug-session close and reopen without page metadata', async t => {
  const root = await mkdtemp('/private/tmp/attestamp-transport-debug-test-');
  let session = new OwnerDebugSession(root);
  t.after(async () => { session.close(); await rm(root, { recursive: true, force: true }); });
  session.setEnabled(true);
  for (const code of TRANSPORT_DIAGNOSTIC_CODES) session.diagnostics.record(code, { epochId: 'synthetic-transport-epoch' });
  session.close(); session = new OwnerDebugSession(root);
  assert.deepEqual(codes(session), TRANSPORT_DIAGNOSTIC_CODES);
});

test('relay refuses malformed observer readiness claims and expires a missing heartbeat', async t => {
  let time = 0;
  const page = pageFixture({ transport: false, clock: { setTimeout, clearTimeout, performance: { now: () => time } } });
  t.after(() => page.close());
  for (const message of [{ kind: 'ready', available: true },
    { kind: 'ready', available: true, observerState: 'replaced' },
    { kind: 'ready', available: true, observerState: 'ready', content: 'PRIVATE_CANARY' }]) {
    page.transportMessage(message); await turn(); assert.equal((await page.inspect()).surfaceSupported, false);
  }
  page.transportMessage({ kind: 'ready', available: true, observerState: 'wrapped' });
  await turn(); assert.equal((await page.inspect()).surfaceSupported, true);
  time = 3001;
  assert.equal((await page.inspect()).surfaceSupported, false);
  assert.equal((await page.inspect()).observerState, 'unavailable');
});

test('transport diagnostics require pairing, exact fixed-code envelopes and the new negotiated vocabulary', async t => {
  const diagnostics = new LocalDiagnostics(), adapter = { capabilities: { observation: true },
    pair: () => ({ runtimeEpoch: 'synthetic-epoch' }), synchronize() {} };
  const bridge = new ChromeBridgeController(adapter, () => {}, { diagnostics, localBrowser: {}, localPlatform: {} });
  const event = code => ({ kind: 'PAP_CAPTURE_DIAGNOSTIC', profile: CHATGPT_CAPTURE_DIAGNOSTIC_PROFILE, code });
  assert.throws(() => bridge.receive(event(TRANSPORT_DIAGNOSTIC_CODES[0])), /not paired/);
  bridge.receive({ kind: 'PAP_HELLO' });
  for (const code of TRANSPORT_DIAGNOSTIC_CODES) for (let i = 0; i < 20; i++) bridge.receive(event(code));
  for (const message of [event('PRIVATE_CANARY'), { ...event(TRANSPORT_DIAGNOSTIC_CODES[0]), url: 'PRIVATE_CANARY' },
    { ...event(TRANSPORT_DIAGNOSTIC_CODES[0]), profile: 'pap-chatgpt-capture-diagnostic/1' }]) assert.throws(() => bridge.receive(message));
  const events = diagnostics.preview().report.events.filter(value => value.code.startsWith('TRANSPORT_'));
  assert.deepEqual(events.map(value => value.code), TRANSPORT_DIAGNOSTIC_CODES);
  assert.ok(events.every(value => Object.keys(value).sort().join(',') === 'code,component,elapsedMs,sequence'));
  for (const profile of ['pap-chatgpt-capture-diagnostic/1', CHATGPT_CAPTURE_DIAGNOSTIC_PROFILE]) {
    const worker = await workerFixture({ inspect: async () => { throw Error('PRIVATE_RELAY_ERROR_CANARY'); } });
    t.after(() => worker.close()); await turn();
    const port = worker.ports[0], hello = port.messages.find(value => value.kind === 'PAP_HELLO');
    port.onMessage.emit({ kind: 'PAP_READY', browserSessionId: hello.browserSessionId,
      runtimeEpoch: 'synthetic-epoch', captureDiagnosticProfile: profile });
    await turn();
    const emitted = port.messages.filter(value => value.kind === 'PAP_CAPTURE_DIAGNOSTIC');
    assert.deepEqual(emitted.map(value => value.code), profile === CHATGPT_CAPTURE_DIAGNOSTIC_PROFILE ? ['TRANSPORT_RELAY_UNAVAILABLE'] : []);
    assert.doesNotMatch(JSON.stringify(emitted), /PRIVATE_RELAY_ERROR_CANARY/);
  }
});
