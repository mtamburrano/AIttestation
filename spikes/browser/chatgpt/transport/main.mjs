import { installFetchObserver } from './fetch-observer.mjs';
import { isChatGPTRouteIdentifier } from '../../../recipient/chatgpt-route.mjs';

const TRANSPORT_CHANNEL = 'pap-chatgpt-transport/3';
const CONTROL_EVENT = 'pap-chatgpt-transport-control-v3';
// Filled from the bundle's module bytes; changed code must replace old observers.
const OBSERVER_REVISION = '__ATTESTAMP_OBSERVER_BUILD__';
const origin = 'https://chatgpt.com';
function startObserver() {
  const previous = globalThis.__attestampChatGPTTransport;
  if (previous?.revision === OBSERVER_REVISION) { previous.ready(); return; }
  previous?.stop();
  dispatchEvent(new CustomEvent('pap-chatgpt-transport-control', { detail: '{"kind":"clear"}' }));
  const observer = installFetchObserver(window, { emit: message => window.postMessage({ channel: TRANSPORT_CHANNEL, ...message }, origin) });
  let owner = null;
  const ready = () => {
    const observerState = observer.state();
    window.postMessage({ channel: TRANSPORT_CHANNEL, kind: 'ready', observerState,
      available: observerState === 'ready' || observerState === 'wrapped' }, origin);
  };
  const control = event => {
    if (typeof event.detail !== 'string' || event.detail.length > 512) return;
    try {
      const message = JSON.parse(event.detail);
      if (!/^[a-f0-9-]{36}$/.test(message.owner)) return;
      if (message.kind === 'arm' && /^[a-f0-9-]{36}$/.test(message.id)
          && (message.conversationId === null || isChatGPTRouteIdentifier(message.conversationId))) {
        owner = message.owner; observer.arm(message.id, message.conversationId);
      } else if (message.kind === 'claim') { owner = message.owner; observer.clear(); }
      else if (message.kind === 'clear' && message.owner === owner) observer.clear();
      else if (message.kind === 'probe') ready();
    } catch {}
  };
  const pagehide = () => observer.clear();
  addEventListener(CONTROL_EVENT, control);
  addEventListener('pagehide', pagehide);
  globalThis.__attestampChatGPTTransport = { revision: OBSERVER_REVISION, ready, stop() {
    removeEventListener(CONTROL_EVENT, control); removeEventListener('pagehide', pagehide); observer.stop();
  } };
  ready();
}
if (location.origin === origin && window === window.top) startObserver();
