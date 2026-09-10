import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { b64, unb64, fail } from './format.mjs';
import { Vault, inspectRecovery, readVaultHeader, vaultKeyId } from './vault.mjs';

const DEFAULT_SERVICE = 'ai.provenance.evidence-vault';
const vaultAccount = (vaultId, keyId) => `vault:${vaultId}:encryption:${keyId}`;
const signingAccount = vaultId => `vault:${vaultId}:signing:active`;
const newVaultId = () => b64(randomBytes(16));

function signingBytes(identity) {
  if (!identity?.privateKey || !identity?.publicKey) fail('UNRECOVERABLE', 'Signing identity missing');
  const derived = createPublicKey(identity.privateKey).export({ format: 'jwk' }).x;
  if (derived !== identity.publicKey.export({ format: 'jwk' }).x) fail('UNRECOVERABLE', 'Signing keypair mismatch');
  return identity.privateKey.export({ format: 'der', type: 'pkcs8' });
}

function signingIdentity(bytes) {
  const encoded = Buffer.from(bytes);
  try {
    const privateKey = createPrivateKey({ key: encoded, format: 'der', type: 'pkcs8' });
    if (privateKey.asymmetricKeyType !== 'ed25519') fail('UNRECOVERABLE', 'Signing key is not Ed25519');
    return { privateKey, publicKey: createPublicKey(privateKey) };
  } catch (error) {
    if (error?.code === 'UNRECOVERABLE') throw error;
    fail('UNRECOVERABLE', 'Stored signing key is invalid');
  } finally { encoded.fill(0); }
}

function securityRun(executable, args, input) {
  return spawnSync(executable, args, { input, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' },
    maxBuffer: 1024 * 1024, timeout: 15000, windowsHide: true });
}

/** Stores each key role as a distinct generic-password item in the macOS login keychain. */
export class MacOSKeychainStore {
  #service; #keychain; #security; #run;
  constructor({ service = DEFAULT_SERVICE, keychain = null, security = '/usr/bin/security', run = null } = {}) {
    if (typeof service !== 'string' || !/^[A-Za-z0-9._-]{1,120}$/.test(service)) fail('INVALID', 'Invalid keychain service');
    if (keychain !== null && (typeof keychain !== 'string' || !isAbsolute(keychain))) fail('INVALID', 'Invalid keychain path');
    if (run === null && security !== '/usr/bin/security') fail('INVALID', 'Untrusted Keychain executable');
    if (process.platform !== 'darwin' && run === null) fail('UNSUPPORTED', 'macOS Keychain is required');
    this.#service = service; this.#keychain = keychain; this.#security = security; this.#run = run ?? securityRun;
  }
  #invoke(args, input = undefined, { missing = false } = {}) {
    const result = this.#run(this.#security, args, input);
    if (result?.status === 0) return result.stdout ?? '';
    const detail = `${result?.stderr ?? ''}${result?.stdout ?? ''}`;
    if (missing && /could not be found|item not found|SecKeychainSearchCopyNext: -25300/i.test(detail)) return null;
    if (/interaction is not allowed|user interaction is not allowed|auth failed|locked/i.test(detail)) fail('LOCKED', 'macOS Keychain is locked');
    fail('UNRECOVERABLE', 'macOS Keychain operation failed');
  }
  get(account) {
    const args = ['find-generic-password', '-a', account, '-s', this.#service, '-w'];
    if (this.#keychain) args.push(this.#keychain);
    const output = this.#invoke(args, undefined, { missing: true });
    return output === null ? null : unb64(output.trim());
  }
  set(account, secret) {
    if (!Buffer.isBuffer(secret) || secret.length === 0) fail('INVALID', 'Secret must be non-empty bytes');
    if (this.#keychain) fail('UNSUPPORTED', 'Secure writes through the CLI require the default macOS keychain');
    // With no password argument, a final -w reads the secret from stdin. This
    // keeps key material out of argv and shell history.
    const args = ['add-generic-password', '-U', '-a', account, '-s', this.#service, '-w'];
    this.#invoke(args, `${b64(secret)}\n`);
  }
  delete(account) {
    const args = ['delete-generic-password', '-a', account, '-s', this.#service];
    if (this.#keychain) args.push(this.#keychain);
    this.#invoke(args, undefined, { missing: true });
  }
}

/** Test-only key store. Callers must allocate one per isolated test resource. */
export class MemoryKeyStore {
  #items = new Map(); #locked = false;
  get(account) {
    if (this.#locked) fail('LOCKED', 'Key store is locked');
    const value = this.#items.get(account); return value ? Buffer.from(value) : null;
  }
  set(account, secret) {
    if (this.#locked) fail('LOCKED', 'Key store is locked');
    const previous = this.#items.get(account); if (previous) previous.fill(0);
    this.#items.set(account, Buffer.from(secret));
  }
  delete(account) {
    if (this.#locked) fail('LOCKED', 'Key store is locked');
    const value = this.#items.get(account); if (value) value.fill(0);
    this.#items.delete(account);
  }
  setLocked(locked) { this.#locked = Boolean(locked); }
  accounts() { return [...this.#items.keys()].sort(); }
}

/**
 * Owns the unlocked lifetime of a vault. Persistent key material remains in the
 * configured OS-protected store and is loaded only between unlock() and lock().
 */
export class DurableVault {
  #directory; #keyStore; #vault = null; #fault; #readerVersion;
  constructor(directory, keyStore, fault = () => {}, readerVersion = undefined) {
    this.#directory = directory; this.#keyStore = keyStore; this.#fault = fault; this.#readerVersion = readerVersion;
  }
  static create(directory, { keyStore = new MacOSKeychainStore(), fault = () => {}, readerVersion } = {}) {
    const vaultId = newVaultId(), vmk = randomBytes(32), signing = generateKeyPairSync('ed25519');
    const vmkAccount = vaultAccount(vaultId, vaultKeyId(vmk)), signerAccount = signingAccount(vaultId);
    const result = new DurableVault(directory, keyStore, fault, readerVersion), signerSecret = signingBytes(signing);
    try {
      keyStore.set(vmkAccount, vmk); keyStore.set(signerAccount, signerSecret);
      result.#vault = new Vault(directory, vmk, signing, { create: true, fault, vaultId, ...(readerVersion === undefined ? {} : { readerVersion }) });
      return result;
    } catch (error) {
      try { keyStore.delete(signerAccount); } catch {}
      try { keyStore.delete(vmkAccount); } catch {}
      throw error;
    } finally { vmk.fill(0); signerSecret.fill(0); }
  }
  static open(directory, { keyStore = new MacOSKeychainStore(), fault = () => {}, readerVersion } = {}) {
    const result = new DurableVault(directory, keyStore, fault, readerVersion); result.unlock(); return result;
  }
  static adoptLegacy(directory, vaultKey, signing, { keyStore = new MacOSKeychainStore(), fault = () => {}, readerVersion } = {}) {
    const header = readVaultHeader(directory);
    if (!Buffer.isBuffer(vaultKey) || vaultKeyId(vaultKey) !== header.keyId) fail('UNRECOVERABLE', 'Legacy vault key does not match');
    const check = new Vault(directory, vaultKey, signing, { fault, ...(readerVersion === undefined ? {} : { readerVersion }) });
    try {
      check.verifyAll();
      const latest = check.inspect().records.at(-1);
      if (latest && latest.manifest.signingPublicKey !== check.signingPublicKey) fail('UNRECOVERABLE', 'Legacy active signing key does not match the latest record');
    } finally { check.close(); }
    const vmkAccount = vaultAccount(header.vaultId, header.keyId), signerAccount = signingAccount(header.vaultId);
    const signerSecret = signingBytes(signing);
    try {
      keyStore.set(vmkAccount, vaultKey); keyStore.set(signerAccount, signerSecret);
      return DurableVault.open(directory, { keyStore, fault, readerVersion });
    } catch (error) {
      try { keyStore.delete(signerAccount); } catch {}
      try { keyStore.delete(vmkAccount); } catch {}
      throw error;
    } finally { signerSecret.fill(0); }
  }
  static restore(input, recoveryKey, newDirectory, { keyStore = new MacOSKeychainStore(), fault = () => {}, readerVersion } = {}) {
    // Validate the complete declared snapshot before creating a destination or keys.
    const recovered = inspectRecovery(input, recoveryKey);
    const result = DurableVault.create(newDirectory, { keyStore, fault, readerVersion });
    try { result.#vault.importRecovered(recovered); return result; }
    catch (error) {
      try {
        if (result.verifyAll().count === recovered.records.length) return result;
      } catch {}
      const header = readVaultHeader(newDirectory); result.lock();
      try { keyStore.delete(signingAccount(header.vaultId)); } catch {}
      try { keyStore.delete(vaultAccount(header.vaultId, header.keyId)); } catch {}
      throw error;
    }
  }
  get locked() { return this.#vault === null; }
  get vaultId() { return this.#vault?.vaultId ?? readVaultHeader(this.#directory).vaultId; }
  #require() { if (!this.#vault) fail('LOCKED', 'Vault is locked'); return this.#vault; }
  unlock() {
    if (this.#vault) return this;
    const header = readVaultHeader(this.#directory);
    let vmk = null, storedSigning = null;
    try {
      vmk = this.#keyStore.get(vaultAccount(header.vaultId, header.keyId));
      storedSigning = this.#keyStore.get(signingAccount(header.vaultId));
      if (!vmk || vmk.length !== 32 || !storedSigning) fail('UNRECOVERABLE', 'Required OS-protected keys are missing');
      this.#vault = new Vault(this.#directory, vmk, signingIdentity(storedSigning), {
        fault: this.#fault, ...(this.#readerVersion === undefined ? {} : { readerVersion: this.#readerVersion }),
      });
      return this;
    } finally { vmk?.fill(0); storedSigning?.fill(0); }
  }
  lock() { if (this.#vault) { this.#vault.close(); this.#vault = null; } }
  close() { this.lock(); }
  capture(bytes) { return this.#require().capture(bytes); }
  inspect() { return this.#require().inspect(); }
  read(digest) { return this.#require().read(digest); }
  verifyAll() { return this.#require().verifyAll(); }
  exportDisclosure(recordIds, options) { return this.#require().exportDisclosure(recordIds, options); }
  exportRecovery() { return this.#require().exportRecovery(); }
  retentionStatus() { return this.#require().retentionStatus(); }
  schemaInfo() { return this.#require().schemaInfo(); }
  status() {
    const vault = this.#require();
    return { locked: false, vaultId: vault.vaultId, vaultKeyId: vault.keyId,
      signingPublicKey: vault.signingPublicKey, schema: vault.schemaInfo(), historicalSendAuthorization: 'NONE' };
  }
  rotateSigningKey() {
    const vault = this.#require(), replacement = generateKeyPairSync('ed25519');
    const secret = signingBytes(replacement);
    try {
      this.#keyStore.set(signingAccount(vault.vaultId), secret);
      vault.setSigningIdentity(replacement);
      return { signingPublicKey: vault.signingPublicKey };
    } finally { secret.fill(0); }
  }
  rotateVaultKey() {
    const vault = this.#require(), oldKeyId = vault.keyId, replacement = randomBytes(32);
    const newKeyId = vaultKeyId(replacement), newAccount = vaultAccount(vault.vaultId, newKeyId);
    this.#keyStore.set(newAccount, replacement);
    try {
      vault.rotate(replacement);
      let retiredKeyRemovalPending = false;
      try { this.#keyStore.delete(vaultAccount(vault.vaultId, oldKeyId)); }
      catch { retiredKeyRemovalPending = true; }
      return { vaultKeyId: newKeyId, retiredKeyRemovalPending };
    } catch (error) {
      // If the durable header still points at the old key, the replacement was
      // never activated and its exact, newly-created keychain item is safe to remove.
      if (readVaultHeader(this.#directory).keyId === oldKeyId) {
        try { this.#keyStore.delete(newAccount); } catch {}
      }
      throw error;
    } finally { replacement.fill(0); }
  }
}
