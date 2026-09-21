import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { recordingFixture, until } from './recording-fixture.mjs';
import { LocalDiagnostics } from '../spikes/diagnostics/local.mjs';
import { verifyPortable } from '../spikes/recipient/portable.mjs';
import { CHATGPT_PAGE_CONTRACT } from '../spikes/browser/chatgpt/adapter.mjs';
import { EngineStateStore } from '../spikes/browser/chatgpt/engine-store.mjs';

const exact = '\uFEFF  REQUEST_AUTHORITY_e\u0301\r\n☕\t';
const tick = () => new Promise(setImmediate);
async function fixture(t, options = {}) {
  const root = await mkdtemp('/private/tmp/attestamp-request-authority-test-'); let f;
  t.after(async () => { await f?.close(); await rm(root, { recursive: true, force: true }); });
  f = await recordingFixture(root, options); await f.recording(true); return f;
}
const receipts = f => f.runtime.session.receipts.list();
const message = (id = randomUUID(), text = exact) => ({ id, author: { role: 'user' },
  content: { content_type: 'text', parts: [text] } });

async function queuedFixture(t, options = {}) {
  const save = EngineStateStore.prototype.save;
  let release, entered, held = false;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  // Release before fixture cleanup, including on assertion failure.
  t.after(() => { EngineStateStore.prototype.save = save; release(); });
  const f = await fixture(t, options), engine = f.runtime.engine, admissions = [];
  const observe = engine.observe.bind(engine);
  engine.observe = (input, options) => {
    const result = observe(input, options);
    admissions.push({ observation: structuredClone(input), options: { ...options } });
    return result;
  };
  EngineStateStore.prototype.save = async function (state) {
    if (this.vault === f.runtime.session.vault && !held) { held = true; entered(); await gate; }
    return save.call(this, state);
  };
  const command = f.command('SET_RECORDING', { enabled: true });
  command.catch(() => {});
  await started;
  return { f, admissions, async resume() { EngineStateStore.prototype.save = save; release(); await command; } };
}

async function route(f, url) {
  f.navigate(17, url);
  await until(async () => (await f.refresh()).policy?.expectedUrl === url);
}

test('validated request saves exact text with no DOM Send, composer or Send button', async t => {
  const f = await fixture(t), page = f.pages.get(17);
  page.editors = []; page.buttons = []; page.attachments = true;
  page.document.visibilityState = 'hidden';
  await page.request(exact);
  await until(() => receipts(f).length === 1);
  const preview = f.runtime.session.receipts.prepare({ ids: [receipts(f)[0].id] });
  assert.equal(preview.texts[0].preview, exact);
  const assertions = verifyPortable(f.runtime.session.receipts.export(preview.previewId)).records.flatMap(record => record.localAssertions);
  assert.ok(assertions.some(value => value.inputMethod === 'provider-request' && /validated provider request/.test(value.claim)));
  assert.equal(page.requests.length, 1); assert.equal(f.userSends, 0); assert.equal(f.prevention, 0);
});

test('same provider identity deduplicates across retries, reload and tabs; distinct identities remain separate', async t => {
  const diagnostics = new LocalDiagnostics(), f = await fixture(t, { diagnostics });
  let page = f.pages.get(17);
  const original = message('stable-provider-message'), payload = { messages: [original] };
  await page.request(exact, payload); await until(() => receipts(f).length === 1);
  await page.request(exact, payload); await until(() => f.results.filter(v => v.result.deduplicated).length === 1);
  page = await f.reload();
  await page.request(exact, payload); await until(() => f.results.filter(v => v.result.deduplicated).length === 2);
  await f.addTab(19, { url: 'https://chatgpt.com/c/fixture-17', destination: 'conversation:fixture-17' });
  await f.pages.get(19).request(exact, payload); await until(() => f.results.filter(v => v.result.deduplicated).length === 3);
  assert.equal(receipts(f).length, 1); assert.equal(f.runtime.session.status().versions[0].source.tabId, 17);
  await page.request(exact, { messages: [message('distinct-provider-message')] });
  await until(() => receipts(f).length === 2); await f.runtime.engine.drain();
  assert.equal(f.anchorCalls, 2);
  assert.ok(diagnostics.preview().report.events.some(v => v.code === 'REQUEST_DEDUPLICATED'));
  // Reopening the encrypted vault rebuilds the index from signed observations.
  const prior = f.deliveries[0].observation;
  await f.restart();
  const retried = f.runtime.session.observeNormal({ ...prior, text: exact, eventId: randomUUID() });
  assert.equal(retried.id, prior.eventId); assert.equal(receipts(f).length, 2);
});

test('a reused identity with changed bytes is rejected without poisoning a subsequent valid capture', async t => {
  const f = await fixture(t), page = f.pages.get(17);
  await page.request(exact, { messages: [message('immutable-id')] }); await until(() => receipts(f).length === 1);
  await page.request('changed', { messages: [message('immutable-id', 'changed')] });
  await until(() => f.results.some(v => v.result.state === 'RECORDING_UNAVAILABLE'));
  await page.request(exact, { messages: [message('new-valid-id')] }); await until(() => receipts(f).length === 2);
  assert.equal(f.runtime.engine.state().available, true);
});

test('duplicate relay deliveries cannot overwrite a saved outcome or create another receipt', async t => {
  const f = await fixture(t), page = f.pages.get(17), held = page.holdTransport('request');
  await page.request(exact); await until(() => held.messages.length === 1);
  held.release(); await until(() => page.feedback === 'Attestamp · Prompt saved');
  page.transportMessage(held.messages[0].data);
  page.transportMessage({ ...held.messages[0].data, text: 'CONFLICTING_RELAY_CANARY' });
  await tick(); await tick();
  assert.equal(page.feedback, 'Attestamp · Prompt saved'); assert.equal(receipts(f).length, 1); assert.equal(f.deliveries.length, 1);
});

test('first New Chat request requires no DOM input even when route policy precedes both MAIN messages', async t => {
  const f = await fixture(t, { newChat: true, fixedSenderURL: true }), page = f.pages.get(17);
  const matched = page.holdTransport('matched'), request = page.holdTransport('request');
  await page.request(exact); await until(() => request.messages.length === 1);
  f.navigate(17, 'https://chatgpt.com/c/first-request');
  await until(async () => (await f.refresh()).policy?.destination === 'conversation:first-request');
  matched.release(); request.release(); await until(() => receipts(f).length === 1);
  assert.equal(f.sources[0].destination, 'new-chat'); assert.equal(f.userSends, 0);
  await page.request(exact); await until(() => receipts(f).length === 2);
  assert.equal(f.sources[1].destination, 'conversation:first-request');
});

test('late policy renewal cannot discard a supported request under unchanged consent', async t => {
  let time = 0;
  const f = await fixture(t, { pageClock: { setTimeout, clearTimeout, performance: { now: () => time } } });
  const page = f.pages.get(17);
  time = 4000;
  await page.request(exact); await until(() => receipts(f).length === 1);
  assert.equal(page.requests.length, 1); assert.equal(f.deliveries.length, 1);
  assert.equal(f.sources[0].destination, 'conversation:fixture-17');
});

test('late renewal cannot retain consent when OFF/ON notifications have not reached the page', async t => {
  let time = 0; const rejected = [];
  const f = await fixture(t, { pageClock: { setTimeout, clearTimeout, performance: { now: () => time } },
    afterCapture: async (_message, result) => rejected.push(result) });
  const page = f.pages.get(17), send = page.send;
  page.send = message => message.kind === 'PAP_CAPTURE_POLICY' ? Promise.resolve(true) : send(message);
  await f.command('SET_RECORDING', { enabled: false }); await f.command('SET_RECORDING', { enabled: true });
  time = 4000;
  await page.request(exact); await until(() => rejected.length === 2);
  assert.ok(rejected.every(result => result.state === 'RECORDING_UNAVAILABLE'));
  assert.equal(receipts(f).length, 0); assert.equal(f.anchorCalls, 0); assert.equal(page.requests.length, 1);
});

test('a failed status poll reports unavailable without discarding an engine-authorized request', async t => {
  const f = await fixture(t), page = f.pages.get(17), message = f.worker.message;
  f.worker.message = (input, sender) => {
    if (input.kind === 'PAP_CAPTURE_STATUS') throw Error('SYNTHETIC_STATUS_TIMEOUT');
    return message(input, sender);
  };
  await until(() => page.feedback === 'Attestamp · Recording unavailable');
  await page.request(exact); await until(() => receipts(f).length === 1);
  f.worker.message = message;
  assert.equal(f.sources[0].destination, 'conversation:fixture-17'); assert.equal(page.requests.length, 1);
});

test('a matched binding copied from another tab cannot admit its request', async t => {
  const f = await fixture(t), page = f.pages.get(17), foreign = f.pages.get(18);
  const matched = page.holdTransport('matched'), request = page.holdTransport('request');
  await page.request(exact); await until(() => request.messages.length === 1);
  foreign.transportMessage(matched.messages[0].data); foreign.transportMessage(request.messages[0].data);
  await tick(); await tick(); assert.equal(f.deliveries.length, 0);
  matched.release(); request.release(); await until(() => receipts(f).length === 1);
  assert.equal(f.sources[0].tabId, 17);
});

for (const fixedSenderURL of [false, true]) test(`admitted request retains its source across same-document navigation (creation URL=${fixedSenderURL})`, async t => {
  const f = await fixture(t, { fixedSenderURL }), page = f.pages.get(17), held = page.holdTransport('request');
  await page.request(exact); await until(() => held.messages.length === 1);
  f.navigate(17, 'https://chatgpt.com/c/other');
  await until(async () => (await f.refresh()).policy?.destination === 'conversation:other');
  held.release(); await until(() => receipts(f).length === 1);
  assert.equal(f.sources[0].destination, 'conversation:fixture-17');
  await page.request('NEXT_ROUTE'); await until(() => receipts(f).length === 2);
  assert.equal(f.sources[1].destination, 'conversation:other');
  assert.equal(page.requests.length, 2);
});

for (const fixedSenderURL of [false, true]) for (const destination of ['unchanged', 'conversation', 'New Chat', 'two routes']) {
  test(`engine-queued request and IPC retry retain their source across ${destination} (creation URL=${fixedSenderURL})`, async t => {
    const response = new Response('UNCHANGED_PROVIDER_RESPONSE'), provider = Promise.resolve(response);
    const q = await queuedFixture(t, { fixedSenderURL, fetchResponse: () => provider });
    const { f, admissions } = q, page = f.pages.get(17);
    assert.equal(page.request(exact), provider); assert.equal(await provider, response);
    assert.equal(await response.text(), 'UNCHANGED_PROVIDER_RESPONSE');
    // Wait for the real worker timeout and the relay's single IPC retry. Both
    // deliveries must reach the real engine while A is still the active source.
    await until(() => admissions.length === 2);
    assert.equal(f.deliveries.length, 2); assert.deepEqual(admissions[0], admissions[1]);
    assert.equal(admissions[0].options.requestContinuation, false);
    assert.equal(admissions[0].options.newChatContinuation, false);
    assert.equal(receipts(f).length, 0); assert.equal(f.anchorCalls, 0);
    if (destination !== 'unchanged') await route(f, destination === 'New Chat'
      ? 'https://chatgpt.com/' : 'https://chatgpt.com/c/queued-next');
    if (destination === 'two routes') await route(f, 'https://chatgpt.com/c/queued-third');
    await q.resume(); await f.runtime.engine.drain();
    await until(() => f.results.length === 2);
    assert.deepEqual(f.results.map(value => value.result.state), ['PROMPT_SAVED', 'PROMPT_SAVED']);
    await until(() => page.feedback === 'Attestamp · Prompt saved');
    assert.equal(receipts(f).length, 1); assert.equal(f.anchorCalls, 1);
    const version = f.runtime.session.status().versions[0];
    assert.deepEqual(version.source, admissions[0].observation.source);
    assert.equal(version.source.destination, 'conversation:fixture-17');
    const preview = f.runtime.session.receipts.prepare({ ids: [receipts(f)[0].id] });
    assert.equal(preview.texts[0].preview, exact);
    assert.equal(page.requests.length, 1); assert.equal(f.userSends, 0);
    assert.equal(f.prevention, 0); assert.equal(f.releases.length, 0);
  });
}

test('engine queue preserves first-New-Chat and overlapping tab attribution', async t => {
  const q = await queuedFixture(t, { newChat: true, fixedSenderURL: true }), { f, admissions } = q;
  await f.pages.get(17).request(exact);
  await f.pages.get(18).request('INDEPENDENT_TAB');
  await until(() => admissions.length === 2);
  await route(f, 'https://chatgpt.com/c/queued-first');
  await q.resume(); await f.runtime.engine.drain();
  await until(() => f.results.length === 2);
  assert.ok(f.results.every(value => value.result.state === 'PROMPT_SAVED'));
  const versions = f.runtime.session.status().versions;
  assert.equal(versions.length, 2); assert.equal(f.anchorCalls, 2);
  for (const { observation } of admissions) {
    assert.deepEqual(versions.find(value => value.id === observation.eventId).source, observation.source);
  }
  assert.equal(versions.find(value => value.source.tabId === 17).source.destination, 'new-chat');
  assert.equal(versions.find(value => value.source.tabId === 18).source.destination, 'conversation:fixture-18');
  assert.equal(f.pages.get(17).requests.length, 1); assert.equal(f.pages.get(18).requests.length, 1);
});

for (const cutoff of ['OFF', 'OFF/ON', 'reload', 'replacement document', 'window change', 'tab removal',
  'unsupported route', 'permission loss', 'disconnect']) {
  test(`engine-queued active admission cannot cross ${cutoff}`, async t => {
    const q = await queuedFixture(t), { f, admissions } = q, controls = [];
    // Consent commands remain ordered ahead of capture even though their
    // metadata cannot finish until the held no-op save is released.
    if (cutoff.startsWith('OFF')) controls.push(f.command('SET_RECORDING', { enabled: false }));
    if (cutoff === 'OFF/ON') controls.push(f.command('SET_RECORDING', {
      enabled: true, expectedRevision: f.runtime.engine.state().revision + 1,
    }));
    await f.pages.get(17).request(exact);
    await until(() => admissions.length === 1);
    assert.equal(admissions[0].options.requestContinuation, false);
    await route(f, 'https://chatgpt.com/c/queued-revoked');
    if (cutoff === 'reload') await f.reload();
    if (cutoff === 'replacement document') {
      f.pages.get(17).documentId = 'replacement-queued-document';
      await until(async () => {
        const { policy } = await f.refresh();
        return policy && policy.tabEpoch !== admissions[0].observation.source.tabEpoch;
      });
    }
    if (cutoff === 'window change') {
      f.inventory.get(17).windowId++;
      f.worker.chrome.tabs.onActivated.emit();
      await until(() => f.runtime.adapter.scopes().find(value => value.tabId === 17)?.windowId === 2);
    }
    if (cutoff === 'tab removal') { f.inventory.delete(17); f.worker.chrome.tabs.onRemoved.emit(17); }
    if (cutoff === 'unsupported route') f.navigate(17, 'https://chatgpt.com/settings');
    if (cutoff === 'permission loss') f.revokePermission();
    if (cutoff === 'disconnect') f.disconnect();
    if (['tab removal', 'unsupported route', 'permission loss', 'disconnect'].includes(cutoff)) {
      await until(() => !f.runtime.adapter.scopes().some(value => value.tabId === 17));
    }
    await q.resume(); await Promise.all(controls); await f.runtime.engine.drain();
    assert.equal(receipts(f).length, 0); assert.equal(f.anchorCalls, 0);
    assert.equal(f.runtime.engine.state().recording, cutoff !== 'OFF');
    assert.ok(f.results.every(value => value.result.state === 'RECORDING_UNAVAILABLE'));
  });
}

test('OFF ordered after an engine-queued admission preserves that earlier request only', async t => {
  const q = await queuedFixture(t), { f, admissions } = q;
  await f.pages.get(17).request(exact); await until(() => admissions.length === 1);
  const off = f.command('SET_RECORDING', { enabled: false, expectedRevision: f.runtime.engine.state().revision + 1 });
  await route(f, 'https://chatgpt.com/c/queued-before-off');
  await q.resume(); await off; await f.runtime.engine.drain();
  assert.equal(receipts(f).length, 1); assert.equal(f.anchorCalls, 1);
  assert.equal(f.runtime.engine.state().recording, false);
  assert.equal(f.runtime.session.status().versions[0].source.destination, 'conversation:fixture-17');
  await f.pages.get(17).request('AFTER_OFF'); await tick(); await f.runtime.engine.drain();
  assert.equal(receipts(f).length, 1); assert.equal(f.pages.get(17).requests.length, 2);
});

test('an unadmitted retired token cannot borrow a queued active admission', async t => {
  const q = await queuedFixture(t), { f, admissions } = q;
  await f.pages.get(17).request(exact); await until(() => admissions.length === 1);
  await route(f, 'https://chatgpt.com/c/queued-other');
  const forged = { ...admissions[0].observation, eventId: randomUUID(),
    request: { ...admissions[0].observation.request, messageId: 'unadmitted-message' } };
  const rejected = assert.rejects(f.runtime.engine.observe(forged), /CAPTURE_NOT_ENABLED/);
  await q.resume(); await rejected; await f.runtime.engine.drain();
  assert.equal(receipts(f).length, 1); assert.equal(f.anchorCalls, 1);
  assert.equal(f.runtime.session.status().versions[0].id, admissions[0].observation.eventId);
});

test('engine-queued admission expires with its retired binding', async t => {
  const q = await queuedFixture(t), { f, admissions } = q;
  await f.pages.get(17).request(exact); await until(() => admissions.length === 1);
  await route(f, 'https://chatgpt.com/c/queued-expired');
  const expired = performance.now() + 12001;
  t.mock.method(performance, 'now', () => expired);
  await q.resume(); await f.runtime.engine.drain();
  await until(() => f.results.length === 1);
  assert.equal(f.results[0].result.state, 'RECORDING_UNAVAILABLE');
  assert.equal(receipts(f).length, 0); assert.equal(f.anchorCalls, 0);
});

test('a retired binding cannot admit another event or authenticate an unobserved payload', async t => {
  const f = await fixture(t), page = f.pages.get(17), policy = (await f.refresh()).policy;
  const held = page.holdTransport('request');
  await page.request(exact); await until(() => held.messages.length === 1);
  const request = held.messages[0].data;
  f.navigate(17, 'https://chatgpt.com/c/other');
  await until(async () => (await f.refresh()).policy?.destination === 'conversation:other');
  for (const overrides of [{ eventId: randomUUID() }, { text: 'UNOBSERVED_TEXT' }]) {
    const result = await f.worker.message({ kind: 'PAP_CAPTURE', pageContract: CHATGPT_PAGE_CONTRACT,
      token: policy.token, eventId: request.id, observationKind: 'request-observed', text: exact,
      inputMethod: 'provider-request', request: request.request, ...overrides }, page.captureSender());
    assert.equal(result.state, 'RECORDING_UNAVAILABLE');
  }
  assert.equal(f.deliveries.length, 0);
  held.release(); await until(() => receipts(f).length === 1);
});

test('revocation while a retired request challenge is in flight rejects its previously valid proof', async t => {
  const f = await fixture(t), page = f.pages.get(17), held = page.holdTransport('request');
  await page.request(exact); await until(() => held.messages.length === 1);
  f.navigate(17, 'https://chatgpt.com/c/other');
  await until(async () => (await f.refresh()).policy?.destination === 'conversation:other');
  let release, confirmed = false;
  const gate = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const send = page.send;
  page.send = async message => {
    const result = await send(message);
    if (message.kind === 'PAP_CONFIRM_REQUEST') { confirmed = result.confirmed; await gate; }
    return result;
  };
  held.release(); await until(() => confirmed);
  await f.recording(false); await f.recording(true); release();
  await tick(); await tick(); await f.runtime.engine.drain();
  assert.equal(receipts(f).length, 0); assert.equal(f.deliveries.length, 0); assert.equal(f.anchorCalls, 0);
});

test('a conversation binding whose matched event arrives only after navigation cannot admit new work', async t => {
  const f = await fixture(t), page = f.pages.get(17), matched = page.holdTransport('matched'), request = page.holdTransport('request');
  await page.request(exact); await until(() => request.messages.length === 1);
  f.navigate(17, 'https://chatgpt.com/c/other');
  await until(async () => (await f.refresh()).policy?.destination === 'conversation:other');
  matched.release(); request.release(); await tick(); await tick();
  assert.equal(receipts(f).length, 0); assert.equal(f.deliveries.length, 0);
  await page.request(exact); await until(() => receipts(f).length === 1);
  assert.equal(f.sources[0].destination, 'conversation:other');
});

for (const cutoff of ['OFF', 'OFF/ON', 'reload', 'other tab', 'permission loss', 'disconnect']) {
  test(`queued request without DOM input cannot cross ${cutoff}`, async t => {
    let time = 0;
    const f = await fixture(t, { pageClock: { setTimeout, clearTimeout, performance: { now: () => time } } });
    const page = f.pages.get(17), held = page.holdTransport('request');
    time = 4000;
    await page.request(exact); await until(() => held.messages.length === 1);
    f.navigate(17, 'https://chatgpt.com/c/other');
    await until(async () => (await f.refresh()).policy?.destination === 'conversation:other');
    if (cutoff.startsWith('OFF')) await f.recording(false);
    if (cutoff === 'OFF/ON') await f.recording(true);
    if (cutoff === 'reload') await f.reload();
    if (cutoff === 'other tab') {
      f.pages.get(18).transportMessage(held.messages[0].data); page.event('pagehide');
    }
    if (cutoff === 'permission loss') { f.revokePermission(); await until(() => !f.runtime.adapter.scopes().length); }
    if (cutoff === 'disconnect') f.disconnect();
    held.release(); await tick(); await tick(); await f.runtime.engine.drain();
    assert.equal(receipts(f).length, 0); assert.equal(f.anchorCalls, 0); assert.equal(page.requests.length, 1);
  });
}

test('diagnostics distinguish matched, extraction rejection, invalid relay, dispatch and deduplication without content', async t => {
  const diagnostics = new LocalDiagnostics(), f = await fixture(t, { diagnostics }), page = f.pages.get(17);
  await page.request(exact, { action: 'regenerate' });
  await until(() => page.feedback === 'Attestamp · Recording gap');
  const held = page.holdTransport('request');
  await page.request(exact); await until(() => held.messages.length === 1);
  page.transportMessage({ ...held.messages[0].data, text: '\ud800' }); await tick();
  held.release(); await until(() => receipts(f).length === 1);
  const payload = JSON.parse(page.requests.at(-1)[1].body);
  await page.request(exact, payload); await until(() => f.results.some(v => v.result.deduplicated));
  const events = diagnostics.preview().report.events, codes = new Set(events.map(v => v.code));
  for (const code of ['REQUEST_MATCHED', 'REQUEST_EXTRACTOR_REJECTED', 'REQUEST_MESSAGE_REJECTED',
    'DURABLE_SAVE_DISPATCHED', 'REQUEST_DEDUPLICATED']) assert.ok(codes.has(code), code);
  assert.doesNotMatch(JSON.stringify(events), /REQUEST_AUTHORITY|chatgpt\.com|fixture-17|backend-api/);
  const pageCodes = f.port.messages.filter(v => v.kind === 'PAP_CAPTURE_DIAGNOSTIC');
  assert.equal(pageCodes.length, new Set(pageCodes.map(v => v.code)).size);
});

test('validated request after the old intent deadline remains authoritative', async t => {
  const f = await fixture(t), page = f.pages.get(17);
  f.send(exact, { request: false });
  await page.fetch('/backend-api/f/conversation/prepare', { method: 'POST', body: '{}' });
  await new Promise(resolve => setTimeout(resolve, 1600));
  await page.request(exact);
  await until(() => receipts(f).length === 1);
  assert.equal(page.requests.length, 2); assert.equal(f.deliveries.length, 1);
});

test('parent-linked history plus one new user message extracts only the new exact text', async t => {
  const f = await fixture(t), page = f.pages.get(17);
  f.send(exact, { request: false });
  await page.request(exact, { parent_message_id: 'previous-assistant', messages: [
    message('previous-user', 'PRIVATE_HISTORY_CANARY'),
    { id: 'previous-assistant', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['PRIVATE_ANSWER_CANARY'] } },
    message('new-user'),
  ] });
  await until(() => receipts(f).length === 1);
  const preview = f.runtime.session.receipts.prepare({ ids: [receipts(f)[0].id] });
  assert.equal(preview.texts[0].preview, exact);
  assert.doesNotMatch(f.runtime.session.receipts.export(preview.previewId).toString(), /PRIVATE_HISTORY_CANARY|PRIVATE_ANSWER_CANARY/);
});
