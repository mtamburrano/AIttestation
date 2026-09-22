import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { Vault } from '../spikes/vault/vault.mjs';
import { DurableVault, MemoryKeyStore, MacOSKeychainStore } from '../spikes/vault/key-lifecycle.mjs';
import { LocalReceipts } from '../spikes/recipient/local.mjs';
import { ManagedAnchoringClient } from '../spikes/managed/client.mjs';
import { localTLSRequest } from '../spikes/development/tls.mjs';
import { verifyPortable } from '../spikes/recipient/portable.mjs';
import { recordingFixture, until } from './recording-fixture.mjs';
import { measureRuntimeLatency } from './runtime-latency.mjs';

async function isolated(t) {
  const root = await mkdtemp('/private/tmp/attestamp-latency-regression-test-');
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}

test('retained history and an unavailable sponsor stay within the local control budget with debug on/off', async t => {
  const report = await measureRuntimeLatency({ check: true });
  t.diagnostic(JSON.stringify(report));
});

test('vault read caches invalidate on other writers, ciphertext tampering, failed writes and custody reopen', async t => {
  const root = await isolated(t), directory = join(root, 'vault'), keyStore = new MemoryKeyStore();
  const vault = DurableVault.create(directory, { keyStore }); t.after(() => vault.close());
  const receipts = new LocalReceipts(vault);
  const base = vault.capture(Buffer.from('SYNTHETIC_ORIGINAL'));
  const derivative = { type: 'derivative', relationships: [{ type: 'redacted_from', recordDigest: base.recordDigest,
    objectDigest: base.manifest.evidence[0].objectDigest }] };
  const first = vault.capture(Buffer.from('SYNTHETIC_DERIVATIVE'), derivative);
  assert.equal(receipts.list().length, 1); const revision = vault.revision;
  const copy = receipts.list(); copy[0].recordIds.push('mutated');
  assert.equal(receipts.list()[0].recordIds.length, 1);
  const other = DurableVault.open(directory, { keyStore });
  other.capture(Buffer.from('SYNTHETIC_OTHER_WRITER'), derivative); other.close();
  assert.equal(receipts.list().length, 2); assert.notEqual(vault.revision, revision);
  vault.lock(); assert.throws(() => receipts.list()); vault.unlock();
  assert.equal(receipts.list().length, 2);
  const preview = receipts.prepare({ ids: [first.manifest.eventId] });
  assert.ok(verifyPortable(receipts.export(preview.previewId)).records.every(record => record.integrity === 'VALID'));
  const db = new DatabaseSync(join(directory, 'vault.sqlite'));
  try { db.prepare('UPDATE blobs SET envelope=? WHERE id=?').run(Buffer.from('{}'),
    vault.inspect().objects.find(object => object.digest === first.manifest.evidence[0].objectDigest).id); }
  finally { db.close(); }
  assert.throws(() => vault.read(first.manifest.evidence[0].objectDigest));
  assert.throws(() => receipts.prepare({ ids: [first.manifest.eventId] }));
  assert.throws(() => vault.verifyAll());
  const key = randomBytes(32), failedDirectory = join(root, 'failed-vault'); let fail = false;
  const failed = new Vault(failedDirectory, key, undefined, { create: true,
    fault: phase => { if (fail && phase === 'before-commit') throw Error('SYNTHETIC_DISK_FAILURE'); } });
  t.after(() => failed.close());
  failed.capture(Buffer.from('SYNTHETIC_RETAINED')); fail = true;
  assert.throws(() => failed.capture(Buffer.from('SYNTHETIC_FAILED')), /SYNTHETIC_DISK_FAILURE/);
  assert.equal(failed.inspect().records.length, 1); assert.equal(failed.verifyAll().count, 1);
});

test('pending receipt survives the old expiry and becomes saved after delayed admission, without another Send', async t => {
  const root = await isolated(t); let f, release;
  const held = new Promise(resolve => { release = resolve; });
  t.after(async () => { release(); await f?.close(); });
  f = await recordingFixture(root, { beforeCapture: async () => held }); await f.recording(true);
  f.send('SYNTHETIC_DELAYED_ADMISSION');
  await until(() => f.pages.get(17).feedback === 'Attestamp · Save confirmation pending · Check History');
  await delay(4500);
  assert.match(f.pages.get(17).feedback, /confirmation pending/);
  assert.equal(f.runtime.session.receipts.list().length, 0); release();
  await until(() => f.pages.get(17).feedback === 'Attestamp · Prompt saved');
  assert.equal(f.deliveries.length, 1); assert.equal(f.pages.get(17).requests.length, 1);
  assert.equal(f.runtime.session.receipts.list().length, 1); assert.equal(f.prevention, 0);
});

test('receipt reconciliation is exact-ID and source-bound, and deduplicated event IDs survive restart', async t => {
  const root = await isolated(t); let f;
  t.after(async () => { await f?.close(); });
  f = await recordingFixture(root); await f.recording(true);
  const payload = { conversation_id: 'fixture-17', messages: [{ id: 'synthetic-stable-id', author: { role: 'user' },
    content: { content_type: 'text', parts: ['SYNTHETIC_EQUAL_TEXT'] } }] };
  await f.pages.get(17).request('SYNTHETIC_EQUAL_TEXT', payload);
  await until(() => f.pages.get(17).feedback === 'Attestamp · Prompt saved');
  await f.pages.get(18).request('SYNTHETIC_EQUAL_TEXT', payload);
  await until(() => f.pages.get(18).feedback === 'Attestamp · Prompt saved');
  const original = f.deliveries[0].observation, alias = f.deliveries[1].observation;
  assert.notEqual(alias.eventId, original.eventId);
  const receipt = f.runtime.session.captureReceipt(original.eventId, original.source);
  assert.equal(receipt.state, 'PROMPT_SAVED');
  assert.equal(f.runtime.session.captureReceipt(alias.eventId, alias.source).receiptId, receipt.receiptId);
  assert.equal(f.runtime.session.captureReceipt(alias.eventId, alias.source).deduplicated, true);
  assert.equal(f.runtime.session.captureReceipt(original.eventId, alias.source).state, 'SAVE_PENDING');
  assert.equal(f.runtime.session.captureReceipt(randomUUID(), original.source).state, 'SAVE_PENDING');
  assert.throws(() => f.runtime.engine.captureReceipt({ profile: receipt.profile, eventId: original.eventId, source: null }));
  const foreign = await f.worker.message({ kind: 'PAP_CAPTURE_RECEIPT', pageContract: original.source.pageContract,
    eventId: original.eventId }, f.pages.get(18).captureSender());
  assert.equal(foreign.state, 'SAVE_PENDING');
  await f.pages.get(17).request('SYNTHETIC_EQUAL_TEXT');
  await until(() => f.runtime.session.receipts.list().length === 2);
  await f.runtime.engine.drain(); await f.restart();
  assert.equal(f.runtime.session.captureReceipt(original.eventId).receiptId, receipt.receiptId);
  assert.equal(f.runtime.session.captureReceipt(alias.eventId).receiptId, receipt.receiptId);
  assert.equal(f.runtime.session.receipts.list().length, 2);
  const url = new URL(f.runtime.dashboardURL);
  const response = await fetch(new URL('/capture/receipt', url), { method: 'POST',
    headers: { Origin: url.origin, Authorization: `Bearer ${url.hash.slice(1)}` }, body: JSON.stringify({ eventId: alias.eventId }) });
  assert.equal(response.status, 200); assert.equal((await response.json()).receiptId, receipt.receiptId);
});

test('an older engine receives no unsupported receipt queries and its late exact reply still confirms', async t => {
  const root = await isolated(t); let f;
  t.after(async () => { await f?.close(); });
  f = await recordingFixture(root, { receiptQueries: false }); await f.recording(true);
  const emit = f.port.onMessage.emit, held = [];
  f.port.onMessage.emit = message => message.kind === 'PAP_CAPTURE_RESULT' ? held.push(message) : emit(message);
  f.send('SYNTHETIC_OLDER_ENGINE');
  await until(() => f.pages.get(17).feedback === 'Attestamp · Save confirmation pending · Check History');
  await delay(1200);
  assert.equal(f.port.messages.filter(message => message.kind === 'PAP_CAPTURE_RECEIPT').length, 0);
  assert.equal(f.deliveries.length, 1); assert.equal(held.length, 1);
  emit(held[0]); await until(() => f.pages.get(17).feedback === 'Attestamp · Prompt saved');
  assert.equal(f.pages.get(17).requests.length, 1);
});

test('a descriptor committed before a local error reconciles as saved while new capture fails closed', async t => {
  const root = await isolated(t); let f;
  t.after(async () => { await f?.close(); });
  f = await recordingFixture(root); await f.recording(true);
  const capture = f.runtime.session.vault.capture.bind(f.runtime.session.vault);
  f.runtime.session.vault.capture = (...args) => {
    const record = capture(...args);
    if (args[1]?.type === 'observation' && args[0].includes('normal-request-observed')) throw Error('SYNTHETIC_POST_COMMIT_ERROR');
    return record;
  };
  f.send('SYNTHETIC_POST_COMMIT_CAPTURE');
  await until(() => f.results.some(message => message.result.state === 'PROMPT_SAVED'));
  const observation = f.deliveries[0].observation;
  assert.equal(f.runtime.session.captureReceipt(observation.eventId, observation.source).state, 'PROMPT_SAVED');
  assert.equal(f.runtime.session.receipts.list().length, 1); assert.equal(f.runtime.engine.state().available, false);
  assert.equal(f.pages.get(17).requests.length, 1); assert.equal(f.deliveries.length, 1);
  f.runtime.session.vault.capture = capture;
  await f.restart();
  assert.equal(f.runtime.session.captureReceipt(observation.eventId).state, 'PROMPT_SAVED');
  assert.equal(f.runtime.session.receipts.list().length, 1);
});

test('a framed native broker wait leaves timers responsive and preserves request ordering', { skip: process.platform !== 'darwin' }, async t => {
  await isolated(t);
  const child = spawn(process.execPath, [new URL('./keychain-broker-child.mjs', import.meta.url).pathname],
    { env: {}, stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'], timeout: 5000 });
  t.after(() => child.kill());
  let buffer = Buffer.alloc(0), output = '', error = ''; const accounts = [];
  child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { error += bytes; });
  child.stdio[3].on('data', bytes => {
    buffer = Buffer.concat([buffer, bytes]);
    if (buffer.length < 4 || buffer.length < buffer.readUInt32BE() + 4) return;
    const size = buffer.readUInt32BE(), request = JSON.parse(buffer.subarray(4, size + 4));
    buffer = buffer.subarray(size + 4); accounts.push(request.account);
    const body = Buffer.from(JSON.stringify({ profile: 'pap-keychain-response/1', status: 'OK',
      value: Buffer.from(accounts.length === 1 ? 'SYNTHETIC_FIRST' : 'SYNTHETIC_SECOND').toString('base64url') }));
    const frame = Buffer.alloc(body.length + 4); frame.writeUInt32BE(body.length); body.copy(frame, 4);
    setTimeout(() => { child.stdio[4].write(frame.subarray(0, 2)); setTimeout(() => child.stdio[4].write(frame.subarray(2)), 30); }, 100);
  });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  assert.equal(code, 0, error); assert.deepEqual(accounts, ['synthetic-first', 'synthetic-second']);
  assert.equal(JSON.parse(output).ordered, true);
});

test('managed asynchronous credential lookup respects lock and disconnect while the sponsor is off', async t => {
  await isolated(t); let release, requests = 0;
  const held = new Promise(resolve => { release = resolve; });
  const store = new MacOSKeychainStore({ run: async request => {
    if (request.operation === 'get') await held;
    return { status: 0, stdout: JSON.stringify({ profile: 'pap-keychain-response/1', status: 'OK',
      value: Buffer.from('a'.repeat(43)).toString('base64url') }) };
  } });
  const client = new ManagedAnchoringClient({ origin: 'https://synthetic.invalid', keyStore: store,
    request: async () => { requests++; throw Error('SYNTHETIC_UNAVAILABLE'); } });
  const payload = Buffer.concat([Buffer.from('PAP\x01'), randomBytes(32)]).toString('base64url');
  const submission = client.submit(payload); await client.disconnect(); release();
  await assert.rejects(submission, { code: 'ACCOUNT_REQUIRED' }); assert.equal(requests, 0);
  const locked = new MacOSKeychainStore({ run: async () => ({ status: 0,
    stdout: JSON.stringify({ profile: 'pap-keychain-response/1', status: 'LOCKED' }) }) });
  await assert.rejects(locked.getAsync('synthetic-locked'), { code: 'LOCKED' });
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `https://127.0.0.1:${server.address().port}`; await new Promise(resolve => server.close(resolve));
  const start = performance.now();
  await assert.rejects(localTLSRequest(Buffer.from('SYNTHETIC_UNUSED_PIN'), origin)(origin, '/v1/account', 'a'.repeat(43)),
    { code: 'SERVICE_UNAVAILABLE' });
  assert.ok(performance.now() - start < 1000);
});
