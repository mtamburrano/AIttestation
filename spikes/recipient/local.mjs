import { randomBytes } from 'node:crypto';
import { canonical, parseCanonical, objectDigest, pack, keys, LIMITS } from '../vault/format.mjs';
import { publicProofDigest, verifyRecord } from '../vault/records.mjs';
import { PORTABLE_PROFILE, RECIPIENT_LIMITS, verifyPortable, signedObservation, CLAIMS } from './portable.mjs';

const wire = value => Buffer.from(canonical(value));

export function storePublicProof(vault, proof) {
  const bytes = wire(proof), digest = objectDigest(bytes);
  if (bytes.length > RECIPIENT_LIMITS.proof) throw Error('Public proof size limit');
  if (vault.inspect().objects.some(object => object.digest === digest)) {
    if (!vault.read(digest).equals(bytes)) throw Error('Public proof storage mismatch');
  } else vault.capture(bytes, { type: 'public-proof' });
  return { proofDigest: publicProofDigest(bytes), proofObject: digest };
}

export function storeAnchor(vault, envelope) {
  keys(envelope, ['profile', 'recordDigest', 'batch', 'adapter', 'proof']);
  const { proof, ...reference } = envelope;
  return { reference: { ...reference, proofDigest: storePublicProof(vault, proof).proofDigest },
    proofObject: objectDigest(wire(proof)) };
}

export class LocalReceipts {
  #vault; #preview = null;
  constructor(vault) { this.#vault = vault; }

  #history() {
    const records = this.#vault.inspect().records;
    const observations = records.filter(r => r.manifest.type === 'observation').map(record => {
      const bytes = this.#vault.read(record.manifest.evidence[0].objectDigest);
      return { record, value: signedObservation(record, bytes, verifyRecord(record, bytes)) };
    }).filter(entry => entry.value);
    const groups = observations.filter(entry => entry.value.kind === 'frozen-text-version').map(({ record, value }) => {
      const text = records.find(r => r.manifest.eventId === value.textRecord
        && r.manifest.evidence[0].objectDigest === value.textObject);
      if (!text) throw Error('Receipt text reference missing');
      const related = observations.filter(entry => entry.value.recordDigest === record.recordDigest);
      return { id: record.manifest.eventId, title: `${value.mode} · ${record.manifest.localClaimedTime}`,
        textRecordId: text.manifest.eventId, recordIds: [text.manifest.eventId, record.manifest.eventId,
          ...related.map(entry => entry.record.manifest.eventId)], related,
        recordDigest: record.recordDigest, derivative: false };
    });
    for (const record of records.filter(r => r.manifest.type === 'derivative')) groups.push({
      id: record.manifest.eventId, title: `Redacted derivative · ${record.manifest.localClaimedTime}`,
      textRecordId: record.manifest.eventId, recordIds: [record.manifest.eventId], related: [],
      recordDigest: record.recordDigest, derivative: true,
    });
    return { records, groups };
  }

  list() {
    return this.#history().groups.map(({ related: _related, ...group }) => group);
  }

  prepare({ ids, includeEvidence = true }) {
    this.#preview = null;
    if (!Array.isArray(ids) || !ids.length || ids.length > RECIPIENT_LIMITS.records
        || new Set(ids).size !== ids.length || typeof includeEvidence !== 'boolean') throw Error('Select distinct receipts');
    const { groups } = this.#history();
    const selected = ids.map(id => { const group = groups.find(group => group.id === id); if (!group) throw Error('Unknown receipt'); return group; });
    const recordIds = [...new Set(selected.flatMap(group => group.recordIds))];
    const disclosure = parseCanonical(this.#vault.exportDisclosure(recordIds, { includeEvidence }));
    const proofs = new Map(), anchors = [], seen = new Set();
    for (const entry of selected.flatMap(group => group.related)) {
      if (entry.value.kind !== 'consensus-assurance-upgrade') continue;
      const { reference, proofObject } = entry.value;
      if (!reference || reference.recordDigest !== entry.value.recordDigest) throw Error('Stored anchor reference mismatch');
      const bytes = this.#vault.read(proofObject);
      if (publicProofDigest(bytes) !== reference.proofDigest) throw Error('Stored public proof mismatch');
      if (!proofs.has(reference.proofDigest)) proofs.set(reference.proofDigest, { digest: reference.proofDigest, bytes: pack(bytes) });
      const id = canonical(reference); if (!seen.has(id)) { anchors.push(reference); seen.add(id); }
    }
    const bundle = { profile: PORTABLE_PROFILE, disclosure, anchors, publicProofObjects: [...proofs.values()] };
    const bytes = wire(bundle), report = verifyPortable(bytes);
    const previewId = randomBytes(24).toString('base64url');
    this.#preview = { previewId, bytes };
    return { previewId, scope: 'SELECTIVE', exportBytes: bytes.length, includeEvidence,
      records: disclosure.records.map(record => ({ id: record.manifest.eventId, type: record.manifest.type,
        objectDigest: record.manifest.evidence[0].objectDigest, byteLength: record.manifest.evidence[0].byteLength,
        relationships: record.manifest.relationships })),
      texts: selected.map(group => {
        const record = disclosure.records.find(record => record.manifest.eventId === group.textRecordId);
        const content = includeEvidence ? this.#vault.read(record.manifest.evidence[0].objectDigest) : null;
        return { receiptId: group.id, derivative: group.derivative,
          preview: content?.subarray(0, 4096).toString('utf8') ?? null, truncated: content ? content.length > 4096 : false };
      }),
      evidenceObjects: disclosure.objects.length, publicProofObjects: proofs.size, anchorReferences: anchors.length,
      disclosureNotice: 'The export includes the listed signed metadata, keys, record links and selected bytes. Text previews show at most 4096 bytes. Original source bytes are never added for a redacted derivative.',
      claims: CLAIMS, report };
  }

  export(previewId) {
    if (!this.#preview || this.#preview.previewId !== previewId) throw Error('Preview this selection before export');
    return Buffer.from(this.#preview.bytes);
  }

  redact({ id, text }) {
    if (typeof text !== 'string' || !text.isWellFormed() || Buffer.byteLength(text) > LIMITS.field) throw Error('Redacted text limit');
    const { groups, records } = this.#history(), group = groups.find(group => group.id === id);
    if (!group) throw Error('Select one source receipt');
    const source = records.find(record => record.manifest.eventId === group.textRecordId);
    const record = this.#vault.capture(Buffer.from(text, 'utf8'), { type: 'derivative', relationships: [{
      type: 'redacted_from', recordDigest: source.recordDigest, objectDigest: source.manifest.evidence[0].objectDigest,
    }] });
    this.#preview = null;
    return { id: record.manifest.eventId, derivative: true,
      claim: 'New signed bytes with an asserted redaction relationship; the original anchor and release assurance are not inherited.' };
  }
}
