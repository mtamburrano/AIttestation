import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { matchChatGPT, extractChatGPT } from '../spikes/browser/chatgpt/transport/chatgpt.mjs';
import { installFetchObserver, snapshotRequest } from '../spikes/browser/chatgpt/transport/fetch-observer.mjs';
import { validateRequest } from '../spikes/recipient/normal-observation.mjs';
import { verifyPortable } from '../spikes/recipient/portable.mjs';
import { restrictFixtureNetwork } from '../spikes/development/fixture-network.mjs';
import { LocalDiagnostics } from '../spikes/diagnostics/local.mjs';
import { recordingFixture, until } from './recording-fixture.mjs';

const path = '/backend-api/f/steer_turn', url = `https://chatgpt.com${path}`;
const wire = await readFile(new URL('./fixtures/chatgpt-wire/steer-turn.json', import.meta.url), 'utf8');
const captured = JSON.parse(wire), exact = '\uFEFF  e\u0301\r\n☕\t';
const extract = body => extractChatGPT(JSON.stringify(body), path);
const bodyFor = (id, text = exact) => {
  const body = structuredClone(captured);
  body.messages[1].id = id; body.messages[1].content.parts = [text];
  return body;
};
async function fixture(t, options = {}) {
  const root = await mkdtemp('/private/tmp/attestamp-steering-test-');
  const network = restrictFixtureNetwork(root); let f;
  t.after(async () => { await f?.close(); network.restore(); await rm(root, { recursive: true, force: true }); });
  f = await recordingFixture(root, { network, ...options }); await f.recording(true);
  return f;
}

test('steering admits only the owner-observed POST endpoint at every request validation boundary', () => {
  assert.equal(matchChatGPT(new URL(url), 'POST'), true);
  assert.deepEqual(extractChatGPT(wire, path), { text: 'Wire fixture: steer-turn.', request: {
    profile: 'chatgpt-new-user-text/3', path, messageId: captured.messages[1].id, conversationId: captured.conversation_id,
  } });
  const request = extract(captured).request;
  validateRequest(request);
  for (const endpoint of ['/backend-api/steer_turn', '/backend-api/f/steer_turn/', '/backend-api/f/steer_turn/continue',
    '/backend-api/f/steer_turn_extra', '/backend-api/f/conversation/steer_turn', '/backend-api/f/STEER_TURN']) {
    assert.equal(snapshotRequest([endpoint, { method: 'POST', body: wire }], url), null);
    assert.throws(() => extractChatGPT(wire, endpoint), /REQUEST_OPERATION_UNSUPPORTED/);
    assert.throws(() => validateRequest({ ...request, path: endpoint }), /INVALID_CAPTURE_OBSERVATION/);
  }
  for (const address of [url + '?action=next', url + '#next', url.replace('https:', 'http:'),
    url.replace('chatgpt.com', 'chatgpt.com.example.org'), url.replace('chatgpt.com', 'user:secret@chatgpt.com')]) {
    assert.equal(matchChatGPT(new URL(address), 'POST'), false);
  }
  for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) assert.equal(matchChatGPT(new URL(url), method), false);
});

test('steering selects exact latest explicit user text and excludes known non-Send operations', () => {
  const body = bodyFor('steering-exact');
  body.messages.unshift({ author: { role: 'user' }, id: 'older', content: { parts: ['PRIVATE_OLD_TEXT'] } });
  body.messages.push({ author: { role: 'assistant' }, status: 'in_progress', content: { parts: ['PRIVATE_ANSWER'] } });
  body.messages[2].metadata.future = { chime_version: 'SYNTHETIC', turn_exchange_id: 'SYNTHETIC' };
  body.model = 'SYNTHETIC_MODEL';
  assert.deepEqual(Buffer.from(extract(body).text), Buffer.from(exact));
  assert.equal(extract(body).request.messageId, 'steering-exact');
  assert.equal(extract(body).request.conversationId, captured.conversation_id);
  assert.doesNotMatch(JSON.stringify(extract(body)), /PRIVATE_|SYNTHETIC/);
  for (const action of ['edit', 'regenerate', 'resubmit', 'continue', 'variant']) {
    for (const where of ['body', 'message', 'metadata']) {
      const value = structuredClone(captured);
      (where === 'body' ? value : where === 'message' ? value.messages[1] : value.messages[1].metadata).action = action;
      assert.throws(() => extract(value), /REQUEST_OPERATION_UNSUPPORTED/);
    }
  }
  for (const flag of ['is_edit', 'is_regenerate', 'is_resubmit']) {
    for (const where of ['body', 'message', 'metadata']) {
      const value = structuredClone(captured);
      (where === 'body' ? value : where === 'message' ? value.messages[1] : value.messages[1].metadata)[flag] = true;
      assert.throws(() => extract(value), /REQUEST_OPERATION_UNSUPPORTED/);
    }
  }
  assert.throws(() => extract({ ...captured, parent_message_id: captured.messages[1].id }), /REQUEST_OPERATION_UNSUPPORTED/);
  assert.throws(() => extract({ ...captured, messages: [...captured.messages, captured.messages[1]] }), /REQUEST_IDENTITY_MISSING/);
});

test('steering observation preserves receiver, arguments, promise and original response without awaiting it', async t => {
  let respond;
  const promise = new Promise(resolve => { respond = resolve; }), events = [], calls = [];
  const target = { location: new URL('https://chatgpt.com/c/fixture'), fetch(...args) { calls.push({ self: this, args }); return promise; } };
  const observer = installFetchObserver(target, { emit: event => events.push(event) });
  t.after(() => { observer.stop(); respond(new Response('cleanup')); });
  observer.arm(randomUUID(), captured.conversation_id);
  const receiver = {}, request = new Request(url, { method: 'POST', body: wire });
  assert.equal(target.fetch.call(receiver, request), promise);
  assert.equal(calls[0].self, receiver); assert.deepEqual(calls[0].args, [request]);
  assert.equal(request.bodyUsed, false);
  await until(() => events.some(value => value.kind === 'request'));
  assert.equal(events.filter(value => value.kind === 'request').length, 1);
  assert.equal(events.some(value => value.kind === 'acknowledgement'), false);
  const response = new Response('UNMODIFIED_PROVIDER_RESPONSE'); respond(response);
  assert.equal(await promise, response); assert.equal(await response.text(), 'UNMODIFIED_PROVIDER_RESPONSE');
  assert.equal(await request.text(), wire); assert.equal(calls.length, 1);
});

test('steering saves while an assistant response stays open, deduplicates and preserves multitab attribution', async t => {
  const diagnostics = new LocalDiagnostics(), waiting = []; let stream, assistantFinished = false;
  const assistant = new Response(new ReadableStream({ start(controller) {
    stream = controller;
    controller.enqueue(new TextEncoder().encode('data: {"message":{"id":"assistant-start","author":{"role":"assistant"},"status":"in_progress","content":{"content_type":"text","parts":[""]}},"conversation_id":"fixture-17"}\n\n'));
  } }), { headers: { 'content-type': 'text/event-stream' } });
  t.after(() => { stream.close(); for (const resolve of waiting) resolve(new Response('SYNTHETIC_STEERING_RESPONSE')); });
  const f = await fixture(t, { diagnostics, fetchResponse: resource => String(resource).endsWith('/steer_turn')
    ? new Promise(resolve => waiting.push(resolve)) : Promise.resolve(assistant) });
  const page = f.pages.get(17), other = f.pages.get(18), receipts = () => f.runtime.session.receipts.list();
  const response = await page.request('ORDINARY_PROMPT');
  const finished = response.text().then(() => { assistantFinished = true; });
  await until(() => receipts().length === 1);
  f.send(exact, { request: false });
  const send = (target, body) => target.fetch(url, { method: 'POST', body: JSON.stringify(body) });
  send(page, bodyFor('steering-one'));
  await until(() => receipts().length === 2 && page.feedback === 'Attestamp · Prompt saved');
  await delay(1600);
  assert.equal(assistantFinished, false); assert.equal(waiting.length, 1);
  assert.equal(page.feedback, 'Attestamp · Prompt saved');
  assert.ok(!diagnostics.preview().report.events.some(value => value.code === 'REQUEST_NOT_OBSERVED'));
  const saved = f.runtime.session.status().versions[1];
  assert.deepEqual(saved.request, extract(bodyFor('steering-one')).request);
  assert.equal(saved.source.destination, 'conversation:fixture-17');
  const preview = f.runtime.session.receipts.prepare({ ids: [saved.descriptorId] });
  assert.deepEqual(Buffer.from(preview.texts[0].preview), Buffer.from(exact));
  const verified = verifyPortable(f.runtime.session.receipts.export(preview.previewId));
  assert.ok(verified.records.flatMap(value => value.localAssertions).some(value => value.request?.path === path
    && value.request.messageId === saved.request.messageId && value.providerReceipt === 'UNKNOWN'));
  send(page, bodyFor('steering-one'));
  await until(() => f.results.some(value => value.result.deduplicated));
  assert.equal(receipts().length, 2);
  send(other, bodyFor('steering-two'));
  await until(() => receipts().length === 3 && other.feedback === 'Attestamp · Prompt saved');
  assert.equal(f.runtime.session.status().versions[2].source.destination, 'conversation:fixture-18');
  assert.equal(f.runtime.session.status().versions[2].source.windowId, 2);
  send(page, bodyFor('steering-one', 'CONFLICTING_TEXT'));
  await until(() => page.feedback === 'Attestamp · Recording gap');
  assert.equal(receipts().length, 3);
  assert.equal(page.requests.length, 4); assert.equal(other.requests.length, 1);
  assert.equal(f.prevention, 0); assert.equal(f.releases.length, 0);
  assert.doesNotMatch(JSON.stringify(diagnostics.preview().report), /steer_turn|steering-one|CONFLICTING_TEXT|PRIVATE_/);
  stream.close(); stream = { close() {} }; await finished;
});

test('steering held across OFF/ON cannot acquire new authority and OFF never suppresses provider requests', async t => {
  const f = await fixture(t, { tabs: 1 }), page = f.pages.get(17);
  const held = page.holdTransport('request');
  await page.fetch(url, { method: 'POST', body: wire });
  await until(() => held.messages.length === 1);
  await f.recording(false); await f.recording(true);
  held.release(); await delay(100);
  assert.equal(f.runtime.session.receipts.list().length, 0);
  await page.fetch(url, { method: 'POST', body: JSON.stringify(bodyFor('fresh-after-on')) });
  await until(() => f.runtime.session.receipts.list().length === 1);
  await f.recording(false);
  await page.fetch(url, { method: 'POST', body: JSON.stringify(bodyFor('off-send')) });
  await delay(100);
  assert.equal(f.runtime.session.receipts.list().length, 1);
  assert.equal(page.requests.length, 3); assert.equal(f.prevention, 0); assert.equal(f.releases.length, 0);
});
