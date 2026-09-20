import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { installFetchObserver, snapshotRequest, observeAcknowledgement } from '../spikes/browser/chatgpt/transport/fetch-observer.mjs';
import { matchChatGPT, extractChatGPT } from '../spikes/browser/chatgpt/transport/chatgpt.mjs';
import { MAX_REQUEST_BYTES, MAX_PROMPT_BYTES, ACK_BYTES, readPrefix } from '../spikes/browser/chatgpt/transport/bounded.mjs';
import { assertObserverBundle } from '../spikes/browser/chatgpt/build-observer.mjs';

const url = 'https://chatgpt.com/backend-api/f/conversation';
const body = (text = ' \uFEFFe\u0301\r\n☕  ', patch = {}) => JSON.stringify({ action: 'next',
  messages: [{ id: 'user-1', author: { role: 'user' }, content: { content_type: 'text', parts: [text] } }],
  parent_message_id: 'parent-1', conversation_id: 'conversation-1', ...patch });
const response = value => new Response(`data: ${JSON.stringify(value)}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
const ack = { type: 'stream_handoff', conversation_id: 'conversation-1', turn_exchange_id: 'turn-1' };
const tick = () => new Promise(setImmediate);
function fixture(t, original = () => Promise.resolve(new Response('provider'))) {
  const events = [], calls = [];
  const target = { location: new URL('https://chatgpt.com/c/conversation-1'), fetch(...args) { calls.push({ self: this, args }); return original(...args); } };
  const observer = installFetchObserver(target, { emit: value => events.push(value) }); t.after(() => observer.stop());
  observer.qualify(randomUUID(), 'conversation-1');
  return { target, observer, events, calls };
}

test('allowlist selects origin, POST, operation and one new user text; exclusions leave a qualifier usable', async t => {
  const f = fixture(t);
  for (const resource of ['/backend-api/conversation/prepare', '/backend-api/conversation/history', '/backend-anon/conversation',
    'https://example.org/backend-api/conversation', '/backend-api/files', '/backend-api/f/conversation/resume']) {
    await f.target.fetch(resource, { method: 'POST', body: body() });
  }
  for (const patch of [{ action: 'variant' }, { action: 'continue' }, { action: 'edit' }, { action: 'regenerate' },
    { conversation_id: 'other' }, { attachments: ['file'] }, { voice: true }, { is_edit: true }, { is_resubmit: true },
    { messages: [] }, { messages: [JSON.parse(body()).messages[0], JSON.parse(body()).messages[0]] },
    { messages: [{ id: 'user-1', author: { role: 'user' }, content: { content_type: 'multimodal_text', parts: ['text', {}] } }] }]) {
    await f.target.fetch(url, { method: 'POST', body: body('excluded', patch) });
  }
  await f.target.fetch(url, { method: 'GET' });
  await tick(); assert.equal(f.events.filter(e => e.kind === 'request').length, 0);
  await f.target.fetch(url, { method: 'POST', body: body() }); await tick();
  assert.equal(f.events.filter(e => e.kind === 'request').length, 1);
  await f.target.fetch(url, { method: 'POST', body: body() }); await tick();
  assert.equal(f.events.filter(e => e.kind === 'request').length, 1);
  for (const endpoint of ['/backend-api/conversation', '/backend-api/f/conversation']) assert.ok(matchChatGPT(new URL(endpoint, url), 'POST'));
  assert.equal(matchChatGPT(new URL(url + '?unknown=true'), 'POST'), false);
});

test('exact Unicode, BOM, whitespace and escaped maximum survive; malformed UTF-8, duplicate keys and oversize gap without truncation', () => {
  for (const text of ['\uFEFF', '  \r\n\t', 'e\u0301😀\n', '\u0000'.repeat(MAX_PROMPT_BYTES), 'x'.repeat(MAX_PROMPT_BYTES)]) {
    assert.equal(extractChatGPT(body(text), '/backend-api/conversation').text, text);
  }
  for (const text of ['x'.repeat(MAX_PROMPT_BYTES + 1), '\ud800']) assert.throws(() => extractChatGPT(body(text), '/backend-api/conversation'));
  assert.throws(() => extractChatGPT(body().replace('"action":"next"', '"action":"variant","action":"next"'), '/backend-api/conversation'));
  assert.throws(() => extractChatGPT(' '.repeat(MAX_REQUEST_BYTES + 1), '/backend-api/conversation'));
  assert.throws(() => snapshotRequest([url, { method: 'POST', body: new Uint8Array([0xff]) }], url));
});

test('string, URL, Request and init overrides snapshot without consuming the provider body', async () => {
  for (const input of [url, new URL(url), new Request(url, { method: 'POST', body: body('original') })]) {
    const snapshot = snapshotRequest([input, { method: 'POST', body: body('override') }], url);
    assert.equal(extractChatGPT(await snapshot.body, snapshot.path).text, 'override');
    if (input instanceof Request) assert.equal(await input.text(), body('original'));
  }
  const input = new Request(url, { method: 'POST', body: body() });
  const snapshot = snapshotRequest([input], url);
  assert.equal(input.bodyUsed, false);
  assert.equal(await snapshot.body, body()); assert.equal(await input.text(), body());
  const changedMethod = new Request(url, { method: 'PUT', body: body() });
  assert.equal(snapshotRequest([changedMethod], url), null);
  const override = snapshotRequest([changedMethod, { method: 'post' }], url);
  assert.equal(await override.body, body()); assert.equal(changedMethod.bodyUsed, false);
  await changedMethod.text();
  for (const data of [new TextEncoder().encode(body()), new TextEncoder().encode(body()).buffer, new Blob([body()])]) {
    assert.equal(await snapshotRequest([url, { method: 'POST', body: data }], url).body, body());
  }
});

test('provider receives identical arguments, this, promise, Response, rejections and aborts', async t => {
  const originalResponse = response(ack), promise = Promise.resolve(originalResponse), f = fixture(t, () => promise);
  const options = { method: 'POST', body: body() }, receiver = {};
  const result = f.target.fetch.call(receiver, url, options);
  assert.equal(result, promise); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].self, receiver);
  assert.equal(f.calls[0].args[1], options); assert.equal(await result, originalResponse);
  await tick(); assert.equal(f.events.filter(e => e.kind === 'request').length, 1);
  assert.equal(await originalResponse.text(), `data: ${JSON.stringify(ack)}\n\n`);
  const error = new DOMException('synthetic abort', 'AbortError');
  const rejected = Promise.reject(error); rejected.catch(() => {});
  const g = fixture(t, () => rejected);
  assert.equal(g.target.fetch(url, options), rejected); await assert.rejects(rejected, value => value === error);
  await tick(); assert.equal(g.events.filter(e => e.kind === 'request').length, 1);
  const h = fixture(t, () => { throw error; }); assert.throws(() => h.target.fetch(url, options), value => value === error);
  assert.equal(h.calls.length, 1);
});

test('unsupported bodies and capture exceptions cannot change fetch; getters run only in original fetch', async t => {
  let reads = 0;
  const f = fixture(t, (_url, init) => { void init.body; return Promise.resolve(new Response('ok')); });
  const init = { method: 'POST', get body() { reads++; return body(); } };
  assert.equal(await (await f.target.fetch(url, init)).text(), 'ok'); assert.equal(reads, 1);
  const payloads = [new URLSearchParams({ q: 'text' }), new FormData(), new ReadableStream({ start(c) { c.close(); } })];
  for (const data of payloads) await f.target.fetch(url, { method: 'POST', body: data });
  await tick(); assert.equal(f.events.filter(e => e.kind === 'request').length, 0); assert.equal(f.calls.length, 4);
  const target = { fetch: () => Promise.resolve(new Response('unchanged')), location: new URL(url) };
  const observer = installFetchObserver(target, { emit() { throw Error('capture failure'); } }); t.after(() => observer.stop());
  observer.qualify(randomUUID()); assert.equal(await (await target.fetch(url, { method: 'POST', body: body() })).text(), 'unchanged');
});

test('early handoff and inline initial messages bind to their fetch; unknown, foreign, completion and HTTP status are not ack', async () => {
  const request = extractChatGPT(body(), '/backend-api/conversation').request;
  const frames = [ack, { type: 'stream_handoff', conversation_id: 'conversation-1', options: [{ topic_id: 'conversation-turn-turn-1' }] },
    { v: { conversation_id: 'conversation-1', message: { id: 'user-1', author: { role: 'user' }, content: { content_type: 'text', parts: ['ignored'] } } } },
    { v: { conversation_id: 'conversation-1', message: { id: 'assistant-1', author: { role: 'assistant' }, status: 'in_progress', content: { content_type: 'text', parts: [''] } } } }];
  for (const value of frames) assert.ok(await observeAcknowledgement(response(value), request));
  for (const value of [{ ...ack, conversation_id: 'foreign' }, { type: 'message_stream_complete' }, { ok: true },
    { v: { conversation_id: 'conversation-1', message: { id: 'foreign-user', author: { role: 'user' }, content: { content_type: 'text', parts: [''] } } } }]) {
    assert.equal(await observeAcknowledgement(response(value), request), undefined);
  }
  assert.equal(await observeAcknowledgement(new Response('ok'), request), null);
  assert.equal(await observeAcknowledgement(new Response('', { status: 500 }), request), null);
});

test('response observation stops at ack, timeout, failure or byte limit and cancels only its branch', async () => {
  let cancels = 0, reads = 0, inspected = 0;
  const stream = () => ({ getReader: () => ({ read: async () => { reads++; return { value: new Uint8Array(ACK_BYTES * 2), done: false }; },
    cancel: () => { cancels++; return new Promise(() => {}); }, releaseLock() {} }) });
  await readPrefix(stream(), { maximum: ACK_BYTES, timeout: 50, consume(bytes) { inspected += bytes.length; } });
  assert.equal(reads, 1); assert.equal(inspected, ACK_BYTES); assert.equal(cancels, 1);
  const stalled = { getReader: () => ({ read: () => new Promise(() => {}), cancel: () => { cancels++; }, releaseLock() {} }) };
  await readPrefix(stalled, { maximum: 20, timeout: 10, consume() {} }); assert.equal(cancels, 2);
  const broken = { getReader: () => ({ read: () => Promise.reject(Error('stream failed')), cancel: () => { cancels++; }, releaseLock() {} }) };
  await assert.rejects(readPrefix(broken, { maximum: 20, timeout: 10, consume() {} }), /stream failed/); assert.equal(cancels, 3);
  const request = extractChatGPT(body(), '/backend-api/conversation').request;
  const full = `data: ${JSON.stringify(ack)}\n\ndata: ${'ANSWER'.repeat(20000)}\n\n`;
  const original = new Response(full, { headers: { 'content-type': 'text/event-stream' } });
  assert.equal((await observeAcknowledgement(original, request)).kind, 'stream-handoff');
  assert.equal(original.bodyUsed, false); assert.equal(await original.text(), full);
});

test('cleanup cannot cancel provider input/output or turn stale qualifiers into observations', async t => {
  const f = fixture(t); f.observer.clear();
  const promise = f.target.fetch(url, { method: 'POST', body: body() });
  assert.equal(await (await promise).text(), 'provider'); await tick(); assert.deepEqual(f.events, []);
  f.observer.qualify(randomUUID()); const originalFetch = f.target.fetch;
  f.observer.stop(); assert.notEqual(f.target.fetch, originalFetch);
  await f.target.fetch(url, { method: 'POST', body: body() }); assert.equal(f.calls.length, 2);
});

test('extension ships one reviewed MAIN bundle and an isolated document-start relay', async () => {
  await assertObserverBundle();
  const manifest = JSON.parse(await readFile(new URL('../spikes/browser/chatgpt/extension/manifest.json', import.meta.url)));
  assert.deepEqual(manifest.content_scripts.map(v => [v.world, v.run_at, v.js]), [
    ['ISOLATED', 'document_start', ['content-script.js']], ['MAIN', 'document_start', ['fetch-observer.js']]]);
  assert.deepEqual(manifest.host_permissions, ['https://chatgpt.com/*']);
  for (const name of ['bounded', 'chatgpt', 'fetch-observer']) {
    const source = await readFile(new URL(`../spikes/browser/chatgpt/transport/${name}.mjs`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /chrome\.|XMLHttpRequest|WebSocket/);
  }
});

test('a page consuming the original body in its first promise handler still permits early ack observation', async t => {
  const f = fixture(t, () => Promise.resolve(response(ack)));
  const consumed = await f.target.fetch(url, { method: 'POST', body: body() }).then(r => r.text());
  assert.equal(consumed, `data: ${JSON.stringify(ack)}\n\n`);
  await tick(); assert.equal(f.events.filter(value => value.kind === 'ack').length, 1);
});

test('slow Request bodies keep request order and expiration/cleanup never records a late body', async t => {
  const f = fixture(t); let controller;
  const request = new Request(url, { method: 'POST', duplex: 'half', body: new ReadableStream({ start(c) { controller = c; } }) });
  await f.target.fetch(request);
  await f.target.fetch(url, { method: 'POST', body: body('second') });
  controller.enqueue(new TextEncoder().encode(body('first'))); controller.close();
  await request.text(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.events.find(value => value.kind === 'request').text, 'first');
  assert.equal(f.events.filter(value => value.kind === 'request').length, 1);
  let time = 0;
  const events = [], target = { location: new URL(url), fetch: () => Promise.resolve(new Response('provider')) };
  const observer = installFetchObserver(target, { emit: value => events.push(value), now: () => time }); t.after(() => observer.stop());
  observer.qualify(randomUUID()); time = 1501;
  await target.fetch(url, { method: 'POST', body: body() }); await tick(); assert.equal(events.length, 0);
});

test('a retry/resubmit of an observed message cannot consume the next qualified human Send', async t => {
  const f = fixture(t);
  await f.target.fetch(url, { method: 'POST', body: body('first') }); await tick();
  f.observer.qualify(randomUUID(), 'conversation-1');
  await f.target.fetch(url, { method: 'POST', body: body('resubmitted or edited') }); await tick();
  assert.equal(f.events.filter(value => value.kind === 'request').length, 1);
  const next = JSON.parse(body('new prompt')); next.messages[0].id = 'user-2';
  await f.target.fetch(url, { method: 'POST', body: JSON.stringify(next) }); await tick();
  assert.equal(f.events.filter(value => value.kind === 'request').length, 2);
  assert.equal(f.events.filter(value => value.kind === 'request')[1].text, 'new prompt');
});
