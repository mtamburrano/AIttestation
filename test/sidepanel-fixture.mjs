import { randomUUID } from 'node:crypto';
import { continuousFixture, until } from './continuous-fixture.mjs';
import { CHATGPT_EXTENSION_ID } from '../spikes/browser/chatgpt/adapter.mjs';
import { SidePanelModel, targetKey } from '../spikes/browser/chatgpt/extension/sidepanel-model.js';

export const panelOrigin = `chrome-extension://${CHATGPT_EXTENSION_ID}`;
export const panelURL = `${panelOrigin}/sidepanel.html`;
export async function sidePanelFixture(directory, options = {}) {
  const contexts = new Map(), requests = [], replies = [], dashboards = [];
  const f = await continuousFixture(directory, { ...options, enroll: false, defaultMode: 'Sealed',
    panelContexts: async filter => [...contexts.values()].filter(value => filter.documentIds.includes(value.documentId)),
    openDashboard: async url => { dashboards.push(url); } });
  return Object.assign(f, { contexts, requests, replies, dashboards,
    async panel(tabId = 17) {
      const documentId = randomUUID();
      contexts.set(documentId, { contextType: 'SIDE_PANEL', documentId, documentUrl: panelURL, documentOrigin: panelOrigin, incognito: false });
      const sender = { id: CHATGPT_EXTENSION_ID, origin: panelOrigin, url: panelURL, documentId, documentLifecycle: 'active' };
      const transport = async message => {
        requests.push(structuredClone(message));
        const result = await f.worker.message(message, sender); replies.push(result); return result;
      };
      const model = new SidePanelModel(transport);
      await model.refresh();
      await model.select(targetKey(model.state.targets.find(value => value.tabId === tabId)));
      if (!model.scope) throw Error('FIXTURE_PANEL_ENROLLMENT_FAILED');
      return { model, sender, transport, close() { contexts.delete(documentId); } };
    },
    async settled(model, id = model.draft?.submission?.id) {
      await until(async () => { await model.refresh(); return model.state?.operations.some(value => value.id === id && value.settled); });
      return model.state.operations.find(value => value.id === id);
    },
  });
}
