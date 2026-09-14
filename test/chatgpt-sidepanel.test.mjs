import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sidePanelFixture, panelURL } from './sidepanel-fixture.mjs';
import { until } from './continuous-fixture.mjs';
import { targetKey, operationMessage, PANEL_PROFILE } from '../spikes/browser/chatgpt/extension/sidepanel-model.js';
import { verifyPortable } from '../spikes/recipient/portable.mjs';
import { LocalDiagnostics } from '../spikes/release/diagnostics.mjs';
import { workerFixture, turn } from './chrome-worker-fixture.mjs';
import { CHATGPT_EXTENSION_ID, ChatGPTChromeAdapter } from '../spikes/browser/chatgpt/adapter.mjs';
import { panelRequest } from '../spikes/browser/chatgpt/panel.mjs';

const text = '\ufeffSYNTHETIC_PANEL_e\u0301\r\n☕  <script>private</script>';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t, options = {}) {
  const root = await mkdtemp('/private/tmp/attestamp-panel-test-');
  let f;
  try { f = await sidePanelFixture(root, options); }
  catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
  t.after(async () => { options.release?.(); await f.close(); await rm(root, { recursive: true, force: true }); });
  return Object.assign(f, { root });
}

test('one panel action freezes exact bytes; edits, double clicks and another view cannot replace or duplicate a pending send', async t => {
  const gate = deferred(), diagnostics = new LocalDiagnostics({ mode: 'SYNTHETIC_FIXTURE' });
  const f = await fixture(t, { diagnostics, collectFast: () => gate.promise, release: gate.resolve });
  const p = await f.panel(), model = p.model;
  model.edit(text);
  await Promise.all([model.send(), model.send()]);
  await until(() => f.confirmed === 1);
  assert.equal(f.releases.length, 0);
  assert.equal(f.pages.get(17).text, '');
  assert.equal(f.runtime.session.receipts.list().length, 1);
  const original = structuredClone(model.draft.submission);
  model.edit('SYNTHETIC_LATER_EDIT');
  const another = await f.panel(); another.model.edit('SYNTHETIC_SECOND_VIEW');
  assert.equal(another.model.canSend, false);
  const command = another.model.envelope('PROTECT_AND_SEND', { scope: another.model.scope.scope,
    operationId: randomUUID(), text: 'SYNTHETIC_SECOND_VIEW', editRevision: 10 });
  const rejected = await another.transport({ kind: 'PAP_PANEL_REQUEST', profile: PANEL_PROFILE, action: 'COMMAND', command });
  assert.equal(rejected.error, 'OPERATION_IN_PROGRESS');
  await model.select(targetKey(model.state.targets.find(value => value.tabId === 18)));
  assert.equal(model.draft.text, '');
  model.edit('SYNTHETIC_OTHER_TAB_DRAFT'); p.close();
  gate.resolve({ synthetic: true });
  const op = await f.settled(another.model, original.id);
  assert.equal(op.state, 'SUBMISSION_OBSERVED');
  assert.equal(f.releases.length, 1); assert.equal(f.releases[0].tabId, 17);
  assert.equal(f.pages.get(17).text, text); assert.equal(f.pages.get(18).text, '');
  assert.equal(f.pages.get(17).clicks(), 1);
  const preview = f.runtime.session.receipts.prepare({ ids: [f.runtime.session.receipts.list()[0].id] });
  assert.equal(preview.texts[0].preview, text);
  assert.doesNotMatch(JSON.stringify(f.replies), /textBytes|payloadDigest|recordDigest|PRIVATE|<script>/);
  const report = JSON.stringify(diagnostics.preview().report);
  assert.ok(!report.includes(text) && !report.includes('fixture-17'));
  const encrypted = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await encrypted(path);
      else if (entry.isFile()) assert.ok(!(await readFile(path)).includes(Buffer.from(text)));
    }
  };
  await f.close();
  await encrypted(join(f.root, 'engine'));
});

test('only a live privileged panel can read state, send commands or open the local dashboard', async t => {
  const f = await fixture(t), p = await f.panel();
  const state = { kind: 'PAP_PANEL_REQUEST', profile: PANEL_PROFILE, action: 'STATE' };
  const before = f.port.messages.filter(value => value.kind === 'PAP_PANEL_REQUEST').length;
  for (const sender of [f.pages.get(17).captureSender(), { ...p.sender, tab: { id: 17 } },
    { ...p.sender, origin: 'https://chatgpt.com' }, { ...p.sender, url: `${panelURL}?fake=1` },
    { ...p.sender, documentLifecycle: 'prerender' }, { ...p.sender, documentId: randomUUID() }]) {
    assert.equal((await f.worker.message(state, sender)).error, 'UNTRUSTED_PANEL');
  }
  const context = f.contexts.get(p.sender.documentId);
  context.contextType = 'TAB';
  assert.equal((await f.worker.message(state, p.sender)).error, 'UNTRUSTED_PANEL');
  context.contextType = 'SIDE_PANEL'; context.incognito = true;
  assert.equal((await f.worker.message(state, p.sender)).error, 'UNTRUSTED_PANEL');
  context.incognito = false;
  assert.equal(f.port.messages.filter(value => value.kind === 'PAP_PANEL_REQUEST').length, before);
  assert.equal((await p.transport({ ...state, action: 'COMMAND', command: { kind: 'SIGN' } })).error, 'PANEL_REQUEST_REJECTED');
  await p.model.dashboard();
  assert.deepEqual(f.dashboards, [f.runtime.dashboardURL]);
  assert.ok(!JSON.stringify(f.replies).includes(new URL(f.runtime.composerURL).hash.slice(1)));
  p.close(); assert.equal((await f.worker.message(state, p.sender)).error, 'UNTRUSTED_PANEL');
});

test('stale commands, provider drafts, attachments, ambiguous surfaces and navigation fail closed', async t => {
  const gate = deferred(), f = await fixture(t, { collectFast: () => gate.promise, release: gate.resolve });
  const { model, transport } = await f.panel();
  const stale = model.envelope('PROTECT_AND_SEND', { scope: model.scope.scope, operationId: randomUUID(), text, editRevision: 1 });
  await model.mode('Continuous');
  assert.equal((await transport({ kind: 'PAP_PANEL_REQUEST', profile: PANEL_PROFILE, action: 'COMMAND', command: stale })).error, 'STALE_ENGINE_REVISION');
  for (const mutate of [page => { page.text = 'SYNTHETIC_PROVIDER_DRAFT'; }, page => { page.attachments = true; },
    page => { page.buttons = [page.button, page.button]; }]) {
    const page = f.pages.get(17); mutate(page); page.changed();
    await until(async () => { await model.refresh(); return !model.target.sealedEligible; });
    model.edit(text); assert.equal(model.canSend, false);
    const command = model.envelope('PROTECT_AND_SEND', { scope: model.scope.scope, operationId: randomUUID(), text, editRevision: 1 });
    assert.equal((await transport({ kind: 'PAP_PANEL_REQUEST', profile: PANEL_PROFILE, action: 'COMMAND', command })).error, 'CAPABILITY_UNAVAILABLE');
    page.attachments = false; page.buttons = [page.button]; page.text = '';
    await until(async () => { await model.refresh(); return model.target.sealedEligible; });
  }
  assert.equal(f.releases.length, 0);
  await model.send(); await until(() => f.confirmed === 1);
  const id = model.draft.submission.id;
  f.navigate(17);
  await until(async () => { await model.refresh(); return !model.target; });
  gate.resolve({ synthetic: true });
  await f.settled(model, id);
  assert.equal(f.pages.get(17).text, ''); assert.equal(f.releases.length, 0);
  assert.equal(model.canSend, false);
});

test('cancel is terminal and exported; pause/resume and a reopened panel never restore a send', async t => {
  const gate = deferred(), f = await fixture(t, { collectFast: () => gate.promise, release: gate.resolve });
  const { model } = await f.panel(); model.edit(text); await model.send();
  await until(() => f.confirmed === 1); await model.refresh();
  const id = model.draft.submission.id;
  await model.cancel(id); await model.pause(); await model.pause();
  gate.resolve({ synthetic: true });
  await f.runtime.engine.drain();
  const op = await f.settled(model, id);
  assert.equal(op.state, 'CANCELLED'); assert.equal(op.cancellable, false);
  const reopened = await f.panel();
  assert.equal(reopened.model.draft.text, ''); assert.equal(reopened.model.canSend, false);
  assert.equal(f.releases.length, 0);
  const receipt = f.runtime.session.receipts.list()[0];
  const preview = f.runtime.session.receipts.prepare({ ids: [receipt.id] });
  const report = verifyPortable(f.runtime.session.receipts.export(preview.previewId));
  assert.ok(report.records.some(value => value.localAssertions.some(assertion => assertion.kind === 'release-cancelled')));
  await f.restart();
  assert.ok(f.runtime.engine.state().operations.every(value => value.restored && value.stopped));
  assert.equal(f.runtime.engine.state().preferences.defaultMode, 'Sealed');
  assert.equal(f.runtime.engine.state().scopes.length, 0);
});

test('lost panel reply and disconnection do not replay admission', async t => {
  const gate = deferred(), f = await fixture(t, { dropPanelAck: true, collectFast: () => gate.promise, release: gate.resolve });
  const { model } = await f.panel(); model.edit(text);
  const sending = model.send();
  await until(() => f.confirmed === 1);
  f.disconnect(); await sending;
  assert.match(model.error, /Connection lost/);
  const admissions = () => f.port.messages.filter(value => value.command?.kind === 'PROTECT_AND_SEND').length;
  assert.equal(admissions(), 1);
  await model.refresh(); await model.send();
  assert.equal(admissions(), 1); assert.equal(model.canSend, false);
  gate.resolve({ synthetic: true }); await f.runtime.engine.drain();
  assert.equal(f.releases.length, 0);
});

test('panel reconnect requests new state and discards replies from the retired port', async t => {
  const documentId = randomUUID(), origin = `chrome-extension://${CHATGPT_EXTENSION_ID}`;
  const sender = { id: CHATGPT_EXTENSION_ID, origin, url: panelURL, documentId, documentLifecycle: 'active' };
  const worker = await workerFixture({ contexts: async () => [{ contextType: 'SIDE_PANEL', documentId,
    documentUrl: panelURL, documentOrigin: origin, incognito: false }] });
  t.after(() => worker.close()); await turn();
  const ready = (port, runtimeEpoch) => port.onMessage.emit({ kind: 'PAP_READY', runtimeEpoch,
    browserSessionId: port.messages.find(value => value.kind === 'PAP_HELLO').browserSessionId, panelProfile: PANEL_PROFILE });
  const first = worker.ports[0]; ready(first, 'old-epoch');
  const message = { kind: 'PAP_PANEL_REQUEST', profile: PANEL_PROFILE, action: 'COMMAND', command: {
    kind: 'PROTECT_AND_SEND', text: 'SYNTHETIC_LOST_ACK', commandId: randomUUID() } };
  const pending = worker.message(message, sender); await turn();
  const oldRequest = first.messages.find(value => value.kind === 'PAP_PANEL_REQUEST');
  first.disconnect(); assert.equal((await pending).error, 'PANEL_DISCONNECTED');
  await worker.fire(1000); const second = worker.ports[1]; ready(second, 'fresh-epoch');
  const fresh = worker.message({ kind: 'PAP_PANEL_REQUEST', profile: PANEL_PROFILE, action: 'STATE' }, sender);
  await turn();
  const newRequest = second.messages.find(value => value.kind === 'PAP_PANEL_REQUEST');
  first.onMessage.emit({ kind: 'PAP_PANEL_RESULT', profile: PANEL_PROFILE, requestId: oldRequest.requestId, state: 'OLD' });
  second.onMessage.emit({ kind: 'PAP_PANEL_RESULT', profile: PANEL_PROFILE, requestId: newRequest.requestId, state: 'FRESH' });
  assert.equal((await fresh).state, 'FRESH');
  assert.equal(second.messages.filter(value => value.action === 'COMMAND').length, 0);
});

test('panel negotiation is explicit and the native handler rejects authority and encoding extensions', async t => {
  const f = await fixture(t), hello = f.port.messages.find(value => value.kind === 'PAP_HELLO');
  const identity = { browser: { product: 'Google Chrome', channel: 'stable', major: 153 },
    platform: { product: 'macOS', arch: 'arm64', version: '15.7.2' } };
  const adapter = new ChatGPTChromeAdapter(() => {}, { extensionId: CHATGPT_EXTENSION_ID });
  const legacy = { ...hello, ...identity, permissions: ['nativeMessaging'] }; delete legacy.panelProfile;
  adapter.pair(legacy); assert.equal(adapter.capabilities.privilegedPanel, false);
  assert.throws(() => adapter.pair({ ...hello, ...identity, panelProfile: 'unknown' }));
  assert.throws(() => adapter.pair({ ...hello, ...identity, permissions: ['nativeMessaging'] }));
  const { model } = await f.panel();
  for (const command of [{ kind: 'SIGN' }, model.envelope('DEVELOPMENT_FREEZE', {}),
    model.envelope('PROTECT_AND_SEND', { scope: model.scope.scope, operationId: randomUUID(), editRevision: 1, textBytes: '/w==' }),
    model.envelope('PROTECT_AND_SEND', { scope: model.scope.scope, operationId: randomUUID(), editRevision: 1,
      textBytes: 'YQ==', text: 'substituted' })]) {
    await assert.rejects(panelRequest({ kind: 'PAP_PANEL_REQUEST', profile: PANEL_PROFILE, requestId: randomUUID(), action: 'COMMAND', command }, f.runtime.engine));
  }
  assert.equal(f.runtime.engine.state().operations.length, 0);
});

test('unknown post-exposure outcome never offers retry or cancellation as if the send were undone', async t => {
  const f = await fixture(t, { dropReleaseReply: true });
  const { model } = await f.panel(); model.edit(text); await model.send();
  const op = await f.settled(model);
  assert.equal(op.state, 'OUTCOME_UNKNOWN'); assert.equal(op.cancellable, false);
  assert.match(operationMessage(op), /Check ChatGPT; do not retry/);
  await model.send(); await model.refresh();
  assert.equal(f.releases.length, 1); assert.equal(f.pages.get(17).clicks(), 1);
});

for (const code of ['ACCOUNT_REQUIRED', 'QUOTA_EXHAUSTED', 'SERVICE_UNAVAILABLE', 'PENDING_FAST_CONFIRMATION']) {
  test(`panel explains ${code} without sending or automatic retry`, async t => {
    const options = code === 'PENDING_FAST_CONFIRMATION'
      ? { collectFast: () => { throw Object.assign(Error('SYNTHETIC_TIMEOUT'), { code }); } }
      : { managed: { status: () => ({ state: code }), submit: async () => { throw Object.assign(Error('SYNTHETIC_OUTAGE'), { code }); } } };
    const f = await fixture(t, options), { model } = await f.panel(); model.edit(text); await model.send();
    const op = await f.settled(model);
    assert.match(operationMessage(op), /Not sent\./); assert.equal(op.cancellable, true);
    assert.equal(model.canSend, false); assert.equal(f.releases.length, 0);
    await model.cancel(op.id); await f.runtime.engine.drain(); await model.refresh();
    assert.equal(model.state.operations[0].state, 'CANCELLED');
  });
}
