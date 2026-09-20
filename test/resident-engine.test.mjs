import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { recordingFixture, until } from './recording-fixture.mjs';
import { ResidentEngine, ENGINE_COMMAND_PROFILE } from '../spikes/browser/chatgpt/engine.mjs';
import { EngineStateStore, migrateRecordingState, lockResidentEngine } from '../spikes/browser/chatgpt/engine-store.mjs';
import { ChatGPTChromeAdapter, CHATGPT_EXTENSION_ID } from '../spikes/browser/chatgpt/adapter.mjs';
import { ChatGPTRecordingSession } from '../spikes/browser/chatgpt/session.mjs';
import { FAST_CONFIRM_PROFILE } from '../spikes/anchor/algorand/fast-confirm.mjs';
import { Vault, restoreRecovery } from '../spikes/vault/vault.mjs';
import { canonical } from '../spikes/vault/format.mjs';
import { CHATGPT_ADAPTER_PROFILE, CHATGPT_PAGE_CONTRACT } from '../spikes/browser/chatgpt/adapter.mjs';
import { CHATGPT_CAPTURE_PROFILE } from '../spikes/browser/chatgpt/capture.mjs';
import { verifyPortable } from '../spikes/recipient/portable.mjs';
import { testTab } from './chrome-worker-fixture.mjs';
import { ManagedAnchoringClient } from '../spikes/managed/client.mjs';
import { MANAGED_PROFILE, MANAGED_NETWORK } from '../spikes/managed/protocol.mjs';
import { MemoryKeyStore } from '../spikes/vault/key-lifecycle.mjs';

async function root(t) {
  const directory = await mkdtemp('/private/tmp/attestamp-onoff-test-');
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}
async function fixture(t, options) {
  const f = await recordingFixture(await root(t), options); t.after(() => f.close()); return f;
}
const command = (engine, enabled, changes = {}) => ({ profile: ENGINE_COMMAND_PROFILE,
  adapterProfile: engine.state().adapterProfile, runtimeEpoch: engine.state().runtimeEpoch,
  commandId: randomUUID(), expectedRevision: engine.state().revision, kind: 'SET_RECORDING', enabled, ...changes });
const legacy = preferences => ({ profile: 'pap-resident-state/1', state: { revision: 4, operations: [], preferences } });
const global = { paused: false, defaultMode: 'Continuous', conversations: {} };

test('only known unambiguous global Continuous consent migrates ON; repeated migrations are stable', () => {
  const cases = [null, { profile: 'future', state: {} }, legacy({ ...global, defaultMode: 'Off' }),
    legacy({ ...global, paused: true }), legacy({ ...global, defaultMode: 'Sealed' }),
    legacy({ ...global, defaultMode: 'Always Protect' }), legacy({ ...global, conversations: { a: 'Continuous' } }),
    legacy({ ...global, conversations: { a: 'Off' } }), legacy({ ...global, unknown: true }),
    { profile: 'pap-resident-state/2', state: { recording: true } }];
  for (const value of cases) assert.equal(migrateRecordingState(value).recording, false);
  const enabled = migrateRecordingState(legacy(global)); assert.equal(enabled.recording, true);
  assert.deepEqual(migrateRecordingState({ profile: 'pap-resident-state/2', state: enabled }), enabled);
});

test('migration leaves signed history and old journals byte-identical across interruption and restart', async t => {
  const directory = await root(t), key = randomBytes(32);
  const vault = new Vault(join(directory, 'vault'), key, undefined, { create: true }); t.after(() => vault.close());
  const old = vault.capture(Buffer.from(canonical(legacy(global))));
  const journal = Buffer.from('SYNTHETIC_OLD_GRANT_AND_SEND_ATTEMPT');
  await writeFile(join(directory, 'release-pointer'), journal);
  await writeFile(join(directory, 'engine-pointer'), old.manifest.eventId);
  // Simulate loss after a durable new record and before publication of its pointer.
  vault.capture(Buffer.from(canonical({ profile: 'pap-resident-state/2', state: migrateRecordingState(legacy(global)) })));
  const adapter = new ChatGPTChromeAdapter({ extensionId: CHATGPT_EXTENSION_ID });
  const session = await new ChatGPTRecordingSession(directory, adapter, { vault, fastTrust: { profile: FAST_CONFIRM_PROFILE } }).init();
  const first = await new ResidentEngine(directory, session, adapter, randomUUID()).init();
  assert.equal(first.state().recording, true); first.stop(); await first.drain();
  const second = await new ResidentEngine(directory, session, adapter, randomUUID()).init();
  t.after(() => second.stop());
  assert.equal(second.state().recording, true);
  assert.deepEqual(vault.inspect().records.find(record => record.manifest.eventId === old.manifest.eventId), old);
  assert.deepEqual(await readFile(join(directory, 'release-pointer')), journal);
  assert.equal(session.runtime, undefined); assert.equal(session.release, undefined);
});

test('recovery restores evidence but cannot recover consent or an active source identity', async t => {
  const f = await fixture(t); await f.recording(true); f.send('RECOVERY_SYNTHETIC');
  await until(() => f.runtime.session.receipts.list().length === 1); await f.runtime.engine.drain();
  const recovery = f.runtime.session.vault.exportRecovery(), directory = await root(t), key = randomBytes(32);
  restoreRecovery(recovery.package, recovery.recoveryKey, join(directory, 'vault'), key);
  const vault = new Vault(join(directory, 'vault'), key); t.after(() => vault.close());
  const adapter = new ChatGPTChromeAdapter({ extensionId: CHATGPT_EXTENSION_ID });
  const session = await new ChatGPTRecordingSession(directory, adapter, { vault, fastTrust: { profile: FAST_CONFIRM_PROFILE } }).init();
  const engine = await new ResidentEngine(directory, session, adapter, randomUUID()).init(); t.after(() => engine.stop());
  assert.equal(engine.state().recording, false); assert.deepEqual(engine.capturePolicy(), []);
  assert.equal(session.receipts.list().length, 1); await engine.drain(); recovery.recoveryKey.fill(0);
});

test('OFF is serialized with accepted capture; stale unaccepted deliveries cannot revive after ON or restart', async t => {
  let complete; const held = new Promise(resolve => { complete = resolve; });
  const f = await fixture(t, { collectFast: () => held }); t.after(() => complete({ synthetic: true }));
  await f.recording(true); f.send('DURABLE_BEFORE_OFF'); await until(() => f.confirmed === 1);
  const original = structuredClone(f.deliveries[0].observation);
  original.text = Buffer.from(original.textBytes, 'base64').toString(); delete original.textBytes;
  await f.runtime.engine.command(command(f.runtime.engine, false), { surface: 'desktop' });
  await assert.rejects(f.runtime.engine.observe({ ...original, eventId: randomUUID() }), /CAPTURE_NOT_ENABLED/);
  await f.runtime.engine.command(command(f.runtime.engine, true), { surface: 'desktop' });
  await assert.rejects(f.runtime.engine.observe({ ...original, eventId: randomUUID() }), /CAPTURE_NOT_ENABLED/);
  complete({ synthetic: true }); await f.runtime.engine.drain();
  assert.equal(f.runtime.session.status().versions[0].anchor, 'SOURCE_CORROBORATED');
  const epoch = f.runtime.runtimeEpoch; await f.restart();
  assert.notEqual(epoch, f.runtime.runtimeEpoch); assert.equal(f.runtime.engine.state().recording, true);
  await assert.rejects(f.runtime.engine.observe(original), /CAPTURE_NOT_ENABLED/);
  assert.equal(f.runtime.session.receipts.list().length, 1);
});

test('command retries are idempotent, concurrent revisions serialize and all legacy commands reject', async t => {
  const f = await fixture(t), engine = f.runtime.engine, value = command(engine, true);
  const one = engine.command(value, { surface: 'desktop' });
  const two = engine.command(command(engine, false), { surface: 'desktop' });
  await assert.rejects(two, /STALE_ENGINE_REVISION/); const ack = await one;
  assert.deepEqual(await engine.command(value, { surface: 'desktop' }), ack);
  await assert.rejects(engine.command({ ...value, enabled: false }, { surface: 'desktop' }), /COMMAND_REPLAY_CONFLICT/);
  for (const kind of ['PROTECT_AND_SEND', 'DEVELOPMENT_FREEZE', 'CANCEL_OPERATION', 'ENROLL_SCOPE',
    'SET_DEFAULT', 'SET_CONVERSATION_MODE', 'SET_PAUSE']) {
    await assert.rejects(engine.command(command(engine, true, { kind }), { surface: 'extension_panel' }), /INVALID_ENGINE_COMMAND/);
  }
  for (const change of [{ profile: 'pap-resident-command/1' }, { text: 'ARBITRARY' }, { runtimeEpoch: randomUUID() }, { enabled: 'ON' }]) {
    await assert.rejects(engine.command(command(engine, true, change), { surface: 'desktop' }));
  }
  await assert.rejects(engine.command(command(engine, true), { surface: 'content_script' }), /UNTRUSTED_COMMAND_ORIGIN/);
  assert.equal(engine.state().operations.length, 0);
});

test('OFF queued behind an unfinished durable save rejects the next capture and never acknowledges the early save', async t => {
  const f = await fixture(t); await f.recording(true);
  const save = EngineStateStore.prototype.save;
  let release, entered; const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  EngineStateStore.prototype.save = async function (state) { entered(); await held; return save.call(this, state); };
  t.after(() => { EngineStateStore.prototype.save = save; release(); });
  f.send('CAPTURE_BEFORE_ORDERED_OFF'); await started;
  assert.equal(f.prevention, 0); assert.equal(f.results.length, 0);
  const input = structuredClone(f.deliveries[0].observation);
  input.text = Buffer.from(input.textBytes, 'base64').toString(); delete input.textBytes;
  const off = f.runtime.engine.command(command(f.runtime.engine, false), { surface: 'desktop' });
  const late = assert.rejects(f.runtime.engine.observe({ ...input, eventId: randomUUID() }), /CAPTURE_NOT_ENABLED/);
  EngineStateStore.prototype.save = save; release(); await off; await late;
  await f.runtime.engine.drain();
  assert.equal(f.runtime.engine.state().recording, false);
  assert.equal(f.runtime.session.receipts.list().length, 1); assert.equal(f.releases.length, 0);
});

test('512 pending anchors cannot block durable capture; two workers resume saved work once, including while OFF', async t => {
  const directory = await root(t), epoch = randomUUID();
  const vault = new Vault(join(directory, 'vault'), randomBytes(32), undefined, { create: true }); t.after(() => vault.close());
  const adapter = new ChatGPTChromeAdapter({ extensionId: CHATGPT_EXTENSION_ID, runtimeEpoch: epoch });
  const connection = { extensionId: CHATGPT_EXTENSION_ID, adapterProfile: CHATGPT_ADAPTER_PROFILE,
    captureProfile: CHATGPT_CAPTURE_PROFILE, pageContract: CHATGPT_PAGE_CONTRACT, browserSessionId: 'synthetic-queue-browser',
    browser: { product: 'Google Chrome', channel: 'stable', major: 153 }, platform: { product: 'macOS', arch: 'arm64', version: '15.7' },
    permissionState: 'granted', permissions: ['nativeMessaging'], hostPermission: 'https://chatgpt.com/*', tabs: [testTab()] };
  adapter.pair(connection); adapter.synchronize(connection);
  const versions = Array.from({ length: 512 }, () => ({ id: randomUUID(), anchor: 'PENDING', anchorAttempts: 0 }));
  let finish, active = 0, maximum = 0, confirm = false;
  const held = new Promise(resolve => { finish = resolve; }), jobs = [];
  const options = { vault, fastTrust: { profile: FAST_CONFIRM_PROFILE },
    managed: { submit: async (_payload, { beforeSubmit } = {}) => {
      beforeSubmit?.(); return { transactionId: 'A'.repeat(52) };
    } }, collectFast: async () => { if (!confirm) throw Error('SYNTHETIC_TIMEOUT'); return {}; },
    verifyFast: () => ({ authorized: true, anchor: 'SOURCE_CORROBORATED', timestamp: 'SOURCE_REPORTED',
      assurance: FAST_CONFIRM_PROFILE, round: 42 }) };
  const session = await new ChatGPTRecordingSession(directory, adapter, options).init();
  const status = session.status.bind(session), anchor = session.anchorManaged.bind(session);
  session.status = () => ({ versions: [...versions, ...status().versions] });
  session.anchorManaged = async request => {
    jobs.push(request.id); maximum = Math.max(maximum, ++active);
    try { await held; return versions.some(version => version.id === request.id) ? {} : await anchor(request); }
    finally { active--; }
  };
  const engine = await new ResidentEngine(directory, session, adapter, epoch).init();
  t.after(async () => { engine.stop(); finish(); await engine.drain(); });
  assert.equal(jobs.length, 2); await engine.command(command(engine, true), { surface: 'desktop' });
  const policy = engine.capturePolicy()[0], source = { adapterProfile: CHATGPT_ADAPTER_PROFILE, pageContract: CHATGPT_PAGE_CONTRACT,
    runtimeEpoch: epoch, browserSessionId: policy.browserSessionId, scope: policy.scope, tabId: policy.tabId,
    windowId: policy.windowId, tabEpoch: policy.tabEpoch, documentId: 'queue-document', destination: policy.destination };
  const observation = { profile: CHATGPT_CAPTURE_PROFILE, kind: 'request-observed', token: policy.token,
    eventId: randomUUID(), source, text: 'SYNTHETIC_QUEUE_FULL', inputMethod: 'send-button',
    request: { profile: 'chatgpt-new-user-text/1', path: '/backend-api/conversation', messageId: 'queued-message', conversationId: source.destination.slice(13) } };
  const ack = await engine.observe(observation);
  assert.equal(ack.state, 'PROMPT_SAVED');
  assert.deepEqual(await engine.observe(observation), ack);
  await engine.observe({ ...observation, eventId: randomUUID(), text: 'SECOND_DURABLE_CAPTURE' });
  assert.equal(session.receipts.list().length, 2); assert.equal(jobs.length, 2);
  assert.ok(status().versions.every(version => version.anchor === 'PENDING' && version.anchorAttempts === 0));
  const preview = session.receipts.prepare({ ids: [ack.receiptId] });
  assert.equal(preview.texts[0].preview, observation.text);
  assert.ok(verifyPortable(session.receipts.export(preview.previewId)).records.length > 0);
  await engine.command(command(engine, false), { surface: 'desktop' }); assert.deepEqual(engine.capturePolicy(), []);
  await assert.rejects(engine.observe({ ...observation, eventId: randomUUID() }), /CAPTURE_NOT_ENABLED/);
  finish(); await engine.drain();
  assert.equal(maximum, 2); assert.equal(jobs.length, 514); assert.equal(new Set(jobs).size, 514);
  assert.ok(status().versions.every(version => version.anchor === 'PENDING' && version.anchorAttempts === 1));
  engine.stop(); session.close(); confirm = true;
  const restored = await new ChatGPTRecordingSession(directory, adapter, options).init();
  const reopened = await new ResidentEngine(directory, restored, adapter, randomUUID()).init();
  t.after(() => { reopened.stop(); restored.close(); });
  await reopened.drain();
  assert.equal(reopened.state().recording, false); assert.equal(restored.receipts.list().length, 2);
  assert.ok(restored.status().versions.every(version => version.anchor === 'SOURCE_CORROBORATED' && version.anchorAttempts === 2));
});

test('a freed anchor slot cannot schedule capture while its engine metadata save is unfinished', async t => {
  let finishAnchor, finishSave, enteredSave;
  const heldAnchor = new Promise(resolve => { finishAnchor = resolve; });
  const heldSave = new Promise(resolve => { finishSave = resolve; });
  const saving = new Promise(resolve => { enteredSave = resolve; });
  let confirmations = 0;
  const f = await fixture(t, { collectFast: () => ++confirmations === 1 ? heldAnchor : { synthetic: true } });
  const save = EngineStateStore.prototype.save;
  t.after(() => { EngineStateStore.prototype.save = save; finishSave(); finishAnchor({ synthetic: true }); });
  await f.recording(true); f.send('FIRST_DURABLE_SYNTHETIC'); await until(() => f.confirmed === 1);
  EngineStateStore.prototype.save = async function (state) { enteredSave(); await heldSave; return save.call(this, state); };
  f.send('STILL_SAVING_SYNTHETIC'); await saving;
  finishAnchor({ synthetic: true }); await f.runtime.session.drain(); await new Promise(setImmediate);
  assert.equal(f.anchorCalls, 1); assert.equal(f.confirmed, 1);
  assert.equal(f.results.filter(value => value.result.kind === 'request-observed').length, 1);
  EngineStateStore.prototype.save = save; finishSave(); await f.runtime.engine.drain();
  await until(() => f.results.filter(value => value.result.kind === 'request-observed').length === 2);
  assert.equal(f.anchorCalls, 2); assert.equal(f.confirmed, 2); assert.equal(f.prevention, 0);
});

for (const profile of ['pap-chatgpt-observation/2', 'pap-chatgpt-observation/3']) test(`${profile} retains signed meanings and existing anchor policy without new capture authority`, async t => {
  const directory = await root(t), vault = new Vault(join(directory, 'vault'), randomBytes(32), undefined, { create: true });
  t.after(() => vault.close());
  const text = vault.capture(Buffer.from('LEGACY_SYNTHETIC_\uFEFFe\u0301'));
  const value = { profile: 'pap-chatgpt-observation/2', kind: 'normal-send-intent', eventId: randomUUID(),
    source: { adapterProfile: 'pap-chatgpt-chrome/5', pageContract: 'chatgpt-web-text/2026-09-14', runtimeEpoch: 'old-epoch',
      browserSessionId: 'old-browser', scope: randomUUID(), tabId: 17, windowId: 1, tabEpoch: 'old-tab', documentId: 'old-document', destination: 'new-chat' },
    inputMethod: 'send-button', textRecord: text.manifest.eventId, textObject: text.manifest.evidence[0].objectDigest,
    mode: 'Continuous', boundary: 'provider_dom', coverage: 'UTF8_COMPOSER_TEXT', releaseClass: 'RETROSPECTIVE_CONTINUOUS',
    attachments: 'UNSUPPORTED', providerReceipt: 'UNKNOWN' };
  if (profile === 'pap-chatgpt-observation/3') {
    value.profile = profile; value.source.adapterProfile = 'pap-chatgpt-chrome/6';
    value.source.pageContract = 'chatgpt-web-text/2026-09-15'; value.mode = 'ON'; value.releaseClass = 'RETROSPECTIVE_OBSERVATION';
  }
  const record = vault.capture(Buffer.from(canonical(value)), { type: 'observation' });
  vault.capture(Buffer.from(canonical({ profile, kind: 'normal-message-observed', eventId: value.eventId,
    source: value.source, recordDigest: record.recordDigest, messageId: 'legacy-message',
    correlation: 'UNIQUE_NEW_EXACT_TEXT_DOM_MATCH', providerReceipt: 'UNKNOWN' })), { type: 'observation' });
  const before = canonical(vault.inspect().records); let submissions = 0;
  const adapter = new ChatGPTChromeAdapter({ extensionId: CHATGPT_EXTENSION_ID });
  const session = await new ChatGPTRecordingSession(directory, adapter, { vault, fastTrust: { profile: FAST_CONFIRM_PROFILE },
    managed: { status: () => ({ state: 'ACTIVE' }), submit: async (_payload, { beforeSubmit }) => {
      if (profile === 'pap-chatgpt-observation/2') throw Error('LEGACY_MUST_NOT_SUBMIT');
      beforeSubmit(); submissions++; return { transactionId: 'A'.repeat(52) };
    } }, collectFast: async () => ({ synthetic: true }),
    verifyFast: () => ({ authorized: true, anchor: 'SOURCE_CORROBORATED', timestamp: 'SOURCE_REPORTED',
      assurance: FAST_CONFIRM_PROFILE, round: 42 }) }).init();
  const preview = session.receipts.prepare({ ids: [record.manifest.eventId] });
  const report = verifyPortable(session.receipts.export(preview.previewId));
  assert.equal(report.records.find(entry => entry.recordDigest === record.recordDigest).releaseControl, 'OBSERVED_ONLY');
  assert.ok(report.records.find(entry => entry.recordDigest === record.recordDigest).localAssertions.some(assertion => assertion.kind === 'normal-message-observed'));
  if (profile === 'pap-chatgpt-observation/2') {
    await assert.rejects(session.anchorManaged({ id: value.eventId }), /unavailable/);
    await assert.rejects(session.upgradeConsensus({ id: value.eventId }), /read-only/);
  }
  assert.throws(() => session.observeNormal({ eventId: value.eventId }), /read-only/);
  assert.equal(canonical(vault.inspect().records), before);
  const engine = await new ResidentEngine(directory, session, adapter, randomUUID()).init(); t.after(() => engine.stop());
  await engine.drain(); assert.equal(submissions, profile === 'pap-chatgpt-observation/3' ? 1 : 0);
  assert.equal(engine.state().recording, false);
  assert.deepEqual(vault.inspect().records.slice(0, JSON.parse(before).length), JSON.parse(before));
  if (profile === 'pap-chatgpt-observation/3') assert.equal(session.status().versions[0].anchor, 'SOURCE_CORROBORATED');
});

test('the resident lock prevents two recorders loading one directory', async t => {
  const directory = await root(t), unlock = lockResidentEngine(directory);
  try { assert.throws(() => lockResidentEngine(directory), /RESIDENT_ENGINE_ALREADY_RUNNING/); } finally { unlock(); }
  lockResidentEngine(directory)();
});

test('anchor retries retain their transaction and durable attempt budget across restart', async t => {
  let submissions = 0;
  const f = await fixture(t, { managed: { status: () => ({ state: 'ACTIVE' }), submit: async (_payload, { beforeSubmit }) => {
    beforeSubmit(); submissions++; return { transactionId: 'A'.repeat(52) };
  } }, collectFast: async () => { throw Error('SYNTHETIC_TIMEOUT'); } });
  await f.recording(true); f.send('PENDING_SYNTHETIC'); await until(() => f.confirmed === 1); await f.runtime.engine.drain();
  const id = f.runtime.session.status().versions[0].id;
  await assert.rejects(f.runtime.session.anchorManaged({ id }), /SYNTHETIC_TIMEOUT/);
  assert.equal(submissions, 1);
  await f.restart(); await f.runtime.engine.drain();
  assert.equal(f.runtime.session.status().versions[0].anchorAttempts, 3);
  await assert.rejects(f.runtime.session.anchorManaged({ id }), /ANCHOR_RETRY_LIMIT/);
  assert.equal(submissions, 1); assert.equal(f.runtime.session.receipts.list().length, 1);
});

for (const retry of ['explicit', 'reopen']) test(`disconnected account preserves attempts across reopens until ${retry} retry after connection`, async t => {
  let requests = 0, submissions = 0;
  const client = new ManagedAnchoringClient({ origin: 'https://managed.example', keyStore: new MemoryKeyStore(),
    request: async (_origin, path, _token, body) => {
      requests++;
      if (path === '/v1/account') return { profile: MANAGED_PROFILE, accountId: randomUUID(), state: 'ACTIVE',
        paidThrough: 1, month: '2026-09', remaining: 5 };
      submissions++;
      return { profile: MANAGED_PROFILE, network: MANAGED_NETWORK, payload: body.payload,
        transactionId: 'A'.repeat(52), state: 'SUBMITTED_OR_UNKNOWN' };
    } });
  const f = await fixture(t, { managed: client, collectFast: async () => { throw Error('SYNTHETIC_TIMEOUT'); } });
  await f.recording(true); f.send('ACCOUNT_PREREQUISITE_SYNTHETIC');
  await until(() => f.runtime.session.receipts.list().length === 1); await f.runtime.engine.drain();
  const id = f.runtime.session.status().versions[0].id;
  for (let index = 0; index < 3; index++) { await f.restart(); await f.runtime.engine.drain(); }
  for (let index = 0; index < 3; index++) await f.runtime.session.anchorManaged({ id });
  assert.equal(requests, 0); assert.equal(submissions, 0);
  assert.equal(f.runtime.session.status().versions[0].anchorAttempts, 0);
  assert.equal(f.runtime.session.status().versions[0].managed.state, 'ACCOUNT_REQUIRED');
  const payload = f.runtime.session.anchorRequest(id).payload;
  await f.runtime.session.connectManaged({ accessCode: 'a'.repeat(43) });
  if (retry === 'reopen') { await f.restart(); await f.runtime.engine.drain(); }
  else await assert.rejects(f.runtime.session.anchorManaged({ id }), /SYNTHETIC_TIMEOUT/);
  assert.equal(f.runtime.session.status().versions[0].anchorAttempts, 1);
  client.disconnect();
  await assert.rejects(f.runtime.session.anchorManaged({ id }), /SYNTHETIC_TIMEOUT/);
  await f.restart(); await f.runtime.engine.drain();
  assert.equal(f.runtime.session.status().versions[0].anchorAttempts, 3);
  await assert.rejects(f.runtime.session.anchorManaged({ id }), /ANCHOR_RETRY_LIMIT/);
  assert.equal(requests, 2); assert.equal(submissions, 1); assert.equal(f.confirmed, 3);
  assert.equal(f.runtime.session.anchorRequest(id).payload, payload);
  assert.equal(f.runtime.session.status().versions[0].managed.transactionId, 'A'.repeat(52));
  assert.equal(f.runtime.session.receipts.list().length, 1);
  assert.equal(f.userSends, 1); assert.equal(f.prevention, 0); assert.equal(f.releases.length, 0);
});

test('an unconfigured client consumes no attempts across restart and can later anchor the same local evidence', async t => {
  const directory = await root(t), vault = new Vault(join(directory, 'vault'), randomBytes(32), undefined, { create: true });
  t.after(() => vault.close());
  const adapter = new ChatGPTChromeAdapter({ extensionId: CHATGPT_EXTENSION_ID });
  const options = { vault, fastTrust: { profile: FAST_CONFIRM_PROFILE } };
  let session = await new ChatGPTRecordingSession(directory, adapter, options).init();
  const id = randomUUID(), source = { adapterProfile: CHATGPT_ADAPTER_PROFILE, pageContract: CHATGPT_PAGE_CONTRACT,
    runtimeEpoch: randomUUID(), browserSessionId: 'synthetic-unconfigured', scope: randomUUID(), tabId: 17,
    windowId: 1, tabEpoch: 'synthetic-epoch', documentId: 'synthetic-document', destination: 'conversation:synthetic' };
  const original = session.observeNormal({ kind: 'request-observed', eventId: id, source,
    text: 'UNCONFIGURED_SYNTHETIC', inputMethod: 'send-button',
    request: { profile: 'chatgpt-new-user-text/1', path: '/backend-api/conversation', messageId: 'unconfigured-message', conversationId: 'synthetic' } });
  await assert.rejects(session.confirmFast({ id, transactionId: 'invalid' }), /Algorand transaction ID required/);
  assert.equal(session.status().versions[0].anchorAttempts, 0);
  for (let index = 0; index < 4; index++) {
    const engine = await new ResidentEngine(directory, session, adapter, randomUUID()).init();
    await engine.drain(); engine.stop();
    assert.equal((await session.anchorManaged({ id })).anchorAttempts, 0);
    session.close(); session = await new ChatGPTRecordingSession(directory, adapter, options).init();
  }
  session.close(); let submissions = 0;
  session = await new ChatGPTRecordingSession(directory, adapter, { ...options,
    managed: { submit: async (_payload, { beforeSubmit } = {}) => {
      beforeSubmit?.(); submissions++; return { transactionId: 'A'.repeat(52) };
    } }, collectFast: async () => { throw Error('SYNTHETIC_TIMEOUT'); } }).init();
  t.after(() => session.close());
  await assert.rejects(session.anchorManaged({ id }), /SYNTHETIC_TIMEOUT/);
  assert.equal(submissions, 1); assert.equal(session.status().versions[0].anchorAttempts, 1);
  assert.equal(session.status().versions[0].recordDigest, original.recordDigest);
  assert.equal(session.receipts.list().length, 1);
});

for (const failure of ['ACCOUNT_REQUIRED', 'SERVICE_UNAVAILABLE']) test(`external ${failure} consumes a durable attempt and retries the same anchor identity`, async t => {
  let f; const payloads = [];
  const client = new ManagedAnchoringClient({ origin: 'https://managed.example', keyStore: new MemoryKeyStore(),
    request: async (_origin, path, _token, body) => {
      if (path === '/v1/account') return { profile: MANAGED_PROFILE, accountId: randomUUID(), state: 'ACTIVE',
        paidThrough: 1, month: '2026-09', remaining: 5 };
      payloads.push(body.payload);
      if (payloads.length === 1) {
        const { vault } = f.runtime.session, version = f.runtime.session.status().versions[0];
        const attempts = vault.inspect().records.filter(record => record.manifest.type === 'observation')
          .map(record => JSON.parse(vault.read(record.manifest.evidence[0].objectDigest)))
          .filter(value => value.kind === 'anchor-attempt');
        assert.equal(attempts.at(-1).number, 1); assert.equal(version.anchorAttempts, 1);
        throw Object.assign(Error(failure), { code: failure });
      }
      return { profile: MANAGED_PROFILE, network: MANAGED_NETWORK, payload: body.payload,
        transactionId: 'B'.repeat(52), state: 'SUBMITTED_OR_UNKNOWN' };
    } });
  f = await fixture(t, { managed: client, collectFast: async () => { throw Error('SYNTHETIC_TIMEOUT'); } });
  await f.runtime.session.connectManaged({ accessCode: 'b'.repeat(43) });
  await f.recording(true); f.send('AMBIGUOUS_ANCHOR_SYNTHETIC');
  await until(() => f.runtime.session.receipts.list().length === 1); await f.runtime.engine.drain();
  const id = f.runtime.session.status().versions[0].id;
  assert.equal(f.runtime.session.status().versions[0].anchorAttempts, 1);
  await f.restart(); await f.runtime.engine.drain();
  assert.equal(f.runtime.session.status().versions[0].anchorAttempts, 2);
  assert.equal(f.runtime.session.status().versions[0].managed.transactionId, 'B'.repeat(52));
  client.disconnect(); await assert.rejects(f.runtime.session.anchorManaged({ id }), /SYNTHETIC_TIMEOUT/);
  await f.restart(); await f.runtime.engine.drain();
  await assert.rejects(f.runtime.session.anchorManaged({ id }), /ANCHOR_RETRY_LIMIT/);
  assert.deepEqual(payloads, [f.runtime.session.anchorRequest(id).payload, f.runtime.session.anchorRequest(id).payload]);
  assert.equal(f.runtime.session.status().versions[0].anchorAttempts, 3);
  assert.equal(f.runtime.session.status().versions[0].managed.transactionId, 'B'.repeat(52));
  assert.equal(f.confirmed, 2); assert.equal(f.runtime.session.receipts.list().length, 1);
  assert.equal(f.prevention, 0); assert.equal(f.releases.length, 0);
});

for (const code of ['ACCOUNT_REQUIRED', 'UNPAID', 'QUOTA_EXHAUSTED', 'RATE_LIMITED', 'SERVICE_UNAVAILABLE', 'SUBMISSION_INTERRUPTED']) {
  test(`${code} leaves durable evidence, normal Send and free export available`, async t => {
    const f = await fixture(t, { managed: { status: () => ({ state: code }), submit: async (_payload, { beforeSubmit }) => {
      if (code !== 'ACCOUNT_REQUIRED') beforeSubmit();
      throw Object.assign(Error(code), { code });
    } } });
    await f.recording(true); f.send('ACCOUNT_FAILURE_SYNTHETIC'); await until(() => f.runtime.session.receipts.list().length === 1);
    await f.runtime.engine.drain();
    const receipt = f.runtime.session.receipts.list()[0], preview = f.runtime.session.receipts.prepare({ ids: [receipt.id] });
    assert.equal(preview.texts[0].preview, 'ACCOUNT_FAILURE_SYNTHETIC');
    assert.ok(f.runtime.session.receipts.export(preview.previewId).length);
    assert.equal(f.runtime.session.status().versions[0].managed.state, code);
    assert.equal(f.prevention, 0); assert.equal(f.releases.length, 0);
  });
}
