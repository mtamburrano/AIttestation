import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { LIMITS, VaultError, canonical, parseCanonical, b64, unb64, hash, objectDigest, encrypt, decrypt, aad, keys, fail } from './format.mjs';
import { identity, makeRecord, verifyRecord, disclosureObject } from './records.mjs';

const MAX_WRAPS = 2 ** 20;
const id = () => b64(randomBytes(16));
const keyHash = key => b64(hash('PAP/local-vmk-id/v1\0', key));
const wire = value => Buffer.from(canonical(value));
function goodRecord(record, bytes) {
  const result = verifyRecord(record, bytes);
  if (result.structure !== 'VALID' || result.integrity !== 'VALID' || result.keyAttribution !== 'SIGNATURE_VALID') {
    fail(result.integrity === 'INCOMPLETE' ? 'INCOMPLETE' : 'INVALID', 'Record/evidence check failed');
  }
}

export class Vault {
  #db; #vmk; #signing; #fault; #closed = false; #baselines = new WeakMap();
  constructor(directory, vmk, signing = identity(), { create = false, fault = () => {} } = {}) {
    if (!Buffer.isBuffer(vmk) || vmk.length !== 32) fail('UNRECOVERABLE', 'A separate 32-byte vault key is required');
    if (create) mkdirSync(directory, { mode: 0o700 });
    else if (!existsSync(join(directory, 'vault.sqlite'))) fail('UNRECOVERABLE', 'Vault database missing');
    this.#vmk = Buffer.from(vmk); this.#signing = signing; this.#fault = fault;
    this.#db = new DatabaseSync(join(directory, 'vault.sqlite'), { open: true, readOnly: false });
    try {
      this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0;');
      if (create) {
        chmodSync(join(directory, 'vault.sqlite'), 0o600);
        this.#db.exec('CREATE TABLE meta (id INTEGER PRIMARY KEY CHECK(id=1), vault_id TEXT NOT NULL, key_hash TEXT NOT NULL, envelope BLOB); CREATE TABLE usage (key_hash TEXT PRIMARY KEY, counter INTEGER NOT NULL); CREATE TABLE blobs (id TEXT PRIMARY KEY, envelope BLOB NOT NULL);');
        this.#db.prepare('INSERT INTO meta VALUES (1, ?, ?, NULL)').run(id(), keyHash(vmk));
        this.#db.prepare('INSERT INTO usage VALUES (?, 0)').run(keyHash(vmk));
        const state = { profile: 'pap-vault-index-spike/1', objects: [], records: [], checkpoint: '0' };
        const envelope = this.#box(wire(state), 'index', 'index');
        this.#db.prepare('UPDATE meta SET envelope=? WHERE id=1').run(wire(envelope));
      }
      this.#assertKey(); this.#readIndex();
    } catch (e) { this.#db.close(); throw e; }
  }
  #meta() { return this.#db.prepare('SELECT * FROM meta WHERE id=1').get(); }
  #assertKey() {
    if (this.#closed) fail('UNRECOVERABLE', 'Vault closed');
    const meta = this.#meta();
    if (!meta?.envelope || meta.key_hash !== keyHash(this.#vmk)) fail('UNRECOVERABLE', 'Wrong key or incomplete vault');
    const usage = this.#db.prepare('SELECT counter FROM usage WHERE key_hash=?').get(meta.key_hash);
    if (!usage || !Number.isSafeInteger(usage.counter) || usage.counter < 1 || usage.counter > MAX_WRAPS) fail('UNRECOVERABLE', 'Nonce reservation state missing');
  }
  get vaultId() { return this.#meta().vault_id; }
  // Reserve and fsync a unique VMK nonce BEFORE encryption. Crashes only burn reservations.
  #nonce(key = this.#vmk) {
    const kh = keyHash(key);
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
  #readIndex() {
    this.#assertKey();
    const baseline = Buffer.from(this.#meta().envelope);
    const envelope = parseCanonical(baseline);
    const counter = this.#db.prepare('SELECT counter FROM usage WHERE key_hash=?').get(keyHash(this.#vmk)).counter;
    if (unb64(envelope.wrappedKey.nonce, 12).readBigUInt64BE(4) > BigInt(counter)) fail('UNRECOVERABLE', 'Nonce reservation rollback');
    const state = parseCanonical(this.#unbox(envelope, 'index', 'index', null, null, this.#vmk, LIMITS.manifest), LIMITS.manifest);
    validateIndex(state);
    this.#baselines.set(state, baseline);
    return state;
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
      this.#db.prepare('UPDATE meta SET envelope=?, key_hash=? WHERE id=1').run(wire(box), keyHash(replacementKey ?? this.#vmk));
      this.#fault('before-commit');
      this.#db.exec('COMMIT');
      this.#fault('after-commit');
    } catch (e) { if (this.#db.isTransaction) this.#db.exec('ROLLBACK'); throw e; }
  }
  capture(input) {
    const bytes = Buffer.from(input); if (bytes.length > LIMITS.object) fail('LIMIT_EXCEEDED', 'Object size');
    const index = this.#readIndex();
    if (index.records.length >= LIMITS.objects) fail('LIMIT_EXCEEDED', 'Record count');
    const digest = objectDigest(bytes), additions = [];
    if (index.objects.some(o => o.digest === digest)) {
      if (!this.read(digest).equals(bytes)) fail('INVALID', 'Deduplication content mismatch');
    } else {
      if (index.objects.length >= LIMITS.objects || index.objects.reduce((n, o) => n + Number(o.length), 0) + bytes.length > LIMITS.total) fail('LIMIT_EXCEEDED');
      const blobId = id();
      additions.push([blobId, this.#box(bytes, 'evidence', digest)]);
      index.objects.push({ id: blobId, digest, length: String(bytes.length) });
    }
    const record = makeRecord(bytes, this.#signing, BigInt(index.checkpoint) + 1n, index.records.at(-1)?.recordDigest ?? null);
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
    const index = this.#readIndex();
    for (const record of index.records) goodRecord(record, this.read(record.manifest.evidence[0].objectDigest));
    return { snapshot: 'COMPLETE', latestState: 'NOT_PROVEN', count: index.records.length };
  }
  rotate(newKey) {
    if (!Buffer.isBuffer(newKey) || newKey.length !== 32) fail('UNRECOVERABLE');
    const index = this.#readIndex(); this.verifyAll();
    if (this.#db.prepare('SELECT 1 FROM usage WHERE key_hash=?').get(keyHash(newKey))) fail('INVALID', 'VMK reuse forbidden');
    this.#db.prepare('INSERT INTO usage VALUES (?, 0)').run(keyHash(newKey));
    const additions = index.objects.map(o => {
      const box = parseCanonical(this.#db.prepare('SELECT envelope FROM blobs WHERE id=?').get(o.id).envelope);
      const wrappingAAD = aad('PAP/wrapped-dek/v1', this.vaultId, 'evidence', o.digest);
      const dek = decrypt(this.#vmk, box.wrappedKey, wrappingAAD, 32);
      box.wrappedKey = encrypt(newKey, dek, wrappingAAD, this.#nonce(newKey)); dek.fill(0);
      return [o.id, box];
    });
    this.#commit(index, additions, newKey);
    this.#vmk.fill(0); this.#vmk = Buffer.from(newKey);
  }
  exportDisclosure(recordIds, { includeEvidence = true } = {}) {
    const index = this.#readIndex();
    if (!Array.isArray(recordIds) || new Set(recordIds).size !== recordIds.length) fail('INVALID');
    const records = recordIds.map(eventId => {
      const r = index.records.find(r => r.manifest.eventId === eventId); if (!r) fail('INCOMPLETE'); return r;
    });
    const digests = [...new Set(records.map(r => r.manifest.evidence[0].objectDigest))];
    return wire({ profile: 'pap-disclosure-spike/1', scope: 'SELECTIVE', records,
      objects: includeEvidence ? digests.map(d => disclosureObject(this.read(d))) : [] });
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
    const index = this.#readIndex();
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
  close() { if (!this.#closed) { this.#db.close(); this.#vmk.fill(0); this.#closed = true; } }
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
