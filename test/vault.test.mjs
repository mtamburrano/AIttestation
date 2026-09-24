import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Vault, inspectRecovery, restoreRecovery } from '../spikes/vault/vault.mjs';
import { identity, verifyRecord, verifyDisclosure } from '../spikes/vault/records.mjs';
import { canonical, parseCanonical, objectDigest, b64, unb64, hash, aad, encrypt, decrypt, LIMITS } from '../spikes/vault/format.mjs';

function resource(t) {
  const root = mkdtempSync(join(tmpdir(), 'provenance-vault-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const key = randomBytes(32), directory = join(root, 'vault');
  const vault = new Vault(directory, key, undefined, { create: true });
  t.after(() => vault.close());
  return { root, key, directory, vault };
}
const bytes = Buffer.from('exact synthetic e\u0301\0\r\n☕');
const encoded = v => Buffer.from(canonical(v));

test('canonical JSON vectors, unicode sorting, duplicate names, invalid encodings and depth limits', () => {
  assert.equal(canonical({ z: 1e30, a: [4.5, 2e-3, 1e-27, 333333333.33333329] }), '{"a":[4.5,0.002,1e-27,333333333.3333333],"z":1e+30}');
  assert.equal(canonical({ '\ufb33': 7, '😀': 6, '€': 5, 'ö': 4, '\u0080': 3, '1': 2, '\r': 1 }), '{"\\r":1,"1":2,"\u0080":3,"ö":4,"€":5,"😀":6,"דּ":7}');
  for (const text of ['{"x":1,"x":1}', '{ "x":1}', '{"a":1e0}', '"\\ud800"', '1e999', '"\\u0061"']) assert.throws(() => parseCanonical(Buffer.from(text)));
  assert.throws(() => parseCanonical(Buffer.from([0x22, 0xff, 0x22])), /UTF-8/);
  assert.throws(() => parseCanonical(Buffer.from('['.repeat(34) + '0' + ']'.repeat(34))), { code: 'LIMIT_EXCEEDED' });
  assert.throws(() => canonical('x'.repeat(LIMITS.field + 1)), { code: 'LIMIT_EXCEEDED' });
  assert.throws(() => unb64('YQ=='), { code: 'INVALID' });
});
test('Ed25519 RFC 8032 empty-message primitive vector', () => {
  const seed = Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex');
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  assert.equal(createPublicKey(privateKey).export({ format: 'jwk' }).x, b64(Buffer.from('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', 'hex')));
  assert.equal(sign(null, Buffer.alloc(0), privateKey).toString('hex'), 'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b');
});
test('exact bytes, private dedup, independent openings and persisted historical signatures', t => {
  const { root, key, directory, vault } = resource(t);
  const first = vault.capture(bytes), second = vault.capture(bytes);
  assert.equal(vault.inspect().objects.length, 1); assert.equal(vault.inspect().records.length, 2);
  assert.notEqual(first.opening, second.opening); assert.notEqual(first.commitment, second.commitment);
  assert.deepEqual(vault.read(objectDigest(bytes)), bytes);
  const dbBytes = Buffer.concat(['vault.sqlite', 'vault.sqlite-wal'].filter(f => existsSync(join(directory, f))).map(f => readFileSync(join(directory, f))));
  for (const secret of [bytes, Buffer.from(objectDigest(bytes)), Buffer.from(first.opening), key]) assert.equal(dbBytes.includes(secret), false);
  vault.close(); const restarted = new Vault(directory, key); t.after(() => restarted.close());
  assert.equal(restarted.verifyAll().snapshot, 'COMPLETE'); assert.deepEqual(restarted.inspect().records[0], first);
  const other = new Vault(join(root, 'other'), randomBytes(32), undefined, { create: true }); t.after(() => other.close());
  const otherRecord = other.capture(bytes); assert.notEqual(otherRecord.commitment, first.commitment);
});
for (const phase of ['before-write', 'after-objects', 'after-index', 'before-commit', 'after-commit', 'acknowledged']) {
  test(`real process kill ${phase}: atomic capture recovery`, t => {
    const { root, directory, key, vault } = resource(t);
    vault.capture(bytes); vault.close();
    const keyPath = join(root, 'test-key'); writeFileSync(keyPath, key, { mode: 0o600 });
    const child = spawnSync(process.execPath, ['test/vault-crash-child.mjs', directory, keyPath, phase], { encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 10000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const reopened = new Vault(directory, key); t.after(() => reopened.close());
    assert.equal(reopened.verifyAll().count, ['after-commit', 'acknowledged'].includes(phase) ? 2 : 1);
    if (phase === 'acknowledged') assert.equal(reopened.inspect().records.at(-1).recordDigest, child.stdout.trim());
    assert.deepEqual(reopened.read(objectDigest(bytes)), bytes);
  });
}
test('injected low disk rolls back unacknowledged capture and preserves previous capture', t => {
  const { directory, key, vault } = resource(t); vault.capture(bytes); vault.close();
  const failing = new Vault(directory, key, undefined, { fault: phase => {
    if (phase === 'before-commit') throw Object.assign(Error('SQLITE_FULL: test-only injected low disk'), { code: 'SQLITE_FULL' });
  } });
  assert.throws(() => failing.capture(Buffer.from('new')), { code: 'SQLITE_FULL' }); failing.close();
  const reopened = new Vault(directory, key); t.after(() => reopened.close());
  assert.equal(reopened.verifyAll().count, 1);
});
test('recovery works on clean destination with new VMK/signing key; old snapshot never claims latest', t => {
  const { root, vault, key } = resource(t); const first = vault.capture(bytes);
  const backup = vault.exportRecovery(); vault.capture(Buffer.from('later'));
  const recovered = inspectRecovery(backup.package, backup.recoveryKey);
  assert.equal(recovered.snapshot, 'COMPLETE'); assert.equal(recovered.latestState, 'NOT_PROVEN'); assert.equal(recovered.records.length, 1);
  for (const secret of [bytes, key, backup.recoveryKey, Buffer.from(first.opening), Buffer.from(objectDigest(bytes))]) assert.equal(backup.package.includes(secret), false);
  const newKey = randomBytes(32), newIdentity = identity();
  const restored = restoreRecovery(backup.package, backup.recoveryKey, join(root, 'clean-device'), newKey, newIdentity); t.after(() => restored.close());
  assert.deepEqual(restored.read(objectDigest(bytes)), bytes); assert.deepEqual(restored.inspect().records[0], first);
  const next = restored.capture(Buffer.from('after restore'));
  assert.notEqual(next.manifest.signingPublicKey, first.manifest.signingPublicKey);
  assert.equal(restored.verifyAll().count, 2);
  assert.throws(() => inspectRecovery(backup.package, null), { code: 'UNRECOVERABLE' });
  assert.throws(() => inspectRecovery(backup.package, randomBytes(32)), { code: 'INVALID' });
});
test('recovery rejects whole blob removal, changed outer metadata and cross-package substitutions before writing', t => {
  const { root, vault } = resource(t); vault.capture(bytes); vault.capture(Buffer.from('second event'));
  const backup = vault.exportRecovery(), other = vault.exportRecovery();
  const pkg = parseCanonical(backup.package), otherPkg = parseCanonical(other.package);
  const mutations = [ p => p.blobs.pop(), p => { p.snapshotId = b64(randomBytes(16)); },
    p => { p.encryptedManifest = otherPkg.encryptedManifest; }, p => { p.complete = true; },
    p => { p.blobs[0].id = '../escape'; }, p => { p.blobs[0].box.payload.tag = b64(randomBytes(16)); },
    p => { p.blobs[0].box.wrappedKey = p.blobs[1].box.wrappedKey; } ];
  for (const [i, mutate] of mutations.entries()) {
    const changed = structuredClone(pkg); mutate(changed);
    const destination = join(root, `invalid-restore-${i}`);
    assert.throws(() => restoreRecovery(encoded(changed), backup.recoveryKey, destination, randomBytes(32)));
    assert.equal(existsSync(destination), false);
  }
});
test('authenticated inventory catches complete event/blob deletion and missing openings even with test-authorized re-encryption', t => {
  const { vault, key } = resource(t); vault.capture(bytes); vault.capture(Buffer.from('second event'));
  const backup = vault.exportRecovery(), original = parseCanonical(backup.package);
  const wrapAAD = aad('PAP/wrapped-dek/v1', original.vaultId, 'recovery-manifest', original.snapshotId, original.packageId, original.snapshotId);
  const payloadAAD = aad('PAP/recovery-manifest/v1', original.vaultId, 'recovery-manifest', original.snapshotId, original.packageId, original.snapshotId);
  const snapshotKey = decrypt(backup.recoveryKey, original.wrappedVMK, aad('PAP/recovery-vmk/v1', original.vaultId, 'vmk', 'vmk', original.packageId, original.snapshotId), 32);
  const dek = decrypt(snapshotKey, original.encryptedManifest.wrappedKey, wrapAAD, 32);
  const manifest = parseCanonical(decrypt(dek, original.encryptedManifest.payload, payloadAAD));
  for (const mutation of ['event-set', 'opening', 'wrapped-key']) {
    const p = structuredClone(original), m = structuredClone(manifest);
    // Fresh test-only keys avoid ever reusing a DEK encryption invocation.
    const freshDEK = randomBytes(32), freshVMK = randomBytes(32), freshRecovery = randomBytes(32);
    let wrapNumber = 0;
    const nonce = () => { const n = Buffer.alloc(12); n.writeUInt32BE(++wrapNumber, 8); return n; };
    for (const blob of p.blobs) {
      const object = m.index.objects.find(o => o.id === blob.id);
      const objectAAD = aad('PAP/wrapped-dek/v1', p.vaultId, 'evidence', object.digest);
      const objectKey = decrypt(snapshotKey, blob.box.wrappedKey, objectAAD, 32);
      blob.box.wrappedKey = encrypt(freshVMK, objectKey, objectAAD, nonce());
      const item = m.inventory.find(item => item.id === blob.id);
      item.ciphertextDigest = b64(hash(encoded(blob.box))); item.encodedLength = String(encoded(blob.box).length);
    }
    p.encryptedManifest.payload = encrypt(freshDEK, encoded(m), payloadAAD);
    p.encryptedManifest.wrappedKey = encrypt(freshVMK, freshDEK, wrapAAD, nonce());
    p.wrappedVMK = encrypt(freshRecovery, freshVMK, aad('PAP/recovery-vmk/v1', p.vaultId, 'vmk', 'vmk', p.packageId, p.snapshotId));
    assert.equal(inspectRecovery(encoded(p), freshRecovery).snapshot, 'COMPLETE', 'Known-good rewrapped baseline');
    if (mutation === 'event-set') { m.index.records.pop(); const o = m.index.objects.pop(); p.blobs = p.blobs.filter(b => b.id !== o.id); }
    if (mutation === 'opening') m.index.records[0].opening = null;
    if (mutation === 'wrapped-key') delete p.blobs[0].box.wrappedKey;
    const changedDEK = randomBytes(32);
    p.encryptedManifest.payload = encrypt(changedDEK, encoded(m), payloadAAD);
    p.encryptedManifest.wrappedKey = encrypt(freshVMK, changedDEK, wrapAAD, nonce());
    assert.throws(() => inspectRecovery(encoded(p), freshRecovery), mutation === 'opening' ? { code: 'INCOMPLETE' } : undefined);
  }
});
test('rotation rewraps without changing ciphertext or signatures; historical backups remain recoverable', t => {
  const { directory, key, vault } = resource(t); const record = vault.capture(bytes), backup = vault.exportRecovery();
  const db = new DatabaseSync(join(directory, 'vault.sqlite')); t.after(() => db.close());
  const before = parseCanonical(db.prepare('SELECT envelope FROM blobs').get().envelope);
  const rotated = randomBytes(32); vault.rotate(rotated);
  const after = parseCanonical(db.prepare('SELECT envelope FROM blobs').get().envelope);
  assert.deepEqual(after.payload, before.payload); assert.notDeepEqual(after.wrappedKey, before.wrappedKey);
  assert.deepEqual(vault.inspect().records[0], record); assert.equal(vault.verifyAll().snapshot, 'COMPLETE');
  assert.throws(() => vault.rotate(key), /reuse/);
  assert.equal(inspectRecovery(backup.package, backup.recoveryKey).snapshot, 'COMPLETE');
  vault.close(); assert.throws(() => new Vault(directory, key), { code: 'UNRECOVERABLE' });
  const reopened = new Vault(directory, rotated); t.after(() => reopened.close()); assert.equal(reopened.verifyAll().count, 1);
});
test('wrapping keys advance past the legacy invocation boundary and missing reservation state fails closed', t => {
  const { directory, vault } = resource(t); vault.capture(bytes);
  const db = new DatabaseSync(join(directory, 'vault.sqlite')); t.after(() => db.close());
  db.exec(`UPDATE usage SET counter=${2 ** 20}`);
  assert.equal(vault.capture(bytes).manifest.sequence, '2');
  vault.rotate(randomBytes(32)); assert.equal(vault.capture(bytes).manifest.sequence, '3');
  db.exec('DELETE FROM usage'); assert.throws(() => vault.capture(bytes), { code: 'UNRECOVERABLE' });
});
test('corruption, absent content, selective disclosure and missing openings never appear fully verified', t => {
  const { directory, vault } = resource(t); const record = vault.capture(bytes);
  const complete = verifyDisclosure(vault.exportDisclosure([record.manifest.eventId]));
  assert.equal(complete.scope, 'SELECTIVE'); assert.equal(complete.records[0].integrity, 'VALID');
  const partial = verifyDisclosure(vault.exportDisclosure([record.manifest.eventId], { includeEvidence: false }));
  assert.equal(partial.records[0].integrity, 'INCOMPLETE'); assert.equal(partial.records[0].evidence, 'MISSING');
  assert.equal(verifyRecord({ ...record, opening: null }, bytes).integrity, 'INCOMPLETE');
  assert.equal(verifyRecord(record, Buffer.from('altered')).integrity, 'INVALID');
  assert.equal(verifyRecord({ ...record, signature: b64(randomBytes(64)) }, bytes).keyAttribution, 'SIGNATURE_INVALID');
  const db = new DatabaseSync(join(directory, 'vault.sqlite')); t.after(() => db.close());
  const row = db.prepare('SELECT * FROM blobs').get(), box = parseCanonical(row.envelope);
  box.payload.tag = b64(randomBytes(16)); db.prepare('UPDATE blobs SET envelope=? WHERE id=?').run(encoded(box), row.id);
  assert.throws(() => vault.read(objectDigest(bytes)), { code: 'INVALID' });
  assert.throws(() => vault.capture(bytes), { code: 'INVALID' });
  db.exec('DELETE FROM blobs'); assert.throws(() => vault.verifyAll(), { code: 'INCOMPLETE' });
  assert.throws(() => vault.capture(bytes), { code: 'INCOMPLETE' });
});
test('standalone disclosure verifier needs only explicit local file; unknown fields and resource excess reject', t => {
  const { root, vault } = resource(t); const record = vault.capture(bytes);
  const path = join(root, 'synthetic-disclosure.json');
  writeFileSync(path, vault.exportDisclosure([record.manifest.eventId]));
  const result = spawnSync(process.execPath, ['spikes/vault/verify.mjs', path], { encoding: 'utf8', env: {}, timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).records[0].keyAttribution, 'SIGNATURE_VALID');
  const bundle = parseCanonical(readFileSync(path)); bundle.remote = 'https://invalid.example/never-fetch';
  assert.throws(() => verifyDisclosure(encoded(bundle)), { code: 'INVALID' });
  delete bundle.remote; bundle.records = Array(513).fill(record);
  assert.throws(() => verifyDisclosure(encoded(bundle)), { code: 'LIMIT_EXCEEDED' });
  assert.throws(() => vault.capture(Buffer.alloc(LIMITS.object + 1)), { code: 'LIMIT_EXCEEDED' });
  const backup = vault.exportRecovery(), changed = parseCanonical(backup.package);
  changed.wrappedVMK.algorithm = 'unknown';
  assert.throws(() => inspectRecovery(encoded(changed), backup.recoveryKey), { code: 'UNSUPPORTED' });
});
