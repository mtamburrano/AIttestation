import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes, webcrypto } from 'node:crypto';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { PassThrough } from 'node:stream';
import { runInNewContext } from 'node:vm';
import { ChatGPTChromeAdapter, CHATGPT_ADAPTER_PROFILE, CHATGPT_PAGE_CONTRACT,
  CHATGPT_RELEASE_PROTOCOL } from '../spikes/browser/chatgpt/adapter.mjs';
import { ChromeBridgeController } from '../spikes/browser/chatgpt/bridge.mjs';
import { encodeNativeFrame, NativeFrameDecoder, NATIVE_BRIDGE_PROFILE,
  rendezvousRecord, runNativeHost } from '../spikes/browser/chatgpt/native-host.mjs';
import { startPackagedChatGPT } from '../spikes/browser/chatgpt/runtime-main.mjs';
import { ChatGPTProtectionSession } from '../spikes/browser/chatgpt/session.mjs';
import { FAST_CONFIRM_PROFILE, collectFastEvidence } from '../spikes/anchor/algorand/fast-confirm.mjs';
import { MAX_PROTECTED_TEXT_BYTES, validateProtectedTextPayload } from '../spikes/release/runtime.mjs';
import { canonical, parseCanonical } from '../spikes/vault/format.mjs';
import { verifyPortable } from '../spikes/recipient/portable.mjs';
import { MemoryKeyStore } from '../spikes/vault/key-lifecycle.mjs';

const extensionId = 'hdnjjomhchcpcnikfabcnmlhcehbnhbc';
const browserSessionId = 'browser-session-0000000000000001';
const fastTrust = {
  profile: FAST_CONFIRM_PROFILE, network: 'testnet-v1.0', genesis: 'test-genesis',
  applicationServiceOrigin: 'https://anchor.example',
  operators: [
    { id: 'a', organization: 'Operator A', endpoint: 'https://algod-a.example' },
    { id: 'b', organization: 'Operator B', endpoint: 'https://algod-b.example' },
  ],
};
const connection = (overrides = {}) => ({
  extensionId, adapterProfile: CHATGPT_ADAPTER_PROFILE, releaseProtocol: CHATGPT_RELEASE_PROTOCOL,
  pageContract: CHATGPT_PAGE_CONTRACT, browserSessionId,
  browser: { product: 'Google Chrome', channel: 'stable', major: 153 },
  platform: { product: 'macOS', arch: 'arm64', version: '15.7.1' },
  permissions: ['nativeMessaging', 'tabs'], hostPermission: 'https://chatgpt.com/*',
  permissionState: 'granted', ...overrides,
});
const tab = (overrides = {}) => ({ id: 17, url: 'https://chatgpt.com/', active: true,
  destination: 'new-chat', surfaceSupported: true, composerEmpty: true, attachmentsPresent: false, ...overrides });
const sync = (adapter, tabs = [tab()], overrides = {}) => adapter.synchronize({
  browserSessionId, permissionState: 'granted', adapterProfile: CHATGPT_ADAPTER_PROFILE,
  releaseProtocol: CHATGPT_RELEASE_PROTOCOL, pageContract: CHATGPT_PAGE_CONTRACT, tabs, ...overrides,
});
const fastReport = Object.freeze({
  profile: FAST_CONFIRM_PROFILE, anchor: 'SOURCE_CORROBORATED', timestamp: 'SOURCE_REPORTED',
  authorized: true, round: 42, blockHeaderHash: Buffer.alloc(32, 7).toString('base64'),
  sourceClaimedTimes: ['2026-09-10T12:00:00Z', '2026-09-10T12:00:01Z'],
  assurance: FAST_CONFIRM_PROFILE, reason: 'test-local corroboration',
});
const observedResponse = (command, exposure = 'DOM_INJECTED', submitted = true,
  observation = 'LOCAL_CLICK_DISPATCHED') => ({
  profile: command.profile, runtimeEpoch: command.runtimeEpoch,
  browserSessionId: command.browserSessionId, scope: command.scope, tabId: command.tabId,
  expectedUrl: command.expectedUrl, destination: command.destination,
  attemptId: command.attemptId, payloadDigest: command.payloadDigest,
  textDigest: command.textDigest, exposure, submitted, observation,
});

async function fixture(t, { responder, collectFast, verifyFast, verifyArchive, fault } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'provenance-chatgpt-path-test-'));
  const commands = []; let session;
  const adapter = new ChatGPTChromeAdapter(async command => {
    commands.push(structuredClone(command));
    if (responder) return responder(command, session);
    const durable = session.runtime.snapshot();
    assert.equal(durable.attempts[command.attemptId].state, 'DISPATCHING');
    assert.equal(durable.seals[durable.attempts[command.attemptId].sealId].authorization, null);
    return observedResponse(command);
  }, { extensionId });
  adapter.pair(connection()); sync(adapter);
  session = await new ChatGPTProtectionSession(root, adapter, {
    vaultKey: randomBytes(32), fastTrust,
    collectFast: collectFast ?? (async ({ transactionId }) => ({ testTransactionId: transactionId })),
    verifyFast: verifyFast ?? (() => structuredClone(fastReport)),
    verifyArchive: verifyArchive ?? (() => ({ independentlyVerified: true, anchor: 'CONSENSUS_VERIFIED',
      timestamp: 'BLOCK_HASH_BOUND', round: 42, reason: 'test State Proof' })), fault,
  }).init();
  const enrollment = session.enroll({ tabId: 17, destination: 'new-chat' });
  t.after(async () => { session.close(); await rm(root, { recursive: true, force: true }); });
  return { root, adapter, session, commands, scope: enrollment.scope };
}

test('supported text profile preserves exact UTF-8 through 256 KiB and rejects attachments or ambiguous encoding', () => {
  const exact = 'x'.repeat(MAX_PROTECTED_TEXT_BYTES);
  assert.equal(validateProtectedTextPayload({ text: exact, attachments: [] }).text, exact);
  const maximumFrame = encodeNativeFrame({ kind: 'PAP_RELEASE', textBytes: Buffer.alloc(MAX_PROTECTED_TEXT_BYTES).toString('base64') });
  assert.ok(maximumFrame.length < 512 * 1024, 'base64 transport must bound worst-case JSON expansion');
  assert.throws(() => validateProtectedTextPayload({ text: `${exact}x`, attachments: [] }), /256 KiB/);
  assert.throws(() => validateProtectedTextPayload({ text: '\ud800', attachments: [] }), /Unsupported/);
  assert.throws(() => validateProtectedTextPayload({ text: 'text', attachments: [{ name: 'x', bytes: '' }] }), /no attachments/);
  assert.throws(() => validateProtectedTextPayload({ text: 'text', attachments: [], extra: true }), /Unsupported/);
});

test('Sealed preserves a maximum-size non-ASCII prompt through durable state and native transport', async t => {
  const { session, commands, scope } = await fixture(t);
  const exact = 'é'.repeat(MAX_PROTECTED_TEXT_BYTES / 2);
  assert.equal(Buffer.byteLength(exact, 'utf8'), MAX_PROTECTED_TEXT_BYTES);
  const version = await session.freeze({ text: exact, mode: 'Sealed', scope, editRevision: 1 });
  assert.equal(session.runtime.snapshot().seals[version.id].payload.text, exact);
  await session.confirmFast({ id: version.id, scope, currentText: exact, editRevision: 1,
    transactionId: 'maximum-prompt-transaction' });
  const released = await session.release({ id: version.id, scope, currentText: exact, editRevision: 1 });
  assert.equal(released.state, 'SUBMISSION_OBSERVED'); assert.equal(commands.length, 1);
  assert.equal(Buffer.from(commands[0].textBytes, 'base64').toString('utf8'), exact);
  assert.ok(encodeNativeFrame(commands[0]).length < 512 * 1024);
});

test('Sealed persists fast evidence and consumes exact-version authorization before adapter egress', async t => {
  const { session, commands, scope } = await fixture(t);
  const version = await session.freeze({ text: 'private e\u0301\r\n☕', mode: 'Sealed', scope, editRevision: 4 });
  assert.equal(version.state, 'PENDING_FAST_CONFIRMATION'); assert.equal(commands.length, 0);
  await assert.rejects(session.release({ id: version.id, scope, currentText: 'private e\u0301\r\n☕', editRevision: 4 }), /confirmation/);
  const confirmed = await session.confirmFast({ id: version.id, scope, currentText: 'private e\u0301\r\n☕', editRevision: 4,
    transactionId: 'two-operator-transaction' });
  assert.equal(confirmed.state, 'SEALED_NOT_SENT'); assert.equal(confirmed.anchor, 'SOURCE_CORROBORATED');
  assert.equal(confirmed.timestamp, 'SOURCE_REPORTED'); assert.equal(commands.length, 0);
  const seal = session.runtime.snapshot().seals[version.id];
  assert.equal(seal.confirmation.profile, FAST_CONFIRM_PROFILE); assert.ok(seal.confirmation.receiptId); assert.ok(seal.authorization);
  const outcomes = await Promise.allSettled([1, 2].map(() => session.release({
    id: version.id, scope, currentText: 'private e\u0301\r\n☕', editRevision: 4,
  })));
  assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1); assert.equal(commands.length, 1);
  assert.equal(Buffer.from(commands[0].textBytes, 'base64').toString(), 'private e\u0301\r\n☕');
  assert.equal(Object.hasOwn(commands[0], 'text'), false); assert.equal(Object.hasOwn(commands[0], 'confirmation'), false);
  assert.deepEqual(session.runtime.snapshot().attempts[commands[0].attemptId].confirmation, seal.confirmation);
  await assert.rejects(session.release({ id: version.id, scope, currentText: 'edited', editRevision: 5 }), /authorization|Stale/);
  await assert.rejects(Promise.resolve().then(() => session.release({
    id: version.id, scope, currentText: 'private e\u0301\r\n☕', editRevision: 4,
  })), /Stale|revision/);
});

test('Continuous releases durably before anchoring while Always Protect uses the same Sealed gate automatically', async t => {
  const continuous = await fixture(t);
  const c = await continuous.session.freeze({ text: 'continuous', mode: 'Continuous', scope: continuous.scope, editRevision: 1 });
  assert.equal(c.state, 'SUBMISSION_OBSERVED'); assert.equal(c.anchor, 'PENDING'); assert.equal(continuous.commands.length, 1);
  const attempt = continuous.session.runtime.snapshot().attempts[c.attempt.attemptId];
  assert.equal(attempt.releaseClass, 'RETROSPECTIVE_CONTINUOUS'); assert.equal(attempt.confirmation, null);
  const anchored = await continuous.session.confirmFast({ id: c.id, scope: continuous.scope,
    transactionId: 'post-release-transaction' });
  assert.equal(anchored.anchor, 'SOURCE_CORROBORATED'); assert.equal(continuous.commands.length, 1);
  await assert.rejects(continuous.session.release({ id: c.id, scope: continuous.scope, currentText: 'continuous', editRevision: 1 }), /cannot be resent/);

  const automatic = await fixture(t);
  const a = await automatic.session.freeze({ text: 'automatic', mode: 'Always Protect', scope: automatic.scope, editRevision: 8 });
  assert.equal(a.state, 'PENDING_FAST_CONFIRMATION'); assert.equal(automatic.commands.length, 0);
  const sent = await automatic.session.confirmFast({ id: a.id, scope: automatic.scope, currentText: 'automatic', editRevision: 8,
    transactionId: 'pre-release-transaction' });
  assert.equal(sent.state, 'SUBMISSION_OBSERVED'); assert.equal(automatic.commands.length, 1);
  assert.equal(automatic.session.runtime.snapshot().attempts[sent.attempt.attemptId].releaseClass, 'PRE_DISCLOSURE_PROTECTED');
});

test('an edit/revert racing durable attempt consumption fails before adapter egress in every mode', async t => {
  for (const mode of ['Continuous', 'Sealed', 'Always Protect']) {
    await t.test(mode, async t => {
      const race = { armed: false };
      const context = await fixture(t, { fault: phase => {
        if (phase === 'after-consumption' && race.armed) {
          race.armed = false;
          race.session.updateDraft({ text: 'race', scope: race.scope, editRevision: 2 });
        }
      } });
      race.session = context.session; race.scope = context.scope;

      let result;
      if (mode === 'Continuous') {
        race.armed = true;
        result = await context.session.freeze({ text: 'race', mode, scope: context.scope, editRevision: 1 });
      } else {
        const version = await context.session.freeze({ text: 'race', mode, scope: context.scope, editRevision: 1 });
        if (mode === 'Sealed') {
          await context.session.confirmFast({ id: version.id, scope: context.scope,
            currentText: 'race', editRevision: 1, transactionId: 'race-transaction' });
          race.armed = true;
          result = await context.session.release({ id: version.id, scope: context.scope,
            currentText: 'race', editRevision: 1 });
        } else {
          race.armed = true;
          result = await context.session.confirmFast({ id: version.id, scope: context.scope,
            currentText: 'race', editRevision: 1, transactionId: 'race-transaction' });
        }
      }
      assert.equal(result.state, 'FAILED_BEFORE_EGRESS');
      assert.equal(context.commands.length, 0);
    });
  }
});

test('timeout or conflict leaves Sealed pending with no authorization or egress', async t => {
  for (const failure of ['timeout', 'conflict']) {
    await t.test(failure, async t => {
      const error = Error(failure); error.code = failure === 'timeout' ? 'PENDING_FAST_CONFIRMATION' : 'INVALID_FAST_CONFIRMATION';
      const { session, commands, scope } = await fixture(t, { verifyFast: () => { throw error; } });
      const version = await session.freeze({ text: failure, mode: 'Sealed', scope, editRevision: 1 });
      await assert.rejects(session.confirmFast({ id: version.id, scope, currentText: failure, editRevision: 1,
        transactionId: `${failure}-transaction` }));
      const after = session.status().versions[0], seal = session.runtime.snapshot().seals[version.id];
      assert.equal(after.state, 'PENDING_FAST_CONFIRMATION'); assert.equal(after.anchor, 'PENDING');
      assert.equal(seal.confirmation, null); assert.equal(seal.authorization, null); assert.equal(commands.length, 0);
    });
  }
});

test('pending Sealed confirmation supports explicit evidence retry or cancellation without downgrade', async t => {
  for (const action of ['retry', 'cancel']) {
    await t.test(action, async t => {
      let available = false;
      const pending = Error('confirmation source unavailable'); pending.code = 'PENDING_FAST_CONFIRMATION';
      const { session, commands, scope } = await fixture(t, {
        verifyFast: () => { if (!available) throw pending; return structuredClone(fastReport); },
      });
      const version = await session.freeze({ text: action, mode: 'Sealed', scope, editRevision: 1 });
      await assert.rejects(session.confirmFast({ id: version.id, scope, currentText: action,
        editRevision: 1, transactionId: 'first-attempt-transaction' }), /unavailable/);
      assert.equal(session.status().versions[0].state, 'PENDING_FAST_CONFIRMATION');
      assert.equal(commands.length, 0); available = true;
      if (action === 'retry') {
        const confirmed = await session.confirmFast({ id: version.id, scope, currentText: action,
          editRevision: 1, transactionId: 'second-attempt-transaction' });
        assert.equal(confirmed.state, 'SEALED_NOT_SENT'); assert.equal(commands.length, 0);
      } else {
        const cancelled = await session.cancel({ id: version.id, scope });
        assert.equal(cancelled.state, 'CANCELLED');
        await assert.rejects(session.confirmFast({ id: version.id, scope, currentText: action,
          editRevision: 1, transactionId: 'second-attempt-transaction' }), /cancelled/);
        assert.equal(commands.length, 0);
      }
    });
  }
});

test('stale edit, scope/tab ambiguity, restart, permission, adapter and provider changes all fail closed', async t => {
  const cases = {
    'stale edit revision': async ({ session, scope, version }) => session.release({ id: version.id, scope, currentText: 'locked', editRevision: 2 }),
    'scope destination change': async ({ adapter, session, scope, version }) => {
      assert.throws(() => sync(adapter, [tab({ destination: 'conversation:other', url: 'https://chatgpt.com/c/other' })]));
      return session.release({ id: version.id, scope, currentText: 'locked', editRevision: 1 });
    },
    'multiple ChatGPT tabs': async ({ adapter, session, scope, version }) => {
      assert.throws(() => sync(adapter, [tab(), tab({ id: 18, active: false })]));
      return session.release({ id: version.id, scope, currentText: 'locked', editRevision: 1 });
    },
    'runtime restart': async ({ adapter, session, scope, version }) => {
      adapter.restart(); return session.release({ id: version.id, scope, currentText: 'locked', editRevision: 1 });
    },
    'permission loss': async ({ adapter, session, scope, version }) => {
      assert.throws(() => sync(adapter, [tab()], { permissionState: 'revoked' }));
      return session.release({ id: version.id, scope, currentText: 'locked', editRevision: 1 });
    },
    'adapter mismatch': async ({ adapter, session, scope, version }) => {
      assert.throws(() => sync(adapter, [tab()], { releaseProtocol: 'other' }));
      return session.release({ id: version.id, scope, currentText: 'locked', editRevision: 1 });
    },
    'unsupported provider change': async ({ adapter, session, scope, version }) => {
      assert.throws(() => sync(adapter, [tab({ surfaceSupported: false })]));
      return session.release({ id: version.id, scope, currentText: 'locked', editRevision: 1 });
    },
    'attachment added': async ({ session, scope, version }) => session.release({ id: version.id, scope,
      currentText: 'locked', editRevision: 1, attachments: [{ name: 'x', bytes: '' }] }),
  };
  for (const [name, mutate] of Object.entries(cases)) {
    await t.test(name, async t => {
      const context = await fixture(t); context.version = await context.session.freeze({
        text: 'locked', mode: 'Sealed', scope: context.scope, editRevision: 1,
      });
      await context.session.confirmFast({ id: context.version.id, scope: context.scope,
        currentText: 'locked', editRevision: 1, transactionId: 'fail-closed-transaction' });
      await assert.rejects(Promise.resolve().then(() => mutate(context)));
      assert.equal(context.commands.length, 0);
    });
  }
});

test('later State-Proof verification upgrades assurance without rewriting fast release evidence', async t => {
  const { session, scope } = await fixture(t);
  const version = await session.freeze({ text: 'upgrade', mode: 'Sealed', scope, editRevision: 1 });
  await assert.rejects(session.upgradeConsensus({ id: version.id, envelope: Buffer.from('{}'), trust: {} }), /must precede/);
  const fast = await session.confirmFast({ id: version.id, scope, currentText: 'upgrade', editRevision: 1,
    transactionId: 'upgrade-transaction' });
  await session.release({ id: version.id, scope, currentText: 'upgrade', editRevision: 1 });
  const attemptBefore = session.runtime.snapshot().attempts[fast.attempt?.attemptId] ?? Object.values(session.runtime.snapshot().attempts)[0];
  const request = session.anchorRequest(version.id);
  const envelope = Buffer.from(canonical({ profile: 'pap-anchor-envelope/1', recordDigest: version.recordDigest,
    batch: request.batch, adapter: { profile: 'pap-algorand-sp/1', network: 'test-only-network', genesis: 'test-only-genesis' }, proof: { synthetic: true } }));
  const upgraded = await session.upgradeConsensus({ id: version.id, envelope, trust: {} });
  assert.equal(upgraded.anchor, 'CONSENSUS_VERIFIED'); assert.equal(upgraded.timestamp, 'BLOCK_HASH_BOUND');
  assert.deepEqual(session.runtime.snapshot().attempts[attemptBefore.attemptId].confirmation, attemptBefore.confirmation);
  assert.equal(attemptBefore.confirmation.result, 'SOURCE_CORROBORATED');
  const preview = session.receipts.prepare({ ids: [version.descriptorId] });
  const exported = session.receipts.export(preview.previewId), bundle = parseCanonical(exported);
  assert.equal(bundle.publicProofObjects.length, 1);
  const receipt = verifyPortable(exported).records.find(r => r.recordDigest === version.recordDigest);
  assert.equal(receipt.releaseControl, 'CLIENT_ENFORCED_ASSERTION');
  assert.equal(receipt.anchor, 'INDETERMINATE');
  assert.equal(receipt.localAssertions.find(a => a.kind === 'release-outcome').authorizationAnchor, 'SOURCE_CORROBORATED');
  await assert.rejects(session.upgradeConsensus({ id: version.id, envelope: Buffer.from('{}'), trust: {} }), /Duplicate/);
});

test('collector queries both configured operators concurrently and maps only bounded corroboration evidence', async () => {
  const starts = []; let tick = 0;
  const evidence = await collectFastEvidence({ trust: fastTrust, now: () => [0, 12][tick++], observe: async operator => {
    starts.push(operator.id);
    return { profile: FAST_CONFIRM_PROFILE, network: 'testnet-v1.0', genesis: 'test-genesis', consensus: 'consensus',
      transactionId: 'tx', confirmedRound: 7, blockHeaderHash: 'header', sourceClaimedTime: '2026-09-10T12:00:00Z',
      poolError: '', error: '', expired: false, transaction: 'tx-bytes', signedTxnInBlock: 'stib', fullHeader: 'header-bytes',
      transactionProof: { hashtype: 'sha256' } };
  }});
  assert.deepEqual(starts.sort(), ['a', 'b']); assert.equal(evidence.sources.length, 2);
  assert.equal(evidence.observedWaitMillis, 12); assert.equal(evidence.sources[1].organization, 'Operator B');
});

test('extension manifest is limited to the supported ChatGPT surface and exposes no attachment or ambient data permission', async () => {
  const root = new URL('../spikes/browser/chatgpt/extension/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
  assert.deepEqual(manifest.permissions.slice().sort(), ['nativeMessaging', 'tabs']);
  assert.deepEqual(manifest.host_permissions, ['https://chatgpt.com/*']);
  assert.deepEqual(manifest.content_scripts[0].matches, ['https://chatgpt.com/*']);
  const publicKey = Buffer.from(manifest.key, 'base64');
  const keyHash = createHash('sha256').update(publicKey).digest().subarray(0, 16);
  const derivedId = [...keyHash].map(byte => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join('');
  assert.equal(derivedId, extensionId);
  const content = await readFile(new URL('content-script.js', root), 'utf8');
  assert.match(content, /#prompt-textarea/); assert.match(content, /send-button/);
  assert.doesNotMatch(content, /clipboard|downloads|history|bookmarks|file:\/\//i);
  const worker = await readFile(new URL('service-worker.js', root), 'utf8');
  assert.match(worker, /browser: \{ product: 'UNVERIFIED', channel: 'UNVERIFIED', major: 0 \}/);
  assert.doesNotMatch(worker, /browser: \{ product: 'Google Chrome', channel: 'stable'/);
});

test('pinned ChatGPT content script injects exact authorized bytes and fails before exposure on unknown markup', async () => {
  const source = await readFile(new URL('../spikes/browser/chatgpt/extension/content-script.js', import.meta.url), 'utf8');
  function load({ supported = true, url = 'https://chatgpt.com/' } = {}) {
    let listener, clicked = 0;
    class Textarea {}
    class Editor {
      constructor() { this.textContent = ''; }
      getAttribute(name) { return name === 'contenteditable' ? 'true' : null; }
      replaceChildren(node) { this.textContent = node.value; }
      dispatchEvent() {}
    }
    const editor = new Editor(), send = { disabled: false, click: () => { clicked++; } };
    const document = {
      querySelectorAll(selector) {
        if (selector === '#prompt-textarea') return supported ? [editor] : [];
        if (selector === 'button[data-testid="send-button"]') return supported ? [send] : [];
        if (selector === 'input[type=file]') return [];
        return [];
      },
      querySelector: () => null,
      createTextNode: value => ({ value }),
    };
    const pageUrl = new URL(url);
    runInNewContext(source, {
      location: { origin: pageUrl.origin, pathname: pageUrl.pathname, href: pageUrl.href }, document,
      HTMLTextAreaElement: Textarea, InputEvent: class {}, TextEncoder, TextDecoder, atob, btoa, crypto: webcrypto,
      chrome: { runtime: { onMessage: { addListener: callback => { listener = callback; } } } },
    });
    return { editor, clicked: () => clicked, send: message => new Promise(resolve => listener(message, {}, resolve)) };
  }
  const page = load(), text = 'exact e\u0301\r\n☕';
  const textDigest = createHash('sha256').update(Buffer.from(text)).digest('hex');
  const response = await page.send({ kind: 'PAP_RELEASE', pageContract: CHATGPT_PAGE_CONTRACT,
    expectedUrl: 'https://chatgpt.com/', destination: 'new-chat',
    attemptId: 'attempt', textDigest, textBytes: Buffer.from(text).toString('base64') });
  assert.equal(page.editor.textContent, text); assert.equal(page.clicked(), 1);
  assert.equal(response.attemptId, 'attempt'); assert.equal(response.textDigest, textDigest);
  assert.equal(response.exposure, 'DOM_INJECTED'); assert.equal(response.submitted, true);
  assert.equal(response.observation, 'LOCAL_CLICK_DISPATCHED');
  const unknown = load({ supported: false });
  const rejected = await unknown.send({ kind: 'PAP_RELEASE', pageContract: CHATGPT_PAGE_CONTRACT,
    expectedUrl: 'https://chatgpt.com/', destination: 'new-chat', attemptId: 'unknown',
    textDigest: createHash('sha256').update('never').digest('hex'), textBytes: Buffer.from('never').toString('base64') });
  assert.equal(rejected.exposure, 'NONE'); assert.equal(rejected.submitted, false); assert.equal(unknown.clicked(), 0);
  const corrupted = load();
  const wrongDigest = await corrupted.send({ kind: 'PAP_RELEASE', pageContract: CHATGPT_PAGE_CONTRACT,
    expectedUrl: 'https://chatgpt.com/', destination: 'new-chat', attemptId: 'corrupt',
    textDigest, textBytes: Buffer.from('different valid UTF-8').toString('base64') });
  assert.equal(wrongDigest.exposure, 'NONE'); assert.equal(corrupted.editor.textContent, '');
  const changedScope = load({ url: 'https://chatgpt.com/c/other' });
  const wrongScope = await changedScope.send({ kind: 'PAP_RELEASE', pageContract: CHATGPT_PAGE_CONTRACT,
    expectedUrl: 'https://chatgpt.com/', destination: 'new-chat', attemptId: 'wrong-scope',
    textDigest, textBytes: Buffer.from(text).toString('base64') });
  assert.equal(wrongScope.exposure, 'NONE'); assert.equal(changedScope.editor.textContent, '');
});

test('native bridge frames bounded messages and correlates only the exact release attempt', async () => {
  const decoder = new NativeFrameDecoder(), frame = encodeNativeFrame({ kind: 'PAP_STATE', value: 'split frame' });
  assert.deepEqual(decoder.push(frame.subarray(0, 7)), []);
  assert.deepEqual(decoder.push(frame.subarray(7)), [{ kind: 'PAP_STATE', value: 'split frame' }]);
  const oversized = Buffer.alloc(4); oversized.writeUInt32LE(512 * 1024 + 1);
  assert.throws(() => decoder.push(oversized), /limit/);
  const record = JSON.parse(rendezvousRecord({
    extensionOrigin: `chrome-extension://${extensionId}/`, socketPath: '/private/tmp/test-only.sock',
    runtimeEpoch: 'runtime-epoch', expiresAt: '2026-09-11T12:05:00.000Z', token: randomBytes(32),
  }));
  assert.equal(Buffer.from(record.token, 'base64url').length, 32);
  assert.throws(() => rendezvousRecord({ extensionOrigin: '', socketPath: '', runtimeEpoch: '', expiresAt: '', token: null }), /fresh/);

  let controller, outbound;
  const adapter = new ChatGPTChromeAdapter(command => controller.sendRelease(command), { extensionId });
  controller = new ChromeBridgeController(adapter, message => {
    outbound = structuredClone(message);
    queueMicrotask(() => controller.receive(observedResponse(message)));
  }, { localBrowser: { product: 'Google Chrome', channel: 'stable', major: 153 },
    localPlatform: { product: 'macOS', arch: 'arm64', version: '15.7.2' } });
  controller.receive({ kind: 'PAP_HELLO', ...connection({
    browser: { product: 'UNVERIFIED', channel: 'UNVERIFIED', major: 0 },
    platform: { product: 'unknown', arch: 'unknown', version: '' },
  }), tabs: [tab()] });
  const enrollment = adapter.enroll({ tabId: 17, destination: 'new-chat' });
  const state = await adapter.dispatch({ scope: enrollment.scope, protocol: CHATGPT_RELEASE_PROTOCOL,
    attemptId: 'attempt-one', digest: 'a'.repeat(64), payload: { text: 'exact bridge text', attachments: [] } });
  assert.equal(state, 'SUBMISSION_OBSERVED'); assert.equal(outbound.kind, 'PAP_RELEASE');
  assert.equal(Buffer.from(outbound.textBytes, 'base64').toString(), 'exact bridge text');
  assert.equal(outbound.expectedUrl, 'https://chatgpt.com/'); assert.equal(outbound.destination, 'new-chat');
  assert.equal(Object.hasOwn(outbound, 'text'), false); assert.equal(Object.hasOwn(outbound, 'authorization'), false);
  controller.disconnect();
  assert.equal(await adapter.dispatch({ scope: enrollment.scope, protocol: CHATGPT_RELEASE_PROTOCOL,
    attemptId: 'attempt-two', digest: 'b'.repeat(64), payload: { text: 'never sent', attachments: [] } }), 'FAILED_BEFORE_EGRESS');
});

test('packaged composer and isolated native framing drive the real bridge, adapter, and Sealed session', async t => {
  const root = await realpath(await mkdtemp('/private/tmp/provenance-native-e2e-'));
  const input = new PassThrough(), output = new PassThrough();
  const attestation = {
    browser: { product: 'Google Chrome', channel: 'stable', major: 153 },
    platform: { product: 'macOS', arch: 'arm64', version: '15.7.2' },
  };
  let peerAttempts = 0;
  const runtime = await startPackagedChatGPT({ supportDirectory: root,
    fastTrust, keyStore: new MemoryKeyStore(), openBrowser: false,
    collectFast: async ({ transactionId }) => ({ collectedBy: 'two-operator-observer', transactionId }),
    verifyFast: () => structuredClone(fastReport),
    attestPeer: async () => {
      if (++peerAttempts === 1) throw Error('test-only unauthorized direct peer');
      return structuredClone(attestation);
    },
  });
  let nativeSocket;
  t.after(async () => {
    input.end(); nativeSocket?.destroy(); await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  assert.equal((await lstat(runtime.rendezvousPath)).mode & 0o077, 0);
  assert.equal((await lstat(runtime.socketPath)).mode & 0o077, 0);

  const record = JSON.parse(await readFile(runtime.rendezvousPath, 'utf8'));
  const rejected = createConnection(runtime.socketPath); await once(rejected, 'connect');
  const rejectedClosed = new Promise(resolve => rejected.once('close', resolve));
  rejected.on('error', () => {});
  rejected.write(`${canonical({ kind: 'PAP_BRIDGE_AUTH', profile: NATIVE_BRIDGE_PROFILE,
    extensionOrigin: `chrome-extension://${extensionId}/`, runtimeEpoch: record.runtimeEpoch,
    token: record.token })}\n`);
  await rejectedClosed;
  assert.equal(peerAttempts, 1); assert.equal(runtime.browserState(), null);

  nativeSocket = await runNativeHost({ extensionOrigin: `chrome-extension://${extensionId}/`,
    rendezvousPath: runtime.rendezvousPath, input, output });
  input.write(encodeNativeFrame({ kind: 'PAP_HELLO', ...connection({
    browser: { product: 'UNVERIFIED', channel: 'UNVERIFIED', major: 0 },
    platform: { product: 'unknown', arch: 'unknown', version: '' },
  }), tabs: [tab()] }));
  await runtime.waitForPairing();
  const composer = new URL(runtime.composerURL), secret = composer.hash.slice(1), origin = composer.origin;
  const api = async (path, data = {}, token = secret) => {
    const response = await fetch(new URL(path, origin), { method: 'POST', headers: {
      Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
    }, body: JSON.stringify(data) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await api('/status', {}, 'wrong-token')).status, 400);
  const status = await api('/status');
  assert.equal(status.status, 200); assert.equal(status.body.browser.tabs[0].id, 17);
  const enrollment = (await api('/enroll', { tabId: 17, destination: 'new-chat' })).body;
  const version = (await api('/freeze', { text: 'socket-bound exact text', attachments: [],
    mode: 'Sealed', scope: enrollment.scope, editRevision: 1 })).body;
  const anchor = await api('/anchor-request', { id: version.id });
  assert.equal(anchor.status, 200); assert.equal(typeof anchor.body.payload, 'string');
  const confirmed = (await api('/confirm', { id: version.id, transactionId: 'A'.repeat(52),
    scope: enrollment.scope, currentText: 'socket-bound exact text', attachments: [], editRevision: 1 })).body;
  assert.equal(confirmed.state, 'SEALED_NOT_SENT');

  const decoder = new NativeFrameDecoder();
  const releaseFrame = new Promise((resolve, reject) => {
    output.on('data', chunk => {
      try {
        const messages = decoder.push(chunk);
        if (messages.length) resolve(messages[0]);
      } catch (error) { reject(error); }
    });
  });
  const release = api('/release', { id: version.id, scope: enrollment.scope,
    currentText: 'socket-bound exact text', attachments: [], editRevision: 1 });
  const command = await releaseFrame;
  assert.equal(command.kind, 'PAP_RELEASE');
  assert.equal(Buffer.from(command.textBytes, 'base64').toString('utf8'), 'socket-bound exact text');
  input.write(encodeNativeFrame(observedResponse(command)));
  const result = await release;
  assert.equal(result.status, 200); assert.equal(result.body.state, 'SUBMISSION_OBSERVED');
  const durable = runtime.session.runtime.snapshot().seals[version.id];
  assert.equal(durable.confirmation.profile, FAST_CONFIRM_PROFILE);
  assert.equal(durable.confirmation.result, 'SOURCE_CORROBORATED');
});

test('unsupported platform or extension identity cannot pair', () => {
  const adapter = new ChatGPTChromeAdapter(async () => {}, { extensionId });
  for (const bad of [connection({ extensionId: 'a'.repeat(32) }),
    connection({ platform: { product: 'macOS', arch: 'x86_64', version: '15.7' } }),
    connection({ platform: { product: 'macOS', arch: 'arm64', version: '15.6' } }),
    connection({ browser: { product: 'Google Chrome', channel: 'stable', major: 152 } })]) {
    assert.throws(() => adapter.pair(bad), /UNSUPPORTED_PATH/);
  }
  assert.throws(() => new ChromeBridgeController(adapter, () => {}, {}), /Authenticated local browser/);
});
