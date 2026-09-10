import { verifyDisclosure } from '../vault/records.mjs';
import { parseCanonical, unpack, canonical } from '../vault/format.mjs';
import { verifyAnchor } from '../anchor/verifier.mjs';

export function recoveredBundle(disclosureText) {
  const bytes = Buffer.from(disclosureText), checked = verifyDisclosure(bytes);
  if (checked.records.some(r => r.integrity !== 'VALID' || r.keyAttribution !== 'SIGNATURE_VALID')) throw Error('Invalid recovered evidence');
  const disclosure = parseCanonical(bytes);
  const content = record => {
    const object = disclosure.objects.find(o => o.digest === record?.manifest.evidence[0].objectDigest);
    if (!object) throw Error('Recovery metadata object missing');
    return parseCanonical(unpack(object.bytes));
  };
  // The app writes an explicit index as the final record immediately before
  // snapshot export. Never classify arbitrary captured text as proof metadata.
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
  return { disclosure: disclosureText, anchors };
}

// Trust is a separate caller input. Exported trust metadata cannot select roots.
export function verifyBundle(bundle, trust) {
  if (!bundle || typeof bundle.disclosure !== 'string' || !Array.isArray(bundle.anchors) || bundle.anchors.length > 512) throw Error('Invalid export');
  const disclosure = Buffer.from(bundle.disclosure), checked = verifyDisclosure(disclosure);
  const records = parseCanonical(disclosure).records;
  if (new Set(records.map(r => r.manifest.eventId)).size !== records.length) throw Error('Duplicate record');
  const anchors = bundle.anchors.map(a => {
    const index = records.findIndex(r => r.manifest.eventId === a.descriptorId);
    if (index < 0 || checked.records[index].integrity !== 'VALID' || checked.records[index].keyAttribution !== 'SIGNATURE_VALID') throw Error('Anchor descriptor is missing or invalid');
    if (typeof a.envelope !== 'string') throw Error('Invalid envelope');
    return { descriptorId: a.descriptorId, ...verifyAnchor(Buffer.from(a.envelope), trust, records[index].recordDigest) };
  });
  return { evidence: checked, anchors, releaseControl: 'LOCAL_ASSERTIONS_ONLY',
    coverage: 'Selected records only; unlisted or unanchored records gain no anchor assurance',
    valid: checked.records.length > 0 && checked.records.every(r => r.structure === 'VALID' && r.integrity === 'VALID' && r.keyAttribution === 'SIGNATURE_VALID')
      && anchors.every(a => a.independentlyVerified) };
}
