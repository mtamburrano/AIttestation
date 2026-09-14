import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { CHATGPT_EXTENSION_ID } from '../spikes/browser/chatgpt/adapter.mjs';

export const turn = () => new Promise(resolve => setImmediate(resolve));
export const testTab = (overrides = {}) => ({ id: 17, url: 'https://chatgpt.com/c/test-conversation', active: true,
  destination: 'conversation:test-conversation', surfaceSupported: true, composerEmpty: true,
  attachmentsPresent: false, ...overrides });
const event = () => {
  const listeners = new Set();
  return { addListener: listener => listeners.add(listener), emit: (...args) => {
    for (const listener of listeners) listener(...args);
  } };
};

export async function workerFixture({ onConnect = () => {}, inspect = async () => testTab(),
  query = async () => [testTab()], permission = async () => true } = {}) {
  const ports = [], timers = new Set();
  const chrome = {
    runtime: { id: CHATGPT_EXTENSION_ID, lastError: undefined, onMessage: event(),
      getPlatformInfo: async () => ({ os: 'mac', arch: 'arm64' }),
      connectNative() {
        const port = { onMessage: event(), onDisconnect: event(), messages: [], closed: false,
          postMessage(value) { if (port.closed) throw Error('FIXTURE_PORT_CLOSED'); port.messages.push(value); port.send?.(value); },
          disconnect() { if (port.closed) return; port.closed = true; port.close?.(); port.onDisconnect.emit(); },
        };
        ports.push(port); onConnect(port); return port;
      } },
    permissions: { contains: permission, onRemoved: event() },
    tabs: { query, sendMessage: inspect, onActivated: event(), onCreated: event(), onRemoved: event(), onUpdated: event() },
  };
  runInNewContext(await readFile(new URL('../spikes/browser/chatgpt/extension/service-worker.js', import.meta.url), 'utf8'), {
    chrome, crypto: webcrypto, navigator: {}, URL,
    setTimeout(callback, delay) { const timer = { callback, delay }; timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); },
  });
  return { chrome, ports, timers,
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
