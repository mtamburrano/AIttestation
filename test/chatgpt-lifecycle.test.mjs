import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { workerFixture, testTab, turn } from './chrome-worker-fixture.mjs';
import { recordingFixture, until } from './recording-fixture.mjs';

for (const runtimeEpoch of ['same-runtime', 'restarted-runtime']) for (const offlineNavigation of [false, true]) {
  test(`native reconnect preserves the proven document route with fresh capture authority (${runtimeEpoch}, offline navigation=${offlineNavigation})`, async t => {
    const creationURL = 'https://chatgpt.com/';
    let tab = testTab({ url: creationURL, destination: 'new-chat' }), granted = true;
    const captured = [];
    const f = await workerFixture({ query: async () => [tab], permission: async () => granted,
      inspect: async (_id, message) => message.kind === 'PAP_CONFIRM_DOCUMENT'
        ? { nonce: message.nonce, active: true, url: tab.url }
        : message.kind === 'PAP_INSPECT' ? { destination: tab.destination, surfaceSupported: true,
          attachmentsPresent: false, observerState: 'ready' } : true,
      onConnect(port) {
        port.send = message => {
          if (message.kind !== 'PAP_CAPTURE') return;
          captured.push(structuredClone(message));
          queueMicrotask(() => port.onMessage.emit({ kind: 'PAP_CAPTURE_RESULT', requestId: message.requestId,
            result: { profile: 'pap-chatgpt-capture/5', eventId: message.observation.eventId,
              kind: message.observation.kind, state: 'PROMPT_SAVED' } }));
        };
      },
    });
    t.after(() => f.close());
    await turn();
    const first = f.ports[0], hello = first.messages.find(message => message.kind === 'PAP_HELLO');
    const sender = { id: f.chrome.runtime.id, frameId: 0, origin: 'https://chatgpt.com',
      documentId: 'same-live-document', documentLifecycle: 'active', url: creationURL,
      tab: { id: tab.id, windowId: tab.windowId, incognito: false } };
    const status = () => f.message({ kind: 'PAP_CAPTURE_STATUS', pageContract: hello.pageContract }, sender);
    const offer = (port, epoch) => {
      const policy = { profile: 'pap-chatgpt-capture/5', token: randomUUID(), runtimeEpoch: epoch,
        browserSessionId: hello.browserSessionId, tabId: tab.id, windowId: tab.windowId,
        tabEpoch: port.messages.find(message => message.kind === 'PAP_HELLO').tabs[0].tabEpoch, scope: randomUUID(), expectedUrl: tab.url, destination: tab.destination };
      port.onMessage.emit({ kind: 'PAP_CAPTURE_POLICY', profile: policy.profile, policies: [policy],
        states: [{ tabId: tab.id, state: 'READY' }] });
      return policy;
    };
    const capture = (policy, selectedSender = sender) => f.message({ kind: 'PAP_CAPTURE', pageContract: hello.pageContract,
      token: policy.token, eventId: randomUUID(), observationKind: 'request-observed', inputMethod: 'provider-request',
      text: 'SYNTHETIC_RECONNECTED_REQUEST', request: { profile: 'chatgpt-new-user-text/3',
        path: '/backend-api/f/conversation', messageId: randomUUID(), conversationId: 'created-conversation' } }, selectedSender);
    f.ready(first, 'same-runtime'); offer(first, 'same-runtime'); await status();
    tab = { ...tab, url: 'https://chatgpt.com/c/created-conversation', destination: 'conversation:created-conversation' };
    f.chrome.tabs.onUpdated.emit(tab.id, { url: tab.url }); await turn(); await turn();
    const previous = offer(first, 'same-runtime');
    assert.equal((await status()).policy.token, previous.token);
    assert.equal((await capture(previous)).state, 'PROMPT_SAVED');
    first.disconnect();
    assert.equal((await capture(previous)).state, 'RECORDING_UNAVAILABLE');
    if (offlineNavigation) {
      tab = { ...tab, url: 'https://chatgpt.com/c/offline-conversation', destination: 'conversation:offline-conversation' };
      f.chrome.tabs.onUpdated.emit(tab.id, { url: tab.url, status: 'loading' }); await turn(); await turn();
    }
    await f.fire(1000);
    const replacement = f.ports[1]; f.ready(replacement, runtimeEpoch);
    const current = offer(replacement, runtimeEpoch);
    assert.equal((await status()).policy?.token, current.token,
      'a native reconnect must not forget the authenticated SPA document creation URL');
    assert.equal((await capture(previous)).state, 'RECORDING_UNAVAILABLE', 'old capture authority stays revoked');
    assert.equal((await capture(current, { ...sender, documentId: 'other-document' })).state, 'RECORDING_UNAVAILABLE');
    assert.equal((await capture(current)).state, 'PROMPT_SAVED');
    assert.equal(captured.length, 2);
    assert.equal(captured[1].observation.source.destination, tab.destination);
    assert.equal(captured[1].observation.source.documentId, sender.documentId);
    granted = false; f.chrome.permissions.onRemoved.emit();
    assert.equal((await capture(current)).state, 'RECORDING_UNAVAILABLE');
    assert.equal(captured.length, 2);
  });
}

test('startup and overlapping update recovery inject only fixed scripts into supported top-level documents', async t => {
  const calls = [];
  const f = await workerFixture({ query: async () => [testTab(),
    testTab({ id: 18, url: 'https://chatgpt.com/settings' }), testTab({ id: 19, incognito: true }),
    testTab({ id: 20, discarded: true }), testTab({ id: 21, url: 'https://chatgpt.com/c/WEB:11111111-2222-4333-8444-555555555555' })],
    executeScript: async input => { calls.push(structuredClone(input)); await turn();
      return [{ frameId: 0, documentId: `document-${input.target.tabId}` }]; } });
  t.after(() => f.close());
  f.chrome.runtime.onInstalled.emit({ reason: 'update' }); f.chrome.runtime.onInstalled.emit({ reason: 'install' });
  await until(() => calls.length === 4); await turn();
  assert.deepEqual(calls.filter(value => value.world === 'ISOLATED').map(value => value.target.tabId).sort(), [17, 21]);
  for (const id of [17, 21]) {
    assert.deepEqual(calls.filter(value => value.target.tabId === id), [
      { target: { tabId: id, frameIds: [0] }, world: 'ISOLATED', files: ['content-script.js'], injectImmediately: true },
      { target: { tabId: id, documentIds: [`document-${id}`] }, world: 'MAIN', files: ['fetch-observer.js'], injectImmediately: true },
    ]);
  }
});

for (const count of [33, 65]) {
  test(`recovery reaches all ${count} supported tabs with bounded concurrency and overlapping update events`, async t => {
    const calls = [], tabs = Array.from({ length: count }, (_, index) => testTab({ id: 17 + index }));
    let active = 0, peak = 0, release;
    const gate = new Promise(resolve => { release = resolve; });
    const f = await workerFixture({ query: async () => tabs,
      executeScript: async input => {
        calls.push(structuredClone(input)); active++; peak = Math.max(peak, active);
        try {
          await gate; await turn();
          return [{ frameId: 0, documentId: `document-${input.target.tabId}` }];
        } finally { active--; }
      } });
    t.after(() => { release(); f.close(); });
    f.chrome.runtime.onInstalled.emit({ reason: 'update' });
    await turn(); await turn();
    assert.ok(calls.length > 0, 'recovery must start even above the capture inventory limit');
    assert.ok(calls.length <= 8, 'only a bounded batch may wait on Chrome at once');
    release();
    await until(() => calls.length === count * 2 && active === 0);
    assert.ok(peak <= 8);
    for (const tab of tabs) assert.deepEqual(calls.filter(value => value.target.tabId === tab.id), [
      { target: { tabId: tab.id, frameIds: [0] }, world: 'ISOLATED', files: ['content-script.js'], injectImmediately: true },
      { target: { tabId: tab.id, documentIds: [`document-${tab.id}`] }, world: 'MAIN', files: ['fetch-observer.js'], injectImmediately: true },
    ]);
  });
}

test('a disappeared document does not prevent recovery of later batches', async t => {
  const calls = [], tabs = Array.from({ length: 33 }, (_, index) => testTab({ id: 17 + index }));
  const f = await workerFixture({ query: async () => tabs,
    executeScript: async input => {
      calls.push(structuredClone(input));
      if (input.target.tabId === 17) throw Error('SYNTHETIC_DOCUMENT_GONE');
      return [{ frameId: 0, documentId: `document-${input.target.tabId}` }];
    } });
  t.after(() => f.close());
  await until(() => calls.length === 65);
  assert.deepEqual(calls.filter(value => value.world === 'ISOLATED').map(value => value.target.tabId), tabs.map(tab => tab.id));
  assert.deepEqual(calls.filter(value => value.world === 'MAIN').map(value => value.target.tabId), tabs.slice(1).map(tab => tab.id));
});

test('revoking permission during a batch prevents further batches and MAIN injection', async t => {
  const calls = []; let granted = true;
  const f = await workerFixture({ permission: async () => granted,
    query: async () => Array.from({ length: 33 }, (_, index) => testTab({ id: 17 + index })),
    executeScript: async input => {
      calls.push(structuredClone(input)); granted = false; await turn();
      return [{ frameId: 0, documentId: `document-${input.target.tabId}` }];
    } });
  t.after(() => f.close());
  for (let i = 0; i < 10; i++) await turn();
  assert.ok(calls.length > 0 && calls.length <= 8);
  assert.ok(calls.every(value => value.world === 'ISOLATED'));
});

for (const failure of ['revoked initially', 'revoked after relay', 'document disappeared', 'wrong frame', 'missing document']) {
  test(`recovery fails closed when ${failure}`, async t => {
    const calls = []; let granted = failure !== 'revoked initially';
    const f = await workerFixture({ permission: async () => granted,
      query: async () => [testTab()],
      executeScript: async input => {
        calls.push(structuredClone(input));
        if (failure === 'document disappeared') throw Error('SYNTHETIC_DOCUMENT_GONE');
        if (failure === 'revoked after relay') granted = false;
        return [{ frameId: failure === 'wrong frame' ? 1 : 0, documentId: failure === 'missing document' ? '' : 'document-17' }];
      } });
    t.after(() => f.close());
    for (let i = 0; i < 5; i++) await turn();
    assert.equal(calls.length, failure === 'revoked initially' ? 0 : 1);
    assert.ok(calls.every(value => value.world === 'ISOLATED'));
  });
}

async function fixture(t) {
  const root = await mkdtemp('/private/tmp/attestamp-lifecycle-test-'); let f;
  t.after(async () => { await f?.close(); await rm(root, { recursive: true, force: true }); });
  f = await recordingFixture(root); await f.recording(true); return f;
}

test('repeated reinjection preserves one observer, one relay and current consent', async t => {
  const f = await fixture(t), page = f.pages.get(17), policy = (await f.refresh()).policy;
  for (let i = 0; i < 4; i++) page.reinject();
  assert.equal((await f.refresh()).policy.token, policy.token);
  await page.request('ON_AFTER_REINJECTION');
  await until(() => f.runtime.session.receipts.list().length === 1);
  assert.equal(f.deliveries.length, 1);
  assert.equal(page.document.querySelectorAll('#attestamp-recording-status').length, 1);
  await f.recording(false); page.reinject();
  await page.request('OFF_AFTER_REINJECTION'); await turn(); await turn();
  assert.equal(f.runtime.session.receipts.list().length, 1);
  assert.equal(page.feedback, ''); assert.equal(page.requests.length, 2); assert.equal(f.prevention, 0);
});

test('an invalidated extension context removes stale status and retires pending relay work', async t => {
  const f = await fixture(t), page = f.pages.get(17), held = page.holdTransport('request');
  await page.request('STALE_EXTENSION_REQUEST'); await until(() => held.messages.length === 1);
  page.invalidateExtension();
  await until(() => page.document.querySelectorAll('#attestamp-recording-status').length === 0);
  held.release(); await turn(); await turn();
  assert.equal(f.deliveries.length, 0); assert.equal(f.runtime.session.receipts.list().length, 0);
  await page.request('PROVIDER_CONTINUES'); await turn();
  assert.equal(page.requests.length, 2); assert.equal(f.prevention, 0);
});
