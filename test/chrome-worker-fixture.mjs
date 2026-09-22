import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { CHATGPT_EXTENSION_ID } from '../spikes/browser/chatgpt/adapter.mjs';

export const turn = () => new Promise(resolve => setImmediate(resolve));
export const testTab = (overrides = {}) => ({ id: 17, windowId: 1, tabEpoch: 'test-document-epoch', url: 'https://chatgpt.com/c/test-conversation', active: true,
  destination: 'conversation:test-conversation', surfaceSupported: true,
  attachmentsPresent: false, ...overrides });
const event = () => {
  const listeners = new Set();
  return { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener), emit: (...args) => {
    for (const listener of listeners) listener(...args);
  } };
};

export async function workerFixture({ onConnect = () => {}, inspect = async () => testTab(),
  query = async () => [testTab()], permission = async () => true, clock = null, contexts = async () => [], executeScript = null } = {}) {
  const ports = [], panelPorts = [], timers = new Set();
  const chrome = {
    runtime: { id: CHATGPT_EXTENSION_ID, lastError: undefined, onMessage: event(), onConnect: event(),
      onInstalled: event(),
      getContexts: contexts,
      getPlatformInfo: async () => ({ os: 'mac', arch: 'arm64' }),
      connectNative() {
        const port = { onMessage: event(), onDisconnect: event(), messages: [], closed: false,
          postMessage(value) { if (port.closed) throw Error('FIXTURE_PORT_CLOSED'); port.messages.push(value); port.send?.(value); },
          disconnect() { if (port.closed) return; port.closed = true; port.close?.(); port.onDisconnect.emit(); },
        };
        ports.push(port); onConnect(port); return port;
      } },
    permissions: { contains: permission, onRemoved: event() },
    sidePanel: { setPanelBehavior: async () => {} },
    scripting: executeScript ? { executeScript } : undefined,
    tabs: { query, sendMessage: inspect, onActivated: event(), onCreated: event(), onRemoved: event(), onUpdated: event() },
  };
  runInNewContext(await readFile(new URL('../spikes/browser/chatgpt/extension/service-worker.js', import.meta.url), 'utf8'), {
    chrome, crypto: webcrypto, navigator: {}, URL, TextEncoder, btoa, performance: clock?.performance ?? performance,
    setTimeout(callback, delay) {
      const timer = clock ? clock.setTimeout(() => { timers.delete(timer); callback(); }, delay) : { callback, delay };
      timers.add(timer); return timer;
    },
    clearTimeout(timer) { if (clock) clock.clearTimeout(timer); timers.delete(timer); },
  });
  return { chrome, ports, panelPorts, timers,
    connectPanel(sender, { notifyDisconnect = true, dropAfterDeparture = false } = {}) {
      let departed = false;
      const client = { onMessage: event(), onDisconnect: event() };
      const worker = { onMessage: event(), onDisconnect: event(), name: 'pap-chatgpt-panel-channel/1',
        sender: structuredClone(sender), messages: [] };
      client.postMessage = message => {
        if (departed) throw Error('FIXTURE_PORT_CLOSED');
        const snapshot = structuredClone(message);
        queueMicrotask(() => worker.onMessage.emit(snapshot));
      };
      worker.postMessage = message => {
        worker.messages.push(structuredClone(message));
        if (departed) { if (dropAfterDeparture) return; throw Error('FIXTURE_PORT_CLOSED'); }
        const snapshot = structuredClone(message);
        queueMicrotask(() => client.onMessage.emit(snapshot));
      };
      const disconnect = () => {
        if (departed) return; departed = true;
        queueMicrotask(() => { client.onDisconnect.emit(); if (notifyDisconnect) worker.onDisconnect.emit(); });
      };
      client.disconnect = worker.disconnect = disconnect;
      panelPorts.push(worker); chrome.runtime.onConnect.emit(worker);
      return client;
    },
    message(message, sender) { return new Promise(resolve => chrome.runtime.onMessage.emit(message, sender, resolve)); },
    close() { for (const port of [...ports, ...panelPorts]) port.disconnect(); for (const timer of timers) clock?.clearTimeout(timer); timers.clear(); },
    async fire(delay) {
      await turn();
      const timer = [...timers].find(item => item.delay === delay);
      if (!timer) throw Error(`FIXTURE_TIMER_MISSING_${delay}`);
      timers.delete(timer); timer.callback(); await turn();
    },
    ready(port, epoch = 'test-runtime-epoch') {
      const hello = port.messages.find(message => message.kind === 'PAP_HELLO');
      port.onMessage.emit({ kind: 'PAP_READY', browserSessionId: hello.browserSessionId, runtimeEpoch: epoch });
    },
  };
}
