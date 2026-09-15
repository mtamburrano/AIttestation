import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { sidePanelFixture, panelURL } from './sidepanel-fixture.mjs';
import { CHATGPT_PANEL_PROFILE, CHATGPT_PANEL_DIAGNOSTIC_PROFILE, PANEL_REJECTION_CODES, panelRequest } from '../spikes/browser/chatgpt/panel.mjs';
import { ChromeBridgeController } from '../spikes/browser/chatgpt/bridge.mjs';
import { LocalDiagnostics } from '../spikes/diagnostics/local.mjs';
import { startDesktopChannel } from '../spikes/browser/chatgpt/desktop-channel.mjs';
import { dashboardState } from '../spikes/browser/chatgpt/dashboard.mjs';
import { recordingStatus } from '../spikes/browser/chatgpt/extension/sidepanel-model.js';
import { workerFixture, turn } from './chrome-worker-fixture.mjs';
import { CHATGPT_PAGE_CONTRACT } from '../spikes/browser/chatgpt/adapter.mjs';
import { until } from './recording-fixture.mjs';

async function fixture(t, options) {
  const directory = await mkdtemp('/private/tmp/attestamp-panel-test-');
  const f = await sidePanelFixture(directory, options);
  t.after(async () => { await f.close(); await rm(directory, { recursive: true, force: true }); }); return f;
}
test('retained sidebar controls only global recording and opens history, without collecting drafts', async t => {
  const f = await fixture(t), { model } = await f.panel();
  assert.equal(model.state.recording, false); f.pages.get(17).text = 'UNCHANGED_DRAFT';
  await model.toggle(); assert.equal(model.state.recording, true);
  assert.equal(model.state.readySources, 2); assert.equal(f.pages.get(17).text, 'UNCHANGED_DRAFT');
  assert.equal(f.runtime.session.receipts.list().length, 0);
  await model.dashboard(); assert.equal(f.dashboards.length, 1);
  await model.toggle(); assert.equal(model.state.recording, false);
  assert.equal(f.releases.length, 0);
  const html = await readFile(new URL('../spikes/browser/chatgpt/extension/sidepanel.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /<textarea|<select|Protect and send/);
});

test('each sidebar document is uniquely bound across all runtime context types', async t => {
  const f = await fixture(t), panel = await f.panel(), other = await f.panel();
  const request = { kind: 'PAP_PANEL_REQUEST', profile: CHATGPT_PANEL_PROFILE, action: 'STATE' };
  assert.notEqual(panel.sender.url, other.sender.url);
  assert.deepEqual(Object.keys(panel.sender).sort(), ['id', 'origin', 'url']);
  const context = f.contexts.get(panel.documentId), original = structuredClone(context);
  for (const patch of [{ contextType: 'POPUP' }, { contextType: 'TAB' }, { contextType: 'OFFSCREEN_DOCUMENT' },
    { frameId: 1 }, { tabId: 17 }, { documentOrigin: 'null' }, { incognito: true }, { documentId: '' }]) {
    Object.assign(context, patch);
    assert.equal((await panel.transport(request)).stage, 'PANEL_CONTEXT_REJECTED');
    Object.assign(context, original);
  }
  // Filtering getContexts by SIDE_PANEL would hide this live URL collision.
  f.contexts.set('copied-popup', { ...original, contextType: 'POPUP', documentId: randomUUID(), contextId: randomUUID() });
  assert.equal((await panel.transport(request)).stage, 'PANEL_CONTEXT_REJECTED');
  f.contexts.delete('copied-popup');
  assert.equal((await panel.transport(request)).state.recording, false);
  const sender = { ...panel.sender, documentId: panel.documentId, documentLifecycle: 'active', frameId: 0 };
  assert.equal((await f.requestFrom(request, sender)).state.recording, false);
  for (const patch of [{ id: 'wrong-extension' }, { origin: 'null' }, { frameId: 1 }, { nativeApplication: 'forged' },
    { documentId: randomUUID() }, { url: panel.sender.url + '#extra' }, { url: panel.sender.url + '&extra=1' }]) {
    assert.equal((await f.requestFrom(request, { ...sender, ...patch })).error, 'UNTRUSTED_PANEL');
  }
});

test('closure, context replacement, missing permissions and API failures fail closed before native control', async t => {
  const diagnostics = new LocalDiagnostics(), f = await fixture(t, { diagnostics }), panel = await f.panel();
  const contexts = f.worker.chrome.runtime.getContexts, permission = f.worker.chrome.permissions.contains;
  const request = { kind: 'PAP_PANEL_REQUEST', profile: CHATGPT_PANEL_PROFILE, action: 'STATE' };
  f.worker.chrome.permissions.contains = async () => false;
  assert.equal((await panel.transport(request)).stage, 'PANEL_PERMISSION_REJECTED');
  f.worker.chrome.permissions.contains = async () => {
    f.contexts.get(panel.documentId).contextId = randomUUID(); return true;
  };
  assert.equal((await panel.transport(request)).stage, 'PANEL_CONTEXT_REJECTED');
  f.worker.chrome.permissions.contains = permission;
  f.worker.chrome.runtime.getContexts = async () => { throw Error('PRIVATE_PLATFORM_CANARY https://private.invalid DOCUMENT_SECRET'); };
  for (let i = 0; i < 40; i++) assert.equal((await panel.transport(request)).stage, 'PANEL_CONTEXT_UNAVAILABLE');
  f.worker.chrome.runtime.getContexts = contexts;
  await until(() => diagnostics.preview().report.events.some(event => event.code === 'PANEL_CONTEXT_UNAVAILABLE'));
  const report = diagnostics.preview().report;
  assert.equal(report.events.filter(event => event.code === 'PANEL_CONTEXT_UNAVAILABLE').length, 1);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_PLATFORM_CANARY|private.invalid|DOCUMENT_SECRET|sidepanel.html|documentId/);
  assert.equal(f.port.messages.filter(value => value.kind === 'PAP_PANEL_DIAGNOSTIC' && value.code === 'PANEL_CONTEXT_UNAVAILABLE').length, 1);
  assert.equal(f.runtime.engine.state().recording, false);
  panel.close(); assert.equal((await panel.transport(request)).stage, 'PANEL_CONTEXT_REJECTED');
});

test('a copied-URL popup cannot borrow the surviving sidebar document to change recording', async t => {
  for (const schedule of ['departure', 'delayed disconnect notification', 'same-document navigation']) await t.test(schedule, async t => {
    const delayed = schedule === 'delayed disconnect notification', sameDocument = schedule === 'same-document navigation';
    const f = await fixture(t), panel = await f.panel(), before = f.runtime.engine.state();
    const popup = { ...f.contexts.get(panel.documentId), contextType: 'POPUP', documentId: randomUUID(), contextId: randomUUID() };
    f.contexts.set(popup.documentId, popup);
    const inspect = f.worker.chrome.runtime.getContexts;
    let release, started;
    const entered = new Promise(resolve => { started = resolve; });
    f.worker.chrome.runtime.getContexts = async filter => {
      started(); await new Promise(resolve => { release = resolve; });
      f.worker.chrome.runtime.getContexts = inspect;
      return inspect(filter);
    };
    const command = { profile: 'pap-resident-command/2', kind: 'SET_RECORDING', enabled: true,
      runtimeEpoch: before.runtimeEpoch, adapterProfile: panel.model.state.adapterProfile,
      expectedRevision: before.revision, commandId: randomUUID() };
    let requester;
    const result = f.requestFrom({ kind: 'PAP_PANEL_REQUEST', profile: CHATGPT_PANEL_PROFILE, action: 'COMMAND', command },
      { ...panel.sender }, { connected(port) { requester = port; }, notifyDisconnect: !delayed, dropAfterDeparture: delayed });
    await entered;
    // Synthetic scheduling, including observed Chrome same-document behavior:
    // only the sidebar remains at the copied URL, but history leaves the Port up.
    if (sameDocument) popup.documentUrl = panelURL + '?different-location';
    else { f.contexts.delete(popup.documentId); requester.disconnect(); }
    release();
    const reply = await result;
    await turn();
    if (delayed) {
      // Even if Chrome has not delivered onDisconnect yet and a Port write only
      // drops, the departed document cannot answer a fresh challenge.
      assert.equal(f.worker.panelPorts.at(-1).messages.at(-1).kind, 'PAP_PANEL_CHALLENGE');
      await until(() => f.worker.panelPorts.at(-1).messages.some(message => message.kind === 'PAP_PANEL_REPLY'));
      assert.equal(f.worker.panelPorts.at(-1).messages.at(-1).result.stage, 'PANEL_CONTEXT_REJECTED');
    }
    assert.equal(f.runtime.engine.state().recording, false);
    assert.equal(f.runtime.engine.state().revision, before.revision);
    assert.equal(f.port.messages.filter(value => value.kind === 'PAP_PANEL_REQUEST' && value.action === 'COMMAND').length, 0);
    assert.equal(reply.error, 'UNTRUSTED_PANEL');
  });
});

test('panel confirmations are single-use and confined to the requesting channel', async t => {
  const f = await fixture(t), panel = await f.panel();
  const before = f.runtime.engine.state(), command = { profile: 'pap-resident-command/2', kind: 'SET_RECORDING', enabled: true,
    runtimeEpoch: before.runtimeEpoch, adapterProfile: panel.model.state.adapterProfile,
    expectedRevision: before.revision, commandId: randomUUID() };
  const request = { kind: 'PAP_PANEL_REQUEST', profile: CHATGPT_PANEL_PROFILE, action: 'COMMAND', command };
  // The old one-shot route must reject even a real-looking sidebar sender.
  assert.equal((await f.worker.message(request, panel.sender)).error, 'UNTRUSTED_PANEL');
  let previousNonce;
  for (const attack of ['other channel', 'replayed confirmation', 'extra fields', 'second request']) {
    const client = f.worker.connectPanel(panel.sender), messages = [];
    client.onMessage.addListener(message => messages.push(message));
    client.postMessage(request);
    await until(() => messages.some(message => message.kind === 'PAP_PANEL_CHALLENGE'));
    const { nonce } = messages[0];
    if (previousNonce) assert.notEqual(nonce, previousNonce);
    if (attack === 'other channel') {
      const other = f.worker.connectPanel(panel.sender), replies = [];
      other.onMessage.addListener(message => replies.push(message));
      other.postMessage({ kind: 'PAP_PANEL_CONFIRM', nonce });
      await until(() => replies.length);
      assert.equal(replies[0].result.error, 'UNTRUSTED_PANEL');
      assert.equal(f.runtime.engine.state().revision, before.revision);
      client.disconnect();
    } else {
      client.postMessage(attack === 'second request' ? request : { kind: 'PAP_PANEL_CONFIRM',
        nonce: attack === 'replayed confirmation' ? previousNonce : nonce, ...(attack === 'extra fields' ? { unexpected: true } : {}) });
      await until(() => messages.some(message => message.kind === 'PAP_PANEL_REPLY'));
      assert.equal(messages.at(-1).result.error, 'UNTRUSTED_PANEL');
    }
    previousNonce = nonce;
  }
  assert.equal(f.runtime.engine.state().recording, false);
  assert.equal(f.runtime.engine.state().revision, before.revision);
  assert.equal(f.port.messages.filter(value => value.kind === 'PAP_PANEL_REQUEST' && value.action === 'COMMAND').length, 0);
});

test('native diagnostics accept only paired, bounded content-free stage codes', () => {
  const diagnostics = new LocalDiagnostics(), adapter = { capabilities: { privilegedPanel: true },
    pair: () => ({ runtimeEpoch: 'synthetic-epoch' }), synchronize() {} };
  const bridge = new ChromeBridgeController(adapter, () => {}, { diagnostics, localBrowser: {}, localPlatform: {} });
  const event = code => ({ kind: 'PAP_PANEL_DIAGNOSTIC', profile: CHATGPT_PANEL_DIAGNOSTIC_PROFILE, code });
  assert.throws(() => bridge.receive(event(PANEL_REJECTION_CODES[0])), /not paired/);
  bridge.receive({ kind: 'PAP_HELLO' });
  for (const code of PANEL_REJECTION_CODES) for (let i = 0; i < 5; i++) bridge.receive(event(code));
  for (const message of [event('PRIVATE_CANARY'), { ...event(PANEL_REJECTION_CODES[0]), url: 'PRIVATE_CANARY' },
    { ...event(PANEL_REJECTION_CODES[0]), profile: 'wrong' }]) assert.throws(() => bridge.receive(message));
  const events = diagnostics.preview().report.events.filter(value => value.code.startsWith('PANEL_'));
  assert.deepEqual(events.map(value => value.code), PANEL_REJECTION_CODES);
  assert.ok(events.every(value => Object.keys(value).sort().join(',') === 'code,component,elapsedMs,sequence'));
});

test('diagnostics are not sent to a peer that only negotiated the control contract', async t => {
  const worker = await workerFixture(); t.after(() => worker.close()); await turn();
  const port = worker.ports[0], hello = port.messages.find(value => value.kind === 'PAP_HELLO');
  port.onMessage.emit({ kind: 'PAP_READY', browserSessionId: hello.browserSessionId,
    runtimeEpoch: 'synthetic-epoch', panelProfile: CHATGPT_PANEL_PROFILE });
  assert.equal((await worker.message({ kind: 'PAP_PANEL_REQUEST', profile: CHATGPT_PANEL_PROFILE, action: 'STATE' }, {})).error, 'UNTRUSTED_PANEL');
  assert.equal(port.messages.filter(value => value.kind === 'PAP_PANEL_DIAGNOSTIC').length, 0);
});

test('sidebar views, dashboard and resident menu channel share consent without replay or enrollment', async t => {
  const f = await fixture(t), first = await f.panel(), second = await f.panel();
  await first.model.toggle();
  // The stale second view learns the current state; it never retries its command.
  await second.model.toggle();
  assert.equal(second.model.state.recording, true); assert.match(second.model.error, /another view/);
  assert.equal(f.requests.filter(value => value.action === 'COMMAND').length, 2);
  const input = new PassThrough(), output = new PassThrough(), events = [];
  output.on('data', bytes => events.push(JSON.parse(bytes.subarray(4))));
  const channel = startDesktopChannel(f.runtime, { input, output, onExit() {} });
  t.after(() => channel.close());
  await until(() => events.length > 0); assert.equal(events.at(-1).recording, true);
  const state = events.at(-1), body = Buffer.from(JSON.stringify({ profile: 'pap-desktop-command/2', kind: 'RECORDING',
    runtimeEpoch: state.runtimeEpoch, revision: state.revision, enabled: false }));
  const size = Buffer.alloc(4); size.writeUInt32BE(body.length); input.write(Buffer.concat([size, body]));
  await until(() => !f.runtime.engine.state().recording);
  await first.model.refresh(); await second.model.refresh();
  assert.equal(first.model.state.recording, false); assert.equal(second.model.state.recording, false);
  assert.equal((await dashboardState(f.runtime)).recording, false);
  assert.equal(f.runtime.session.receipts.list().length, 0);
  await first.model.toggle(); first.close(); second.close();
  await f.addTab(19, { active: false, windowId: 3 });
  f.worker.chrome.tabs.onActivated.emit({ tabId: 19 });
  f.navigate(17); await f.refresh(18); await f.refresh(19);
  assert.equal(f.runtime.session.receipts.list().length, 0);
  f.send('SYNTHETIC_UNRELATED_SOURCE', { id: 18 }); f.send('SYNTHETIC_NEW_SOURCE', { id: 19 });
  await until(() => f.runtime.session.receipts.list().length === 2);
  assert.equal(f.releases.length, 0); assert.equal(f.prevention, 0);
});

test('status separates intentional OFF, requested ON, unavailable sources and local evidence', () => {
  assert.equal(recordingStatus({ recording: false, available: false }), 'Attestamp is OFF');
  assert.equal(recordingStatus({ recording: true, available: false }), 'ON requested · Recording unavailable');
  assert.match(recordingStatus({ recording: true, available: true, unavailableSources: 1 }), /Some supported tabs are unavailable/);
  assert.match(recordingStatus({ recording: true, available: true, readySources: 0 }), /Waiting/);
  assert.doesNotMatch(recordingStatus({ recording: true, available: true, readySources: 2 }), /saved|anchor|debug/i);
});
test('untrusted page, tab and stale sidebar contexts cannot acquire control authority', async t => {
  const f = await fixture(t), panel = await f.panel();
  const message = { kind: 'PAP_PANEL_REQUEST', profile: CHATGPT_PANEL_PROFILE, action: 'STATE' };
  for (const sender of [f.pages.get(17).captureSender(), { ...panel.sender, tab: { id: 17 } },
    { ...panel.sender, url: panelURL + '?spoof' }, { ...panel.sender, documentLifecycle: 'prerender' },
    { ...panel.sender, documentId: randomUUID() }, { ...panel.sender, origin: 'https://chatgpt.com' }]) {
    assert.equal((await f.requestFrom(message, sender)).error, 'UNTRUSTED_PANEL');
  }
  panel.close(); assert.equal((await panel.transport(message)).error, 'UNTRUSTED_PANEL');
});
test('sidebar cannot manufacture captures; page roles cannot set consent; removed commands reject at both panel boundaries', async t => {
  const f = await fixture(t), panel = await f.panel();
  for (const kind of ['PROTECT_AND_SEND', 'DEVELOPMENT_FREEZE', 'SET_PAUSE', 'ENROLL_SCOPE', 'CANCEL_OPERATION']) {
    const command = { kind, text: 'ARBITRARY_SYNTHETIC' };
    assert.equal((await panel.transport({ kind: 'PAP_PANEL_REQUEST', profile: CHATGPT_PANEL_PROFILE,
      action: 'COMMAND', command })).error, 'PANEL_REQUEST_REJECTED');
    await assert.rejects(panelRequest({ kind: 'PAP_PANEL_REQUEST', profile: CHATGPT_PANEL_PROFILE,
      requestId: randomUUID(), action: 'COMMAND', command }, f.runtime.engine));
  }
  assert.equal((await f.worker.message({ kind: 'PAP_CAPTURE', pageContract: CHATGPT_PAGE_CONTRACT,
    text: 'ARBITRARY_SYNTHETIC' }, panel.sender)).state, 'RECORDING_UNAVAILABLE');
  assert.equal((await f.worker.message({ kind: 'PAP_PANEL_REQUEST', profile: CHATGPT_PANEL_PROFILE,
    action: 'COMMAND', command: { kind: 'SET_RECORDING', enabled: true } }, f.pages.get(17).captureSender())).error, 'UNTRUSTED_PANEL');
  const state = panel.model.state;
  const command = { profile: 'pap-resident-command/2', kind: 'SET_RECORDING', enabled: true, text: 'FORGED',
    runtimeEpoch: state.runtimeEpoch, adapterProfile: state.adapterProfile, expectedRevision: state.revision, commandId: randomUUID() };
  await assert.rejects(panelRequest({ kind: 'PAP_PANEL_REQUEST', profile: CHATGPT_PANEL_PROFILE,
    requestId: randomUUID(), action: 'COMMAND', command }, f.runtime.engine));
  assert.equal(f.runtime.engine.state().recording, false); assert.equal(f.runtime.session.receipts.list().length, 0);
});
test('disconnect makes sidebar status unavailable without replaying a prior command', async t => {
  const f = await fixture(t), { model } = await f.panel(); await model.toggle();
  const before = f.requests.filter(value => value.action === 'COMMAND').length;
  f.disconnect(); await until(() => !f.runtime.browserState()); await model.refresh();
  assert.equal(model.state, null); assert.match(model.error, /unavailable/);
  assert.equal(f.requests.filter(value => value.action === 'COMMAND').length, before);
});
