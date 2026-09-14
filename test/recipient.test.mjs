import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Vault, restoreRecovery } from '../spikes/vault/vault.mjs';
import { identity, disclosureObject } from '../spikes/vault/records.mjs';
import { canonical, parseCanonical, unpack } from '../spikes/vault/format.mjs';
import { signedLogFixture } from '../spikes/anchor/fixture.mjs';
import { LocalReceipts, storeAnchor } from '../spikes/recipient/local.mjs';
import { portableBundle, verifyPortable, parseBoundedJSON, RECIPIENT_LIMITS } from '../spikes/recipient/portable.mjs';
import { startRecipient, verifyIsolated } from '../spikes/recipient/server.mjs';

const wire = value => Buffer.from(canonical(value));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'provenance-recipient-test-'));
  const vault = new Vault(join(root, 'vault'), randomBytes(32), undefined, { create: true });
  const opened = [vault]; t.after(() => { opened.forEach(v => v.close()); rmSync(root, { recursive: true, force: true }); });
  const event = value => vault.capture(wire({ profile: 'pap-chatgpt-observation/1', ...value }), { type: 'observation' });
  const texts = ['first public snippet', 'second PRIVATE OMITTED', '<script>fetch("https://never.example")</script>'];
  const groups = texts.map(text => {
    const input = vault.capture(Buffer.from(text));
    const record = event({ kind: 'frozen-text-version', mode: 'Sealed', textRecord: input.manifest.eventId,
      textObject: input.manifest.evidence[0].objectDigest });
    return { input, record };
  });
  const log = identity(), digests = groups.map(g => g.record.recordDigest);
  const trust = { profile: 'pap-signed-log-fixture/1', network: 'synthetic-log', genesis: 'test-only-genesis',
    checkpoint: { publicKey: log.publicKey.export({ format: 'jwk' }).x, minimumSequence: '1' } };
  const envelopes = groups.map((group, i) => parseCanonical(signedLogFixture(digests, i, log)));
  for (let i = 0; i < groups.length; i++) {
    const recordDigest = groups[i].record.recordDigest;
    event({ kind: 'release-outcome', recordDigest, mode: 'Sealed', state: 'SUBMISSION_OBSERVED',
      releaseClass: 'PRE_DISCLOSURE_PROTECTED', confirmation: { result: 'SOURCE_CORROBORATED' } });
    event({ kind: 'consensus-assurance-upgrade', recordDigest, report: { anchor: 'FIXTURE_VERIFIED', timestamp: 'SOURCE_REPORTED' },
      ...storeAnchor(vault, envelopes[i]) });
  }
  return { root, vault, opened, groups, envelopes, trust, event, receipts: new LocalReceipts(vault) };
}

test('selective preview shares stored/exported proofs and cannot broaden after later capture', t => {
  const { vault, groups, envelopes, receipts, trust } = fixture(t);
  assert.equal(vault.inspect().records.filter(r => r.manifest.type === 'public-proof').length, 1);
  const ids = [groups[0].record.manifest.eventId, groups[2].record.manifest.eventId];
  const preview = receipts.prepare({ ids }), baseline = receipts.export(preview.previewId);
  assert.equal(preview.publicProofObjects, 1); assert.equal(preview.anchorReferences, 2);
  vault.capture(Buffer.from('captured AFTER preview'));
  assert.deepEqual(receipts.export(preview.previewId), baseline);
  const bundle = parseCanonical(baseline);
  assert.deepEqual(bundle.publicProofObjects.map(object => parseCanonical(unpack(object.bytes))), [envelopes[0].proof]);
  assert.equal(bundle.disclosure.records.some(r => r.recordDigest === groups[1].record.recordDigest), false);
  assert.equal(bundle.disclosure.objects.some(o => unpack(o.bytes).includes('PRIVATE OMITTED')), false);
  assert.equal(bundle.disclosure.objects.some(o => unpack(o.bytes).includes('AFTER preview')), false);
  const report = verifyPortable(baseline, trust);
  assert.equal(report.publicProofs.verifications, 1, 'one shared proof is checked once after individual membership checks');
  const target = report.records.find(r => r.recordDigest === groups[0].record.recordDigest);
  assert.equal(target.anchor, 'FIXTURE_VERIFIED'); assert.equal(target.timestamp, 'SOURCE_REPORTED');
  assert.equal(target.releaseControl, 'CLIENT_ENFORCED_ASSERTION'); assert.equal(target.evidenceAvailability, 'SELECTIVE');
  const omitted = receipts.prepare({ ids, includeEvidence: false });
  const noBytes = verifyPortable(receipts.export(omitted.previewId), trust).records.find(r => r.recordDigest === target.recordDigest);
  assert.equal(noBytes.integrity, 'INCOMPLETE'); assert.equal(noBytes.evidenceAvailability, 'MISSING');
  assert.equal(noBytes.keyAttribution, 'SIGNATURE_VALID'); assert.equal(noBytes.anchor, 'FIXTURE_VERIFIED');
  assert.equal(noBytes.releaseControl, 'UNKNOWN');
  assert.throws(() => receipts.export(preview.previewId), /Preview/);
});

test('redaction is an explicit signed derivative with no source disclosure or inherited assurance, including after recovery', t => {
  const { root, vault, groups, receipts, opened } = fixture(t);
  const source = groups[1].input;
  const derivative = receipts.redact({ id: groups[1].record.manifest.eventId, text: 'second [REDACTED]' });
  const preview = receipts.prepare({ ids: [derivative.id] }), bundle = parseCanonical(receipts.export(preview.previewId));
  assert.equal(bundle.disclosure.records.length, 1); assert.equal(bundle.disclosure.objects.length, 1);
  assert.equal(bundle.anchors.length, 0); assert.equal(bundle.publicProofObjects.length, 0);
  const record = bundle.disclosure.records[0];
  assert.deepEqual(record.manifest.relationships, [{ type: 'redacted_from', recordDigest: source.recordDigest,
    objectDigest: source.manifest.evidence[0].objectDigest }]);
  assert.equal(vault.read(source.manifest.evidence[0].objectDigest).toString(), 'second PRIVATE OMITTED');
  const report = verifyPortable(wire(bundle)).records[0];
  assert.equal(report.integrity, 'VALID'); assert.equal(report.anchor, 'INDETERMINATE');
  assert.equal(report.releaseControl, 'NOT_APPLICABLE'); assert.equal(report.derivative.length, 1);
  const before = receipts.list(), backup = vault.exportRecovery();
  const restored = restoreRecovery(backup.package, backup.recoveryKey, join(root, 'clean-recovery'), randomBytes(32)); opened.push(restored);
  const history = new LocalReceipts(restored); assert.deepEqual(history.list(), before);
  const recoveredPreview = history.prepare({ ids: [groups[0].record.manifest.eventId, groups[2].record.manifest.eventId] });
  const recoveredBundle = parseCanonical(history.export(recoveredPreview.previewId));
  assert.equal(recoveredBundle.publicProofObjects.length, 1); assert.equal(recoveredBundle.anchors.length, 2);
});

test('ordinary captured JSON cannot create release authority and each assurance dimension fails independently', t => {
  const { vault, groups, receipts, trust, event } = fixture(t);
  const forged = vault.capture(wire({ profile: 'pap-chatgpt-observation/1', kind: 'release-outcome',
    recordDigest: groups[0].record.recordDigest, mode: 'Sealed', state: 'SUBMISSION_OBSERVED', releaseClass: 'PRE_DISCLOSURE_PROTECTED' }));
  const disclosure = parseCanonical(vault.exportDisclosure([groups[0].record.manifest.eventId, forged.manifest.eventId]));
  const report = verifyPortable(wire(portableBundle(disclosure)), trust);
  assert.equal(report.records[0].releaseControl, 'UNKNOWN'); assert.equal(report.records[1].releaseControl, 'NOT_APPLICABLE');
  const preview = receipts.prepare({ ids: [groups[0].record.manifest.eventId] }), baseline = parseCanonical(receipts.export(preview.previewId));
  const missingProof = structuredClone(baseline); missingProof.publicProofObjects = [];
  const missing = verifyPortable(wire(missingProof), trust).records.find(r => r.recordDigest === groups[0].record.recordDigest);
  assert.equal(missing.anchor, 'INDETERMINATE'); assert.equal(missing.integrity, 'VALID');
  const wrongTrust = { ...trust, genesis: 'wrong-genesis' };
  assert.equal(verifyPortable(wire(baseline), wrongTrust).records.find(r => r.recordDigest === missing.recordDigest).anchor, 'INVALID');
  const unsupported = structuredClone(baseline); unsupported.anchors[0].batch.profile = 'unknown-merkle';
  assert.equal(verifyPortable(wire(unsupported), trust).records.find(r => r.recordDigest === missing.recordDigest).anchor, 'UNSUPPORTED');
  const altered = structuredClone(baseline); altered.anchors[0].batch.path[0] = randomBytes(32).toString('base64url');
  assert.equal(verifyPortable(wire(altered), trust).records.find(r => r.recordDigest === missing.recordDigest).anchor, 'INVALID');
  const noOpening = structuredClone(baseline); noOpening.disclosure.records[0].opening = null;
  const incomplete = verifyPortable(wire(noOpening), trust).records[0];
  assert.equal(incomplete.integrity, 'INCOMPLETE'); assert.equal(incomplete.keyAttribution, 'SIGNATURE_VALID');
  event({ kind: 'release-outcome', recordDigest: groups[0].record.recordDigest, mode: 'Sealed', state: 'UNKNOWN_AFTER_POSSIBLE_EGRESS',
    releaseClass: 'PRE_DISCLOSURE_PROTECTED', confirmation: { result: 'SOURCE_CORROBORATED' } });
  const conflict = receipts.prepare({ ids: [groups[0].record.manifest.eventId] });
  assert.equal(conflict.report.records.find(r => r.recordDigest === missing.recordDigest).releaseControl, 'UNKNOWN');
});

test('cancellation links require a signed frozen target and preserve unassociated legacy records through recovery', t => {
  const { root, vault, groups, receipts, event, opened } = fixture(t);
  const linked = event({ kind: 'release-cancelled', mode: 'Sealed', version: 'cancelled-version', recordDigest: groups[0].record.recordDigest });
  const orphans = [
    event({ kind: 'release-cancelled', mode: 'Sealed', version: 'legacy-version-with-no-digest' }),
    event({ kind: 'release-cancelled', mode: 'Sealed', version: 'missing-target', recordDigest: randomBytes(32).toString('base64url') }),
    event({ kind: 'release-cancelled', mode: 'Always Protect', version: 'mode-mismatch', recordDigest: groups[0].record.recordDigest }),
    event({ kind: 'release-cancelled', mode: 'Sealed', version: 'text-is-not-frozen', recordDigest: groups[0].input.recordDigest }),
  ];
  const original = vault.inspect().records, history = receipts.list();
  assert.ok(history.find(g => g.id === groups[0].record.manifest.eventId).recordIds.includes(linked.manifest.eventId));
  for (const orphan of orphans) {
    const group = history.find(g => g.id === orphan.manifest.eventId);
    assert.equal(group.unassociatedCancellation, true); assert.deepEqual(group.recordIds, [orphan.manifest.eventId]);
    assert.throws(() => receipts.redact({ id: group.id, text: 'invented source' }), /no source prompt/);
    const preview = receipts.prepare({ ids: [group.id] }), bundle = parseCanonical(receipts.export(preview.previewId));
    assert.deepEqual(bundle.disclosure.records, [orphan]);
    assert.equal(preview.texts[0].unassociatedCancellation, true);
    const assertion = preview.report.records[0].localAssertions[0];
    assert.equal(assertion.association, 'UNASSOCIATED'); assert.equal(assertion.providerNonEgress, 'NOT_PROVEN');
  }
  const preview = receipts.prepare({ ids: [groups[0].record.manifest.eventId] });
  const target = preview.report.records.find(r => r.recordDigest === groups[0].record.recordDigest);
  assert.equal(target.localAssertions.filter(a => a.kind === 'release-cancelled').length, 1);
  assert.equal(target.releaseControl, 'UNKNOWN', 'a selected release and cancellation do not establish latest state');
  const metadata = receipts.prepare({ ids: [groups[0].record.manifest.eventId], includeEvidence: false });
  assert.ok(metadata.report.records.every(r => r.localAssertions.length === 0));
  assert.deepEqual(vault.inspect().records, original, 'reading or exporting never rewrites historical signed records');
  const backup = vault.exportRecovery();
  const restored = restoreRecovery(backup.package, backup.recoveryKey, join(root, 'cancel-recovery'), randomBytes(32)); opened.push(restored);
  const recovered = new LocalReceipts(restored);
  assert.deepEqual(recovered.list(), history);
  const recoveredPreview = recovered.prepare({ ids: [groups[0].record.manifest.eventId, orphans[0].manifest.eventId] });
  assert.equal(recoveredPreview.report.records.flatMap(r => r.localAssertions).filter(a => a.kind === 'release-cancelled').length, 2);
});

test('cancellation cannot target another signing key or pass when its signed evidence is changed', t => {
  const { vault, groups, event } = fixture(t), other = fixture(t);
  const cancellation = other.event({ kind: 'release-cancelled', mode: 'Sealed', version: 'foreign-signer',
    recordDigest: groups[0].record.recordDigest });
  const selected = parseCanonical(vault.exportDisclosure([groups[0].record.manifest.eventId]));
  const foreign = parseCanonical(other.vault.exportDisclosure([cancellation.manifest.eventId]));
  const bundle = portableBundle({ ...selected, records: [...selected.records, ...foreign.records], objects: [...selected.objects, ...foreign.objects] });
  const report = verifyPortable(wire(bundle));
  assert.deepEqual(report.records[0].localAssertions, []);
  assert.equal(report.records[1].localAssertions[0].association, 'UNASSOCIATED');
  const local = event({ kind: 'release-cancelled', mode: 'Sealed', version: 'local-version', recordDigest: groups[0].record.recordDigest });
  const tampered = portableBundle(parseCanonical(vault.exportDisclosure([groups[0].record.manifest.eventId, local.manifest.eventId])));
  tampered.disclosure.objects.find(o => o.digest === local.manifest.evidence[0].objectDigest).bytes = disclosureObject(Buffer.from('changed')).bytes;
  assert.throws(() => verifyPortable(wire(tampered)), /Object mismatch/);
});

test('hostile bundles reject duplicate names, paths, extra objects, tampering, and parser/resource excess', t => {
  const { receipts, groups } = fixture(t);
  const preview = receipts.prepare({ ids: [groups[0].record.manifest.eventId] }), baseline = parseCanonical(receipts.export(preview.previewId));
  assert.throws(() => parseBoundedJSON('{"a":1,"\\u0061":2}'), /Duplicate/);
  assert.throws(() => parseBoundedJSON('['.repeat(33) + '0' + ']'.repeat(33)), /depth/);
  assert.throws(() => verifyPortable(Buffer.alloc(RECIPIENT_LIMITS.wire + 1)), /size/);
  for (const change of [
    b => { b.remote = 'https://never.example/'; },
    b => { b.trust = { checkpoint: 'sender-chosen' }; },
    b => { b.publicProofObjects[0].path = '../../outside'; },
    b => { b.publicProofObjects.push(b.publicProofObjects[0]); },
    b => { b.publicProofObjects[0].bytes[0] = 'AAAA'; },
    b => { b.anchors.push(b.anchors[0]); },
    b => { b.disclosure.records.push(b.disclosure.records[0]); },
    b => { b.disclosure.objects.push(disclosureObject(Buffer.from('unselected secret'))); },
    b => { b.disclosure.records = Array(129).fill(b.disclosure.records[0]); },
    b => { b.anchors = []; },
  ]) {
    const changed = structuredClone(baseline); change(changed); assert.throws(() => verifyPortable(wire(changed)));
  }
});

test('recorded archived anchors verify offline in a fresh process with separate trust and shared proofs', t => {
  const root = mkdtempSync(join(tmpdir(), 'provenance-offline-recipient-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = new URL('../spikes/demonstrator/testdata/', import.meta.url);
  const legacy = JSON.parse(readFileSync(new URL('evidence-export.json', directory)));
  const trust = JSON.parse(readFileSync(new URL('independent-trust.json', directory)));
  const envelopes = legacy.anchors.map(a => parseCanonical(Buffer.from(a.envelope)));
  const disclosure = parseCanonical(Buffer.from(legacy.disclosure));
  const descriptorIds = new Set(legacy.anchors.map(a => a.descriptorId));
  const records = disclosure.records.filter(r => descriptorIds.has(r.manifest.eventId));
  const digests = new Set(records.map(r => r.manifest.evidence[0].objectDigest));
  const bundle = portableBundle({ ...disclosure, records, objects: disclosure.objects.filter(o => digests.has(o.digest)) }, envelopes);
  assert.equal(bundle.publicProofObjects.length, 1);
  const bytes = wire(bundle), report = verifyPortable(bytes, trust);
  assert.equal(report.publicProofs.verifications, 1);
  assert.ok(report.records.every(r => r.anchor === 'CONSENSUS_VERIFIED' && r.timestamp === 'BLOCK_HASH_BOUND'));
  assert.ok(verifyPortable(bytes).records.every(r => r.anchor === 'INDETERMINATE'));
  assert.ok(verifyPortable(bytes, { ...trust, genesis: 'wrong' }).records.every(r => r.anchor === 'INVALID'));
  assert.ok(verifyPortable(bytes, trust, { algorandVerifierPath: '/nonexistent/provenance-test-verifier' }).records.every(r => r.anchor === 'UNSUPPORTED'));
  const missingHeader = structuredClone(envelopes); delete missingHeader[0].proof.fullHeader;
  const missing = portableBundle({ ...bundle.disclosure, records: [records[0]], objects: bundle.disclosure.objects.filter(o => o.digest === records[0].manifest.evidence[0].objectDigest) }, [missingHeader[0]]);
  assert.equal(verifyPortable(wire(missing), trust).records[0].anchor, 'INDETERMINATE');
  assert.equal(verifyPortable(Buffer.from(JSON.stringify(legacy)), trust).records.filter(r => r.anchor === 'CONSENSUS_VERIFIED').length, 3);
  for (const name of ['restored-evidence-export.json']) {
    const old = readFileSync(new URL(name, directory));
    assert.equal(verifyPortable(old, trust).records.filter(r => r.anchor === 'CONSENSUS_VERIFIED').length, 3);
  }
  writeFileSync(join(root, 'evidence.json'), bytes); writeFileSync(join(root, 'trust.json'), JSON.stringify(trust));
  const guard = join(root, 'deny-network.mjs');
  writeFileSync(guard, `import net from 'node:net';import tls from 'node:tls';import http from 'node:http';import https from 'node:https';import dns from 'node:dns';import {syncBuiltinESMExports} from 'node:module';const deny=()=>{throw Error('NETWORK_FORBIDDEN')};net.connect=net.createConnection=tls.connect=http.request=http.get=https.request=https.get=dns.lookup=dns.resolve=deny;globalThis.fetch=deny;syncBuiltinESMExports();`);
  const run = spawnSync(process.execPath, ['--import', guard, new URL('../spikes/recipient/verify.mjs', import.meta.url).pathname,
    join(root, 'evidence.json'), join(root, 'trust.json')], { cwd: root, env: {}, encoding: 'utf8', timeout: 30000 });
  assert.equal(run.status, 0, run.stderr); assert.equal(JSON.parse(run.stdout).publicProofs.verifications, 1);
});

test('recipient HTTP accepts only paired local requests and isolates hostile input from the next verification', async t => {
  const { receipts, groups } = fixture(t), app = await startRecipient();
  t.after(() => app.close());
  const preview = receipts.prepare({ ids: [groups[2].record.manifest.eventId] }), bundle = receipts.export(preview.previewId).toString();
  const headers = { Origin: app.origin, Authorization: `Bearer ${new URL(app.url).hash.slice(1)}` };
  assert.equal((await fetch(`${app.origin}/verify`, { method: 'POST', body: '{}' })).status, 400);
  const page = await fetch(app.url); assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  assert.doesNotMatch(await page.text(), /<iframe|https:\/\//);
  const malformed = await fetch(`${app.origin}/verify`, { method: 'POST', headers, body: JSON.stringify({ bundle: '{"a":1,"a":2}', trust: null }) });
  assert.equal(malformed.status, 400);
  const valid = await fetch(`${app.origin}/verify`, { method: 'POST', headers, body: JSON.stringify({ bundle, trust: null }) });
  assert.equal(valid.status, 200); assert.equal((await valid.json()).records[0].integrity, 'VALID');
  const isolated = await verifyIsolated(bundle); assert.equal(isolated.records[0].keyAttribution, 'SIGNATURE_VALID');
});
