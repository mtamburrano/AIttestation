import { canonical, parseCanonical, keys, fail, unpack, pack, unb64, LIMITS } from '../vault/format.mjs';
import { publicProofDigest, verifyDisclosure } from '../vault/records.mjs';
import { verifyAnchor } from '../anchor/verifier.mjs';
import { verifyInclusion } from '../anchor/merkle.mjs';

export const PORTABLE_PROFILE = 'pap-portable-evidence/1';
export const RECIPIENT_LIMITS = Object.freeze({ wire: 16 * 2 ** 20, total: 12 * 2 ** 20,
  records: 128, objects: 128, proofs: 8, anchors: 128, proof: 8 * 2 ** 20, trust: 64 * 1024 });
export const CLAIMS = 'Selected records only. Signatures authenticate key assertions, not authorship, event truth, provider receipt, complete history or latest state. Checkpoint authenticity is a separate recipient trust assumption.';
export const CANCELLATION_CLAIM = 'Cancellation is a signed local client assertion. It does not independently establish provider non-egress, authorship, event truth or anchor assurance.';

// Older exports were ordinary JSON. Preserve them while rejecting duplicate names
// and excessive nesting before JSON.parse, including escaped duplicate names.
export function parseBoundedJSON(input, maximum = RECIPIENT_LIMITS.wire) {
  if (Buffer.byteLength(input) > maximum) fail('LIMIT_EXCEEDED', 'Input size');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(input)); }
  catch { fail('INVALID', 'UTF-8'); }
  const stack = []; let start = -1, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (start >= 0) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') {
        const frame = stack.at(-1);
        if (frame?.key) {
          let name; try { name = JSON.parse(text.slice(start, i + 1)); } catch { fail('INVALID', 'JSON key'); }
          if (frame.names.has(name)) fail('INVALID', 'Duplicate JSON name');
          frame.names.add(name); frame.key = false;
        }
        start = -1;
      }
    } else if (c === '"') start = i;
    else if (c === '{' || c === '[') {
      if (stack.length >= LIMITS.depth) fail('LIMIT_EXCEEDED', 'JSON depth');
      stack.push(c === '{' ? { key: true, names: new Set() } : {});
    } else if (c === '}' || c === ']') stack.pop();
    else if (c === ',' && stack.at(-1)?.names) stack.at(-1).key = true;
  }
  try { return JSON.parse(text); } catch { fail('INVALID', 'JSON syntax'); }
}

export function shareAnchors(envelopes) {
  const objects = new Map();
  const anchors = envelopes.map(envelope => {
    keys(envelope, ['profile', 'recordDigest', 'batch', 'adapter', 'proof']);
    const bytes = Buffer.from(canonical(envelope.proof)), proofDigest = publicProofDigest(bytes);
    if (!objects.has(proofDigest)) objects.set(proofDigest, { digest: proofDigest, bytes: pack(bytes) });
    const { proof: _proof, ...reference } = envelope;
    return { ...reference, proofDigest };
  });
  return { anchors, publicProofObjects: [...objects.values()] };
}

export function portableBundle(disclosure, envelopes = []) {
  return { profile: PORTABLE_PROFILE, disclosure, ...shareAnchors(envelopes) };
}

function normalize(bundle) {
  if (bundle?.profile === PORTABLE_PROFILE) {
    keys(bundle, ['profile', 'disclosure', 'anchors', 'publicProofObjects']);
    return bundle;
  }
  if (['pap-disclosure-spike/1', 'pap-disclosure-spike/2'].includes(bundle?.profile)) return portableBundle(bundle);
  if (typeof bundle?.disclosure !== 'string' || !Array.isArray(bundle.anchors)
      || (bundle.profile !== undefined && bundle.profile !== 'pap-demo-export/2')) fail('UNSUPPORTED', 'Export profile');
  // Legacy exporter-supplied trust/report/claims are never verification inputs.
  const disclosure = parseCanonical(Buffer.from(bundle.disclosure));
  if (bundle.anchors.length > RECIPIENT_LIMITS.anchors) fail('LIMIT_EXCEEDED', 'Anchor count');
  const records = new Map(disclosure.records.map(r => [r.manifest?.eventId, r.recordDigest]));
  const envelopes = bundle.anchors.map(a => {
    keys(a, ['descriptorId', 'envelope']);
    const envelope = parseCanonical(Buffer.from(a.envelope), RECIPIENT_LIMITS.proof);
    if (!records.has(a.descriptorId) || records.get(a.descriptorId) !== envelope.recordDigest) fail('INVALID', 'Legacy descriptor mismatch');
    return envelope;
  });
  return bundle.profile === 'pap-demo-export/2'
    ? { profile: PORTABLE_PROFILE, disclosure, anchors: envelopes, publicProofObjects: bundle.publicProofObjects }
    : portableBundle(disclosure, envelopes);
}

export function signedObservation(record, bytes, checked) {
  if (record.manifest?.profile !== 'pap-local-record/1' || record.manifest.type !== 'observation'
      || checked.structure !== 'VALID' || checked.integrity !== 'VALID' || checked.keyAttribution !== 'SIGNATURE_VALID' || !bytes) return null;
  try {
    const value = parseCanonical(bytes, LIMITS.manifest);
    return value.profile === 'pap-chatgpt-observation/1' ? value : null;
  } catch { return null; }
}

export function linksCancellation(record, observation, targetRecord, targetObservation) {
  return observation?.kind === 'release-cancelled'
    && typeof observation.version === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(observation.version)
    && ['Sealed', 'Always Protect'].includes(observation.mode)
    && targetObservation?.kind === 'frozen-text-version' && targetObservation.mode === observation.mode
    && observation.recordDigest === targetRecord?.recordDigest
    && record.manifest.signingPublicKey === targetRecord?.manifest.signingPublicKey;
}

export function verifyPortable(input, trust = null, { algorandVerifierPath } = {}) {
  const original = parseBoundedJSON(input), bundle = normalize(original);
  if (original.profile === PORTABLE_PROFILE && canonical(original) !== Buffer.from(input).toString('utf8')) fail('INVALID', 'Non-canonical export');
  if (trust !== null && Buffer.byteLength(canonical(trust)) > RECIPIENT_LIMITS.trust) fail('LIMIT_EXCEEDED', 'Trust input');
  const disclosure = bundle.disclosure;
  if (!Array.isArray(disclosure?.records) || disclosure.records.length > RECIPIENT_LIMITS.records
      || !Array.isArray(disclosure.objects) || disclosure.objects.length > RECIPIENT_LIMITS.objects
      || !Array.isArray(bundle.anchors) || bundle.anchors.length > RECIPIENT_LIMITS.anchors
      || !Array.isArray(bundle.publicProofObjects) || bundle.publicProofObjects.length > RECIPIENT_LIMITS.proofs) fail('LIMIT_EXCEEDED', 'Export counts');
  const seenRecords = new Set(), eventIds = new Set(), referencedObjects = new Set();
  for (const record of disclosure.records) {
    if (!record || seenRecords.has(record.recordDigest) || (record.manifest && eventIds.has(record.manifest.eventId))) fail('INVALID', 'Duplicate record');
    seenRecords.add(record.recordDigest); if (record.manifest) eventIds.add(record.manifest.eventId);
    for (const ref of record.manifest?.evidence ?? []) referencedObjects.add(ref.objectDigest);
  }
  const objects = new Map(), proofs = new Map(); let total = 0;
  for (const object of disclosure.objects) {
    if (!referencedObjects.has(object.digest)) fail('INVALID', 'Unselected evidence object');
    const bytes = unpack(object.bytes, RECIPIENT_LIMITS.total); total += bytes.length;
    if (total > RECIPIENT_LIMITS.total) fail('LIMIT_EXCEEDED', 'Decoded bytes');
    objects.set(object.digest, bytes);
  }
  // Legacy generic proof objects have no typed anchor envelope. Validate their
  // integrity but never infer anchor assurance from their mere presence.
  for (const object of disclosure.publicProofObjects ?? []) {
    total += unpack(object.bytes, RECIPIENT_LIMITS.proof).length;
    if (total > RECIPIENT_LIMITS.total) fail('LIMIT_EXCEEDED', 'Decoded bytes');
  }
  for (const object of bundle.publicProofObjects) {
    keys(object, ['digest', 'bytes']); unb64(object.digest, 32);
    if (proofs.has(object.digest)) fail('INVALID', 'Duplicate public proof object');
    const bytes = unpack(object.bytes, RECIPIENT_LIMITS.proof); total += bytes.length;
    if (total > RECIPIENT_LIMITS.total) fail('LIMIT_EXCEEDED', 'Decoded bytes');
    if (publicProofDigest(bytes) !== object.digest) fail('INVALID', 'Public proof object mismatch');
    proofs.set(object.digest, parseCanonical(bytes, RECIPIENT_LIMITS.proof));
  }
  const checked = verifyDisclosure(Buffer.from(canonical(disclosure)));
  const records = disclosure.records.map((record, index) => ({
    recordDigest: record.recordDigest, eventId: record.manifest?.eventId ?? null,
    ...checked.records[index], anchor: 'INDETERMINATE',
    evidenceAvailability: checked.records[index].evidence === 'COMPLETE' ? 'SELECTIVE' : 'MISSING',
    releaseControl: record.manifest?.type === 'observation' ? 'UNKNOWN' : 'NOT_APPLICABLE',
    derivative: record.manifest?.type === 'derivative' ? record.manifest.relationships : null,
    anchorResults: [], localAssertions: [],
  }));
  const byDigest = new Map(records.map(r => [r.recordDigest, r]));
  const usedProofs = new Set(), references = new Set(), cache = new Map();
  for (const reference of bundle.anchors) {
    keys(reference, ['profile', 'recordDigest', 'batch', 'adapter', 'proofDigest']); unb64(reference.proofDigest, 32);
    const target = byDigest.get(reference.recordDigest), identity = canonical(reference);
    if (!target || references.has(identity)) fail('INVALID', 'Unselected or duplicate anchor reference');
    references.add(identity); usedProofs.add(reference.proofDigest);
    let result;
    if (target.structure !== 'VALID' || target.integrity === 'INVALID' || target.keyAttribution !== 'SIGNATURE_VALID') {
      result = { anchor: 'INDETERMINATE', timestamp: 'INDETERMINATE', reason: 'Record assertion unavailable or invalid' };
    } else {
      try {
        if (!verifyInclusion(reference.recordDigest, reference.batch)) fail('INVALID', 'Record inclusion mismatch');
      } catch (error) {
        result = { anchor: error.code === 'UNSUPPORTED' ? 'UNSUPPORTED' : 'INVALID', timestamp: 'INDETERMINATE', reason: error.message };
      }
      if (!result && !proofs.has(reference.proofDigest)) result = { anchor: 'INDETERMINATE', timestamp: 'INDETERMINATE', reason: 'Shared proof missing' };
      if (result) { target.anchorResults.push({ proofDigest: reference.proofDigest, ...result }); continue; }
      const cacheId = canonical({ profile: reference.profile, root: reference.batch.root,
        adapter: reference.adapter, proofDigest: reference.proofDigest });
      if (!cache.has(cacheId)) {
        if (cache.size >= RECIPIENT_LIMITS.proofs) fail('LIMIT_EXCEEDED', 'Distinct anchor verifications');
        const { proofDigest: _digest, ...envelope } = reference;
        cache.set(cacheId, verifyAnchor(Buffer.from(canonical({ ...envelope, proof: proofs.get(reference.proofDigest) })),
          trust, reference.recordDigest, { algorandVerifierPath, timeoutMs: 5000 }));
      }
      result = cache.get(cacheId);
    }
    target.anchorResults.push({ proofDigest: reference.proofDigest, ...result });
  }
  for (const digest of proofs.keys()) if (!usedProofs.has(digest)) fail('INVALID', 'Unreferenced public proof object');
  for (const result of records) {
    if (result.anchorResults.length === 1) {
      result.anchor = result.anchorResults[0].anchor; result.timestamp = result.anchorResults[0].timestamp;
    } else if (result.anchorResults.length > 1) {
      const anchors = new Set(result.anchorResults.map(r => r.anchor)), timestamps = new Set(result.anchorResults.map(r => r.timestamp));
      result.anchor = anchors.size === 1 ? [...anchors][0] : 'INDETERMINATE';
      result.timestamp = timestamps.size === 1 ? [...timestamps][0] : 'INDETERMINATE';
    }
  }
  const observations = new Map(disclosure.records.map((record, index) => [record.recordDigest,
    signedObservation(record, objects.get(record.manifest?.evidence?.[0]?.objectDigest), checked.records[index])]));
  const sourceRecords = new Map(disclosure.records.map(record => [record.recordDigest, record]));
  disclosure.records.forEach((record, index) => {
    const observation = observations.get(record.recordDigest);
    const target = byDigest.get(observation?.recordDigest);
    if (observation?.kind === 'release-cancelled') {
      const linked = linksCancellation(record, observation, sourceRecords.get(observation.recordDigest), observations.get(observation.recordDigest));
      (linked ? target : records[index]).localAssertions.push({ kind: 'release-cancelled', state: 'CANCELLED',
        association: linked ? 'SIGNED_RECORD_DIGEST' : 'UNASSOCIATED', assurance: 'CLIENT_ASSERTION_ONLY',
        providerNonEgress: 'NOT_PROVEN', claim: CANCELLATION_CLAIM });
      return;
    }
    if (!target || record.manifest.signingPublicKey !== sourceRecords.get(target.recordDigest)?.manifest?.signingPublicKey) return;
    if (observation.kind === 'fast-confirmation' || observation.kind === 'consensus-assurance-upgrade') {
      target.localAssertions.push({ kind: observation.kind, anchor: observation.report?.anchor ?? 'UNKNOWN',
        timestamp: observation.report?.timestamp ?? 'UNKNOWN', assurance: 'CLIENT_ASSERTION_ONLY' });
    }
    if (observation.kind === 'release-outcome') {
      const releaseControl = observation.mode === 'Continuous' && observation.releaseClass === 'RETROSPECTIVE_CONTINUOUS'
        ? 'OBSERVED_ONLY' : ['Sealed', 'Always Protect'].includes(observation.mode)
          && observation.releaseClass === 'PRE_DISCLOSURE_PROTECTED' && observation.state === 'SUBMISSION_OBSERVED'
          ? 'CLIENT_ENFORCED_ASSERTION' : 'UNKNOWN';
      target.localAssertions.push({ kind: 'release-outcome', releaseControl, state: observation.state,
        authorizationAnchor: observation.confirmation?.result ?? null, assurance: 'CLIENT_ASSERTION_ONLY' });
      // Multiple selected attempts may disagree. An omitted attempt never proves completeness.
      const releases = target.localAssertions.filter(a => a.kind === 'release-outcome');
      target.releaseControl = new Set(releases.map(a => a.releaseControl)).size === 1 ? releaseControl : 'UNKNOWN';
    }
  });
  for (const record of records) {
    if (record.localAssertions.some(assertion => assertion.kind === 'release-cancelled')) record.releaseControl = 'UNKNOWN';
  }
  return { profile: 'pap-recipient-report/1', scope: 'SELECTIVE', records,
    publicProofs: { objects: proofs.size, references: references.size, verifications: cache.size },
    claims: CLAIMS, trust: trust === null ? 'NOT_SELECTED' : 'SEPARATELY_SELECTED' };
}
