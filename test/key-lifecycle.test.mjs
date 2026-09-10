import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { DurableVault, MacOSKeychainStore, MemoryKeyStore } from '../spikes/vault/key-lifecycle.mjs';
import { Vault } from '../spikes/vault/vault.mjs';
import { identity, publicProofDigest, verifyDisclosure } from '../spikes/vault/records.mjs';
import { b64, canonical, parseCanonical } from '../spikes/vault/format.mjs';

function directory(t, name = 'vault') {
  const root = mkdtempSync(join(tmpdir(), 'provenance-key-lifecycle-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, path: join(root, name) };
}

test('OS-store lifecycle persists separated roles, supports lock and rotates both active keys', t => {
  const { path } = directory(t), keyStore = new MemoryKeyStore();
  const vault = DurableVault.create(path, { keyStore }); t.after(() => vault.close());
  const original = vault.status(), first = vault.capture(Buffer.from('durable exact bytes'));
  assert.equal(keyStore.accounts().length, 2);
  assert.ok(keyStore.accounts().some(account => account.includes(':encryption:')));
  assert.ok(keyStore.accounts().some(account => account.endsWith(':signing:active')));

  vault.lock(); assert.equal(vault.locked, true);
  assert.throws(() => vault.inspect(), { code: 'LOCKED' });
  keyStore.setLocked(true); assert.throws(() => vault.unlock(), { code: 'LOCKED' });
  keyStore.setLocked(false); vault.unlock();
  assert.equal(vault.status().signingPublicKey, original.signingPublicKey);
  assert.deepEqual(vault.inspect().records[0], first);

  const changedSigner = vault.rotateSigningKey();
  const second = vault.capture(Buffer.from('after signing rotation'));
  assert.notEqual(changedSigner.signingPublicKey, original.signingPublicKey);
  assert.equal(second.manifest.signingPublicKey, changedSigner.signingPublicKey);
  assert.equal(vault.verifyAll().count, 2, 'old signatures remain valid without the old private key');

  const oldVaultKeyId = vault.status().vaultKeyId, changedVault = vault.rotateVaultKey();
  assert.notEqual(changedVault.vaultKeyId, oldVaultKeyId);
  assert.equal(keyStore.accounts().some(account => account.endsWith(oldVaultKeyId)), false);
  vault.close();
  const reopened = DurableVault.open(path, { keyStore }); t.after(() => reopened.close());
  assert.equal(reopened.status().signingPublicKey, changedSigner.signingPublicKey);
  assert.equal(reopened.verifyAll().count, 2);
});

test('clean-device recovery restores history under fresh device keys and no prior send authority', t => {
  const { root, path } = directory(t), originalStore = new MemoryKeyStore();
  const original = DurableVault.create(path, { keyStore: originalStore }); t.after(() => original.close());
  const oldPublicKey = original.status().signingPublicKey;
  const historical = original.capture(Buffer.from('historical exact evidence'));
  const backup = original.exportRecovery(), cleanStore = new MemoryKeyStore();
  const restored = DurableVault.restore(backup.package, backup.recoveryKey, join(root, 'clean-device'), { keyStore: cleanStore });
  t.after(() => restored.close());
  assert.notEqual(restored.status().signingPublicKey, oldPublicKey);
  assert.equal(restored.status().historicalSendAuthorization, 'NONE');
  assert.deepEqual(restored.inspect().records[0], historical);
  const newRecord = restored.capture(Buffer.from('new device evidence'));
  assert.notEqual(newRecord.manifest.signingPublicKey, historical.manifest.signingPublicKey);
  assert.equal(restored.verifyAll().count, 2);
});

test('clean-device recovery recognizes a post-commit interruption without losing its new keys', t => {
  const { root, path } = directory(t), sourceStore = new MemoryKeyStore();
  const source = DurableVault.create(path, { keyStore: sourceStore }); t.after(() => source.close());
  source.capture(Buffer.from('recovery commit boundary')); const backup = source.exportRecovery();
  const cleanStore = new MemoryKeyStore();
  const restored = DurableVault.restore(backup.package, backup.recoveryKey, join(root, 'post-commit'), {
    keyStore: cleanStore, fault: phase => { if (phase === 'after-commit') throw Error('simulated post-commit interruption'); },
  });
  t.after(() => restored.close());
  assert.equal(cleanStore.accounts().length, 2); assert.equal(restored.verifyAll().count, 1);
});

test('vault rotation treats a post-commit interruption as committed and remains reopenable', t => {
  const { path } = directory(t), keyStore = new MemoryKeyStore();
  const initial = DurableVault.create(path, { keyStore }); initial.capture(Buffer.from('before rotation')); initial.close();
  const interrupted = DurableVault.open(path, { keyStore, fault: phase => {
    if (phase === 'after-commit') throw Error('simulated post-commit interruption');
  } });
  const replacement = interrupted.rotateVaultKey(); interrupted.close();
  const reopened = DurableVault.open(path, { keyStore }); t.after(() => reopened.close());
  assert.equal(reopened.status().vaultKeyId, replacement.vaultKeyId);
  assert.equal(reopened.verifyAll().count, 1);
});

test('legacy vault adoption and additive schema migration survive interruption and rollback reader', t => {
  const { path } = directory(t), vaultKey = randomBytes(32), signer = identity();
  const legacy = new Vault(path, vaultKey, signer, { create: true });
  const record = legacy.capture(Buffer.from('pre-upgrade evidence'));
  const oldBundle = legacy.exportDisclosure([record.manifest.eventId]); legacy.close();
  const db = new DatabaseSync(join(path, 'vault.sqlite'));
  db.exec('DROP TABLE vault_schema; PRAGMA user_version=1;'); db.close();

  assert.throws(() => new Vault(path, vaultKey, signer, { fault: phase => {
    if (phase === 'migration-before-commit') throw Error('simulated interrupted upgrade');
  } }), /interrupted upgrade/);
  const rollbackBeforeUpgrade = new Vault(path, vaultKey, signer, { readerVersion: 1 });
  assert.equal(rollbackBeforeUpgrade.schemaInfo().writerVersion, 1); rollbackBeforeUpgrade.close();

  const keyStore = new MemoryKeyStore();
  const upgraded = DurableVault.adoptLegacy(path, vaultKey, signer, { keyStore });
  assert.equal(upgraded.schemaInfo().writerVersion, 2); upgraded.close();
  const rollback = new Vault(path, vaultKey, signer, { readerVersion: 1 });
  assert.equal(rollback.verifyAll().count, 1); rollback.close();
  assert.equal(verifyDisclosure(oldBundle).records[0].integrity, 'VALID');
});

test('public proof objects are content-addressed once and reference-shared across records', t => {
  const { path } = directory(t), vault = new Vault(path, randomBytes(32), undefined, { create: true });
  t.after(() => vault.close());
  const first = vault.capture(Buffer.from('first')), second = vault.capture(Buffer.from('second'));
  const sharedProof = Buffer.from(canonical({ profile: 'public-anchor-proof/1', synthetic: true }));
  const bundle = vault.exportDisclosure([first.manifest.eventId, second.manifest.eventId], { publicProofs: [
    { recordDigest: first.recordDigest, bytes: sharedProof }, { recordDigest: second.recordDigest, bytes: sharedProof },
  ] });
  const decoded = parseCanonical(bundle), report = verifyDisclosure(bundle);
  assert.equal(decoded.profile, 'pap-disclosure-spike/2');
  assert.equal(decoded.publicProofObjects.length, 1); assert.equal(decoded.publicProofReferences.length, 2);
  assert.deepEqual(report.publicProofs, { availability: 'REFERENCE_SHARED', objects: 1, references: 2 });
  const unreferenced = structuredClone(decoded);
  const extra = Buffer.from('extra');
  unreferenced.publicProofObjects.push({ digest: publicProofDigest(extra), bytes: [b64(extra)] });
  assert.throws(() => verifyDisclosure(Buffer.from(canonical(unreferenced))), { code: 'INVALID' });
  decoded.publicProofObjects[0].bytes = [b64(Buffer.from('tampered'))];
  assert.throws(() => verifyDisclosure(Buffer.from(canonical(decoded))), { code: 'INVALID' });
  assert.deepEqual(vault.retentionStatus(), { policy: 'APPEND_ONLY', records: 2, objects: 2, reclaimableObjects: 0,
    reason: 'Every object is reachable from retained signed records; MVP garbage collection is disabled.' });
});

test('macOS keychain adapter keeps secrets out of argv and uses exact role accounts', () => {
  const items = new Map(), calls = [];
  const run = (_executable, args, input) => {
    calls.push({ args: [...args], input });
    const account = args[args.indexOf('-a') + 1], command = args[0];
    if (command === 'add-generic-password') { items.set(account, input.trim()); return { status: 0, stdout: '', stderr: '' }; }
    if (command === 'find-generic-password' && items.has(account)) return { status: 0, stdout: `${items.get(account)}\n`, stderr: '' };
    if (command === 'delete-generic-password') { items.delete(account); return { status: 0, stdout: '', stderr: '' }; }
    return { status: 44, stdout: '', stderr: 'SecKeychainSearchCopyNext: -25300 item could not be found' };
  };
  const store = new MacOSKeychainStore({ service: 'ai.provenance.test-only', run });
  const secret = Buffer.from('synthetic secret'), account = 'vault:test:signing:active'; store.set(account, secret);
  assert.deepEqual(store.get(account), secret); store.delete(account); assert.equal(store.get(account), null);
  assert.ok(calls[0].args.includes(account)); assert.ok(calls[0].args.includes('-w'));
  assert.equal(calls[0].args.includes(b64(secret)), false); assert.equal(calls[0].input, `${b64(secret)}\n`);
  const isolated = new MacOSKeychainStore({ service: 'ai.provenance.test-only', keychain: '/tmp/test-only.keychain-db', run });
  assert.throws(() => isolated.set(account, secret), { code: 'UNSUPPORTED' });
});
