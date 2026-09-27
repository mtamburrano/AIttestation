import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { browserExtensionFiles, buildBrowserExtensions } from '../spikes/browser/shared/build-extensions.mjs';
import { FIREFOX_EXTENSION_ID, FIREFOX_PRIVATE_EXTENSION_ID } from '../spikes/browser/shared/profiles.mjs';
import { FirefoxIntegration } from '../spikes/browser/firefox/integration.mjs';
import { ChatGPTFirefoxAdapter } from '../spikes/browser/firefox/adapter.mjs';
import { FIREFOX_ADAPTER_PROFILE, FIREFOX_CAPTURE_PROFILE } from '../spikes/recipient/firefox-observation.mjs';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { recordingFixture, until } from './recording-fixture.mjs';
import { testTab } from './chrome-worker-fixture.mjs';
import { runNativeHost, NativeFrameDecoder, encodeNativeFrame, FIREFOX_NATIVE_BRIDGE_PROFILE } from '../spikes/browser/chatgpt/native-host.mjs';
import { ENGINE_COMMAND_PROFILE, RECORDING_CONTROL_PROFILE } from '../spikes/core/recording-engine.mjs';
import { CHATGPT_PAGE_CONTRACT } from '../spikes/browser/chatgpt/adapter.mjs';
import { scaleObservation } from './vault-scale-fixture.mjs';

test('both browser builds share the exact fetch decoder and keep separate manifests, identity and controls', async () => {
  await buildBrowserExtensions({ check: true });
  const chrome = await browserExtensionFiles('chrome'), firefox = await browserExtensionFiles('firefox');
  assert.equal(chrome.get('fetch-observer.js'), firefox.get('fetch-observer.js'));
  const manifest = JSON.parse(firefox.get('manifest.json'));
  assert.deepEqual(manifest.background, { scripts: ['service-worker.js'] });
  assert.equal(manifest.sidebar_action.default_panel, 'sidepanel.html'); assert.equal(manifest.side_panel, undefined);
  assert.equal(manifest.browser_specific_settings.gecko.id, FIREFOX_EXTENSION_ID);
  assert.ok(manifest.browser_specific_settings.gecko.data_collection_permissions.required.includes('personalCommunications'));
  const privateManifest = JSON.parse((await browserExtensionFiles('firefox', { privateIdentity: true })).get('manifest.json'));
  assert.equal(privateManifest.browser_specific_settings.gecko.id, FIREFOX_PRIVATE_EXTENSION_ID);
  assert.ok(!firefox.get('service-worker.js').includes('pap-chatgpt-chrome/9'));
  assert.ok(chrome.get('service-worker.js').includes('const FIREFOX = false;'));
});

test('Firefox adapter rejects a Chrome identity and retains real Firefox namespaces', () => {
  const adapter = new ChatGPTFirefoxAdapter({ extensionId: FIREFOX_EXTENSION_ID });
  const hello = { extensionId: FIREFOX_EXTENSION_ID, adapterProfile: FIREFOX_ADAPTER_PROFILE, captureProfile: FIREFOX_CAPTURE_PROFILE,
    pageContract: 'chatgpt-web-text/2026-09-21.1', browserSessionId: 'synthetic-firefox-session',
    browser: { product: 'Firefox', major: 153, channel: 'stable' }, platform: { product: 'macOS', arch: 'arm64', version: '15.7.2' },
    permissions: ['nativeMessaging', 'scripting'], permissionState: 'granted', hostPermission: 'https://chatgpt.com/*', tabs: [] };
  assert.throws(() => adapter.pair({ ...hello, browser: { ...hello.browser, product: 'Google Chrome' } }));
  adapter.pair(hello); assert.equal(adapter.controlProfile, FIREFOX_ADAPTER_PROFILE); assert.equal(adapter.captureProfile, FIREFOX_CAPTURE_PROFILE);
});

test('Firefox registration preserves Chrome and detects edits before removing only its owned manifest', async t => {
  const root = await mkdtemp('/private/tmp/attestamp-firefox-install-test-'); t.after(() => rm(root, { recursive: true, force: true }));
  const support = join(root, 'support'), manifests = join(root, 'mozilla'); await mkdir(support); await mkdir(manifests);
  const other = join(manifests, 'ai.provenance.consumer.json'); await writeFile(other, 'unrelated synthetic Chrome registration');
  const enabled = [], manager = await new FirefoxIntegration({ supportDirectory: support, manifestDirectory: manifests,
    receiver: join(root, 'App/Contents/MacOS/provenance-firefox-host'), setEnabled: async (...args) => enabled.push(args) }).init();
  assert.equal((await manager.status()).configured, false);
  const plan = await manager.preview(); await manager.apply({ operationId: plan.operationId, consent: true });
  const path = plan.configPath, manifest = JSON.parse(await readFile(path));
  assert.deepEqual(manifest.allowed_extensions, [FIREFOX_EXTENSION_ID]); assert.equal(manifest.allowed_origins, undefined);
  const removing = await manager.preview({ action: 'remove' }); await writeFile(path, JSON.stringify({ ...manifest, description: 'changed' }));
  await assert.rejects(manager.apply({ operationId: removing.operationId, consent: true }), /CONFLICT/);
  assert.deepEqual(enabled.at(-1), ['firefox-chatgpt', false]);
  await writeFile(path, JSON.stringify(manifest)); const remove = await manager.preview({ action: 'remove' });
  await manager.apply({ operationId: remove.operationId, consent: true });
  await assert.rejects(readFile(path), { code: 'ENOENT' }); assert.equal(await readFile(other, 'utf8'), 'unrelated synthetic Chrome registration');
});

for (const action of ['install', 'remove']) for (const point of ['journal-written', 'manifest-staged', 'manifest-replaced']) {
  test(`Firefox recovers owned ${action} after interruption at ${point}`, async t => {
    const root = await mkdtemp('/private/tmp/attestamp-firefox-recovery-test-');
    t.after(() => rm(root, { recursive: true, force: true }));
    const supportDirectory = join(root, 'support'), manifestDirectory = join(root, 'mozilla');
    await mkdir(supportDirectory); await mkdir(manifestDirectory);
    const other = join(manifestDirectory, 'unrelated.json'); await writeFile(other, 'unchanged unrelated manifest');
    const enabled = [], options = { supportDirectory, manifestDirectory, receiver: join(root, 'Receiver-A'),
      setEnabled: async (...args) => enabled.push(args) };
    const first = await new FirefoxIntegration(options).init(), install = await first.preview();
    await first.apply({ operationId: install.operationId, consent: true });
    const changed = { ...options, receiver: join(root, 'Receiver-B') };
    const updating = await new FirefoxIntegration({ ...changed, failpoint: async stage => {
      if (stage === point) throw Error('SYNTHETIC_INTERRUPTION');
    } }).init();
    const preview = await updating.preview({ action });
    await assert.rejects(updating.apply({ operationId: preview.operationId, consent: true }), /SYNTHETIC_INTERRUPTION/);
    assert.deepEqual(enabled.at(-1), ['firefox-chatgpt', false]);
    const before = enabled.length, recovered = await new FirefoxIntegration(changed).init();
    assert.equal(enabled.length, before, 'Recovery must never re-enable capture');
    const current = await readFile(install.configPath, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (point === 'manifest-replaced' && action === 'remove') assert.equal(current, null);
    else assert.equal(JSON.parse(current).path, point === 'manifest-replaced' ? changed.receiver : options.receiver);
    // Both repair/update and removal remain available after restart.
    const repair = await recovered.preview(), remove = await recovered.preview({ action: 'remove' });
    assert.ok(repair.operationId); await recovered.apply({ operationId: remove.operationId, consent: true });
    await assert.rejects(readFile(install.configPath), { code: 'ENOENT' });
    assert.equal(await readFile(other, 'utf8'), 'unchanged unrelated manifest');
  });
}

test('Firefox interruption preserves a concurrent third-party edit and reports the unresolved conflict', async t => {
  const root = await mkdtemp('/private/tmp/attestamp-firefox-conflict-test-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { supportDirectory: join(root, 'support'), manifestDirectory: join(root, 'mozilla'),
    receiver: join(root, 'Receiver-A'), setEnabled: async () => {} };
  await mkdir(options.supportDirectory); await mkdir(options.manifestDirectory);
  const manager = await new FirefoxIntegration(options).init(), first = await manager.preview();
  await manager.apply({ operationId: first.operationId, consent: true });
  const external = JSON.stringify({ unrelated: 'PRIVATE_UNRELATED_CONFIGURATION' });
  const updating = await new FirefoxIntegration({ ...options, receiver: join(root, 'Receiver-B'), failpoint: async stage => {
    if (stage === 'manifest-staged') await writeFile(first.configPath, external);
  } }).init();
  const update = await updating.preview();
  await assert.rejects(updating.apply({ operationId: update.operationId, consent: true }), /CONFLICT/);
  const reopened = await new FirefoxIntegration(options).init();
  assert.equal((await reopened.status()).state, 'REPAIR_REQUIRED');
  await assert.rejects(reopened.preview(), /CONFLICT/); await assert.rejects(reopened.preview({ action: 'remove' }), /CONFLICT/);
  assert.equal(await readFile(first.configPath, 'utf8'), external);
});

test('independent Chrome and Firefox native channels share one vault and reject cross-source and stale authority', async t => {
  const root = await mkdtemp('/private/tmp/attestamp-browser-coexist-test-');
  t.after(() => rm(root, { recursive: true, force: true }));
  let peers = 0;
  const f = await recordingFixture(root, { recording: true, managed: null, attestPeer: async () => ({
    browser: { product: peers++ === 0 ? 'Google Chrome' : 'Firefox', major: 153, channel: 'stable' },
    platform: { product: 'macOS', arch: 'arm64', version: '15.7.2' },
  }) });
  t.after(() => f.close());
  const input = new PassThrough(), output = new PassThrough(), frames = [], decoder = new NativeFrameDecoder();
  output.on('data', chunk => frames.push(...decoder.push(chunk)));
  const socket = await runNativeHost({ input, output, profile: FIREFOX_NATIVE_BRIDGE_PROFILE,
    extensionOrigin: `firefox-extension:${FIREFOX_EXTENSION_ID}`, rendezvousPath: f.runtime.firefoxRendezvousPath });
  t.after(() => { socket.destroy(); input.end(); output.end(); });
  input.write(encodeNativeFrame({ kind: 'PAP_HELLO', extensionId: FIREFOX_EXTENSION_ID,
    adapterProfile: FIREFOX_ADAPTER_PROFILE, captureProfile: FIREFOX_CAPTURE_PROFILE,
    pageContract: CHATGPT_PAGE_CONTRACT, browserSessionId: 'synthetic-firefox-peer',
    browser: { product: 'UNVERIFIED', major: 0, channel: 'UNVERIFIED' },
    platform: { product: 'UNVERIFIED', arch: 'UNVERIFIED', version: '' },
    permissions: ['nativeMessaging', 'scripting'], permissionState: 'granted', hostPermission: 'https://chatgpt.com/*', tabs: [testTab()] }));
  await until(() => frames.some(frame => frame.kind === 'PAP_READY'));
  const integration = async enabled => {
    const engine = f.runtime.coreEngine, state = engine.state();
    await engine.command({ profile: ENGINE_COMMAND_PROFILE, controlProfile: RECORDING_CONTROL_PROFILE,
      runtimeEpoch: state.runtimeEpoch, expectedRevision: state.revision, commandId: randomUUID(),
      kind: 'SET_INTEGRATION', integrationId: 'firefox-chatgpt', enabled }, { surface: 'desktop' });
  };
  await integration(true);
  await until(() => frames.some(frame => frame.kind === 'PAP_CAPTURE_POLICY' && frame.policies.length));
  const policy = frames.findLast(frame => frame.kind === 'PAP_CAPTURE_POLICY').policies[0];
  const capture = scaleObservation(1, '\ufeffSynthetic Firefox exact e\u0301\r\n\0');
  capture.profile = FIREFOX_CAPTURE_PROFILE; capture.token = policy.token;
  for (const key of ['runtimeEpoch', 'browserSessionId', 'scope', 'tabId', 'windowId', 'tabEpoch', 'destination']) capture.source[key] = policy[key];
  capture.source.adapterProfile = FIREFOX_ADAPTER_PROFILE; capture.request.conversationId = 'test-conversation';
  const send = async observation => {
    const requestId = randomUUID(), { text, ...rest } = observation;
    input.write(encodeNativeFrame({ kind: 'PAP_CAPTURE', requestId, observation: { ...rest, textBytes: Buffer.from(text).toString('base64') } }));
    await until(() => frames.some(frame => frame.requestId === requestId));
    return frames.find(frame => frame.requestId === requestId).result;
  };
  const results = await Promise.all([send(capture), f.send('Synthetic Chrome beside Firefox')]);
  assert.equal(results[0].state, 'PROMPT_SAVED');
  await until(() => f.runtime.session.versionCount === 2);
  const chrome = f.deliveries.find(delivery => delivery.observation.kind === 'request-observed').observation;
  assert.equal((await send({ ...capture, eventId: randomUUID(), token: chrome.token,
    source: { ...capture.source, scope: chrome.source.scope } })).state, 'CAPTURE_REJECTED');
  await f.recording(false); await f.recording(true);
  assert.equal((await send({ ...capture, eventId: randomUUID() })).state, 'CAPTURE_REJECTED');
  await integration(false);
  assert.equal((await send({ ...capture, eventId: randomUUID() })).state, 'CAPTURE_REJECTED');
  socket.destroy(); input.end(); output.end();
  await f.send('Synthetic Chrome after Firefox disconnect');
  await until(() => f.runtime.session.versionCount === 3);
});
