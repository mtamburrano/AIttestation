import { installFetchObserver } from './fetch-observer.mjs';
import { isChatGPTRouteIdentifier } from '../../../recipient/chatgpt-route.mjs';

const TRANSPORT_CHANNEL = 'pap-chatgpt-transport/2';
const CONTROL_EVENT = 'pap-chatgpt-transport-control';
const origin = 'https://chatgpt.com';
if (location.origin === origin && window === window.top) {
  const observer = installFetchObserver(window, { emit: message => window.postMessage({ channel: TRANSPORT_CHANNEL, ...message }, origin) });
  const ready = () => {
    const observerState = observer.state();
    window.postMessage({ channel: TRANSPORT_CHANNEL, kind: 'ready', observerState,
      available: observerState === 'ready' || observerState === 'wrapped' }, origin);
  };
  addEventListener(CONTROL_EVENT, event => {
    if (typeof event.detail !== 'string' || event.detail.length > 400) return;
    try {
      const message = JSON.parse(event.detail);
      if (message.kind === 'arm' && /^[a-f0-9-]{36}$/.test(message.id)
          && (message.conversationId === null || isChatGPTRouteIdentifier(message.conversationId))) observer.arm(message.id, message.conversationId);
      else if (message.kind === 'clear') observer.clear();
      else if (message.kind === 'probe') ready();
    } catch {}
  });
  addEventListener('pagehide', () => observer.clear());
  ready();
}
