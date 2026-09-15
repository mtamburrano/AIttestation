import { randomUUID, randomBytes } from 'node:crypto';
import { recordingFixture } from './recording-fixture.mjs';
import { CHATGPT_EXTENSION_ID } from '../spikes/browser/chatgpt/adapter.mjs';
import { SidePanelModel } from '../spikes/browser/chatgpt/extension/sidepanel-model.js';
import { requestPanel } from '../spikes/browser/chatgpt/extension/sidepanel-channel.js';

export const panelOrigin = `chrome-extension://${CHATGPT_EXTENSION_ID}`;
export const panelURL = `${panelOrigin}/sidepanel.html`;
export async function sidePanelFixture(directory, options = {}) {
  const contexts = new Map(), requests = [], replies = [], dashboards = [];
  const f = await recordingFixture(directory, { ...options,
    panelContexts: async filter => structuredClone([...contexts.values()].filter(value => !filter.documentUrls || filter.documentUrls.includes(value.documentUrl))),
    openDashboard: async url => { dashboards.push(url); } });
  const requestFrom = (message, sender, { connected = () => {}, ...options } = {}) => requestPanel(message, {
    connect() { const port = f.worker.connectPanel(sender, options); connected(port); return port; },
  });
  return Object.assign(f, { contexts, requests, replies, dashboards, requestFrom,
    async panel() {
      const documentId = randomBytes(16).toString('hex').toUpperCase();
      const url = `${panelURL}?view=${randomUUID()}`;
      contexts.set(documentId, { contextType: 'SIDE_PANEL', contextId: randomUUID(), documentId,
        documentUrl: url, documentOrigin: panelOrigin, incognito: false, frameId: 0, tabId: -1, windowId: -1 });
      // Observed Chrome 153 non-tab sender shape. These remain synthetic objects;
      // the separate browser fixture verifies the actual platform behavior.
      const sender = { id: CHATGPT_EXTENSION_ID, origin: panelOrigin, url };
      const ports = new Set();
      let closed = false;
      const transport = async message => {
        if (closed) return { error: 'UNTRUSTED_PANEL', stage: 'PANEL_CONTEXT_REJECTED' };
        requests.push(structuredClone(message));
        const result = await requestFrom(message, sender, { connected(port) { ports.add(port); port.onDisconnect.addListener(() => ports.delete(port)); } });
        replies.push(result); return result;
      };
      const model = new SidePanelModel(transport);
      await model.refresh();
      return { model, sender, transport, documentId, close() {
        closed = true; contexts.delete(documentId); for (const port of ports) port.disconnect();
      } };
    },
  });
}
