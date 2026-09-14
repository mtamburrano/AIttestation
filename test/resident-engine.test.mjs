import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startPackagedChatGPT } from '../spikes/browser/chatgpt/runtime-main.mjs';
import { ENGINE_COMMAND_PROFILE } from '../spikes/browser/chatgpt/engine.mjs';
import { CHATGPT_ADAPTER_PROFILE, CHATGPT_RELEASE_PROTOCOL, CHATGPT_PAGE_CONTRACT,
  CHATGPT_EXTENSION_ID } from '../spikes/browser/chatgpt/adapter.mjs';
import { MemoryKeyStore } from '../spikes/vault/key-lifecycle.mjs';
import { FAST_CONFIRM_PROFILE } from '../spikes/anchor/algorand/fast-confirm.mjs';
import { verifyPortable } from '../spikes/recipient/portable.mjs';
import { ManagedAnchoringClient } from '../spikes/managed/client.mjs';

const tab = (id = 17, overrides = {}) => ({ id, windowId: id, tabEpoch: `document-${id}`, active: true,
  url: 'https://chatgpt.com/c/synthetic-conversation', destination: 'conversation:synthetic-conversation',
  surfaceSupported: true, composerEmpty: true, attachmentsPresent: false, ...overrides });
const hello = tabs => ({ extensionId: CHATGPT_EXTENSION_ID, adapterProfile: CHATGPT_ADAPTER_PROFILE,
  releaseProtocol: CHATGPT_RELEASE_PROTOCOL, pageContract: CHATGPT_PAGE_CONTRACT, browserSessionId: 'synthetic-browser-session',
  browser: { product: 'Google Chrome', channel: 'stable', major: 153 },
  platform: { product: 'macOS', arch: 'arm64', version: '15.7.2' }, permissions: ['nativeMessaging'],
  hostPermission: 'https://chatgpt.com/*', permissionState: 'granted', tabs });
const envelope = (engine, kind, data = {}) => ({ profile: ENGINE_COMMAND_PROFILE, runtimeEpoch: engine.state().runtimeEpoch,
  adapterProfile: CHATGPT_ADAPTER_PROFILE, commandId: randomUUID(), expectedRevision: engine.state().revision, kind, ...data });
const command = (engine, kind, data = {}) => engine.command(envelope(engine, kind, data), { surface: 'development' });
const submit = (scope, text = 'SYNTHETIC_SECRET_e\u0301\r\n☕', editRevision = 1) => ({ scope, text, editRevision, operationId: randomUUID() });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function until(check) {
  for (let index = 0; index < 300; index++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('Isolated engine fixture timed out');
}

async function fixture(t, { collectFast, fault, dispatchOutcome = () => 'SUBMISSION_OBSERVED', tabs = [tab()], managed = null } = {}) {
  const root = await mkdtemp('/private/tmp/attestamp-engine-test-'), keyStore = new MemoryKeyStore();
  const attempts = [], confirmations = [], cleanups = [];
  const options = { supportDirectory: root, keyStore, installation: null, fastTrust: { profile: FAST_CONFIRM_PROFILE },
    managed: managed ?? { status: () => ({ state: 'ACTIVE' }), submit: async () => ({ transactionId: 'A'.repeat(52) }) },
    collectFast: async request => { confirmations.push(request); return collectFast ? collectFast(request) : { synthetic: true }; },
    verifyFast: () => ({ authorized: true, anchor: 'SOURCE_CORROBORATED', timestamp: 'SOURCE_REPORTED',
      assurance: FAST_CONFIRM_PROFILE, round: 42 }),
    verifyArchive: () => { throw Error('NO_ARCHIVE_FIXTURE'); },
    attestPeer: () => { throw Error('NO_NATIVE_PEER_IN_THIS_FIXTURE'); },
  };
  let runtime = await startPackagedChatGPT(options);
  const pair = () => { runtime.adapter.pair(hello(tabs)); runtime.adapter.synchronize(hello(tabs)); };
  pair();
  // The product runner covers real native frames. Here only the final browser
  // response is injected so command races can be held at deterministic points.
  const installDispatch = () => {
    runtime.adapter.dispatch = async (attempt, isCurrent) => {
      if (fault) await fault(attempt, runtime);
      // Like the adapter's dispatch guard, a throwing authority check rejects
      // before this fixture can reach its synthetic provider.
      try { if (!isCurrent()) return 'FAILED_BEFORE_EGRESS'; }
      catch { return 'FAILED_BEFORE_EGRESS'; }
      assert.equal(runtime.session.runtime.snapshot().seals[attempt.sealId].authorization, null);
      attempts.push(attempt); return dispatchOutcome(attempt, runtime);
    };
  };
  installDispatch();
  t.after(async () => { for (const cleanup of cleanups) cleanup(); await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const context = { root, attempts, confirmations, cleanups, options,
    get runtime() { return runtime; }, get engine() { return runtime.engine; },
    synchronize(next) { tabs = next; runtime.adapter.synchronize(hello(tabs)); },
    async enroll(id = 17) {
      const { eligible: _eligible, ...target } = runtime.engine.state().targets.find(value => value.tabId === id);
      return (await command(runtime.engine, 'ENROLL_SCOPE', { target })).scope;
    },
    async restart(releasePointer = null) {
      await runtime.close();
      if (releasePointer) await writeFile(join(root, 'release-pointer'), releasePointer);
      runtime = await startPackagedChatGPT(options); installDispatch();
    },
    pair,
    async api(path, body = {}) {
      const url = new URL(runtime.composerURL);
      const response = await fetch(new URL(path, url), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { Origin: url.origin, Authorization: `Bearer ${url.hash.slice(1)}` }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    },
  };
  return context;
}

test('duplicate views read one engine and closing a view cannot interrupt admitted work', async t => {
  const wait = deferred(), f = await fixture(t, { collectFast: () => wait.promise }); f.cleanups.push(() => wait.resolve({ synthetic: true }));
  const scope = await f.enroll(), frames = [];
  const unsubscribe = f.engine.subscribe(state => frames.push(state));
  const input = envelope(f.engine, 'PROTECT_AND_SEND', submit(scope));
  const accepted = await f.api('/engine/command', input); assert.equal(accepted.status, 200);
  await until(() => f.confirmations.length === 1);
  unsubscribe();
  assert.equal((await f.api('/close')).body.engine, 'RUNNING');
  assert.deepEqual((await f.api('/engine/command', input)).body, accepted.body);
  const reopened = await f.api('/engine/state');
  assert.equal(reopened.body.operations[0].id, accepted.body.operationId);
  wait.resolve({ synthetic: true }); await f.engine.drain();
  assert.equal(f.attempts.length, 1); assert.ok(frames.length >= 2);
  assert.equal((await f.api('/engine/state')).body.operations[0].state, 'SUBMISSION_OBSERVED');
});

test('a second runtime cannot load release state or acquire dispatch authority in the same directory', async t => {
  const f = await fixture(t), scope = await f.enroll();
  const version = await f.runtime.session.freeze({ text: 'singleton', mode: 'Sealed', scope, editRevision: 1 });
  await f.runtime.session.confirmFast({ id: version.id, scope, currentText: 'singleton', editRevision: 1, transactionId: 'fixture' });
  const before = f.runtime.session.runtime.snapshot();
  await assert.rejects(startPackagedChatGPT(f.options), /RESIDENT_ENGINE_ALREADY_RUNNING/);
  assert.deepEqual(f.runtime.session.runtime.snapshot(), before);
  await f.runtime.session.release({ id: version.id, scope, currentText: 'singleton', editRevision: 1 });
  assert.equal(f.attempts.length, 1);
});

test('concurrent commands serialize revisions; delivery retries and repeated equal text have different identities', async t => {
  const f = await fixture(t), scope = await f.enroll();
  const first = envelope(f.engine, 'PROTECT_AND_SEND', submit(scope));
  const responses = await Promise.all([1, 2, 3].map(() => f.engine.command(first, { surface: 'development' })));
  assert.deepEqual(responses[0], responses[1]); await f.engine.drain(); assert.equal(f.attempts.length, 1);
  await assert.rejects(f.engine.command({ ...first, text: 'conflicting' }, { surface: 'development' }), /COMMAND_REPLAY_CONFLICT/);
  await command(f.engine, 'PROTECT_AND_SEND', submit(scope)); await f.engine.drain();
  assert.equal(f.attempts.length, 2);
  const versions = f.engine.state().operations.map(value => value.result);
  assert.notEqual(versions[0].id, versions[1].id); assert.notEqual(versions[0].recordDigest, versions[1].recordDigest);
  assert.equal(versions[0].digest, versions[1].digest);
  const a = envelope(f.engine, 'SET_DEFAULT', { mode: 'Continuous' }), b = { ...a, commandId: randomUUID(), mode: 'Sealed' };
  const outcomes = await Promise.allSettled([a, b].map(value => f.engine.command(value, { surface: 'development' })));
  assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1);
  assert.match(outcomes[1].reason.message, /STALE_ENGINE_REVISION/);
});

async function assertCancellationRejectedWithoutWrites(f, operationId) {
  const state = f.engine.state(), records = f.runtime.session.vault.inspect().records;
  const durable = f.runtime.session.runtime.snapshot();
  await assert.rejects(command(f.engine, 'CANCEL_OPERATION', { operationId }), { code: 'OPERATION_UNAVAILABLE' });
  await f.engine.drain();
  assert.deepEqual(f.engine.state(), state, 'a rejected cancellation must not change state or revision');
  assert.deepEqual(f.runtime.session.vault.inspect().records, records, 'a rejected cancellation must not append evidence');
  assert.deepEqual(f.runtime.session.runtime.snapshot(), durable);
}

test('terminal cancellation rejects a new command while identical delivery remains read-only', async t => {
  let submissions = 0;
  const managed = new ManagedAnchoringClient({ origin: 'https://unused-synthetic.invalid', keyStore: new MemoryKeyStore(),
    request: async () => { submissions++; assert.fail('DISCONNECTED_FIXTURE_MUST_NOT_SUBMIT'); } });
  const f = await fixture(t, { managed });
  const scope = await f.enroll(), input = submit(scope);
  await command(f.engine, 'PROTECT_AND_SEND', input); await f.engine.drain();
  assert.equal(f.engine.state().operations[0].state, 'PENDING_FAST_CONFIRMATION');
  assert.equal(f.engine.state().operations[0].result.managed.state, 'ACCOUNT_REQUIRED');
  const cancel = envelope(f.engine, 'CANCEL_OPERATION', { operationId: input.operationId });
  const acknowledgements = await Promise.all([1, 2].map(() => f.engine.command(cancel, { surface: 'development' })));
  assert.deepEqual(acknowledgements[0], acknowledgements[1]); await f.engine.drain();
  const state = f.engine.state(), records = f.runtime.session.vault.inspect().records;
  assert.equal(state.operations[0].state, 'CANCELLED');
  assert.ok(Object.values(state.operations[0].result.actions).every(value => value === false));
  assert.deepEqual(await f.engine.command(cancel, { surface: 'development' }), acknowledgements[0]);
  await f.engine.drain();
  assert.deepEqual(f.engine.state(), state); assert.deepEqual(f.runtime.session.vault.inspect().records, records);
  await assertCancellationRejectedWithoutWrites(f, input.operationId);
  assert.equal(submissions, 0); assert.equal(f.confirmations.length, 0); assert.equal(f.attempts.length, 0);
  assert.deepEqual(f.runtime.session.runtime.snapshot().attempts, {});
  const version = state.operations[0].result;
  const preview = f.runtime.session.receipts.prepare({ ids: [version.descriptorId] });
  const report = verifyPortable(f.runtime.session.receipts.export(preview.previewId));
  const target = report.records.find(record => record.recordDigest === version.recordDigest);
  assert.equal(target.localAssertions.length, 1);
  assert.equal(target.localAssertions[0].kind, 'release-cancelled');
  assert.equal(target.localAssertions[0].assurance, 'CLIENT_ASSERTION_ONLY');
  assert.equal(target.localAssertions[0].providerNonEgress, 'NOT_PROVEN');
  assert.equal(target.releaseControl, 'UNKNOWN'); assert.equal(target.anchor, 'INDETERMINATE');
  assert.equal(target.timestamp, 'LOCAL_CLAIMED');
});

test('cancellation consults the live version and durable seal before an engine snapshot catches up', async t => {
  for (const boundary of ['session', 'release journal']) await t.test(boundary, async t => {
    const managed = new ManagedAnchoringClient({ origin: 'https://unused-synthetic.invalid', keyStore: new MemoryKeyStore(),
      request: async () => assert.fail('DISCONNECTED_FIXTURE_MUST_NOT_SUBMIT') });
    const f = await fixture(t, { managed });
    const scope = await f.enroll(), input = submit(scope);
    await command(f.engine, 'PROTECT_AND_SEND', input); await f.engine.drain();
    const version = f.engine.state().operations[0].result;
    if (boundary === 'session') await f.runtime.session.cancel({ id: version.id, scope });
    else await f.runtime.session.runtime.cancel(version.id, scope, version.digest);
    assert.equal(f.engine.state().operations[0].stopped, false);
    assert.equal(f.runtime.session.runtime.snapshot().seals[version.id].cancelled, true);
    await assertCancellationRejectedWithoutWrites(f, input.operationId);
    assert.equal(f.confirmations.length, 0); assert.equal(f.attempts.length, 0);
  });
});

test('completed release outcomes reject a fresh cancel without changing evidence or stopped state', async t => {
  for (const outcome of ['SUBMISSION_OBSERVED', 'OUTCOME_UNKNOWN']) await t.test(outcome, async t => {
    let submissions = 0;
    const f = await fixture(t, { dispatchOutcome: () => outcome,
      managed: { status: () => ({ state: 'ACTIVE' }), submit: async () => {
        submissions++; return { transactionId: 'A'.repeat(52) };
      } } });
    const scope = await f.enroll(), input = submit(scope);
    await command(f.engine, 'PROTECT_AND_SEND', input); await f.engine.drain();
    assert.equal(f.engine.state().operations[0].state, outcome);
    assert.equal(f.engine.state().operations[0].stopped, false);
    await assertCancellationRejectedWithoutWrites(f, input.operationId);
    assert.equal(submissions, 1); assert.equal(f.confirmations.length, 1); assert.equal(f.attempts.length, 1);
  });
});

test('cancellation still ends admitted work before capture completes or while confirmation is pending', async t => {
  for (const phase of ['capture', 'confirmation']) await t.test(phase, async t => {
    const wait = deferred(); let waiting = false;
    const pause = () => { waiting = true; return wait.promise; };
    const f = await fixture(t, phase === 'confirmation' ? { collectFast: pause } : {});
    f.cleanups.push(() => wait.resolve({ synthetic: true }));
    if (phase === 'capture') {
      const freeze = f.runtime.session.freeze.bind(f.runtime.session);
      f.runtime.session.freeze = async request => { await pause(); return freeze(request); };
    }
    const scope = await f.enroll(), input = submit(scope);
    await command(f.engine, 'PROTECT_AND_SEND', input); await until(() => waiting);
    const cancel = envelope(f.engine, 'CANCEL_OPERATION', { operationId: input.operationId });
    const ack = await f.engine.command(cancel, { surface: 'development' });
    const state = f.engine.state(), records = f.runtime.session.vault.inspect().records;
    assert.equal(state.operations[0].stopped, true);
    assert.deepEqual(await f.engine.command(cancel, { surface: 'development' }), ack);
    await assert.rejects(command(f.engine, 'CANCEL_OPERATION', { operationId: input.operationId }), { code: 'OPERATION_UNAVAILABLE' });
    assert.deepEqual(f.engine.state(), state); assert.deepEqual(f.runtime.session.vault.inspect().records, records);
    wait.resolve({ synthetic: true }); await f.engine.drain();
    assert.equal(f.engine.state().operations[0].state, 'CANCELLED');
    assert.equal(f.attempts.length, 0);
    assert.ok(Object.values(f.runtime.session.runtime.snapshot().seals).every(seal => seal.authorization === null));
    await assertCancellationRejectedWithoutWrites(f, input.operationId);
  });
});

test('cancellation interrupts an active consumed attempt without rewriting possible exposure as cancellation', async t => {
  for (const phase of ['before egress', 'after egress']) await t.test(phase, async t => {
    const wait = deferred(); let waiting = false;
    const pause = async () => { waiting = true; await wait.promise; return 'OUTCOME_UNKNOWN'; };
    const f = await fixture(t, phase === 'before egress' ? { fault: pause } : { dispatchOutcome: pause });
    f.cleanups.push(() => wait.resolve());
    const scope = await f.enroll(), input = submit(scope);
    await command(f.engine, 'PROTECT_AND_SEND', input); await until(() => waiting);
    const version = f.engine.state().operations[0].result;
    const durable = f.runtime.session.runtime.snapshot();
    assert.equal(durable.attempts[durable.seals[version.id].priorAttempt].state, 'DISPATCHING');
    assert.equal(version.attempt, null, 'the durable attempt precedes the live outcome');
    await command(f.engine, 'CANCEL_OPERATION', { operationId: input.operationId });
    wait.resolve(); await f.engine.drain();
    assert.equal(f.engine.state().operations[0].state, phase === 'before egress' ? 'FAILED_BEFORE_EGRESS' : 'OUTCOME_UNKNOWN');
    assert.equal(f.attempts.length, phase === 'before egress' ? 0 : 1);
    const preview = f.runtime.session.receipts.prepare({ ids: [version.descriptorId] });
    const report = verifyPortable(f.runtime.session.receipts.export(preview.previewId));
    assert.ok(report.records.every(record => !record.localAssertions?.some(value => value.kind === 'release-cancelled')));
    await assertCancellationRejectedWithoutWrites(f, input.operationId);
  });
});

test('duplicate-conversation windows retain independent drafts and navigation never retargets another operation', async t => {
  const wait = deferred(), f = await fixture(t, { tabs: [tab(), tab(18)], collectFast: () => wait.promise });
  f.cleanups.push(() => wait.resolve({ synthetic: true }));
  const firstScope = await f.enroll(), secondScope = await f.enroll(18);
  assert.notEqual(firstScope, secondScope); assert.equal(await f.enroll(18), secondScope);
  await command(f.engine, 'PROTECT_AND_SEND', submit(firstScope, 'first-window', 9));
  await until(() => f.confirmations.length === 1);
  await command(f.engine, 'PROTECT_AND_SEND', submit(secondScope, 'second-window', 1));
  await until(() => f.confirmations.length === 2);
  f.synchronize([tab(17, { tabEpoch: 'reloaded-document' }), tab(18)]);
  assert.equal(f.runtime.adapter.eligibility(firstScope), 'REVOKED');
  assert.equal(f.runtime.adapter.eligibility(secondScope), 'ELIGIBLE');
  wait.resolve({ synthetic: true }); await f.engine.drain();
  assert.equal(f.attempts.length, 1); assert.equal(f.attempts[0].scope, secondScope);
  assert.equal(f.attempts[0].payload.text, 'second-window');
  assert.equal(f.engine.state().operations.find(value => value.scope === firstScope).state, 'CANCELLED');
});

test('pause and effective policy precedence end old protected work without silently resuming or downgrading it', async t => {
  const wait = deferred(), f = await fixture(t, { collectFast: () => wait.promise,
    tabs: [tab(), tab(18, { destination: 'conversation:other', url: 'https://chatgpt.com/c/other' })] });
  f.cleanups.push(() => wait.resolve({ synthetic: true }));
  const scope = await f.enroll(), other = await f.enroll(18);
  await command(f.engine, 'SET_DEFAULT', { mode: 'Off' });
  await command(f.engine, 'SET_CONVERSATION_MODE', { scope, mode: 'Sealed' });
  assert.equal(f.engine.state().scopes.find(value => value.scope === scope).effectiveMode, 'Sealed');
  assert.equal(f.engine.state().scopes.find(value => value.scope === other).effectiveMode, 'Off');
  await command(f.engine, 'PROTECT_AND_SEND', submit(scope)); await until(() => f.confirmations.length === 1);
  await command(f.engine, 'SET_PAUSE', { paused: true });
  assert.ok(f.engine.state().scopes.every(value => value.effectiveMode === 'Off'));
  await command(f.engine, 'SET_PAUSE', { paused: false });
  wait.resolve({ synthetic: true }); await f.engine.drain();
  assert.equal(f.attempts.length, 0); assert.equal(f.engine.state().operations[0].state, 'CANCELLED');
  await command(f.engine, 'SET_CONVERSATION_MODE', { scope, mode: 'Continuous' });
  const state = f.engine.state().scopes.find(value => value.scope === scope);
  assert.equal(state.requestedMode, 'Continuous'); assert.equal(state.effectiveMode, 'Unavailable');
  assert.equal(f.attempts.length, 0, 'a preference is never an automatic dispatch command');
});

test('mode changes and a disconnect during confirmation cannot revive grants on reconnect', async t => {
  for (const change of ['Off', 'Continuous', 'disconnect']) await t.test(change, async t => {
    const wait = deferred(), f = await fixture(t, { collectFast: () => wait.promise });
    f.cleanups.push(() => wait.resolve({ synthetic: true }));
    const scope = await f.enroll();
    await command(f.engine, 'PROTECT_AND_SEND', submit(scope)); await until(() => f.confirmations.length === 1);
    if (change === 'disconnect') { f.runtime.adapter.disconnect(); f.pair(); await f.enroll(); }
    else { await command(f.engine, 'SET_DEFAULT', { mode: change }); await command(f.engine, 'SET_DEFAULT', { mode: 'Sealed' }); }
    wait.resolve({ synthetic: true }); await f.engine.drain();
    assert.equal(f.attempts.length, 0); assert.equal(f.engine.state().operations[0].state, 'CANCELLED');
    assert.ok(Object.values(f.runtime.session.runtime.snapshot().seals).every(value => value.authorization === null));
  });
});

test('restart restores encrypted history and preferences while old commands, scopes and grants stay unusable', async t => {
  const f = await fixture(t), scope = await f.enroll(), original = envelope(f.engine, 'PROTECT_AND_SEND', submit(scope));
  await f.engine.command(original, { surface: 'development' }); await f.engine.drain();
  await command(f.engine, 'SET_CONVERSATION_MODE', { scope, mode: 'Sealed' });
  await command(f.engine, 'SET_DEFAULT', { mode: 'Off' });
  const legacy = await f.runtime.session.freeze({ text: 'legacy pending', mode: 'Sealed', scope, editRevision: 2 });
  await f.runtime.session.confirmFast({ id: legacy.id, scope, currentText: 'legacy pending', editRevision: 2, transactionId: 'fixture' });
  assert.ok(f.runtime.session.runtime.snapshot().seals[legacy.id].authorization);
  const crashPointer = await readFile(join(f.root, 'release-pointer'));
  const receipts = f.runtime.session.receipts.list(), preview = f.runtime.session.receipts.prepare({ ids: [receipts[0].id] });
  const exported = f.runtime.session.receipts.export(preview.previewId), report = verifyPortable(exported);
  const preferences = f.engine.state().preferences;
  // Restore this test's captured journal pointer to model abrupt termination
  // with an unconsumed grant, rather than relying on graceful-exit cancellation.
  await f.restart(crashPointer);
  assert.deepEqual(f.engine.state().preferences, preferences); assert.equal(f.engine.state().scopes.length, 0);
  assert.equal(f.runtime.session.runtime.snapshot().seals[legacy.id].authorization, null);
  assert.equal(f.engine.state().operations[0].state, 'SUBMISSION_OBSERVED');
  assert.equal(f.engine.state().operations[0].restored, true);
  assert.ok(Object.values(f.engine.state().operations[0].result.actions).every(value => value === false));
  await assert.rejects(f.engine.command(original, { surface: 'development' }), /STALE_RUNTIME_EPOCH/);
  await assert.rejects(command(f.engine, 'PROTECT_AND_SEND', submit(scope)), /SCOPE_REVOKED/);
  assert.equal(f.attempts.length, 1); assert.deepEqual(verifyPortable(exported), report);
  assert.equal(f.runtime.session.receipts.list().length, receipts.length);
  const scan = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await scan(path);
      else if (entry.isFile()) assert.equal((await readFile(path)).includes(Buffer.from('SYNTHETIC_SECRET')), false);
    }
  };
  await scan(f.root);
});

test('bounded command contracts reject hostile origin, adapter, target, extra fields and stale runtime identities', async t => {
  const f = await fixture(t);
  const input = envelope(f.engine, 'SET_PAUSE', { paused: true });
  await assert.rejects(f.engine.command(input, { surface: 'content_script' }), /UNTRUSTED_COMMAND_ORIGIN/);
  for (const patch of [{ adapterProfile: 'pap-chatgpt-chrome/4' }, { runtimeEpoch: 'old' }, { commandId: 'x'.repeat(1000) },
    { origin: 'extension_panel' }, { expectedRevision: -1 }]) {
    await assert.rejects(f.engine.command({ ...input, ...patch }, { surface: 'development' }));
  }
  const { eligible: _eligible, ...target } = f.engine.state().targets[0];
  for (const patch of [{ adapterId: 'other' }, { adapterEpoch: 'wrong' }, { tabEpoch: 'wrong' },
    { windowId: 999 }, { destination: 'conversation:other' }]) {
    await assert.rejects(command(f.engine, 'ENROLL_SCOPE', { target: { ...target, ...patch } }), /ADAPTER_TARGET_MISMATCH/);
  }
  assert.equal(f.engine.state().scopes.length, 0); assert.equal(f.attempts.length, 0);
});

test('new-chat preferences apply only to that document and cannot become a preference for every new conversation', async t => {
  const f = await fixture(t, { tabs: [tab(17, { destination: 'new-chat', url: 'https://chatgpt.com/' }),
    tab(18, { destination: 'new-chat', url: 'https://chatgpt.com/' })] });
  const first = await f.enroll(), second = await f.enroll(18);
  await command(f.engine, 'SET_CONVERSATION_MODE', { scope: first, mode: 'Off' });
  assert.equal(f.engine.state().scopes.find(value => value.scope === first).effectiveMode, 'Off');
  assert.equal(f.engine.state().scopes.find(value => value.scope === second).effectiveMode, 'Sealed');
  assert.deepEqual(f.engine.state().preferences.conversations, {});
  await f.restart(); f.pair(); await f.enroll();
  assert.equal(f.engine.state().scopes[0].effectiveMode, 'Sealed');
});

test('an outcome write interrupted after consumption stays unknown across view replay and engine restart', async t => {
  const f = await fixture(t), scope = await f.enroll(), store = f.runtime.session.store;
  const save = store.save.bind(store);
  store.save = async (state, refs) => {
    if (Object.values(state.attempts).some(attempt => attempt.state === 'SUBMISSION_OBSERVED')) throw Error('SYNTHETIC_OUTCOME_WRITE_FAILURE');
    return save(state, refs);
  };
  const input = envelope(f.engine, 'PROTECT_AND_SEND', submit(scope));
  const ack = await f.engine.command(input, { surface: 'development' }); await f.engine.drain();
  assert.equal(f.attempts.length, 1); assert.equal(f.engine.state().operations[0].state, 'OUTCOME_UNKNOWN');
  assert.equal(f.engine.state().operations[0].result.state, 'OUTCOME_UNKNOWN');
  assert.deepEqual(await f.engine.command(input, { surface: 'development' }), ack);
  await assertCancellationRejectedWithoutWrites(f, input.operationId);
  store.save = save; await f.restart();
  assert.equal(f.engine.state().operations[0].state, 'OUTCOME_UNKNOWN');
  assert.equal(f.attempts.length, 1);
  assert.ok(Object.values(f.runtime.session.runtime.snapshot().seals).every(value => value.authorization === null));
  await assert.rejects(f.engine.command(input, { surface: 'development' }), /STALE_RUNTIME_EPOCH/);
});
