import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { recordingFixture, until } from './recording-fixture.mjs';
import { verifyPortable } from '../spikes/recipient/portable.mjs';
import { CHATGPT_PAGE_CONTRACT } from '../spikes/browser/chatgpt/adapter.mjs';
import { pageFixture } from './chatgpt-page-fixture.mjs';
import { EngineStateStore } from '../spikes/browser/chatgpt/engine-store.mjs';

const exact = '\uFEFFSYNTHETIC_TRANSPORT_e\u0301\r\n☕  ';
const tick = () => new Promise(setImmediate);
async function fixture(t, options) {
  const root = await mkdtemp('/private/tmp/attestamp-transport-test-'); let f;
  t.after(async () => { await f?.close(); await rm(root, { recursive: true, force: true }); });
  f = await recordingFixture(root, options); return f;
}
const saved = f => f.runtime.session.receipts.list();
const preview = (f, id = saved(f)[0].id) => {
  const value = f.runtime.session.receipts.prepare({ ids: [id] });
  return { value, bytes: f.runtime.session.receipts.export(value.previewId) };
};
const handoff = (conversation = 'fixture-17', turn = 'turn-17') => new Response(`data: ${JSON.stringify({
  type: 'stream_handoff', conversation_id: conversation, turn_exchange_id: turn })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });

test('durable exact request text is independent of composer markup and rendered history; ack is a separate signed assertion', async t => {
  const f = await fixture(t, { fetchResponse: async () => handoff() }); await f.recording(true);
  const page = f.pages.get(17);
  page.text = 'UNRELATED_COMPOSER_TEXT'; f.appear(exact);
  f.send(undefined, { request: false }); await page.request(exact);
  await until(() => f.results.some(value => value.result.kind === 'acknowledgement')); await f.runtime.engine.drain();
  assert.equal(saved(f).length, 1); assert.equal(preview(f).value.texts[0].preview, exact);
  const report = verifyPortable(preview(f).bytes);
  const record = report.records.find(value => value.localAssertions.some(a => a.kind === 'normal-request-observed'));
  assert.equal(record.releaseControl, 'OBSERVED_ONLY');
  assert.ok(record.localAssertions.some(a => a.kind === 'normal-acknowledgement' && a.providerReceipt === 'UNKNOWN'));
  assert.ok(record.localAssertions.every(a => a.assurance === 'CLIENT_ASSERTION_ONLY'));
  assert.equal(f.prevention, 0); assert.equal(page.injections(), 0); assert.equal(page.clicks(), 0); assert.equal(f.releases.length, 0);
});

test('DOM events alone, typing, hydration, synthetic input and IME never create evidence', async t => {
  const f = await fixture(t); await f.recording(true); const page = f.pages.get(17);
  page.text = exact; page.event('input', { isTrusted: true }); f.appear(exact);
  f.send(exact, { trusted: false, request: false });
  for (const event of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }, { shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
    f.send(exact, { method: 'enter', request: false, ...event });
  }
  page.event('compositionstart'); f.send(exact, { method: 'enter', request: false }); page.event('compositionend');
  f.send(exact, { method: 'enter', request: false });
  f.send(exact, { request: false }); await tick(); await tick();
  assert.equal(saved(f).length, 0); assert.equal(f.deliveries.length, 0);
  page.transportMessage({ kind: 'request', id: crypto.randomUUID(), text: exact, request: {} });
  await tick(); assert.equal(f.deliveries.length, 0);
});

test('empty -> type -> clear with absent Send stays armed, and the next request captures once', async t => {
  const f = await fixture(t); await f.recording(true); const page = f.pages.get(17);
  page.buttons = []; page.text = ''; await tick();
  assert.equal((await page.inspect()).surfaceSupported, true); assert.equal(page.feedback, 'Attestamp · ON');
  page.text = 'typing'; page.text = ''; await tick(); await f.refresh();
  assert.equal(page.feedback, 'Attestamp · ON'); assert.equal(saved(f).length, 0);
  f.send(exact, { method: 'enter' }); await until(() => saved(f).length === 1);
  assert.equal(preview(f).value.texts[0].preview, exact);
});

test('conversation -> New Chat recovers sidebar/page source state with a stale creation URL and no reload', async t => {
  const f = await fixture(t, { fixedSenderURL: true }); await f.recording(true); const page = f.pages.get(17);
  f.navigate(17, 'https://chatgpt.com/');
  await until(() => f.runtime.adapter.scopes().some(s => s.tabId === 17 && s.destination === 'new-chat'));
  await until(async () => (await f.refresh()).policy?.destination === 'new-chat');
  assert.equal(page.feedback, 'Attestamp · ON');
  assert.equal(f.runtime.engine.state().scopes.find(s => s.tabId === 17).effectiveRecording, 'ON');
  f.send(exact); await until(() => saved(f).length === 1);
  assert.equal(f.sources[0].destination, 'new-chat');
});

test('equal-text human Sends stay distinct; retries of one delivery stay idempotent', async t => {
  const f = await fixture(t, { dropAck: true }); await f.recording(true); f.send(exact);
  await until(() => f.pages.get(17).feedback === 'Attestamp · Prompt saved');
  assert.equal(f.deliveries.length, 2); assert.equal(f.deliveries[0].observation.eventId, f.deliveries[1].observation.eventId);
  f.send(exact); await until(() => saved(f).length === 2); await f.runtime.engine.drain();
  assert.notEqual(f.deliveries[0].observation.eventId, f.deliveries[2].observation.eventId);
  assert.equal(f.anchorCalls, 2); assert.equal(f.userSends, 2); assert.equal(f.prevention, 0);
});

for (const outcome of ['no-ack', 'HTTP-error', 'rejection', 'stream-failure', 'timeout']) {
  test(`request is durably saved without downgrade on ${outcome}`, async t => {
    const f = await fixture(t, { fetchResponse: () => {
      if (outcome === 'rejection') return Promise.reject(Error('synthetic network failure'));
      if (outcome === 'timeout') return new Promise(() => {});
      if (outcome === 'stream-failure') return Promise.resolve(new Response(new ReadableStream({ start(c) { c.error(Error('synthetic stream failure')); } }),
        { headers: { 'content-type': 'text/event-stream' } }));
      return Promise.resolve(new Response('', { status: outcome === 'HTTP-error' ? 500 : 200 }));
    } });
    await f.recording(true); f.send(exact); await until(() => f.pages.get(17).feedback === 'Attestamp · Prompt saved');
    assert.equal(saved(f).length, 1); assert.equal(f.runtime.session.status().versions[0].acknowledgement, undefined);
    f.pages.get(17).event('pagehide'); await tick(); assert.equal(saved(f).length, 1);
  });
}

for (const fault of ['storageFault', 'keyFault']) test(`${fault} never reports saved or interferes with provider fetch`, async t => {
  const f = await fixture(t); await f.recording(true); f[fault](); f.send(exact);
  await until(() => f.results.length > 0); assert.equal(saved(f).length, 0);
  assert.ok(f.results.every(v => v.result.state !== 'PROMPT_SAVED'));
  assert.equal(f.pages.get(17).requests.length, 1); assert.equal(f.prevention, 0);
});

test('overlapping tabs and reversed acknowledgements preserve source/event attribution; duplicate and foreign acks cannot create evidence', async t => {
  const replies = [];
  const f = await fixture(t, { fetchResponse: () => new Promise(resolve => replies.push(resolve)) }); await f.recording(true);
  f.send('FIRST', { id: 17 }); f.send('SECOND', { id: 18 }); await until(() => saved(f).length === 2);
  replies[1](handoff('fixture-18', 'second')); replies[0](handoff('fixture-17', 'first'));
  await until(() => f.results.filter(v => v.result.kind === 'acknowledgement').length === 2);
  const versions = f.runtime.session.status().versions;
  assert.equal(versions.find(v => v.source.tabId === 17).acknowledgement.correlationId, 'first');
  assert.equal(versions.find(v => v.source.tabId === 18).acknowledgement.correlationId, 'second');
  const acknowledgement = f.deliveries.find(v => v.observation.kind === 'acknowledgement');
  const before = f.results.length; f.replay(acknowledgement); await until(() => f.results.length > before);
  assert.equal(f.results.at(-1).result.state, 'PROMPT_SAVED');
  for (const change of [{ eventId: crypto.randomUUID() }, { source: { ...acknowledgement.observation.source, tabId: 999 } },
    { acknowledgement: { ...acknowledgement.observation.acknowledgement, conversationId: 'foreign' } }]) {
    const requestId = f.replay({ ...acknowledgement, observation: { ...acknowledgement.observation, ...change } });
    await until(() => f.results.some(v => v.requestId === requestId));
    assert.equal(f.results.find(v => v.requestId === requestId).result.state, 'RECORDING_UNAVAILABLE');
  }
  assert.equal(saved(f).length, 2);
});

test('OFF/ON and permission loss reject stale observations and acknowledgements; existing saved evidence remains', async t => {
  const replies = [];
  const f = await fixture(t, { fetchResponse: () => new Promise(resolve => replies.push(resolve)) }); await f.recording(true);
  f.send(exact); await until(() => saved(f).length === 1);
  const old = f.deliveries[0]; await f.recording(false); await f.recording(true);
  replies[0](handoff()); await tick(); assert.equal(f.runtime.session.status().versions[0].acknowledgement, undefined);
  const requestId = f.replay(old); await until(() => f.results.some(v => v.requestId === requestId));
  assert.equal(f.results.find(v => v.requestId === requestId).result.state, 'RECORDING_UNAVAILABLE');
  f.revokePermission(); await until(() => !f.runtime.adapter.scopes().length); f.send('REVOKED'); await tick();
  assert.equal(saved(f).length, 1);
});

test('current evidence and acknowledgement restore and export with original versioned meanings', async t => {
  const f = await fixture(t, { fetchResponse: async () => handoff() }); await f.recording(true); f.send(exact);
  await until(() => f.results.some(v => v.result.kind === 'acknowledgement')); await f.runtime.engine.drain();
  const receipt = saved(f)[0], before = preview(f).value.texts[0].preview;
  await f.restart(); assert.equal(saved(f)[0].id, receipt.id); assert.equal(preview(f).value.texts[0].preview, before);
  const assertions = verifyPortable(preview(f).bytes).records.flatMap(v => v.localAssertions);
  assert.ok(assertions.some(v => v.kind === 'normal-request-observed' && v.coverage === 'UTF8_NEW_USER_MESSAGE'));
  assert.ok(assertions.some(v => v.kind === 'normal-acknowledgement'));
});
for (const schedule of ['before worker receipt', 'during browser checks', 'Chrome loading route', 'lost acknowledgement']) {
  test(`first New-chat Send survives navigation ${schedule} exactly once`, async t => {
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    t.after(() => release());
    const f = await fixture(t, { newChat: true, dropAck: schedule === 'lost acknowledgement',
      beforeCapture: ['before worker receipt', 'Chrome loading route'].includes(schedule) ? async () => { entered(); await gate; } : null });
    await f.recording(true);
    if (schedule === 'during browser checks') {
      const query = f.worker.chrome.tabs.query;
      let held = false;
      f.worker.chrome.tabs.query = async (...args) => {
        const value = await query(...args);
        if (!held) { held = true; entered(); await gate; }
        return value;
      };
    }
    f.send(exact);
    if (schedule !== 'lost acknowledgement') await started;
    f.navigate(17, 'https://chatgpt.com/c/created-by-send', schedule === 'Chrome loading route' ? { status: 'loading' } : {});
    await until(() => f.runtime.adapter.scopes().some(source => source.destination === 'conversation:created-by-send'));
    release();
    await until(() => f.pages.get(17).feedback === 'Attestamp · Prompt saved');
    await f.runtime.engine.drain();
    assert.equal(saved(f).length, 1); assert.equal(preview(f).value.texts[0].preview, exact);
    assert.equal(f.sources[0].destination, 'new-chat');
    assert.equal(f.userSends, 1); assert.equal(f.prevention, 0); assert.equal(f.releases.length, 0);
    assert.equal(f.anchorCalls, 1);
    f.appear(exact);
    await new Promise(setImmediate);
    assert.ok(f.deliveries.every(value => value.observation.kind === 'request-observed'));
    const original = f.deliveries[0], before = f.results.length;
    f.replay(original); await until(() => f.results.length > before);
    assert.equal(saved(f).length, 1);
    f.replay({ ...original, observation: { ...original.observation, eventId: crypto.randomUUID() } });
    await until(() => f.results.length > before + 1);
    assert.equal(f.results.at(-1).result.state, 'RECORDING_UNAVAILABLE');
  });
}

for (const change of ['OFF/ON', 'reload', 'full navigation', 'different document', 'copied tab', 'second navigation', 'unsupported URL', 'permission', 'expired']) {
  test(`New-chat continuity rejects ${change} before durable capture`, async t => {
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    t.after(() => release());
    const f = await fixture(t, { newChat: true, beforeCapture: async () => { entered(); await gate; } });
    await f.recording(true); f.send(exact); await started;
    f.navigate(17, 'https://chatgpt.com/c/created-by-send');
    await until(() => f.runtime.adapter.scopes().some(source => source.destination === 'conversation:created-by-send'));
    if (change === 'OFF/ON') { await f.recording(false); await f.recording(true); }
    if (change === 'reload') { f.pages.get(17).event('pagehide'); f.worker.chrome.tabs.onUpdated.emit(17, { status: 'loading' }); }
    if (change === 'full navigation') f.pages.get(17).event('pagehide');
    if (change === 'different document') f.pages.get(17).documentId = 'replacement-document';
    if (change === 'copied tab') {
      const original = f.pages.get(17), copy = f.pages.get(18);
      f.pages.set(17, copy); copy.location.href = original.location.href;
      t.after(() => original.close());
    }
    if (change === 'second navigation') f.navigate(17, 'https://chatgpt.com/c/unrelated');
    if (change === 'unsupported URL') f.navigate(17, 'https://chatgpt.com/settings');
    if (change === 'permission') f.revokePermission();
    if (change === 'expired') await new Promise(resolve => setTimeout(resolve, 5100));
    release();
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(saved(f).length, 0); assert.equal(f.anchorCalls, 0); assert.equal(f.prevention, 0);
  });
}

test('first New-chat Send survives Chrome reporting loading before the conversation route', async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  t.after(() => release());
  const f = await fixture(t, { newChat: true, beforeCapture: async () => { entered(); await gate; } });
  await f.recording(true);
  f.send(exact);
  await started;
  // Real Chrome delivers the navigation precursor and the conversation route as
  // separate tab updates. The status-only update must not retire the pending
  // first-New-chat candidate before its route is known.
  f.worker.chrome.tabs.onUpdated.emit(17, { status: 'loading' });
  f.navigate(17, 'https://chatgpt.com/c/created-by-send');
  await until(() => f.runtime.adapter.scopes().some(source => source.destination === 'conversation:created-by-send'));
  release();
  await until(() => f.pages.get(17).feedback === 'Attestamp · Prompt saved');
  await f.runtime.engine.drain();
  assert.equal(saved(f).length, 1);
  assert.equal(preview(f).value.texts[0].preview, exact);
  assert.equal(f.sources[0].destination, 'new-chat');
  assert.equal(f.userSends, 1); assert.equal(f.prevention, 0); assert.equal(f.releases.length, 0);
});

test('a repeated status-only loading precursor still revokes New-chat continuity', async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  t.after(() => release());
  const f = await fixture(t, { newChat: true, beforeCapture: async () => { entered(); await gate; } });
  await f.recording(true); f.send(exact); await started;
  // Only the first bounded precursor is tolerated; a second one is a real second
  // navigation and must revoke before any durable capture.
  f.worker.chrome.tabs.onUpdated.emit(17, { status: 'loading' });
  f.worker.chrome.tabs.onUpdated.emit(17, { status: 'loading' });
  f.navigate(17, 'https://chatgpt.com/c/created-by-send');
  await until(() => f.runtime.adapter.scopes().some(source => source.destination === 'conversation:created-by-send'));
  release();
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(saved(f).length, 0); assert.equal(f.anchorCalls, 0); assert.equal(f.prevention, 0);
});

test('same-document navigation alone cannot authenticate an unobserved first Send', async t => {
  const f = await fixture(t, { newChat: true }); await f.recording(true);
  const policy = f.runtime.engine.capturePolicy().find(value => value.tabId === 17);
  f.navigate(17, 'https://chatgpt.com/c/unrelated');
  const page = f.pages.get(17);
  const result = await f.worker.message({ kind: 'PAP_CAPTURE', pageContract: CHATGPT_PAGE_CONTRACT,
    token: policy.token, eventId: crypto.randomUUID(), observationKind: 'request-observed', inputMethod: 'provider-request', text: exact, request: { profile: 'chatgpt-new-user-text/3', path: '/backend-api/conversation', messageId: 'unobserved', conversationId: null } }, page.captureSender());
  assert.equal(result.state, 'RECORDING_UNAVAILABLE');
  assert.equal(saved(f).length, 0); assert.equal(f.deliveries.length, 0);
});

test('Chrome creation-URL metadata is authenticated for polling while the first capture is pending', async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  t.after(() => release());
  const f = await fixture(t, { newChat: true, fixedSenderURL: true, beforeCapture: async () => { entered(); await gate; } });
  await f.recording(true); f.send(exact); await started;
  f.navigate(17, 'https://chatgpt.com/c/created-by-send', { status: 'loading' });
  await until(() => f.runtime.adapter.scopes().some(source => source.destination === 'conversation:created-by-send'));
  const current = await f.refresh(); assert.equal(current.policy.destination, 'conversation:created-by-send');
  release(); await until(() => f.pages.get(17).feedback === 'Attestamp · Prompt saved');
  f.send(exact); await until(() => saved(f).length === 2);
  assert.deepEqual(f.sources.map(source => source.destination), ['new-chat', 'conversation:created-by-send']);
  const old = f.deliveries[0];
  await f.recording(false); assert.equal(f.pages.get(17).feedback, ''); await f.recording(true);
  const requestId = f.replay(old); await until(() => f.results.some(value => value.requestId === requestId));
  assert.equal(f.results.find(value => value.requestId === requestId).result.state, 'RECORDING_UNAVAILABLE');
  f.send('FRESH_CONSENT'); await until(() => saved(f).length === 3);
});

test('a destination tab URL cannot authenticate the old document during full navigation', async t => {
  const f = await fixture(t, { newChat: true, fixedSenderURL: true }); await f.recording(true);
  const query = f.worker.chrome.tabs.query;
  f.worker.chrome.tabs.query = async (...args) => (await query(...args)).map(tab => tab.id === 17
    ? { ...tab, url: 'https://chatgpt.com/c/another-document' } : tab);
  f.worker.chrome.tabs.onUpdated.emit(17, { url: 'https://chatgpt.com/c/another-document', status: 'loading' });
  const status = await f.refresh();
  assert.equal(status.state, 'RECORDING_UNAVAILABLE');
  assert.equal(saved(f).length, 0);
});

test('maximum escaped prompt survives framing and restore exactly; oversize produces a gap without truncation', async t => {
  const f = await fixture(t); await f.recording(true);
  const text = '\uFEFF' + '\0'.repeat(256 * 1024 - 3);
  f.send(text); await until(() => f.pages.get(17).feedback === 'Attestamp · Prompt saved');
  const records = f.runtime.session.vault.inspect().records;
  const version = f.runtime.session.status().versions[0];
  const record = records.find(v => v.manifest.eventId === version.descriptorId);
  const descriptor = JSON.parse(f.runtime.session.vault.read(record.manifest.evidence[0].objectDigest));
  const bytes = f.runtime.session.vault.read(descriptor.textObject);
  assert.equal(bytes.length, 256 * 1024); assert.equal(bytes.toString(), text);
  f.send('x'.repeat(256 * 1024 + 1)); await until(() => f.pages.get(17).feedback === 'Attestamp · Recording gap');
  assert.equal(saved(f).length, 1); await f.restart(); assert.equal(saved(f).length, 1);
});

test('late policy refresh cannot overwrite OFF or a reconnected session with the same numeric revision', async t => {
  for (const state of ['OFF', 'READY']) {
    let settle;
    const page = pageFixture({ capture: () => new Promise(resolve => { settle = resolve; }) }); t.after(() => page.close());
    await tick();
    await page.send({ kind: 'PAP_CAPTURE_POLICY', pageContract: CHATGPT_PAGE_CONTRACT, browserSessionId: 'new-session',
      revision: 1, state, policy: null });
    settle({ kind: 'PAP_CAPTURE_POLICY', pageContract: CHATGPT_PAGE_CONTRACT, browserSessionId: 'old-session',
      revision: 1, state: 'RECORDING_UNAVAILABLE', policy: null });
    await tick(); assert.equal(page.feedback, state === 'OFF' ? '' : 'Attestamp · ON');
    await page.send({ kind: 'PAP_CAPTURE_POLICY', pageContract: CHATGPT_PAGE_CONTRACT, browserSessionId: 'new-session',
      revision: 0, state: 'RECORDING_UNAVAILABLE', policy: null });
    assert.equal(page.feedback, state === 'OFF' ? '' : 'Attestamp · ON');
  }
});

for (const stage of ['text', 'descriptor', 'metadata']) test(`interruption at ${stage} never announces premature save`, async t => {
  const f = await fixture(t); await f.recording(true);
  const capture = f.runtime.session.vault.capture.bind(f.runtime.session.vault), save = EngineStateStore.prototype.save;
  t.after(() => { EngineStateStore.prototype.save = save; f.runtime.session.vault.capture = capture; });
  if (stage === 'metadata') EngineStateStore.prototype.save = async () => { throw Error('SYNTHETIC_WRITE_INTERRUPTED'); };
  else f.runtime.session.vault.capture = (...args) => {
    if (stage === 'text' && args[0].equals(Buffer.from(exact))
        || stage === 'descriptor' && args[1]?.type === 'observation' && args[0].includes('normal-request-observed')) throw Error('SYNTHETIC_WRITE_INTERRUPTED');
    return capture(...args);
  };
  f.send(exact); await until(() => f.results.length > 0);
  assert.ok(f.results.every(v => v.result.state !== 'PROMPT_SAVED'));
  assert.doesNotMatch(f.pages.get(17).feedback, /Prompt saved/);
  assert.equal(f.pages.get(17).requests.length, 1); assert.equal(f.prevention, 0);
});
