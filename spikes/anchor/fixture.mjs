import { sign } from 'node:crypto';
import { canonical, b64, unb64, LIMITS, fail } from '../vault/format.mjs';
import { inclusion, anchorPayload } from './merkle.mjs';

// Producer has signing authority; the verifier imports no producer code or private keys.
export function signedLogFixture(recordDigests, position, logIdentity, { network = 'synthetic-log', genesis = 'test-only-genesis', sequence = '1' } = {}) {
  const batch = inclusion(recordDigests.map(d => unb64(d, 32)), position);
  const adapter = { profile: 'pap-signed-log-fixture/1', network, genesis };
  const entry = { ...adapter, payload: b64(anchorPayload(unb64(batch.root, 32))), sequence, sourceClaimedTime: '2026-01-01T00:00:00.000Z' };
  const signature = b64(sign(null, Buffer.from(`PAP/fixture-log/v1\0${canonical(entry)}`), logIdentity.privateKey));
  return Buffer.from(canonical({ profile: 'pap-anchor-envelope/1', recordDigest: recordDigests[position], batch, adapter, proof: { entry, signature } }));
}

// Input-only measurement recorder: never polls an implicit endpoint or invents missing samples.
export function measurement({ source, submittedMs, confirmedMs = null, archivedMs = null, bundleBytes = null, feeMicroAlgos = null }) {
  if (!['SYNTHETIC', 'DEDICATED_ALGORAND_TEST'].includes(source) || !Number.isSafeInteger(submittedMs) || submittedMs < 0) fail('INVALID');
  for (const time of [confirmedMs, archivedMs]) if (time !== null && (!Number.isSafeInteger(time) || time < submittedMs)) fail('INVALID');
  if (archivedMs !== null && (confirmedMs === null || archivedMs < confirmedMs)) fail('INVALID');
  if (bundleBytes !== null && (!Number.isSafeInteger(bundleBytes) || bundleBytes < 0 || bundleBytes > LIMITS.wire)) fail('INVALID');
  if (feeMicroAlgos !== null && (typeof feeMicroAlgos !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(feeMicroAlgos))) fail('INVALID');
  return { source, confirmationLatencyMs: confirmedMs === null ? null : confirmedMs - submittedMs,
    archivalLagAfterConfirmationMs: archivedMs === null ? null : archivedMs - confirmedMs,
    bundleBytes, feeMicroAlgos, status: confirmedMs === null ? 'PENDING_CONFIRMATION' : archivedMs === null ? 'PENDING_ARCHIVE' : 'ARCHIVED' };
}
