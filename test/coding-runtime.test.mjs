import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { connect } from 'node:net';
import { Readable } from 'node:stream';
import { recordingFixture, until } from './recording-fixture.mjs';
import { receiveHook } from '../spikes/coding/hook-receiver.mjs';
import { HookHealth } from '../spikes/coding/health.mjs';
import { LocalDiagnostics } from '../spikes/diagnostics/local.mjs';

async function fixture(t) {
  const root = await mkdtemp('/private/tmp/attestamp-hook-lifecycle-test-');
  let authorized = true, f, validationGate, peerPaths = [];
  t.after(async () => { try { await f?.close(); } finally { await rm(root, { recursive: true, force: true }); } });
  const diagnostics = new LocalDiagnostics();
  f = await recordingFixture(root, { recording: true, managed: null, diagnostics,
    codeIdentity: async () => 'a'.repeat(40), hookPeer: async (_socket, enrollment) => {
      const peerPath = peerPaths.shift();
      if (validationGate) { validationGate.enter(); await validationGate.wait; }
      if (!authorized || peerPath && !enrollment.executables.some(value => value.path === peerPath)) throw Error('PRIVATE_ERROR_WITH_PROMPT_AND_PATH');
      return { client: enrollment.client, origin: 'enrolled-local-executable' };
    } });
  const executable = join(root, 'synthetic-client'); await writeFile(executable, 'synthetic native client', { mode: 0o700 });
  const manager = f.runtime.integrationManager;
  const { socketPath } = JSON.parse(await readFile(join(root, 'engine/coding-bridge.json')));
  const change = async (client, action = 'install') => {
    const preview = await manager.preview({ client, action, clientExecutable: executable });
    await manager.apply({ operationId: preview.operationId, consent: true });
    return (await manager.status()).find(value => value.id === client);
  };
  const invoke = (client, installationId, extra = {}) => receiveHook({ client, installationId, socket: connect(socketPath),
    input: Readable.from([Buffer.from(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'PRIVATE_EXACT_HOOK_TEXT',
      session_id: 'private-session', turn_id: 'same-turn', prompt_id: randomUUID(), ...extra }))]) });
  const pauseIdentity = () => {
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; }), wait = new Promise(resolve => { release = resolve; });
    validationGate = { enter, wait }; return { entered, release };
  };
  return { ...f, root, executable, manager, invoke, change, diagnostics, pauseIdentity,
    selectPeerPaths: paths => { peerPaths = [...paths]; }, rejectIdentity: () => { authorized = false; } };
}

test('two enrolled Codex origins admit concurrently; removing one revokes its in-flight authentication without losing the other', async t => {
  const f = await fixture(t), second = join(f.root, 'second-synthetic-client'); await writeFile(second, 'second synthetic image', { mode: 0o700 });
  const select = async paths => {
    const plan = await f.manager.preview({ client: 'codex', clientExecutables: paths.map(path => ({ path })) });
    await f.manager.apply({ operationId: plan.operationId, consent: true });
    return (await f.manager.status()).find(value => value.id === 'codex');
  };
  const entry = await select([f.executable, second]); f.selectPeerPaths([f.executable, second]);
  const results = await Promise.all([f.invoke('codex', entry.installationId), f.invoke('codex', entry.installationId)]);
  assert.deepEqual(results.map(value => value.state), ['ADMITTED', 'ADMITTED']);
  await f.runtime.coreEngine.drain(); assert.equal(f.runtime.session.versionCount, 2);
  assert.equal(new Set(f.runtime.session.status({ limit: 5 }).versions.map(value => value.id)).size, 2);
  f.selectPeerPaths([second]); const gate = f.pauseIdentity(), stale = f.invoke('codex', entry.installationId);
  await gate.entered; await select([f.executable]); assert.equal((await stale).state, 'UNAVAILABLE'); gate.release();
  f.selectPeerPaths([second]); assert.equal((await f.invoke('codex', entry.installationId)).state, 'UNAVAILABLE');
  f.selectPeerPaths([f.executable]); assert.equal((await f.invoke('codex', entry.installationId)).state, 'ADMITTED');
  await f.runtime.coreEngine.drain(); assert.equal(f.runtime.session.versionCount, 3);
  await f.send('Synthetic Chrome after narrowing Codex enrollment');
  await until(() => f.runtime.session.versionCount === 4);
});

test('both coding clients survive six remove/install cycles alongside Chrome without restarting the resident', async t => {
  const f = await fixture(t);
  let expected = 0;
  for (let cycle = 0; cycle < 6; cycle++) {
    const installed = [];
    for (const client of ['codex', 'claude-code']) {
      const entry = await f.change(client); installed.push(entry);
      assert.equal(entry.hookHealth.lastObserved, 'NEVER_OBSERVED');
      assert.equal((await f.invoke(client, entry.installationId)).state, 'ADMITTED');
      expected++; await until(() => f.runtime.session.versionCount === expected);
    }
    await f.send(`Synthetic Chrome coexistence ${cycle}`); expected++;
    await until(() => f.runtime.session.versionCount === expected);
    for (const entry of installed) {
      await f.change(entry.id, 'remove');
      assert.equal((await f.invoke(entry.id, entry.installationId)).state, 'UNAVAILABLE');
    }
    assert.equal(f.runtime.session.versionCount, expected);
  }
});

test('known hook rejection and authenticated admission are distinct, bounded and content-free', async t => {
  const f = await fixture(t), entry = await f.change('codex');
  const status = async () => (await f.manager.status()).find(value => value.id === 'codex');
  assert.equal((await status()).state, 'TRUST_REQUIRED');
  assert.equal((await f.invoke('codex', entry.installationId)).state, 'ADMITTED');
  await until(() => f.runtime.session.versionCount === 1);
  let state = await status();
  assert.equal(state.state, 'HOOK_RELEASED'); assert.equal(state.connected, false);
  assert.equal(state.hookHealth.authenticated, true); assert.equal(state.hookHealth.counters.RELEASED, 1);
  await f.runtime.coreEngine.drain();
  f.rejectIdentity();
  assert.equal((await f.invoke('codex', entry.installationId)).state, 'UNAVAILABLE');
  state = await status();
  assert.equal(state.state, 'HOOK_AUTH_REJECTED'); assert.equal(state.hookHealth.authenticated, false);
  assert.equal(state.hookHealth.counters.AUTH_REJECTED, 1);
  await new Promise(resolve => setImmediate(resolve));
  const events = f.diagnostics.preview({ components: ['hook'] }).report.events;
  assert.ok(events.some(event => event.code === 'HOOK_AUTH_REJECTED'));
  assert.ok(events.some(event => event.code === 'HOOK_RELEASED'));
  assert.doesNotMatch(JSON.stringify({ health: state.hookHealth, events }), /PRIVATE_|private-session|same-turn|installationId|configPath/);
  assert.equal(f.runtime.session.versionCount, 1);
});

test('hook health cannot invoke a diagnostic sink on the synchronous admission path or grow with input values', async () => {
  const codes = [], health = new HookHealth({ diagnostics: { record: code => codes.push(code) } });
  for (let i = 0; i < 1000; i++) { health.record(`untrusted-${i}`, 'AUTH_REJECTED'); health.record('codex', `error-${i}`); }
  assert.deepEqual(codes, []);
  assert.equal(health.status('unknown').counters.AUTH_REJECTED, 1000);
  assert.equal(health.status('codex').lastObserved, 'NEVER_OBSERVED');
  health.flushLater(); assert.deepEqual(codes, []);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(codes, ['HOOK_AUTH_REJECTED']);
  assert.ok(JSON.stringify(health.status('unknown')).length < 1024);
});

test('removal during native authentication retires the attempt without disrupting Chrome', async t => {
  const f = await fixture(t), entry = await f.change('codex'), gate = f.pauseIdentity();
  const invocation = f.invoke('codex', entry.installationId);
  await gate.entered;
  await f.change('codex', 'remove');
  assert.equal((await invocation).state, 'UNAVAILABLE');
  gate.release(); await new Promise(resolve => setImmediate(resolve));
  await f.runtime.coreEngine.drain(); assert.equal(f.runtime.session.versionCount, 0);
  await f.send('Synthetic Chrome after interrupted coding removal');
  await until(() => f.runtime.session.versionCount === 1);
});

test('an OFF/ON cycle during native authentication cannot refresh the original admission authority', async t => {
  const f = await fixture(t), entry = await f.change('codex'), gate = f.pauseIdentity();
  const invocation = f.invoke('codex', entry.installationId);
  await gate.entered; await f.recording(false); await f.recording(true); gate.release();
  assert.equal((await invocation).state, 'UNAVAILABLE');
  await f.runtime.coreEngine.drain(); assert.equal(f.runtime.session.versionCount, 0);
  const health = (await f.manager.status()).find(value => value.id === 'codex').hookHealth;
  assert.equal(health.lastObserved, 'DISABLED'); assert.equal(health.authenticated, true);
});
