import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { readSync, writeSync, read, write, rmSync } from 'node:fs';
import { b64, unb64, fail } from './format.mjs';
import { inspectRecoveryFile, exportRecoveryFile } from './recovery-stream.mjs';
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

function exactRead(fd, length) {
  const bytes = Buffer.alloc(length); let offset = 0;
  while (offset < length) {
    const count = readSync(fd, bytes, offset, length - offset, null);
    if (count === 0) fail('UNRECOVERABLE', 'Native Keychain broker closed');
    offset += count;
  }
  return bytes;
}

function exactWrite(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(fd, bytes, offset, bytes.length - offset);
    if (count === 0) fail('UNRECOVERABLE', 'Native Keychain broker closed');
    offset += count;
  }
}

let brokerTail = Promise.resolve(), brokerPending = 0, brokerFailed = false;
function brokerRun(request) {
  // Never interleave a synchronous vault operation with an in-flight managed
  // credential exchange on the same framed pipe. The caller may retry later.
  if (brokerFailed || brokerPending) fail('UNRECOVERABLE', 'Native Keychain broker unavailable or busy');
  try {
    const body = Buffer.from(JSON.stringify(request));
    if (body.length > 256 * 1024) fail('LIMIT_EXCEEDED', 'Keychain request');
    const frame = Buffer.alloc(4 + body.length); frame.writeUInt32BE(body.length); body.copy(frame, 4);
    exactWrite(3, frame);
    const length = exactRead(4, 4).readUInt32BE();
    if (length === 0 || length > 1024 * 1024) fail('UNRECOVERABLE', 'Invalid Keychain broker response');
    return { status: 0, stdout: exactRead(4, length).toString('utf8') };
  } catch (error) {
    if (error?.code === 'UNRECOVERABLE' || error?.code === 'LIMIT_EXCEEDED') throw error;
    fail('UNRECOVERABLE', 'Native Keychain broker unavailable');
  }
}

function brokerRunAsync(request) {
  if (brokerFailed || brokerPending >= 32) return Promise.reject(Error('Native Keychain broker unavailable or busy'));
  brokerPending++;
  const operation = brokerTail.then(async () => {
    if (brokerFailed) fail('UNRECOVERABLE', 'Native Keychain broker unavailable');
    const transfer = async (method, fd, bytes) => {
      let offset = 0;
      while (offset < bytes.length) {
        const count = await new Promise((resolve, reject) => method(fd, bytes, offset, bytes.length - offset, null,
          (error, count) => error ? reject(error) : resolve(count)));
        if (!count) fail('UNRECOVERABLE', 'Native Keychain broker closed');
        offset += count;
      }
      return bytes;
    };
    const body = Buffer.from(JSON.stringify(request));
    if (body.length > 256 * 1024) fail('LIMIT_EXCEEDED', 'Keychain request');
    const frame = Buffer.alloc(4 + body.length); frame.writeUInt32BE(body.length); body.copy(frame, 4);
    await transfer(write, 3, frame);
    const length = (await transfer(read, 4, Buffer.alloc(4))).readUInt32BE();
    if (!length || length > 1024 * 1024) fail('UNRECOVERABLE', 'Invalid Keychain broker response');
    return { status: 0, stdout: (await transfer(read, 4, Buffer.alloc(length))).toString('utf8') };
  }).catch(error => { brokerFailed = true; throw error; }).finally(() => { brokerPending--; });
  brokerTail = operation.catch(() => {});
  return operation;
}

/** Uses the private broker channel inherited from the fixed-purpose native app host. */
export class MacOSKeychainStore {
  #service; #run;
  constructor({ service = DEFAULT_SERVICE, run = null } = {}) {
    if (typeof service !== 'string' || !/^[A-Za-z0-9._-]{1,120}$/.test(service)) fail('INVALID', 'Invalid keychain service');
    if (process.platform !== 'darwin' && run === null) fail('UNSUPPORTED', 'macOS Keychain is required');
    if (run === null && service !== DEFAULT_SERVICE) fail('INVALID', 'Production Keychain service is fixed');
    this.#service = service; this.#run = run;
  }
  #request(operation, account, value) {
    const request = { profile: 'pap-keychain-request/1', operation, service: this.#service, account };
    if (value !== undefined) request.value = b64(value);
    return request;
  }
  #response(operation, result) {
    if (result?.status !== 0) fail('UNRECOVERABLE', 'App-bound Keychain helper failed');
    let response;
    try { response = JSON.parse(result.stdout); } catch { fail('UNRECOVERABLE', 'Invalid Keychain helper response'); }
    if (!response || response.profile !== 'pap-keychain-response/1') fail('UNRECOVERABLE', 'Invalid Keychain helper response');
    if (response.status === 'LOCKED') fail('LOCKED', 'macOS Keychain is locked');
    if (response.status === 'MISSING' && operation === 'get') return null;
    if (response.status !== 'OK') fail('UNRECOVERABLE', 'App-bound Keychain operation failed');
    return response.value;
  }
  #invoke(operation, account, value = undefined) {
    return this.#response(operation, (this.#run ?? brokerRun)(this.#request(operation, account, value)));
  }
  async #invokeAsync(operation, account, value = undefined) {
    return this.#response(operation, await (this.#run ?? brokerRunAsync)(this.#request(operation, account, value)));
  }
  get(account) {
    const value = this.#invoke('get', account);
    return value === null ? null : unb64(value);
  }
  set(account, secret) {
    if (!Buffer.isBuffer(secret) || secret.length === 0) fail('INVALID', 'Secret must be non-empty bytes');
    this.#invoke('set', account, secret);
  }
  delete(account) { this.#invoke('delete', account); }
  async getAsync(account) {
    const value = await this.#invokeAsync('get', account);
    return value === null ? null : unb64(value);
  }
  async setAsync(account, secret) {
    if (!Buffer.isBuffer(secret) || secret.length === 0) fail('INVALID', 'Secret must be non-empty bytes');
    await this.#invokeAsync('set', account, secret);
  }
  async deleteAsync(account) { await this.#invokeAsync('delete', account); }
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
  #directory; #keyStore; #vault = null; #fault; #readerVersion; #retiredKeyRemovalPending = false;
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
  static restoreFile(path, recoveryKey, newDirectory, { keyStore = new MacOSKeychainStore(), fault = () => {} } = {}) {
    const snapshot = inspectRecoveryFile(path, recoveryKey);
    const result = DurableVault.create(newDirectory, { keyStore, fault });
    try {
      const restored = inspectRecoveryFile(path, recoveryKey, { onRecord: (record, bytes) => result.#vault.importRecord(record, bytes) });
      if (restored.packageId !== snapshot.packageId || restored.count !== snapshot.count || restored.head !== snapshot.head) fail('INVALID', 'Recovery input changed');
      return result;
    } catch (error) {
      const header = readVaultHeader(newDirectory); result.close();
      try { keyStore.delete(signingAccount(header.vaultId)); } catch {}
      try { keyStore.delete(vaultAccount(header.vaultId, header.keyId)); } catch {}
      rmSync(newDirectory, { recursive: true, force: true }); throw error;
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
      this.#reconcileKeyRetirements();
      return this;
    } catch (error) {
      this.#vault?.close(); this.#vault = null; throw error;
    } finally { vmk?.fill(0); storedSigning?.fill(0); }
  }
  lock() { if (this.#vault) { this.#vault.close(); this.#vault = null; } }
  close() { this.lock(); }
  capture(bytes, options) { return this.#require().capture(bytes, options); }
  inspect() { return this.#require().inspect(); }
  get checkpoint() { return this.#require().checkpoint; }
  recoveryFitsJSON() { return this.#require().recoveryFitsJSON(); }
  get recordCount() { return this.#require().recordCount; }
  hasObject(digest) { return this.#require().hasObject(digest); }
  getRecord(id) { return this.#require().getRecord(id); }
  lookupRecords(field, value, options) { return this.#require().lookupRecords(field, value, options); }
  recordPage(options) { return this.#require().recordPage(options); }
  records() { return this.#require().records(); }
  rebuildIndexes() { return this.#require().rebuildIndexes(); }
  historyCounts() { return this.#require().historyCounts(); }
  readState(name) { return this.#require().readState(name); }
  writeState(name, value) { return this.#require().writeState(name, value); }
  metrics(options) { return this.#require().metrics(options); }
  get revision() { return this.#require().revision; }
  get remainingRecordCapacity() { return this.#require().remainingRecordCapacity; }
  requireRecordCapacity(count) { return this.#require().requireRecordCapacity(count); }
  read(digest) { return this.#require().read(digest); }
  verifyAll() { return this.#require().verifyAll(); }
  exportDisclosure(recordIds, options) { return this.#require().exportDisclosure(recordIds, options); }
  exportRecoveryFile(path) { return exportRecoveryFile(this.#require(), path); }
  exportRecovery() { return this.#require().exportRecovery(); }
  retentionStatus() { return this.#require().retentionStatus(); }
  schemaInfo() { return this.#require().schemaInfo(); }
  status() {
    const vault = this.#require();
    return { locked: false, vaultId: vault.vaultId, vaultKeyId: vault.keyId,
      signingPublicKey: vault.signingPublicKey, schema: vault.schemaInfo(), historicalSendAuthorization: 'NONE',
      retiredKeyRemovalPending: this.#retiredKeyRemovalPending || vault.pendingKeyRetirements().length > 0 };
  }
  #reconcileKeyRetirements() {
    const vault = this.#require(); let pending = false;
    for (const intent of vault.pendingKeyRetirements()) {
      let obsoleteKeyId;
      if (vault.keyId === intent.replacementKeyId) obsoleteKeyId = intent.retiredKeyId;
      else if (vault.keyId === intent.retiredKeyId) obsoleteKeyId = intent.replacementKeyId;
      else fail('UNRECOVERABLE', 'Key retirement does not match the active vault key');
      try {
        this.#keyStore.delete(vaultAccount(vault.vaultId, obsoleteKeyId));
        vault.completeKeyRetirement(intent.retiredKeyId, intent.replacementKeyId);
      } catch { pending = true; }
    }
    this.#retiredKeyRemovalPending = pending;
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
    try {
      vault.beginKeyRetirement(oldKeyId, newKeyId);
      this.#keyStore.set(newAccount, replacement);
      vault.rotate(replacement);
      this.#fault('rotation-after-db-commit');
      let retiredKeyRemovalPending = false;
      try {
        this.#keyStore.delete(vaultAccount(vault.vaultId, oldKeyId));
        vault.completeKeyRetirement(oldKeyId, newKeyId);
      }
      catch { retiredKeyRemovalPending = true; }
      this.#retiredKeyRemovalPending = retiredKeyRemovalPending;
      return { vaultKeyId: newKeyId, retiredKeyRemovalPending };
    } catch (error) {
      // If the durable header still points at the old key, the replacement was
      // never activated and its exact, newly-created keychain item is safe to remove.
      if (readVaultHeader(this.#directory).keyId === oldKeyId) {
        try {
          this.#keyStore.delete(newAccount);
          vault.completeKeyRetirement(oldKeyId, newKeyId);
        } catch {}
      }
      throw error;
    } finally { replacement.fill(0); }
  }
}
