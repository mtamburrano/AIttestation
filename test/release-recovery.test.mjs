import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { DurableVault, MemoryKeyStore } from '../spikes/vault/key-lifecycle.mjs';
import { RecordingSession } from '../spikes/core/recording-session.mjs';
import { startPackagedChatGPT } from '../spikes/browser/chatgpt/runtime-main.mjs';
import { ENGINE_COMMAND_PROFILE } from '../spikes/browser/chatgpt/engine.mjs';
import { CHATGPT_ADAPTER_PROFILE } from '../spikes/browser/chatgpt/adapter.mjs';
import { CHATGPT_CAPTURE_PROFILE } from '../spikes/browser/chatgpt/capture.mjs';
import { FAST_CONFIRM_PROFILE } from '../spikes/anchor/algorand/fast-confirm.mjs';
import { InstallationLifecycle } from '../spikes/distribution/lifecycle.mjs';
import { recipientSourceResources } from '../spikes/distribution/package-resources.mjs';
import { restrictFixtureNetwork } from '../spikes/development/fixture-network.mjs';
import { scaleObservation } from './vault-scale-fixture.mjs';

test('release recovery preserves exact exports, starts OFF and leaves independent verification after app removal', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'attestamp-release-recovery-')));
  const network = restrictFixtureNetwork(root), fastTrust = { profile: FAST_CONFIRM_PROFILE };
  const sourceStore = new MemoryKeyStore(), source = DurableVault.create(join(root, 'source'), { keyStore: sourceStore });
  let runtime, restored, session;
  t.after(async () => { await runtime?.close(); await session?.close(); restored?.close(); source.close(); network.restore(); await rm(root, { recursive: true, force: true }); });
  session = await new RecordingSession(join(root, 'source-session'), { vault: source, managed: null, fastTrust }).init();
  const input = { ...scaleObservation(1, '\ufeffSYNTHETIC_RECOVERY_e\u0301\r\n\0 ☕'), profile: CHATGPT_CAPTURE_PROFILE };
  session.observe(input);
  const receipt = session.receipts.list()[0], selected = session.receipts.prepare({ ids: [receipt.id] });
  const before = session.receipts.export(selected.previewId), records = source.inspect().records;
  source.writeState('recording-preference', { profile: 'pap-resident-state/2', state: { revision: 7, recording: true, migration: 'NEW_OR_RECOVERED' } });
  const backupPath = join(root, 'synthetic.pap-recovery'), backup = source.exportRecoveryFile(backupPath);
  await session.close(); session = null;
  for (const phase of ['before-commit', 'after-commit']) {
    const keys = new MemoryKeyStore(), failed = join(root, `interrupted-${phase}`);
    assert.throws(() => DurableVault.restoreFile(backupPath, backup.recoveryKey, failed, { keyStore: keys,
      fault: observed => { if (observed === phase) throw Error('SYNTHETIC_RESTORE_INTERRUPTION'); } }), /SYNTHETIC_RESTORE_INTERRUPTION/);
    assert.deepEqual(keys.accounts(), []);
    await assert.rejects(readFile(join(failed, 'vault.sqlite')), { code: 'ENOENT' });
  }
  const restoredStore = new MemoryKeyStore(), support = join(root, 'restored'), path = join(support, 'vault');
  await mkdir(support, { mode: 0o700 });
  restored = DurableVault.restoreFile(backupPath, backup.recoveryKey, path, { keyStore: restoredStore });
  backup.recoveryKey.fill(0);
  assert.deepEqual(restored.inspect().records, records);
  assert.equal(restored.readState('recording-preference'), null);
  assert.equal(restored.status().historicalSendAuthorization, 'NONE');
  assert.notEqual(restored.status().signingPublicKey, source.status().signingPublicKey);
  restored.close(); restored = DurableVault.open(path, { keyStore: restoredStore });
  runtime = await startPackagedChatGPT({ supportDirectory: support, vault: restored, fastTrust, managed: null, installation: null,
    integrationHomes: { codex: join(root, 'codex'), 'claude-code': join(root, 'claude'), firefox: join(root, 'firefox') } });
  assert.equal(runtime.engine.state().recording, false); assert.equal(runtime.coreEngine.beginAdmission(), null);
  const previousEpoch = 'synthetic-previous-runtime';
  await assert.rejects(runtime.engine.command({ profile: ENGINE_COMMAND_PROFILE, runtimeEpoch: previousEpoch,
    adapterProfile: CHATGPT_ADAPTER_PROFILE, commandId: randomUUID(), expectedRevision: 7,
    kind: 'SET_RECORDING', enabled: true }, { surface: 'desktop' }));
  assert.equal(runtime.engine.state().recording, false);
  const after = runtime.session.receipts.prepare({ ids: [receipt.id] });
  assert.deepEqual(runtime.session.receipts.export(after.previewId), before);
  const app = join(root, 'Synthetic.app'), verifier = join(root, 'Independent Verifier');
  await mkdir(app); await writeFile(join(app, 'synthetic-host'), 'never executed');
  for (const relative of recipientSourceResources) {
    const target = join(verifier, relative); await mkdir(dirname(target), { recursive: true });
    await cp(new URL(`../${relative}`, import.meta.url), target);
  }
  const installation = sequence => new InstallationLifecycle({ supportDirectory: support,
    chromeSupportDirectory: join(root, 'synthetic-browser-support'), browserHost: join(app, 'synthetic-host'), sequence });
  const old = await installation(2).init(); await old.enable();
  const current = await installation(3).init(); await current.enable();
  await assert.rejects(installation(2).init(), /APPLICATION_ROLLBACK_REJECTED/);
  const repair = await installation(4).init(); assert.equal(repair.highestSeen, 4);
  await repair.record('exportOffered');
  assert.deepEqual(await repair.remove({ exportDecision: 'exported' }), { integration: 'DISABLED', evidence: 'RETAINED', keys: 'RETAINED' });
  await runtime.close(); runtime = null; await rm(app, { recursive: true });
  assert.deepEqual(restored.inspect().records, records); assert.equal(restoredStore.accounts().length, 2);
  const { verifyPortable } = await import(pathToFileURL(join(verifier, 'spikes/recipient/portable.mjs')));
  const report = verifyPortable(before);
  assert.ok(report.records.length > 0 && report.records.every(row => row.integrity === 'VALID' && row.keyAttribution === 'SIGNATURE_VALID'));
  assert.ok(report.records.every(row => row.anchor !== 'CONSENSUS_VERIFIED'));
});
