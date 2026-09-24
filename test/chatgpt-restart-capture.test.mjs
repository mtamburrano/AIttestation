import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Vault } from '../spikes/vault/vault.mjs';
import { LIMITS } from '../spikes/vault/format.mjs';
import { ChatGPTRecordingSession } from '../spikes/browser/chatgpt/session.mjs';
import { ResidentEngine, ENGINE_COMMAND_PROFILE } from '../spikes/browser/chatgpt/engine.mjs';
import { EngineStateStore } from '../spikes/browser/chatgpt/engine-store.mjs';
import { ChatGPTChromeAdapter, CHATGPT_EXTENSION_ID, CHATGPT_ADAPTER_PROFILE, CHATGPT_PAGE_CONTRACT } from '../spikes/browser/chatgpt/adapter.mjs';
import { CHATGPT_CAPTURE_PROFILE } from '../spikes/browser/chatgpt/capture.mjs';
import { FAST_CONFIRM_PROFILE } from '../spikes/anchor/algorand/fast-confirm.mjs';
import { LocalDiagnostics, emitCaptureFailure, validateDiagnosticEvent } from '../spikes/diagnostics/local.mjs';
import { OwnerDebugSession } from '../spikes/development/debug-session.mjs';
import { restrictFixtureNetwork } from '../spikes/development/fixture-network.mjs';
import { testTab } from './chrome-worker-fixture.mjs';
import { recordingFixture, until } from './recording-fixture.mjs';

const trust = { profile: FAST_CONFIRM_PROFILE };
const unavailable = () => Object.assign(Error('SYNTHETIC_SPONSOR_OFF'), { code: 'SERVICE_UNAVAILABLE' });
const source = () => ({ adapterProfile: CHATGPT_ADAPTER_PROFILE, pageContract: CHATGPT_PAGE_CONTRACT,
  runtimeEpoch: randomUUID(), browserSessionId: 'synthetic-restart-browser', scope: randomUUID(),
  tabId: 17, windowId: 1, tabEpoch: 'synthetic-tab', documentId: 'synthetic-document', destination: 'conversation:retained' });
const observation = (index, captureSource = source()) => ({ kind: 'request-observed', eventId: randomUUID(), source: captureSource,
  inputMethod: 'provider-request', text: `SYNTHETIC_RESTART_${index}`,
  request: { profile: 'chatgpt-new-user-text/3', path: '/backend-api/conversation', messageId: `synthetic-${index}`,
    conversationId: captureSource.destination === 'new-chat' ? null : captureSource.destination.slice(13) } });
const command = (engine, enabled) => ({ profile: ENGINE_COMMAND_PROFILE, runtimeEpoch: engine.state().runtimeEpoch,
  adapterProfile: CHATGPT_ADAPTER_PROFILE, commandId: randomUUID(), expectedRevision: engine.state().revision, kind: 'SET_RECORDING', enabled });
const turn = () => new Promise(resolve => setImmediate(resolve));

async function seed(vault, root) {
  const session = await new ChatGPTRecordingSession(root, {}, { vault, fastTrust: trust }).init();
  try { for (let index = 0; index < 18; index++) session.observeNormal(observation(index)); }
  finally { session.close(); }
}

test('first new-tab capture survives restart, 18 pending retry jobs and transient source unavailability', async t => {
  const root = await mkdtemp('/private/tmp/attestamp-restart-queue-test-');
  const vault = new Vault(join(root, 'vault'), randomBytes(32), undefined, { create: true });
  let engine, session, hold = false, active = 0, maximum = 0, release;
  const gate = new Promise(resolve => { release = resolve; }), attempts = new Map(), diagnostics = new LocalDiagnostics();
  t.after(async () => { hold = false; release(); engine?.stop(); await engine?.drain(); session?.close(); vault.close(); await rm(root, { recursive: true, force: true }); });
  await seed(vault, root);
  const immutable = vault.inspect().records;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const open = async () => {
    const epoch = randomUUID(), adapter = new ChatGPTChromeAdapter({ extensionId: CHATGPT_EXTENSION_ID, runtimeEpoch: epoch, diagnostics });
    const connection = { extensionId: CHATGPT_EXTENSION_ID, adapterProfile: CHATGPT_ADAPTER_PROFILE,
      captureProfile: CHATGPT_CAPTURE_PROFILE, pageContract: CHATGPT_PAGE_CONTRACT, browserSessionId: 'synthetic-restart-browser',
      browser: { product: 'Google Chrome', channel: 'stable', major: 153 }, platform: { product: 'macOS', arch: 'arm64', version: '15.7' },
      permissionState: 'granted', permissions: ['nativeMessaging'], hostPermission: 'https://chatgpt.com/*', tabs: [testTab()] };
    adapter.pair(connection); adapter.synchronize(connection);
    session = await new ChatGPTRecordingSession(root, adapter, { vault, diagnostics, fastTrust: trust,
      managed: { submit: async (payload, { beforeSubmit }) => {
        beforeSubmit(); attempts.set(payload, (attempts.get(payload) ?? 0) + 1);
        maximum = Math.max(maximum, ++active);
        try { if (hold) await gate; throw unavailable(); } finally { active--; }
      } }, collectFast: async () => { throw Error('EXTERNAL_CONFIRMATION_FORBIDDEN'); },
    }).init();
    engine = await new ResidentEngine(root, session, adapter, epoch, diagnostics).init();
    return { adapter, connection };
  };
  await open(); await engine.command(command(engine, true), { surface: 'desktop' }); await engine.drain();
  const oldEpoch = engine.state().runtimeEpoch, oldPolicy = engine.capturePolicy()[0];
  engine.stop(); await engine.drain(); session.close();
  const { adapter, connection } = await open(); await engine.drain();
  assert.notEqual(engine.state().runtimeEpoch, oldEpoch); assert.equal(engine.state().recording, true);
  t.mock.timers.tick(5000); await engine.drain();
  hold = true; t.mock.timers.tick(30000);
  await turn(); await turn(); assert.equal(active, 2);
  t.mock.timers.tick(13000);
  adapter.synchronize({ ...connection, tabs: [testTab({ surfaceSupported: false })] });
  assert.equal(engine.state().available, true); assert.equal(engine.captureStates()[0].state, 'RECORDING_UNAVAILABLE');
  assert.equal(engine.capturePolicy().length, 0);
  adapter.synchronize({ ...connection, tabs: [testTab(), testTab({ id: 19, tabEpoch: 'new-tab', url: 'https://chatgpt.com/', destination: 'new-chat' })] });
  t.mock.timers.tick(16600);
  const policy = engine.capturePolicy().find(value => value.tabId === 19);
  const captureSource = { ...source(), runtimeEpoch: policy.runtimeEpoch, browserSessionId: policy.browserSessionId,
    scope: policy.scope, tabId: policy.tabId, windowId: policy.windowId, tabEpoch: policy.tabEpoch, destination: policy.destination };
  const input = { ...observation('first-new-tab', captureSource), profile: CHATGPT_CAPTURE_PROFILE, token: policy.token };
  const saved = await engine.observe(input);
  assert.equal(saved.state, 'PROMPT_SAVED'); assert.equal(active, 2, 'capture must not await sponsor work');
  assert.deepEqual(await engine.observe(input), saved);
  assert.equal(session.receipts.list().length, 19); assert.equal(engine.state().available, true);
  await assert.rejects(engine.observe({ ...input, eventId: randomUUID(), token: oldPolicy.token,
    source: { ...captureSource, runtimeEpoch: oldEpoch } }), /CAPTURE_NOT_ENABLED|UNSUPPORTED_PATH/);
  await engine.command(command(engine, false), { surface: 'desktop' });
  await assert.rejects(engine.observe({ ...input, eventId: randomUUID() }), /CAPTURE_NOT_ENABLED/);
  hold = false; release(); await engine.drain();
  assert.equal(maximum, 2);
  assert.equal([...attempts.values()].filter(count => count === 4).length, 18);
  assert.deepEqual(vault.inspect().records.slice(0, immutable.length), immutable);
  engine.stop(); await engine.drain(); session.close(); await open(); await engine.drain();
  assert.equal(session.captureReceipt(input.eventId, input.source).receiptId, saved.receiptId);
  assert.equal(session.receipts.list().length, 19); assert.equal(engine.state().recording, false);
  const codes = diagnostics.preview().report.events.map(event => event.code);
  assert.ok(codes.includes('ANCHOR_RETRY_STARTED')); assert.ok(codes.includes('CAPABILITY_UNAVAILABLE'));
  assert.ok(!codes.includes('ENGINE_CAPTURE_DISABLED'));
});

for (const failure of ['sqlite-busy', 'record-limit', 'descriptor', 'post-commit', 'state-pointer', 'reconciliation']) {
  test(`durable ${failure} failure is distinguishable without losing exact receipt semantics or signed history`, async t => {
    const root = await mkdtemp('/private/tmp/attestamp-restart-failure-test-');
    const vault = new Vault(join(root, 'vault'), randomBytes(32), undefined, { create: true });
    const debug = new OwnerDebugSession(root), network = restrictFixtureNetwork(root);
    let f, locker, thrown;
    t.after(async () => { locker?.close(); await f?.close(); network.restore(); debug.close(); vault.close(); await rm(root, { recursive: true, force: true }); });
    await seed(vault, root);
    const immutable = vault.inspect().records;
    debug.setEnabled(true);
    f = await recordingFixture(root, { vault, network, diagnostics: debug.diagnostics, debugSession: debug,
      managed: { status: () => ({ state: 'NOT_CONFIGURED' }), submit: async () => { throw unavailable(); } } });
    await f.recording(true); await f.runtime.engine.drain();
    // A normal stop/start restores the same 18 durable observations; the new
    // fixture supplies a fresh authenticated browser connection and document.
    await f.close();
    f = await recordingFixture(root, { vault, network, diagnostics: debug.diagnostics, debugSession: debug, newChat: true,
      managed: { status: () => ({ state: 'NOT_CONFIGURED' }), submit: async () => { throw unavailable(); } } });
    await f.runtime.engine.drain(); await f.recording(true);
    const capture = vault.capture.bind(vault), inspect = vault.inspect.bind(vault);
    const observe = f.runtime.session.observeNormal.bind(f.runtime.session);
    f.runtime.session.observeNormal = input => { try { return observe(input); } catch (error) { thrown = error; throw error; } };
    if (failure === 'sqlite-busy') {
      locker = new DatabaseSync(join(root, 'vault', 'vault.sqlite')); locker.exec('BEGIN IMMEDIATE');
    } else if (failure === 'record-limit') {
      while (vault.inspect().records.length < LIMITS.objects) capture(Buffer.from('SYNTHETIC_RETAINED_STATE'));
    } else if (failure === 'state-pointer') {
      t.mock.method(EngineStateStore.prototype, 'save', async () => { throw Object.assign(Error('PRIVATE_PATH_CANARY'), { code: 'ENOSPC' }); });
    } else {
      vault.capture = (bytes, options) => {
        if (options?.type !== 'observation' || !bytes.includes('normal-request-observed')) return capture(bytes, options);
        if (failure === 'post-commit') capture(bytes, options);
        if (failure === 'reconciliation') vault.inspect = () => { throw Object.assign(Error('PRIVATE_REBUILD_CANARY'), { code: 'INVALID' }); };
        throw new TypeError('PRIVATE_PROMPT_ERROR_CANARY');
      };
    }
    const before = f.runtime.session.receipts.list().length;
    f.send('PRIVATE_NEW_CAPTURE_CANARY');
    await until(() => failure === 'record-limit' ? f.runtime.engine.state().captureUnavailableReason === 'VAULT_CAPACITY_EXHAUSTED'
      : !f.runtime.engine.state().available);
    await until(() => f.pages.get(17).feedback.includes('Prompt saved') || f.pages.get(17).feedback.includes('confirmation pending')
      || f.pages.get(17).feedback.includes('capacity exhausted'));
    const delivery = f.deliveries[0].observation;
    const saved = ['post-commit', 'state-pointer'].includes(failure);
    assert.equal(f.runtime.session.captureReceipt(delivery.eventId, delivery.source).state, saved ? 'PROMPT_SAVED' : 'SAVE_PENDING');
    assert.equal(f.runtime.session.captureReceipt(randomUUID(), delivery.source).state, 'SAVE_PENDING');
    assert.equal(f.pages.get(17).requests.length, 1); assert.equal(f.deliveries.length, 1); assert.equal(f.prevention, 0);
    if (failure === 'sqlite-busy') { assert.equal(thrown.code, 'ERR_SQLITE_ERROR'); assert.equal(thrown.errcode, 5); }
    if (failure === 'record-limit') {
      assert.equal(f.runtime.engine.state().available, true);
      assert.equal(f.results[0].result.state, 'VAULT_CAPACITY_EXHAUSTED');
    }
    const report = JSON.parse(debug.export()), events = report.segments.flatMap(segment => segment.events);
    const codes = events.map(event => event.code);
    for (const code of ['BRIDGE_CONNECTED', 'BRIDGE_AUTHENTICATED', 'BRIDGE_HELLO', 'REQUEST_MATCHED', 'DURABLE_SAVE_DISPATCHED',
      failure === 'record-limit' ? 'VAULT_CAPACITY_EXHAUSTED' : 'ENGINE_CAPTURE_DISABLED']) assert.ok(codes.includes(code), code);
    const expected = failure === 'sqlite-busy' ? 'CAPTURE_FAILURE_STORAGE_BUSY'
      : failure === 'record-limit' ? 'VAULT_CAPACITY_EXHAUSTED'
        : failure === 'state-pointer' ? 'CAPTURE_FAILURE_STORAGE_FULL' : 'CAPTURE_FAILURE_TYPE';
    assert.ok(codes.includes(expected));
    assert.ok(codes.includes(failure === 'state-pointer' ? 'VAULT_WRITE_FAILED'
      : failure === 'record-limit' ? 'VAULT_CAPACITY_EXHAUSTED' : failure === 'sqlite-busy' ? 'CAPTURE_TEXT_WRITE_FAILED' : 'CAPTURE_DESCRIPTOR_WRITE_FAILED'));
    if (failure === 'reconciliation') {
      assert.ok(codes.indexOf('CAPTURE_FAILURE_TYPE') < codes.indexOf('CAPTURE_RECONCILIATION_FAILED'));
      assert.ok(codes.includes('CAPTURE_FAILURE_INVALID'));
    }
    if (!saved) { assert.ok(codes.includes('CAPTURE_GAP')); assert.ok(!codes.includes('NORMAL_PROMPT_SAVED')); }
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_.*CANARY|SYNTHETIC_RESTART|chatgpt\.com|vault\.sqlite|TypeError/);
    events.forEach(validateDiagnosticEvent);
    locker?.close(); locker = null; vault.capture = capture; vault.inspect = inspect; t.mock.restoreAll();
    assert.equal(f.runtime.session.receipts.list().length, before + Number(saved));
    assert.deepEqual(vault.inspect().records.slice(0, immutable.length), immutable);
    await f.restart();
    assert.equal(f.runtime.session.captureReceipt(delivery.eventId).state, saved ? 'PROMPT_SAVED' : 'SAVE_PENDING');
    assert.equal(f.runtime.session.receipts.list().length, before + Number(saved));
  });
}

test('capture failure diagnostics retain only fixed classes even for unknown errors and hostile getters', () => {
  const diagnostics = new LocalDiagnostics();
  for (const error of [Object.assign(Error('PRIVATE_MESSAGE_CANARY'), { code: 'PRIVATE_CODE_CANARY' }),
    { get code() { throw Error('PRIVATE_GETTER_CANARY'); } }, new RangeError('PRIVATE_RANGE_CANARY')]) {
    assert.doesNotThrow(() => emitCaptureFailure(diagnostics, error, { operationId: 'PRIVATE_EVENT_CANARY' }));
  }
  const report = diagnostics.preview().report;
  assert.deepEqual(report.events.map(event => event.code), ['CAPTURE_FAILURE_UNEXPECTED', 'CAPTURE_FAILURE_UNEXPECTED', 'CAPTURE_FAILURE_RANGE']);
  report.events.forEach(validateDiagnosticEvent); assert.doesNotMatch(JSON.stringify(report), /PRIVATE_.*CANARY/);
});
