import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pageFixture } from './chatgpt-page-fixture.mjs';
import { workerFixture, testTab } from './chrome-worker-fixture.mjs';
import { startPackagedChatGPT } from '../spikes/browser/chatgpt/runtime-main.mjs';
import { MemoryKeyStore } from '../spikes/vault/key-lifecycle.mjs';
import { ENGINE_COMMAND_PROFILE } from '../spikes/browser/chatgpt/engine.mjs';
import { CHATGPT_PAGE_CONTRACT, CHATGPT_EXTENSION_ID } from '../spikes/browser/chatgpt/adapter.mjs';
import { FAST_CONFIRM_PROFILE } from '../spikes/anchor/algorand/fast-confirm.mjs';
import { runNativeHost, NativeFrameDecoder, encodeNativeFrame } from '../spikes/browser/chatgpt/native-host.mjs';

export async function until(check) {
  for (let index = 0; index < 500; index++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Object.assign(Error('SCENARIO_TIMEOUT'), { code: 'SCENARIO_TIMEOUT' });
}

// This fixture uses real product startup, vault, IPC framing, worker and content
// scripts. Only page/browser/platform identity and anchoring are synthetic.
export async function continuousFixture(directory, { diagnostics, network, tabs = 2, textarea = false, dropAck = false,
  collectFast, managed, enroll = true, defaultMode = 'Off', panelContexts = async () => [], openDashboard = async () => {},
  dropPanelAck = false, dropReleaseReply = false } = {}) {
  const pages = new Map(), inventory = new Map(), deliveries = [], results = [], releases = [], sources = [];
  const keyStore = new MemoryKeyStore();
  let worker, socket, native, nativeFailure, port, allow = true, anchorCalls = 0, confirmed = 0, userSends = 0, prevention = 0;
  let captureFault = false, keyFault = false;
  const runtimeOptions = { supportDirectory: join(directory, 'engine'), keyStore, diagnostics,
    installation: null, fastTrust: { profile: FAST_CONFIRM_PROFILE }, openBrowser: false,
    managed: managed ?? { status: () => ({ state: 'ACTIVE' }), submit: async () => { anchorCalls++; return { transactionId: 'A'.repeat(52) }; } },
    collectFast: async () => { confirmed++; return collectFast ? collectFast() : { synthetic: true }; },
    openDashboard,
    controllerTimeoutMs: 250,
    verifyFast: () => ({ authorized: true, anchor: 'SOURCE_CORROBORATED', timestamp: 'SOURCE_REPORTED',
      assurance: FAST_CONFIRM_PROFILE, round: 42 }),
    verifyArchive: () => { throw Error('NO_ARCHIVE_FIXTURE'); },
    attestPeer: async () => ({ browser: { product: 'Google Chrome', channel: 'stable', major: 153 },
      platform: { product: 'macOS', arch: 'arm64', version: '15.7.2' } }),
  };
  let runtime = await startPackagedChatGPT(runtimeOptions);
  let revoke = network?.allowRuntime(runtime);
  const originalCapture = runtime.session.vault.capture.bind(runtime.session.vault);
  runtime.session.vault.capture = (...args) => {
    if (captureFault) throw Error('SYNTHETIC_STORAGE_FAILURE');
    if (keyFault) throw Error('SYNTHETIC_KEY_UNAVAILABLE');
    return originalCapture(...args);
  };
  const input = new PassThrough(), output = new PassThrough(), decoder = new NativeFrameDecoder();
  const command = (kind, data) => runtime.engine.command({ profile: ENGINE_COMMAND_PROFILE,
    runtimeEpoch: runtime.runtimeEpoch, adapterProfile: runtime.engine.state().adapterProfile,
    commandId: randomUUID(), expectedRevision: runtime.engine.state().revision, kind, ...data }, { surface: 'desktop' });
  for (let i = 0; i < tabs; i++) {
    const id = 17 + i, tab = testTab({ id, windowId: i + 1,
      url: `https://chatgpt.com/c/fixture-${id}`, destination: `conversation:fixture-${id}` });
    inventory.set(id, tab);
    const sender = page => page.sender({ tab: { id, windowId: tab.windowId, url: page.location.href }, documentId: `synthetic-${id}` });
    const page = pageFixture({ textarea, url: tab.url,
      authorize: (message, page) => worker.message(message, sender(page)),
      notify: (message, page) => worker?.chrome.runtime.onMessage.emit(message, sender(page)),
      capture: (message, page) => worker ? worker.message(message, sender(page)) : Promise.resolve({ state: 'RECORDING_UNAVAILABLE' }),
    });
    page.captureSender = () => sender(page); pages.set(id, page);
  }
  output.on('data', chunk => {
    try {
      for (const message of decoder.push(chunk)) {
        if (message.kind === 'PAP_RELEASE') releases.push(message);
        if (dropPanelAck && message.kind === 'PAP_PANEL_RESULT' && message.ack?.operationId) {
          dropPanelAck = false; continue;
        }
        if (message.kind === 'PAP_CAPTURE_RESULT') {
          results.push(message);
          if (dropAck && message.result.kind === 'send-intent' && results.filter(value => value.result.kind === 'send-intent').length === 1) continue;
        }
        port.onMessage.emit(message);
      }
    } catch (error) { nativeFailure = error; }
  });
  try {
    worker = await workerFixture({ clock: { setTimeout, clearTimeout, performance }, permission: async () => allow,
      contexts: panelContexts,
      query: async () => [...inventory.values()].map(tab => ({ ...tab, url: pages.get(tab.id).location.href })),
      inspect: (id, message) => pages.get(id).send(message),
      onConnect(value) {
        port = value;
        port.close = () => socket?.destroy();
        port.send = message => {
          if (dropReleaseReply && message.profile === 'pap-chatgpt-release/2') return;
          if (message.kind === 'PAP_CAPTURE') { deliveries.push(structuredClone(message)); sources.push(message.observation.source); }
          input.write(encodeNativeFrame(message));
        };
      },
    });
    native = await runNativeHost({ extensionOrigin: `chrome-extension://${CHATGPT_EXTENSION_ID}/`,
      rendezvousPath: runtime.rendezvousPath, input, output });
    socket = native; socket.on('error', error => { nativeFailure = error; });
    await until(() => runtime.browserState());
    await command('SET_DEFAULT', { mode: defaultMode });
    const scopes = new Map();
    for (const id of enroll ? pages.keys() : []) {
      const { eligible: _eligible, ...target } = runtime.engine.state().targets.find(value => value.tabId === id);
      scopes.set(id, (await command('ENROLL_SCOPE', { target })).scope);
    }
    const refresh = async (id = 17) => {
      const page = pages.get(id);
      const status = await worker.message({ kind: 'PAP_CAPTURE_STATUS', pageContract: CHATGPT_PAGE_CONTRACT }, page.captureSender());
      if (status.kind === 'PAP_CAPTURE_POLICY') await page.send(status);
      return status;
    };
    const f = { get runtime() { return runtime; }, pages, inventory, deliveries, results, releases, sources, scopes, worker, refresh, command,
      get nativeFailure() { return nativeFailure; }, get anchorCalls() { return anchorCalls; }, get confirmed() { return confirmed; },
      get userSends() { return userSends; }, get prevention() { return prevention; },
      get port() { return port; },
      async mode(mode, id = 17) {
        await command('SET_CONVERSATION_MODE', { scope: scopes.get(id), mode });
        await until(async () => { const status = await refresh(id); return mode === 'Continuous' ? Boolean(status.policy) : !status.policy; });
      },
      send(text, { id = 17, method = 'send-button', trusted = true, ...event } = {}) {
        const page = pages.get(id);
        if (text !== undefined) page.text = text;
        page.event(method === 'enter' ? 'keydown' : 'click', { isTrusted: trusted,
          target: method === 'enter' ? page.editor : page.button, key: 'Enter', button: 0, detail: 1,
          preventDefault: () => { prevention++; }, stopImmediatePropagation: () => { prevention++; }, ...event });
        userSends++;
      },
      appear(text, id = 17, messageId = randomUUID()) {
        const page = pages.get(id), node = new page.Element('DIV', text);
        node.setAttribute('data-message-id', messageId); page.messages.push(node); page.changed(); return node;
      },
      storageFault() { captureFault = true; }, keyFault() { keyFault = true; },
      revokePermission() { allow = false; worker.chrome.permissions.onRemoved.emit(); },
      disconnect() { port.disconnect(); },
      navigate(id = 17, url = 'https://chatgpt.com/c/different') {
        pages.get(id).location.href = url;
        worker.chrome.tabs.onUpdated.emit(id, { url }); pages.get(id).changed();
      },
      replay(message) { input.write(encodeNativeFrame({ ...message, requestId: randomUUID() })); },
      async restart() {
        await f.close(); runtime = await startPackagedChatGPT(runtimeOptions); revoke = network?.allowRuntime(runtime);
      },
      async close() {
        captureFault = false; keyFault = false;
        for (const page of pages.values()) page.close();
        worker.close(); socket?.destroy(); input.end(); output.end();
        await runtime.close(); revoke?.();
      },
    };
    return f;
  } catch (error) {
    for (const page of pages.values()) page.close();
    worker?.close(); socket?.destroy(); input.end(); output.end(); await runtime.close(); revoke?.(); throw error;
  }
}
