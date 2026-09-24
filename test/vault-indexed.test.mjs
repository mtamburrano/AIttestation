import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { DurableVault, MemoryKeyStore } from '../spikes/vault/key-lifecycle.mjs';
import { Vault, restoreRecovery } from '../spikes/vault/vault.mjs';
import { exportRecoveryFile, inspectRecoveryFile, restoreRecoveryFile } from '../spikes/vault/recovery-stream.mjs';
import { canonical, parseCanonical, objectDigest, aad, encrypt } from '../spikes/vault/format.mjs';
import { verifyRecord } from '../spikes/vault/records.mjs';
import { ChatGPTRecordingSession } from '../spikes/browser/chatgpt/session.mjs';
import { ChatGPTChromeAdapter, CHATGPT_EXTENSION_ID } from '../spikes/browser/chatgpt/adapter.mjs';
import { ResidentEngine } from '../spikes/browser/chatgpt/engine.mjs';
import { EngineStateStore } from '../spikes/browser/chatgpt/engine-store.mjs';
import { dashboardState } from '../spikes/browser/chatgpt/dashboard.mjs';
import { FAST_CONFIRM_PROFILE } from '../spikes/anchor/algorand/fast-confirm.mjs';
import { verifyPortable } from '../spikes/recipient/portable.mjs';
import { scaleObservation } from './vault-scale-fixture.mjs';

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'attestamp-indexed-test-')), path = join(root, 'vault'), key = randomBytes(32);
  const opened = [], open = (opts = {}) => { const v = new Vault(path, key, undefined, opts); opened.push(v); return v; };
  const vault = open({ create: true, ...options });
  t.after(() => { opened.forEach(v => v.close()); key.fill(0); rmSync(root, { recursive: true, force: true }); });
  return { root, path, key, vault, open, opened };
}
const adapter = () => new ChatGPTChromeAdapter({ extensionId: CHATGPT_EXTENSION_ID });
const sessionFor = (root, vault, extra = {}) => new ChatGPTRecordingSession(root, adapter(), { vault, fastTrust: { profile: FAST_CONFIRM_PROFILE }, ...extra }).init();

test('indexed startup and five-receipt history never invoke full archive readers; pages/search reach old exact bytes', async t => {
  const f = fixture(t); let session = await sessionFor(f.root, f.vault);
  let first;
  for (let n = 0; n < 1000; n++) { const input = scaleObservation(n); const saved = session.observeNormal(input); if (!n) first = { input, saved }; }
  assert.equal(f.vault.recordCount, 2000); assert.equal(session.versionCount, 1000);
  session.close(); f.vault.close(); const vault = f.open();
  vault.inspect = vault.verifyAll = vault.records = () => { throw Error('FORBIDDEN_FULL_HISTORY_READ'); };
  const originalRead = vault.read.bind(vault); let reads = 0;
  vault.read = (...args) => { reads++; return originalRead(...args); };
  session = await sessionFor(f.root, vault);
  const engine = await new ResidentEngine(f.root, session, adapter(), randomUUID()).init();
  t.after(async () => { engine.stop(); await engine.drain(); session.close(); });
  assert.equal(reads, 0); assert.equal(vault.metrics().recordsRead, 0);
  const runtime = { engine, session, browserState: () => null };
  const initial = await dashboardState(runtime); assert.equal(initial.history.prompts.length, 5); assert.equal(initial.history.counts.prompts, 1000);
  assert.ok(reads <= 40); assert.ok(vault.metrics().recordsRead <= 30);
  const ids = new Set(initial.history.prompts.map(r => r.id));
  const older = await dashboardState(runtime, { before: initial.history.page.next });
  assert.equal(older.history.prompts.length, 5); assert.ok(older.history.prompts.every(r => !ids.has(r.id)));
  const search = await dashboardState(runtime, { search: 'NEEDLE000000 exact' });
  assert.deepEqual(search.history.prompts.map(p => p.id), [first.saved.descriptorId]);
  const preview = session.receipts.prepare({ ids: [first.saved.descriptorId] });
  assert.equal(preview.texts[0].preview, first.input.text);
  assert.ok(verifyPortable(session.receipts.export(preview.previewId)).records.every(r => r.integrity === 'VALID' && r.keyAttribution === 'SIGNATURE_VALID'));
  assert.equal(session.captureReceipt(first.input.eventId, first.input.source).state, 'PROMPT_SAVED');
  assert.equal(session.observeNormal({ ...first.input, eventId: randomUUID() }).id, first.input.eventId);
});

for (const phase of ['migration-after-ddl', 'migration-before-commit', 'migration-after-commit']) {
  test(`schema/v3 migration preserves signed records and recovers from ${phase}`, async t => {
    const f = fixture(t, { readerVersion: 3 });
    const record = f.vault.capture(Buffer.from('\ufefflegacy e\u0301\r\n\0'));
    const backup = f.vault.exportRecovery(), baseline = f.vault.inspect(); f.vault.close();
    assert.throws(() => f.open({ fault: p => { if (p === phase) throw Error('SYNTHETIC_MIGRATION_INTERRUPTION'); } }), /SYNTHETIC_MIGRATION_INTERRUPTION/);
    const migrated = f.open(); assert.deepEqual(migrated.inspect().records, baseline.records);
    assert.deepEqual(migrated.read(record.manifest.evidence[0].objectDigest), Buffer.from('\ufefflegacy e\u0301\r\n\0'));
    assert.equal(migrated.schemaInfo().minimumReader, 4);
    assert.throws(() => f.open({ readerVersion: 3 }), { code: 'UNSUPPORTED' });
    const restored = restoreRecovery(backup.package, backup.recoveryKey, join(f.root, 'old-backup'), randomBytes(32)); f.opened.push(restored);
    assert.deepEqual(restored.inspect().records, baseline.records);
    backup.recoveryKey.fill(0);
  });
}

for (const phase of ['after-objects', 'after-index', 'before-commit', 'after-commit']) {
  test(`prompt receipt index publication is atomic at ${phase}`, async t => {
    const f = fixture(t); let session = await sessionFor(f.root, f.vault);
    session.observeNormal(scaleObservation(0)); session.close(); f.vault.close();
    let writes = 0;
    const failing = f.open({ fault: p => { if (p === phase && ++writes === 2) throw Error('SYNTHETIC_INDEX_INTERRUPTION'); } });
    session = await sessionFor(f.root, failing); const input = scaleObservation(1);
    assert.throws(() => session.observeNormal(input), /SYNTHETIC_INDEX_INTERRUPTION/);
    const durable = phase === 'after-commit';
    assert.equal(session.captureReceipt(input.eventId).state, durable ? 'PROMPT_SAVED' : 'SAVE_PENDING');
    session.close(); failing.close(); const reopened = f.open();
    assert.equal(reopened.historyCounts().prompts, durable ? 2 : 1); reopened.verifyAll();
    const resumed = await sessionFor(f.root, reopened);
    assert.equal(resumed.captureReceipt(input.eventId).state, durable ? 'PROMPT_SAVED' : 'SAVE_PENDING'); resumed.close();
  });
}

test('compression preserves exact binary payloads and rejects authenticated ciphertext corruption', t => {
  const f = fixture(t), content = Buffer.concat([Buffer.from([0xff,0,0xef,0xbb,0xbf]), Buffer.from('e\u0301\r\n☕'.repeat(4000))]);
  const record = f.vault.capture(content);
  assert.deepEqual(f.vault.read(objectDigest(content)), content); assert.equal(verifyRecord(record, f.vault.read(objectDigest(content))).integrity, 'VALID');
  const db = new DatabaseSync(join(f.path, 'vault.sqlite')); t.after(() => db.close());
  const blob = db.prepare('SELECT id,envelope FROM blobs').get(); assert.ok(blob.envelope.length < content.length / 4);
  const box = parseCanonical(blob.envelope); box.payload.ciphertext[0] = Buffer.from('corrupt deflate').toString('base64url');
  db.prepare('UPDATE blobs SET envelope=? WHERE id=?').run(Buffer.from(canonical(box)), blob.id);
  assert.throws(() => f.vault.read(objectDigest(content)), { code: 'INVALID' });
});

test('mutable preferences and attempt counters overwrite bounded state without adding signed history; recovery remains OFF', async t => {
  const f = fixture(t), store = new EngineStateStore(f.root, f.vault);
  for (let revision = 1; revision <= 200; revision++) await store.save({ revision, recording: revision % 2 === 0, migration: 'NEW_OR_RECOVERED' });
  assert.equal(f.vault.recordCount, 0); assert.equal((await store.load()).state.recording, true);
  await store.revokeRecording(); assert.equal((await store.load()).state.recording, false);
  await store.save({ revision: 201, recording: true, migration: 'NEW_OR_RECOVERED' });
  assert.equal((await store.load()).state.recording, true);
  const db = new DatabaseSync(join(f.path, 'vault.sqlite')); t.after(() => db.close());
  assert.equal(db.prepare('SELECT count(*) AS n FROM settings').get().n, 1);
  const backup = f.vault.exportRecovery(); const recovered = restoreRecovery(backup.package, backup.recoveryKey, join(f.root, 'recovered'), randomBytes(32)); f.opened.push(recovered);
  assert.equal(recovered.readState('recording-preference'), null); backup.recoveryKey.fill(0);
});

test('rebuildable search and history indexes recover transactionally from their evidence', async t => {
  let interrupt = false; const f = fixture(t, { fault: phase => { if (interrupt && phase === 'rebuild-before-commit') throw Error('SYNTHETIC_REBUILD_INTERRUPTION'); } });
  const session = await sessionFor(f.root, f.vault);
  for (let n = 0; n < 12; n++) session.observeNormal(scaleObservation(n)); session.close();
  const records = f.vault.inspect().records, initial = f.vault.historyCounts();
  interrupt = true; assert.throws(() => f.vault.rebuildIndexes(), /SYNTHETIC_REBUILD_INTERRUPTION/);
  assert.deepEqual(f.vault.historyCounts(), initial); interrupt = false;
  const db = new DatabaseSync(join(f.path, 'vault.sqlite')); db.exec('DELETE FROM search_words'); db.close();
  f.vault.rebuildIndexes(); assert.deepEqual(f.vault.inspect().records, records); assert.deepEqual(f.vault.historyCounts(), initial);
  assert.equal(f.vault.recordPage({ kind: 'prompt', search: 'needle000003' }).records.length, 1);
});

test('streamed recovery exceeds legacy package bounds, validates before restore and retains exact signatures', async t => {
  const f = fixture(t), session = await sessionFor(f.root, f.vault);
  let first;
  for (let n = 0; n < 300; n++) { const input = scaleObservation(n), value = session.observeNormal(input); if (!n) first = { input, value }; }
  session.close(); const path = join(f.root, 'recovery.pap-recovery'), recovery = exportRecoveryFile(f.vault, path);
  assert.equal(inspectRecoveryFile(path, recovery.recoveryKey).count, 600);
  const restored = restoreRecoveryFile(path, recovery.recoveryKey, join(f.root, 'restored'), randomBytes(32)); f.opened.push(restored);
  assert.equal(restored.verifyAll().count, 600);
  const keyStore = new MemoryKeyStore(), managed = DurableVault.restoreFile(path, recovery.recoveryKey, join(f.root, 'key-store-restored'), { keyStore });
  f.opened.push(managed); assert.equal(keyStore.accounts().length, 2);
  assert.equal(managed.verifyAll().count, 600); assert.equal(managed.readState('recording-preference'), null);
  assert.deepEqual(restored.getRecord(first.value.descriptorId), f.vault.getRecord(first.value.descriptorId));
  const resumed = await sessionFor(f.root, restored); assert.equal(resumed.captureReceipt(first.input.eventId).state, 'PROMPT_SAVED'); resumed.close();
  const bytes = readFileSync(path), corrupt = join(f.root, 'truncated.pap-recovery'); writeFileSync(corrupt, bytes.subarray(0, bytes.length - 8));
  const target = join(f.root, 'must-not-exist');
  assert.throws(() => restoreRecoveryFile(corrupt, recovery.recoveryKey, target, randomBytes(32))); assert.equal(existsSync(target), false);
  assert.throws(() => inspectRecoveryFile(path, randomBytes(32)), { code: 'INVALID' }); recovery.recoveryKey.fill(0);
});

test('many deduplicated request receipts stay resolvable after cache eviction and restart', async t => {
  const f = fixture(t); let session = await sessionFor(f.root, f.vault);
  const original = scaleObservation(0), saved = session.observeNormal(original), aliases = [];
  for (let n = 0; n < 150; n++) {
    const alias = { ...original, eventId: randomUUID() }; aliases.push(alias);
    assert.equal(session.observeNormal(alias).id, original.eventId);
  }
  assert.equal(session.versionCount, 1);
  session.close(); session = await sessionFor(f.root, f.vault);
  for (const input of [original, aliases[0], aliases[75], aliases[149]]) {
    assert.equal(session.captureReceipt(input.eventId, input.source).receiptId, saved.descriptorId);
    assert.equal(session.captureReceipt(input.eventId, { ...input.source, scope: randomUUID() }).state, 'SAVE_PENDING');
  }
  session.close();
});

test('recovery streams large payloads even when the receipt count is small', t => {
  const f = fixture(t), bytes = Buffer.alloc(9 * 2 ** 20, 0x61);
  f.vault.capture(bytes); assert.equal(f.vault.recoveryFitsJSON(), false);
  const recovery = exportRecoveryFile(f.vault, join(f.root, 'large-payload.pap-recovery'));
  assert.equal(inspectRecoveryFile(recovery.path, recovery.recoveryKey, { onRecord: (record, exact) => {
    assert.deepEqual(exact, bytes); assert.equal(verifyRecord(record, exact).integrity, 'VALID');
  } }).count, 1); recovery.recoveryKey.fill(0);
});

test('authenticated malformed compression and expansion beyond the declared length fail closed', t => {
  const f = fixture(t), content = Buffer.alloc(4096, 0x61), digest = objectDigest(content);
  f.vault.capture(content);
  const db = new DatabaseSync(join(f.path, 'vault.sqlite')); t.after(() => db.close());
  const row = db.prepare('SELECT id FROM blobs').get();
  for (const compressed of [Buffer.from([0xff, 0xff]), deflateRawSync(Buffer.alloc(8192, 0x61))]) {
    // The authorized fixture reserves a fresh nonce and DEK before constructing
    // valid AEAD around deliberately invalid compressed bytes.
    const counter = db.prepare('SELECT counter FROM usage').get().counter + 1;
    db.prepare('UPDATE usage SET counter=?').run(counter + 63);
    const nonce = Buffer.alloc(12); nonce.writeBigUInt64BE(BigInt(counter), 4);
    const wrappingKey = createHmac('sha256', f.key).update(`PAP/wrapping-key/v4\0${f.vault.vaultId}\0${BigInt(counter) / 65536n}`).digest();
    const dek = randomBytes(32), box = { wrapProfile: 'pap-vault-wrap/4',
      payload: encrypt(dek, compressed, aad('PAP/blob/v1', f.vault.vaultId, 'evidence', digest)),
      wrappedKey: encrypt(wrappingKey, dek, aad('PAP/wrapped-dek/v1', f.vault.vaultId, 'evidence', digest), nonce) };
    db.prepare('UPDATE blobs SET envelope=? WHERE id=?').run(Buffer.from(canonical(box)), row.id);
    dek.fill(0); wrappingKey.fill(0);
    assert.throws(() => f.vault.read(digest), { code: 'INVALID', message: 'Compressed evidence invalid' });
  }
});
