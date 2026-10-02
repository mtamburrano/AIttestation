import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Vault } from '../spikes/vault/vault.mjs';
import { RecordingSession } from '../spikes/core/recording-session.mjs';
import { scaleObservation } from './vault-scale-fixture.mjs';
import { FAST_CONFIRM_PROFILE } from '../spikes/anchor/algorand/fast-confirm.mjs';
import { CHATGPT_CAPTURE_PROFILE } from '../spikes/browser/chatgpt/capture.mjs';

export async function verifyPackagedReceipt(bundle, work) {
  const directory = await mkdtemp(join(work, 'receipt-')), key = randomBytes(32);
  const vault = new Vault(join(directory, 'vault'), key, undefined, { create: true });
  const session = await new RecordingSession(directory, { vault, managed: null, fastTrust: { profile: FAST_CONFIRM_PROFILE } }).init();
  try {
    session.observe({ ...scaleObservation(1, 'Synthetic offline package receipt'), profile: CHATGPT_CAPTURE_PROFILE });
    const receipt = session.receipts.list()[0], selection = session.receipts.prepare({ ids: [receipt.id] });
    const { verifyPortable } = await import(pathToFileURL(join(bundle, 'Recipient/Attestamp Verifier.app/Contents/Resources/spikes/recipient/portable.mjs')));
    const report = verifyPortable(session.receipts.export(selection.previewId));
    assert.ok(report.records.length > 0 && report.records.every(row => row.integrity === 'VALID' && row.keyAttribution === 'SIGNATURE_VALID'));
    assert.ok(report.records.every(row => row.anchor !== 'CONSENSUS_VERIFIED'));
    return { status: 'PASS', integrity: 'VALID', anchor: 'NOT_CLAIMED', serviceAccess: false };
  } finally { await session.close(); vault.close(); key.fill(0); await rm(directory, { recursive: true, force: true }); }
}
