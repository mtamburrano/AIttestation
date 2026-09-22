import { request } from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { recordingFixture, until } from './recording-fixture.mjs';
import { ChatGPTChromeAdapter, CHATGPT_EXTENSION_ID, CHATGPT_ADAPTER_PROFILE, CHATGPT_PAGE_CONTRACT } from '../spikes/browser/chatgpt/adapter.mjs';
import { ChromeBridgeController } from '../spikes/browser/chatgpt/bridge.mjs';
import { encodeNativeFrame, NativeFrameDecoder } from '../spikes/browser/chatgpt/native-host.mjs';
import { testTab } from './chrome-worker-fixture.mjs';
import { FAST_CONFIRM_PROFILE, collectFastEvidence } from '../spikes/anchor/algorand/fast-confirm.mjs';
import { validateText, MAX_TEXT_BYTES } from '../spikes/vault/text.mjs';
import { canonical } from '../spikes/vault/format.mjs';
import { identity as signingIdentity } from '../spikes/vault/records.mjs';
import { signedLogFixture } from '../spikes/anchor/fixture.mjs';
import { verifyAnchor } from '../spikes/anchor/verifier.mjs';
import { verifyPortable } from '../spikes/recipient/portable.mjs';
import { chatGPTDestinationForURL, isChatGPTRouteIdentifier, isChatGPTDestination } from '../spikes/recipient/chatgpt-route.mjs';
import { validateCaptureSource } from '../spikes/recipient/normal-observation.mjs';

const fastTrust = {
  profile: FAST_CONFIRM_PROFILE, network: 'testnet-v1.0', genesis: 'test-genesis',
  applicationServiceOrigin: 'https://anchor.example',
  operators: [
    { id: 'a', organization: 'Operator A', endpoint: 'https://algod-a.example' },
    { id: 'b', organization: 'Operator B', endpoint: 'https://algod-b.example' },
  ],
};

const identity = { browser: { product: 'Google Chrome', channel: 'stable', major: 153 },
  platform: { product: 'macOS', arch: 'arm64', version: '15.7.2' } };
const hello = () => ({ kind: 'PAP_HELLO', extensionId: CHATGPT_EXTENSION_ID,
  adapterProfile: CHATGPT_ADAPTER_PROFILE, captureProfile: 'pap-chatgpt-capture/5',
  pageContract: CHATGPT_PAGE_CONTRACT, browserSessionId: 'synthetic-browser-session', ...identity,
  permissions: ['nativeMessaging'], hostPermission: 'https://chatgpt.com/*', permissionState: 'granted', tabs: [testTab()] });
test('bounded route grammar agrees across adapter destinations and signed capture sources', () => {
  const adapter = new ChatGPTChromeAdapter({ extensionId: CHATGPT_EXTENSION_ID }); adapter.pair(hello());
  const uuid = '11111111-2222-4333-8444-555555555555';
  const source = destination => ({ adapterProfile: CHATGPT_ADAPTER_PROFILE, pageContract: CHATGPT_PAGE_CONTRACT,
    runtimeEpoch: 'synthetic-runtime', browserSessionId: 'synthetic-session', scope: randomUUID(),
    tabId: 17, windowId: 1, tabEpoch: 'synthetic-epoch', documentId: 'synthetic-document', destination });
  for (const identifier of ['a', 'a_Z-09', 'a'.repeat(243), `WEB:${uuid}`, `WEB:${uuid.toUpperCase()}`]) {
    assert.equal(isChatGPTRouteIdentifier(identifier), true);
    for (const ending of ['', '/']) {
      const url = `https://chatgpt.com/c/${identifier}${ending}`, destination = `conversation:${identifier}`;
      assert.equal(chatGPTDestinationForURL(url), destination);
      adapter.synchronize({ ...hello(), tabs: [testTab({ url, destination })] });
      assert.equal(adapter.scopes()[0]?.destination, destination);
      assert.doesNotThrow(() => validateCaptureSource(source(destination)));
    }
  }
  for (const identifier of ['', 'a'.repeat(244), 'WEB:', 'WEB:not-a-uuid', `web:${uuid}`, `OTHER:${uuid}`,
    `WEB:${uuid}:extra`, 'a/b', 'a?b', 'a#b', 'a b', 'a\nb', 'a\n', 'a\r', 'a\t', 'a%2Fb', `WEB%3A${uuid}`, 'https://example.com', 'a\\b']) {
    assert.equal(isChatGPTRouteIdentifier(identifier), false, JSON.stringify(identifier));
    const destination = `conversation:${identifier}`, url = `https://chatgpt.com/c/${identifier}`;
    assert.equal(chatGPTDestinationForURL(url), null, JSON.stringify(url));
    assert.equal(isChatGPTDestination(destination), false);
    assert.throws(() => validateCaptureSource(source(destination)), /INVALID_CAPTURE_OBSERVATION/);
    adapter.synchronize({ ...hello(), tabs: [testTab({ url, destination: '' })] });
    assert.equal(adapter.scopes().length, 0);
  }
  for (const url of ['http://chatgpt.com/c/a', 'https://chatgpt.com.evil/c/a', 'https://user@chatgpt.com/c/a',
    'https://chatgpt.com:443/c/a', 'https://chatgpt.com/c/a//', 'https://chatgpt.com/c/a/?x',
    'https://chatgpt.com/c/a/#x', 'https://chatgpt.com/?x', 'https://chatgpt.com/#x']) {
    assert.equal(chatGPTDestinationForURL(url), null, url);
    adapter.synchronize({ ...hello(), tabs: [testTab({ url, destination: 'conversation:a' })] });
    assert.equal(adapter.scopes().length, 0);
  }
  assert.equal(chatGPTDestinationForURL('https://chatgpt.com/'), 'new-chat');
  assert.doesNotThrow(() => validateCaptureSource(source('new-chat')));
});
async function fixture(t, options) {
  const directory = await mkdtemp('/private/tmp/attestamp-boundary-test-'); const f = await recordingFixture(directory, options);
  t.after(async () => { await f.close(); await rm(directory, { recursive: true, force: true }); }); return f;
}
test('source discovery automatically includes new and duplicate-conversation tabs across windows', () => {
  const adapter = new ChatGPTChromeAdapter({ extensionId: CHATGPT_EXTENSION_ID }); adapter.pair(hello());
  adapter.synchronize(hello()); const first = adapter.scopes()[0];
  adapter.synchronize({ ...hello(), tabs: [testTab(), testTab({ id: 18, windowId: 2, active: false })] });
  assert.equal(adapter.scopes().length, 2); assert.equal(adapter.scopes()[0].scope, first.scope);
  assert.equal(adapter.scopes()[0].destination, adapter.scopes()[1].destination);
  assert.notEqual(adapter.scopes()[0].scope, adapter.scopes()[1].scope);
  adapter.synchronize({ ...hello(), tabs: [testTab({ id: 18, windowId: 2 }), testTab({ id: 19, windowId: 3 })] });
  assert.equal(adapter.scopes().length, 2); assert.ok(!adapter.scopes().some(source => source.scope === first.scope));
  assert.equal(adapter.enroll, undefined); assert.equal(adapter.dispatch, undefined);
});
test('identity, permissions, old contracts and extra release capability cannot pair', () => {
  for (const changes of [{ extensionId: 'a'.repeat(32) }, { adapterProfile: 'pap-chatgpt-chrome/5' },
    { captureProfile: 'pap-chatgpt-capture/1' }, { releaseProtocol: 'pap-chatgpt-release/2' },
    { pageContract: 'stale' }, { permissionState: 'revoked' }, { platform: { product: 'Linux' } },
    { browser: { product: 'Google Chrome', channel: 'beta', major: 153 } }]) {
    const adapter = new ChatGPTChromeAdapter({ extensionId: CHATGPT_EXTENSION_ID });
    assert.throws(() => adapter.pair({ ...hello(), ...changes }), /UNSUPPORTED_PATH/);
    assert.deepEqual(adapter.scopes(), []);
  }
});
test('bridge rejects removed release messages and bounded native framing remains enforced', () => {
  const adapter = new ChatGPTChromeAdapter({ extensionId: CHATGPT_EXTENSION_ID }), sent = [];
  const bridge = new ChromeBridgeController(adapter, value => sent.push(value), { localBrowser: identity.browser, localPlatform: identity.platform });
  bridge.receive(hello());
  for (const kind of ['PAP_RELEASE', 'PAP_CHECK_RELEASE', 'PAP_RELEASE_CHECKED']) {
    assert.throws(() => bridge.receive({ kind, attemptId: randomUUID() }), /Unsupported Chrome bridge message/);
  }
  assert.equal(bridge.sendRelease, undefined); assert.equal(sent.length, 1);
  const bytes = encodeNativeFrame(hello()), decoder = new NativeFrameDecoder();
  assert.deepEqual(decoder.push(bytes.subarray(0, 3)), []);
  assert.deepEqual(decoder.push(bytes.subarray(3)), [hello()]);
  const oversized = Buffer.alloc(4); oversized.writeUInt32LE(1024 * 1024 + 1);
  assert.throws(() => new NativeFrameDecoder().push(oversized));
});
test('authenticated dashboard has no generic prompt-writing, enrollment, freeze or release endpoints', async t => {
  const f = await fixture(t), url = new URL(f.runtime.dashboardURL);
  for (const path of ['/freeze', '/draft', '/release', '/cancel', '/enroll', '/observe', '/capture']) {
    const response = await fetch(new URL(path, url), { method: 'POST', headers: {
      Origin: url.origin, Authorization: `Bearer ${url.hash.slice(1)}` }, body: JSON.stringify({ text: 'FORGED_SYNTHETIC' }) });
    assert.equal(response.status, 400);
  }
  for (const headers of [{}, { Origin: 'https://chatgpt.com', Authorization: `Bearer ${url.hash.slice(1)}` },
    { Origin: url.origin, Authorization: 'Bearer invalid' }]) {
    const response = await fetch(new URL('/engine/state', url), { method: 'POST', headers, body: '{}' });
    assert.equal(response.status, 400);
  }
  const status = await new Promise((resolve, reject) => {
    const req = request(new URL('/engine/state', url), { method: 'POST', headers: {
      Host: 'localhost', Origin: url.origin, Authorization: `Bearer ${url.hash.slice(1)}` } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    }); req.on('error', reject); req.end('{}');
  });
  assert.equal(status, 400);
  assert.equal(f.runtime.session.receipts.list().length, 0);
});
test('rejected archival assurance leaves the existing exact observation and fast status unchanged', async t => {
  const f = await fixture(t); await f.recording(true); f.send('ARCHIVE_SYNTHETIC');
  await until(() => f.runtime.session.receipts.list().length === 1); await f.runtime.engine.drain();
  const version = f.runtime.session.status().versions[0];
  await assert.rejects(f.runtime.session.upgradeConsensus({ id: version.id, envelope: Buffer.from('{}'), trust: {} }), /NO_ARCHIVE_FIXTURE/);
  assert.equal(f.runtime.session.status().versions[0].anchor, 'SOURCE_CORROBORATED');
  assert.equal(f.releases.length, 0);
});

test('an injected consensus verdict adds durable assurance without rewriting the observation or overstating portable fixture proof', async t => {
  const f = await fixture(t, { verifyArchive: (bytes, trust, digest) => {
    const report = verifyAnchor(bytes, trust, digest);
    assert.equal(report.anchor, 'FIXTURE_VERIFIED');
    // The state-transition verdict is synthetic; portable verification below
    // still checks the real signed-log proof and must not call it consensus.
    return { independentlyVerified: true, anchor: 'CONSENSUS_VERIFIED', timestamp: 'BLOCK_HASH_BOUND', round: 42 };
  } });
  await f.recording(true); f.send('ARCHIVE_TRANSITION_SYNTHETIC');
  await until(() => f.runtime.session.receipts.list().length === 1); await f.runtime.engine.drain();
  const version = f.runtime.session.status().versions[0], key = signingIdentity();
  const trust = { profile: 'pap-signed-log-fixture/1', network: 'synthetic-log', genesis: 'test-only-genesis',
    checkpoint: { publicKey: key.publicKey.export({ format: 'jwk' }).x, minimumSequence: '1' } };
  const original = f.runtime.session.vault.inspect().records.find(record => record.recordDigest === version.recordDigest);
  const before = canonical(original), envelope = signedLogFixture([version.recordDigest], 0, key);
  const updated = await f.runtime.session.upgradeConsensus({ id: version.id, envelope, trust });
  assert.equal(updated.anchor, 'CONSENSUS_VERIFIED'); assert.equal(updated.assuranceHistory.length, 2);
  assert.equal(canonical(f.runtime.session.vault.inspect().records.find(record => record.recordDigest === version.recordDigest)), before);
  await assert.rejects(f.runtime.session.upgradeConsensus({ id: version.id, envelope, trust }), /Duplicate/);
  const preview = f.runtime.session.receipts.prepare({ ids: [version.descriptorId] });
  const report = verifyPortable(f.runtime.session.receipts.export(preview.previewId), trust);
  const target = report.records.find(record => record.recordDigest === version.recordDigest);
  assert.equal(target.anchor, 'FIXTURE_VERIFIED'); assert.equal(target.releaseControl, 'OBSERVED_ONLY');
  await f.restart(); assert.equal(f.runtime.session.status().versions[0].anchor, 'CONSENSUS_VERIFIED');
  assert.equal(f.releases.length, 0);
});
test('exact text validation rejects invalid Unicode and byte overflow', () => {
  assert.equal(validateText('\uFEFFe\u0301\r\n☕'), '\uFEFFe\u0301\r\n☕');
  assert.equal(validateText('x'.repeat(MAX_TEXT_BYTES)).length, MAX_TEXT_BYTES);
  for (const value of ['\uD800', '\uDC00', 'é'.repeat(MAX_TEXT_BYTES), null]) assert.throws(() => validateText(value));
});

test('collector queries both configured operators concurrently and maps only bounded corroboration evidence', async () => {
  const starts = []; let tick = 0;
  const transactionId = 'A'.repeat(52);
  const evidence = await collectFastEvidence({ trust: fastTrust, transactionId, now: () => tick++ ? 12 : 0, observe: async operator => {
    starts.push(operator.id);
    return { profile: FAST_CONFIRM_PROFILE, network: 'testnet-v1.0', genesis: 'test-genesis', consensus: 'consensus',
      transactionId, confirmedRound: 7, blockHeaderHash: 'header', sourceClaimedTime: '2026-09-10T12:00:00Z',
      poolError: '', error: '', expired: false, transaction: 'tx-bytes', signedTxnInBlock: 'stib', fullHeader: 'header-bytes',
      transactionProof: { hashtype: 'sha256' } };
  }});
  assert.deepEqual(starts.sort(), ['a', 'b']); assert.equal(evidence.sources.length, 2);
  assert.equal(evidence.observedWaitMillis, 12); assert.equal(evidence.sources[1].organization, 'Operator B');
});

test('extension manifest is limited to the supported ChatGPT surface and exposes no attachment or ambient data permission', async () => {
  const root = new URL('../spikes/browser/chatgpt/extension/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
  assert.equal(manifest.name, 'Attestamp for ChatGPT');
  assert.equal(manifest.short_name, 'Attestamp');
  assert.equal(manifest.version, '2.3.3');
  assert.ok(manifest.description.length <= 132, 'Chrome Web Store short description limit');
  assert.match(manifest.description, /Attestamp desktop app/);
  assert.match(manifest.description, /supported ChatGPT tabs/);
  assert.deepEqual(manifest.permissions.slice().sort(), ['nativeMessaging', 'sidePanel']);
  assert.equal(manifest.incognito, 'not_allowed');
  assert.deepEqual(manifest.host_permissions, ['https://chatgpt.com/*']);
  assert.deepEqual(manifest.content_scripts[0].matches, ['https://chatgpt.com/*']);
  const publicKey = Buffer.from(manifest.key, 'base64');
  const keyHash = createHash('sha256').update(publicKey).digest().subarray(0, 16);
  const derivedId = [...keyHash].map(byte => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join('');
  assert.equal(derivedId, CHATGPT_EXTENSION_ID, 'consumer metadata updates must preserve the assigned Store ID');
  const content = await readFile(new URL('content-script.js', root), 'utf8');
  assert.match(content, /#prompt-textarea/); assert.match(content, /send-button/);
  assert.doesNotMatch(content, /clipboard|downloads|bookmarks|file:\/\//i);
  // A product History label does not grant access to the browser history API.
  assert.doesNotMatch(content, /\bhistory\s*(?:\.|\[)|\[\s*['"]history['"]\s*\]/i);
  const worker = await readFile(new URL('service-worker.js', root), 'utf8');
  assert.match(worker, /browser: \{ product: 'UNVERIFIED', channel: 'UNVERIFIED', major: 0 \}/);
  assert.doesNotMatch(worker, /browser: \{ product: 'Google Chrome', channel: 'stable'/);
});
