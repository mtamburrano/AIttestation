import { randomBytes } from 'node:crypto';
import { canonical, parseCanonical, objectDigest, pack, keys, LIMITS } from '../vault/format.mjs';
import { publicProofDigest, verifyRecord } from '../vault/records.mjs';
import { PORTABLE_PROFILE, RECIPIENT_LIMITS, verifyPortable, signedObservation, linksCancellation, linksNormalMessage, CLAIMS } from './portable.mjs';

const wire = value => Buffer.from(canonical(value));

export function storePublicProof(vault, proof) {
  const bytes = wire(proof), digest = objectDigest(bytes);
  if (bytes.length > RECIPIENT_LIMITS.proof) throw Error('Public proof size limit');
  if (vault.hasObject(digest)) {
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
  #vault; #preview = null; #cachedHistory = null; #revision = null; #query = null;
  constructor(vault) { this.#vault = vault; }

  #history(options = {}) {
    const revision = this.#vault.revision;
    if (options.ids && (!Array.isArray(options.ids) || options.ids.length > RECIPIENT_LIMITS.records)) throw Error('Receipt selection limit');
    const query = JSON.stringify(options);
    if (revision !== undefined && revision === this.#revision && query === this.#query) return this.#cachedHistory;
    const page = options.ids ? { records: options.ids.map(id => this.#vault.getRecord(id)).filter(Boolean), next: null }
      : this.#vault.recordPage({ kind: 'prompt', limit: 100, ...options });
    const initial = [...page.records];
    if (!options.ids && !options.search && !options.attentionOnly) initial.push(...this.#vault.recordPage({ kind: 'derivative', limit: 5 }).records, ...this.#vault.recordPage({ kind: 'unassociated', limit: 5 }).records);
    const selected = new Map(initial.map(record => [record.manifest.eventId, record]));
    for (const record of initial) if (record.manifest.type === 'observation') {
      const bytes = this.#vault.read(record.manifest.evidence[0].objectDigest);
      const value = signedObservation(record, bytes, verifyRecord(record, bytes));
      if (!value) continue;
      const text = value.textRecord ? this.#vault.getRecord(value.textRecord) : null;
      if (text) selected.set(text.manifest.eventId, text);
      for (const related of this.#vault.lookupRecords('related', record.recordDigest)) selected.set(related.manifest.eventId, related);
    }
    const records = [...selected.values()].sort((a, b) => Number(a.manifest.sequence) - Number(b.manifest.sequence));
    const byId = new Map(records.map(record => [record.manifest.eventId, record]));
    const observations = records.filter(r => r.manifest.type === 'observation').map(record => {
      const bytes = this.#vault.read(record.manifest.evidence[0].objectDigest);
      return { record, value: signedObservation(record, bytes, verifyRecord(record, bytes)) };
    }).filter(entry => entry.value);
    const byDigest = new Map();
    for (const entry of observations) {
      const digest = entry.value.recordDigest;
      if (!byDigest.has(digest)) byDigest.set(digest, []);
      byDigest.get(digest).push(entry);
    }
    const groups = observations.filter(entry => entry.value.kind === 'frozen-text-version'
      || ['pap-chatgpt-observation/2', 'pap-chatgpt-observation/3', 'pap-chatgpt-observation/4', 'pap-chatgpt-observation/5', 'pap-chatgpt-observation/6'].includes(entry.value.profile)
        && ['normal-send-intent', 'normal-request-observed'].includes(entry.value.kind)).map(({ record, value }) => {
      const text = byId.get(value.textRecord);
      if (!text || text.manifest.evidence[0].objectDigest !== value.textObject) throw Error('Receipt text reference missing');
      const related = (byDigest.get(record.recordDigest) ?? []).filter(entry => entry.value.recordDigest === record.recordDigest
        && entry.record.manifest.signingPublicKey === record.manifest.signingPublicKey
        && (entry.value.kind !== 'release-cancelled' || linksCancellation(entry.record, entry.value, record, value))
        && (!['normal-message-observed', 'normal-acknowledgement'].includes(entry.value.kind) || linksNormalMessage(entry.record, entry.value, record, value)));
      return { id: record.manifest.eventId, title: `${value.mode} · ${record.manifest.localClaimedTime}`,
        prompt: { mode: value.mode, savedAt: record.manifest.localClaimedTime,
          scope: value.source?.scope ?? value.scope ?? null, destination: value.source?.destination ?? null,
          outcome: related.findLast(entry => entry.value.kind === 'release-outcome')?.value.state ?? null,
          cancelled: related.some(entry => entry.value.kind === 'release-cancelled'),
          anchor: related.some(entry => entry.value.kind === 'consensus-assurance-upgrade') ? 'PORTABLE_PROOF'
            : related.some(entry => entry.value.kind === 'fast-confirmation') ? 'SOURCE_CORROBORATED' : 'PENDING' },
        textRecordId: text.manifest.eventId, recordIds: [text.manifest.eventId, record.manifest.eventId,
          ...related.map(entry => entry.record.manifest.eventId)], related,
        recordDigest: record.recordDigest, derivative: false };
    });
    const grouped = new Set(groups.flatMap(group => group.recordIds));
    // Legacy version IDs cannot be inferred from prompt bytes, time, mode or record order.
    // Keep the original signed observation selectable without inventing a prompt link.
    for (const { record } of observations.filter(entry => entry.value.kind === 'release-cancelled'
        && !grouped.has(entry.record.manifest.eventId))) groups.push({
      id: record.manifest.eventId, title: `Unassociated cancellation · ${record.manifest.localClaimedTime}`,
      textRecordId: record.manifest.eventId, recordIds: [record.manifest.eventId], related: [],
      recordDigest: record.recordDigest, derivative: false, unassociatedCancellation: true,
    });
    for (const record of records.filter(r => r.manifest.type === 'derivative')) groups.push({
      id: record.manifest.eventId, title: `Redacted derivative · ${record.manifest.localClaimedTime}`,
      textRecordId: record.manifest.eventId, recordIds: [record.manifest.eventId], related: [],
      recordDigest: record.recordDigest, derivative: true,
    });
    this.#revision = revision; this.#query = query; this.#cachedHistory = { records, groups, next: page.next };
    return this.#cachedHistory;
  }

  list(options = {}) {
    return structuredClone(this.#history(options).groups.map(({ related: _related, ...group }) => group));
  }

  page(options = {}) {
    if (Object.keys(options).some(key => !['before', 'limit', 'attentionOnly', 'search', 'kind'].includes(key))) throw Error('Invalid receipt page');
    const history = this.#history({ limit: 5, ...options });
    return { receipts: structuredClone(history.groups.map(({ related: _related, ...group }) => group)),
      next: history.next, counts: this.#vault.historyCounts() };
  }

  prepare({ ids, includeEvidence = true }) {
    this.#preview = null;
    if (!Array.isArray(ids) || !ids.length || ids.length > RECIPIENT_LIMITS.records
        || new Set(ids).size !== ids.length || typeof includeEvidence !== 'boolean') throw Error('Select distinct receipts');
    const { groups } = this.#history({ ids });
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
          ...(group.unassociatedCancellation ? { unassociatedCancellation: true } : {}),
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
    const { groups, records } = this.#history({ ids: [id] }), group = groups.find(group => group.id === id);
    if (!group) throw Error('Select one source receipt');
    if (group.unassociatedCancellation) throw Error('Unassociated cancellation has no source prompt to redact');
    const source = records.find(record => record.manifest.eventId === group.textRecordId);
    const record = this.#vault.capture(Buffer.from(text, 'utf8'), { type: 'derivative', relationships: [{
      type: 'redacted_from', recordDigest: source.recordDigest, objectDigest: source.manifest.evidence[0].objectDigest,
    }] });
    this.#preview = null;
    return { id: record.manifest.eventId, derivative: true,
      claim: 'New signed bytes with an asserted redaction relationship; the original anchor and release assurance are not inherited.' };
  }
}
