import { generateKeyPairSync, createPublicKey, sign, verify, randomBytes } from 'node:crypto';
import { canonical, parseCanonical, hash, b64, unb64, objectDigest, LIMITS, keys, fail, pack, unpack } from './format.mjs';

export const identity = () => generateKeyPairSync('ed25519');
export const publicBytes = key => key.export({ format: 'jwk' }).x;
export const publicProofDigest = bytes => b64(hash('PAP/public-proof/v1\0', bytes));
export function makeRecord(bytes, signing, sequence, previous) {
  const manifest = { profile: 'pap-poc/1', eventId: b64(randomBytes(16)), type: 'capture', mode: 'Continuous',
    sequence: String(sequence), localClaimedTime: new Date().toISOString(), previousRecordDigest: previous,
    signingPublicKey: publicBytes(signing.publicKey), boundary: 'trusted_local_composer',
    adapter: { id: 'local-vault-spike', version: '1' }, coverage: 'exact', policy: null, relationships: [],
    evidence: [{ role: 'input', objectDigest: objectDigest(bytes), byteLength: String(bytes.length), mediaType: 'application/octet-stream', coverage: 'exact' }] };
  const opening = randomBytes(32);
  const commitment = hash('PAP/commit/v1\0', opening, canonical(manifest));
  const signature = sign(null, Buffer.concat([Buffer.from('PAP/sign/v1\0'), commitment]), signing.privateKey);
  return { manifest, opening: b64(opening), commitment: b64(commitment), signature: b64(signature),
    recordDigest: b64(hash('PAP/record/v1\0', commitment, signature)) };
}
export function verifyRecord(record, evidence = null) {
  const result = { structure: 'VALID', integrity: 'VALID', keyAttribution: 'SIGNATURE_VALID',
    evidence: evidence === null ? 'MISSING' : 'COMPLETE', anchor: 'UNANCHORED', timestamp: 'LOCAL_CLAIMED', releaseControl: 'NOT_APPLICABLE' };
  try {
    keys(record, ['manifest', 'opening', 'commitment', 'signature', 'recordDigest']);
    const m = record.manifest;
    if (m === null || record.opening === null) { result.integrity = 'INCOMPLETE'; result.keyAttribution = 'KEY_MISSING'; return result; }
    keys(m, ['profile', 'eventId', 'type', 'mode', 'sequence', 'localClaimedTime', 'previousRecordDigest', 'signingPublicKey', 'boundary', 'adapter', 'coverage', 'policy', 'relationships', 'evidence']);
    if (m.profile !== 'pap-poc/1') fail('UNSUPPORTED');
    if (Buffer.byteLength(canonical(m)) > LIMITS.manifest) fail('LIMIT_EXCEEDED');
    unb64(m.eventId, 16);
    if (typeof m.sequence !== 'string' || !/^[1-9][0-9]{0,19}$/.test(m.sequence) || m.type !== 'capture'
        || m.mode !== 'Continuous' || m.boundary !== 'trusted_local_composer' || m.coverage !== 'exact'
        || m.policy !== null || !Array.isArray(m.relationships) || m.relationships.length) fail('UNSUPPORTED');
    keys(m.adapter, ['id', 'version']);
    if (m.adapter.id !== 'local-vault-spike' || m.adapter.version !== '1' || typeof m.localClaimedTime !== 'string'
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(m.localClaimedTime)) fail('INVALID');
    if (m.previousRecordDigest !== null) unb64(m.previousRecordDigest, 32);
    if (!Array.isArray(m.evidence) || m.evidence.length !== 1) fail('UNSUPPORTED');
    const ref = m.evidence[0]; keys(ref, ['role', 'objectDigest', 'byteLength', 'mediaType', 'coverage']);
    unb64(ref.objectDigest, 32);
    if (ref.role !== 'input' || ref.mediaType !== 'application/octet-stream' || ref.coverage !== 'exact'
        || typeof ref.byteLength !== 'string' || !/^(0|[1-9][0-9]{0,8})$/.test(ref.byteLength)) fail('INVALID');
    if (Number(ref.byteLength) > LIMITS.object) fail('LIMIT_EXCEEDED');
    const commitment = unb64(record.commitment, 32), signature = unb64(record.signature, 64);
    if (b64(hash('PAP/commit/v1\0', unb64(record.opening, 32), canonical(m))) !== record.commitment
        || b64(hash('PAP/record/v1\0', commitment, signature)) !== record.recordDigest) result.integrity = 'INVALID';
    if (m.signingPublicKey === null) result.keyAttribution = 'KEY_MISSING';
    else {
      unb64(m.signingPublicKey, 32);
      const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: m.signingPublicKey }, format: 'jwk' });
      if (!verify(null, Buffer.concat([Buffer.from('PAP/sign/v1\0'), commitment]), publicKey, signature)) result.keyAttribution = 'SIGNATURE_INVALID';
    }
    if (evidence === null) { if (result.integrity === 'VALID') result.integrity = 'INCOMPLETE'; }
    else if (evidence.length !== Number(ref.byteLength) || objectDigest(evidence) !== ref.objectDigest) result.integrity = 'INVALID';
  } catch (e) { result.structure = e.code === 'UNSUPPORTED' || e.code === 'LIMIT_EXCEEDED' ? 'UNSUPPORTED' : 'INVALID'; result.integrity = 'INVALID'; result.keyAttribution = 'KEY_MISSING'; }
  return result;
}
export function verifyDisclosure(input) {
  const bundle = parseCanonical(input);
  if (bundle?.profile === 'pap-disclosure-spike/1') keys(bundle, ['profile', 'scope', 'records', 'objects']);
  else if (bundle?.profile === 'pap-disclosure-spike/2') keys(bundle,
    ['profile', 'scope', 'records', 'objects', 'publicProofObjects', 'publicProofReferences']);
  else fail('UNSUPPORTED');
  if (bundle.scope !== 'SELECTIVE') fail('UNSUPPORTED');
  if (!Array.isArray(bundle.records) || !Array.isArray(bundle.objects) || bundle.records.length > LIMITS.objects
      || bundle.objects.length > LIMITS.objects) fail('LIMIT_EXCEEDED');
  const objects = new Map(); let total = 0;
  for (const obj of bundle.objects) {
    keys(obj, ['digest', 'bytes']); unb64(obj.digest, 32);
    if (objects.has(obj.digest)) fail('INVALID', 'Duplicate object');
    const bytes = unpack(obj.bytes, LIMITS.object); total += bytes.length;
    if (total > LIMITS.total) fail('LIMIT_EXCEEDED');
    if (objectDigest(bytes) !== obj.digest) fail('INVALID', 'Object mismatch');
    objects.set(obj.digest, bytes);
  }
  const result = { scope: 'SELECTIVE', latestState: 'NOT_PROVEN', records: bundle.records.map(r =>
    verifyRecord(r, objects.get(r.manifest?.evidence?.[0]?.objectDigest) ?? null)) };
  if (bundle.profile === 'pap-disclosure-spike/2') {
    if (!Array.isArray(bundle.publicProofObjects) || !Array.isArray(bundle.publicProofReferences)
        || bundle.publicProofObjects.length > LIMITS.objects || bundle.publicProofReferences.length > LIMITS.entries) fail('LIMIT_EXCEEDED');
    const selected = new Set(bundle.records.map(record => record.recordDigest)), proofs = new Map(); let proofBytes = 0;
    for (const object of bundle.publicProofObjects) {
      keys(object, ['digest', 'bytes']); unb64(object.digest, 32);
      if (proofs.has(object.digest)) fail('INVALID', 'Duplicate public proof object');
      const bytes = unpack(object.bytes, LIMITS.total); proofBytes += bytes.length;
      if (proofBytes > LIMITS.total || publicProofDigest(bytes) !== object.digest) fail('INVALID', 'Public proof object mismatch');
      proofs.set(object.digest, bytes);
    }
    const references = new Set(), usedProofs = new Set();
    for (const reference of bundle.publicProofReferences) {
      keys(reference, ['recordDigest', 'proofDigest']); unb64(reference.recordDigest, 32); unb64(reference.proofDigest, 32);
      const identity = `${reference.recordDigest}:${reference.proofDigest}`;
      if (references.has(identity) || !selected.has(reference.recordDigest) || !proofs.has(reference.proofDigest)) fail('INVALID', 'Invalid public proof reference');
      references.add(identity); usedProofs.add(reference.proofDigest);
    }
    if (usedProofs.size !== proofs.size) fail('INVALID', 'Unreferenced public proof object');
    result.publicProofs = { availability: bundle.publicProofReferences.length ? 'REFERENCE_SHARED' : 'MISSING',
      objects: proofs.size, references: references.size };
  }
  return result;
}
export const disclosureObject = bytes => ({ digest: objectDigest(bytes), bytes: pack(bytes) });
