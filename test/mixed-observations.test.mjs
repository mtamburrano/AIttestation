import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { RecordingSession } from '../spikes/core/recording-session.mjs';
import { HOOK_CAPTURE_PROFILE, HOOK_SOURCE_PROFILE } from '../spikes/recipient/hook-observation.mjs';
import { CHATGPT_CAPTURE_PROFILE } from '../spikes/recipient/normal-observation.mjs';
import { FIREFOX_CAPTURE_PROFILE, FIREFOX_ADAPTER_PROFILE } from '../spikes/recipient/firefox-observation.mjs';
import { verifyPortable } from '../spikes/recipient/portable.mjs';
import { FAST_CONFIRM_PROFILE } from '../spikes/anchor/algorand/fast-confirm.mjs';
import { exportRecoveryFile, inspectRecoveryFile, restoreRecoveryFile } from '../spikes/vault/recovery-stream.mjs';
import { scaleObservation } from './vault-scale-fixture.mjs';
import { codingFixture, exactHookText } from './coding-fixture.mjs';

test('mixed profiles retain exact bytes, independent sends, stable replay, bounded History and recovery', async t => {
  const f = await codingFixture(t), s = f.session;
  const chrome = { ...scaleObservation(1, exactHookText), profile: CHATGPT_CAPTURE_PROFILE };
  const firefox = { ...scaleObservation(2, exactHookText), profile: FIREFOX_CAPTURE_PROFILE };
  firefox.source.adapterProfile = FIREFOX_ADAPTER_PROFILE;
  const hook = client => ({ profile: HOOK_CAPTURE_PROFILE, kind: 'hook-prompt-observed', eventId: randomUUID(), text: exactHookText,
    inputMethod: 'user-prompt-submit-hook', source: { profile: HOOK_SOURCE_PROFILE, integrationId: client,
      installationId: randomUUID(), runtimeEpoch: f.epoch, scope: randomUUID(), sessionId: 'synthetic-session',
      invocationId: randomUUID(), promptId: client === 'claude-code' ? randomUUID() : null, turnId: client === 'codex' ? 'turn' : null,
      origin: 'enrolled-local-executable' } });
  const codex = hook('codex'), claude = hook('claude-code');
  const inputs = [chrome, firefox, codex, claude], saved = inputs.map(input => s.observe(input));
  const immutable = saved.map(value => f.vault.getRecord(value.descriptorId));
  assert.equal(s.versionCount, 4);
  const duplicate = { ...claude, eventId: randomUUID(), source: { ...claude.source, invocationId: randomUUID() } };
  assert.equal(s.observe(duplicate).id, claude.eventId);
  assert.throws(() => s.observe({ ...duplicate, text: 'changed' }), /REPLAY_CONFLICT/);
  const equalNew = { ...codex, eventId: randomUUID(), source: { ...codex.source, invocationId: randomUUID() } };
  assert.notEqual(s.observe(equalNew).id, codex.eventId); assert.equal(s.versionCount, 5);
  for (let index = 0; index < 80; index++) s.observe({ ...scaleObservation(index + 10), profile: CHATGPT_CAPTURE_PROFILE });
  assert.equal(s.captureReceipt(duplicate.eventId, duplicate.source).receiptId, saved[3].descriptorId);
  const records = f.vault.records;
  f.vault.inspect = f.vault.records = () => { throw Error('FORBIDDEN_FULL_HISTORY'); };
  const preview = s.receipts.prepare({ ids: saved.map(value => value.descriptorId) });
  assert.equal(preview.texts.length, 4); assert.ok(preview.texts.every(value => value.preview === exactHookText));
  const report = verifyPortable(s.receipts.export(preview.previewId));
  assert.ok(report.records.every(value => value.integrity === 'VALID' && value.keyAttribution === 'SIGNATURE_VALID'));
  f.vault.records = records; // Recovery streams the archive; History/export must not scan it.
  const path = join(f.root, 'mixed.pap-recovery'), recovery = exportRecoveryFile(f.vault, path);
  assert.equal(inspectRecoveryFile(path, recovery.recoveryKey).count, f.vault.recordCount);
  const restored = restoreRecoveryFile(path, recovery.recoveryKey, join(f.root, 'restored'), randomBytes(32));
  t.after(() => restored.close()); recovery.recoveryKey.fill(0);
  const resumed = await new RecordingSession(join(f.root, 'restored'), { vault: restored, fastTrust: { profile: FAST_CONFIRM_PROFILE }, managed: null }).init();
  t.after(() => resumed.close());
  assert.equal(resumed.versionCount, 85);
  for (let i = 0; i < saved.length; i++) assert.deepEqual(restored.getRecord(saved[i].descriptorId), immutable[i]);
  assert.equal(resumed.observe(duplicate).id, claude.eventId);
  const recovered = resumed.receipts.prepare({ ids: saved.map(value => value.descriptorId) });
  assert.ok(verifyPortable(resumed.receipts.export(recovered.previewId)).records.every(value => value.integrity === 'VALID'));
});
