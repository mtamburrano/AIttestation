import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { SourceRegistry } from '../spikes/core/source-registry.mjs';
import { IntegrationRegistry } from '../spikes/core/integration-registry.mjs';
import { startRecordingCore } from '../spikes/core/runtime.mjs';
import { ENGINE_COMMAND_PROFILE } from '../spikes/core/recording-engine.mjs';
import { EngineStateStore, lockResidentEngine } from '../spikes/browser/chatgpt/engine-store.mjs';
import { ChatGPTCaptureAdmission } from '../spikes/browser/chatgpt/admission.mjs';
import { ChatGPTChromeAdapter, CHATGPT_EXTENSION_ID, CHATGPT_ADAPTER_PROFILE, CHATGPT_PAGE_CONTRACT } from '../spikes/browser/chatgpt/adapter.mjs';
import { CHATGPT_CAPTURE_PROFILE } from '../spikes/browser/chatgpt/capture.mjs';
import { FAST_CONFIRM_PROFILE } from '../spikes/anchor/algorand/fast-confirm.mjs';
import { Vault } from '../spikes/vault/vault.mjs';

async function fixture(t) {
  const root = await mkdtemp('/private/tmp/attestamp-core-sources-test-');
  const key = randomBytes(32), vault = new Vault(join(root, 'vault'), key, undefined, { create: true });
  const epoch = randomUUID(), sources = new SourceRegistry();
  const peers = ['test-browser-a', 'test-browser-b'].map(integrationId => {
    const adapter = new ChatGPTChromeAdapter({ extensionId: CHATGPT_EXTENSION_ID, runtimeEpoch: epoch });
    const hello = { extensionId: CHATGPT_EXTENSION_ID, adapterProfile: CHATGPT_ADAPTER_PROFILE,
      captureProfile: CHATGPT_CAPTURE_PROFILE, pageContract: CHATGPT_PAGE_CONTRACT,
      browserSessionId: randomUUID(), browser: { product: 'Google Chrome', channel: 'stable', major: 153 },
      platform: { product: 'macOS', arch: 'arm64', version: '15.7.2' },
      permissions: ['nativeMessaging'], permissionState: 'granted', hostPermission: 'https://chatgpt.com/*',
      tabs: [{ id: 17, windowId: 1, tabEpoch: 'synthetic-document', url: 'https://chatgpt.com/c/test',
        active: true, destination: 'conversation:test', surfaceSupported: true, attachmentsPresent: false }] };
    adapter.pair(hello); adapter.synchronize(hello);
    return sources.attach({ integrationId, installationId: 'synthetic-installation',
      boundary: new ChatGPTCaptureAdmission(adapter, epoch) });
  });
  const core = await startRecordingCore({ directory: root, sources, runtimeEpoch: epoch, vault,
    fastTrust: { profile: FAST_CONFIRM_PROFILE }, managed: null,
    integrations: peers.map(peer => ({ id: peer.integrationId, previouslyEnabled: true, supported: true })),
    platform: { lock: lockResidentEngine, stateStore: (path, selected) => new EngineStateStore(path, selected) } });
  t.after(async () => { await core.close(); vault.close(); key.fill(0); await rm(root, { recursive: true, force: true }); });
  const recording = enabled => core.engine.command({ profile: ENGINE_COMMAND_PROFILE, adapterProfile: CHATGPT_ADAPTER_PROFILE,
    runtimeEpoch: epoch, commandId: randomUUID(), expectedRevision: core.engine.state().revision,
    kind: 'SET_RECORDING', enabled }, { surface: 'desktop' });
  const channels = peers.map(peer => core.engine.captureChannel(peer));
  const submission = (index, text = '\ufeffExact\r\n e\u0301 😀') => {
    const policy = channels[index].capturePolicy()[0];
    return { profile: CHATGPT_CAPTURE_PROFILE, kind: 'request-observed', token: policy.token, eventId: randomUUID(), text,
      source: { adapterProfile: CHATGPT_ADAPTER_PROFILE, pageContract: CHATGPT_PAGE_CONTRACT,
        runtimeEpoch: epoch, browserSessionId: policy.browserSessionId, scope: policy.scope,
        tabId: policy.tabId, windowId: policy.windowId, tabEpoch: policy.tabEpoch,
        documentId: 'synthetic-document', destination: policy.destination },
      inputMethod: 'provider-request', request: { profile: 'chatgpt-new-user-text/3', path: '/backend-api/conversation',
        messageId: randomUUID(), conversationId: 'test' } };
  };
  return { ...core, root, vault, sources, peers, channels, recording, submission };
}

test('equal tab IDs in independent peers cannot share capture authority or receipt queries', async t => {
  const f = await fixture(t); await f.recording(true);
  const one = f.submission(0), two = f.submission(1);
  assert.equal(one.source.tabId, two.source.tabId);
  assert.notEqual(one.source.scope, two.source.scope);
  await assert.rejects(f.channels[1].observe(one), /CAPTURE_NOT_ENABLED/);
  const saved = await f.channels[0].observe(one);
  await f.channels[1].observe(two);
  assert.equal(f.session.versionCount, 2, 'equal text is two distinct submissions');
  const query = { profile: one.profile, eventId: one.eventId, source: one.source };
  assert.equal(f.channels[0].captureReceipt(query).receiptId, saved.receiptId);
  assert.equal(f.channels[1].captureReceipt(query).state, 'SAVE_PENDING');
  assert.equal(f.channels[0].command, undefined);
  assert.equal(f.channels[0].state, undefined);
  assert.equal(f.channels[0].vault, undefined);
});

test('OFF revokes every peer while disconnect and integration disable revoke only their source', async t => {
  const f = await fixture(t); await f.recording(true);
  const old = [f.submission(0), f.submission(1)];
  await f.recording(false); await f.recording(true);
  for (let index = 0; index < 2; index++) await assert.rejects(f.channels[index].observe(old[index]), /CAPTURE_NOT_ENABLED/);
  const queued = f.channels[0].observe(f.submission(0));
  f.sources.detach(f.peers[0]);
  await assert.rejects(queued, /CAPTURE_NOT_ENABLED/);
  assert.equal((await f.channels[1].observe(f.submission(1))).state, 'PROMPT_SAVED');
  const pending = f.submission(1);
  f.sources.setIntegrationEnabled('test-browser-b', false);
  assert.deepEqual(f.channels[1].capturePolicy(), []);
  f.sources.setIntegrationEnabled('test-browser-b', true);
  await assert.rejects(f.channels[1].observe(pending), /CAPTURE_NOT_ENABLED/);
  assert.equal(f.session.versionCount, 1);
});

test('new integrations stay disabled after migration, recovery and missing state', async () => {
  let snapshot = null;
  const vault = { readState: () => snapshot, writeState: (_key, value) => { snapshot = structuredClone(value); } };
  const definitions = [
    { id: 'existing-browser', previouslyEnabled: true, supported: true },
    { id: 'new-client', previouslyEnabled: false, supported: true },
    { id: 'unsupported-client', previouslyEnabled: false, supported: false, unavailableReason: 'SUBMISSION_GENERATION_UNAVAILABLE' },
  ];
  const registry = new IntegrationRegistry(vault, definitions);
  assert.equal(registry.enabled('existing-browser'), true);
  assert.equal(registry.enabled('new-client'), false);
  assert.throws(() => registry.setEnabled('unsupported-client', true), /SUBMISSION_GENERATION_UNAVAILABLE/);
  const previous = registry.generation('existing-browser');
  registry.setEnabled('new-client', true);
  assert.equal(registry.generation('existing-browser'), previous);
  assert.equal(new IntegrationRegistry(vault, definitions).enabled('new-client'), true);
  snapshot = null;
  assert.equal(new IntegrationRegistry(vault, definitions).enabled('new-client'), false);
});

test('failed disable persistence revokes memory authority before returning the failure', async () => {
  const registry = new IntegrationRegistry({ readState: () => null, writeState() { throw Error('SYNTHETIC_STORAGE_FAILURE'); } },
    [{ id: 'test-client', previouslyEnabled: true, supported: true }]);
  const old = registry.generation('test-client');
  assert.throws(() => registry.setEnabled('test-client', false), /SYNTHETIC_STORAGE_FAILURE/);
  assert.equal(registry.available('test-client'), false);
  assert.notEqual(registry.generation('test-client'), old);
});
