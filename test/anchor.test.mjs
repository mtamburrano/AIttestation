import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { canonical, parseCanonical, b64, hash, unb64 } from '../spikes/vault/format.mjs';
import { identity, makeRecord } from '../spikes/vault/records.mjs';
import { merkleRoot, inclusion, verifyInclusion, anchorPayload } from '../spikes/anchor/merkle.mjs';
import { signedLogFixture, measurement } from '../spikes/anchor/fixture.mjs';
import { verifyAnchor, ALGORAND_CONSENSUS_ALLOWLIST } from '../spikes/anchor/verifier.mjs';

const encoded = v => Buffer.from(canonical(v));
function fixture() {
  const log = identity(), producer = identity();
  const records = Array.from({ length: 3 }, (_, i) => makeRecord(Buffer.from(`synthetic private prompt ${i}`), producer, i + 1, null));
  const digests = records.map(r => r.recordDigest), expected = digests[1];
  const trust = { profile: 'pap-signed-log-fixture/1', network: 'synthetic-log', genesis: 'test-only-genesis',
    checkpoint: { publicKey: log.publicKey.export({ format: 'jwk' }).x, minimumSequence: '1' } };
  return { records, expected, trust, bundle: signedLogFixture(digests, 1, log) };
}
test('Merkle roots match independently computed Python hashlib fixtures', () => {
  const roots = {
    0: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    1: '7f9c9e31ac8256ca2f258583df262dbc7d6f68f2a03043d5c99a4ae5a7396ce9',
    2: '28fb81e496897e0ce886f08602392e9239b65c659041e5202163e58ad898f444',
    3: 'ba8d94b7fbcecae7b81c4c80574fe24734a6917bf9c1ecd66ff3e0c34ead4620',
    5: '85e20cac1f02fda7bcdb2fc3f908568c57018c77815f1fa361acad13994f08bf',
    8: 'f907f23f76aa01b755a614d31ef9832909f44638b4590073301e61e6d01f9a1d',
  };
  for (const [n, root] of Object.entries(roots)) assert.equal(merkleRoot(Array.from({ length: Number(n) }, (_, i) => Buffer.alloc(32, i))).toString('hex'), root);
});
test('inclusion shape, position, extra/truncated proof and altered leaves fail across tree boundaries', () => {
  for (const n of [1, 2, 3, 5, 7, 8, 9, 31, 32, 33, 511, 512]) {
    const entries = Array.from({ length: n }, (_, i) => hash(String(i)));
    for (const pos of [...new Set([0, Math.floor(n / 2), n - 1])]) {
      const proof = inclusion(entries, pos);
      assert.equal(verifyInclusion(b64(entries[pos]), proof), true);
      assert.equal(verifyInclusion(b64(randomBytes(32)), proof), false);
      const extra = { ...proof, path: [...proof.path, b64(randomBytes(32))] };
      try { assert.equal(verifyInclusion(b64(entries[pos]), extra), false); } catch (e) { assert.equal(e.code, 'INVALID'); }
      if (proof.path.length) assert.throws(() => verifyInclusion(b64(entries[pos]), { ...proof, path: proof.path.slice(1) }), { code: 'INVALID' });
      if (n > 1) {
        // Uneven trees can change required path depth as well as the reconstructed hash.
        let rejected;
        try { rejected = !verifyInclusion(b64(entries[pos]), { ...proof, position: String((pos + 1) % n) }); }
        catch (e) { assert.equal(e.code, 'INVALID'); rejected = true; }
        assert.equal(rejected, true);
      }
    }
  }
});
test('only 36 blinded bytes leave core; non-Algorand adapter uses unchanged record/envelope schema', () => {
  const f = fixture(), bundle = parseCanonical(f.bundle);
  const payload = anchorPayload(unb64(bundle.batch.root, 32));
  assert.equal(payload.length, 36); assert.equal(payload.subarray(0, 4).toString('hex'), '50415001');
  for (const r of f.records) {
    assert.equal(payload.includes(unb64(r.manifest.evidence[0].objectDigest, 32)), false);
    assert.equal(payload.includes(unb64(r.opening, 32)), false);
  }
  const report = verifyAnchor(f.bundle, f.trust, f.expected);
  assert.equal(report.independentlyVerified, true); assert.equal(report.anchor, 'FIXTURE_VERIFIED');
  assert.equal(report.timestamp, 'SOURCE_REPORTED'); assert.equal(report.assurance, 'TEST_LOG_KEY_SIGNATURE');
});
test('independent network, checkpoint, key, expected record and bundle-embedded authority attacks', () => {
  const f = fixture(); assert.equal(verifyAnchor(f.bundle, f.trust, f.expected).independentlyVerified, true);
  assert.equal(verifyAnchor(f.bundle, null, f.expected).anchor, 'INDETERMINATE');
  assert.equal(verifyAnchor(f.bundle, { ...f.trust, checkpoint: null }, f.expected).anchor, 'INDETERMINATE');
  for (const trust of [{ ...f.trust, network: 'other' }, { ...f.trust, genesis: 'other' },
    { ...f.trust, checkpoint: { ...f.trust.checkpoint, minimumSequence: '2' } },
    { ...f.trust, checkpoint: { ...f.trust.checkpoint, publicKey: identity().publicKey.export({ format: 'jwk' }).x } }]) {
    assert.equal(verifyAnchor(f.bundle, trust, f.expected).anchor, 'INVALID');
  }
  assert.equal(verifyAnchor(f.bundle, f.trust, b64(randomBytes(32))).independentlyVerified, false);
  for (const mutate of [ p => { p.trustRoot = f.trust; }, p => { p.proof.entry.sourceClaimedTime = 'altered'; },
    p => { p.proof.entry.payload = b64(randomBytes(36)); }, p => { p.batch.root = b64(randomBytes(32)); },
    p => { p.adapter.profile = 'unrecognized'; }, p => { p.proof.signature = b64(randomBytes(64)); } ]) {
    const p = parseCanonical(f.bundle); mutate(p); assert.equal(verifyAnchor(encoded(p), f.trust, f.expected).independentlyVerified, false);
  }
});
test('fake Algorand RPC success, arbitrary inclusion, missing roots and unsupported profiles cannot pass', () => {
  const f = fixture(), bundle = parseCanonical(f.bundle);
  bundle.adapter = { profile: 'pap-algorand-sp/1', network: 'unconfigured-testnet', genesis: b64(randomBytes(32)) };
  bundle.proof = { rpcConfirmed: true, consensusVerified: true, blockHashBound: true, round: '42',
    transactionLeaf: b64(randomBytes(32)), stateProof: 'fabricated' };
  const trust = { ...bundle.adapter, checkpoint: { arbitraryBundleRoot: true } };
  assert.equal(ALGORAND_CONSENSUS_ALLOWLIST.length, 1);
  const report = verifyAnchor(encoded(bundle), trust, f.expected);
  assert.ok(['UNSUPPORTED', 'INVALID'].includes(report.anchor)); assert.equal(report.independentlyVerified, false);
  assert.equal(report.timestamp, 'INDETERMINATE');
  assert.equal(verifyAnchor(encoded(bundle), null, f.expected).anchor, 'INDETERMINATE');
  assert.equal(verifyAnchor(encoded(bundle), { ...trust, network: 'wrong' }, f.expected).anchor, 'INVALID');
});
test('separate verifier process verifies exported fixture with all network APIs blocked', t => {
  const root = mkdtempSync(join(tmpdir(), 'provenance-anchor-test-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = fixture();
  const bundle = join(root, 'bundle.json'), trust = join(root, 'independent-trust.json'), guard = join(root, 'deny-network.mjs');
  writeFileSync(bundle, f.bundle); writeFileSync(trust, encoded(f.trust));
  writeFileSync(guard, `import net from 'node:net'; import tls from 'node:tls'; import http from 'node:http'; import https from 'node:https'; import dns from 'node:dns'; import {syncBuiltinESMExports} from 'node:module'; const deny=()=>{throw Error('NETWORK_FORBIDDEN')}; globalThis.fetch=deny; globalThis.WebSocket=deny; net.connect=net.createConnection=deny; net.Socket.prototype.connect=deny; tls.connect=deny; http.request=http.get=https.request=https.get=deny; dns.lookup=dns.resolve=deny; syncBuiltinESMExports();`);
  const result = spawnSync(process.execPath, ['--import', guard, 'spikes/anchor/verify.mjs', bundle, trust, f.expected], { env: {}, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).anchor, 'FIXTURE_VERIFIED');
});
test('measurement recorder separates pending archival evidence from confirmation and labels simulations', () => {
  assert.deepEqual(measurement({ source: 'SYNTHETIC', submittedMs: 0, confirmedMs: 2000, archivedMs: 15000, bundleBytes: 1024, feeMicroAlgos: '1000' }), {
    source: 'SYNTHETIC', confirmationLatencyMs: 2000, archivalLagAfterConfirmationMs: 13000, bundleBytes: 1024, feeMicroAlgos: '1000', status: 'ARCHIVED' });
  assert.equal(measurement({ source: 'SYNTHETIC', submittedMs: 0, confirmedMs: 5 }).status, 'PENDING_ARCHIVE');
  assert.equal(measurement({ source: 'SYNTHETIC', submittedMs: 0 }).confirmationLatencyMs, null);
  assert.throws(() => measurement({ source: 'SYNTHETIC', submittedMs: 5, confirmedMs: 10, archivedMs: 9 }));
});
