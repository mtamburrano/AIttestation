import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { FAST_CONFIRM_PROFILE, ALGOD_RETRY_PROFILE, collectFastEvidence, observeAlgodOperator } from '../spikes/anchor/algorand/fast-confirm.mjs';
import { LocalDiagnostics } from '../spikes/release/diagnostics.mjs';

const archive = JSON.parse(await readFile(new URL('../spikes/anchor/algorand/proof/testdata/testnet-archive.json', import.meta.url)));
const transactionId = archive.transactionId;
const trust = {
  profile: FAST_CONFIRM_PROFILE, network: archive.network, genesis: archive.genesis,
  applicationServiceOrigin: 'https://sponsor.invalid',
  operators: [{ id: 'a', organization: 'Operator A', endpoint: 'https://a.invalid' },
    { id: 'b', organization: 'Operator B', endpoint: 'https://b.invalid' }],
};
const observation = () => ({ profile: FAST_CONFIRM_PROFILE, network: archive.network, genesis: archive.genesis,
  consensus: archive.consensus, transactionId, confirmedRound: archive.round,
  transaction: archive.transaction, signedTxnInBlock: archive.signedTxnInBlock, fullHeader: archive.fullHeader,
  transactionProof: structuredClone(archive.transactionProof), poolError: '', error: '', expired: false,
  blockHeaderHash: createHash('sha512-256').update('BH').update(Buffer.from(archive.fullHeader, 'base64')).digest('base64'),
  sourceClaimedTime: '2026-09-10T12:00:00Z' });
const transient = (code = 'ALGOD_NOT_YET_OBSERVABLE') => Object.assign(Error('PRIVATE_REMOTE_ERROR_CANARY'), { code });

test('one or both delayed operators confirm automatically without rereading a successful operator', async t => {
  for (const waits of [{ a: 0, b: 2 }, { a: 2, b: 0 }, { a: 1, b: 2 }]) {
    await t.test(JSON.stringify(waits), async () => {
      const calls = { a: 0, b: 0 }, active = { a: 0, b: 0 }, starts = [];
      const diagnostics = new LocalDiagnostics(), started = performance.now();
      const evidence = await collectFastEvidence({ trust, transactionId, waitMs: 1500, diagnostics,
        observe: async (operator, request) => {
          assert.equal(request.transactionId, transactionId); assert.equal(request.signal.aborted, false);
          assert.equal(++active[operator.id], 1); starts.push(operator.id);
          await Promise.resolve(); active[operator.id]--;
          if (calls[operator.id]++ < waits[operator.id]) throw transient(operator.id === 'a'
            ? 'ALGOD_NOT_YET_OBSERVABLE' : 'ALGOD_NOT_YET_CONFIRMED');
          return observation();
        } });
      assert.deepEqual(starts.slice(0, 2), ['a', 'b']);
      assert.deepEqual(calls, { a: waits.a + 1, b: waits.b + 1 });
      assert.equal(evidence.transactionId, transactionId);
      assert.ok(evidence.sources.every(source => source.transactionId === transactionId));
      assert.ok(evidence.observedWaitMillis >= 300 && performance.now() - started < 1500);
      const events = diagnostics.preview().report.events;
      assert.equal(events.length, waits.a + waits.b);
      assert.ok(events.every(event => ['ALGOD_NOT_YET_OBSERVABLE', 'ALGOD_NOT_YET_CONFIRMED'].includes(event.code)));
      assert.ok(!JSON.stringify(events).includes('PRIVATE_REMOTE_ERROR_CANARY'));
    });
  }
});

test('permanent absence exhausts one shared budget with bounded attempts and no background retries', async t => {
  for (const retryTime of [100, 100.5]) {
    await t.test(`second observation at ${retryTime} ms`, async t => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      syncBuiltinESMExports();
      const calls = { a: 0, b: 0 }, signals = [], diagnostics = new LocalDiagnostics();
      const controller = new AbortController();
      t.after(() => { controller.abort(); t.mock.timers.reset(); syncBuiltinESMExports(); });
      let now = 0, settled = false;
      const work = collectFastEvidence({ trust, transactionId, waitMs: 250, now: () => now,
        signal: controller.signal, diagnostics,
        observe: async (operator, request) => {
          assert.equal(request.transactionId, transactionId);
          calls[operator.id]++; signals.push(request.signal); throw transient();
        } });
      const rejected = assert.rejects(work, { code: 'PENDING_FAST_CONFIRMATION' }).then(() => { settled = true; });
      await new Promise(setImmediate);
      assert.deepEqual(calls, { a: 1, b: 1 });
      now = retryTime; t.mock.timers.tick(100);
      await new Promise(setImmediate);
      assert.deepEqual(calls, { a: 2, b: 2 });

      // Fractional callback time lets a shortened final sleep wake just before
      // the independent deadline. Neither source may start a third observation.
      now = 249.5; t.mock.timers.tick(149.5);
      await new Promise(setImmediate);
      assert.deepEqual(calls, { a: 2, b: 2 });
      assert.equal(settled, false);
      assert.ok(signals.every(signal => !signal.aborted));
      now = 250; t.mock.timers.tick(0.5);
      await rejected;
      assert.deepEqual(calls, { a: 2, b: 2 }); assert.ok(signals.every(signal => signal.aborted));
      assert.equal(diagnostics.preview().report.events.filter(event => event.code === 'CONFIRMATION_BUDGET_EXPIRED').length, 1);
      now = 1250; t.mock.timers.tick(1000);
      await new Promise(setImmediate);
      assert.deepEqual(calls, { a: 2, b: 2 });
    });
  }
});

test('abort interrupts observation and backoff, and a pre-aborted request starts no work', async t => {
  for (const phase of ['before', 'observation', 'backoff']) {
    await t.test(phase, async () => {
      const controller = new AbortController(), signals = [], diagnostics = new LocalDiagnostics();
      let calls = 0;
      if (phase === 'before') controller.abort();
      const work = collectFastEvidence({ trust, transactionId, waitMs: 1500, signal: controller.signal, diagnostics,
        observe: async (_operator, { signal }) => {
          calls++; signals.push(signal);
          if (phase === 'backoff') throw transient();
          return new Promise(() => {});
        } });
      const rejected = assert.rejects(work, { code: 'PENDING_FAST_CONFIRMATION' });
      if (phase !== 'before') { await delay(20); controller.abort(); }
      await rejected;
      assert.equal(calls, phase === 'before' ? 0 : 2); assert.ok(signals.every(signal => signal.aborted));
      assert.equal(diagnostics.preview().report.events.at(-1).code, 'CONFIRMATION_INTERRUPTED');
      await delay(110); assert.equal(calls, phase === 'before' ? 0 : 2);
    });
  }
});

test('clock overruns and observers ignoring cancellation cannot extend the wait budget', async () => {
  let now = 0;
  await assert.rejects(collectFastEvidence({ trust, transactionId, waitMs: 50, now: () => now,
    observe: async () => { now = 51; return observation(); } }), { code: 'PENDING_FAST_CONFIRMATION' });
  await assert.rejects(collectFastEvidence({ trust, transactionId, waitMs: 30,
    observe: async () => new Promise(() => {}) }), { code: 'PENDING_FAST_CONFIRMATION' });
});

test('malformed or conflicting observations and unclassified errors never get another attempt', async t => {
  const changes = [value => { delete value.transactionProof; }, value => { value.poolError = 'rejected'; },
    value => { value.expired = true; }, value => { value.confirmedRound = 0; },
    value => { value.transactionId = 'B'.repeat(52); }, value => { value.network = 'wrong'; },
    value => { value.genesis = 'wrong'; }, value => { value.profile = 'wrong'; },
    value => { value.consensus = 'wrong'; }, value => { value.fullHeader = 'wrong'; },
    value => { value.transaction = 'wrong'; }, value => { value.signedTxnInBlock = 'wrong'; },
    value => { value.transactionProof.proof = 'wrong'; }, value => { value.blockHeaderHash = 'wrong'; }];
  for (const index of [0, 1]) {
    for (let change = 0; change < changes.length; change++) {
      await t.test(`operator ${index}, conflict ${change}`, async () => {
        const calls = { a: 0, b: 0 };
        await assert.rejects(collectFastEvidence({ trust, transactionId, waitMs: 1000, observe: async operator => {
          calls[operator.id]++;
          const result = observation(); if (operator.id === trust.operators[index].id) changes[change](result);
          return result;
        } }));
        assert.deepEqual(calls, { a: 1, b: 1 });
      });
    }
  }
  for (const code of ['INVALID_FAST_CONFIRMATION', 'PENDING_FAST_CONFIRMATION', 'ENOENT', null]) {
    let calls = 0;
    await assert.rejects(collectFastEvidence({ trust, transactionId, observe: async () => { calls++; throw transient(code); } }));
    assert.equal(calls, 2);
  }
});

test('invalid or non-independent operator configuration is rejected before observations', async () => {
  for (const change of [value => { value.operators[1].id = 'a'; },
    value => { value.operators[1].organization = 'operator a'; },
    value => { value.operators[1].endpoint = 'https://a.invalid'; },
    value => { value.operators[0].endpoint = 'https://sponsor.invalid'; },
    value => { value.operators[0].endpoint = 'http://a.invalid'; },
    value => { value.operators[0].endpoint = 'https://a.invalid/../'; },
    value => { value.operators[0].organization = ' '; }]) {
    const invalid = structuredClone(trust); change(invalid);
    await assert.rejects(collectFastEvidence({ trust: invalid, transactionId,
      observe: async () => { assert.fail('invalid configuration must not start observations'); } }));
  }
  await assert.rejects(collectFastEvidence({ trust, transactionId: 'not canonical', observe: async () => assert.fail() }));
});

test('a terminal source aborts the other source instead of waiting for a later consistent answer', async () => {
  const calls = { a: 0, b: 0 }, signals = [];
  await assert.rejects(collectFastEvidence({ trust, transactionId, waitMs: 1500,
    observe: async (operator, { signal }) => {
      calls[operator.id]++; signals.push(signal);
      if (operator.id === 'a') throw transient();
      return { ...observation(), genesis: 'conflict' };
    } }), { code: 'INVALID_FAST_CONFIRMATION' });
  assert.ok(signals.every(signal => signal.aborted));
  await delay(120); assert.deepEqual(calls, { a: 1, b: 1 });
});

test('trust and operator labels remain fixed if caller data changes during retries', async () => {
  const config = structuredClone(trust); let calls = 0;
  const evidence = await collectFastEvidence({ trust: config, transactionId, observe: async operator => {
    if (!calls++) { config.operators[0].id = 'mutated'; throw transient(); }
    assert.ok(['a', 'b'].includes(operator.id)); return observation();
  } });
  assert.deepEqual(evidence.sources.map(source => source.operatorId), ['a', 'b']);
});

async function observerScript(t, source) {
  const root = await mkdtemp(join(tmpdir(), 'attestamp-observer-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'observer.mjs');
  await writeFile(path, `#!${process.execPath}\nimport fs from 'node:fs';\nconst request = JSON.parse(fs.readFileSync(0, 'utf8'));\n${source}\n`, { mode: 0o700 });
  return { root, path };
}

test('the process boundary retries only the versioned transaction-bound transient outcome', async t => {
  const { path } = await observerScript(t, `
    const counter = new URL(request.operator.id + '.count', import.meta.url);
    const count = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
    fs.writeFileSync(counter, String(count + 1));
    if (count === 0) {
      process.stdout.write(JSON.stringify({ profile: ${JSON.stringify(ALGOD_RETRY_PROFILE)}, transactionId: request.transactionId, reason: 'ALGOD_NOT_YET_CONFIRMED' }));
      process.exitCode = 2;
    } else process.stdout.write(${JSON.stringify(JSON.stringify(observation()))});
  `);
  const evidence = await collectFastEvidence({ trust, transactionId, observerPath: path, waitMs: 1500 });
  assert.equal(evidence.sources.length, 2);
  for (const id of ['a', 'b']) assert.equal(await readFile(join(path, '..', `${id}.count`), 'utf8'), '2');
});

test('process failures and malformed retry messages are terminal and discard remote diagnostics', async t => {
  for (const [name, source] of [
    ['ordinary exit', `process.stdout.write('PRIVATE_REMOTE_ERROR_CANARY'); process.exitCode = 1;`],
    ['malformed evidence', `process.stdout.write('{}');`],
    ['wrong retry transaction', `process.stdout.write(JSON.stringify({ profile: ${JSON.stringify(ALGOD_RETRY_PROFILE)}, transactionId: 'B'.repeat(52), reason: 'ALGOD_NOT_YET_OBSERVABLE' })); process.exitCode = 2;`],
    ['unknown retry reason', `process.stdout.write(JSON.stringify({ profile: ${JSON.stringify(ALGOD_RETRY_PROFILE)}, transactionId: request.transactionId, reason: 'PRIVATE_REMOTE_ERROR_CANARY' })); process.exitCode = 2;`],
    ['ambiguous retry message', `process.stdout.write('{"profile":${JSON.stringify(ALGOD_RETRY_PROFILE)},"transactionId":"' + request.transactionId + '","reason":"INVALID","reason":"ALGOD_NOT_YET_OBSERVABLE"}'); process.exitCode = 2;`],
    ['stdout limit', `process.stdout.write('x'.repeat(9 * 1024 * 1024));`],
    ['stderr limit', `process.stderr.write('x'.repeat(9 * 1024 * 1024));`],
  ]) {
    await t.test(name, async t => {
      const { path } = await observerScript(t, source);
      await assert.rejects(collectFastEvidence({ trust, transactionId, observerPath: path, waitMs: 1500 }), error => {
        assert.equal(error.code, 'INVALID_FAST_CONFIRMATION'); assert.ok(!error.message.includes('PRIVATE_REMOTE_ERROR_CANARY')); return true;
      });
    });
  }
  await assert.rejects(observeAlgodOperator(trust.operators[0], { transactionId,
    observerPath: '/nonexistent/attestamp-test-observer' }), { code: 'INVALID_FAST_CONFIRMATION' });
});

test('deadline kills hanging observer processes and pre-abort spawns none', async t => {
  const { path, root } = await observerScript(t, `
    fs.writeFileSync(new URL(request.operator.id + '.pid', import.meta.url), String(process.pid));
    setInterval(() => {}, 1000);
  `);
  await assert.rejects(collectFastEvidence({ trust, transactionId, observerPath: path, waitMs: 500 }), { code: 'PENDING_FAST_CONFIRMATION' });
  await delay(100);
  for (const id of ['a', 'b']) {
    const pid = Number(await readFile(join(root, `${id}.pid`), 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(observeAlgodOperator(trust.operators[0], { transactionId, signal: controller.signal,
    observerPath: '/nonexistent/attestamp-test-observer' }), { code: 'PENDING_FAST_CONFIRMATION' });
});
