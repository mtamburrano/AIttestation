import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { recordingFixture, until } from './recording-fixture.mjs';
import { verifyPortable } from '../spikes/recipient/portable.mjs';
import { LocalDiagnostics } from '../spikes/diagnostics/local.mjs';
import { canonical } from '../spikes/vault/format.mjs';
import { pageFixture } from './chatgpt-page-fixture.mjs';
import { CHATGPT_PAGE_CONTRACT, SURFACE_CHURN_MS } from '../spikes/browser/chatgpt/adapter.mjs';
import { CHATGPT_CAPTURE_PROFILE } from '../spikes/browser/chatgpt/capture.mjs';

const exact = 'SYNTHETIC_NORMAL_e\u0301\r\n☕  ';
async function fixture(t, options) {
  const root = await mkdtemp('/private/tmp/attestamp-capture-test-');
  let f;
  t.after(async () => { await f?.close(); await rm(root, { recursive: true, force: true }); });
  f = await recordingFixture(root, options); return f;
}
const saved = f => f.runtime.session.receipts.list();
// Status that reaches the page is push- or poll-driven, so allow a bounded
// window for it instead of a single fixed wait under parallel test load.
async function untilWithin(check, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await check()) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return false;
}
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

test('unsupported rich content and ambiguous controls report gaps without inferred events', async t => {
  for (const drift of ['rich', 'ambiguous']) await t.test(drift, async t => {
    const f = await fixture(t); await f.recording(true); const page = f.pages.get(17); page.text = exact;
    if (drift === 'rich') page.editor.replaceChildren(new page.Element('IMG'));
    if (drift === 'ambiguous') page.buttons.push(page.button);
    f.send(undefined); await until(() => /gap|unavailable/.test(page.feedback));
    assert.equal(saved(f).length, 0); assert.equal(f.deliveries.length, 0); assert.equal(f.prevention, 0);
  });
});

// Every stable DOM capability that makes a new Send unobservable must reach the
// indicator in the same task that sees it, with no worker or native reply
// awaited, and the next deliberate Send must then be refused instead of gapping
// under a displayed ON.
const ineligibleSurfaces = [
  { drift: 'attachment', method: 'send-button',
    apply: page => { page.attachments = true; }, restore: page => { page.attachments = false; } },
  { drift: 'missing-control', method: 'send-button',
    apply: page => { page.buttons = []; }, restore: page => { page.buttons = [page.button]; } },
  { drift: 'disabled-control', method: 'send-button',
    apply: page => { page.button.disabled = true; }, restore: page => { page.button.disabled = false; } },
  { drift: 'aria-disabled-control', method: 'enter',
    apply: page => { page.button.ariaDisabled = true; }, restore: page => { page.button.ariaDisabled = false; } },
  { drift: 'hidden-control', method: 'send-button',
    apply: page => { page.button.visible = false; }, restore: page => { page.button.visible = true; } },
  { drift: 'readonly-editor', method: 'enter',
    apply: page => { page.editor.readOnly = true; }, restore: page => { page.editor.readOnly = false; } },
  { drift: 'disabled-editor', method: 'send-button',
    apply: page => { page.editor.disabled = true; }, restore: page => { page.editor.disabled = false; } },
  { drift: 'hidden-editor', method: 'enter',
    apply: page => { page.editor.hidden = true; }, restore: page => { page.editor.hidden = false; } },
  { drift: 'hidden-editor-style', method: 'send-button',
    apply: page => { page.editor.visible = false; }, restore: page => { page.editor.visible = true; } },
];
for (const { drift, method, apply, restore } of ineligibleSurfaces)
  test(`an ineligible ${drift} surface is refused in the same task as the next ${method} Send`, async t => {
    const f = await fixture(t); await f.recording(true); const page = f.pages.get(17);
    page.text = exact;
    assert.equal(page.feedback, 'Attestamp · ON');
    const before = saved(f).length;
    apply(page); page.changed();
    // No worker or native reply is awaited: the document must withdraw ON from
    // its own observation, in the same task that saw the change.
    assert.equal(page.feedback, 'Attestamp · Recording unavailable',
      `${drift} must not keep advertising ON before its Send is refused`);
    f.send(undefined, { method });
    // The refusal is immediate and stays a refusal; it never becomes a saving
    // Send, a gap, a delivery or durable evidence.
    const observed = []; let pending = true;
    const sample = () => { if (pending) observed.push(page.feedback); };
    const sampler = setInterval(sample, 5); sample();
    await new Promise(resolve => setTimeout(resolve, 60)); pending = false; clearInterval(sampler);
    assert.equal(page.feedback, 'Attestamp · Recording unavailable');
    assert.ok(observed.every(value => value === 'Attestamp · Recording unavailable'),
      `${drift} moved through ${JSON.stringify([...new Set(observed)])}`);
    assert.equal(saved(f).length, before); assert.equal(f.deliveries.length, 0); assert.equal(f.prevention, 0);
    // A worker READY that predates this observation is still only the worker's
    // claim; it cannot raise what this document already knows it cannot do.
    await f.refresh(); assert.equal(page.feedback, 'Attestamp · Recording unavailable');
    // Restoring the surface clears the withdrawal but does not by itself claim
    // ON again: only the worker republishing READY restores the advertised state.
    restore(page); page.changed();
    assert.equal(page.feedback, 'Attestamp · Recording unavailable');
    assert.ok(page.checks.every(check => check.kind === 'PAP_PAGE_DIAGNOSTIC'),
      `the refused Send reached the worker: ${JSON.stringify(page.checks.map(check => check.kind))}`);
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

test('an unobserved Send creates no evidence while an earlier capture is live', async t => {
  const f = await fixture(t); await f.recording(true);
  f.send(exact); await until(() => saved(f).length === 1);
  const page = f.pages.get(17);
  // A later Send on a surface this document can see is unobservable is refused
  // on the spot: it is never read, never delivered and never durable, and the
  // indicator carries that refusal rather than a pending save.
  page.editor.readOnly = true; page.changed();
  f.send(undefined);
  // The refusal is immediate, and the earlier capture that is still being
  // observed keeps its own outcome rather than being replaced by this Send.
  assert.notEqual(page.feedback, 'Attestamp · Saving prompt…');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.notEqual(page.feedback, 'Attestamp · Saving prompt…');
  assert.equal(f.deliveries.length, 1); assert.equal(saved(f).length, 1); assert.equal(f.prevention, 0);
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

test('a genuine steering Send during generation survives provider composer control churn', async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  t.after(() => release());
  let inspections = 0;
  const f = await fixture(t, { beforeCapture: async () => { entered(); await gate; } });
  const inspect = f.worker.chrome.tabs.sendMessage;
  f.worker.chrome.tabs.sendMessage = async (id, message, options) => {
    const result = await inspect(id, message, options);
    if (message.kind === 'PAP_INSPECT') inspections++;
    return result;
  };
  await f.recording(true);
  const page = f.pages.get(17), scope = f.runtime.adapter.scopes().find(source => source.tabId === 17).scope;
  f.send(exact);
  await started;
  // The provider re-renders its composer while generating: the Send control is
  // momentarily duplicated and then restored, exactly as the observed real
  // sequence did. The captured Send must not be discarded by that churn.
  const controls = page.buttons, before = inspections;
  page.buttons = [page.button, page.button]; page.changed();
  await until(() => inspections > before);
  page.buttons = controls; page.changed();
  release();
  await until(() => saved(f).length === 1);
  await f.runtime.engine.drain();
  assert.equal(preview(f).value.texts[0].preview, exact);
  assert.equal(f.runtime.adapter.scopes().find(source => source.tabId === 17).scope, scope,
    'composer churn keeps the same capture scope');
  assert.equal(f.sources[0].destination, 'conversation:fixture-17');
  assert.equal(f.prevention, 0);
});

test('sustained loss of the supported surface still reports unavailable', async t => {
  const f = await fixture(t, {}); await f.recording(true);
  const page = f.pages.get(17), scope = f.runtime.adapter.scopes().find(source => source.tabId === 17).scope;
  assert.equal(f.runtime.adapter.observationEligible(scope), true);
  const controls = page.buttons;
  page.buttons = [page.button, page.button]; page.changed();
  await until(() => f.runtime.adapter.observationEligible(scope) === false);
  assert.equal(f.runtime.engine.captureStates().find(value => value.tabId === 17).state, 'RECORDING_UNAVAILABLE');
  page.buttons = controls; page.changed();
  await until(() => f.runtime.adapter.observationEligible(scope) === true);
  assert.equal(f.runtime.engine.captureStates().find(value => value.tabId === 17).state, 'READY');
});

test('authoritative OFF clears the page indicator while the surface stays unsupported', async t => {
  const f = await fixture(t, {}); await f.recording(true);
  const page = f.pages.get(17);
  assert.equal(page.feedback, 'Attestamp · ON');
  const controls = page.buttons;
  // The provider exposes an ambiguous Send control, so this document withdraws
  // its own availability before any worker or native round-trip.
  page.buttons = [page.button, page.button]; page.changed();
  assert.equal(page.feedback, 'Attestamp · Recording unavailable');
  await until(async () => (await f.refresh()).state === 'RECORDING_UNAVAILABLE');
  // The owner then turns recording OFF while the surface is still unsupported.
  // OFF is an authoritative statement about consent, not a capability claim, so
  // it must clear the unavailable indicator instead of being withheld by it.
  await f.recording(false);
  assert.equal(page.feedback, '', 'an unavailable indicator must not outlive OFF');
  const off = await f.refresh();
  assert.equal(off.state, 'OFF'); assert.equal(off.policy, null);
  assert.equal(f.runtime.engine.state().recording, false);
  // A genuine Send on the still-unsupported surface stays a non-capture: no
  // observation, no delivery and no durable evidence.
  f.send(exact);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(page.feedback, ''); assert.equal(page.clicks(), 0); assert.equal(page.injections(), 0);
  // Recovering the surface does not re-enable anything by itself: only a later,
  // explicit ON republishes READY.
  page.buttons = controls; page.changed();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(page.feedback, ''); assert.equal(f.deliveries.length, 0); assert.equal(saved(f).length, 0);
  await f.recording(true);
  await until(() => page.feedback === 'Attestamp · ON');
  assert.equal(f.deliveries.length, 0); assert.equal(saved(f).length, 0); assert.equal(f.prevention, 0);
});

test('a churn window closes and republishes without any further provider event', async t => {
  let inspections = 0;
  const f = await fixture(t, {});
  const inspect = f.worker.chrome.tabs.sendMessage;
  f.worker.chrome.tabs.sendMessage = async (id, message, options) => {
    const result = await inspect(id, message, options);
    if (message.kind === 'PAP_INSPECT') inspections++;
    return result;
  };
  await f.recording(true);
  const page = f.pages.get(17), scope = f.runtime.adapter.scopes().find(source => source.tabId === 17).scope;
  const policy = f.runtime.engine.capturePolicy().find(value => value.tabId === 17);
  assert.ok(policy);
  // The provider reports an ambiguous Send surface once. From here nothing else
  // reaches the adapter: the expiry must republish on its own.
  const controls = page.buttons, before = inspections;
  page.buttons = [page.button, page.button]; page.changed();
  await until(() => inspections > before);
  // The surface cannot synchronously observe a new Send, so READY is withdrawn
  // at once, while the retained policy still covers an already-observed Send.
  await until(async () => (await f.refresh()).state === 'RECORDING_UNAVAILABLE');
  assert.ok((await f.refresh()).policy, 'the grace retains capture authority');
  await new Promise(resolve => setTimeout(resolve, SURFACE_CHURN_MS + 500));
  await until(() => !f.runtime.adapter.observationEligible(scope));
  // The worker's published policy and state are what actually withdraw capture,
  // so probe them rather than the lazily evaluated adapter predicate.
  const published = await f.refresh();
  assert.equal(published.state, 'RECORDING_UNAVAILABLE');
  assert.equal(published.policy, null);
  // The retired policy cannot deliver a capture once the window has closed.
  const stale = await f.worker.message({ kind: 'PAP_CAPTURE', pageContract: CHATGPT_PAGE_CONTRACT, token: policy.token,
    eventId: crypto.randomUUID(), observationKind: 'send-intent', inputMethod: 'send-button', text: exact }, page.captureSender());
  assert.equal(stale.state, 'RECORDING_UNAVAILABLE');
  assert.equal(saved(f).length, 0);
  // The worker and page indicators must lose READY too, with no further provider
  // event. The page learns this from the worker push or its own one-second poll.
  assert.ok(await untilWithin(() => page.feedback === 'Attestamp · Recording unavailable', 15_000),
    `page indicator stayed ${JSON.stringify(page.feedback)}`);
  page.buttons = controls; page.changed();
});

test('staggered multi-tab churn expires each tab without further provider events', async t => {
  let inspections = 0;
  const f = await fixture(t, {});
  const inspect = f.worker.chrome.tabs.sendMessage;
  f.worker.chrome.tabs.sendMessage = async (id, message, options) => {
    const result = await inspect(id, message, options);
    if (message.kind === 'PAP_INSPECT') inspections++;
    return result;
  };
  await f.recording(true);
  const pageA = f.pages.get(17), pageB = f.pages.get(18);
  const scopeA = f.runtime.adapter.scopes().find(source => source.tabId === 17).scope;
  const scopeB = f.runtime.adapter.scopes().find(source => source.tabId === 18).scope;
  const policyB = f.runtime.engine.capturePolicy().find(value => value.tabId === 18);
  assert.ok(policyB);
  // The worker's published view, not the lazily evaluated adapter predicate, is
  // what decides whether a tab is still offered capture.
  assert.equal((await f.refresh(17)).state, 'READY'); assert.equal((await f.refresh(18)).state, 'READY');
  const controlsA = pageA.buttons, controlsB = pageB.buttons;
  // Tab A enters churn first.
  let before = inspections;
  pageA.buttons = [pageA.button, pageA.button]; pageA.changed();
  await until(() => inspections > before);
  // Let A's window age, then let a tab event refresh B's observability so the two
  // deadlines differ. After B enters churn nothing else reaches the adapter.
  await new Promise(resolve => setTimeout(resolve, 1200));
  before = inspections;
  f.worker.chrome.tabs.onActivated.emit();
  await until(() => inspections > before);
  pageB.buttons = [pageB.button, pageB.button]; pageB.changed();
  await until(() => inspections > before + 1);
  // A is retired first; B keeps its own grace because its churn started later.
  await until(async () => (await f.refresh(17)).policy === null);
  assert.equal(f.runtime.adapter.observationEligible(scopeA), false);
  assert.ok((await f.refresh(18)).policy, 'B retains its own grace after A is retired');
  // B must then retire from its own re-armed deadline, with no further event.
  await until(async () => (await f.refresh(18)).policy === null);
  assert.equal(f.runtime.adapter.observationEligible(scopeB), false);
  assert.equal(pageB.feedback, 'Attestamp · Recording unavailable');
  const stale = await f.worker.message({ kind: 'PAP_CAPTURE', pageContract: CHATGPT_PAGE_CONTRACT, token: policyB.token,
    eventId: crypto.randomUUID(), observationKind: 'send-intent', inputMethod: 'send-button', text: exact }, pageB.captureSender());
  assert.equal(stale.state, 'RECORDING_UNAVAILABLE');
  assert.equal(saved(f).length, 0); assert.equal(f.prevention, 0);
  pageA.buttons = controlsA; pageA.changed();
  pageB.buttons = controlsB; pageB.changed();
});

test('an ambiguous surface withdraws READY in the same task, before the next Send', async t => {
  const f = await fixture(t, {});
  await f.recording(true);
  const page = f.pages.get(17);
  assert.equal(page.feedback, 'Attestamp · ON');
  assert.equal((await f.refresh()).state, 'READY');
  // The provider exposes ambiguous Send controls and a genuine click follows in
  // the next input task. No worker or native round-trip is awaited here: the
  // document must stop advertising ON from its own observation, in the same task
  // that saw the churn.
  const controls = page.buttons;
  page.buttons = [page.button, page.button]; page.changed();
  assert.equal(page.feedback, 'Attestamp · Recording unavailable',
    'the indicator must not stay ON while a Send cannot be observed');
  const before = saved(f).length; f.send(exact);
  // The refusal is what the owner was already told; it must not turn into a gap
  // message that suggests a Send was lost after a truthful warning, and no
  // capture may reach the engine.
  assert.equal(page.feedback, 'Attestamp · Recording unavailable');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(page.feedback, 'Attestamp · Recording unavailable');
  assert.equal(saved(f).length, before); assert.equal(f.deliveries.length, 0); assert.equal(f.prevention, 0);
  // The worker's own advertised view agrees once the round-trip lands, and the
  // retained policy still carries the bounded grace for an already-observed Send.
  await until(async () => (await f.refresh()).state === 'RECORDING_UNAVAILABLE');
  assert.ok((await f.refresh()).policy, 'the grace retains capture authority');
  page.buttons = controls; page.changed();
  await until(() => page.feedback === 'Attestamp · ON');
  await until(async () => (await f.refresh()).state === 'READY');
});

test('a stale READY reply cannot restore ON after the surface already churned', async t => {
  let status = { kind: 'PAP_CAPTURE_POLICY', pageContract: CHATGPT_PAGE_CONTRACT,
    browserSessionId: 'synthetic-churn-session', revision: 0, state: 'OFF', policy: null };
  const page = pageFixture({ draft: 'SYNTHETIC_CHURN', capture: async message => message.kind === 'PAP_CAPTURE_STATUS'
    ? status : { profile: CHATGPT_CAPTURE_PROFILE, eventId: message.eventId, kind: message.observationKind, state: 'PROMPT_SAVED' } });
  t.after(() => page.close());
  await page.send(status);
  // The retained policy is the worker's last word before it has seen the churn.
  const policy = { profile: CHATGPT_CAPTURE_PROFILE, token: 'retained-token',
    expectedUrl: page.location.href, destination: 'conversation:test-conversation' };
  status = { ...status, revision: 1, state: 'READY', policy }; await page.send(status);
  assert.equal(page.feedback, 'Attestamp · ON');
  const controls = page.buttons;
  page.buttons = [page.button, page.button]; page.changed();
  assert.equal(page.feedback, 'Attestamp · Recording unavailable');
  // The worker has not republished yet, so its next reply still claims READY for
  // the same token. Delayed propagation must not win the race against this
  // document's own observation.
  status = { ...status, revision: 2, state: 'READY', policy }; await page.send(status);
  assert.equal(page.feedback, 'Attestamp · Recording unavailable');
  page.event('click', { isTrusted: true, target: page.button, button: 0, detail: 1 });
  assert.equal(page.feedback, 'Attestamp · Recording unavailable');
  // A surface that can observe a Send again restores ON under the same policy.
  page.buttons = controls; page.changed();
  assert.equal(page.feedback, 'Attestamp · ON');
});

test('an explicit worker OFF clears the indicator while the local surface is unsupported', async t => {
  const captured = [];
  let status = { kind: 'PAP_CAPTURE_POLICY', pageContract: CHATGPT_PAGE_CONTRACT,
    browserSessionId: 'synthetic-off-precedence-session', revision: 0, state: 'OFF', policy: null };
  const page = pageFixture({ draft: 'SYNTHETIC_OFF_PRECEDENCE', capture: async message => {
    if (message.kind === 'PAP_CAPTURE_STATUS') return status;
    captured.push(message);
    return { profile: CHATGPT_CAPTURE_PROFILE, eventId: message.eventId, kind: message.observationKind, state: 'PROMPT_SAVED' };
  } });
  t.after(() => page.close());
  await page.send(status);
  const token = token => ({ profile: CHATGPT_CAPTURE_PROFILE, token,
    expectedUrl: page.location.href, destination: 'conversation:test-conversation' });
  status = { ...status, revision: 1, state: 'READY', policy: token('first-token') }; await page.send(status);
  assert.equal(page.feedback, 'Attestamp · ON');
  // The surface becomes locally unsupported and this document withdraws ON.
  const controls = page.buttons;
  page.buttons = [page.button, page.button]; page.changed();
  assert.equal(page.feedback, 'Attestamp · Recording unavailable');
  // Only the worker's explicit OFF may clear that withdrawal, and it must do so
  // even though the local surface still cannot observe a Send.
  status = { ...status, revision: 2, state: 'OFF', policy: null }; await page.send(status);
  assert.equal(page.feedback, '', 'the authoritative OFF must outrank local unavailability');
  // The cleared indicator is not re-derived from the surface, and the withdrawn
  // Send still creates no capture.
  page.event('click', { isTrusted: true, target: page.button, button: 0, detail: 1 });
  assert.equal(page.feedback, ''); assert.equal(captured.length, 0);
  // Recovering the surface while the worker still reports OFF stays OFF: the
  // page's own observation cannot lift the authoritative OFF.
  page.buttons = controls; page.changed();
  assert.equal(page.feedback, '');
  page.event('click', { isTrusted: true, target: page.button, button: 0, detail: 1 });
  assert.equal(page.feedback, ''); assert.equal(captured.length, 0);
  // A later explicit ON republishes READY with a fresh policy.
  status = { ...status, revision: 3, state: 'READY', policy: token('second-token') }; await page.send(status);
  assert.equal(page.feedback, 'Attestamp · ON');
  page.event('click', { isTrusted: true, target: page.button, button: 0, detail: 1 });
  assert.equal(captured.length, 1); assert.equal(captured[0].token, 'second-token');
});

test('a revoked capture still reports its gap instead of a generic state', async t => {
  const captured = [], replies = [];
  let status = { kind: 'PAP_CAPTURE_POLICY', pageContract: CHATGPT_PAGE_CONTRACT,
    browserSessionId: 'synthetic-revocation-session', revision: 0, state: 'OFF', policy: null };
  const page = pageFixture({ draft: 'SYNTHETIC_REVOKE', capture: async message => {
    if (message.kind === 'PAP_CAPTURE_STATUS') return status;
    captured.push(message);
    return new Promise(resolve => replies.push(() => resolve({ profile: CHATGPT_CAPTURE_PROFILE,
      eventId: message.eventId, kind: message.observationKind, state: 'PROMPT_SAVED' })));
  } });
  t.after(() => page.close());
  await page.send(status);
  status = { ...status, revision: 1, state: 'READY', policy: { profile: CHATGPT_CAPTURE_PROFILE,
    token: 'revoked-token', expectedUrl: page.location.href, destination: 'conversation:test-conversation' } };
  await page.send(status);
  assert.equal(page.feedback, 'Attestamp · ON');
  page.event('click', { isTrusted: true, target: page.button, button: 0, detail: 1 });
  assert.equal(captured.length, 1);
  // The worker revokes the policy while that Send is still in flight. The page
  // drops the observation but must report the gap it proved, not the worker's
  // generic unavailability.
  status = { ...status, revision: 2, state: 'RECORDING_UNAVAILABLE', policy: null }; await page.send(status);
  assert.match(page.feedback, /Recording gap/);
  // A revocation whose Send was already acknowledged, and whose correlation can
  // no longer be observed, keeps the quieter wording.
  status = { ...status, revision: 3, state: 'READY', policy: { profile: CHATGPT_CAPTURE_PROFILE,
    token: 'second-token', expectedUrl: page.location.href, destination: 'conversation:test-conversation' } };
  await page.send(status); assert.equal(page.feedback, 'Attestamp · ON');
  page.event('click', { isTrusted: true, target: page.button, button: 0, detail: 1 });
  assert.equal(captured.length, 2);
  replies[1](); await until(() => page.feedback === 'Attestamp · Prompt saved');
  status = { ...status, revision: 4, state: 'RECORDING_UNAVAILABLE', policy: null }; await page.send(status);
  assert.match(page.feedback, /Prompt saved/);
});

test('an observed Send still saves inside the window while the surface is unsupported', async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  t.after(() => release());
  let inspections = 0;
  const f = await fixture(t, { beforeCapture: async () => { entered(); await gate; } });
  const inspect = f.worker.chrome.tabs.sendMessage;
  f.worker.chrome.tabs.sendMessage = async (id, message, options) => {
    const result = await inspect(id, message, options);
    if (message.kind === 'PAP_INSPECT') inspections++;
    return result;
  };
  await f.recording(true);
  const page = f.pages.get(17), scope = f.runtime.adapter.scopes().find(source => source.tabId === 17).scope;
  f.send(exact);
  await started;
  // The surface is still ambiguous when the already-observed genuine Send
  // reaches the engine, because the capture outlives the provider re-render.
  const controls = page.buttons, before = inspections;
  page.buttons = [page.button, page.button]; page.changed();
  await until(() => inspections > before);
  release();
  await until(() => page.feedback === 'Attestamp · Prompt saved');
  assert.equal(saved(f).length, 1);
  assert.equal(preview(f).value.texts[0].preview, exact);
  assert.equal(f.runtime.adapter.scopes().find(source => source.tabId === 17).scope, scope);
  assert.equal(f.prevention, 0);
  page.buttons = controls; page.changed();
});

test('a page Send rejection and a worker capture rejection are distinguishable in diagnostics', async t => {
  const diagnostics = new LocalDiagnostics({ mode: 'SYNTHETIC_FIXTURE' });
  const f = await fixture(t, { diagnostics }); await f.recording(true);
  const page = f.pages.get(17);
  // The provider briefly exposes two Send controls: the page declines to observe
  // and reports only its fixed rejection code, never DOM or prompt detail.
  const controls = page.buttons;
  page.buttons = [page.button, page.button];
  page.event('click', { isTrusted: true, target: page.button, button: 0, detail: 1 });
  page.buttons = controls;
  await until(() => (diagnostics.preview().report.events ?? []).some(event => event.code === 'PAGE_SEND_REJECTED'));
  const codes = () => diagnostics.preview().report.events.map(event => ({ code: event.code, component: event.component }));
  assert.deepEqual(codes().filter(value => value.code === 'PAGE_SEND_REJECTED'),
    [{ code: 'PAGE_SEND_REJECTED', component: 'adapter' }]);
  assert.equal(saved(f).length, 0);
  // A stale token is rejected by the worker before any durable observation.
  const stale = await f.worker.message({ kind: 'PAP_CAPTURE', pageContract: CHATGPT_PAGE_CONTRACT,
    token: crypto.randomUUID(), eventId: crypto.randomUUID(), observationKind: 'send-intent',
    inputMethod: 'send-button', text: exact }, page.captureSender());
  assert.equal(stale.state, 'RECORDING_UNAVAILABLE');
  await until(() => codes().some(value => value.code === 'CAPTURE_REJECTED'));
  assert.deepEqual(codes().filter(value => value.code === 'CAPTURE_REJECTED'),
    [{ code: 'CAPTURE_REJECTED', component: 'bridge' }]);
  assert.equal(saved(f).length, 0);
  // Each bounded code is reported once per session, not once per rejection.
  await f.worker.message({ kind: 'PAP_CAPTURE', pageContract: CHATGPT_PAGE_CONTRACT,
    token: crypto.randomUUID(), eventId: crypto.randomUUID(), observationKind: 'send-intent',
    inputMethod: 'send-button', text: exact }, page.captureSender());
  assert.equal(codes().filter(value => value.code === 'CAPTURE_REJECTED').length, 1);
});

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
