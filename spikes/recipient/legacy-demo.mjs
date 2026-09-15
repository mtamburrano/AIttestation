import { publicProofDigest, verifyDisclosure } from '../vault/records.mjs';
import { parseCanonical, unpack, canonical, pack, keys, unb64, LIMITS } from '../vault/format.mjs';
import { verifyAnchor } from '../anchor/verifier.mjs';

function sharedAnchors(anchors) {
  if (!Array.isArray(anchors) || anchors.length > LIMITS.objects) throw Error('Anchor export limit exceeded');
  const publicProofObjects = new Map(); let total = 0;
  const references = anchors.map(anchor => {
    const envelope = parseCanonical(Buffer.from(anchor.envelope), 8 * LIMITS.manifest);
    keys(envelope, ['profile', 'recordDigest', 'batch', 'adapter', 'proof']);
    const bytes = Buffer.from(canonical(envelope.proof)), digest = publicProofDigest(bytes);
    if (!publicProofObjects.has(digest)) {
      total += bytes.length; if (total > LIMITS.total) throw Error('Public proof export limit exceeded');
      publicProofObjects.set(digest, { digest, bytes: pack(bytes) });
    }
    return { descriptorId: anchor.descriptorId, envelope: canonical({ profile: envelope.profile,
      recordDigest: envelope.recordDigest, batch: envelope.batch, adapter: envelope.adapter, proofDigest: digest }) };
  });
  return { anchors: references, publicProofObjects: [...publicProofObjects.values()] };
}

export function recoveredBundle(disclosureText) {
  const bytes = Buffer.from(disclosureText), checked = verifyDisclosure(bytes);
  if (checked.records.some(r => r.integrity !== 'VALID' || r.keyAttribution !== 'SIGNATURE_VALID')) throw Error('Invalid recovered evidence');
  const disclosure = parseCanonical(bytes);
  const content = record => {
    const object = disclosure.objects.find(o => o.digest === record?.manifest.evidence[0].objectDigest);
    if (!object) throw Error('Recovery metadata object missing');
    return parseCanonical(unpack(object.bytes));
  };
  // The historical app wrote an explicit final index before snapshot export. Never classify arbitrary captured text as proof metadata.
  const index = content(disclosure.records.at(-1));
  if (index.profile !== 'pap-demo-observation/1' || index.kind !== 'recovery-export-index' || !Array.isArray(index.anchors)) throw Error('Demonstrator recovery index missing');
  const anchors = index.anchors.map(ref => {
    const receipt = content(disclosure.records.find(r => r.manifest.eventId === ref.receiptId));
    const descriptor = disclosure.records.find(r => r.manifest.eventId === ref.descriptorId);
    if (!descriptor || receipt.profile !== 'pap-demo-observation/1' || receipt.kind !== 'validated-confirmation'
        || receipt.recordDigest !== descriptor.recordDigest) throw Error('Recovered anchor reference mismatch');
    return { descriptorId: ref.descriptorId, envelope: canonical(receipt.envelope) };
  });
  // These remain candidates. Only separately selected trust can confer assurance.
  return { profile: 'pap-demo-export/2', disclosure: disclosureText, ...sharedAnchors(anchors) };
}

// Trust is a separate caller input. Exported trust metadata cannot select roots.
export function verifyBundle(bundle, trust) {
  if (!bundle || typeof bundle.disclosure !== 'string' || !Array.isArray(bundle.anchors) || bundle.anchors.length > 512) throw Error('Invalid export');
  const disclosure = Buffer.from(bundle.disclosure), checked = verifyDisclosure(disclosure);
  const records = parseCanonical(disclosure).records;
  if (new Set(records.map(r => r.manifest.eventId)).size !== records.length) throw Error('Duplicate record');
  let publicProofs = null;
  if (bundle.profile !== undefined) {
    if (bundle.profile !== 'pap-demo-export/2' || !Array.isArray(bundle.publicProofObjects)
        || bundle.publicProofObjects.length > LIMITS.objects) throw Error('Unsupported export');
    publicProofs = new Map(); let total = 0;
    for (const object of bundle.publicProofObjects) {
      keys(object, ['digest', 'bytes']); unb64(object.digest, 32);
      if (publicProofs.has(object.digest)) throw Error('Duplicate public proof object');
      const bytes = unpack(object.bytes, LIMITS.total); total += bytes.length;
      if (total > LIMITS.total || publicProofDigest(bytes) !== object.digest) throw Error('Invalid public proof object');
      publicProofs.set(object.digest, parseCanonical(bytes, 8 * LIMITS.manifest));
    }
  }
  const usedProofs = new Set(), anchorReferences = new Set();
  const anchors = bundle.anchors.map(a => {
    const index = records.findIndex(r => r.manifest.eventId === a.descriptorId);
    if (index < 0 || checked.records[index].integrity !== 'VALID' || checked.records[index].keyAttribution !== 'SIGNATURE_VALID') throw Error('Anchor descriptor is missing or invalid');
    if (typeof a.envelope !== 'string') throw Error('Invalid envelope');
    let envelope = Buffer.from(a.envelope);
    if (publicProofs) {
      const reference = parseCanonical(envelope, 2 * LIMITS.manifest);
      keys(reference, ['profile', 'recordDigest', 'batch', 'adapter', 'proofDigest']); unb64(reference.proofDigest, 32);
      const proof = publicProofs.get(reference.proofDigest); if (!proof) throw Error('Missing public proof object');
      const referenceId = `${a.descriptorId}:${reference.proofDigest}`;
      if (anchorReferences.has(referenceId)) throw Error('Duplicate anchor reference');
      anchorReferences.add(referenceId); usedProofs.add(reference.proofDigest);
      envelope = Buffer.from(canonical({ profile: reference.profile, recordDigest: reference.recordDigest,
        batch: reference.batch, adapter: reference.adapter, proof }));
    }
    return { descriptorId: a.descriptorId, ...verifyAnchor(envelope, trust, records[index].recordDigest) };
  });
  if (publicProofs && usedProofs.size !== publicProofs.size) throw Error('Unreferenced public proof object');
  return { evidence: checked, anchors, releaseControl: 'LOCAL_ASSERTIONS_ONLY',
    coverage: 'Selected records only; unlisted or unanchored records gain no anchor assurance',
    valid: checked.records.length > 0 && checked.records.every(r => r.structure === 'VALID' && r.integrity === 'VALID' && r.keyAttribution === 'SIGNATURE_VALID')
      && anchors.every(a => a.independentlyVerified) };
}

export { sharedAnchors };
