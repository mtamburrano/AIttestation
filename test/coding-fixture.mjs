import { mkdtemp, rm } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Vault } from '../spikes/vault/vault.mjs';
import { SourceRegistry } from '../spikes/core/source-registry.mjs';
import { startRecordingCore } from '../spikes/core/runtime.mjs';
import { ENGINE_COMMAND_PROFILE, RECORDING_CONTROL_PROFILE } from '../spikes/core/recording-engine.mjs';
import { EngineStateStore, lockResidentEngine } from '../spikes/browser/chatgpt/engine-store.mjs';
import { CodingAdmission } from '../spikes/coding/admission.mjs';
import { FAST_CONFIRM_PROFILE } from '../spikes/anchor/algorand/fast-confirm.mjs';

export const exactHookText = '\ufeffSynthetic exact e\u0301\r\n\0 ☕';
export async function codingFixture(t) {
  const root = await mkdtemp('/private/tmp/attestamp-hook-test-'), epoch = randomUUID(), key = randomBytes(32);
  const vault = new Vault(join(root, 'vault'), key, undefined, { create: true }), sources = new SourceRegistry();
  const peers = ['codex', 'claude-code'].map(integrationId => sources.attach({ integrationId, installationId: randomUUID(),
    boundary: new CodingAdmission({ integrationId, installationId: randomUUID(), runtimeEpoch: epoch, origin: 'enrolled-local-executable' }) }));
  const core = await startRecordingCore({ directory: root, sources, runtimeEpoch: epoch, vault, managed: null,
    fastTrust: { profile: FAST_CONFIRM_PROFILE }, integrations: peers.map(peer => ({ id: peer.integrationId, supported: true, previouslyEnabled: false })),
    platform: { lock: lockResidentEngine, stateStore: (path, selected) => new EngineStateStore(path, selected) } });
  t.after(async () => { await core.close(); vault.close(); key.fill(0); await rm(root, { recursive: true, force: true }); });
  const command = (kind, enabled, integrationId) => core.engine.command({ profile: ENGINE_COMMAND_PROFILE,
    controlProfile: RECORDING_CONTROL_PROFILE, runtimeEpoch: epoch, commandId: randomUUID(),
    expectedRevision: core.engine.state().revision, kind, enabled, ...(integrationId ? { integrationId } : {}) }, { surface: 'desktop' });
  const channels = peers.map(peer => core.engine.captureChannel(peer));
  const input = (index = 0, extra = {}) => ({ text: exactHookText, sessionId: 'synthetic-session',
    promptId: index ? randomUUID() : null, turnId: index ? null : 'synthetic-turn', invocationId: randomUUID(), scope: randomUUID(), ...extra });
  const admit = (index, data, authority = core.engine.beginAdmission()) => channels[index].admit(data,
    { deadline: performance.now() + 100, authority });
  return { ...core, root, epoch, key, vault, sources, peers, channels, command, input, admit };
}
