import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { canonical, b64 } from '../spikes/vault/format.mjs';
import { MemoryKeyStore } from '../spikes/vault/key-lifecycle.mjs';
import { ManagedSponsorship, DEFAULT_LIMITS } from '../spikes/managed/service.mjs';
import { startManagedServer } from '../spikes/managed/http.mjs';
import { ManagedAnchoringClient, managedOrigin } from '../spikes/managed/client.mjs';
import { MANAGED_PROFILE, MANAGED_NETWORK } from '../spikes/managed/protocol.mjs';

const request = () => ({ profile: MANAGED_PROFILE, payload: b64(Buffer.concat([Buffer.from('PAP\x01'), randomBytes(32)])) });
async function fixture(t, { limits = {}, sponsor: suppliedSponsor } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'provenance-managed-test-'));
  let now = Date.parse('2026-09-11T12:00:00Z');
  const prepared = [], broadcasts = [];
  const sponsor = suppliedSponsor ?? {
    async prepare(payload) {
      prepared.push(payload);
      return { transactionId: `${String.fromCharCode(65 + prepared.length)}${'A'.repeat(51)}`,
        signedTransaction: Buffer.from(`synthetic:${payload}`).toString('base64'),
        feeMicroAlgos: 1000, network: MANAGED_NETWORK };
    },
    async broadcast(value) { broadcasts.push(structuredClone(value)); },
  };
  const options = { limits: { ...DEFAULT_LIMITS, ...limits }, sponsor, now: () => now };
  let service = new ManagedSponsorship(root, options);
  const account = service.provision({ paidThrough: now + 86400000 });
  t.after(async () => { service.close(); await rm(root, { recursive: true, force: true }); });
  return { root, account, prepared, broadcasts, sponsor, options,
    get service() { return service; }, get now() { return now; }, set now(time) { now = time; },
    restart() { service.close(); service = new ManagedSponsorship(root, options); },
  };
}
const code = expected => error => error.code === expected;

test('persistent quotas survive replay, renewal, credential recovery, restart and clock rollback', async t => {
  const f = await fixture(t, { limits: { accountMonth: 2, accountDay: 2 } });
  const first = request(), second = request(); let token = f.account.accessCode;
  const initial = await f.service.anchor(token, first);
  assert.deepEqual(await f.service.anchor(token, first), initial);
  assert.equal(f.prepared.length, 1); assert.equal(f.broadcasts.length, 1);
  await f.service.anchor(token, second);
  await assert.rejects(f.service.anchor(token, request()), code('QUOTA_EXHAUSTED'));
  f.service.setSubscription(f.account.accountId, f.now + 90 * 86400000);
  token = f.service.rotateAccessCode(f.account.accountId).accessCode;
  assert.throws(() => f.service.account(f.account.accessCode), code('ACCOUNT_REQUIRED'));
  f.restart();
  assert.equal(f.service.account(token).remaining, 0);
  await assert.rejects(f.service.anchor(token, request()), code('QUOTA_EXHAUSTED'));
  f.now += 86400000;
  await assert.rejects(f.service.anchor(token, request()), code('QUOTA_EXHAUSTED'));
  f.now = Date.parse('2026-10-01T00:00:00Z');
  assert.equal(f.service.account(token).remaining, 2);
  await f.service.anchor(token, request());
  f.now = Date.parse('2026-09-01T00:00:00Z');
  assert.equal(f.service.account(token).month, '2026-10');
  assert.equal(f.service.account(token).remaining, 1);
  f.service.setSubscription(f.account.accountId, f.now);
  assert.equal(f.service.account(token).state, 'UNPAID');
  await assert.rejects(f.service.anchor(token, request()), code('UNPAID'));
  assert.equal((await f.service.anchor(token, first)).transactionId, initial.transactionId,
    'expired accounts retain access to their already reserved transaction');
});

test('daily and global limits bound concurrent accounts across database connections', async t => {
  const f = await fixture(t, { limits: { accountDay: 1, globalDay: 2 } });
  const other = new ManagedSponsorship(f.root, f.options);
  try {
    const second = other.provision({ paidThrough: f.now + 86400000 });
    const third = f.service.provision({ paidThrough: f.now + 86400000 });
    const results = await Promise.allSettled([
      f.service.anchor(f.account.accessCode, request()), other.anchor(second.accessCode, request()),
      f.service.anchor(third.accessCode, request()),
    ]);
    assert.equal(results.filter(value => value.status === 'fulfilled').length, 2);
    assert.equal(f.prepared.length, 2);
    assert.equal(results[2].reason.code, 'SERVICE_UNAVAILABLE');
    await assert.rejects(f.service.anchor(f.account.accessCode, request()), code('QUOTA_EXHAUSTED'));
  } finally { other.close(); }
});

test('ambiguous broadcast and restart never re-sign; replay budget is durable and bounded', async t => {
  const f = await fixture(t); const original = f.sponsor.broadcast;
  f.sponsor.broadcast = async value => { await original(value); throw Error('lost RPC response'); };
  const body = request(), initial = await f.service.anchor(f.account.accessCode, body);
  assert.equal(initial.state, 'SUBMITTED_OR_UNKNOWN');
  for (let i = 0; i < 5; i++) {
    f.now += 10001; f.restart();
    assert.deepEqual(await f.service.anchor(f.account.accessCode, body), initial);
  }
  assert.equal(f.prepared.length, 1); assert.equal(f.broadcasts.length, 3);
  assert.ok(f.broadcasts.every(value => canonical(value) === canonical(f.broadcasts[0])));
});

test('concurrent duplicate requests and interrupted preparation cannot obtain fresh fee authority', async t => {
  const f = await fixture(t);
  let unlock, entered;
  const gate = new Promise(resolve => { unlock = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const original = f.sponsor.prepare;
  f.sponsor.prepare = async payload => { entered(); await gate; return original(payload); };
  const body = request(), first = f.service.anchor(f.account.accessCode, body);
  await started;
  await assert.rejects(f.service.anchor(f.account.accessCode, body), code('SERVICE_UNAVAILABLE'));
  unlock(); await first;
  assert.equal(f.prepared.length, 1);
  f.sponsor.prepare = async () => { throw Error('interrupted before preparation'); };
  const interrupted = request();
  await assert.rejects(f.service.anchor(f.account.accessCode, interrupted), code('SERVICE_UNAVAILABLE'));
  f.restart(); f.sponsor.prepare = original;
  await assert.rejects(f.service.anchor(f.account.accessCode, interrupted), code('SUBMISSION_INTERRUPTED'));
  assert.equal(f.prepared.length, 1); assert.equal(f.service.account(f.account.accessCode).remaining, 998);
});

test('abrupt process exit preserves quota and pre-broadcast transaction intent', async t => {
  for (const phase of ['prepare', 'broadcast']) {
    await t.test(phase, async t => {
      const f = await fixture(t), body = request();
      const child = spawnSync(process.execPath, [new URL('./managed-crash-child.mjs', import.meta.url).pathname], {
        env: {}, encoding: 'utf8', timeout: 10000,
        input: JSON.stringify({ directory: f.root, token: f.account.accessCode, request: body, phase, now: f.now }),
      });
      assert.equal(child.status, phase === 'prepare' ? 71 : 72, child.stderr);
      f.restart();
      assert.equal(f.service.account(f.account.accessCode).remaining, 999);
      if (phase === 'prepare') await assert.rejects(f.service.anchor(f.account.accessCode, body), code('SUBMISSION_INTERRUPTED'));
      else {
        f.now += 10001;
        assert.equal((await f.service.anchor(f.account.accessCode, body)).transactionId, 'C'.repeat(52));
        assert.equal(f.broadcasts[0].signedTransaction, Buffer.from('test-only-crash-transaction').toString('base64'));
      }
      assert.equal(f.prepared.length, 0, 'crash recovery cannot sign a replacement transaction');
    });
  }
});

test('request rates, policy and ledger capacity fail closed across restart', async t => {
  const f = await fixture(t, { limits: { accountMinute: 2, globalMinute: 4, ledger: 1, accounts: 1 } });
  assert.throws(() => f.service.provision({ paidThrough: f.now + 1000 }), /capacity/);
  await f.service.anchor(f.account.accessCode, request());
  await assert.rejects(f.service.anchor(f.account.accessCode, request()), code('SERVICE_UNAVAILABLE'));
  f.restart();
  assert.throws(() => f.service.account(f.account.accessCode), code('RATE_LIMITED'));
  assert.throws(() => f.service.account('not a code'), code('ACCOUNT_REQUIRED'));
  f.restart();
  assert.throws(() => f.service.account('not a code'), code('RATE_LIMITED'));
  f.now += 60000;
  assert.equal(f.service.account(f.account.accessCode).remaining, 999);
  assert.throws(() => new ManagedSponsorship(f.root, { ...f.options, limits: { ...f.options.limits, accounts: 2 } }), /policy mismatch/);
});

test('submission requires local credentials and a successful synchronous attempt checkpoint before any request', async () => {
  let requests = 0, checkpoints = 0;
  const client = new ManagedAnchoringClient({ origin: 'https://managed.example', keyStore: new MemoryKeyStore(),
    request: async () => { requests++; return { profile: MANAGED_PROFILE, accountId: randomUUID(), state: 'ACTIVE',
      paidThrough: 1, month: '2026-09', remaining: 5 }; } });
  const payload = request().payload, beforeSubmit = () => { checkpoints++; throw Error('SYNTHETIC_ATTEMPT_WRITE_FAILURE'); };
  await assert.rejects(client.submit(payload, { beforeSubmit }), code('ACCOUNT_REQUIRED'));
  assert.equal(requests, 0); assert.equal(checkpoints, 0);
  await client.connect('a'.repeat(43)); assert.equal(requests, 1);
  await assert.rejects(client.submit(payload, { beforeSubmit }), /SYNTHETIC_ATTEMPT_WRITE_FAILURE/);
  assert.equal(requests, 1); assert.equal(checkpoints, 1);
});

test('HTTP client sends only blinded payload and scoped credential; no token is persisted by the service', async t => {
  const f = await fixture(t), server = await startManagedServer(f.service);
  t.after(() => server.close());
  const keyStore = new MemoryKeyStore(), options = { origin: server.origin, keyStore, allowLoopbackForTests: true };
  const client = new ManagedAnchoringClient(options);
  assert.equal((await client.status()).state, 'ACCOUNT_REQUIRED');
  assert.equal((await client.connect(f.account.accessCode)).state, 'ACTIVE');
  const body = request(), result = await client.submit(body.payload);
  assert.equal(result.payload, body.payload); assert.deepEqual(f.prepared, [body.payload]);
  const relaunched = new ManagedAnchoringClient(options);
  assert.equal((await relaunched.status()).remaining, 999);
  const db = new DatabaseSync(join(f.root, 'sponsorship.sqlite'), { readOnly: true });
  try {
    const rows = canonical({ accounts: db.prepare('SELECT * FROM accounts').all().map(row => ({ ...row })),
      anchors: db.prepare('SELECT * FROM anchors').all().map(row => ({ ...row })) });
    assert.equal(rows.includes(f.account.accessCode), false);
    assert.ok(rows.includes(body.payload));
    assert.deepEqual(Object.keys(db.prepare('SELECT * FROM anchors').get()).sort(),
      ['account', 'broadcasts', 'created', 'day', 'last_broadcast', 'month', 'payload', 'prepared']);
  } finally { db.close(); }
  f.service.setSubscription(f.account.accountId, f.now);
  assert.equal((await relaunched.status()).state, 'UNPAID');
  await assert.rejects(relaunched.submit(request().payload), code('UNPAID'));
  relaunched.disconnect(); assert.equal(keyStore.accounts().length, 0);
  assert.equal((await client.status()).state, 'ACCOUNT_REQUIRED');
});

test('service rejects hostile request schemas, unauthenticated traffic and oversized bodies before signing', async t => {
  const f = await fixture(t), server = await startManagedServer(f.service); t.after(() => server.close());
  const headers = { Authorization: `Bearer ${f.account.accessCode}`, 'Content-Type': 'application/json' };
  for (const extra of ['text', 'filename', 'recordDigest', 'signingKey', 'decryptionKey', 'endpoint', 'fee']) {
    const reply = await fetch(`${server.origin}/v1/anchors`, { method: 'POST', headers,
      body: canonical({ ...request(), [extra]: 'PRIVATE_CANARY' }) });
    assert.equal(reply.status, 400);
  }
  for (const body of ['{"profile":"x","profile":"y","payload":"x"}', 'x'.repeat(257), canonical({ profile: MANAGED_PROFILE, payload: b64(randomBytes(36)) })]) {
    assert.equal((await fetch(`${server.origin}/v1/anchors`, { method: 'POST', headers, body })).status, 400);
  }
  assert.equal((await fetch(`${server.origin}/v1/anchors`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: canonical(request()) })).status, 401);
  assert.equal((await fetch(`${server.origin}/v1/account`, { headers: { ...headers, Origin: 'https://hostile.example' } })).status, 400);
  assert.equal((await fetch(`${server.origin}/v1/provision`, { method: 'POST', headers, body: '{}' })).status, 400);
  assert.equal(f.prepared.length, 0);
});

test('client rejects redirect, oversized/misbound responses and unapproved origins without following them', async t => {
  for (const origin of ['http://service.example', 'https://service.example/path', 'https://u:p@service.example', 'https://service.example?query']) {
    assert.throws(() => managedOrigin(origin));
  }
  let hits = 0, mode = 'redirect';
  const server = createServer((request, response) => {
    hits++;
    if (mode === 'redirect') response.writeHead(307, { Location: 'http://127.0.0.1:1/never' }).end();
    else response.end('x'.repeat(5000));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const keyStore = new MemoryKeyStore(), client = new ManagedAnchoringClient({
    origin: `http://127.0.0.1:${server.address().port}`, keyStore, allowLoopbackForTests: true });
  await assert.rejects(client.connect(b64(randomBytes(32))), code('SERVICE_UNAVAILABLE'));
  mode = 'oversized';
  await assert.rejects(client.connect(b64(randomBytes(32))), code('SERVICE_UNAVAILABLE'));
  assert.equal(hits, 2); assert.equal(keyStore.accounts().length, 0);
  const fake = new ManagedAnchoringClient({ origin: 'https://managed.example', keyStore,
    request: async (_origin, path) => path.endsWith('/account')
      ? { profile: MANAGED_PROFILE, accountId: 'a'.repeat(36), state: 'ACTIVE', paidThrough: 1, month: '2026-09', remaining: 5 }
      : { profile: MANAGED_PROFILE, network: MANAGED_NETWORK, payload: request().payload,
        transactionId: 'A'.repeat(52), state: 'SUBMITTED_OR_UNKNOWN' } });
  await fake.connect(b64(randomBytes(32)));
  await assert.rejects(fake.submit(request().payload), code('SERVICE_UNAVAILABLE'));
});
