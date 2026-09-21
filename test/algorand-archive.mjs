import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseCanonical, canonical } from '../spikes/vault/format.mjs';
import { verifyDisclosure } from '../spikes/vault/records.mjs';
import { verifyAnchor, verifyAnchorAsync } from '../spikes/anchor/verifier.mjs';
import { FAST_CONFIRM_PROFILE, collectFastEvidence, verifyFastConfirmation, verifyFastConfirmationAsync } from '../spikes/anchor/algorand/fast-confirm.mjs';

const root = new URL('../spikes/anchor/algorand/proof/testdata/', import.meta.url);
const bundle = readFileSync(new URL('anchor-envelope.json', root));
const envelope = parseCanonical(bundle);
const checkpoint = JSON.parse(readFileSync(new URL('independent-checkpoint.json', root)));
const trust = { profile: checkpoint.profile, network: checkpoint.network, genesis: checkpoint.genesis, checkpoint };
const disclosureBytes = readFileSync(new URL('disclosure.json', root));
const disclosure = verifyDisclosure(disclosureBytes);
assert.equal(disclosure.records[0].integrity, 'VALID');
assert.equal(disclosure.records[0].keyAttribution, 'SIGNATURE_VALID');
const expectedDigest = parseCanonical(disclosureBytes).records[0].recordDigest;
assert.equal(envelope.recordDigest, expectedDigest);
const r = verifyAnchor(bundle, trust, expectedDigest);
assert.deepEqual(await verifyAnchorAsync(bundle, trust, expectedDigest), r);
assert.equal(r.anchor, 'CONSENSUS_VERIFIED', r.reason);
assert.equal(r.timestamp, 'BLOCK_HASH_BOUND', r.reason);
assert.equal(r.independentlyVerified, true);
assert.equal(verifyAnchor(bundle, null, envelope.recordDigest).independentlyVerified, false);
const forged = structuredClone(envelope); forged.proof.rpcConfirmed = true;
assert.equal(verifyAnchor(Buffer.from(canonical(forged)), trust, envelope.recordDigest).independentlyVerified, false);
assert.equal((await verifyAnchorAsync(Buffer.from(canonical(forged)), trust, envelope.recordDigest)).independentlyVerified, false);
assert.equal(verifyAnchor(bundle, { ...trust, genesis: 'wrong' }, envelope.recordDigest).independentlyVerified, false);
assert.equal(verifyAnchor(bundle, trust, envelope.recordDigest, { algorandVerifierPath: '/nonexistent/provenance-test-verifier' }).anchor, 'UNSUPPORTED');
const archive = JSON.parse(readFileSync(new URL('testnet-archive.json', root)));
const expectedPayload = Buffer.from(JSON.parse(readFileSync(new URL('expected-payload.json', root))), 'base64');
const blockHeaderHash = createHash('sha512-256').update('BH').update(Buffer.from(archive.fullHeader, 'base64')).digest('base64');
const operators = [
  { id: 'operator-a', organization: 'Independent A', endpoint: 'https://algod-a.example' },
  { id: 'operator-b', organization: 'Independent B', endpoint: 'https://algod-b.example' },
];
const evidence = {
  profile: FAST_CONFIRM_PROFILE, network: archive.network, genesis: archive.genesis, consensus: archive.consensus,
  transactionId: archive.transactionId, transaction: archive.transaction, signedTxnInBlock: archive.signedTxnInBlock,
  fullHeader: archive.fullHeader, transactionProof: archive.transactionProof, observedWaitMillis: 3210,
  sources: operators.map((operator, index) => ({ operatorId: operator.id, organization: operator.organization,
    endpoint: operator.endpoint, transactionId: archive.transactionId, confirmedRound: archive.round,
    blockHeaderHash, sourceClaimedTime: `2026-09-10T12:00:0${index}Z`, poolError: '', error: '', expired: false })),
};
const fastTrust = { profile: FAST_CONFIRM_PROFILE, network: archive.network, genesis: archive.genesis,
  applicationServiceOrigin: 'https://anchor.provenance.example', operators };
const fast = verifyFastConfirmation(evidence, fastTrust, expectedPayload);
assert.deepEqual(await verifyFastConfirmationAsync(evidence, fastTrust, expectedPayload), fast);
assert.equal(fast.anchor, 'SOURCE_CORROBORATED'); assert.equal(fast.timestamp, 'SOURCE_REPORTED');
assert.equal(fast.authorized, true); assert.equal(fast.round, archive.round);
const conflict = structuredClone(evidence); conflict.sources[1].confirmedRound++;
assert.throws(() => verifyFastConfirmation(conflict, fastTrust, expectedPayload), /not authorized/);
const observations = { 'operator-a': 0, 'operator-b': 0 };
const collected = await collectFastEvidence({ trust: fastTrust, transactionId: archive.transactionId, waitMs: 1500,
  observe: async operator => {
    if (observations[operator.id]++ === 0) throw Object.assign(Error('isolated pending fixture'), { code: 'ALGOD_NOT_YET_CONFIRMED' });
    return { ...evidence, ...evidence.sources[operators.findIndex(value => value.id === operator.id)] };
  } });
assert.equal(verifyFastConfirmation(collected, fastTrust, expectedPayload).authorized, true);
assert.deepEqual(observations, { 'operator-a': 2, 'operator-b': 2 });
const wrongPayload = Buffer.from(expectedPayload); wrongPayload[4] ^= 1;
assert.throws(() => verifyFastConfirmation(collected, fastTrust, wrongPayload), /not authorized/);
await assert.rejects(verifyFastConfirmationAsync(collected, fastTrust, wrongPayload), /not authorized/);
const badSignature = structuredClone(collected);
const signedBytes = Buffer.from(badSignature.signedTxnInBlock, 'base64'); signedBytes[15] ^= 1;
badSignature.signedTxnInBlock = signedBytes.toString('base64');
assert.throws(() => verifyFastConfirmation(badSignature, fastTrust, expectedPayload), /not authorized/);
await assert.rejects(verifyFastConfirmationAsync(badSignature, fastTrust, expectedPayload), /not authorized/);
console.log(`PASS: fast two-operator inclusion at round ${fast.round}, then archived State-Proof upgrade; forged, conflicting, or missing roots fail closed.`);
