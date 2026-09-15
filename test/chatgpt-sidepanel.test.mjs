import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { sidePanelFixture, panelURL } from './sidepanel-fixture.mjs';
import { CHATGPT_PANEL_PROFILE, panelRequest } from '../spikes/browser/chatgpt/panel.mjs';
import { CHATGPT_PAGE_CONTRACT } from '../spikes/browser/chatgpt/adapter.mjs';
import { until } from './recording-fixture.mjs';

async function fixture(t) {
  const directory = await mkdtemp('/private/tmp/attestamp-panel-test-');
  const f = await sidePanelFixture(directory);
  t.after(async () => { await f.close(); await rm(directory, { recursive: true, force: true }); }); return f;
}
test('retained sidebar controls only global recording and opens history, without collecting drafts', async t => {
  const f = await fixture(t), { model } = await f.panel();
  assert.equal(model.state.recording, false); f.pages.get(17).text = 'UNCHANGED_DRAFT';
  await model.toggle(); assert.equal(model.state.recording, true);
  assert.equal(model.state.readySources, 2); assert.equal(f.pages.get(17).text, 'UNCHANGED_DRAFT');
  assert.equal(f.runtime.session.receipts.list().length, 0);
  await model.dashboard(); assert.equal(f.dashboards.length, 1);
  await model.toggle(); assert.equal(model.state.recording, false);
  assert.equal(f.releases.length, 0);
  const html = await readFile(new URL('../spikes/browser/chatgpt/extension/sidepanel.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /<textarea|<select|Protect and send/);
});
test('untrusted page, tab and stale sidebar contexts cannot acquire control authority', async t => {
  const f = await fixture(t), panel = await f.panel();
  const message = { kind: 'PAP_PANEL_REQUEST', profile: CHATGPT_PANEL_PROFILE, action: 'STATE' };
  for (const sender of [f.pages.get(17).captureSender(), { ...panel.sender, tab: { id: 17 } },
    { ...panel.sender, url: panelURL + '?spoof' }, { ...panel.sender, documentLifecycle: 'prerender' },
    { ...panel.sender, documentId: randomUUID() }, { ...panel.sender, origin: 'https://chatgpt.com' }]) {
    assert.equal((await f.worker.message(message, sender)).error, 'UNTRUSTED_PANEL');
  }
  panel.close(); assert.equal((await panel.transport(message)).error, 'UNTRUSTED_PANEL');
});
test('sidebar cannot manufacture captures; page roles cannot set consent; removed commands reject at both panel boundaries', async t => {
  const f = await fixture(t), panel = await f.panel();
  for (const kind of ['PROTECT_AND_SEND', 'DEVELOPMENT_FREEZE', 'SET_PAUSE', 'ENROLL_SCOPE', 'CANCEL_OPERATION']) {
    const command = { kind, text: 'ARBITRARY_SYNTHETIC' };
    assert.equal((await panel.transport({ kind: 'PAP_PANEL_REQUEST', profile: CHATGPT_PANEL_PROFILE,
      action: 'COMMAND', command })).error, 'PANEL_REQUEST_REJECTED');
    await assert.rejects(panelRequest({ kind: 'PAP_PANEL_REQUEST', profile: CHATGPT_PANEL_PROFILE,
      requestId: randomUUID(), action: 'COMMAND', command }, f.runtime.engine));
  }
  assert.equal((await f.worker.message({ kind: 'PAP_CAPTURE', pageContract: CHATGPT_PAGE_CONTRACT,
    text: 'ARBITRARY_SYNTHETIC' }, panel.sender)).state, 'RECORDING_UNAVAILABLE');
  assert.equal((await f.worker.message({ kind: 'PAP_PANEL_REQUEST', profile: CHATGPT_PANEL_PROFILE,
    action: 'COMMAND', command: { kind: 'SET_RECORDING', enabled: true } }, f.pages.get(17).captureSender())).error, 'UNTRUSTED_PANEL');
  const state = panel.model.state;
  const command = { profile: 'pap-resident-command/2', kind: 'SET_RECORDING', enabled: true, text: 'FORGED',
    runtimeEpoch: state.runtimeEpoch, adapterProfile: state.adapterProfile, expectedRevision: state.revision, commandId: randomUUID() };
  await assert.rejects(panelRequest({ kind: 'PAP_PANEL_REQUEST', profile: CHATGPT_PANEL_PROFILE,
    requestId: randomUUID(), action: 'COMMAND', command }, f.runtime.engine));
  assert.equal(f.runtime.engine.state().recording, false); assert.equal(f.runtime.session.receipts.list().length, 0);
});
test('disconnect makes sidebar status unavailable without replaying a prior command', async t => {
  const f = await fixture(t), { model } = await f.panel(); await model.toggle();
  const before = f.requests.filter(value => value.action === 'COMMAND').length;
  f.disconnect(); await until(() => !f.runtime.browserState()); await model.refresh();
  assert.equal(model.state, null); assert.match(model.error, /unavailable/);
  assert.equal(f.requests.filter(value => value.action === 'COMMAND').length, before);
});
