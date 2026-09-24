import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DurableVault, MemoryKeyStore } from '../spikes/vault/key-lifecycle.mjs';
import { LIMITS, canonical } from '../spikes/vault/format.mjs';
import { inspectRecovery } from '../spikes/vault/vault.mjs';
import { ChatGPTRecordingSession } from '../spikes/browser/chatgpt/session.mjs';
import { EngineStateStore } from '../spikes/browser/chatgpt/engine-store.mjs';
import { ENGINE_COMMAND_PROFILE } from '../spikes/browser/chatgpt/engine.mjs';
import { startPackagedChatGPT } from '../spikes/browser/chatgpt/runtime-main.mjs';
import { CHATGPT_ADAPTER_PROFILE, CHATGPT_PAGE_CONTRACT } from '../spikes/browser/chatgpt/adapter.mjs';
import { FAST_CONFIRM_PROFILE } from '../spikes/anchor/algorand/fast-confirm.mjs';
import { verifyPortable } from '../spikes/recipient/portable.mjs';
import { LocalDiagnostics, validateDiagnosticEvent } from '../spikes/diagnostics/local.mjs';
import { startupFailure, readStartupFailure } from '../spikes/development/startup.mjs';
import { restrictFixtureNetwork } from '../spikes/development/fixture-network.mjs';
import { recordingStatus } from '../spikes/browser/chatgpt/extension/sidepanel-model.js';
import { sidePanelFixture } from './sidepanel-fixture.mjs';
import { until } from './recording-fixture.mjs';

const capacity = 'VAULT_CAPACITY_EXHAUSTED';
const trust = { profile: FAST_CONFIRM_PROFILE };
const state = revision => ({ revision, recording: true, migration: 'NEW_OR_RECOVERED' });
const observation = () => ({ kind: 'request-observed', eventId: randomUUID(), inputMethod: 'provider-request',
  text: 'SYNTHETIC_CAPACITY_PROMPT', source: { adapterProfile: CHATGPT_ADAPTER_PROFILE, pageContract: CHATGPT_PAGE_CONTRACT,
    runtimeEpoch: randomUUID(), browserSessionId: 'synthetic-capacity-browser', scope: randomUUID(), tabId: 17, windowId: 1,
    tabEpoch: 'synthetic-capacity-tab', documentId: 'synthetic-capacity-document', destination: 'conversation:capacity' },
  request: { profile: 'chatgpt-new-user-text/3', path: '/backend-api/conversation',
    messageId: randomUUID(), conversationId: 'capacity' } });
const command = (engine, enabled) => ({ profile: ENGINE_COMMAND_PROFILE, runtimeEpoch: engine.state().runtimeEpoch,
  adapterProfile: CHATGPT_ADAPTER_PROFILE, commandId: randomUUID(), expectedRevision: engine.state().revision,
  kind: 'SET_RECORDING', enabled });
const fill = (vault, count) => {
  while (vault.inspect().records.length < count) vault.capture(Buffer.from('SYNTHETIC_CAPACITY_FILLER'));
};
async function api(runtime, path, data = {}) {
  const url = new URL(runtime.dashboardURL);
  const response = await fetch(new URL(path, url), { method: 'POST',
    headers: { Origin: url.origin, Authorization: `Bearer ${url.hash.slice(1)}` }, body: JSON.stringify(data) });
  const value = await response.json(); assert.equal(response.status, 200, value.error); return value;
}

test('472/452 retained sequence reaches 512/492, rejects capture and repeatedly opens history/export/recovery', async t => {
  const root = await mkdtemp('/private/tmp/attestamp-capacity-restart-test-'), supportDirectory = join(root, 'engine');
  const keyStore = new MemoryKeyStore(), network = restrictFixtureNetwork(root), diagnostics = new LocalDiagnostics();
  let vault, session, runtime, revoke, earlyRecovery, fullRecovery, restored, writable, sponsorCalls = 0;
  t.after(async () => {
    await runtime?.close(); revoke?.(); session?.close(); vault?.close(); restored?.close(); writable?.close();
    earlyRecovery?.recoveryKey.fill(0); fullRecovery?.recoveryKey.fill(0); network.restore();
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(supportDirectory, { mode: 0o700 });
  vault = DurableVault.create(join(supportDirectory, 'vault'), { keyStore });
  session = await new ChatGPTRecordingSession(supportDirectory, {}, { vault, fastTrust: trust }).init();
  const input = observation(), saved = session.observeNormal(input);
  while (vault.inspect().records.length < 452) vault.capture(Buffer.from(`SYNTHETIC_UNIQUE_${vault.inspect().records.length}`));
  while (vault.inspect().records.length < 472) vault.capture(Buffer.from(input.text));
  assert.equal(vault.inspect().objects.length, 452);
  const original = vault.inspect().records;
  earlyRecovery = vault.exportRecovery();
  const store = new EngineStateStore(supportDirectory, vault);
  for (let revision = 1; revision <= 40; revision++) await store.save(state(revision));
  const retained = vault.inspect();
  assert.equal(retained.records.length, 512); assert.equal(retained.objects.length, 492);
  assert.deepEqual(retained.records.slice(0, 472), original);
  assert.throws(() => vault.capture(Buffer.from('SYNTHETIC_REJECTED')), { code: capacity, message: capacity });
  await assert.rejects(store.save(state(41)), { code: capacity });
  assert.deepEqual((await store.load()).state, state(40));
  const rejected = observation();
  assert.throws(() => session.observeNormal(rejected), { code: capacity });
  assert.equal(session.captureReceipt(rejected.eventId).state, 'SAVE_PENDING');
  assert.deepEqual(vault.inspect(), retained);
  session.close(); session = null; vault.close(); vault = null;
  const opened = [];
  const options = { supportDirectory, keyStore, fastTrust: trust, installation: null, diagnostics,
    managed: { status: () => ({ state: 'ACTIVE' }), submit: async () => { sponsorCalls++; throw Error('EXTERNAL_SUBMISSION_FORBIDDEN'); } },
    collectFast: async () => { throw Error('EXTERNAL_CONFIRMATION_FORBIDDEN'); }, openDashboard: async url => { opened.push(url); } };
  let previousEpoch;
  for (let restart = 0; restart < 3; restart++) {
    runtime = await startPackagedChatGPT(options); revoke = network.allowRuntime(runtime);
    assert.notEqual(runtime.runtimeEpoch, previousEpoch); previousEpoch = runtime.runtimeEpoch;
    assert.equal(runtime.engine.state().available, true);
    assert.equal(runtime.engine.state().recording, restart === 0);
    assert.equal(runtime.engine.state().captureUnavailableReason, capacity);
    assert.deepEqual(runtime.engine.capturePolicy(), []);
    await runtime.engine.drain(); assert.equal(sponsorCalls, 0);
    const dashboard = await api(runtime, '/dashboard/state');
    assert.equal(dashboard.integration.code, capacity); assert.equal(dashboard.history.counts.prompts, 1);
    const preview = await api(runtime, '/receipts/preview', { ids: [saved.descriptorId] });
    assert.equal(preview.texts[0].preview, input.text);
    const exported = await api(runtime, '/receipts/export', { previewId: preview.previewId });
    const report = verifyPortable(Buffer.from(exported.content));
    assert.equal(report.records.length, 2);
    assert.ok(report.records.every(record => record.integrity === 'VALID' && record.keyAttribution === 'SIGNATURE_VALID'));
    assert.equal((await api(runtime, '/dashboard/verifier')).opened, true);
    assert.match(opened.at(-1), /^http:\/\/127\.0\.0\.1:/);
    const recovery = await api(runtime, '/dashboard/recovery', { confirmed: true });
    fullRecovery?.recoveryKey.fill(0);
    fullRecovery = { package: Buffer.from(recovery.package), recoveryKey: Buffer.from(recovery.recoveryKey, 'base64') };
    assert.deepEqual(inspectRecovery(fullRecovery.package, fullRecovery.recoveryKey).records, retained.records);
    const off = command(runtime.engine, false);
    const ack = await runtime.engine.command(off, { surface: 'desktop' });
    assert.equal(ack.recording, false);
    assert.deepEqual(await runtime.engine.command(off, { surface: 'desktop' }), ack);
    await assert.rejects(runtime.engine.command(command(runtime.engine, true), { surface: 'desktop' }), { code: capacity });
    await assert.rejects(runtime.engine.command({ ...off, commandId: randomUUID(), runtimeEpoch: randomUUID() },
      { surface: 'desktop' }), { code: 'STALE_RUNTIME_EPOCH' });
    assert.equal(await readFile(join(supportDirectory, 'engine-recording-off'), 'utf8'), 'OFF\n');
    assert.deepEqual(runtime.session.vault.inspect(), retained);
    assert.equal(runtime.session.captureReceipt(input.eventId, input.source).receiptId, saved.descriptorId);
    assert.equal(runtime.session.captureReceipt(input.eventId, { ...input.source, scope: randomUUID() }).state, 'SAVE_PENDING');
    await runtime.close(); runtime = null; revoke(); revoke = null;
  }
  // A complete full backup remains full: recovery must never discard signed
  // history to manufacture space. An earlier checkpoint is explicitly older.
  restored = DurableVault.restore(fullRecovery.package, fullRecovery.recoveryKey, join(root, 'full-restored'),
    { keyStore: new MemoryKeyStore() });
  assert.deepEqual(restored.inspect().records, retained.records);
  assert.equal(restored.verifyAll().count, 512);
  assert.throws(() => restored.capture(Buffer.from('SYNTHETIC_NO_SPACE')), { code: capacity });
  const fullDirectory = join(root, 'full-recovered-engine'); await mkdir(fullDirectory, { mode: 0o700 });
  runtime = await startPackagedChatGPT({ ...options, supportDirectory: fullDirectory, vault: restored, managed: null });
  assert.equal(runtime.engine.state().recording, false); assert.equal(runtime.engine.state().available, true);
  assert.equal(runtime.engine.state().captureUnavailableReason, capacity);
  assert.equal(runtime.session.receipts.list().length, 1);
  assert.deepEqual(restored.inspect().records, retained.records);
  await runtime.close(); runtime = null;
  writable = DurableVault.restore(earlyRecovery.package, earlyRecovery.recoveryKey, join(root, 'earlier-restored'),
    { keyStore: new MemoryKeyStore() });
  const recoveredDirectory = join(root, 'recovered-engine'); await mkdir(recoveredDirectory, { mode: 0o700 });
  runtime = await startPackagedChatGPT({ ...options, supportDirectory: recoveredDirectory, vault: writable, managed: null });
  assert.equal(runtime.engine.state().recording, false); assert.equal(runtime.engine.state().captureUnavailableReason, null);
  assert.equal(writable.inspect().records.length, 472);
  await runtime.engine.command(command(runtime.engine, true), { surface: 'desktop' });
  const newObservation = observation(); runtime.session.observeNormal(newObservation);
  assert.equal(runtime.session.captureReceipt(newObservation.eventId).state, 'PROMPT_SAVED');
  assert.deepEqual(writable.inspect().records.slice(0, 472), original);
  const events = diagnostics.preview().report.events;
  assert.ok(events.some(event => event.code === capacity)); events.forEach(validateDiagnosticEvent);
  assert.doesNotMatch(JSON.stringify(events), /SYNTHETIC_|chatgpt\.com|vault\.sqlite/);
});

for (const records of [510, 511]) {
  test(`capture with ${records} retained records preserves exact save, OFF, sidebar and provider semantics`, async t => {
    const root = await mkdtemp('/private/tmp/attestamp-capacity-browser-test-'), network = restrictFixtureNetwork(root);
    let f;
    t.after(async () => { await f?.close(); network.restore(); await rm(root, { recursive: true, force: true }); });
    const diagnostics = new LocalDiagnostics();
    f = await sidePanelFixture(root, { network, diagnostics, managed: { status: () => ({ state: 'NOT_CONFIGURED' }) } });
    const { model } = await f.panel(); await model.toggle(); await f.refresh();
    const vault = f.runtime.session.vault, initialInput = observation();
    f.runtime.session.observeNormal(initialInput);
    fill(vault, records);
    const retained = vault.inspect().records;
    const policy = f.runtime.engine.capturePolicy()[0];
    if (records === 511) {
      assert.equal(policy, undefined);
      assert.throws(() => f.runtime.session.observeNormal(observation()), { code: capacity });
      assert.deepEqual(vault.inspect().records, retained, 'no orphan text record in the last slot');
    }
    // The page still holds its previously delivered policy when capacity changes.
    await f.send('SYNTHETIC_LAST_CAPTURE');
    await until(() => f.results.length >= 1);
    const delivery = f.deliveries[0].observation;
    assert.equal(f.results[0].result.state, records === 510 ? 'PROMPT_SAVED' : capacity);
    assert.equal(f.runtime.session.captureReceipt(delivery.eventId, delivery.source).state,
      records === 510 ? 'PROMPT_SAVED' : 'SAVE_PENDING');
    assert.equal(vault.inspect().records.length, records === 510 ? 512 : 511);
    assert.deepEqual(vault.inspect().records.slice(0, records), retained);
    assert.equal(f.pages.get(17).requests.length, 1); assert.equal(f.deliveries.length, 1);
    assert.equal(f.prevention, 0); assert.equal(f.releases.length, 0);
    await until(() => f.pages.get(17).feedback.includes('capacity exhausted'));
    await model.refresh(); assert.equal(model.state.available, true);
    assert.match(recordingStatus(model.state), /ON requested.*capacity exhausted/);
    await model.dashboard(); assert.equal(f.dashboards.length, 1);
    await model.toggle(); assert.equal(model.state.recording, false);
    assert.match(recordingStatus(model.state), /OFF.*capacity exhausted/);
    const requests = f.requests.length; await model.toggle(); assert.equal(f.requests.length, requests);
    assert.equal(f.runtime.engine.captureStates()[0].state, 'OFF');
    await f.restart();
    assert.equal(f.runtime.engine.state().available, true); assert.equal(f.runtime.engine.state().recording, false);
    assert.equal(f.runtime.engine.state().captureUnavailableReason, capacity);
    assert.equal(f.runtime.session.captureReceipt(delivery.eventId, delivery.source).state,
      records === 510 ? 'PROMPT_SAVED' : 'SAVE_PENDING');
    assert.equal(f.runtime.session.vault.inspect().records.length, records === 510 ? 512 : 511);
  });
}

test('capacity startup diagnostics are fixed and distinct from generic limits and private error text', () => {
  const error = Object.assign(Error('PRIVATE_CAPACITY_CANARY'), { code: capacity });
  assert.equal(startupFailure(error), `PRIVATE_DEVELOPMENT_START_FAILED:${capacity}`);
  assert.equal(readStartupFailure(startupFailure(error)), startupFailure(error));
  assert.doesNotMatch(startupFailure(error), /CANARY|UNKNOWN/);
});

test('durable OFF latch survives interrupted ON persistence and clears only after a successful ON', async t => {
  const root = await mkdtemp('/private/tmp/attestamp-capacity-consent-test-'), keyStore = new MemoryKeyStore();
  const vault = DurableVault.create(join(root, 'vault'), { keyStore }), store = new EngineStateStore(root, vault);
  t.after(async () => { vault.close(); await rm(root, { recursive: true, force: true }); });
  await store.save(state(1)); await store.revokeRecording();
  assert.equal((await store.load()).state.recording, false);
  // A signed but unpublished state must not bypass the revocation latch.
  vault.capture(Buffer.from(canonical({ profile: 'pap-resident-state/2', state: state(2) })));
  assert.equal((await store.load()).state.recording, false);
  await store.save(state(3)); assert.equal((await store.load()).state.recording, true);
  assert.equal(vault.remainingRecordCapacity, LIMITS.objects - 3);
});

test('exhaustion during an ON state commit cannot acknowledge an unpersisted preference', async t => {
  const root = await mkdtemp('/private/tmp/attestamp-capacity-command-test-');
  let runtime;
  t.after(async () => { await runtime?.close(); await rm(root, { recursive: true, force: true }); });
  runtime = await startPackagedChatGPT({ supportDirectory: root, keyStore: new MemoryKeyStore(),
    fastTrust: trust, installation: null, managed: null });
  const vault = runtime.session.vault;
  fill(vault, 510);
  const save = EngineStateStore.prototype.save;
  t.mock.method(EngineStateStore.prototype, 'save', async function (state) {
    // Another admitted writer uses the remaining slots before this state write.
    fill(vault, 512); return save.call(this, state);
  });
  await assert.rejects(runtime.engine.command(command(runtime.engine, true), { surface: 'desktop' }), { code: capacity });
  assert.equal(runtime.engine.state().available, true); assert.equal(runtime.engine.state().recording, false);
  assert.equal(runtime.engine.state().captureUnavailableReason, capacity);
  assert.equal(await new EngineStateStore(root, vault).load(), null);
  await runtime.engine.command(command(runtime.engine, false), { surface: 'desktop' });
  assert.equal((await new EngineStateStore(root, vault).load()).state.recording, false);
});
