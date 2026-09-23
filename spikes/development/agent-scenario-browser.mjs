import { setTimeout as delay } from 'node:timers/promises';
import { connectAgentCDP } from './agent-cdp.mjs';
import { providerEndpoint, inspectScenarioRequest } from './agent-scenario-oracle.mjs';

// DOM state selects normal UI controls only. Request bytes and signed History
// are checked independently; rendered conversation text is never read.
const uiExpression = `(() => {
  const composer = document.querySelector('#prompt-textarea');
  const visible = element => !!element && element.getClientRects().length > 0;
  const stop = document.querySelector('button[data-testid="stop-button"]');
  const send = document.querySelector('button[data-testid="send-button"], button#composer-submit-button');
  return { provider: location.origin === 'https://chatgpt.com',
    route: location.pathname === '/' ? 'new' : /^\\/c\\/[A-Za-z0-9_-]+$/.test(location.pathname) ? 'conversation' : 'other',
    composer: visible(composer) && (composer.isContentEditable || composer.tagName === 'TEXTAREA'),
    empty: !!composer && !(composer.value ?? composer.innerText ?? '').length,
    active: visible(stop), send: visible(send) && !send.disabled && send !== stop };
})()`;

export async function scenarioBrowser(metadata, { trace, signal, connect = connectAgentCDP, wait = delay,
  now = () => performance.now() } = {}) {
  let cdp, sessionId, current = null, problem = null, targetId;
  const requests = [], byId = new Map(), responses = new Map();
  const startedAt = now();
  const check = () => { signal?.throwIfAborted(); if (problem) throw Error(problem); };
  const add = value => {
    if (trace.length >= 256) { problem = 'AGENT_SCENARIO_TRACE_LIMIT'; return; }
    trace.push({ elapsedMs: Math.max(0, Math.floor(now() - startedAt)), ...value });
  };
  const onEvent = event => {
    if (event.sessionId !== sessionId) return;
    const value = event.params;
    if (event.method === 'Network.requestWillBeSent') {
      const endpoint = providerEndpoint(value?.request?.url, value?.request?.method);
      if (!endpoint) return;
      const entry = { sequence: requests.length + 1, scenario: current?.index ?? null, endpoint,
        method: 'POST', requestBytes: typeof value.request.postData === 'string' ? Buffer.byteLength(value.request.postData) : null,
        exactSyntheticText: false };
      add(entry);
      if (requests.length >= 3 || !current || current.observed) { problem = 'AGENT_SCENARIO_UNEXPECTED_SEND'; return; }
      current.observed = true;
      try {
        const identity = inspectScenarioRequest(value.request.postData, endpoint, current.text);
        if (current.index === 2 ? !endpoint.endsWith('/steer_turn') : endpoint.endsWith('/steer_turn')) {
          throw Error('AGENT_SCENARIO_ENDPOINT_MISMATCH');
        }
        entry.exactSyntheticText = true;
        entry.hasConversation = identity.conversationId !== null;
        requests.push({ ...identity, index: current.index });
        byId.set(value.requestId, entry);
      } catch (error) {
        problem = error.message === 'AGENT_SCENARIO_ENDPOINT_MISMATCH' ? error.message : 'AGENT_SCENARIO_REQUEST_INVALID';
      }
    } else if (event.method === 'Network.responseReceived' && byId.has(value?.requestId)) {
      const status = value.response?.status;
      responses.set(byId.get(value.requestId).scenario, status);
      add({ sequence: byId.get(value.requestId).sequence, event: 'response',
        status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null });
    } else if (['Network.loadingFinished', 'Network.loadingFailed'].includes(event.method) && byId.has(value?.requestId)) {
      add({ sequence: byId.get(value.requestId).sequence,
        event: event.method === 'Network.loadingFinished' ? 'finished' : 'failed' });
    } else if (event.method === 'Runtime.exceptionThrown') add({ event: 'page-exception' });
  };
  const evaluate = async expression => {
    check();
    const value = await cdp.call('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
    if (value.exceptionDetails) throw Error('AGENT_SCENARIO_UI_CHANGED');
    return value.result?.value;
  };
  const until = async (predicate, reason, timeoutMs = 30000) => {
    const deadline = now() + timeoutMs;
    for (;;) {
      check();
      const value = await predicate();
      if (value) return value;
      if (now() >= deadline) throw Error(reason);
      await wait(100);
    }
  };
  const ui = async () => {
    const state = await evaluate(uiExpression);
    if (!state?.provider) throw Error('AGENT_SCENARIO_UI_CHANGED');
    return state;
  };
  try {
    cdp = await connect(metadata, { onEvent });
    ({ targetId } = await cdp.call('Target.createTarget', { url: 'about:blank' }));
    ({ sessionId } = await cdp.call('Target.attachToTarget', { targetId, flatten: true }));
    await cdp.call('Network.enable', { maxPostDataSize: 512 * 1024 }, sessionId);
    await cdp.call('Runtime.enable', {}, sessionId);
    await cdp.call('Page.navigate', { url: 'https://chatgpt.com/' }, sessionId);
    await until(async () => {
      const state = await evaluate(uiExpression);
      return state?.provider && state.route === 'new' && state.composer && state.empty && !state.active;
    }, 'AGENT_SCENARIO_UI_CHANGED');
    add({ event: 'fresh-page-ready' });
    return {
      check,
      async accepted(index) {
        // Check History even when the provider rejects the request. Local
        // recording is retrospective and does not assert provider acceptance.
        await until(() => responses.has(index), 'AGENT_SCENARIO_RESPONSE_MISSING', 15000);
        const status = responses.get(index);
        if (!(status >= 200 && status < 300)) throw Error('AGENT_SCENARIO_PROVIDER_REJECTED');
      },
      async send(index, text, consume) {
        if (index !== requests.length || index > 2) throw Error('AGENT_SCENARIO_INVALID');
        if ([...responses.values()].some(status => !(status >= 200 && status < 300))) throw Error('AGENT_SCENARIO_PROVIDER_REJECTED');
        const before = await until(async () => {
          const state = await ui();
          return state.composer && state.empty && state.active === (index === 2) ? state : false;
        }, index === 2 ? 'AGENT_SCENARIO_STEERING_UNAVAILABLE' : 'AGENT_SCENARIO_UI_CHANGED', index === 2 ? 15000 : 60000);
        if (before.route !== (index === 0 ? 'new' : 'conversation')) throw Error('AGENT_SCENARIO_ROUTE_MISMATCH');
        add({ event: 'before-send', scenario: index, ...before });
        await evaluate(`document.querySelector('#prompt-textarea').focus(); true`);
        await cdp.call('Input.insertText', { text }, sessionId);
        await until(async () => {
          const state = await ui();
          return !state.empty && (state.send || index === 2 && state.active);
        }, 'AGENT_SCENARIO_UI_CHANGED', 5000);
        if (index === 2 && !(await ui()).active) throw Error('AGENT_SCENARIO_STEERING_UNAVAILABLE');
        current = { index, text, observed: false };
        // Consume before dispatch. A timeout or lost reply is an ambiguous
        // attempt and must never cause an automatic second Enter.
        await consume(); check();
        await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter',
          windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' }, sessionId);
        await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter',
          windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, sessionId);
        const request = await until(() => requests[index], 'AGENT_SCENARIO_REQUEST_MISSING', 15000);
        if (index > 0 && request.conversationId === null
            || index === 2 && request.conversationId !== requests[1].conversationId
            || requests.some((other, i) => i < index && other.messageId === request.messageId)) {
          throw Error('AGENT_SCENARIO_REQUEST_INVALID');
        }
        return request;
      },
      async close() {
        try { await cdp.call('Target.closeTarget', { targetId }); }
        finally { cdp.close(); }
      },
    };
  } catch (error) {
    if (cdp && targetId) await cdp.call('Target.closeTarget', { targetId }).catch(() => {});
    cdp?.close(); throw error;
  }
}
