import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Vault } from '../spikes/vault/vault.mjs';
import { canonical } from '../spikes/vault/format.mjs';
import { EngineStateStore } from '../spikes/browser/chatgpt/engine-store.mjs';
import { ENGINE_COMMAND_PROFILE } from '../spikes/browser/chatgpt/engine.mjs';
import { startPackagedChatGPT } from '../spikes/browser/chatgpt/runtime-main.mjs';
import { CHATGPT_ADAPTER_PROFILE } from '../spikes/browser/chatgpt/adapter.mjs';
import { FAST_CONFIRM_PROFILE } from '../spikes/anchor/algorand/fast-confirm.mjs';
import { verifyPortable } from '../spikes/recipient/portable.mjs';
import { inspectRecoveryFile } from '../spikes/vault/recovery-stream.mjs';
import { restrictFixtureNetwork } from '../spikes/development/fixture-network.mjs';
import { startupFailure, readStartupFailure } from '../spikes/development/startup.mjs';
import { scaleObservation } from './vault-scale-fixture.mjs';

const state = revision => ({ revision, recording: true, migration: 'NEW_OR_RECOVERED' });
const command = (engine, enabled) => ({ profile: ENGINE_COMMAND_PROFILE, runtimeEpoch: engine.state().runtimeEpoch,
  adapterProfile: CHATGPT_ADAPTER_PROFILE, commandId: randomUUID(), expectedRevision: engine.state().revision,
  kind: 'SET_RECORDING', enabled });
async function api(runtime, path, data = {}) {
  const url = new URL(runtime.dashboardURL);
  const response = await fetch(new URL(path, url), { method: 'POST',
    headers: { Origin: url.origin, Authorization: `Bearer ${url.hash.slice(1)}` }, body: JSON.stringify(data) });
  const value = await response.json(); assert.equal(response.status, 200, value.error); return value;
}

test('a full schema/v3 vault migrates past 512 while preserving every record, controls and streamed recovery', async t => {
  const root = await mkdtemp('/private/tmp/attestamp-capacity-migration-test-'), path = join(root, 'vault'), key = randomBytes(32);
  const network = restrictFixtureNetwork(root); let vault, runtime, revoke;
  t.after(async () => { await runtime?.close(); revoke?.(); vault?.close(); network.restore(); key.fill(0); await rm(root, { recursive: true, force: true }); });
  vault = new Vault(path, key, undefined, { create: true, readerVersion: 3 });
  const pointer = vault.capture(Buffer.from(canonical({ profile: 'pap-resident-state/2', state: state(1) })));
  await writeFile(join(root, 'engine-pointer'), pointer.manifest.eventId, { mode: 0o600 });
  for (let n = 1; n < 492; n++) vault.capture(Buffer.from(`SYNTHETIC_UNIQUE_${n}`));
  for (let n = 492; n < 512; n++) vault.capture(Buffer.from('SYNTHETIC_UNIQUE_1'));
  const original = vault.inspect(); assert.equal(original.records.length, 512); assert.equal(original.objects.length, 492);
  assert.throws(() => vault.capture(Buffer.from('SYNTHETIC_OLD_CAP')), { code: 'VAULT_CAPACITY_EXHAUSTED' });
  vault.close(); vault = new Vault(path, key);
  assert.deepEqual(vault.inspect().records, original.records);
  for (let restart = 0; restart < 3; restart++) {
    const count = vault.recordCount;
    runtime = await startPackagedChatGPT({ supportDirectory: root, vault, fastTrust: { profile: FAST_CONFIRM_PROFILE }, installation: null, managed: null });
    revoke = network.allowRuntime(runtime);
    assert.equal(runtime.engine.state().available, true); assert.equal(runtime.engine.state().captureUnavailableReason, null);
    assert.equal(vault.recordCount, count, 'opening does not append signed state');
    await runtime.engine.command(command(runtime.engine, true), { surface: 'desktop' });
    const input = scaleObservation(restart), saved = runtime.session.observeNormal(input);
    assert.equal(runtime.session.captureReceipt(input.eventId, input.source).receiptId, saved.descriptorId);
    const dashboard = await api(runtime, '/dashboard/state'); assert.equal(dashboard.history.counts.prompts, restart + 1);
    const preview = await api(runtime, '/receipts/preview', { ids: [saved.descriptorId] }); assert.equal(preview.texts[0].preview, input.text);
    const exported = await api(runtime, '/receipts/export', { previewId: preview.previewId });
    assert.ok(verifyPortable(Buffer.from(exported.content)).records.every(r => r.integrity === 'VALID'));
    await runtime.engine.command(command(runtime.engine, false), { surface: 'desktop' });
    assert.equal(vault.recordCount, count + 2, 'controls do not consume evidence records');
    if (restart === 2) {
      const recovery = await api(runtime, '/dashboard/recovery', { confirmed: true });
      const response = await fetch(new URL(recovery.downloadURL, runtime.dashboardURL));
      assert.equal(response.status, 200); const backupPath = join(root, 'download.pap-recovery');
      await writeFile(backupPath, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
      const secret = Buffer.from(recovery.recoveryKey, 'base64');
      assert.equal(inspectRecoveryFile(backupPath, secret).count, 518); secret.fill(0);
      assert.equal((await fetch(new URL(recovery.downloadURL, runtime.dashboardURL))).status, 400, 'download token is single use');
    }
    assert.deepEqual(vault.inspect().records.slice(0, 512), original.records);
    await runtime.close(); runtime = null; revoke(); revoke = null;
  }
});

for (const count of [510, 511, 512]) test(`capture and exact receipts grow normally through the former ${count} boundary`, async t => {
  const root = await mkdtemp('/private/tmp/attestamp-capacity-growth-test-'), key = randomBytes(32);
  const vault = new Vault(join(root, 'vault'), key, undefined, { create: true }); let runtime;
  t.after(async () => { await runtime?.close(); vault.close(); key.fill(0); await rm(root, { recursive: true, force: true }); });
  for (let n = 0; n < count; n++) vault.capture(Buffer.from('SYNTHETIC_FILLER'));
  runtime = await startPackagedChatGPT({ supportDirectory: root, vault, fastTrust: { profile: FAST_CONFIRM_PROFILE }, installation: null, managed: null });
  await runtime.engine.command(command(runtime.engine, true), { surface: 'desktop' });
  const input = scaleObservation(count); runtime.session.observeNormal(input);
  assert.equal(vault.recordCount, count + 2); assert.equal(runtime.session.captureReceipt(input.eventId).state, 'PROMPT_SAVED');
  assert.equal(runtime.engine.state().captureUnavailableReason, null);
});

test('OFF latch survives an interrupted ON preference commit and clears only after durable success', async t => {
  const root = await mkdtemp('/private/tmp/attestamp-consent-state-test-'), key = randomBytes(32); let interrupt = false;
  const vault = new Vault(join(root, 'vault'), key, undefined, { create: true,
    fault: phase => { if (interrupt && phase === 'state-before-commit') throw Object.assign(Error('SYNTHETIC_DISK_FULL'), { code: 'SQLITE_FULL' }); } });
  t.after(async () => { vault.close(); key.fill(0); await rm(root, { recursive: true, force: true }); });
  const store = new EngineStateStore(root, vault);
  await store.save(state(1)); await store.revokeRecording(); interrupt = true;
  await assert.rejects(store.save(state(2)), { code: 'SQLITE_FULL' });
  assert.equal((await store.load()).state.recording, false);
  interrupt = false; await store.save(state(3)); assert.equal((await store.load()).state.recording, true);
  assert.equal(vault.recordCount, 0);
});

test('legacy capacity diagnostics remain fixed and content-free', () => {
  const error = Object.assign(Error('PRIVATE_CAPACITY_CANARY'), { code: 'VAULT_CAPACITY_EXHAUSTED' });
  assert.equal(readStartupFailure(startupFailure(error)), 'PRIVATE_DEVELOPMENT_START_FAILED:VAULT_CAPACITY_EXHAUSTED');
  assert.doesNotMatch(startupFailure(error), /CANARY|UNKNOWN/);
});
