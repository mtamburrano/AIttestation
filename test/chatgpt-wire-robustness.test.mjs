import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { extractChatGPT } from '../spikes/browser/chatgpt/transport/chatgpt.mjs';
import { installFetchObserver } from '../spikes/browser/chatgpt/transport/fetch-observer.mjs';
import { MAX_REQUEST_BYTES, MAX_PROMPT_BYTES } from '../spikes/browser/chatgpt/transport/bounded.mjs';
import { LocalDiagnostics } from '../spikes/diagnostics/local.mjs';
import { verifyPortable } from '../spikes/recipient/portable.mjs';
import { recordingFixture, until } from './recording-fixture.mjs';

const path = '/backend-api/f/conversation', url = `https://chatgpt.com${path}`;
const exact = '\uFEFF  e\u0301\r\n☕\t';
const user = (parts = [exact], patch = {}) => ({ id: 'wire-user', author: { role: 'user' }, content: { content_type: 'text', parts }, ...patch });
const payload = (patch = {}) => ({ action: 'next', messages: [user()], parent_message_id: 'client-created-root', ...patch });
const extract = value => extractChatGPT(JSON.stringify(value), path);
const tick = () => new Promise(setImmediate);

for (const action of [undefined, null, 'next', 'future-send']) test(`unknown envelope fields do not veto text (action=${action})`, () => {
  const noise = { image: { edit: true, regenerate: true }, attachment: ['file'], audio: true,
    anonymous_feature: { voice: 'future' }, nested: { conversation_id: 'irrelevant', is_edit: true } };
  let deep = noise;
  for (let i = 0; i < 100; i++) deep = { unknown: deep };
  const result = extract(payload({ action, parent_message_id: undefined, model: 'future',
    conversation_mode: { kind: 'future-assistant' }, attachments: noise, feature_config: deep,
    model_response_contracts: [{ type: 'photo_upload_action.v1', presets: ['cap:image', 'cap:file'] }],
    messages: [null, ...Array.from({ length: 150 }, () => ({ future_history: noise })),
      { id: 'history', author: { role: 'tool' }, content: { arbitrary: 'PRIVATE_HISTORY_CANARY' } },
      user([exact], { recipient: 'future', channel: 'future', metadata: noise }),
      { author: { role: 'assistant' }, content: { parts: ['PRIVATE_ANSWER_CANARY'] } }] }));
  assert.equal(result.text, exact);
  assert.equal(result.request.messageId, 'wire-user');
  assert.equal(result.request.conversationId, null);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_HISTORY|PRIVATE_ANSWER|cap:image|future/);
});

test('heterogeneous parts preserve ordered text bytes without separators or normalization', () => {
  const notices = [], parts = ['\uFEFF ', { content_type: 'image_asset_pointer', asset_pointer: 'PRIVATE_IMAGE' },
    { type: 'text', text: ' e\u0301\r\n' }, { file_id: 'PRIVATE_FILE' }, '☕\t'];
  const body = payload({ messages: [user(parts, { content: { content_type: 'multimodal_text', parts },
    metadata: { attachments: [{ id: 'PRIVATE_ATTACHMENT', name: 'PRIVATE_FILENAME' }] } })] });
  const result = extractChatGPT(JSON.stringify(body), path, code => notices.push(code));
  assert.equal(result.text, exact);
  assert.deepEqual(Buffer.from(result.text), Buffer.from(exact));
  assert.ok(notices.includes('REQUEST_MEDIA_IGNORED'));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_IMAGE|PRIVATE_FILE|PRIVATE_ATTACHMENT|PRIVATE_FILENAME/);
  assert.throws(() => extract(payload({ messages: [user(['\ud83d', '\ude00'])] })), /REQUEST_PROMPT_INVALID/);
});

test('latest user is selected positively and never falls back to earlier history text', () => {
  assert.equal(extract(payload({ messages: [user(['OLD'], { id: 'old' }), user()] })).text, exact);
  for (const parts of [[], [''], [{ image_asset_pointer: 'private' }]]) {
    assert.throws(() => extract(payload({ messages: [user(['OLD'], { id: 'old' }), user(parts)] })), /REQUEST_(PROMPT_MISSING|MEDIA_ONLY)/);
  }
  for (const messages of [[], [{ role: 'user', content: { parts: [exact] } }], [user([exact], { id: null })],
    [user(), user()], [{ author: { role: 'tool' }, id: 'tool', content: { parts: [exact] } }]]) {
    assert.throws(() => extract(payload({ messages })), /REQUEST_(PROMPT_MISSING|IDENTITY_MISSING)/);
  }
});

test('only explicit operation semantics reject; unknown operation values and irrelevant edit keys remain additive', () => {
  for (const action of ['edit', 'regenerate', 'resubmit', 'continue', 'variant']) {
    assert.throws(() => extract(payload({ action })), /REQUEST_OPERATION_UNSUPPORTED/);
    assert.throws(() => extract(payload({ messages: [user([exact], { metadata: { action } })] })), /REQUEST_OPERATION_UNSUPPORTED/);
  }
  for (const key of ['is_edit', 'is_regenerate', 'is_resubmit']) {
    assert.throws(() => extract(payload({ [key]: true })), /REQUEST_OPERATION_UNSUPPORTED/);
    assert.equal(extract(payload({ [key]: 'future' })).text, exact);
  }
  assert.throws(() => extract(payload({ parent_message_id: 'wire-user' })), /REQUEST_OPERATION_UNSUPPORTED/);
  assert.equal(extract(payload({ messages: [user([exact], { metadata: { editor: { is_edit: true } } })] })).text, exact);
});

test('JSON ambiguity checks concern evidence paths, allowing duplicate and deeply nested irrelevant extensions', () => {
  const body = JSON.stringify(payload());
  assert.equal(extractChatGPT(body.replace('"action":"next"', '"extra":{"a":1,"a":2},"action":"next"'), path).text, exact);
  const history = body.replace('"messages":[', '"messages":[{"author":{"role":"assistant","role":"future"}},');
  assert.equal(extractChatGPT(history, path).text, exact, 'unrelated history cannot invalidate an identified latest turn');
  for (const text of [body.replace('"action":"next"', '"action":"edit","action":"next"'),
    body.replace('"id":"wire-user"', '"id":"different","id":"wire-user"'),
    body.replace('"role":"user"', '"role":"tool","role":"user"'),
    body.replace('"parts":', '"parts":["OTHER"],"parts":'),
    JSON.stringify(payload({ messages: [user([{ text: 'ONE' }])] })).replace('"text":"ONE"', '"text":"ONE","text":"TWO"')]) {
    assert.throws(() => extractChatGPT(text, path), /REQUEST_JSON_INVALID/);
  }
});

test('body acquisition, decoding, operation, media and identity gaps are bounded content-free codes', async t => {
  const events = [], calls = [], provider = Promise.resolve(new Response('unchanged'));
  const target = { location: new URL('https://chatgpt.com/c/route'), fetch(...args) { calls.push(args); return provider; } };
  const observer = installFetchObserver(target, { emit: event => events.push(event) }); t.after(() => observer.stop());
  observer.arm(randomUUID(), 'route');
  const cases = [
    [new URLSearchParams({ secret: 'PRIVATE_BODY_CANARY' }), 'REQUEST_BODY_READ_FAILED'],
    [new Blob([new Uint8Array([0xff])]), 'REQUEST_BODY_READ_FAILED'],
    [' '.repeat(MAX_REQUEST_BYTES + 1), 'REQUEST_BODY_LIMIT'],
    ['{"secret":"PRIVATE_JSON_CANARY",', 'REQUEST_JSON_INVALID'],
    [JSON.stringify(payload({ action: 'regenerate' })), 'REQUEST_OPERATION_UNSUPPORTED'],
    [JSON.stringify(payload({ messages: [user([{ file_id: 'PRIVATE_MEDIA_CANARY' }])] })), 'REQUEST_MEDIA_ONLY'],
    [JSON.stringify(payload({ messages: [user([''])] })), 'REQUEST_PROMPT_MISSING'],
    [JSON.stringify(payload({ messages: [user([exact], { id: undefined })] })), 'REQUEST_IDENTITY_MISSING'],
    [JSON.stringify(payload({ messages: [user(['x'.repeat(MAX_PROMPT_BYTES + 1)])] })), 'REQUEST_PROMPT_INVALID'],
  ];
  for (const [body, code] of cases) {
    const before = events.length, init = { method: 'POST', body };
    assert.equal(target.fetch(url, init), provider);
    await until(() => events.slice(before).some(value => value.kind === 'gap'));
    assert.equal(events.at(-1).code, code);
    assert.equal(calls.at(-1)[1], init);
  }
  assert.equal(calls.length, cases.length);
  assert.ok(events.every(value => ['matched', 'gap'].includes(value.kind)));
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_|chatgpt\.com|backend-api|wire-user|secret|Error/);
});

for (const newChat of [false, true]) for (const conversation_id of [undefined, null, 'provider-conversation']) {
  test(`provider conversation metadata saves independently of route (${newChat}/${conversation_id})`, async t => {
    const root = await mkdtemp('/private/tmp/attestamp-wire-test-'), diagnostics = new LocalDiagnostics(); let f;
    t.after(async () => { await f?.close(); await rm(root, { recursive: true, force: true }); });
    f = await recordingFixture(root, { diagnostics, newChat, tabs: 1 }); await f.recording(true);
    const page = f.pages.get(17), receipts = () => f.runtime.session.receipts.list();
    await page.request(exact, payload({ conversation_id, messages: [user([exact, { file_id: 'PRIVATE_FILE' }])] }));
    await until(() => receipts().length === 1);
    const saved = f.runtime.session.status().versions[0];
    assert.equal(saved.source.destination, newChat ? 'new-chat' : 'conversation:fixture-17');
    assert.equal(saved.request.conversationId, conversation_id ?? null);
    const preview = f.runtime.session.receipts.prepare({ ids: [saved.descriptorId] });
    assert.equal(preview.texts[0].preview, exact);
    const assertions = verifyPortable(f.runtime.session.receipts.export(preview.previewId)).records.flatMap(value => value.localAssertions);
    assert.ok(assertions.some(value => value.request?.conversationId === (conversation_id ?? null) && value.source.destination === saved.source.destination));
    // New-chat continuation remains one event; a subsequent request uses its
    // own authenticated route policy, as it does after the provider navigates.
    if (newChat) {
      f.navigate(17, 'https://chatgpt.com/c/created-for-retry');
      await until(async () => (await f.refresh()).policy?.destination === 'conversation:created-for-retry');
    }
    await page.request(exact, payload({ conversation_id: conversation_id ?? 'now-known' }));
    await until(() => f.results.some(value => value.result.deduplicated));
    assert.equal(receipts().length, 1);
    assert.equal(f.runtime.session.status().versions[0].request.conversationId, conversation_id ?? null);
    if (conversation_id) {
      await page.request(exact, payload({ conversation_id: 'conflicting-provider' }));
      await until(() => f.results.some(value => value.result.state === 'RECORDING_UNAVAILABLE'));
      assert.equal(receipts().length, 1);
    }
    await f.runtime.engine.drain(); assert.equal(f.anchorCalls, 1);
    assert.equal(page.requests.length, conversation_id ? 3 : 2); assert.equal(f.prevention, 0); assert.equal(f.releases.length, 0);
    const codes = diagnostics.preview().report.events.map(value => value.code);
    if (!conversation_id) assert.ok(codes.includes('REQUEST_CONVERSATION_UNAVAILABLE'));
    assert.ok(codes.includes('REQUEST_MEDIA_IGNORED'));
    if (!newChat && conversation_id) assert.ok(codes.includes('REQUEST_CONVERSATION_DIFFERENT'));
    assert.doesNotMatch(JSON.stringify(diagnostics.preview().report), /PRIVATE_|provider-conversation|fixture-17|backend-api/);
    await f.restart(); assert.equal(receipts().length, 1);
    await tick();
  });
}

const wireFixtures = ['new-chat-text', 'existing-chat-text', 'new-chat-image', 'new-chat-file'];
for (const name of wireFixtures) for (const newChat of [true, false]) {
  test(`owner-captured ${name} saves exact text under an authenticated ${newChat ? 'new-chat' : 'conversation'} route`, async t => {
    const wire = await readFile(new URL(`./fixtures/chatgpt-wire/${name}.json`, import.meta.url), 'utf8');
    const body = JSON.parse(wire), expected = `Wire fixture: ${name}.`, notices = [];
    const extracted = extractChatGPT(wire, path, code => notices.push(code));
    assert.equal(extracted.text, expected); assert.equal(extracted.request.messageId, body.messages[0].id);
    assert.equal(extracted.request.conversationId, body.conversation_id ?? null);
    if (name.endsWith('image') || name.endsWith('file')) assert.ok(notices.includes('REQUEST_MEDIA_IGNORED'));
    // Evolving fields are added to the captured shape, not a substitute envelope.
    const future = structuredClone(body);
    future.action = 'future-send'; future.messages[0].recipient = 'future'; future.messages[0].channel = 'future';
    future.messages[0].metadata.future = { image: { edit: true }, attachment: ['future'], voice: true };
    future.future_feature = { arbitrary: { enabled: true, file_ids: ['future'] } };
    assert.deepEqual(extract(future), extracted);
    const root = await mkdtemp('/private/tmp/attestamp-real-wire-test-'); let f;
    t.after(async () => { await f?.close(); await rm(root, { recursive: true, force: true }); });
    const provider = Promise.resolve(new Response('UNTOUCHED_SYNTHETIC_PROVIDER_RESPONSE'));
    f = await recordingFixture(root, { newChat, tabs: 1, fetchResponse: () => provider }); await f.recording(true);
    const page = f.pages.get(17);
    assert.equal(page.fetch(url, { method: 'POST', body: wire }), provider);
    assert.equal(await (await provider).text(), 'UNTOUCHED_SYNTHETIC_PROVIDER_RESPONSE');
    await until(() => f.runtime.session.receipts.list().length === 1);
    const saved = f.runtime.session.status().versions[0];
    assert.deepEqual(saved.request, extracted.request);
    assert.equal(saved.source.destination, newChat ? 'new-chat' : 'conversation:fixture-17');
    const preview = f.runtime.session.receipts.prepare({ ids: [saved.descriptorId] });
    assert.equal(preview.texts[0].preview, expected);
    const assertions = verifyPortable(f.runtime.session.receipts.export(preview.previewId)).records.flatMap(value => value.localAssertions);
    assert.ok(assertions.some(value => value.request?.messageId === extracted.request.messageId
      && value.source.destination === saved.source.destination && value.providerReceipt === 'UNKNOWN'));
    const record = f.runtime.session.vault.inspect().records.find(value => value.manifest.eventId === saved.descriptorId);
    const observation = JSON.parse(f.runtime.session.vault.read(record.manifest.evidence[0].objectDigest).toString());
    assert.equal(observation.attachments, 'UNSUPPORTED');
    assert.doesNotMatch(JSON.stringify(observation), /asset_pointer|library_file_id|photo_upload_action|fixture-new-chat-image.png|fixture-new-chat-file.rtf/);
    await f.runtime.engine.drain(); assert.equal(f.anchorCalls, 1);
    assert.equal(page.requests.length, 1); assert.equal(page.requests[0][1].body, wire);
    assert.equal(f.prevention, 0); assert.equal(f.releases.length, 0);
  });
}
