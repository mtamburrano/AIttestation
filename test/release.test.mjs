import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReleaseRuntime, digest, capabilities } from '../spikes/release/runtime.mjs';
import { startFixture } from '../spikes/release/fixture.mjs';

const payload = { text: 'private e\u0301\r\n☕', attachments: [{ name: 'sample.bin', bytes: Buffer.from([0, 255, 13, 10]).toString('base64') }] };
async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), 'provenance-release-test-'));
  t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}
async function prepare(runtime, scope = 'tab-one') {
  const seal = await runtime.seal(payload, scope);
  return { id: seal.id, scope, expectedDigest: seal.digest, currentPayload: payload };
}
test('no egress without confirmation; durable exact bytes precede single concurrent dispatch', async t => {
  const dir = await temporary(t), sent = [];
  const runtime = await new ReleaseRuntime(dir, async a => {
    const disk = JSON.parse(await readFile(join(dir, 'release-test-journal.json')));
    assert.equal(disk.attempts[a.attemptId].state, 'DISPATCHING');
    assert.equal(disk.seals[a.sealId].authorization, null);
    assert.deepEqual(a.payload, payload); sent.push(a); return 'SUBMISSION_OBSERVED';
  }).init();
  const request = await prepare(runtime);
  await assert.rejects(runtime.release(request), /confirmation/); assert.equal(sent.length, 0);
  await runtime.confirm(request.id, request.scope, request.expectedDigest);
  const results = await Promise.allSettled([runtime.release(request), runtime.release(request)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(sent.length, 1);
  assert.equal(results.find(r => r.status === 'fulfilled').value.providerReceipt, 'UNKNOWN');
});
test('edits, changed attachments, scope, confirmation digest and protocol fail closed', async t => {
  const sent = [], runtime = await new ReleaseRuntime(await temporary(t), async a => { sent.push(a); }).init();
  const request = await prepare(runtime);
  await assert.rejects(runtime.confirm(request.id, request.scope, 'wrong'), /Stale/);
  await runtime.confirm(request.id, request.scope, request.expectedDigest);
  for (const change of [ { scope: 'tab-two' }, { expectedDigest: 'wrong' }, { protocol: 'other' },
    { currentPayload: { ...payload, text: 'edited' } }, { currentPayload: { ...payload, attachments: [] } } ]) {
    await assert.rejects(runtime.release({ ...request, ...change }));
  }
  assert.equal(sent.length, 0);
  await assert.rejects(runtime.seal({ ...payload, attachments: [{ reference: 'file:///secret' }] }, 'tab-one'));
});
for (const crashAt of ['before-consumption', 'after-consumption', 'after-egress']) {
  test(`restart after ${crashAt}; no automatic resend and explicit retry consumes new authorization`, async t => {
    const dir = await temporary(t), sent = [];
    const dispatch = async a => { sent.push(a); return 'SUBMISSION_OBSERVED'; };
    let runtime = await new ReleaseRuntime(dir, dispatch, phase => { if (phase === crashAt) throw Error('simulated crash'); }).init();
    const request = await prepare(runtime);
    await runtime.confirm(request.id, request.scope, request.expectedDigest);
    await assert.rejects(runtime.release(request), /simulated crash/);
    runtime = await new ReleaseRuntime(dir, dispatch).init();
    assert.equal(sent.length, crashAt === 'after-egress' ? 1 : 0);
    const attempts = Object.values(runtime.snapshot().attempts);
    if (crashAt === 'before-consumption') { assert.equal(attempts.length, 0); await runtime.release(request); }
    else {
      assert.equal(attempts[0].state, 'OUTCOME_UNKNOWN');
      await assert.rejects(runtime.release(request), /confirmation/);
      await assert.rejects(runtime.retry(request.id, request.scope, attempts[0].attemptId, false));
      await runtime.retry(request.id, request.scope, attempts[0].attemptId, true);
      const retry = await runtime.release(request);
      assert.notEqual(retry.attemptId, attempts[0].attemptId);
      assert.equal(runtime.snapshot().attempts[retry.attemptId].priorAttempt, attempts[0].attemptId);
      await assert.rejects(runtime.retry(request.id, request.scope, attempts[0].attemptId, true));
    }
  });
}
test('isolated adapter disable, unsupported surface, multi-tab and restart scope invalidation', async t => {
  const fixture = await startFixture(await temporary(t)); t.after(() => fixture.close());
  for (const mode of ['disabled', 'unsupported', 'wrong-tab', 'restart']) {
    fixture.adapter.enabled = fixture.adapter.supported = true; fixture.adapter.scopes.add('tab-one');
    const request = await prepare(fixture.runtime());
    await fixture.runtime().confirm(request.id, request.scope, request.expectedDigest);
    if (mode === 'disabled') fixture.adapter.enabled = false;
    if (mode === 'unsupported') fixture.adapter.supported = false;
    if (mode === 'wrong-tab') fixture.adapter.scopes.delete('tab-one');
    if (mode === 'restart') await fixture.restart();
    assert.equal((await fixture.runtime().release(request)).state, 'FAILED_BEFORE_EGRESS');
    assert.equal(fixture.egress.length, 0);
  }
});
test('hostile page cannot use local authority or ambient filesystem/signer APIs', async t => {
  const f = await startFixture(await temporary(t)); t.after(() => f.close());
  for (const path of ['/seal', '/sign', '/read-file']) {
    const response = await fetch(f.composerOrigin + path, { method: 'POST', headers: { Origin: f.providerOrigin }, body: '{}' });
    assert.equal(response.status, 400);
  }
  assert.equal(capabilities.filesystemAPI, false); assert.equal(capabilities.signerAPI, false);
  assert.equal(capabilities.providerReceipt, 'UNKNOWN');
  assert.equal((await fetch(f.providerOrigin + '/release', { method: 'POST', body: '{}' })).status, 400);
});
