import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { pageFixture, pageCommand } from './chatgpt-page-fixture.mjs';
import { workerFixture, testTab } from './chrome-worker-fixture.mjs';
import { ChatGPTChromeAdapter, CHATGPT_EXTENSION_ID } from '../spikes/browser/chatgpt/adapter.mjs';
import { ChromeBridgeController } from '../spikes/browser/chatgpt/bridge.mjs';
import { ChatGPTProtectionSession } from '../spikes/browser/chatgpt/session.mjs';
import { LocalDiagnostics } from '../spikes/release/diagnostics.mjs';
import { FAST_CONFIRM_PROFILE } from '../spikes/anchor/algorand/fast-confirm.mjs';

async function until(check) {
  for (let index = 0; index < 500; index++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Synthetic composer fixture timed out');
}

async function integratedFixture(t, { sendState = 'absent', change = () => {}, loseReply = false, onCheck = () => {}, timeoutMs = 5000 } = {}) {
  const root = await mkdtemp('/private/tmp/attestamp-composer-test-'), diagnostics = new LocalDiagnostics({ mode: 'SYNTHETIC_FIXTURE' });
  let port, worker, controller, session, pageRelease, permission = true;
  const releases = [];
  const adapter = new ChatGPTChromeAdapter((command, refs) => controller.sendRelease(command, refs), {
    extensionId: CHATGPT_EXTENSION_ID, diagnostics, runtimeEpoch: 'synthetic-runtime-epoch' });
  controller = new ChromeBridgeController(adapter, message => port.onMessage.emit(message), {
    localBrowser: { product: 'Google Chrome', channel: 'stable', major: 153 },
    localPlatform: { product: 'macOS', arch: 'arm64', version: '15.7.2' }, diagnostics, timeoutMs,
  });
  session = await new ChatGPTProtectionSession(root, adapter, { vaultKey: randomBytes(32), diagnostics,
    fastTrust: { profile: FAST_CONFIRM_PROFILE }, collectFast: async () => ({ synthetic: true }),
    verifyFast: () => ({ authorized: true, anchor: 'SOURCE_CORROBORATED', timestamp: 'SOURCE_REPORTED',
      assurance: FAST_CONFIRM_PROFILE, round: 42 }),
  }).init();
  const page = pageFixture({ sendState,
    notify: (message, page) => worker.chrome.runtime.onMessage.emit(message, page.sender()),
    authorize: async (message, page) => { await onCheck(message, context); return worker.message(message, page.sender()); },
    onInput: () => change(context),
  });
  const context = { root, diagnostics, adapter, controller, session, page, releases,
    revokePermission() { permission = false; worker.chrome.permissions.onRemoved.emit(); },
    get worker() { return worker; }, get port() { return port; }, get pageRelease() { return pageRelease; } };
  worker = await workerFixture({ clock: { setTimeout, clearTimeout, performance }, permission: async () => permission,
    query: async () => [testTab({ url: page.location.href })],
    onConnect(value) {
      port = value; port.close = () => controller.disconnect();
      port.send = message => { if (message.kind === 'PAP_RELEASE') assert.fail('Wrong direction'); controller.receive(message); };
    },
    inspect: (_tabId, message, options) => {
      assert.equal(options.frameId, 0);
      if (message.kind !== 'PAP_RELEASE') return page.send(message);
      releases.push(message);
      const durable = session.runtime.snapshot(), attempt = durable.attempts[message.attemptId];
      assert.equal(attempt.state, 'DISPATCHING'); assert.equal(durable.seals[attempt.sealId].authorization, null);
      pageRelease = page.send(message);
      return loseReply ? pageRelease.then(() => new Promise(() => {})) : pageRelease;
    },
  });
  t.after(async () => { worker.close(); await pageRelease; session.close(); await rm(root, { recursive: true, force: true }); });
  await until(() => port.messages.some(message => message.kind === 'PAP_HELLO'));
  context.scope = session.enroll({ tabId: 17, destination: testTab().destination }).scope;
  context.run = async (mode = 'Sealed') => {
    const text = 'SYNTHETIC_PRIVATE_e\u0301\r\n☕';
    const version = await session.freeze({ text, mode, scope: context.scope, editRevision: 1 });
    const request = { id: version.id, scope: context.scope, currentText: text, editRevision: 1 };
    const confirmed = await session.confirmFast({ ...request, transactionId: 'synthetic-only' });
    const result = mode === 'Sealed' ? await session.release(request) : confirmed;
    return { version, request, result, text };
  };
  return context;
}

test('editor detection separates drafts and attachments from absent, disabled and ambiguous Send controls', async t => {
  for (const textarea of [false, true]) for (const draft of ['', 'EXISTING_PRIVATE_DRAFT']) {
    for (const sendState of ['absent', 'enabled', 'disabled', 'ambiguous']) await t.test(`${textarea}/${draft.length}/${sendState}`, async () => {
      const page = pageFixture({ textarea, draft, sendState });
      assert.deepEqual(await page.inspect(), { destination: 'conversation:test-conversation',
        surfaceSupported: true, composerEmpty: !draft, attachmentsPresent: false });
      if (draft || sendState === 'ambiguous') {
        const result = await page.send(pageCommand());
        assert.equal(result.exposure, 'NONE'); assert.equal(page.text, draft);
        assert.equal(page.injections(), 0); assert.equal(page.clicks(), 0); assert.equal(page.checks.length, 0);
      }
    });
  }
  for (const type of ['preview', 'file']) {
    const page = pageFixture({ attachments: type === 'preview' });
    if (type === 'file') page.files = [{ files: [{}] }];
    assert.equal((await page.inspect()).attachmentsPresent, true);
    assert.equal((await page.inspect()).surfaceSupported, true);
    assert.equal((await page.send(pageCommand())).exposure, 'NONE'); assert.equal(page.injections(), 0);
  }
});

test('an authorized exact insertion waits for asynchronous rendering or enablement and clicks once', async t => {
  for (const textarea of [false, true]) for (const sendState of ['absent', 'disabled', 'hidden', 'enabled']) {
    await t.test(`${textarea}/${sendState}`, async () => {
      const text = 'exact e\u0301\r\n☕', command = pageCommand(text);
      const page = pageFixture({ textarea, sendState, onInput(page) {
        setTimeout(() => { page.buttons = [page.button]; page.button.disabled = false; page.button.visible = true; page.changed(); }, 30);
      } });
      const result = await page.send(command);
      assert.equal(page.text, text); assert.equal(page.injections(), 1); assert.equal(page.clicks(), 1);
      assert.deepEqual(result, { attemptId: command.attemptId, textDigest: command.textDigest, exposure: 'DOM_INJECTED',
        submitted: true, observation: 'LOCAL_CLICK_DISPATCHED' });
      assert.deepEqual(page.checks.map(check => check.phase), ['inject', 'click']);
      page.text = '';
      assert.equal((await page.send(command)).exposure, 'UNKNOWN');
      assert.equal(page.clicks(), 1); assert.equal(page.injections(), 1);
    });
  }
});

test('readiness expiry remains exposed and late rendering never clicks or retries', async t => {
  for (const sendState of ['absent', 'disabled', 'hidden', 'ambiguous']) await t.test(sendState, async () => {
    const page = pageFixture({ sendState: sendState === 'ambiguous' ? 'absent' : sendState,
      onInput: page => { if (sendState === 'ambiguous') page.buttons = [page.button, page.button]; } }), command = pageCommand();
    const result = await page.send(command);
    assert.equal(result.exposure, 'DOM_INJECTED'); assert.equal(result.submitted, false);
    assert.equal(page.injections(), 1); assert.equal(page.clicks(), 0);
    page.buttons = [page.button]; page.button.disabled = false; page.button.visible = true; page.changed();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(page.clicks(), 0); assert.equal((await page.send(command)).exposure, 'UNKNOWN');
    assert.equal(page.injections(), 1);
  });
});

test('text, attachment, editor, control and destination drift after injection abort without a click', async t => {
  const cases = {
    'provider normalization': page => { page.text += 'rewrite'; },
    'edit and revert': page => { const text = page.text; page.text = 'edited'; page.text = text; },
    'destination change': page => { page.location.href = 'https://chatgpt.com/c/other'; },
    'URL query change': page => { page.location.search = '?other'; },
    'attachments': page => { page.attachments = true; },
    'selected file': page => { page.files = [{ files: [{}] }]; },
    'detached editor': page => { page.editor.isConnected = false; },
    'replacement editor': page => { page.editors = [{ ...page.editor }]; },
    'ambiguous editors': page => { page.editors = [page.editor, page.editor]; },
    'ambiguous controls': page => { page.buttons = [page.button, page.button]; },
    'readonly composer': page => { page.editor.readOnly = true; },
    'page hidden': page => { page.document.visibilityState = 'hidden'; },
    'page hidden and restored': page => {
      page.document.visibilityState = 'hidden'; page.event('visibilitychange'); page.document.visibilityState = 'visible';
    },
    'page suspension': page => { page.event('pagehide'); },
  };
  for (const [name, drift] of Object.entries(cases)) await t.test(name, async () => {
    const page = pageFixture({ sendState: 'absent', onInput(page) {
      setTimeout(() => { drift(page); page.changed(); page.buttons = [page.button]; }, 10);
    } });
    const result = await page.send(pageCommand());
    assert.equal(result.exposure, 'DOM_INJECTED'); assert.equal(result.submitted, false);
    assert.equal(page.injections(), 1); assert.equal(page.clicks(), 0);
  });
});

test('authorization denial, lost replies and drift during the final check cannot dispatch', async t => {
  for (const phase of ['inject', 'click']) await t.test(`denied ${phase}`, async () => {
    const page = pageFixture({ authorize: async message => message.phase !== phase });
    const result = await page.send(pageCommand());
    assert.equal(result.exposure, phase === 'inject' ? 'NONE' : 'DOM_INJECTED');
    assert.equal(result.submitted, false); assert.equal(page.clicks(), 0);
  });
  for (const drift of ['text', 'url', 'button', 'disabled', 'aria-disabled', 'expired', 'lost reply']) await t.test(drift, async () => {
    let now = 0, late;
    const page = pageFixture({ clock: { setTimeout, clearTimeout, performance: { now: () => now } },
      authorize: async (message, page) => {
        if (message.phase === 'inject') return true;
        if (drift === 'text') page.text += 'edited';
        if (drift === 'url') page.location.href = 'https://chatgpt.com/c/other';
        if (drift === 'button') page.buttons = [{ ...page.button }];
        if (drift === 'disabled') page.button.disabled = true;
        if (drift === 'aria-disabled') page.button.ariaDisabled = true;
        if (drift === 'expired') now = 2000;
        if (drift === 'lost reply') return new Promise(resolve => { late = resolve; });
        return true;
      } });
    const result = await page.send(pageCommand());
    assert.equal(result.exposure, 'DOM_INJECTED'); assert.equal(result.submitted, false); assert.equal(page.clicks(), 0);
    late?.(true); await new Promise(resolve => setImmediate(resolve)); assert.equal(page.clicks(), 0);
  });
});

test('unknown markup, stale contracts, untrusted senders and byte corruption never reach the editor', async () => {
  for (const options of [{ supported: false }, { url: 'https://chatgpt.com/c/other' },
    { url: 'https://untrusted.invalid/' }]) {
    const page = pageFixture(options);
    assert.equal((await page.send(pageCommand())).exposure, 'NONE'); assert.equal(page.injections(), 0);
  }
  const page = pageFixture();
  for (const overrides of [{ textBytes: Buffer.from('wrong text').toString('base64') },
    { textDigest: 'not-a-digest' }, { textBytes: 'invalid base64' }]) {
    assert.equal((await page.send(pageCommand(undefined, overrides))).exposure, 'NONE');
  }
  assert.equal((await page.send(pageCommand(undefined, { pageContract: 'chatgpt-web-text/2026-09-10' }))).surfaceSupported, false);
  for (const sender of [{ id: 'other' }, page.sender()]) {
    assert.equal((await page.send(pageCommand(), sender)).surfaceSupported, false);
  }
  assert.equal(page.injections(), 0); assert.equal(page.clicks(), 0);
});

test('synchronous input failure or partial normalization remains exposed without a click', async () => {
  for (const onInput of [page => { page.text += 'normalized'; }, () => { throw Error('SYNTHETIC_INPUT_FAILURE'); }]) {
    const page = pageFixture({ onInput }), result = await page.send(pageCommand());
    assert.equal(result.exposure, 'DOM_INJECTED'); assert.equal(result.submitted, false);
    assert.equal(page.injections(), 1); assert.equal(page.clicks(), 0);
  }
});

test('drift signals remain content-free and Send rendering alone does not change detection', async () => {
  const page = pageFixture({ sendState: 'absent' });
  page.changed(); page.buttons = [page.button]; page.changed(); assert.equal(page.notifications.length, 0);
  page.text = 'PRIVATE_PROMPT'; assert.deepEqual(page.notifications, [{ kind: 'PAP_SURFACE_CHANGED' }]);
  page.editors = []; page.changed(); assert.equal((await page.inspect()).surfaceSupported, false);
  assert.equal(page.notifications.length, 2);
  assert.doesNotMatch(JSON.stringify(page.notifications), /PRIVATE|test-conversation|https|textContent/);
});

test('real engine, worker and content script settle Sealed and Always Protect with correlated diagnostics', async t => {
  for (const mode of ['Sealed', 'Always Protect']) await t.test(mode, async t => {
    const context = await integratedFixture(t, { change: ({ page }) => {
      setTimeout(() => { page.buttons = [page.button]; page.changed(); }, 30);
    } });
    const { result, request, text, version } = await context.run(mode);
    assert.equal(result.state, 'SUBMISSION_OBSERVED'); assert.equal(context.page.text, text);
    assert.equal(context.page.clicks(), 1); assert.equal(context.releases.length, 1);
    assert.equal(context.session.runtime.snapshot().seals[version.id].authorization, null);
    await assert.rejects(async () => context.session.release(request)); assert.equal(context.page.clicks(), 1);
    const events = context.diagnostics.preview().report.events;
    const accepted = events.filter(event => event.code === 'BRIDGE_CHECK_ACCEPTED');
    assert.equal(accepted.length, 2);
    assert.ok(accepted.every(event => event.operationId === context.diagnostics.id('operationId', version.id)
      && event.dispatchId === context.diagnostics.id('dispatchId', result.attempt.attemptId)));
    assert.ok(events.some(event => event.code === 'SUBMISSION_OBSERVED'));
    for (const secret of [text, context.root, context.scope, version.id, version.digest, context.page.location.href]) {
      assert.ok(!JSON.stringify(events).includes(secret));
    }
  });
});

test('settle failures and lost replies remain durably unknown and never resend', async t => {
  const cases = {
    'absent Send': {},
    'disabled Send': { sendState: 'disabled' },
    'ambiguous Send after insertion': { change: ({ page }) => { page.buttons = [page.button, page.button]; } },
    'surface drift': { change: ({ page }) => { setTimeout(() => { page.text += 'changed'; page.buttons = [page.button]; }, 10); } },
    'pinned URL drift': { change: ({ page }) => { setTimeout(() => { page.location.search = '?changed'; page.buttons = [page.button]; }, 10); } },
    'trusted draft edit and revert': { change: ({ page, session, scope }) => {
      session.updateDraft({ text: 'edited', scope, editRevision: 2 });
      session.updateDraft({ text: page.text, scope, editRevision: 3 }); page.buttons = [page.button];
    } },
    'permission loss': { change: context => { context.revokePermission(); context.page.buttons = [context.page.button]; } },
    'tab switched and restored': { change: ({ worker, page }) => {
      worker.chrome.tabs.onActivated.emit(); worker.chrome.tabs.onActivated.emit(); page.buttons = [page.button];
    } },
    'same URL reload started': { change: ({ worker, page }) => {
      worker.chrome.tabs.onUpdated.emit(17, { status: 'loading' }); page.buttons = [page.button];
    } },
    'bridge disconnected': { change: ({ port, page }) => { port.disconnect(); page.buttons = [page.button]; } },
    'engine attempt expired': { timeoutMs: 100, change: ({ page }) => {
      setTimeout(() => { page.buttons = [page.button]; page.changed(); }, 150);
    } },
    'reply lost after click': { sendState: 'enabled', loseReply: true },
  };
  for (const [name, options] of Object.entries(cases)) await t.test(name, async t => {
    const context = await integratedFixture(t, options), { result, version, request } = await context.run();
    await context.pageRelease;
    assert.equal(result.state, 'OUTCOME_UNKNOWN');
    assert.equal(context.page.clicks(), options.loseReply ? 1 : 0);
    assert.equal(context.page.injections(), 1); assert.equal(context.releases.length, 1);
    assert.equal(context.session.runtime.snapshot().attempts[result.attempt.attemptId].state, 'OUTCOME_UNKNOWN');
    assert.equal(context.session.runtime.snapshot().seals[version.id].authorization, null);
    await assert.rejects(async () => context.session.release(request)); assert.equal(context.releases.length, 1);
    assert.ok(context.diagnostics.preview().report.events.some(event => event.code === 'OUTCOME_UNKNOWN'
      && event.operationId === context.diagnostics.id('operationId', version.id)));
  });
});

test('release checks are tied to their exact content document, phase and pending engine attempt', async t => {
  let probes = 0;
  const context = await integratedFixture(t, { sendState: 'enabled', async onCheck(message, context) {
    if (message.phase !== 'click') return;
    probes++;
    const before = context.port.messages.length;
    for (const sender of [context.page.sender({ frameId: 1 }), context.page.sender({ id: 'another-extension' }),
      context.page.sender({ tab: { id: 18 } }), context.page.sender({ documentId: 'other-document' }),
      context.page.sender({ origin: 'https://other.invalid' }), context.page.sender({ url: 'https://chatgpt.com/c/other' })]) {
      assert.equal(await context.worker.message(message, sender), false);
    }
    assert.equal(await context.worker.message({ ...message, phase: 'inject' }, context.page.sender()), false);
    assert.equal(await context.worker.message({ ...message, attemptId: 'another-attempt' }, context.page.sender()), false);
    assert.equal(context.port.messages.length, before);
  } });
  const { result } = await context.run();
  assert.equal(result.state, 'SUBMISSION_OBSERVED'); assert.equal(probes, 1);
  const check = context.page.checks[1];
  assert.equal(await context.worker.message(check, context.page.sender()), false, 'completed attempts cannot regain a click grant');
});

test('the engine rejects a trusted draft change while either authorization check is in flight', async t => {
  for (const phase of ['inject', 'click']) await t.test(phase, async t => {
    const context = await integratedFixture(t, { sendState: 'enabled', onCheck(message, { session, scope }) {
      if (message.phase === phase) session.updateDraft({ text: 'NEW_TRUSTED_DRAFT', scope, editRevision: 2 });
    } });
    const { result } = await context.run();
    assert.equal(result.state, phase === 'inject' ? 'FAILED_BEFORE_EGRESS' : 'OUTCOME_UNKNOWN');
    assert.equal(context.page.injections(), phase === 'inject' ? 0 : 1); assert.equal(context.page.clicks(), 0);
    assert.ok(context.diagnostics.preview().report.events.some(event => event.code === 'BRIDGE_CHECK_REJECTED'));
  });
});
