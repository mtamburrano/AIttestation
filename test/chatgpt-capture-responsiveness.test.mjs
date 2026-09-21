import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { recordingFixture, until } from './recording-fixture.mjs';
import { verifyFastConfirmationAsync, FAST_CONFIRM_PROFILE } from '../spikes/anchor/algorand/fast-confirm.mjs';
import { OwnerDebugSession } from '../spikes/development/debug-session.mjs';
import { restrictFixtureNetwork } from '../spikes/development/fixture-network.mjs';

test('a delayed durable-save reply during confirmation work stays uncertain and later confirms', async t => {
  const root = await mkdtemp('/private/tmp/attestamp-capture-response-test-');
  let f, releaseConfirmation, releaseReply, confirmations = 0;
  const confirmation = new Promise(resolve => { releaseConfirmation = resolve; });
  const reply = new Promise(resolve => { releaseReply = resolve; });
  t.after(async () => { releaseReply(); releaseConfirmation(); await f?.close(); await rm(root, { recursive: true, force: true }); });
  f = await recordingFixture(root, {
    collectFast: async () => { confirmations++; await confirmation; return { synthetic: true }; },
    afterCapture: async (message, result) => {
      if (message.text === 'DELAYED_DURABLE_REPLY') { assert.equal(result.state, 'PROMPT_SAVED'); await reply; }
    },
  });
  await f.recording(true);
  await f.pages.get(17).request('BACKLOG_ONE');
  await f.pages.get(18).request('BACKLOG_TWO');
  await until(() => confirmations === 2);
  f.send('DELAYED_DURABLE_REPLY');
  await until(() => f.runtime.session.receipts.list().length === 3);
  await delay(5100);
  assert.equal(f.pages.get(17).feedback, 'Attestamp · Save not confirmed · Check History');
  assert.equal(f.runtime.session.receipts.list().length, 3);
  releaseReply();
  await until(() => f.pages.get(17).feedback === 'Attestamp · Prompt saved');
  assert.equal(confirmations, 2, 'save confirmation must not wait for anchoring');
  assert.equal(f.pages.get(17).requests.length, 2); assert.equal(f.prevention, 0); assert.equal(f.releases.length, 0);
});

test('a confirmation backlog keeps new capture and authenticated debug/control responsive', async t => {
  const root = await mkdtemp('/private/tmp/attestamp-anchor-response-test-');
  const verifierPath = join(root, 'synthetic-fast-verifier'), gate = join(root, 'release-verifiers');
  const report = { profile: FAST_CONFIRM_PROFILE, authorized: true, anchor: 'SOURCE_CORROBORATED',
    timestamp: 'SOURCE_REPORTED', assurance: FAST_CONFIRM_PROFILE, reason: 'SYNTHETIC_TEST_VERDICT',
    round: 42, blockTime: 1700000000, blockHeaderHash: Buffer.alloc(32).toString('base64'), sourceClaimedTimes: ['a', 'b'] };
  await writeFile(verifierPath, `#!${process.execPath}\n
const {existsSync}=require('node:fs');
process.stdin.resume();process.stdin.on('end',async()=>{
  while(!existsSync(${JSON.stringify(gate)}))await new Promise(resolve=>setTimeout(resolve,20));
  process.stdout.write(${JSON.stringify(JSON.stringify(report))});
});`, { mode: 0o700 });
  const debug = new OwnerDebugSession(root), network = restrictFixtureNetwork(root);
  let f, active = 0, maximum = 0, verified = 0;
  t.after(async () => {
    await writeFile(gate, 'release'); await f?.close(); network.restore(); debug.close();
    await rm(root, { recursive: true, force: true });
  });
  f = await recordingFixture(root, { network, debugSession: debug, diagnostics: debug.diagnostics,
    verifyFast: async (...args) => {
      maximum = Math.max(maximum, ++active);
      try { const value = await verifyFastConfirmationAsync(...args, { verifierPath }); verified++; return value; }
      finally { active--; }
    },
  });
  await f.recording(true);
  for (let index = 0; index < 15; index++) {
    await f.pages.get(18).request(`BACKLOG_${index}`);
    await until(() => f.runtime.session.receipts.list().length === index + 1);
  }
  await until(() => active === 2);
  const started = performance.now();
  const provider = f.pages.get(17).request('CAPTURE_WHILE_VERIFYING');
  await provider;
  const dashboard = new URL(f.runtime.dashboardURL);
  const response = await fetch(new URL('/debug-session/recording', dashboard), { method: 'POST',
    headers: { Origin: dashboard.origin, Authorization: `Bearer ${dashboard.hash.slice(1)}` }, body: JSON.stringify({ enabled: true }) });
  assert.equal(response.status, 200); await response.json();
  await until(() => f.pages.get(17).feedback === 'Attestamp · Prompt saved');
  await f.recording(false);
  assert.ok(performance.now() - started < 1500, 'capture and controls must settle within the local response budget');
  assert.equal(debug.status().state, 'RECORDING'); assert.equal(active, 2); assert.equal(verified, 0);
  assert.equal(f.runtime.session.receipts.list().length, 16); assert.equal(f.pages.get(17).requests.length, 1);
  assert.equal(f.prevention, 0); assert.equal(f.releases.length, 0);
  await writeFile(gate, 'release'); await f.runtime.engine.drain();
  assert.equal(maximum, 2); assert.equal(verified, 16); assert.equal(f.anchorCalls, 16);
  assert.ok(f.runtime.session.status().versions.every(value => value.anchor === 'SOURCE_CORROBORATED'));
  await f.restart();
  assert.equal(f.runtime.session.receipts.list().length, 16);
  assert.equal(f.anchorCalls, 16, 'restart must not resubmit corroborated observations');
});

test('native response timeouts cannot turn an already durable capture into a definite gap', async t => {
  const root = await mkdtemp('/private/tmp/attestamp-native-response-test-'); let f;
  t.after(async () => { await f?.close(); await rm(root, { recursive: true, force: true }); });
  f = await recordingFixture(root); await f.recording(true);
  const emit = f.port.onMessage.emit, held = [];
  f.port.onMessage.emit = message => message.kind === 'PAP_CAPTURE_RESULT' ? held.push(message) : emit(message);
  f.send('SAVED_WITHOUT_NATIVE_REPLY');
  await until(() => held.length === 2);
  await until(() => f.pages.get(17).feedback === 'Attestamp · Save not confirmed · Check History');
  assert.equal(f.runtime.session.receipts.list().length, 1);
  for (const message of held) emit(message);
  await delay(20);
  assert.doesNotMatch(f.pages.get(17).feedback, /Recording gap/);
  assert.equal(f.pages.get(17).requests.length, 1); assert.equal(f.anchorCalls, 1);
});

for (const cutoff of ['OFF', 'OFF/ON', 'newer Send', 'pagehide']) {
  test(`a late save reply after both timeouts cannot override ${cutoff}`, async t => {
    const root = await mkdtemp('/private/tmp/attestamp-late-response-test-'); let f, release;
    const reply = new Promise(resolve => { release = resolve; });
    t.after(async () => { release(); await f?.close(); await rm(root, { recursive: true, force: true }); });
    f = await recordingFixture(root, {
      pageClock: { performance, clearTimeout, setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds === 2500 ? 30 : milliseconds) },
      afterCapture: async () => reply,
    });
    await f.recording(true); f.send('LATE_SAVE');
    await until(() => f.pages.get(17).feedback === 'Attestamp · Save not confirmed · Check History');
    if (cutoff.startsWith('OFF')) await f.recording(false);
    if (cutoff === 'OFF/ON') await f.recording(true);
    if (cutoff === 'newer Send') {
      f.send('EXCLUDED_NEWER_SEND', { payload: { action: 'edit' } });
      await until(() => f.pages.get(17).feedback === 'Attestamp · Recording gap');
    }
    if (cutoff === 'pagehide') f.pages.get(17).event('pagehide');
    const feedback = f.pages.get(17).feedback;
    release(); await delay(30);
    assert.equal(f.pages.get(17).feedback, feedback);
    assert.equal(f.runtime.session.receipts.list().length, 1);
  });
}
