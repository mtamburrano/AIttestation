import { createPublicKey, verify } from 'node:crypto';
import { parseCanonical, canonical, keys, unb64, b64, fail, LIMITS } from '../vault/format.mjs';
import { verifyInclusion, anchorPayload } from './merkle.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runNativeVerifier } from './native-verifier.mjs';

export const ALGORAND_CONSENSUS_ALLOWLIST = Object.freeze([
  'https://github.com/algorandfoundation/specs/tree/268b63433a907455d439995bf916f6b296018f4f',
]);

export function verifyAnchor(input, trustedConfiguration, expectedRecordDigest, { algorandVerifierPath, timeoutMs = 30000 } = {}) {
  const check = verification(input, trustedConfiguration, expectedRecordDigest, { algorandVerifierPath, timeoutMs });
  const step = check.next();
  if (step.done) return step.value;
  const { binary, options } = step.value;
  try { return check.next(spawnSync(binary, [], { ...options, encoding: 'utf8', env: {} })).value; }
  catch (error) { return check.throw(error).value; }
}

export async function verifyAnchorAsync(input, trustedConfiguration, expectedRecordDigest, { algorandVerifierPath, timeoutMs = 30000 } = {}) {
  const check = verification(input, trustedConfiguration, expectedRecordDigest, { algorandVerifierPath, timeoutMs });
  const step = check.next();
  if (step.done) return step.value;
  const { binary, options } = step.value;
  return check.next(await runNativeVerifier(binary, options)).value;
}

function* verification(input, trustedConfiguration, expectedRecordDigest, { algorandVerifierPath, timeoutMs }) {
  const report = { structure: 'VALID', recordInclusion: 'INVALID', anchor: 'INDETERMINATE',
    timestamp: 'INDETERMINATE', independentlyVerified: false, assurance: 'NONE', reason: '' };
  try {
    const bundle = parseCanonical(input, 8 * LIMITS.manifest);
    keys(bundle, ['profile', 'recordDigest', 'batch', 'adapter', 'proof']);
    if (bundle.profile !== 'pap-anchor-envelope/1') fail('UNSUPPORTED', 'Anchor envelope profile');
    unb64(expectedRecordDigest, 32);
    if (bundle.recordDigest !== expectedRecordDigest || !verifyInclusion(bundle.recordDigest, bundle.batch)) fail('INVALID', 'Record inclusion mismatch');
    report.recordInclusion = 'VALID';
    keys(bundle.adapter, ['profile', 'network', 'genesis']);
    const adapter = bundle.adapter;
    if (typeof adapter.network !== 'string' || typeof adapter.genesis !== 'string') fail('INVALID');
    if (trustedConfiguration === null || trustedConfiguration === undefined) {
      report.reason = 'Independent trust configuration missing'; return report;
    }
    keys(trustedConfiguration, ['profile', 'network', 'genesis', 'checkpoint']);
    if (trustedConfiguration.network !== adapter.network || trustedConfiguration.genesis !== adapter.genesis
        || trustedConfiguration.profile !== adapter.profile) fail('INVALID', 'Independent network/profile mismatch');
    const payload = b64(anchorPayload(unb64(bundle.batch.root, 32)));
    if (bundle.proof === null) { report.reason = 'Anchor proof missing'; return report; }
    if (adapter.profile === 'pap-algorand-sp/1') {
      if (!trustedConfiguration.checkpoint) { report.reason = 'Independent checkpoint missing'; return report; }
      if (bundle.proof.format === 'algorand-archive/1' && ['transaction', 'signedTxnInBlock', 'fullHeader', 'lightHeader', 'transactionProof', 'lightProof', 'chain']
        .some(field => bundle.proof[field] === undefined || bundle.proof[field] === null || bundle.proof[field] === ''
          || (field === 'chain' && Array.isArray(bundle.proof[field]) && !bundle.proof[field].length))) {
        report.reason = 'Archived proof material missing'; return report;
      }
      const binary = algorandVerifierPath ?? fileURLToPath(new URL('./algorand/bin/verify', import.meta.url));
      const result = yield { binary, options: { input: JSON.stringify({ archive: bundle.proof,
        trust: trustedConfiguration.checkpoint, expectedPayload: Buffer.from(payload, 'base64url').toString('base64') }),
        timeout: timeoutMs, maxBuffer: 65536 } };
      if (result.error) {
        report.anchor = 'UNSUPPORTED'; report.reason = 'Native Algorand verifier unavailable or resource limit exceeded'; return report;
      }
      let checked;
      try { checked = JSON.parse(result.stdout); } catch { fail('INVALID', 'Malformed native verifier result'); }
      if (checked.independentlyVerified && (result.status !== 0 || checked.anchor !== 'CONSENSUS_VERIFIED'
          || checked.timestamp !== 'BLOCK_HASH_BOUND')) fail('INVALID', 'Inconsistent native verifier result');
      return { ...report, ...checked, assurance: checked.anchor === 'CONSENSUS_VERIFIED'
        ? 'STATE_PROOF_UNDER_SELECTED_CHECKPOINT' : 'NONE' };
    }
    if (adapter.profile !== 'pap-signed-log-fixture/1') fail('UNSUPPORTED', 'Adapter profile');
    keys(bundle.proof, ['entry', 'signature']);
    const entry = bundle.proof.entry;
    keys(entry, ['profile', 'network', 'genesis', 'payload', 'sequence', 'sourceClaimedTime']);
    if (entry.profile !== adapter.profile || entry.network !== adapter.network || entry.genesis !== adapter.genesis
        || entry.payload !== payload || typeof entry.sequence !== 'string' || !/^[1-9][0-9]{0,19}$/.test(entry.sequence)
        || typeof entry.sourceClaimedTime !== 'string') fail('INVALID', 'Signed fixture entry mismatch');
    const checkpoint = trustedConfiguration.checkpoint;
    if (checkpoint === null) { report.reason = 'Independent checkpoint missing'; return report; }
    keys(checkpoint, ['publicKey', 'minimumSequence']); unb64(checkpoint.publicKey, 32);
    if (typeof checkpoint.minimumSequence !== 'string' || !/^[1-9][0-9]{0,19}$/.test(checkpoint.minimumSequence)
        || BigInt(entry.sequence) < BigInt(checkpoint.minimumSequence)) fail('INVALID', 'Checkpoint sequence mismatch');
    const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: checkpoint.publicKey }, format: 'jwk' });
    if (!verify(null, Buffer.from(`PAP/fixture-log/v1\0${canonical(entry)}`), publicKey, unb64(bundle.proof.signature, 64))) fail('INVALID', 'Fixture checkpoint signature');
    report.anchor = 'FIXTURE_VERIFIED'; report.assurance = 'TEST_LOG_KEY_SIGNATURE'; report.independentlyVerified = true;
    report.timestamp = 'SOURCE_REPORTED'; report.reason = 'Synthetic log signature under separately supplied key; no public-chain consensus or UTC timestamp claim';
  } catch (e) {
    report.structure = e.code === 'UNSUPPORTED' || e.code === 'LIMIT_EXCEEDED' ? 'UNSUPPORTED' : 'INVALID';
    report.anchor = report.structure; report.reason = e.message;
  }
  return report;
}
