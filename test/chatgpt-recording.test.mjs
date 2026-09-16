import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { recordingFixture, until } from './recording-fixture.mjs';
import { verifyPortable } from '../spikes/recipient/portable.mjs';
import { LocalDiagnostics } from '../spikes/diagnostics/local.mjs';
import { canonical } from '../spikes/vault/format.mjs';
import { pageFixture } from './chatgpt-page-fixture.mjs';
import { CHATGPT_PAGE_CONTRACT } from '../spikes/browser/chatgpt/adapter.mjs';
import { CHATGPT_CAPTURE_PROFILE } from '../spikes/browser/chatgpt/capture.mjs';

const exact = 'SYNTHETIC_NORMAL_e\u0301\r\n☕  ';
async function fixture(t, options) {
  const root = await mkdtemp('/private/tmp/attestamp-capture-test-');
  let f;
  t.after(async () => { await f?.close(); await rm(root, { recursive: true, force: true }); });
  f = await recordingFixture(root, options); return f;
}
const saved = f => f.runtime.session.receipts.list();
const preview = (f, id = saved(f)[0].id) => {
  const value = f.runtime.session.receipts.prepare({ ids: [id] });
  return { value, bytes: f.runtime.session.receipts.export(value.previewId) };
};

for (const unavailable of ['policy', 'transport']) test(`page indicator recovers from ${unavailable} unavailability through OFF and ON with fresh policy only`, async t => {
  let status = { kind: 'PAP_CAPTURE_POLICY', pageContract: CHATGPT_PAGE_CONTRACT,
    browserSessionId: 'synthetic-policy-session', revision: 0, state: 'RECORDING_UNAVAILABLE', policy: null };
  const replies = [], captured = [];
  const page = pageFixture({ draft: 'POLICY_SYNTHETIC', capture: async message => {
    if (message.kind === 'PAP_CAPTURE_STATUS') {
      if (unavailable === 'transport' && status.revision === 0) throw Error('SYNTHETIC_DISCONNECT');
      return status;
    }
    captured.push(message);
    return new Promise(resolve => replies.push(() => resolve({ profile: CHATGPT_CAPTURE_PROFILE,
      eventId: message.eventId, kind: message.observationKind, state: 'PROMPT_SAVED' })));
  } });
  t.after(() => page.close());
  const update = async (state, policy = null) => {
    status = { ...status, revision: status.revision + 1, state, policy }; await page.send(status);
  };
  const policy = token => ({ profile: CHATGPT_CAPTURE_PROFILE, token,
    expectedUrl: page.location.href, destination: 'conversation:test-conversation' });
  const send = () => page.event('click', { isTrusted: true, target: page.button, button: 0, detail: 1 });
  await until(() => page.feedback === 'Attestamp · Recording unavailable');
  const stale = structuredClone(status);
  await update('OFF'); assert.equal(page.feedback, '');
  await page.send(stale); assert.equal(page.feedback, '');
  send(); assert.equal(captured.length, 0);
  await update('READY', policy('first-token')); assert.equal(page.feedback, 'Attestamp · ON');
  send(); assert.equal(page.feedback, 'Attestamp · Saving prompt…');
  await update('RECORDING_UNAVAILABLE'); assert.match(page.feedback, /Recording gap/);
  await update('OFF'); assert.equal(page.feedback, '');
  replies[0](); await new Promise(setImmediate); assert.equal(page.feedback, '');
  const off = structuredClone(status);
  await update('READY', policy('second-token')); assert.equal(page.feedback, 'Attestamp · ON');
  await page.send(off); assert.equal(page.feedback, 'Attestamp · ON');
  send(); replies[1](); await until(() => page.feedback === 'Attestamp · Prompt saved');
  await update('READY', status.policy); assert.equal(page.feedback, 'Attestamp · Prompt saved');
  assert.equal(captured.length, 2); assert.equal(page.clicks(), 0); assert.equal(page.injections(), 0);
});

test('a late failed policy refresh cannot overwrite newer OFF or ON state', async t => {
  for (const enabled of [false, true]) {
    let rejectRefresh;
    const page = pageFixture({ capture: () => new Promise((_resolve, reject) => { rejectRefresh = reject; }) });
    t.after(() => page.close());
    await page.send({ kind: 'PAP_CAPTURE_POLICY', pageContract: CHATGPT_PAGE_CONTRACT,
      browserSessionId: 'synthetic-fresh-policy', revision: 1, state: enabled ? 'READY' : 'OFF',
      policy: enabled ? { profile: CHATGPT_CAPTURE_PROFILE, token: 'fresh-token',
        expectedUrl: page.location.href, destination: 'conversation:test-conversation' } : null });
    rejectRefresh(Error('SYNTHETIC_OLD_REFRESH_FAILURE')); await new Promise(setImmediate);
    assert.equal(page.feedback, enabled ? 'Attestamp · ON' : '');
  }
});

test('ON follows existing and newly opened duplicate-conversation tabs across windows without a control command', async t => {
  const f = await fixture(t); await f.recording(true);
  f.send('EXISTING_WINDOW_ONE', { id: 17 }); f.send('EXISTING_WINDOW_TWO', { id: 18 });
  await until(() => saved(f).length === 2);
  const duplicate = await f.addTab(19, { windowId: 3, active: false, url: 'https://chatgpt.com/c/fixture-17' });
  assert.equal(duplicate.destination, 'conversation:fixture-17');
  assert.notEqual(duplicate.scope, f.scopes.get(17));
  f.send('NEW_DUPLICATE_WINDOW', { id: 19 });
  await until(() => saved(f).length === 3); await f.runtime.engine.drain();
  assert.deepEqual(new Set(f.sources.map(source => source.windowId)), new Set([1, 2, 3]));
  assert.equal(f.anchorCalls, 3); assert.equal(f.releases.length, 0); assert.equal(f.prevention, 0);
});

test('normal user sends retain exact bytes with retrospective source assertions and no release authority', async t => {
  const diagnostics = new LocalDiagnostics(), f = await fixture(t, { diagnostics });
  await f.recording(true);
  f.send(exact); f.appear(exact);
  await until(() => f.results.some(value => value.result.kind === 'message-observed'));
  await f.runtime.engine.drain();
  assert.equal(f.pages.get(17).feedback, 'Attestamp · Prompt saved');
  assert.equal(saved(f).length, 1);
  const exported = preview(f), report = verifyPortable(exported.bytes);
  assert.equal(exported.value.texts[0].preview, exact);
  const target = report.records.find(record => record.localAssertions.some(value => value.kind === 'normal-send-intent'));
  assert.equal(target.releaseControl, 'OBSERVED_ONLY');
  assert.equal(target.localAssertions[0].source.destination, 'conversation:fixture-17');
  assert.equal(target.localAssertions[0].textAssociation, 'SIGNED_TEXT_REFERENCE');
  assert.ok(target.localAssertions.some(value => value.kind === 'normal-message-observed' && value.providerReceipt === 'UNKNOWN'));
  assert.equal(target.anchor, 'INDETERMINATE');
  assert.equal(f.anchorCalls, 1); assert.equal(f.confirmed, 1);
  assert.equal(f.releases.length, 0); assert.equal(f.prevention, 0);
  assert.equal(f.runtime.session.runtime, undefined);
  for (const page of f.pages.values()) { assert.equal(page.clicks(), 0); assert.equal(page.injections(), 0); }
  const events = JSON.stringify(diagnostics.preview().report);
  assert.ok(!events.includes(exact)); assert.ok(!events.includes('conversation:fixture-17'));
  assert.ok(!events.includes(f.sources[0].documentId));
});

test('equal-text genuine sends are distinct while duplicate native delivery is idempotent', async t => {
  const f = await fixture(t); await f.recording(true);
  f.send(exact); await until(() => f.results.some(value => value.result.kind === 'send-intent'));
  const first = f.deliveries[0]; f.replay(first); f.replay(first);
  await until(() => f.results.length >= 3);
  assert.equal(saved(f).length, 1);
  f.send(exact); await until(() => saved(f).length === 2); await f.runtime.engine.drain();
  assert.notEqual(saved(f)[0].recordDigest, saved(f)[1].recordDigest);
  const records = f.runtime.session.vault.inspect().records;
  assert.equal(records.find(value => value.manifest.eventId === saved(f)[0].textRecordId).manifest.evidence[0].objectDigest,
    records.find(value => value.manifest.eventId === saved(f)[1].textRecordId).manifest.evidence[0].objectDigest);
  const before = f.results.length;
  f.replay({ ...first, observation: { ...first.observation, textBytes: Buffer.from('conflicting').toString('base64') } });
  await until(() => f.results.length > before);
  assert.equal(f.results.at(-1).result.state, 'RECORDING_UNAVAILABLE');
  assert.equal(saved(f).length, 2); assert.equal(f.anchorCalls, 2); assert.equal(f.releases.length, 0);
});

test('typing, hydration, synthetic clicks, IME commit and alternate Enter chords create no prompt events', async t => {
  const f = await fixture(t); await f.recording(true); const page = f.pages.get(17);
  page.text = exact; f.appear(exact); page.changed();
  f.send(exact, { trusted: false });
  for (const event of [{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true },
    { repeat: true }, { isComposing: true }, { keyCode: 229 }]) f.send(exact, { method: 'enter', ...event });
  page.event('compositionstart'); f.send(exact, { method: 'enter' });
  page.event('compositionend'); f.send(exact, { method: 'enter' });
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(saved(f).length, 0); assert.equal(f.deliveries.length, 0);
  f.send(exact, { method: 'enter' }); await until(() => saved(f).length === 1);
  assert.equal(f.deliveries[0].observation.inputMethod, 'enter'); assert.equal(f.prevention, 0);
});

test('ON automatically follows multiple tabs and source navigation cannot mix prompts', async t => {
  const f = await fixture(t);
  f.send('OFF'); f.send('ALSO_OFF', { id: 18 });
  await f.recording(true); f.send('first-tab'); f.send('second-tab', { id: 18 });
  await until(() => saved(f).length === 2);
  assert.deepEqual(saved(f).map(value => preview(f, value.id).value.texts[0].preview).sort(), ['first-tab', 'second-tab']);
  const old = f.deliveries.find(value => value.observation.source.tabId === 17);
  f.navigate(); await until(() => !f.runtime.adapter.scopes().some(value => value.scope === f.scopes.get(17)));
  const before = f.results.length; f.replay(old);
  await until(() => f.results.length > before);
  assert.equal(f.results.at(-1).result.state, 'RECORDING_UNAVAILABLE');
  f.send('still-second', { id: 18 }); await until(() => saved(f).length === 3);
  assert.equal(f.releases.length, 0);
});

test('lost acknowledgement retries evidence delivery once without repeating the user send', async t => {
  const f = await fixture(t, { dropAck: true }); await f.recording(true);
  f.send(exact);
  await until(() => f.pages.get(17).feedback === 'Attestamp · Prompt saved');
  await f.runtime.engine.drain();
  assert.equal(f.deliveries.length, 2);
  assert.deepEqual(f.deliveries[0].observation, f.deliveries[1].observation);
  assert.equal(saved(f).length, 1); assert.equal(f.userSends, 1); assert.equal(f.anchorCalls, 1);
  assert.equal(f.releases.length, 0); assert.equal(f.prevention, 0);
});

test('vault and key failures never announce a save or block the provider action', async t => {
  for (const fault of ['storageFault', 'keyFault']) await t.test(fault, async t => {
    const f = await fixture(t); await f.recording(true); f[fault](); f.send(exact);
    await until(() => /gap|unavailable/.test(f.pages.get(17).feedback));
    assert.equal(saved(f).length, 0);
    assert.ok(!f.results.some(value => value.result.state === 'PROMPT_SAVED'));
    assert.equal(f.userSends, 1); assert.equal(f.prevention, 0); assert.equal(f.releases.length, 0);
    assert.equal(f.anchorCalls, 0);
  });
});

test('bridge loss and OFF revoke capture tokens without restoring them on resume', async t => {
  const f = await fixture(t); await f.recording(true);
  f.send(exact); await until(() => f.results.length > 0);
  const old = f.deliveries[0];
  await f.command('SET_RECORDING', { enabled: false });
  await f.command('SET_RECORDING', { enabled: true });
  await f.refresh();
  const before = f.results.length; f.replay(old);
  await until(() => f.results.length > before);
  assert.equal(f.results.at(-1).result.state, 'RECORDING_UNAVAILABLE');
  assert.equal(saved(f).length, 1);
  f.disconnect(); await until(() => /unavailable|gap|unconfirmed/.test(f.pages.get(17).feedback));
  f.send('after-disconnect'); await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(saved(f).length, 1); assert.equal(f.userSends, 2); assert.equal(f.prevention, 0);
});

test('supported textarea and paragraph projections preserve edits and explicit line boundaries', async t => {
  for (const textarea of [false, true]) await t.test(String(textarea), async t => {
    const f = await fixture(t, { textarea }); await f.recording(true); const page = f.pages.get(17);
    page.text = 'obsolete draft';
    const text = textarea ? exact : 'first e\u0301\nsecond  \n';
    if (textarea) page.text = text;
    else {
      const a = new page.Element('P', 'first e\u0301'), b = new page.Element('P', 'second  '), blank = new page.Element('P');
      blank.replaceChildren(new page.Element('BR')); page.editor.replaceChildren(a, b, blank);
    }
    f.send(undefined); await until(() => saved(f).length === 1);
    assert.equal(preview(f).value.texts[0].preview, text);
    assert.equal(page.injections(), 0); assert.equal(page.clicks(), 0);
  });
});

test('unsupported rich content, attachments and ambiguous controls report gaps without inferred events', async t => {
  for (const drift of ['attachment', 'rich', 'hidden', 'ambiguous']) await t.test(drift, async t => {
    const f = await fixture(t); await f.recording(true); const page = f.pages.get(17); page.text = exact;
    if (drift === 'attachment') page.attachments = true;
    if (drift === 'rich') page.editor.replaceChildren(new page.Element('IMG'));
    if (drift === 'hidden') page.editor.visible = false;
    if (drift === 'ambiguous') page.buttons.push(page.button);
    f.send(undefined); await until(() => /gap|unavailable/.test(page.feedback));
    assert.equal(saved(f).length, 0); assert.equal(f.deliveries.length, 0); assert.equal(f.prevention, 0);
  });
});

test('hydrated message IDs and ambiguous equal-text appearances cannot supply message assertions', async t => {
  const f = await fixture(t); await f.recording(true); const page = f.pages.get(17);
  f.appear(exact, 17, 'old-message');
  f.send(exact); await until(() => f.results.some(value => value.result.kind === 'send-intent'));
  page.messages = []; f.appear(exact, 17, 'old-message');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.ok(!f.deliveries.some(value => value.observation.kind === 'message-observed'));
  f.send(exact); await until(() => saved(f).length === 2);
  f.appear(exact); await new Promise(resolve => setTimeout(resolve, 40));
  assert.ok(!f.deliveries.some(value => value.observation.kind === 'message-observed'));
});

test('new observations survive restart and cannot inherit a fabricated legacy release assertion', async t => {
  const f = await fixture(t); await f.recording(true); f.send(exact); f.appear(exact);
  await until(() => f.results.some(value => value.result.kind === 'message-observed')); await f.runtime.engine.drain();
  const descriptor = f.runtime.engine.state().operations[0].result;
  const bytes = preview(f).bytes, before = verifyPortable(bytes);
  f.runtime.session.vault.capture(Buffer.from(canonical({ profile: 'pap-chatgpt-observation/1', kind: 'release-outcome',
    recordDigest: descriptor.recordDigest, mode: 'Sealed', releaseClass: 'PRE_DISCLOSURE_PROTECTED', state: 'SUBMISSION_OBSERVED' })), { type: 'observation' });
  const exported = verifyPortable(preview(f).bytes);
  assert.equal(exported.records.find(value => value.recordDigest === descriptor.recordDigest).releaseControl, 'OBSERVED_ONLY');
  await f.restart();
  assert.deepEqual(verifyPortable(bytes), before);
  assert.equal(saved(f).length, 1); assert.equal(f.runtime.engine.state().scopes.length, 0);
  assert.equal(f.runtime.session.status().versions[0].anchor, 'SOURCE_CORROBORATED');
  assert.equal(f.runtime.engine.state().operations[0].state, 'PROMPT_SAVED');
  assert.equal(f.runtime.session.runtime, undefined);
});

test('an older delayed save cannot hide a newer recording gap', async t => {
  const f = await fixture(t, { dropAck: true }); await f.recording(true);
  f.send(exact); await until(() => f.results.length === 1);
  const page = f.pages.get(17); page.editor.readOnly = true;
  f.send(undefined); assert.match(page.feedback, /gap/);
  page.editor.readOnly = false;
  await until(() => f.results.length === 2);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.match(page.feedback, /gap/); assert.equal(saved(f).length, 1); assert.equal(f.prevention, 0);
});

test('interruption between exact bytes, signed intent and engine metadata never returns premature success', async t => {
  for (const stage of ['intent', 'engine-state']) await t.test(stage, async t => {
    const f = await fixture(t); await f.recording(true);
    const vault = f.runtime.session.vault, capture = vault.capture.bind(vault);
    vault.capture = (bytes, options) => {
      let value; try { value = JSON.parse(bytes); } catch {}
      if (stage === 'intent' && value?.kind === 'normal-send-intent'
          || stage === 'engine-state' && value?.profile === 'pap-resident-state/2') {
        throw Error('SYNTHETIC_DURABILITY_INTERRUPTION');
      }
      return capture(bytes, options);
    };
    f.send(exact); await until(() => f.results.length > 0);
    assert.ok(!f.results.some(value => value.result.state === 'PROMPT_SAVED'));
    assert.match(f.pages.get(17).feedback, /gap|unavailable/);
    assert.equal(saved(f).length, stage === 'intent' ? 0 : 1);
    assert.equal(f.releases.length, 0); assert.equal(f.anchorCalls, 0); assert.equal(f.prevention, 0);
    vault.capture = capture;
  });
});

test('keyboard activation and synthesized follow-on clicks represent one intent per genuine action', async t => {
  const f = await fixture(t); await f.recording(true); const page = f.pages.get(17);
  f.send(exact, { method: 'enter' });
  page.event('click', { isTrusted: true, target: page.button, button: 0, detail: 0 });
  await until(() => saved(f).length === 1);
  page.event('keydown', { isTrusted: true, target: page.button, key: 'Enter' });
  page.event('click', { isTrusted: true, target: page.button, button: 0, detail: 0 });
  await until(() => saved(f).length === 2);
  assert.deepEqual(f.deliveries.map(value => value.observation.inputMethod), ['enter', 'send-button']);
  assert.equal(page.clicks(), 0); assert.equal(page.injections(), 0);
});

test('UTF-8 BOM and the maximum escaped payload survive native framing and restart exactly', async t => {
  const f = await fixture(t, { textarea: true }); await f.recording(true);
  const text = '\uFEFF' + '\0'.repeat(256 * 1024 - 3);
  f.send(text); await until(() => saved(f).length === 1); await f.runtime.engine.drain();
  const receipt = saved(f)[0], readText = () => {
    const record = f.runtime.session.vault.inspect().records.find(value => value.manifest.eventId === receipt.textRecordId);
    return f.runtime.session.vault.read(record.manifest.evidence[0].objectDigest);
  };
  assert.deepEqual(readText(), Buffer.from(text));
  assert.ok(f.deliveries[0].observation.textBytes.length > 256 * 1024);
  f.send('\0'.repeat(256 * 1024 + 1));
  assert.match(f.pages.get(17).feedback, /gap/); assert.equal(f.deliveries.length, 1);
  await f.restart(); assert.deepEqual(readText(), Buffer.from(text));
  assert.equal(f.runtime.session.status().versions[0].recordDigest, f.runtime.engine.state().operations[0].result.recordDigest);
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
    assert.ok(f.deliveries.every(value => value.observation.kind === 'send-intent'));
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

test('a saved prompt keeps simple success feedback when later message correlation expires', async t => {
  const timers = new Set();
  const page = pageFixture({ draft: exact, capture: async message => message.kind === 'PAP_CAPTURE_STATUS'
    ? { kind: 'PAP_CAPTURE_POLICY', pageContract: CHATGPT_PAGE_CONTRACT, browserSessionId: 'copy-test', revision: 1,
      policy: { profile: CHATGPT_CAPTURE_PROFILE, token: 'test-copy-token', expectedUrl: 'https://chatgpt.com/c/test-conversation', destination: 'conversation:test-conversation' }, state: 'READY' }
    : { profile: CHATGPT_CAPTURE_PROFILE, eventId: message.eventId, kind: message.observationKind, state: 'PROMPT_SAVED' },
  clock: { performance, setTimeout(callback, delay) { const timer = { callback, delay }; timers.add(timer); return timer; }, clearTimeout(timer) { timers.delete(timer); } } });
  t.after(() => page.close());
  await until(() => page.feedback === 'Attestamp · ON');
  page.event('click', { isTrusted: true, target: page.button, button: 0, detail: 1 });
  await until(() => page.feedback === 'Attestamp · Prompt saved');
  [...timers].find(timer => timer.delay === 10000).callback();
  assert.equal(page.feedback, 'Attestamp · Prompt saved');
});

for (const change of ['OFF/ON', 'reload', 'second navigation']) test(`a confirmed New-chat snapshot loses authority after ${change} during proof delivery`, async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  t.after(() => release());
  const f = await fixture(t, { newChat: true }); await f.recording(true);
  const inspect = f.worker.chrome.tabs.sendMessage;
  f.worker.chrome.tabs.sendMessage = async (id, message, options) => {
    const result = await inspect(id, message, options);
    if (message.kind === 'PAP_CONFIRM_NEW_CHAT') { entered(); await gate; }
    return result;
  };
  f.send(exact); await started;
  f.navigate(17, 'https://chatgpt.com/c/created-by-send');
  if (change === 'OFF/ON') { await f.recording(false); await f.recording(true); }
  if (change === 'reload') f.worker.chrome.tabs.onUpdated.emit(17, { status: 'loading' });
  if (change === 'second navigation') f.navigate(17, 'https://chatgpt.com/c/unrelated');
  release(); await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(saved(f).length, 0); assert.equal(f.deliveries.length, 0); assert.equal(f.prevention, 0);
});

test('same-document navigation alone cannot authenticate an unobserved first Send', async t => {
  const f = await fixture(t, { newChat: true }); await f.recording(true);
  const policy = f.runtime.engine.capturePolicy().find(value => value.tabId === 17);
  f.navigate(17, 'https://chatgpt.com/c/unrelated');
  const page = f.pages.get(17);
  const result = await f.worker.message({ kind: 'PAP_CAPTURE', pageContract: CHATGPT_PAGE_CONTRACT,
    token: policy.token, eventId: crypto.randomUUID(), observationKind: 'send-intent', inputMethod: 'send-button', text: exact }, page.captureSender());
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
