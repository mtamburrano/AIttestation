import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { continuousFixture, until } from './continuous-fixture.mjs';
import { verifyPortable } from '../spikes/recipient/portable.mjs';
import { LocalDiagnostics } from '../spikes/release/diagnostics.mjs';
import { canonical } from '../spikes/vault/format.mjs';

const exact = 'SYNTHETIC_NORMAL_e\u0301\r\n☕  ';
async function fixture(t, options) {
  const root = await mkdtemp('/private/tmp/attestamp-capture-test-');
  let f;
  t.after(async () => { await f?.close(); await rm(root, { recursive: true, force: true }); });
  f = await continuousFixture(root, options); return f;
}
const saved = f => f.runtime.session.receipts.list();
const preview = (f, id = saved(f)[0].id) => {
  const value = f.runtime.session.receipts.prepare({ ids: [id] });
  return { value, bytes: f.runtime.session.receipts.export(value.previewId) };
};

test('normal user sends retain exact bytes with retrospective source assertions and no release authority', async t => {
  const diagnostics = new LocalDiagnostics(), f = await fixture(t, { diagnostics });
  await f.mode('Continuous');
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
  assert.deepEqual(f.runtime.session.runtime.snapshot().seals, {});
  assert.deepEqual(f.runtime.session.runtime.snapshot().attempts, {});
  for (const page of f.pages.values()) { assert.equal(page.clicks(), 0); assert.equal(page.injections(), 0); }
  const events = JSON.stringify(diagnostics.preview().report);
  assert.ok(!events.includes(exact)); assert.ok(!events.includes('conversation:fixture-17'));
  assert.ok(!events.includes(f.sources[0].documentId));
});

test('equal-text genuine sends are distinct while duplicate native delivery is idempotent', async t => {
  const f = await fixture(t); await f.mode('Continuous');
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
  const f = await fixture(t); await f.mode('Continuous'); const page = f.pages.get(17);
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

test('Off, unrelated conversations and stale document identities cannot capture or mix prompts', async t => {
  const f = await fixture(t);
  f.send('OFF'); f.send('UNRELATED', { id: 18 });
  await f.mode('Continuous'); f.send('first-tab'); f.send('unconsented', { id: 18 });
  await until(() => saved(f).length === 1);
  await f.mode('Continuous', 18);
  f.send('another-first'); f.send('second-tab', { id: 18 });
  await until(() => saved(f).length === 3);
  assert.deepEqual(saved(f).map(value => preview(f, value.id).value.texts[0].preview).sort(), ['another-first', 'first-tab', 'second-tab']);
  const old = f.deliveries.find(value => value.observation.source.tabId === 17);
  f.navigate(); await until(() => !f.runtime.adapter.scopes().some(value => value.scope === f.scopes.get(17)));
  const before = f.results.length;
  f.replay(old); await until(() => f.results.length > before);
  assert.equal(f.results.at(-1).result.state, 'RECORDING_UNAVAILABLE');
  f.send('still-second', { id: 18 }); await until(() => saved(f).length === 4);
  assert.ok(f.sources.filter(value => value.tabId === 18).every(value => value.destination === 'conversation:fixture-18'));
  assert.equal(f.releases.length, 0);
});

test('lost acknowledgement retries evidence delivery once without repeating the user send', async t => {
  const f = await fixture(t, { dropAck: true }); await f.mode('Continuous');
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
    const f = await fixture(t); await f.mode('Continuous'); f[fault](); f.send(exact);
    await until(() => /gap|unavailable/.test(f.pages.get(17).feedback));
    assert.equal(saved(f).length, 0);
    assert.ok(!f.results.some(value => value.result.state === 'PROMPT_SAVED'));
    assert.equal(f.userSends, 1); assert.equal(f.prevention, 0); assert.equal(f.releases.length, 0);
    assert.equal(f.anchorCalls, 0);
  });
});

test('bridge loss and global pause revoke capture tokens without restoring them on resume', async t => {
  const f = await fixture(t); await f.mode('Continuous');
  f.send(exact); await until(() => f.results.length > 0);
  const old = f.deliveries[0];
  await f.command('SET_PAUSE', { paused: true });
  await f.command('SET_PAUSE', { paused: false });
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
    const f = await fixture(t, { textarea }); await f.mode('Continuous'); const page = f.pages.get(17);
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
    const f = await fixture(t); await f.mode('Continuous'); const page = f.pages.get(17); page.text = exact;
    if (drift === 'attachment') page.attachments = true;
    if (drift === 'rich') page.editor.replaceChildren(new page.Element('IMG'));
    if (drift === 'hidden') page.editor.visible = false;
    if (drift === 'ambiguous') page.buttons.push(page.button);
    f.send(undefined); await until(() => /gap|unavailable/.test(page.feedback));
    assert.equal(saved(f).length, 0); assert.equal(f.deliveries.length, 0); assert.equal(f.prevention, 0);
  });
});

test('hydrated message IDs and ambiguous equal-text appearances cannot supply message assertions', async t => {
  const f = await fixture(t); await f.mode('Continuous'); const page = f.pages.get(17);
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
  const f = await fixture(t); await f.mode('Continuous'); f.send(exact); f.appear(exact);
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
  assert.deepEqual(f.runtime.session.runtime.snapshot().attempts, {});
});

test('an older delayed save cannot hide a newer recording gap', async t => {
  const f = await fixture(t, { dropAck: true }); await f.mode('Continuous');
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
    const f = await fixture(t); await f.mode('Continuous');
    const vault = f.runtime.session.vault, capture = vault.capture.bind(vault);
    vault.capture = (bytes, options) => {
      let value; try { value = JSON.parse(bytes); } catch {}
      if (stage === 'intent' && value?.kind === 'normal-send-intent'
          || stage === 'engine-state' && value?.profile === 'pap-resident-state/1' && value.state.operations.some(item => item.observation)) {
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
  const f = await fixture(t); await f.mode('Continuous'); const page = f.pages.get(17);
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
  const f = await fixture(t, { textarea: true }); await f.mode('Continuous');
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
  assert.equal(f.runtime.session.status().versions[0].digest, f.runtime.engine.state().operations[0].result.digest);
});
