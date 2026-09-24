import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { LIMITS, VaultError, canonical, parseCanonical, b64, unb64, hash, objectDigest, encrypt, decrypt, aad, keys, fail } from './format.mjs';
import { identity, makeRecord, verifyRecord, disclosureObject, publicProofDigest } from './records.mjs';

const MAX_WRAPS = 2 ** 20;
const CURRENT_SCHEMA = 3;
const MINIMUM_READER = 1;
const id = () => b64(randomBytes(16));
export const vaultKeyId = key => b64(hash('PAP/local-vmk-id/v1\0', key));
const wire = value => Buffer.from(canonical(value));
function goodRecord(record, bytes) {
  const result = verifyRecord(record, bytes);
  if (result.structure !== 'VALID' || result.integrity !== 'VALID' || result.keyAttribution !== 'SIGNATURE_VALID') {
    fail(result.integrity === 'INCOMPLETE' ? 'INCOMPLETE' : 'INVALID', 'Record/evidence check failed');
  }
}

export class Vault {
  #db; #vmk; #signing; #fault; #closed = false; #baselines = new WeakMap();
  #indexCache = null; #revision = null;
  constructor(directory, vmk, signing = identity(), { create = false, fault = () => {}, vaultId = null,
    readerVersion = CURRENT_SCHEMA } = {}) {
    if (!Buffer.isBuffer(vmk) || vmk.length !== 32) fail('UNRECOVERABLE', 'A separate 32-byte vault key is required');
    if (!Number.isInteger(readerVersion) || readerVersion < MINIMUM_READER || readerVersion > CURRENT_SCHEMA) fail('UNSUPPORTED', 'Vault reader version');
    if (create) mkdirSync(directory, { mode: 0o700 });
    else if (!existsSync(join(directory, 'vault.sqlite'))) fail('UNRECOVERABLE', 'Vault database missing');
    this.#vmk = Buffer.from(vmk); this.#signing = signing; this.#fault = fault;
    this.#db = new DatabaseSync(join(directory, 'vault.sqlite'), { open: true, readOnly: false });
    try {
      this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0;');
      if (create) {
        chmodSync(join(directory, 'vault.sqlite'), 0o600);
        this.#db.exec('CREATE TABLE meta (id INTEGER PRIMARY KEY CHECK(id=1), vault_id TEXT NOT NULL, key_hash TEXT NOT NULL, envelope BLOB); CREATE TABLE usage (key_hash TEXT PRIMARY KEY, counter INTEGER NOT NULL); CREATE TABLE blobs (id TEXT PRIMARY KEY, envelope BLOB NOT NULL);');
        const selectedVaultId = vaultId ?? id(); unb64(selectedVaultId, 16);
        this.#db.prepare('INSERT INTO meta VALUES (1, ?, ?, NULL)').run(selectedVaultId, vaultKeyId(vmk));
        this.#db.prepare('INSERT INTO usage VALUES (?, 0)').run(vaultKeyId(vmk));
        const state = { profile: 'pap-vault-index-spike/1', objects: [], records: [], checkpoint: '0' };
        const envelope = this.#box(wire(state), 'index', 'index');
        this.#db.prepare('UPDATE meta SET envelope=? WHERE id=1').run(wire(envelope));
      }
      if (this.#db.prepare('PRAGMA user_version').get().user_version > CURRENT_SCHEMA) fail('UNSUPPORTED', 'Vault schema requires a newer reader');
      this.#assertKey(); this.#readIndex();
      this.#migrate(readerVersion);
    } catch (e) { this.#db.close(); throw e; }
  }
  #meta() { return this.#db.prepare('SELECT * FROM meta WHERE id=1').get(); }
  #migrate(readerVersion) {
    const storedVersion = this.#db.prepare('PRAGMA user_version').get().user_version;
    if (!Number.isInteger(storedVersion) || storedVersion < 0 || storedVersion > CURRENT_SCHEMA) fail('UNSUPPORTED', 'Vault schema is newer than this application');
    const diskVersion = storedVersion || 1;
    const table = this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='vault_schema'").get();
    if (diskVersion > 1 && !table) fail('UNSUPPORTED', 'Vault schema compatibility metadata missing');
    if (table) {
      const info = this.#db.prepare('SELECT writer_version, minimum_reader FROM vault_schema WHERE id=1').get();
      if (!info || !Number.isInteger(info.minimum_reader) || info.minimum_reader < 1
          || info.minimum_reader > diskVersion || info.minimum_reader > readerVersion
          || info.writer_version !== diskVersion) fail('UNSUPPORTED', 'Incompatible vault schema');
    }
    if (readerVersion < CURRENT_SCHEMA || diskVersion === CURRENT_SCHEMA) return;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db.exec('CREATE TABLE IF NOT EXISTS vault_schema (id INTEGER PRIMARY KEY CHECK(id=1), writer_version INTEGER NOT NULL, minimum_reader INTEGER NOT NULL);');
      this.#db.exec('CREATE TABLE IF NOT EXISTS key_retirements (id INTEGER PRIMARY KEY CHECK(id=1), retired_key_hash TEXT NOT NULL, replacement_key_hash TEXT NOT NULL);');
      this.#db.prepare('INSERT INTO vault_schema VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET writer_version=excluded.writer_version, minimum_reader=excluded.minimum_reader').run(CURRENT_SCHEMA, MINIMUM_READER);
      this.#fault('migration-after-ddl');
      this.#db.exec(`PRAGMA user_version=${CURRENT_SCHEMA}`);
      this.#fault('migration-before-commit');
      this.#db.exec('COMMIT');
      this.#fault('migration-after-commit');
    } catch (e) {
      if (this.#db.isTransaction) { this.#db.exec('ROLLBACK'); throw e; }
      const version = this.#db.prepare('PRAGMA user_version').get().user_version;
      const info = this.#db.prepare('SELECT writer_version, minimum_reader FROM vault_schema WHERE id=1').get();
      if (version !== CURRENT_SCHEMA || info?.writer_version !== CURRENT_SCHEMA) throw e;
    }
  }
  #assertKey() {
    if (this.#closed) fail('UNRECOVERABLE', 'Vault closed');
    const meta = this.#meta();
    if (!meta?.envelope || meta.key_hash !== vaultKeyId(this.#vmk)) fail('UNRECOVERABLE', 'Wrong key or incomplete vault');
    const usage = this.#db.prepare('SELECT counter FROM usage WHERE key_hash=?').get(meta.key_hash);
    if (!usage || !Number.isSafeInteger(usage.counter) || usage.counter < 1 || usage.counter > MAX_WRAPS) fail('UNRECOVERABLE', 'Nonce reservation state missing');
  }
  get vaultId() { return this.#db.prepare('SELECT vault_id FROM meta WHERE id=1').get().vault_id; }
  get keyId() { return this.#db.prepare('SELECT key_hash FROM meta WHERE id=1').get().key_hash; }
  get revision() { this.#readIndex(); return this.#revision; }
  get remainingRecordCapacity() { return LIMITS.objects - this.#readIndex().records.length; }
  requireRecordCapacity(count = 1) {
    if (!Number.isSafeInteger(count) || count < 1) fail('INVALID');
    if (this.remainingRecordCapacity < count) fail('VAULT_CAPACITY_EXHAUSTED');
  }
  get signingPublicKey() { return this.#signing ? this.#signing.publicKey.export({ format: 'jwk' }).x : null; }
  schemaInfo() {
    if (!this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='vault_schema'").get()) {
      return { writerVersion: 1, minimumReader: 1 };
    }
    const row = this.#db.prepare('SELECT writer_version, minimum_reader FROM vault_schema WHERE id=1').get();
    return row ? { writerVersion: row.writer_version, minimumReader: row.minimum_reader } : { writerVersion: 1, minimumReader: 1 };
  }
  setSigningIdentity(signing) {
    if (!signing?.privateKey || !signing?.publicKey) fail('UNRECOVERABLE', 'Signing identity missing');
    this.#signing = signing;
  }
  pendingKeyRetirements() {
    const table = this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='key_retirements'").get();
    if (!table) return [];
    const rows = this.#db.prepare('SELECT retired_key_hash, replacement_key_hash FROM key_retirements ORDER BY id').all();
    for (const row of rows) { unb64(row.retired_key_hash, 32); unb64(row.replacement_key_hash, 32); }
    return rows.map(row => ({ retiredKeyId: row.retired_key_hash, replacementKeyId: row.replacement_key_hash }));
  }
  beginKeyRetirement(retiredKeyId, replacementKeyId) {
    unb64(retiredKeyId, 32); unb64(replacementKeyId, 32);
    if (retiredKeyId === replacementKeyId || this.keyId !== retiredKeyId) fail('INVALID', 'Invalid key retirement transition');
    const pending = this.pendingKeyRetirements();
    if (pending.length && !pending.some(row => row.retiredKeyId === retiredKeyId && row.replacementKeyId === replacementKeyId)) {
      fail('CONFLICT', 'Another key retirement is pending');
    }
    if (pending.length) return;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db.prepare('INSERT INTO key_retirements VALUES (1, ?, ?)').run(retiredKeyId, replacementKeyId);
      this.#fault('retirement-intent-before-commit');
      this.#db.exec('COMMIT');
    } catch (error) { if (this.#db.isTransaction) this.#db.exec('ROLLBACK'); throw error; }
  }
  completeKeyRetirement(retiredKeyId, replacementKeyId) {
    unb64(retiredKeyId, 32); unb64(replacementKeyId, 32);
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db.prepare('DELETE FROM key_retirements WHERE retired_key_hash=? AND replacement_key_hash=?').run(retiredKeyId, replacementKeyId);
      this.#db.exec('COMMIT');
    } catch (error) { if (this.#db.isTransaction) this.#db.exec('ROLLBACK'); throw error; }
  }
  // Reserve and fsync a unique VMK nonce BEFORE encryption. Crashes only burn reservations.
  #nonce(key = this.#vmk) {
    const kh = vaultKeyId(key);
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.#db.prepare('SELECT counter FROM usage WHERE key_hash=?').get(kh);
      if (!row || !Number.isSafeInteger(row.counter) || row.counter < 0) fail('UNRECOVERABLE', 'Nonce state');
      if (row.counter >= MAX_WRAPS) fail('LIMIT_EXCEEDED', 'VMK rotation required');
      this.#db.prepare('UPDATE usage SET counter=counter+1 WHERE key_hash=?').run(kh);
      this.#db.exec('COMMIT');
      const nonce = Buffer.alloc(12); nonce.writeBigUInt64BE(BigInt(row.counter + 1), 4); return nonce;
    } catch (e) { if (this.#db.isTransaction) this.#db.exec('ROLLBACK'); throw e; }
  }
  #box(bytes, role, objectId, packageId = null, snapshotId = null, key = this.#vmk) {
    const dek = randomBytes(32);
    const payload = encrypt(dek, bytes, aad(role === 'recovery-manifest' ? 'PAP/recovery-manifest/v1' : 'PAP/blob/v1', this.vaultId, role, objectId, packageId, snapshotId));
    const wrappedKey = encrypt(key, dek, aad('PAP/wrapped-dek/v1', this.vaultId, role, objectId, packageId, snapshotId), this.#nonce(key));
    dek.fill(0);
    return { payload, wrappedKey };
  }
  #unbox(box, role, objectId, packageId = null, snapshotId = null, key = this.#vmk, max = LIMITS.total) {
    return unbox(box, key, this.vaultId, role, objectId, packageId, snapshotId, max);
  }
  #readIndex({ mutable = false, refresh = false } = {}) {
    if (this.#closed) fail('UNRECOVERABLE', 'Vault closed');
    const dataVersion = this.#db.prepare('PRAGMA data_version').get().data_version;
    // Cache only this connection's authenticated snapshot. Other connections'
    // commits invalidate it even when only a ciphertext or nonce counter changed.
    // Writers receive detached copies and retain the original conflict baseline.
    if (!refresh && this.#indexCache?.dataVersion === dataVersion) {
      const state = mutable ? structuredClone(this.#indexCache.state) : this.#indexCache.state;
      this.#baselines.set(state, this.#indexCache.baseline); return state;
    }
    this.#assertKey();
    const baseline = Buffer.from(this.#meta().envelope);
    const envelope = parseCanonical(baseline);
    const counter = this.#db.prepare('SELECT counter FROM usage WHERE key_hash=?').get(vaultKeyId(this.#vmk)).counter;
    if (unb64(envelope.wrappedKey.nonce, 12).readBigUInt64BE(4) > BigInt(counter)) fail('UNRECOVERABLE', 'Nonce reservation rollback');
    const state = parseCanonical(this.#unbox(envelope, 'index', 'index', null, null, this.#vmk, LIMITS.manifest), LIMITS.manifest);
    validateIndex(state);
    this.#indexCache = { dataVersion, state, baseline }; this.#revision = Symbol('authenticated-vault-snapshot');
    const result = mutable ? structuredClone(state) : state;
    this.#baselines.set(result, baseline);
    return result;
  }
  #commit(index, additions = [], replacementKey = null) {
    const bytes = wire(index); if (bytes.length > LIMITS.manifest) fail('LIMIT_EXCEEDED', 'Index manifest');
    const box = this.#box(bytes, 'index', 'index', null, null, replacementKey ?? this.#vmk);
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      if (!Buffer.from(this.#meta().envelope).equals(this.#baselines.get(index))) fail('CONFLICT', 'Concurrent writer changed snapshot');
      this.#fault('before-write');
      for (const [blobId, envelope] of additions) this.#db.prepare('INSERT OR REPLACE INTO blobs VALUES (?, ?)').run(blobId, wire(envelope));
      this.#fault('after-objects');
      this.#db.prepare('UPDATE meta SET envelope=?, key_hash=? WHERE id=1').run(wire(box), vaultKeyId(replacementKey ?? this.#vmk));
      this.#fault('before-commit');
      this.#db.exec('COMMIT');
      this.#fault('after-commit');
    } catch (e) { if (this.#db.isTransaction) this.#db.exec('ROLLBACK'); throw e; }
    finally { this.#indexCache = null; }
  }
  capture(input, options = {}) {
    const bytes = Buffer.from(input); if (bytes.length > LIMITS.object) fail('LIMIT_EXCEEDED', 'Object size');
    const index = this.#readIndex({ mutable: true });
    if (index.records.length >= LIMITS.objects) fail('VAULT_CAPACITY_EXHAUSTED');
    const digest = objectDigest(bytes), additions = [];
    if (index.objects.some(o => o.digest === digest)) {
      if (!this.read(digest).equals(bytes)) fail('INVALID', 'Deduplication content mismatch');
    } else {
      if (index.objects.length >= LIMITS.objects || index.objects.reduce((n, o) => n + Number(o.length), 0) + bytes.length > LIMITS.total) fail('LIMIT_EXCEEDED');
      const blobId = id();
      additions.push([blobId, this.#box(bytes, 'evidence', digest)]);
      index.objects.push({ id: blobId, digest, length: String(bytes.length) });
    }
    const record = makeRecord(bytes, this.#signing, BigInt(index.checkpoint) + 1n, index.records.at(-1)?.recordDigest ?? null, options);
    goodRecord(record, bytes);
    index.records.push(record); index.checkpoint = record.manifest.sequence;
    this.#commit(index, additions);
    return structuredClone(record);
  }
  inspect() { return structuredClone(this.#readIndex()); }
  read(digest) {
    const index = this.#readIndex(), object = index.objects.find(o => o.digest === digest);
    if (!object) fail('INCOMPLETE', 'Missing evidence reference');
    const row = this.#db.prepare('SELECT envelope FROM blobs WHERE id=?').get(object.id);
    if (!row) fail('INCOMPLETE', 'Missing evidence ciphertext');
    const bytes = this.#unbox(parseCanonical(row.envelope), 'evidence', digest, null, null, this.#vmk, LIMITS.object);
    if (objectDigest(bytes) !== digest || bytes.length !== Number(object.length)) fail('INVALID', 'Evidence mismatch');
    return bytes;
  }
  verifyAll() {
    const index = this.#readIndex({ refresh: true });
    for (const record of index.records) goodRecord(record, this.read(record.manifest.evidence[0].objectDigest));
    return { snapshot: 'COMPLETE', latestState: 'NOT_PROVEN', count: index.records.length };
  }
  rotate(newKey) {
    if (!Buffer.isBuffer(newKey) || newKey.length !== 32) fail('UNRECOVERABLE');
    const index = this.#readIndex(); this.verifyAll();
    const newKeyId = vaultKeyId(newKey);
    if (this.#db.prepare('SELECT 1 FROM usage WHERE key_hash=?').get(newKeyId)) fail('INVALID', 'VMK reuse forbidden');
    this.#db.prepare('INSERT INTO usage VALUES (?, 0)').run(newKeyId);
    const additions = index.objects.map(o => {
      const box = parseCanonical(this.#db.prepare('SELECT envelope FROM blobs WHERE id=?').get(o.id).envelope);
      const wrappingAAD = aad('PAP/wrapped-dek/v1', this.vaultId, 'evidence', o.digest);
      const dek = decrypt(this.#vmk, box.wrappedKey, wrappingAAD, 32);
      box.wrappedKey = encrypt(newKey, dek, wrappingAAD, this.#nonce(newKey)); dek.fill(0);
      return [o.id, box];
    });
    try { this.#commit(index, additions, newKey); }
    catch (e) {
      // A post-commit interruption must not leave the live object holding the old
      // key while the durable header already selects the replacement.
      if (this.#meta().key_hash !== newKeyId) throw e;
    }
    this.#vmk.fill(0); this.#vmk = Buffer.from(newKey);
  }
  retentionStatus() {
    const index = this.#readIndex();
    return { policy: 'APPEND_ONLY', records: index.records.length, objects: index.objects.length,
      reclaimableObjects: 0, reason: 'Every object is reachable from retained signed records; MVP garbage collection is disabled.' };
  }
  exportDisclosure(recordIds, { includeEvidence = true, publicProofs = [] } = {}) {
    const index = this.#readIndex();
    if (!Array.isArray(recordIds) || new Set(recordIds).size !== recordIds.length) fail('INVALID');
    const records = recordIds.map(eventId => {
      const r = index.records.find(r => r.manifest.eventId === eventId); if (!r) fail('INCOMPLETE'); return r;
    });
    const digests = [...new Set(records.map(r => r.manifest.evidence[0].objectDigest))];
    const objects = includeEvidence ? digests.map(d => disclosureObject(this.read(d))) : [];
    if (!Array.isArray(publicProofs) || publicProofs.length > LIMITS.entries) fail('LIMIT_EXCEEDED');
    if (!publicProofs.length) return wire({ profile: 'pap-disclosure-spike/1', scope: 'SELECTIVE', records, objects });
    const selected = new Set(records.map(record => record.recordDigest)), proofObjects = new Map(), references = [];
    let proofBytes = 0;
    for (const entry of publicProofs) {
      if (!entry || Object.keys(entry).sort().join(',') !== 'bytes,recordDigest' || !selected.has(entry.recordDigest)) fail('INVALID', 'Public proof does not reference a selected record');
      const bytes = Buffer.from(entry.bytes); if (bytes.length > LIMITS.total) fail('LIMIT_EXCEEDED');
      const digest = publicProofDigest(bytes);
      if (!proofObjects.has(digest)) {
        proofBytes += bytes.length; if (proofBytes > LIMITS.total) fail('LIMIT_EXCEEDED');
        proofObjects.set(digest, { digest, bytes: disclosureObject(bytes).bytes });
      }
      references.push({ recordDigest: entry.recordDigest, proofDigest: digest });
    }
    if (proofObjects.size > LIMITS.objects) fail('LIMIT_EXCEEDED');
    if (new Set(references.map(reference => `${reference.recordDigest}:${reference.proofDigest}`)).size !== references.length) fail('INVALID', 'Duplicate public proof reference');
    return wire({ profile: 'pap-disclosure-spike/2', scope: 'SELECTIVE', records, objects,
      publicProofObjects: [...proofObjects.values()], publicProofReferences: references });
  }
  exportRecovery() {
    const index = this.#readIndex(); this.verifyAll();
    const packageId = id(), snapshotId = id(), recoveryKey = randomBytes(32);
    const blobs = index.objects.map(o => ({ id: o.id, box: parseCanonical(this.#db.prepare('SELECT envelope FROM blobs WHERE id=?').get(o.id).envelope) }));
    const manifest = { profile: 'pap-recovery-manifest-spike/1', cryptoProfile: 'pap-poc-crypto/1',
      vaultId: this.vaultId, packageId, snapshotId, scope: 'ALL_RETAINED_AT_CHECKPOINT', checkpoint: index.checkpoint,
      index, inventory: blobs.map(b => ({ id: b.id, ciphertextDigest: b64(hash(wire(b.box))), encodedLength: String(wire(b.box).length) })),
      objectCount: String(blobs.length), recordCount: String(index.records.length), excluded: [], anchors: [] };
    const manifestBytes = wire(manifest); if (manifestBytes.length > LIMITS.manifest) fail('LIMIT_EXCEEDED', 'Snapshot manifest');
    const encryptedManifest = this.#box(manifestBytes, 'recovery-manifest', snapshotId, packageId, snapshotId);
    const wrappedVMK = encrypt(recoveryKey, this.#vmk, aad('PAP/recovery-vmk/v1', this.vaultId, 'vmk', 'vmk', packageId, snapshotId));
    return { recoveryKey, package: wire({ profile: 'pap-recovery-spike/1', vaultId: this.vaultId, packageId, snapshotId,
      wrappedVMK, encryptedManifest, blobs }) };
  }
  importRecovered(recovered) {
    const index = this.#readIndex({ mutable: true });
    if (index.records.length) fail('INVALID', 'Restore requires empty destination');
    const additions = [];
    for (const record of recovered.records) goodRecord(record, recovered.objects.get(record.manifest.evidence[0].objectDigest));
    for (const [digest, bytes] of recovered.objects) {
      if (objectDigest(bytes) !== digest) fail('INVALID');
      const blobId = id(); additions.push([blobId, this.#box(bytes, 'evidence', digest)]);
      index.objects.push({ id: blobId, digest, length: String(bytes.length) });
    }
    index.records = structuredClone(recovered.records); index.checkpoint = recovered.checkpoint;
    validateIndex(index); this.#commit(index, additions);
  }
  close() { if (!this.#closed) { this.#db.close(); this.#vmk.fill(0); this.#signing = null; this.#indexCache = null; this.#closed = true; } }
}

export function readVaultHeader(directory) {
  const path = join(directory, 'vault.sqlite');
  if (!existsSync(path)) fail('UNRECOVERABLE', 'Vault database missing');
  const db = new DatabaseSync(path, { open: true, readOnly: true });
  try {
    const meta = db.prepare('SELECT vault_id, key_hash FROM meta WHERE id=1').get();
    if (!meta) fail('UNRECOVERABLE', 'Vault header missing');
    unb64(meta.vault_id, 16); unb64(meta.key_hash, 32);
    const schemaVersion = db.prepare('PRAGMA user_version').get().user_version || 1;
    if (schemaVersion > 4) fail('UNSUPPORTED', 'Vault schema is newer than this application');
    return { vaultId: meta.vault_id, keyId: meta.key_hash, schemaVersion };
  } finally { db.close(); }
}

function unbox(box, key, vaultId, role, objectId, packageId = null, snapshotId = null, max = LIMITS.total) {
  keys(box, ['payload', 'wrappedKey']);
  const dek = decrypt(key, box.wrappedKey, aad('PAP/wrapped-dek/v1', vaultId, role, objectId, packageId, snapshotId), 32);
  try { return decrypt(dek, box.payload, aad(role === 'recovery-manifest' ? 'PAP/recovery-manifest/v1' : 'PAP/blob/v1', vaultId, role, objectId, packageId, snapshotId), max); }
  finally { dek.fill(0); }
}
function validateIndex(index) {
  keys(index, ['profile', 'objects', 'records', 'checkpoint']);
  if (index.profile !== 'pap-vault-index-spike/1') fail('UNSUPPORTED');
  if (!Array.isArray(index.objects) || !Array.isArray(index.records) || index.objects.length > LIMITS.objects
      || index.records.length > LIMITS.objects) fail('LIMIT_EXCEEDED');
  if (index.checkpoint !== String(index.records.length)) fail('INVALID', 'Checkpoint mismatch');
  const ids = new Set(), digests = new Set(); let total = 0;
  for (const o of index.objects) {
    keys(o, ['id', 'digest', 'length']); unb64(o.id, 16); unb64(o.digest, 32);
    if (ids.has(o.id) || digests.has(o.digest) || typeof o.length !== 'string' || !/^(0|[1-9][0-9]{0,8})$/.test(o.length)) fail('INVALID');
    if (Number(o.length) > LIMITS.object || (total += Number(o.length)) > LIMITS.total) fail('LIMIT_EXCEEDED');
    ids.add(o.id); digests.add(o.digest);
  }
  const events = new Set();
  for (const [i, r] of index.records.entries()) {
    const ref = r.manifest?.evidence?.[0];
    if (!ref || !digests.has(ref.objectDigest)) fail('INCOMPLETE', 'Record reference missing');
    if (r.manifest.sequence !== String(i + 1) || r.manifest.previousRecordDigest !== (index.records[i - 1]?.recordDigest ?? null)
        || events.has(r.manifest.eventId)) fail('INVALID', 'Record ordering/identity');
    events.add(r.manifest.eventId);
  }
  if (digests.size !== new Set(index.records.map(r => r.manifest.evidence[0].objectDigest)).size) fail('INVALID', 'Unreferenced object');
}

export function inspectRecovery(input, recoveryKey) {
  if (!Buffer.isBuffer(recoveryKey) || recoveryKey.length !== 32) fail('UNRECOVERABLE', 'Separate recovery secret required');
  const pkg = parseCanonical(input);
  keys(pkg, ['profile', 'vaultId', 'packageId', 'snapshotId', 'wrappedVMK', 'encryptedManifest', 'blobs']);
  if (pkg.profile !== 'pap-recovery-spike/1') fail('UNSUPPORTED');
  for (const key of ['vaultId', 'packageId', 'snapshotId']) unb64(pkg[key], 16);
  if (!Array.isArray(pkg.blobs) || pkg.blobs.length > LIMITS.objects) fail('LIMIT_EXCEEDED');
  const vmk = decrypt(recoveryKey, pkg.wrappedVMK, aad('PAP/recovery-vmk/v1', pkg.vaultId, 'vmk', 'vmk', pkg.packageId, pkg.snapshotId), 32);
  try {
    const manifest = parseCanonical(unbox(pkg.encryptedManifest, vmk, pkg.vaultId, 'recovery-manifest', pkg.snapshotId, pkg.packageId, pkg.snapshotId, LIMITS.manifest), LIMITS.manifest);
    keys(manifest, ['profile', 'cryptoProfile', 'vaultId', 'packageId', 'snapshotId', 'scope', 'checkpoint', 'index', 'inventory', 'objectCount', 'recordCount', 'excluded', 'anchors']);
    if (manifest.profile !== 'pap-recovery-manifest-spike/1' || manifest.cryptoProfile !== 'pap-poc-crypto/1') fail('UNSUPPORTED');
    if (manifest.vaultId !== pkg.vaultId || manifest.packageId !== pkg.packageId || manifest.snapshotId !== pkg.snapshotId
        || manifest.scope !== 'ALL_RETAINED_AT_CHECKPOINT' || canonical(manifest.excluded) !== '[]' || canonical(manifest.anchors) !== '[]') fail('INVALID');
    validateIndex(manifest.index);
    if (!Array.isArray(manifest.inventory) || manifest.objectCount !== String(manifest.index.objects.length)
        || manifest.recordCount !== String(manifest.index.records.length) || manifest.checkpoint !== manifest.index.checkpoint
        || manifest.inventory.length !== manifest.index.objects.length || pkg.blobs.length !== manifest.inventory.length) fail('INCOMPLETE', 'Snapshot inventory mismatch');
    const byId = new Map();
    for (const blob of pkg.blobs) { keys(blob, ['id', 'box']); unb64(blob.id, 16); if (byId.has(blob.id)) fail('INVALID'); byId.set(blob.id, blob.box); }
    const objects = new Map(); let total = 0; const visited = new Set();
    for (const item of manifest.inventory) {
      keys(item, ['id', 'ciphertextDigest', 'encodedLength']);
      if (visited.has(item.id)) fail('INVALID'); visited.add(item.id);
      const object = manifest.index.objects.find(o => o.id === item.id), box = byId.get(item.id);
      if (!object || !box) fail('INCOMPLETE', 'Missing inventory blob');
      if (b64(hash(wire(box))) !== item.ciphertextDigest || String(wire(box).length) !== item.encodedLength) fail('INVALID', 'Ciphertext inventory mismatch');
      const bytes = unbox(box, vmk, pkg.vaultId, 'evidence', object.digest, null, null, LIMITS.object);
      total += bytes.length; if (total > LIMITS.total) fail('LIMIT_EXCEEDED');
      if (String(bytes.length) !== object.length || objectDigest(bytes) !== object.digest) fail('INVALID');
      objects.set(object.digest, bytes);
    }
    for (const record of manifest.index.records) goodRecord(record, objects.get(record.manifest.evidence[0].objectDigest));
    return { snapshot: 'COMPLETE', latestState: 'NOT_PROVEN', snapshotId: pkg.snapshotId, checkpoint: manifest.checkpoint,
      records: structuredClone(manifest.index.records), objects };
  } finally { vmk.fill(0); }
}

export function restoreRecovery(input, recoveryKey, newDirectory, newVMK, signing = identity()) {
  // Authenticate the entire snapshot before creating or writing the restore destination.
  const recovered = inspectRecovery(input, recoveryKey);
  const vault = new Vault(newDirectory, newVMK, signing, { create: true });
  try {
    vault.importRecovered(recovered);
    return vault;
  } catch (e) { vault.close(); throw e; }
}
