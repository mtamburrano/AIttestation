import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifyBundle } from '../spikes/demonstrator/verification.mjs';
import { parseCanonical, canonical } from '../spikes/vault/format.mjs';

// Recorded synthetic disclosures and public TestNet proof only. No account,
// credential lookup, network request, or transaction submission is performed.
const root = new URL('../spikes/demonstrator/testdata/', import.meta.url);
const read = name => JSON.parse(readFileSync(new URL(name, root), 'utf8'));
const trust = read('independent-trust.json');
const original = read('evidence-export.json'), restored = read('restored-evidence-export.json');
for (const bundle of [original, restored]) {
  const report = verifyBundle(bundle, trust);
  assert.equal(report.valid, true); assert.equal(report.anchors.length, 3);
  assert.ok(report.anchors.every(a => a.anchor === 'CONSENSUS_VERIFIED' && a.timestamp === 'BLOCK_HASH_BOUND'));
  assert.equal(verifyBundle(bundle, null).valid, false);
  assert.equal(verifyBundle(bundle, { ...trust, genesis: 'wrong-network' }).valid, false);
  const tampered = structuredClone(bundle), envelope = parseCanonical(Buffer.from(tampered.anchors[0].envelope));
  envelope.batch.position = envelope.batch.position === '0' ? '1' : '0';
  tampered.anchors[0].envelope = canonical(envelope);
  assert.equal(verifyBundle(tampered, trust).valid, false);
}
const before = parseCanonical(Buffer.from(original.disclosure)).records;
const after = parseCanonical(Buffer.from(restored.disclosure)).records;
assert.equal(after.length, before.length + 1, 'restore includes the explicit snapshot export index');
assert.deepEqual(after.slice(0, before.length), before, 'all baseline records and signatures survived recovery');
console.log('PASS: three live TestNet mode commitments, standalone original/restored verification, exact recovery baseline, missing trust, wrong network and inclusion tampering.');
