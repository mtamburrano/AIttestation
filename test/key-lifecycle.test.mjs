import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { DurableVault, MacOSKeychainStore, MemoryKeyStore } from '../spikes/vault/key-lifecycle.mjs';
import { Vault } from '../spikes/vault/vault.mjs';
import { identity, publicProofDigest, verifyDisclosure } from '../spikes/vault/records.mjs';
import { b64, canonical, parseCanonical } from '../spikes/vault/format.mjs';
import { FileKeyStore } from './file-key-store.mjs';

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

test('vault rotation retires the old key after a real process death at the commit boundary', t => {
  const { root, path } = directory(t), keyStoreDirectory = join(root, 'test-key-store');
  const keyStore = new FileKeyStore(keyStoreDirectory);
  const initial = DurableVault.create(path, { keyStore }); initial.capture(Buffer.from('before rotation')); initial.close();
  const initialDb = new DatabaseSync(join(path, 'vault.sqlite'), { readOnly: true });
  const oldKeyId = initialDb.prepare('SELECT key_hash FROM meta WHERE id=1').get().key_hash; initialDb.close();
  const child = spawnSync(process.execPath, [join(import.meta.dirname, 'vault-key-rotation-child.mjs'), path, keyStoreDirectory]);
  assert.equal(child.signal, 'SIGKILL');
  const interruptedDb = new DatabaseSync(join(path, 'vault.sqlite'), { readOnly: true });
  const replacementKeyId = interruptedDb.prepare('SELECT key_hash FROM meta WHERE id=1').get().key_hash;
  assert.notEqual(replacementKeyId, oldKeyId);
  assert.equal(interruptedDb.prepare('SELECT count(*) AS count FROM key_retirements').get().count, 1);
  interruptedDb.close();
  assert.equal(keyStore.accounts().length, 3, 'old VMK, replacement VMK, and signing key survive the killed process');
  const reopened = DurableVault.open(path, { keyStore }); t.after(() => reopened.close());
  assert.equal(reopened.status().vaultKeyId, replacementKeyId);
  assert.equal(reopened.status().retiredKeyRemovalPending, false);
  assert.equal(reopened.verifyAll().count, 1);
  assert.equal(keyStore.accounts().length, 2);
  assert.equal(keyStore.accounts().some(account => account.endsWith(oldKeyId)), false);
  const reconciledDb = new DatabaseSync(join(path, 'vault.sqlite'), { readOnly: true });
  assert.equal(reconciledDb.prepare('SELECT count(*) AS count FROM key_retirements').get().count, 0); reconciledDb.close();
});

test('vault rotation reports transient retirement failure and retries it on open', t => {
  const { path } = directory(t), backing = new MemoryKeyStore(); let failNextRetirement = false;
  const keyStore = {
    get: account => backing.get(account), set: (account, secret) => backing.set(account, secret),
    delete: account => {
      if (failNextRetirement && account.includes(':encryption:')) { failNextRetirement = false; throw Error('synthetic cleanup failure'); }
      backing.delete(account);
    },
  };
  const vault = DurableVault.create(path, { keyStore }); vault.capture(Buffer.from('cleanup retry'));
  failNextRetirement = true;
  assert.equal(vault.rotateVaultKey().retiredKeyRemovalPending, true);
  assert.equal(vault.status().retiredKeyRemovalPending, true); assert.equal(backing.accounts().length, 3); vault.close();
  const reopened = DurableVault.open(path, { keyStore }); t.after(() => reopened.close());
  assert.equal(reopened.status().retiredKeyRemovalPending, false); assert.equal(backing.accounts().length, 2);
  assert.equal(reopened.verifyAll().count, 1);
});

test('legacy vault adoption and indexed migration survive interruption and reject rollback writers', t => {
  const { path } = directory(t), vaultKey = randomBytes(32), signer = identity();
  const legacy = new Vault(path, vaultKey, signer, { create: true, readerVersion: 3 });
  const record = legacy.capture(Buffer.from('pre-upgrade evidence'));
  const oldBundle = legacy.exportDisclosure([record.manifest.eventId]); legacy.close();
  const db = new DatabaseSync(join(path, 'vault.sqlite'));
  db.exec('DROP TABLE key_retirements; DROP TABLE vault_schema; PRAGMA user_version=1;'); db.close();

  assert.throws(() => new Vault(path, vaultKey, signer, { fault: phase => {
    if (phase === 'migration-before-commit') throw Error('simulated interrupted upgrade');
  } }), /interrupted upgrade/);
  const rollbackBeforeUpgrade = new Vault(path, vaultKey, signer, { readerVersion: 1 });
  assert.equal(rollbackBeforeUpgrade.schemaInfo().writerVersion, 1); rollbackBeforeUpgrade.close();

  const keyStore = new MemoryKeyStore();
  const upgraded = DurableVault.adoptLegacy(path, vaultKey, signer, { keyStore });
  assert.equal(upgraded.schemaInfo().writerVersion, 4); upgraded.close();
  assert.throws(() => new Vault(path, vaultKey, signer, { readerVersion: 1 }), { code: 'UNSUPPORTED' });
  const reopened = DurableVault.open(path, { keyStore });
  assert.deepEqual(reopened.inspect().records, [record]); reopened.close();
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

test('macOS keychain adapter uses the private native broker protocol and exact role accounts', () => {
  const items = new Map(), calls = [];
  const run = request => {
    calls.push(structuredClone(request));
    if (request.operation === 'set') items.set(request.account, request.value);
    if (request.operation === 'delete') items.delete(request.account);
    const response = request.operation === 'get' && !items.has(request.account)
      ? { profile: 'pap-keychain-response/1', status: 'MISSING' }
      : { profile: 'pap-keychain-response/1', status: 'OK', ...(request.operation === 'get' ? { value: items.get(request.account) } : {}) };
    return { status: 0, stdout: JSON.stringify(response), stderr: '' };
  };
  const store = new MacOSKeychainStore({ service: 'ai.provenance.test-only', run });
  const secret = Buffer.from('synthetic secret'), account = 'vault:test:signing:active'; store.set(account, secret);
  assert.deepEqual(store.get(account), secret); store.delete(account); assert.equal(store.get(account), null);
  assert.deepEqual(calls[0], { profile: 'pap-keychain-request/1', operation: 'set',
    service: 'ai.provenance.test-only', account, value: b64(secret) });
  assert.equal(Object.keys(calls[0]).sort().join(','), 'account,operation,profile,service,value');
});
