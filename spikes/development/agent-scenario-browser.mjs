import { setTimeout as delay } from 'node:timers/promises';
import { connectAgentCDP } from './agent-cdp.mjs';
import { providerEndpoint, inspectScenarioRequest } from './agent-scenario-oracle.mjs';
import { scenarioReadiness, scenarioResponse, scenarioUI } from './agent-scenario-readiness.mjs';

// DOM state selects normal UI controls only. Request bytes and signed History
// are checked independently; rendered conversation text is never read.
const sendControl = `
  const candidates = [...document.querySelectorAll('button')].filter(button => visible(button) && !button.disabled
    && button.getAttribute('data-testid') !== 'stop-button'
    && (button.getAttribute('data-testid') === 'send-button'
      || ['Send prompt', 'Send message', 'Send now'].includes(button.getAttribute('aria-label'))));
  const send = candidates.length === 1 ? candidates[0] : null;
`;
const uiExpression = `(() => {
  const composer = document.querySelector('#prompt-textarea');
  const visible = element => !!element && element.getClientRects().length > 0;
  const stop = document.querySelector('button[data-testid="stop-button"]');
  ${sendControl}
  return { provider: location.origin === 'https://chatgpt.com',
    controls: [...(composer?.closest('form')?.querySelectorAll('button') ?? [])].filter(visible).slice(0, 16).map(button => {
      const label = button.getAttribute('aria-label') ?? button.innerText ?? '';
      return { kind: /\\bsend\\b/i.test(label) ? 'send' : /\\bqueue\\b/i.test(label) ? 'queue'
        : /\\bstop\\b/i.test(label) ? 'stop' : /\\bsteer\\b/i.test(label) ? 'steer' : 'other',
        disabled: button.disabled, type: button.type, labeled: button.hasAttribute('aria-label'),
        sendId: button.getAttribute('data-testid') === 'send-button', stopId: button.getAttribute('data-testid') === 'stop-button',
        submitId: button.id === 'composer-submit-button' };
    }),
    document: document.readyState, visible: document.visibilityState === 'visible', focused: document.hasFocus(),
    challenge: [...document.querySelectorAll('form#challenge-form, #challenge-running, #challenge-stage, #cf-challenge-running')].some(visible)
      || [...document.querySelectorAll('iframe')].some(frame => visible(frame) && (() => {
        try { return ['https://challenges.cloudflare.com', 'https://newassets.hcaptcha.com'].includes(new URL(frame.src).origin); }
        catch { return false; }
      })()),
    route: location.pathname === '/' ? 'new' : /^\\/c\\/[A-Za-z0-9_-]+$/.test(location.pathname) ? 'conversation' : 'other',
    composer: visible(composer) && (composer.isContentEditable || composer.tagName === 'TEXTAREA'),
    empty: !!composer && !(composer.value ?? composer.innerText ?? '').length,
    active: visible(stop), send: visible(send) && !send.disabled && send !== stop };
})()`;

const thinkingExpression = `(() => {
  const buttons = [...(document.querySelector('#prompt-textarea')?.closest('form')?.querySelectorAll('button') ?? [])]
    .filter(button => button.getClientRects().length && ['Think', 'Thinking'].includes(button.innerText.trim()));
  if (buttons.length !== 1) return null;
  const button = buttons[0], pressed = button.getAttribute('aria-pressed');
  if (button.disabled || !['true', 'false'].includes(pressed)) return null;
  const rect = button.getBoundingClientRect(), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
  return button.contains(document.elementFromPoint(x, y)) ? { selected: pressed === 'true', x, y } : null;
})()`;

export async function scenarioBrowser(metadata, { trace, signal, connect = connectAgentCDP, wait = delay,
  now = () => performance.now() } = {}) {
  let cdp, sessionId, current = null, problem = null, targetId, mainFrameId;
  const requests = [], byId = new Map(), responses = new Map(), finished = new Set();
  const startedAt = now();
  const check = () => { signal?.throwIfAborted(); if (problem) throw Error(problem); };
  const add = value => {
    if (trace.length >= 256) { problem = 'AGENT_SCENARIO_TRACE_LIMIT'; return; }
    trace.push({ elapsedMs: Math.max(0, Math.floor(now() - startedAt)), ...value });
  };
  const readiness = scenarioReadiness({ add, now, mainFrameId: () => mainFrameId });
  const observeRequest = async (value, entry, expected) => {
    try {
      let body = value.request.postData;
      if (typeof body !== 'string') {
        // CDP can omit postData even with Network.enable's size allowance.
        // Read this observed request once; never reconstruct it from the DOM.
        const result = await cdp.call('Network.getRequestPostData', { requestId: value.requestId }, sessionId);
        body = result?.postData;
        if (result?.base64Encoded === true) {
          if (typeof body !== 'string' || body.length > 4 * Math.ceil(512 * 1024 / 3)) throw Error('AGENT_SCENARIO_REQUEST_INVALID');
          const bytes = Buffer.from(body, 'base64');
          if (bytes.toString('base64') !== body) throw Error('AGENT_SCENARIO_REQUEST_INVALID');
          body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        }
      }
      entry.requestBytes = typeof body === 'string' ? Buffer.byteLength(body) : null;
      const identity = inspectScenarioRequest(body, entry.endpoint, expected.text);
      if (expected.index === 2 ? !entry.endpoint.endsWith('/steer_turn') : entry.endpoint.endsWith('/steer_turn')) {
        throw Error('AGENT_SCENARIO_ENDPOINT_MISMATCH');
      }
      entry.exactSyntheticText = true;
      entry.hasConversation = identity.conversationId !== null;
      requests.push({ ...identity, index: expected.index });
    } catch (error) {
      problem ??= error.message === 'AGENT_SCENARIO_ENDPOINT_MISMATCH' ? error.message : 'AGENT_SCENARIO_REQUEST_INVALID';
    } finally { add(entry); }
  };
  const onEvent = event => {
    if (event.sessionId !== sessionId) return;
    try { readiness.event(event); } catch { problem = 'AGENT_SCENARIO_TRACE_LIMIT'; }
    const value = event.params;
    if (event.method === 'Network.requestWillBeSent') {
      const endpoint = providerEndpoint(value?.request?.url, value?.request?.method);
      if (!endpoint) return;
      const entry = { sequence: requests.length + 1, scenario: current?.index ?? null, endpoint,
        method: 'POST', requestBytes: typeof value.request.postData === 'string' ? Buffer.byteLength(value.request.postData) : null,
        bodySource: typeof value.request.postData === 'string' ? 'EVENT' : 'CDP',
        exactSyntheticText: false };
      if (requests.length >= 3 || !current || current.observed) { add(entry); problem = 'AGENT_SCENARIO_UNEXPECTED_SEND'; return; }
      current.observed = true;
      // Responses can arrive while the request body is being retrieved.
      byId.set(value.requestId, entry);
      void observeRequest(value, entry, current);
    } else if (event.method === 'Network.responseReceived' && byId.has(value?.requestId)) {
      const status = value.response?.status;
      responses.set(byId.get(value.requestId).scenario, status);
      add({ sequence: byId.get(value.requestId).sequence, event: 'response',
        ...scenarioResponse(value.response), readiness: readiness.snapshot() });
    } else if (['Network.loadingFinished', 'Network.loadingFailed'].includes(event.method) && byId.has(value?.requestId)) {
      finished.add(byId.get(value.requestId).scenario);
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
    const state = scenarioUI(await evaluate(uiExpression));
    readiness.observe(state);
    if (!state?.provider) throw Error('AGENT_SCENARIO_UI_CHANGED');
    return state;
  };
  const pointReady = point => point && Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.y >= 0;
  const activeTurn = index => responses.get(index) >= 200 && responses.get(index) < 300 && !finished.has(index);
  const click = async point => {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.call('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 }, sessionId);
    }
  };
  const thinking = async () => {
    const state = await ui();
    if (!state.composer || !state.empty || state.active) throw Error('AGENT_SCENARIO_THINKING_UNAVAILABLE');
    const mode = await evaluate(thinkingExpression);
    if (!pointReady(mode)) throw Error('AGENT_SCENARIO_THINKING_UNAVAILABLE');
    if (!mode.selected) {
      await click(mode);
      await until(async () => (await evaluate(thinkingExpression))?.selected === true, 'AGENT_SCENARIO_THINKING_UNAVAILABLE', 5000);
    }
    add({ event: 'thinking-mode', selected: true, changed: !mode.selected });
  };
  const settle = async () => {
    await until(async () => {
      let state;
      try { state = await evaluate(uiExpression); }
      catch (error) {
        // A challenge may naturally navigate and replace the execution context.
        // Missing context is never readiness and cannot extend this deadline.
        if (!['AGENT_CDP_REJECTED', 'AGENT_SCENARIO_UI_CHANGED'].includes(error.message)) throw error;
      }
      return readiness.settled(scenarioUI(state));
    }, 'AGENT_SCENARIO_PROVIDER_NOT_READY', 60000);
    add({ event: 'provider-page-settled', stableMs: 5000, ...readiness.snapshot() });
  };
  try {
    cdp = await connect(metadata, { onEvent });
    ({ targetId } = await cdp.call('Target.createTarget', { url: 'about:blank' }));
    ({ sessionId } = await cdp.call('Target.attachToTarget', { targetId, flatten: true }));
    await cdp.call('Network.enable', { maxPostDataSize: 512 * 1024 }, sessionId);
    await cdp.call('Runtime.enable', {}, sessionId);
    await cdp.call('Page.enable', {}, sessionId);
    ({ frameTree: { frame: { id: mainFrameId } } } = await cdp.call('Page.getFrameTree', {}, sessionId));
    await cdp.call('Page.bringToFront', {}, sessionId);
    const navigation = await cdp.call('Page.navigate', { url: 'https://chatgpt.com/' }, sessionId);
    if (navigation.errorText || navigation.isDownload) throw Error('AGENT_SCENARIO_PROVIDER_NOT_READY');
    await settle();
    // This dedicated profile exposes an ordinary Think toggle. Confirm that
    // prerequisite before spending any Send budget; never switch via an API.
    await thinking();
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
          // Prepare steering while the preceding request is pending. Waiting
          // for response headers before typing can consume the thinking window.
          return state.composer && state.empty && (index === 2
            ? state.active && !finished.has(1) : !state.active) ? state : false;
        }, index === 2 ? 'AGENT_SCENARIO_STEERING_UNAVAILABLE' : 'AGENT_SCENARIO_UI_CHANGED', index === 2 ? 15000 : 60000);
        if (before.route !== (index === 0 ? 'new' : 'conversation')) throw Error('AGENT_SCENARIO_ROUTE_MISMATCH');
        if (index === 1) await thinking();
        add({ event: 'before-send', scenario: index, ...before });
        await evaluate(`document.querySelector('#prompt-textarea').focus(); true`);
        await cdp.call('Input.insertText', { text }, sessionId);
        await until(async () => {
          if ([...responses.values()].some(status => !(status >= 200 && status < 300))) throw Error('AGENT_SCENARIO_PROVIDER_REJECTED');
          if (index === 2 && finished.has(1)) throw Error('AGENT_SCENARIO_STEERING_UNAVAILABLE');
          const state = await ui();
          return !state.empty && state.send && (index !== 2 || activeTurn(1));
        }, index === 2 ? 'AGENT_SCENARIO_STEERING_UNAVAILABLE' : 'AGENT_SCENARIO_UI_CHANGED', index === 2 ? 15000 : 5000);
        if (index === 2 && !activeTurn(1)) throw Error('AGENT_SCENARIO_STEERING_UNAVAILABLE');
        // Input can trigger admission preflight. Settle again before the first
        // dispatch, without manufacturing requests or interacting with challenges.
        if (index === 0) await settle();
        current = { index, text, observed: false };
        // Consume before dispatch. A timeout or lost reply is an ambiguous
        // attempt and must never cause an automatic second Enter.
        await consume(); check();
        // Persisting the checkpoint can outlast the thinking window. Recheck
        // both the control and the open response before attempting steering.
        const point = index === 2 ? await evaluate(`(() => {
          const visible = element => !!element && element.getClientRects().length > 0;
          ${sendControl}
          if (!send) return null;
          const rect = send.getBoundingClientRect(), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
          return send.contains(document.elementFromPoint(x, y)) ? { x, y } : null;
        })()`) : null;
        if (index === 2 && (!pointReady(point) || !activeTurn(1))) {
          throw Error('AGENT_SCENARIO_STEERING_UNAVAILABLE');
        }
        add({ event: 'ui-dispatch', scenario: index, input: index === 2 ? 'CDP_SEND_CLICK' : 'CDP_ENTER',
          ...(index === 2 ? { priorResponseActive: activeTurn(1) } : {}), readiness: readiness.snapshot() });
        if (index === 2) {
          await click(point);
        } else {
          await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter',
            windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' }, sessionId);
          await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter',
            windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, sessionId);
        }
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
