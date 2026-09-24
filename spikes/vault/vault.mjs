import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createHmac } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { LIMITS, canonical, parseCanonical, keys, b64, unb64, hash, objectDigest, encrypt, decrypt, aad, fail } from './format.mjs';
import { signedObservation, linksCancellation } from '../recipient/portable.mjs';
import { identity, makeRecord, verifyRecord, disclosureObject, publicProofDigest } from './records.mjs';
import { Vault as LegacyVault, inspectRecovery, readVaultHeader, vaultKeyId } from './legacy-vault.mjs';

export { inspectRecovery, readVaultHeader, vaultKeyId };
export const STORAGE_LIMITS = Object.freeze({ page: 4096, cacheKiB: 8192, pageRecords: 100, related: 512, state: 1024 * 1024 });
const wire = value => Buffer.from(canonical(value));
const id = () => b64(randomBytes(16));
const MAX_WRAPS = Number.MAX_SAFE_INTEGER;
const WRAPS_PER_KEY = 65536n;
const promptKinds = new Set(['frozen-text-version', 'normal-send-intent', 'normal-request-observed']);
const words = text => [...new Set(text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])];
function goodRecord(record, bytes) {
  const result = verifyRecord(record, bytes);
  if (result.structure !== 'VALID' || result.integrity !== 'VALID' || result.keyAttribution !== 'SIGNATURE_VALID') {
    fail(result.integrity === 'INCOMPLETE' ? 'INCOMPLETE' : 'INVALID', 'Record/evidence check failed');
  }
}

// SQLite B-trees provide bounded pages and atomic evidence/index publication.
// Lookup keys are vault-private HMACs; prompt bytes and record metadata stay encrypted.
export class Vault {
  #db; #vmk; #signing; #fault; #closed = false; #cached = null; #revision = Symbol('vault-revision');
  #nextNonce = 0; #lastNonce = 0; #transactionNonce = null; #rotationNonces = new Map();
  #metrics = { recordsRead: 0, objectsRead: 0, headersRead: 0 };
  constructor(directory, vmk, signing = identity(), { create = false, fault = () => {}, vaultId = null, readerVersion = 4,
    pageSize = STORAGE_LIMITS.page } = {}) {
    if (readerVersion < 4) return new LegacyVault(directory, vmk, signing, { create, fault, vaultId, readerVersion });
    if (readerVersion !== 4 || !Buffer.isBuffer(vmk) || vmk.length !== 32) fail('UNRECOVERABLE');
    if (create) mkdirSync(directory, { mode: 0o700 });
    else if (!existsSync(join(directory, 'vault.sqlite'))) fail('UNRECOVERABLE', 'Vault database missing');
    this.#vmk = Buffer.from(vmk); this.#signing = signing; this.#fault = fault;
    this.#db = new DatabaseSync(join(directory, 'vault.sqlite'));
    try {
      if (![4096, 8192, 16384, 32768].includes(pageSize)) fail('INVALID');
      if (create) this.#db.exec(`PRAGMA page_size=${pageSize}`);
      this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0; PRAGMA cache_size=-${STORAGE_LIMITS.cacheKiB}; PRAGMA temp_store=FILE; PRAGMA secure_delete=ON;`);
      if (create) {
        chmodSync(join(directory, 'vault.sqlite'), 0o600);
        this.#db.exec('CREATE TABLE meta (id INTEGER PRIMARY KEY CHECK(id=1), vault_id TEXT NOT NULL, key_hash TEXT NOT NULL, envelope BLOB); CREATE TABLE usage (key_hash TEXT PRIMARY KEY, counter INTEGER NOT NULL); CREATE TABLE blobs (id TEXT PRIMARY KEY, envelope BLOB NOT NULL);');
        const selectedId = vaultId ?? id(); unb64(selectedId, 16);
        this.#db.prepare('INSERT INTO meta VALUES (1, ?, ?, NULL)').run(selectedId, vaultKeyId(vmk));
        this.#db.prepare('INSERT INTO usage VALUES (?, 0)').run(vaultKeyId(vmk));
        const header = this.#emptyHeader(), box = this.#box(wire(header), 'header', 'header');
        this.#transaction(() => { this.#ddl(); this.#writeHeader(box); });
      } else {
        const version = this.#db.prepare('PRAGMA user_version').get().user_version || 1;
        if (version > 4) fail('UNSUPPORTED', 'Vault schema is newer than this application');
        if (version < 4) this.#migrate(directory, signing);
      }
      const schema = this.schemaInfo();
      if (schema.writerVersion !== 4 || schema.minimumReader !== 4) fail('UNSUPPORTED', 'Incompatible vault schema');
      this.#header();
    } catch (error) { this.#db.close(); this.#vmk.fill(0); throw error; }
  }
  #emptyHeader() { return { profile: 'pap-vault-index/4', checkpoint: 0, objects: 0, bytes: 0, head: null,
    indexKey: b64(randomBytes(32)), prompts: 0, pending: 0, attention: 0, conversations: 0, unassigned: 0 }; }
  #ddl() {
    this.#db.exec(`CREATE TABLE IF NOT EXISTS vault_schema (id INTEGER PRIMARY KEY CHECK(id=1), writer_version INTEGER NOT NULL, minimum_reader INTEGER NOT NULL);
      INSERT OR REPLACE INTO vault_schema VALUES (1,4,4);
      CREATE TABLE IF NOT EXISTS key_retirements (id INTEGER PRIMARY KEY CHECK(id=1), retired_key_hash TEXT NOT NULL, replacement_key_hash TEXT NOT NULL);
      CREATE TABLE records (seq INTEGER PRIMARY KEY, event TEXT UNIQUE NOT NULL, digest TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, subject TEXT, message TEXT, related TEXT, envelope BLOB NOT NULL);
      CREATE INDEX record_kind ON records(kind,seq); CREATE INDEX record_subject ON records(subject,seq);
      CREATE INDEX record_message ON records(message,seq); CREATE INDEX record_related ON records(related,seq);
      CREATE TABLE objects (token TEXT PRIMARY KEY, id TEXT UNIQUE NOT NULL, envelope BLOB NOT NULL);
      CREATE TABLE settings (token TEXT PRIMARY KEY, envelope BLOB NOT NULL);
      CREATE TABLE receipts (seq INTEGER PRIMARY KEY, pending INTEGER NOT NULL, attention INTEGER NOT NULL, conversation TEXT);
      CREATE INDEX receipt_pending ON receipts(pending,seq); CREATE INDEX receipt_attention ON receipts(attention,seq);
      CREATE TABLE conversations (token TEXT PRIMARY KEY);
      CREATE TABLE search_words (token TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY(token,seq)) WITHOUT ROWID;
      PRAGMA user_version=4;`);
  }
  #migrate(directory, signing) {
    // The old format is bounded. Migration is the only opening that walks it.
    const legacy = new LegacyVault(directory, this.#vmk, signing, { readerVersion: 1 });
    let index;
    try { legacy.verifyAll(); index = legacy.inspect(); } finally { legacy.close(); }
    const header = this.#emptyHeader();
    const objectRows = index.objects.map(object => ({ ...object, codec: 'raw' }));
    const preparedObjects = objectRows.map(object => ({ token: this.#token('object', object.digest, header),
      id: object.id, envelope: wire(this.#box(wire(object), 'object-index', this.#token('object', object.digest, header))) }));
    const preparedRecords = index.records.map(record => this.#prepareRecord(record, header));
    this.#transaction(() => {
      this.#ddl(); this.#fault('migration-after-ddl');
      for (const object of preparedObjects) this.#db.prepare('INSERT INTO objects VALUES (?,?,?)').run(object.token, object.id, object.envelope);
      for (const row of preparedRecords) this.#insertRecord(row);
      // Publishing records and all rebuildable routing indexes shares one commit.
      this.#cached = { header, dataVersion: this.#dataVersion() };
      for (const record of index.records) this.#indexRecord(record, this.read(record.manifest.evidence[0].objectDigest), header);
      header.checkpoint = index.records.length; header.head = index.records.at(-1)?.recordDigest ?? null;
      header.objects = index.objects.length; header.bytes = index.objects.reduce((n, o) => n + Number(o.length), 0);
      // Migration uses reserved nonces prepared before BEGIN for each immutable row.
      this.#writeHeader(this.#directBox(wire(header), 'header', 'header'));
      this.#fault('migration-before-commit');
    }, null, true);
    this.#fault('migration-after-commit');
  }
  #dataVersion() { return this.#db.prepare('PRAGMA data_version').get().data_version; }
  #assertKey() {
    if (this.#closed) fail('UNRECOVERABLE', 'Vault closed');
    const meta = this.#db.prepare('SELECT key_hash FROM meta WHERE id=1').get();
    if (meta?.key_hash !== vaultKeyId(this.#vmk)) fail('UNRECOVERABLE', 'Wrong vault key');
    const counter = this.#db.prepare('SELECT counter FROM usage WHERE key_hash=?').get(meta.key_hash)?.counter;
    if (!Number.isSafeInteger(counter) || counter < 1 || counter > MAX_WRAPS || counter < this.#lastNonce) fail('UNRECOVERABLE', 'Nonce reservation state missing');
    if (this.#lastNonce && counter > this.#lastNonce) { this.#nextNonce = 0; this.#lastNonce = 0; }
  }
  #header() {
    this.#assertKey(); const dataVersion = this.#dataVersion();
    if (this.#cached?.dataVersion === dataVersion) return this.#cached.header;
    const row = this.#db.prepare('SELECT envelope FROM meta WHERE id=1').get();
    const box = parseCanonical(row.envelope, STORAGE_LIMITS.state);
    const header = parseCanonical(this.#unbox(box, 'header', 'header'), STORAGE_LIMITS.state);
    keys(header, ['profile', 'checkpoint', 'objects', 'bytes', 'head', 'indexKey', 'prompts', 'pending', 'attention', 'conversations', 'unassigned']);
    if (header.profile !== 'pap-vault-index/4' || !['checkpoint', 'objects', 'bytes', 'prompts', 'pending', 'attention', 'conversations', 'unassigned']
      .every(key => Number.isSafeInteger(header[key]) && header[key] >= 0)
      || header.objects > header.checkpoint || header.prompts > header.checkpoint
      || ['pending', 'attention', 'conversations', 'unassigned'].some(key => header[key] > header.prompts)
      || (header.checkpoint === 0) !== (header.head === null)) fail('INVALID', 'Invalid vault header');
    if (header.head !== null) unb64(header.head, 32);
    unb64(header.indexKey, 32);
    this.#metrics.headersRead++; this.#revision = Symbol('vault-revision');
    this.#cached = { header, dataVersion }; return header;
  }
  #token(domain, value, header = this.#header()) {
    return createHmac('sha256', unb64(header.indexKey, 32)).update(`${domain}\0${value}`).digest('base64url');
  }
  #nonce(key = this.#vmk) {
    if (key === this.#vmk && this.#nextNonce <= this.#lastNonce && this.#nextNonce > 0) {
      const n = Buffer.alloc(12); n.writeBigUInt64BE(BigInt(this.#nextNonce++), 4); return n;
    }
    const kh = vaultKeyId(key);
    const range = this.#rotationNonces.get(kh);
    if (key !== this.#vmk && range && range.next <= range.last) {
      const n = Buffer.alloc(12); n.writeBigUInt64BE(BigInt(range.next++), 4); return n;
    }
    let start, end;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const counter = this.#db.prepare('SELECT counter FROM usage WHERE key_hash=?').get(kh)?.counter;
      if (!Number.isSafeInteger(counter) || counter < 0) fail('UNRECOVERABLE', 'Nonce state');
      if (counter >= MAX_WRAPS) fail('LIMIT_EXCEEDED', 'VMK rotation required');
      start = counter + 1; end = Math.min(counter + 64, MAX_WRAPS);
      this.#db.prepare('UPDATE usage SET counter=? WHERE key_hash=?').run(end, kh); this.#db.exec('COMMIT');
    } catch (error) { if (this.#db.isTransaction) this.#db.exec('ROLLBACK'); throw error; }
    if (key === this.#vmk) { this.#nextNonce = start + 1; this.#lastNonce = end; }
    else this.#rotationNonces.set(kh, { next: start + 1, last: end });
    const n = Buffer.alloc(12); n.writeBigUInt64BE(BigInt(start), 4); return n;
  }
  #wrappingKey(key, nonce) {
    const generation = nonce.readBigUInt64BE(4) / WRAPS_PER_KEY;
    return createHmac('sha256', key).update(`PAP/wrapping-key/v4\0${this.vaultId}\0${generation}`).digest();
  }
  #box(bytes, role, objectId, key = this.#vmk, nonce = this.#nonce(key)) {
    const dek = randomBytes(32), wrappingKey = this.#wrappingKey(key, nonce);
    try { return { wrapProfile: 'pap-vault-wrap/4', payload: encrypt(dek, bytes, aad('PAP/blob/v1', this.vaultId, role, objectId)),
      wrappedKey: encrypt(wrappingKey, dek, aad('PAP/wrapped-dek/v1', this.vaultId, role, objectId), nonce) }; }
    finally { dek.fill(0); wrappingKey.fill(0); }
  }
  // The header's wrapping nonce is fsynced before BEGIN, even if publication fails.
  #directBox(bytes, role, objectId) {
    if (!this.#transactionNonce) fail('INVALID', 'Missing reserved header nonce');
    const nonce = this.#transactionNonce; this.#transactionNonce = null;
    return this.#box(bytes, role, objectId, this.#vmk, nonce);
  }
  #unbox(box, role, objectId, max = LIMITS.object) {
    keys(box, ['payload', 'wrappedKey', ...(Object.hasOwn(box, 'wrapProfile') ? ['wrapProfile'] : [])]);
    if (box.wrapProfile !== undefined && box.wrapProfile !== 'pap-vault-wrap/4') fail('UNSUPPORTED');
    const nonce = unb64(box.wrappedKey.nonce, 12);
    const reserved = this.#db.prepare('SELECT counter FROM usage WHERE key_hash=?').get(this.keyId)?.counter;
    if (!Number.isSafeInteger(reserved) || nonce.readBigUInt64BE(4) > BigInt(reserved)) fail('UNRECOVERABLE', 'Nonce reservation rollback');
    const wrappingKey = box.wrapProfile ? this.#wrappingKey(this.#vmk, nonce) : Buffer.from(this.#vmk);
    let dek;
    try { dek = decrypt(wrappingKey, box.wrappedKey, aad('PAP/wrapped-dek/v1', this.vaultId, role, objectId), 32); }
    finally { wrappingKey.fill(0); }
    try { return decrypt(dek, box.payload, aad('PAP/blob/v1', this.vaultId, role, objectId), max); }
    finally { dek.fill(0); }
  }
  #writeHeader(box) { this.#db.prepare('UPDATE meta SET envelope=? WHERE id=1').run(wire(box)); }
  #transaction(work, baseline = null, reserveHeader = false) {
    this.#transactionNonce = reserveHeader ? this.#nonce() : null;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      if (baseline && !Buffer.from(this.#db.prepare('SELECT envelope FROM meta WHERE id=1').get().envelope).equals(baseline)) fail('CONFLICT');
      const result = work(); this.#db.exec('COMMIT'); return result;
    } catch (error) { if (this.#db.isTransaction) this.#db.exec('ROLLBACK'); throw error; }
    finally { this.#cached = null; this.#transactionNonce = null; this.#revision = Symbol('vault-revision'); }
  }
  get vaultId() { return this.#db.prepare('SELECT vault_id FROM meta WHERE id=1').get().vault_id; }
  get keyId() { return this.#db.prepare('SELECT key_hash FROM meta WHERE id=1').get().key_hash; }
  get signingPublicKey() { return this.#signing?.publicKey.export({ format: 'jwk' }).x ?? null; }
  get revision() { this.#header(); return this.#revision; }
  get checkpoint() { const header = this.#header(); return { sequence: header.checkpoint, recordDigest: header.head }; }
  recoveryFitsJSON() { const header = this.#header(); return header.checkpoint <= 256 && header.bytes <= 8 * 2 ** 20; }
  get recordCount() { return this.#header().checkpoint; }
  get remainingRecordCapacity() { this.#header(); return Number.MAX_SAFE_INTEGER - this.recordCount; }
  requireRecordCapacity(count = 1) { if (!Number.isSafeInteger(count) || count < 1) fail('INVALID'); if (count > this.remainingRecordCapacity) fail('VAULT_CAPACITY_EXHAUSTED'); }
  schemaInfo() { const row = this.#db.prepare('SELECT writer_version,minimum_reader FROM vault_schema WHERE id=1').get(); return { writerVersion: row.writer_version, minimumReader: row.minimum_reader }; }
  metrics({ reset = false } = {}) { const value = { ...this.#metrics }; if (reset) for (const key of Object.keys(this.#metrics)) this.#metrics[key] = 0; return value; }
  setSigningIdentity(signing) { if (!signing?.privateKey || !signing?.publicKey) fail('UNRECOVERABLE'); this.#signing = signing; }
  #prepareRecord(record, header) {
    const seq = Number(record.manifest.sequence);
    return { seq, event: this.#token('event', record.manifest.eventId, header), digest: this.#token('digest', record.recordDigest, header),
      kind: record.manifest.type, envelope: wire(this.#box(wire(record), 'record', String(seq))) };
  }
  #insertRecord(row) { this.#db.prepare('INSERT INTO records(seq,event,digest,kind,envelope) VALUES (?,?,?,?,?)').run(row.seq, row.event, row.digest, row.kind, row.envelope); }
  #indexRecord(record, bytes, header) {
    const seq = Number(record.manifest.sequence);
    if (record.manifest.type !== 'observation') return;
    const value = signedObservation(record, bytes, { structure: 'VALID', integrity: 'VALID', keyAttribution: 'SIGNATURE_VALID' });
    if (!value) return;
    const token = (domain, v) => typeof v === 'string' ? this.#token(domain, v, header) : null;
    const prompt = promptKinds.has(value.kind);
    this.#db.prepare('UPDATE records SET kind=?,subject=?,message=?,related=? WHERE seq=?').run(prompt ? 'prompt' : value.kind === 'request-deduplicated' ? 'alias' : 'observation',
      token('subject', value.eventId ?? value.version), prompt ? token('message', value.request?.messageId) : null,
      token('digest', value.recordDigest), seq);
    if (value.kind === 'release-cancelled') {
      const parentRow = value.recordDigest ? this.#db.prepare('SELECT seq,envelope FROM records WHERE digest=?').get(token('digest', value.recordDigest)) : null;
      const parent = this.#decodeRecord(parentRow);
      const parentValue = parent?.manifest.type === 'observation' ? parseCanonical(this.read(parent.manifest.evidence[0].objectDigest)) : null;
      if (!linksCancellation(record, value, parent, parentValue)) this.#db.prepare("UPDATE records SET kind='unassociated' WHERE seq=?").run(seq);
    }
    if (prompt) {
      const conversation = value.source?.destination?.startsWith('conversation:') ? token('conversation', value.source.destination) : null;
      this.#db.prepare('INSERT INTO receipts VALUES (?,1,0,?)').run(seq, conversation);
      header.prompts++; header.pending++;
      if (conversation) {
        const result = this.#db.prepare('INSERT OR IGNORE INTO conversations VALUES (?)').run(conversation);
        header.conversations += Number(result.changes);
      } else header.unassigned++;
      if (value.textObject) {
        const text = this.read(value.textObject).toString('utf8');
        const insert = this.#db.prepare('INSERT OR IGNORE INTO search_words VALUES (?,?)');
        for (const word of words(text)) insert.run(token('word', word), seq);
      }
    } else if (value.recordDigest && ['fast-confirmation', 'consensus-assurance-upgrade', 'release-outcome'].includes(value.kind)) {
      const parent = this.#db.prepare('SELECT seq,envelope FROM records WHERE digest=?').get(token('digest', value.recordDigest));
      if (!parent) return;
      const descriptor = this.#decodeRecord(parent);
      if (descriptor.manifest.signingPublicKey !== record.manifest.signingPublicKey) return;
      if (value.kind !== 'release-outcome') {
        header.pending -= Number(this.#db.prepare('UPDATE receipts SET pending=0 WHERE seq=? AND pending=1').run(parent.seq).changes);
      } else if (['OUTCOME_UNKNOWN', 'FAILED_BEFORE_EGRESS'].includes(value.state)) {
        header.attention += Number(this.#db.prepare('UPDATE receipts SET attention=1 WHERE seq=? AND attention=0').run(parent.seq).changes);
      }
    }
  }
  capture(input, options = {}) {
    const bytes = Buffer.from(input); if (bytes.length > LIMITS.object) fail('LIMIT_EXCEEDED', 'Object size');
    this.requireRecordCapacity();
    const header = structuredClone(this.#header());
    const baseline = Buffer.from(this.#db.prepare('SELECT envelope FROM meta WHERE id=1').get().envelope);
    const digest = objectDigest(bytes), token = this.#token('object', digest, header);
    let object = this.#db.prepare('SELECT id FROM objects WHERE token=?').get(token), blob, objectBox;
    if (object) { if (!this.read(digest).equals(bytes)) fail('INVALID', 'Deduplication content mismatch'); }
    else {
      const compressed = bytes.length >= 256 ? deflateRawSync(bytes, { level: 6 }) : bytes;
      const beneficial = compressed.length + 32 < bytes.length;
      object = { id: id(), digest, length: String(bytes.length), codec: beneficial ? 'deflate-raw' : 'raw' };
      blob = this.#box(beneficial ? compressed : bytes, 'evidence', digest);
      objectBox = this.#box(wire(object), 'object-index', token);
      header.objects++; header.bytes += bytes.length;
    }
    const record = makeRecord(bytes, this.#signing, header.checkpoint + 1, header.head, options);
    goodRecord(record, bytes);
    const row = this.#prepareRecord(record, header);
    header.checkpoint++; header.head = record.recordDigest;
    this.#transaction(() => {
      this.#fault('before-write');
      if (blob) {
        this.#db.prepare('INSERT INTO blobs VALUES (?,?)').run(object.id, wire(blob));
        this.#db.prepare('INSERT INTO objects VALUES (?,?,?)').run(token, object.id, wire(objectBox));
      }
      this.#fault('after-objects'); this.#insertRecord(row);
      this.#cached = { header, dataVersion: this.#dataVersion() };
      this.#indexRecord(record, bytes, header); this.#fault('after-index');
      this.#writeHeader(this.#directBox(wire(header), 'header', 'header'));
      this.#fault('before-commit');
    }, baseline, true);
    this.#fault('after-commit'); return record;
  }
  hasObject(digest) { return Boolean(this.#db.prepare('SELECT 1 FROM objects WHERE token=?').get(this.#token('object', digest))); }
  read(digest) {
    const token = this.#token('object', digest), row = this.#db.prepare('SELECT id,envelope FROM objects WHERE token=?').get(token);
    if (!row) fail('INCOMPLETE', 'Missing evidence reference');
    const object = parseCanonical(this.#unbox(parseCanonical(row.envelope), 'object-index', token));
    if (object.digest !== digest || object.id !== row.id || !['raw', 'deflate-raw'].includes(object.codec)
        || Number(object.length) > LIMITS.object) fail('INVALID', 'Evidence index mismatch');
    const blob = this.#db.prepare('SELECT envelope FROM blobs WHERE id=?').get(row.id);
    if (!blob) fail('INCOMPLETE', 'Missing evidence ciphertext');
    let bytes = this.#unbox(parseCanonical(blob.envelope), 'evidence', digest);
    if (object.codec === 'deflate-raw') {
      try { bytes = inflateRawSync(bytes, { maxOutputLength: Math.max(1, Number(object.length)) }); }
      catch { fail('INVALID', 'Compressed evidence invalid'); }
    }
    this.#metrics.objectsRead++;
    if (bytes.length !== Number(object.length) || objectDigest(bytes) !== digest) fail('INVALID', 'Evidence mismatch');
    return bytes;
  }
  #decodeRecord(row) {
    if (!row) return null;
    const record = parseCanonical(this.#unbox(parseCanonical(row.envelope), 'record', String(row.seq)), LIMITS.manifest);
    if (record.manifest?.sequence !== String(row.seq)) fail('INVALID', 'Record position mismatch');
    this.#metrics.recordsRead++; return record;
  }
  getRecord(eventId) {
    const record = this.#decodeRecord(this.#db.prepare('SELECT seq,envelope FROM records WHERE event=?').get(this.#token('event', eventId)));
    if (record && record.manifest.eventId !== eventId) fail('INVALID', 'Record locator mismatch'); return record;
  }
  lookupRecords(field, value, { limit = STORAGE_LIMITS.related } = {}) {
    if (!['subject', 'message', 'related'].includes(field) || !Number.isSafeInteger(limit) || limit < 1 || limit > STORAGE_LIMITS.related) fail('INVALID');
    const domain = field === 'related' ? 'digest' : field;
    const rows = this.#db.prepare(`SELECT seq,envelope FROM records WHERE ${field}=? ${field === 'related' ? "AND kind <> 'alias'" : ''} ORDER BY seq LIMIT ?`).all(this.#token(domain, value), limit + 1);
    if (rows.length > limit) fail('LIMIT_EXCEEDED', 'Select a smaller related-record operation');
    return rows.map(row => {
      const record = this.#decodeRecord(row), bytes = this.read(record.manifest.evidence[0].objectDigest);
      const observation = signedObservation(record, bytes, verifyRecord(record, bytes));
      const actual = field === 'subject' ? observation?.eventId ?? observation?.version
        : field === 'message' ? observation?.request?.messageId : observation?.recordDigest;
      if (actual !== value) fail('INVALID', 'Observation locator mismatch'); return record;
    });
  }
  recordPage({ before = Number.MAX_SAFE_INTEGER, after = 0, limit = 5, kind = null, pending = false, attentionOnly = false, search = '', ascending = false } = {}) {
    if (![before, after, limit].every(Number.isSafeInteger) || before < 1 || after < 0 || limit < 1 || limit > STORAGE_LIMITS.pageRecords
        || typeof pending !== 'boolean' || typeof attentionOnly !== 'boolean' || typeof search !== 'string' || search.length > 256) fail('INVALID', 'Invalid history page');
    if (kind !== null && !['prompt', 'observation', 'capture', 'derivative', 'public-proof', 'unassociated'].includes(kind)) fail('INVALID');
    const terms = words(search); if (terms.length > 8) fail('LIMIT_EXCEEDED', 'Search up to eight words');
    let from = 'records r', position = 'r.seq';
    const clauses = [], args = [];
    if (terms.length) {
      from = 'search_words w JOIN records r ON r.seq=w.seq'; position = 'w.seq';
      clauses.push('w.token=?'); args.push(this.#token('word', terms.shift()));
    } else if (pending || attentionOnly) {
      from = 'receipts p JOIN records r ON r.seq=p.seq'; position = 'p.seq';
      clauses.push(`p.${pending ? 'pending' : 'attention'}=1`);
    }
    clauses.push(`${position} < ?`, `${position} > ?`); args.push(before, after);
    if (kind) { clauses.push('r.kind=?'); args.push(kind); }
    if (search && (pending || attentionOnly)) clauses.push(`EXISTS (SELECT 1 FROM receipts p WHERE p.seq=r.seq AND p.${pending ? 'pending' : 'attention'}=1)`);
    for (const word of terms) { clauses.push('EXISTS (SELECT 1 FROM search_words w2 WHERE w2.token=? AND w2.seq=r.seq)'); args.push(this.#token('word', word)); }
    const rows = this.#db.prepare(`SELECT r.seq,r.envelope FROM ${from} WHERE ${clauses.join(' AND ')} ORDER BY ${position} ${ascending || after ? 'ASC' : 'DESC'} LIMIT ?`).all(...args, limit + 1);
    const more = rows.length > limit; rows.length = Math.min(rows.length, limit);
    return { records: rows.map(row => this.#decodeRecord(row)), next: more ? rows.at(-1).seq : null };
  }
  *records() {
    let after = 0;
    while (true) {
      const rows = this.#db.prepare('SELECT seq,envelope FROM records WHERE seq>? ORDER BY seq LIMIT ?').all(after, STORAGE_LIMITS.pageRecords);
      if (!rows.length) return;
      for (const row of rows) { after = row.seq; yield this.#decodeRecord(row); }
    }
  }
  historyCounts() { const h = this.#header(); return { prompts: h.prompts, pendingAnchors: h.pending, needsAttention: h.attention, conversations: h.conversations, unassigned: h.unassigned }; }
  inspect() {
    const h = this.#header();
    const objects = this.#db.prepare('SELECT token,envelope FROM objects').all().map(row => {
      const { codec: _codec, ...object } = parseCanonical(this.#unbox(parseCanonical(row.envelope), 'object-index', row.token)); return object;
    });
    return { profile: 'pap-vault-index-spike/1', objects, records: [...this.records()], checkpoint: String(h.checkpoint) };
  }
  verifyAll() {
    const h = this.#header(); let count = 0, previous = null;
    for (const record of this.records()) {
      if (record.manifest.sequence !== String(++count) || record.manifest.previousRecordDigest !== previous) fail('INVALID', 'Record chain incomplete');
      goodRecord(record, this.read(record.manifest.evidence[0].objectDigest)); previous = record.recordDigest;
    }
    if (count !== h.checkpoint || previous !== h.head
        || this.#db.prepare('SELECT count(*) AS n FROM objects').get().n !== h.objects
        || this.#db.prepare('SELECT count(*) AS n FROM blobs').get().n !== h.objects) fail('INCOMPLETE', 'Checkpoint mismatch');
    return { snapshot: 'COMPLETE', latestState: 'NOT_PROVEN', count };
  }
  rebuildIndexes() {
    const header = structuredClone(this.#header()), baseline = Buffer.from(this.#db.prepare('SELECT envelope FROM meta WHERE id=1').get().envelope);
    for (const key of ['prompts', 'pending', 'attention', 'conversations', 'unassigned']) header[key] = 0;
    this.#transaction(() => {
      this.#db.exec('DELETE FROM receipts; DELETE FROM conversations; DELETE FROM search_words;');
      this.#cached = { header, dataVersion: this.#dataVersion() };
      let count = 0, previous = null;
      for (const record of this.records()) {
        const bytes = this.read(record.manifest.evidence[0].objectDigest); goodRecord(record, bytes);
        if (record.manifest.sequence !== String(++count) || record.manifest.previousRecordDigest !== previous) fail('INVALID');
        this.#db.prepare('UPDATE records SET kind=?,subject=NULL,message=NULL,related=NULL WHERE seq=?').run(record.manifest.type, count);
        this.#indexRecord(record, bytes, header); previous = record.recordDigest;
      }
      if (count !== header.checkpoint || previous !== header.head) fail('INCOMPLETE');
      this.#fault('rebuild-before-commit'); this.#writeHeader(this.#directBox(wire(header), 'header', 'header'));
    }, baseline, true);
  }
  readState(name) {
    const token = this.#token('state', name), row = this.#db.prepare('SELECT envelope FROM settings WHERE token=?').get(token);
    return row ? parseCanonical(this.#unbox(parseCanonical(row.envelope), 'state', token, STORAGE_LIMITS.state), STORAGE_LIMITS.state) : null;
  }
  writeState(name, value) {
    const token = this.#token('state', name), bytes = wire(value); if (bytes.length > STORAGE_LIMITS.state) fail('LIMIT_EXCEEDED');
    const box = this.#box(bytes, 'state', token);
    this.#transaction(() => { this.#db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run(token, wire(box)); this.#fault('state-before-commit'); });
    this.#fault('state-after-commit');
  }
  retentionStatus() { const h = this.#header(); return { policy: 'APPEND_ONLY', records: h.checkpoint, objects: h.objects, reclaimableObjects: 0,
    reason: 'Every object is reachable from retained signed records; MVP garbage collection is disabled.' }; }
  exportDisclosure(recordIds, { includeEvidence = true, publicProofs = [] } = {}) {
    if (!Array.isArray(recordIds) || recordIds.length > LIMITS.objects || new Set(recordIds).size !== recordIds.length) fail('LIMIT_EXCEEDED');
    const records = recordIds.map(id => { const r = this.getRecord(id); if (!r) fail('INCOMPLETE'); return r; });
    const digests = [...new Set(records.map(r => r.manifest.evidence[0].objectDigest))];
    let size = 0;
    const objects = includeEvidence ? digests.map(d => { const bytes = this.read(d); size += bytes.length; if (size > LIMITS.total) fail('LIMIT_EXCEEDED'); return disclosureObject(bytes); }) : [];
    if (!Array.isArray(publicProofs) || publicProofs.length > LIMITS.entries) fail('LIMIT_EXCEEDED');
    if (!publicProofs.length) return wire({ profile: 'pap-disclosure-spike/1', scope: 'SELECTIVE', records, objects });
    const selected = new Set(records.map(r => r.recordDigest)), proofObjects = new Map(), references = [];
    for (const entry of publicProofs) {
      if (!entry || Object.keys(entry).sort().join(',') !== 'bytes,recordDigest' || !selected.has(entry.recordDigest)) fail('INVALID');
      const bytes = Buffer.from(entry.bytes), digest = publicProofDigest(bytes);
      if (!proofObjects.has(digest)) { size += bytes.length; if (size > LIMITS.total) fail('LIMIT_EXCEEDED'); proofObjects.set(digest, { digest, bytes: disclosureObject(bytes).bytes }); }
      references.push({ recordDigest: entry.recordDigest, proofDigest: digest });
    }
    if (new Set(references.map(r => canonical(r))).size !== references.length) fail('INVALID');
    return wire({ profile: 'pap-disclosure-spike/2', scope: 'SELECTIVE', records, objects, publicProofObjects: [...proofObjects.values()], publicProofReferences: references });
  }
  exportRecovery() {
    if (this.recordCount > LIMITS.objects || this.#header().bytes > LIMITS.total) fail('LIMIT_EXCEEDED', 'Use streaming recovery for a large archive');
    // The bounded legacy package remains readable by already distributed readers.
    const index = this.inspect(); this.verifyAll();
    const packageId = id(), snapshotId = id(), recoveryKey = randomBytes(32), snapshotKey = randomBytes(32), blobs = [];
    let invocation = 0;
    const legacyBox = (bytes, role, objectId, packageScope = null, snapshotScope = null) => {
      const dek = randomBytes(32), nonce = Buffer.alloc(12); nonce.writeBigUInt64BE(BigInt(++invocation), 4);
      try { return { payload: encrypt(dek, bytes, aad(role === 'recovery-manifest' ? 'PAP/recovery-manifest/v1' : 'PAP/blob/v1', this.vaultId, role, objectId, packageScope, snapshotScope)),
        wrappedKey: encrypt(snapshotKey, dek, aad('PAP/wrapped-dek/v1', this.vaultId, role, objectId, packageScope, snapshotScope), nonce) }; } finally { dek.fill(0); }
    };
    for (const object of index.objects) blobs.push({ id: object.id, box: legacyBox(this.read(object.digest), 'evidence', object.digest) });
    const manifest = { profile: 'pap-recovery-manifest-spike/1', cryptoProfile: 'pap-poc-crypto/1', vaultId: this.vaultId, packageId, snapshotId,
      scope: 'ALL_RETAINED_AT_CHECKPOINT', checkpoint: index.checkpoint, index,
      inventory: blobs.map(b => ({ id: b.id, ciphertextDigest: b64(hash(wire(b.box))), encodedLength: String(wire(b.box).length) })),
      objectCount: String(blobs.length), recordCount: String(index.records.length), excluded: [], anchors: [] };
    const manifestBytes = wire(manifest); if (manifestBytes.length > LIMITS.manifest) fail('LIMIT_EXCEEDED');
    const encryptedManifest = legacyBox(manifestBytes, 'recovery-manifest', snapshotId, packageId, snapshotId);
    const wrappedVMK = encrypt(recoveryKey, snapshotKey, aad('PAP/recovery-vmk/v1', this.vaultId, 'vmk', 'vmk', packageId, snapshotId));
    snapshotKey.fill(0);
    return { recoveryKey, package: wire({ profile: 'pap-recovery-spike/1', vaultId: this.vaultId, packageId, snapshotId, wrappedVMK, encryptedManifest, blobs }) };
  }
  importRecovered(recovered) {
    if (this.recordCount) fail('INVALID', 'Restore requires empty destination');
    for (const record of recovered.records) this.importRecord(record, recovered.objects.get(record.manifest.evidence[0].objectDigest));
  }
  importRecord(record, bytes) {
    goodRecord(record, bytes);
    const header = structuredClone(this.#header());
    if (record.manifest.sequence !== String(header.checkpoint + 1) || record.manifest.previousRecordDigest !== header.head) fail('INVALID', 'Recovered record chain');
    const digest = objectDigest(bytes), token = this.#token('object', digest), blobId = id();
    const exists = this.hasObject(digest);
    const compressed = deflateRawSync(bytes), beneficial = compressed.length + 32 < bytes.length;
    const object = { id: blobId, digest, length: String(bytes.length), codec: beneficial ? 'deflate-raw' : 'raw' };
    const box = exists ? null : this.#box(beneficial ? compressed : bytes, 'evidence', digest);
    const objectBox = exists ? null : this.#box(wire(object), 'object-index', token);
    const row = this.#prepareRecord(record, header);
    header.checkpoint++; header.head = record.recordDigest; if (!exists) { header.objects++; header.bytes += bytes.length; }
    this.#transaction(() => {
      if (!exists) { this.#db.prepare('INSERT INTO blobs VALUES (?,?)').run(blobId, wire(box)); this.#db.prepare('INSERT INTO objects VALUES (?,?,?)').run(token, blobId, wire(objectBox)); }
      this.#insertRecord(row); this.#cached = { header, dataVersion: this.#dataVersion() };
      this.#indexRecord(record, bytes, header); this.#writeHeader(this.#directBox(wire(header), 'header', 'header'));
      this.#fault('before-commit');
    }, null, true);
    this.#fault('after-commit');
  }
  pendingKeyRetirements() {
    return this.#db.prepare('SELECT retired_key_hash,replacement_key_hash FROM key_retirements').all().map(row => {
      unb64(row.retired_key_hash, 32); unb64(row.replacement_key_hash, 32);
      return { retiredKeyId: row.retired_key_hash, replacementKeyId: row.replacement_key_hash };
    });
  }
  beginKeyRetirement(oldKey, newKey) {
    unb64(oldKey, 32); unb64(newKey, 32); if (oldKey === newKey || this.keyId !== oldKey) fail('INVALID');
    const pending = this.pendingKeyRetirements(); if (pending.length) { if (pending[0].retiredKeyId !== oldKey || pending[0].replacementKeyId !== newKey) fail('CONFLICT'); return; }
    this.#transaction(() => { this.#db.prepare('INSERT INTO key_retirements VALUES (1,?,?)').run(oldKey, newKey); this.#fault('retirement-intent-before-commit'); });
  }
  completeKeyRetirement(oldKey, newKey) { this.#transaction(() => this.#db.prepare('DELETE FROM key_retirements WHERE retired_key_hash=? AND replacement_key_hash=?').run(oldKey, newKey)); }
  rotate(newKey) {
    if (!Buffer.isBuffer(newKey) || newKey.length !== 32) fail('UNRECOVERABLE');
    this.verifyAll(); const header = this.#header(), newId = vaultKeyId(newKey);
    if (this.#db.prepare('SELECT 1 FROM usage WHERE key_hash=?').get(newId)) fail('INVALID', 'VMK reuse forbidden');
    this.#db.prepare('INSERT INTO usage VALUES (?,0)').run(newId);
    // Stage rewrapped envelopes on disk; rotation never materializes the archive.
    this.#db.exec('CREATE TEMP TABLE rewrap (table_name TEXT, row_id TEXT, envelope BLOB, PRIMARY KEY(table_name,row_id)) WITHOUT ROWID');
    try {
      const stage = (table, rowId, box, role, objectId) => {
        const wrapping = aad('PAP/wrapped-dek/v1', this.vaultId, role, objectId);
        const oldWrappingKey = box.wrapProfile ? this.#wrappingKey(this.#vmk, unb64(box.wrappedKey.nonce, 12)) : Buffer.from(this.#vmk);
        const dek = decrypt(oldWrappingKey, box.wrappedKey, wrapping, 32); oldWrappingKey.fill(0);
        const nonce = this.#nonce(newKey), nextWrappingKey = this.#wrappingKey(newKey, nonce);
        box.wrappedKey = encrypt(nextWrappingKey, dek, wrapping, nonce); box.wrapProfile = 'pap-vault-wrap/4';
        dek.fill(0); nextWrappingKey.fill(0);
        this.#db.prepare('INSERT INTO rewrap VALUES (?,?,?)').run(table, String(rowId), wire(box));
      };
      for (const row of this.#db.prepare('SELECT token,id,envelope FROM objects').iterate()) {
        const object = parseCanonical(this.#unbox(parseCanonical(row.envelope), 'object-index', row.token));
        stage('blobs', row.id, parseCanonical(this.#db.prepare('SELECT envelope FROM blobs WHERE id=?').get(row.id).envelope), 'evidence', object.digest);
        stage('objects', row.token, parseCanonical(row.envelope), 'object-index', row.token);
      }
      for (const row of this.#db.prepare('SELECT seq,envelope FROM records').iterate()) stage('records', row.seq, parseCanonical(row.envelope), 'record', String(row.seq));
      for (const row of this.#db.prepare('SELECT token,envelope FROM settings').iterate()) stage('settings', row.token, parseCanonical(row.envelope), 'state', row.token);
      const headerBox = this.#box(wire(header), 'header', 'header', newKey);
      this.#transaction(() => {
        for (const [table, column] of [['blobs', 'id'], ['objects', 'token'], ['records', 'seq'], ['settings', 'token']]) {
          this.#db.exec(`UPDATE ${table} SET envelope=(SELECT envelope FROM rewrap WHERE table_name='${table}' AND row_id=CAST(${table}.${column} AS TEXT))`);
        }
        this.#writeHeader(headerBox); this.#db.prepare('UPDATE meta SET key_hash=? WHERE id=1').run(newId); this.#fault('before-commit');
      });
      this.#fault('after-commit');
    } catch (error) { if (this.keyId !== newId) throw error; }
    finally { this.#db.exec('DROP TABLE rewrap'); }
    this.#vmk.fill(0); this.#vmk = Buffer.from(newKey); this.#nextNonce = 0; this.#lastNonce = 0; this.#cached = null;
  }
  close() { if (!this.#closed) { this.#db.close(); this.#vmk.fill(0); this.#signing = null; this.#cached = null; this.#closed = true; } }
}

export function restoreRecovery(input, recoveryKey, newDirectory, newVMK, signing = identity()) {
  const recovered = inspectRecovery(input, recoveryKey), vault = new Vault(newDirectory, newVMK, signing, { create: true });
  try { vault.importRecovered(recovered); return vault; } catch (error) { vault.close(); throw error; }
}
