import { randomUUID } from 'node:crypto';
import { CHATGPT_ADAPTER_PROFILE, CHATGPT_PAGE_CONTRACT } from '../spikes/browser/chatgpt/adapter.mjs';
export function scaleObservation(number, text = null) {
  return { kind: 'request-observed', eventId: randomUUID(), inputMethod: 'provider-request',
    text: text ?? `\ufeffSYNTHETIC needle${String(number).padStart(6, '0')} e\u0301\0\r\n☕ ${'Exact local prompt evidence. '.repeat(40)}`,
    source: { adapterProfile: CHATGPT_ADAPTER_PROFILE, pageContract: CHATGPT_PAGE_CONTRACT,
      runtimeEpoch: '00000000-0000-4000-8000-000000000001', browserSessionId: 'synthetic-scale-browser',
      scope: '00000000-0000-4000-8000-000000000002', tabId: 17, windowId: 1, tabEpoch: 'synthetic-scale-tab',
      documentId: 'synthetic-scale-document', destination: `conversation:scale-${number % 20}` },
    request: { profile: 'chatgpt-new-user-text/3', path: '/backend-api/conversation', messageId: randomUUID(), conversationId: `scale-${number % 20}` } };
}
