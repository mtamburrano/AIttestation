import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { recordingFixture, until } from './recording-fixture.mjs';

const tick = () => new Promise(setImmediate);
const saved = f => f.runtime.session.receipts.list();
function gate(t) {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  return { promise, release };
}
async function fixture(t, options = {}) {
  const root = await mkdtemp('/private/tmp/attestamp-relay-ordering-test-'); let f;
  t.after(async () => { await f?.close(); await rm(root, { recursive: true, force: true }); });
  f = await recordingFixture(root, options); await f.recording(true); return f;
}
async function conversationPolicy(f, url = 'https://chatgpt.com/c/created-by-send') {
  f.navigate(17, url);
  await until(async () => (await f.refresh()).policy?.expectedUrl === url);
}
async function assertFeedback(f, state) {
  await tick(); await tick();
  assert.equal(f.pages.get(17).feedback, state);
  await f.refresh();
  assert.equal(f.pages.get(17).feedback, state);
}

for (const newChat of [true, false]) {
  test(`first New Chat Send survives repeated loading updates (${newChat ? 'fresh tab' : 'same-tab return'})`, async t => {
    const f = await fixture(t, { newChat, fixedSenderURL: true });
    if (!newChat) await conversationPolicy(f, 'https://chatgpt.com/');
    const page = f.pages.get(17), relay = page.holdTransport('request');
    const originalPolicy = (await f.refresh()).policy;
    f.send('FIRST_SEND_e\u0301\r\n  ☕');
    await until(() => relay.messages.length === 1);
    for (let index = 0; index < 2; index++) {
      f.worker.chrome.tabs.onUpdated.emit(17, { status: 'loading' });
      await tick(); await f.refresh();
    }
    await conversationPolicy(f);
    f.worker.chrome.tabs.onUpdated.emit(17, { status: 'loading' });
    await tick();
    f.worker.chrome.tabs.onUpdated.emit(17, { url: page.location.href, status: 'loading' });
    f.worker.chrome.tabs.onUpdated.emit(17, { status: 'complete' });
    await until(async () => (await f.refresh()).policy?.expectedUrl === page.location.href);
    assert.equal((await f.refresh()).policy.tabEpoch, originalPolicy.tabEpoch);
    assert.equal(saved(f).length, 0);
    relay.release();
    await until(() => page.feedback === 'Attestamp · Prompt saved');
    assert.equal(saved(f).length, 1); assert.equal(f.deliveries.length, 1);
    assert.equal(f.sources[0].destination, 'new-chat');
    assert.equal(f.runtime.session.receipts.prepare({ ids: [saved(f)[0].id] }).texts[0].preview, 'FIRST_SEND_e\u0301\r\n  ☕');
    assert.equal(page.requests.length, 1); assert.equal(f.prevention, 0); assert.equal(f.releases.length, 0);
  });
}

for (const order of ['policy before relay', 'relay before policy']) {
  test(`first New Chat Send captures once with ${order}`, async t => {
    const capture = gate(t); let entered = false;
    const response = new Response('UNCHANGED_PROVIDER_RESPONSE'), provider = Promise.resolve(response);
    const f = await fixture(t, { newChat: true, fixedSenderURL: true, fetchResponse: () => provider,
      beforeCapture: async () => { entered = true; await capture.promise; } });
    const page = f.pages.get(17), relay = page.holdTransport('request');
    f.send('FIRST_NEW_CHAT', { request: false });
    const sent = page.request('FIRST_NEW_CHAT');
    assert.equal(sent, provider); assert.equal(await sent, response);
    assert.equal(await response.text(), 'UNCHANGED_PROVIDER_RESPONSE');
    await until(() => relay.messages.length === 1);
    assert.equal(f.deliveries.length, 0); assert.equal(saved(f).length, 0);
    if (order === 'relay before policy') { relay.release(); await until(() => entered); }
    await conversationPolicy(f);
    if (order === 'policy before relay') {
      assert.equal(entered, false); assert.equal(page.feedback, 'Attestamp · ON');
      relay.release(); await until(() => entered);
    }
    capture.release(); await until(() => page.feedback === 'Attestamp · Prompt saved');
    await assertFeedback(f, 'Attestamp · Prompt saved');
    assert.equal(saved(f).length, 1); assert.equal(f.deliveries.length, 1);
    assert.equal(f.sources[0].destination, 'new-chat');
    assert.equal(f.deliveries[0].observation.eventId, relay.messages[0].data.id);
    assert.equal(page.requests.length, 1); assert.equal(f.prevention, 0); assert.equal(f.releases.length, 0);
  });
}

test('policy before relay preserves the matching request after an earlier unextractable Send', async t => {
  const f = await fixture(t, { newChat: true, fixedSenderURL: true }), page = f.pages.get(17);
  f.send('UNSUPPORTED_FIRST', { request: false });
  await page.fetch('/backend-api/f/conversation', { method: 'POST', body: new FormData() });
  await until(() => page.feedback === 'Attestamp · Recording gap');
  const relay = page.holdTransport('request');
  f.send('SUPPORTED_NEXT'); await until(() => relay.messages.length === 1);
  await conversationPolicy(f); relay.release();
  await until(() => page.feedback === 'Attestamp · Prompt saved');
  assert.equal(saved(f).length, 1); assert.equal(f.deliveries.length, 1);
  assert.equal(f.deliveries[0].observation.eventId, relay.messages[0].data.id);
  assert.equal(f.sources[0].destination, 'new-chat');
  assert.equal(page.requests.length, 2); assert.equal(f.prevention, 0);
});

for (const change of ['OFF', 'OFF/ON', 'reload', 'full navigation', 'replacement document', 'other tab',
  'unrelated route', 'unsupported route', 'permission loss', 'disconnect', 'request relay expiry']) {
  test(`policy-before-relay continuity rejects ${change}`, async t => {
    const response = new Response('PROVIDER_UNAFFECTED'), provider = Promise.resolve(response);
    const f = await fixture(t, { newChat: true, fixedSenderURL: true, fetchResponse: () => provider });
    const page = f.pages.get(17), relay = page.holdTransport('request');
    f.send('DELAYED_FIRST_REQUEST', { request: false });
    assert.equal(page.request('DELAYED_FIRST_REQUEST'), provider);
    await until(() => relay.messages.length === 1);
    await conversationPolicy(f);
    if (change === 'OFF' || change === 'OFF/ON') await f.recording(false);
    if (change === 'OFF/ON') await f.recording(true);
    if (change === 'reload' || change === 'full navigation') page.event('pagehide');
    if (change === 'reload') f.worker.chrome.tabs.onUpdated.emit(17, { status: 'loading' });
    if (change === 'replacement document') { page.documentId = 'replacement-document'; await f.refresh(); }
    if (change === 'other tab') {
      f.pages.get(18).transportMessage(relay.messages[0].data); page.event('pagehide');
    }
    if (change === 'unrelated route') await conversationPolicy(f, 'https://chatgpt.com/c/unrelated');
    if (change === 'unsupported route') { f.navigate(17, 'https://chatgpt.com/settings'); await f.refresh(); }
    if (change === 'permission loss') { f.revokePermission(); await until(() => !f.runtime.adapter.scopes().length); }
    if (change === 'disconnect') f.disconnect();
    if (change === 'request relay expiry') await new Promise(resolve => setTimeout(resolve, 5050));
    relay.release();
    await new Promise(resolve => setTimeout(resolve, 80)); await f.runtime.engine.drain();
    assert.equal(saved(f).length, 0); assert.equal(f.deliveries.length, 0); assert.equal(f.anchorCalls, 0);
    assert.equal(page.requests.length, 1); assert.equal(f.prevention, 0); assert.equal(f.releases.length, 0);
    assert.equal(await provider, response); assert.equal(await response.text(), 'PROVIDER_UNAFFECTED');
    if (change === 'OFF') assert.equal(page.feedback, '');
    assert.doesNotMatch(page.feedback, /Prompt saved/);
  });
}

test('a DOM Send alone creates no evidence across a fresh route policy', async t => {
  const f = await fixture(t, { newChat: true, fixedSenderURL: true });
  f.send('NO_FETCH', { request: false }); await conversationPolicy(f);
  await assertFeedback(f, 'Attestamp · ON');
  assert.equal(saved(f).length, 0); assert.equal(f.deliveries.length, 0); assert.equal(f.pages.get(17).requests.length, 0);
});

for (const state of ['current', 'OFF', 'OFF/ON']) {
  test(`late body-read gap cannot replace a newer saved Send (${state})`, async t => {
    const f = await fixture(t), page = f.pages.get(17), relay = page.holdTransport('gap');
    let input;
    const request = new Request('https://chatgpt.com/backend-api/f/conversation', { method: 'POST', duplex: 'half',
      body: new ReadableStream({ start(controller) { input = controller; } }) });
    t.after(() => { try { input.close(); } catch {} });
    f.send('SLOW_A', { request: false });
    const original = await page.fetch(request);
    assert.ok(original instanceof Response); assert.equal(request.bodyUsed, false);
    f.send('SAVED_B'); await until(() => page.feedback === 'Attestamp · Prompt saved');
    await until(() => relay.messages.length === 1);
    if (state !== 'current') await f.recording(false);
    if (state === 'OFF/ON') await f.recording(true);
    relay.release();
    await assertFeedback(f, state === 'OFF' ? '' : state === 'OFF/ON' ? 'Attestamp · ON' : 'Attestamp · Prompt saved');
    assert.equal(saved(f).length, 1); assert.equal(f.deliveries.length, 1);
    assert.notEqual(f.deliveries[0].observation.eventId, relay.messages[0].data.id);
    // Cancelling the observer's timed-out clone must leave provider input usable.
    input.enqueue(new TextEncoder().encode('UNCHANGED_PROVIDER_INPUT')); input.close();
    assert.equal(await request.text(), 'UNCHANGED_PROVIDER_INPUT');
    assert.equal(page.requests.length, 2); assert.equal(page.requests[0][0], request); assert.equal(f.prevention, 0);
  });
  test(`late save result cannot replace a newer unsupported Send (${state})`, async t => {
    const result = gate(t); let entered = false;
    const f = await fixture(t, { afterCapture: async (_message, value) => {
      assert.equal(value.state, 'PROMPT_SAVED'); entered = true; await result.promise;
    } });
    const page = f.pages.get(17);
    f.send('SAVED_A'); await until(() => entered);
    f.send('UNSUPPORTED_B', { request: false });
    const options = { method: 'POST', body: new FormData() };
    await page.fetch('/backend-api/f/conversation', options);
    await until(() => page.feedback === 'Attestamp · Recording gap');
    if (state !== 'current') await f.recording(false);
    if (state === 'OFF/ON') await f.recording(true);
    result.release();
    await assertFeedback(f, state === 'OFF' ? '' : state === 'OFF/ON' ? 'Attestamp · ON' : 'Attestamp · Recording gap');
    assert.equal(saved(f).length, 1); assert.equal(f.deliveries.length, 1);
    assert.equal(page.requests.length, 2); assert.equal(page.requests[1][1], options); assert.equal(f.prevention, 0);
  });
}

test('a late request message cannot replace a newer unextractable Send outcome', async t => {
  const f = await fixture(t), page = f.pages.get(17), relay = page.holdTransport('request');
  f.send('DELAYED_A'); await until(() => relay.messages.length === 1);
  f.send('UNSUPPORTED_B', { request: false });
  await page.fetch('/backend-api/f/conversation', { method: 'POST', body: new FormData() });
  await until(() => page.feedback === 'Attestamp · Recording gap');
  relay.release(); await until(() => saved(f).length === 1);
  await assertFeedback(f, 'Attestamp · Recording gap');
  assert.equal(f.deliveries.length, 1); assert.equal(page.requests.length, 2); assert.equal(f.prevention, 0);
});

test('a refused newer human Send retires older save feedback without disturbing its evidence', async t => {
  const result = gate(t); let entered = false;
  const f = await fixture(t, { afterCapture: async () => { entered = true; await result.promise; } });
  const page = f.pages.get(17);
  f.send('SAVED_A'); await until(() => entered);
  f.send('REFUSED_B', { payload: { action: 'regenerate' } });
  await assertFeedback(f, 'Attestamp · Recording gap');
  result.release(); await assertFeedback(f, 'Attestamp · Recording gap');
  assert.equal(saved(f).length, 1); assert.equal(f.deliveries.length, 1);
  assert.equal(page.requests.length, 2); assert.equal(f.prevention, 0);
});
