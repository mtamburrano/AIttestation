import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { runNativeVerifier } from '../spikes/anchor/native-verifier.mjs';
import { FAST_CONFIRM_PROFILE, verifyFastConfirmation, verifyFastConfirmationAsync } from '../spikes/anchor/algorand/fast-confirm.mjs';

const payload = Buffer.concat([Buffer.from('PAP\x01'), Buffer.alloc(32)]);
const report = { profile: FAST_CONFIRM_PROFILE, authorized: true, anchor: 'SOURCE_CORROBORATED',
  timestamp: 'SOURCE_REPORTED', assurance: FAST_CONFIRM_PROFILE, reason: 'SYNTHETIC_TEST_VERDICT',
  round: 42, blockTime: 1700000000, blockHeaderHash: Buffer.alloc(32).toString('base64'), sourceClaimedTimes: ['a', 'b'] };
async function executable(t, program) {
  const root = await mkdtemp('/private/tmp/attestamp-native-verifier-test-'), path = join(root, 'verifier');
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path, `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',async()=>{${program}});`, { mode: 0o700 });
  return path;
}

test('async verification preserves the verdict while the synchronous baseline blocks timers', async t => {
  const verifierPath = await executable(t, `await new Promise(resolve=>setTimeout(resolve,150));process.stdout.write(${JSON.stringify(JSON.stringify(report))});`);
  const order = [];
  const baselineTimer = new Promise(resolve => setTimeout(() => { order.push('baseline timer'); resolve(); }, 10));
  assert.deepEqual(verifyFastConfirmation({}, {}, payload, { verifierPath }), report);
  order.push('baseline complete'); await baselineTimer;
  const timer = new Promise(resolve => setTimeout(() => { order.push('async timer'); resolve(); }, 10));
  assert.deepEqual(await verifyFastConfirmationAsync({}, {}, payload, { verifierPath }), report);
  order.push('async complete'); await timer;
  assert.deepEqual(order, ['baseline complete', 'baseline timer', 'async timer', 'async complete']);
});

test('async fast verification shares strict verdict and child-exit checks with offline verification', async t => {
  for (const value of [{ ...report, authorized: false }, { ...report, timestamp: 'BLOCK_HASH_BOUND' },
    { ...report, blockHeaderHash: 'invalid' }, { ...report, arbitrary: 'PRIVATE_OUTPUT' }]) {
    const verifierPath = await executable(t, `process.stdout.write(${JSON.stringify(JSON.stringify(value))});`);
    await assert.rejects(verifyFastConfirmationAsync({}, {}, payload, { verifierPath }));
    assert.throws(() => verifyFastConfirmation({}, {}, payload, { verifierPath }));
  }
  const verifierPath = await executable(t, `process.stdout.write(${JSON.stringify(JSON.stringify(report))});process.exitCode=1;`);
  await assert.rejects(verifyFastConfirmationAsync({}, {}, payload, { verifierPath }), /not authorized/);
  await assert.rejects(verifyFastConfirmationAsync({}, {}, payload, { verifierPath: '/nonexistent/attestamp-test-verifier' }), /unavailable/);
});

test('native verification bounds output, runtime and concurrent children and releases capacity', async t => {
  const slow = await executable(t, 'await new Promise(resolve=>setTimeout(resolve,1000));process.stdout.write("{}");');
  const options = { input: '{}', timeout: 100, maxBuffer: 128 };
  const first = runNativeVerifier(slow, options), second = runNativeVerifier(slow, options);
  assert.equal((await runNativeVerifier(slow, options)).error.code, 'VERIFIER_BUSY');
  assert.ok((await first).error); assert.ok((await second).error);
  for (const stream of ['stdout', 'stderr']) {
    const noisy = await executable(t, `process.${stream}.write('X'.repeat(1024));await new Promise(resolve=>setTimeout(resolve,1000));`);
    const result = await runNativeVerifier(noisy, { ...options, timeout: 2000 });
    assert.ok(result.error); assert.ok(Buffer.byteLength(result.stdout) <= options.maxBuffer);
  }
  const valid = await executable(t, 'process.stdout.write("{}");');
  assert.deepEqual(await runNativeVerifier(valid, { ...options, timeout: 2000 }), { status: 0, stdout: '{}' });
});
