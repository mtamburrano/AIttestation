import { installFetchObserver } from './fetch-observer.mjs';

const TRANSPORT_CHANNEL = 'pap-chatgpt-transport/1';
const CONTROL_EVENT = 'pap-chatgpt-transport-control';
const origin = 'https://chatgpt.com';
if (location.origin === origin && window === window.top) {
  const observer = installFetchObserver(window, { emit: message => window.postMessage({ channel: TRANSPORT_CHANNEL, ...message }, origin) });
  const ready = () => window.postMessage({ channel: TRANSPORT_CHANNEL, kind: 'ready', available: observer.available() }, origin);
  addEventListener(CONTROL_EVENT, event => {
    if (typeof event.detail !== 'string' || event.detail.length > 400) return;
    try {
      const message = JSON.parse(event.detail);
      if (message.kind === 'qualify' && /^[a-f0-9-]{36}$/.test(message.id)
          && (message.conversationId === null || /^[A-Za-z0-9_-]{1,128}$/.test(message.conversationId))) observer.qualify(message.id, message.conversationId);
      else if (message.kind === 'clear') observer.clear();
      else if (message.kind === 'probe') ready();
    } catch {}
  });
  addEventListener('pagehide', () => observer.clear());
  ready();
}
