const PAGE_CONTRACT = 'chatgpt-web-text/2026-09-20';
const CAPTURE_PROFILE = 'pap-chatgpt-capture/3';
const CHANNEL = 'pap-chatgpt-transport/1';
const MAX_TEXT_BYTES = 256 * 1024;
const observations = new Map();
let capturePolicy = null, policyState = null, policySession = null, policyRevision = -1, policyChecked = 0, policyUpdate = 0;
let composing = false, compositionEnded = -Infinity, keyboardIntent = false, stopped = false, feedback;
let transportSeen = -Infinity, transportAvailable = false, lastReported = null, sendOrder = 0, newChatToken = null;
let observerState = 'unavailable';

function destination() {
  if (location.origin !== 'https://chatgpt.com') return null;
  if (location.pathname === '/') return 'new-chat';
  const match = /^\/c\/([A-Za-z0-9_-]+)\/?$/.exec(location.pathname);
  return match ? `conversation:${match[1]}` : null;
}
function transportControl(kind, id) {
  dispatchEvent(new CustomEvent('pap-chatgpt-transport-control', { detail: JSON.stringify({ kind,
    ...(id ? { id, conversationId: capturePolicy.destination === 'new-chat' ? null : capturePolicy.destination.slice(13) } : {}) }) }));
}
function surface() {
  const fresh = !stopped && performance.now() - transportSeen < 3000;
  return { destination: destination() ?? '', surfaceSupported: !stopped && destination() !== null
    && transportAvailable && fresh, attachmentsPresent: false, observerState: fresh ? observerState : 'unavailable' };
}
function surfaceChanged() {
  chrome.runtime.sendMessage({ kind: 'PAP_SURFACE_CHANGED' }).catch(() => {});
}
function showRecording(state) {
  if (!document.documentElement) return;
  if (!feedback) {
    feedback = document.createElement('div'); feedback.id = 'attestamp-recording-status';
    feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
    Object.assign(feedback.style, { position: 'fixed', bottom: '12px', right: '16px', zIndex: '2147483647',
      padding: '6px 10px', borderRadius: '8px', background: '#17382b', color: '#fff', font: '12px system-ui', pointerEvents: 'none' });
    document.documentElement.append(feedback);
  }
  const labels = { READY: 'Attestamp · ON', SAVING: 'Attestamp · Saving prompt…', PROMPT_SAVED: 'Attestamp · Prompt saved',
    GAP: 'Attestamp · Recording gap', RECORDING_UNAVAILABLE: 'Attestamp · Recording unavailable' };
  feedback.textContent = labels[state] ?? ''; feedback.hidden = !labels[state];
}
function render(state = lastReported) {
  lastReported = state;
  showRecording(state === 'OFF' ? 'OFF' : !surface().surfaceSupported ? 'RECORDING_UNAVAILABLE' : state);
}
function policyCurrent(policy) {
  return !stopped && capturePolicy?.token === policy.token && policy.expectedUrl === location.href
    && policy.destination === destination() && performance.now() - policyChecked < 3000;
}
function continuationCurrent(pending) {
  return !stopped && pending.firstNewChat && observations.get(pending.eventId) === pending
    && performance.now() - pending.observedAt < (pending.request ? 5000 : 1500)
    && policySession === pending.policy.browserSessionId
    && (!pending.continuationUrl || pending.continuationUrl === location.href)
    && /^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9_-]+\/?$/.test(location.href);
}
function pendingCurrent(pending) { return policyCurrent(pending.policy) || continuationCurrent(pending); }
function reportOutcome(pending, state) {
  pending.feedback = state;
  if (pending.sendOrder === sendOrder) render(state);
}
function clearObservations(keep = []) {
  for (const [id, pending] of observations) if (!keep.includes(pending)) { clearTimeout(pending.timer); observations.delete(id); }
  if (!keep.length) transportControl('clear');
}
function setCapturePolicy(message) {
  if (message.browserSessionId === policySession && message.revision < policyRevision) return;
  policyUpdate++;
  policySession = message.browserSessionId; policyRevision = message.revision; policyChecked = performance.now();
  const policy = message.policy;
  const next = policy?.profile === CAPTURE_PROFILE && policy.expectedUrl === location.href
    && policy.destination === destination() ? policy : null;
  const state = message.state;
  if (capturePolicy?.token !== next?.token) {
    // A trusted Send can still be waiting in the MAIN-to-isolated message queue.
    // Until its request arrives, retain bounded candidates with their original
    // deadlines instead of guessing which qualifier matches. The worker and
    // ordered engine still authenticate and bind only one first event/document.
    const candidates = state === 'READY' && policy?.profile === CAPTURE_PROFILE ? [...observations.values()].filter(value =>
      continuationCurrent(value) && ['runtimeEpoch', 'browserSessionId', 'tabId', 'windowId', 'tabEpoch']
        .every(key => policy[key] === value.policy[key])
      && (policy.token === value.policy.token || next?.destination.startsWith('conversation:'))) : [];
    const observed = candidates.find(value => value.request);
    const continuing = observed ? [observed] : candidates;
    for (const value of continuing) value.continuationUrl ??= location.href;
    const latest = continuing.find(value => value.sendOrder === sendOrder);
    const hadRequest = [...observations.values()].some(value => value.sendOrder === sendOrder && value.request && !value.saved);
    clearObservations(continuing); capturePolicy = next; policyState = state;
    render(state === 'OFF' ? 'OFF' : latest ? latest.feedback
      : hadRequest && !next ? 'GAP' : state);
  } else if (state !== policyState) { policyState = state; render(state); }
}
async function refreshCapturePolicy() {
  if (stopped) return;
  const update = policyUpdate; let timer;
  try {
    transportControl('probe');
    const status = await Promise.race([chrome.runtime.sendMessage({ kind: 'PAP_CAPTURE_STATUS', pageContract: PAGE_CONTRACT }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('timeout')), 1500); })]);
    if (update !== policyUpdate || stopped) return;
    if (status?.kind !== 'PAP_CAPTURE_POLICY') throw Error('unavailable');
    setCapturePolicy(status); render();
  } catch {
    if (update !== policyUpdate || stopped) return;
    capturePolicy = null; policyState = 'RECORDING_UNAVAILABLE'; clearObservations(); render(policyState);
  } finally { clearTimeout(timer); if (!stopped) setTimeout(refreshCapturePolicy, 1000); }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.tab || message?.pageContract !== PAGE_CONTRACT) {
    respond({ surfaceSupported: false, destination: '', attachmentsPresent: false }); return;
  }
  if (message.kind === 'PAP_INSPECT') { transportControl('probe'); respond(surface()); return; }
  if (message.kind === 'PAP_CAPTURE_POLICY') { setCapturePolicy(message); respond(true); return; }
  if (message.kind === 'PAP_CONFIRM_DOCUMENT') { respond({ nonce: message.nonce, url: location.href, active: !stopped }); return; }
  if (message.kind === 'PAP_CONFIRM_NEW_CHAT') {
    const pending = observations.get(message.eventId);
    respond({ nonce: message.nonce, url: location.href, confirmed: Boolean(pending?.firstNewChat && pending.request
      && performance.now() - pending.observedAt < 5000 && pendingCurrent(pending)
      && pending.policy.token === message.token && (message.acknowledgement
        ? pending.saved && JSON.stringify(pending.acknowledgement) === JSON.stringify(message.acknowledgement)
        : pending.text === message.text && pending.inputMethod === message.inputMethod
          && JSON.stringify(pending.request) === JSON.stringify(message.request))) }); return;
  }
  respond({ error: 'UNSUPPORTED_PAGE_COMMAND' });
});
function reportRejection() {
  chrome.runtime.sendMessage({ kind: 'PAP_PAGE_DIAGNOSTIC', pageContract: PAGE_CONTRACT, code: 'PAGE_SEND_REJECTED' }).catch(() => {});
}
function sendControl() {
  const buttons = [...document.querySelectorAll('button[data-testid="send-button"]')];
  if (buttons.length !== 1) return null;
  const button = buttons[0];
  return button.isConnected && !button.matches(':disabled') && button.getAttribute('aria-disabled') !== 'true'
    && button.getClientRects().length && getComputedStyle(button).visibility === 'visible' ? button : null;
}
function qualifies(event, inputMethod) {
  if (!event.isTrusted || !capturePolicy || !policyCurrent(capturePolicy) || !surface().surfaceSupported
      || document.visibilityState !== 'visible') return false;
  const editors = [...document.querySelectorAll('#prompt-textarea')];
  const editor = editors.length === 1 ? editors[0] : null;
  if (!editor || !(editor instanceof HTMLTextAreaElement || editor.getAttribute('contenteditable') === 'true')
      || !editor.isConnected || editor.disabled || editor.readOnly || editor.hidden
      || getComputedStyle(editor).display === 'none' || getComputedStyle(editor).visibility === 'hidden'
      || [...document.querySelectorAll('input[type=file]')].some(input => input.files?.length)
      || document.querySelector('[data-testid="composer-file-chip"], [data-testid="attachment-preview"]')) return false;
  if (inputMethod === 'enter') return event.target === editor || editor.contains(event.target);
  const button = sendControl();
  return Boolean(button && (event.target === button || button.contains(event.target)));
}
function qualifySend(event, inputMethod) {
  if (!qualifies(event, inputMethod)) {
    const selector = inputMethod === 'enter' ? '#prompt-textarea' : 'button[data-testid="send-button"]';
    if (event.isTrusted && capturePolicy && policyCurrent(capturePolicy)
        && [...document.querySelectorAll(selector)].some(node => event.target === node || node.contains(event.target))) {
      sendOrder++; reportRejection(); render('GAP');
    }
    return false;
  }
  // Advance at the human event, including refusals and bodies that never parse.
  // Request arrival order and native replies cannot redefine the latest Send.
  const order = ++sendOrder;
  if (observations.size >= 16) { reportRejection(); render('GAP'); return false; }
  const pending = { policy: capturePolicy, eventId: crypto.randomUUID(), inputMethod, saved: false,
    sendOrder: order, feedback: 'READY',
    observedAt: performance.now(), firstNewChat: capturePolicy.expectedUrl === 'https://chatgpt.com/' && newChatToken !== capturePolicy.token };
  observations.set(pending.eventId, pending);
  pending.timer = setTimeout(() => {
    if (!pending.saved && pendingCurrent(pending)) reportOutcome(pending, 'GAP');
    observations.delete(pending.eventId);
  }, 1500);
  reportOutcome(pending, 'READY');
  // Only an opaque qualifier crosses to MAIN. It is neither prompt text nor an
  // engine token; the isolated pending record is required for every delivery.
  transportControl('qualify', pending.eventId);
  return true;
}
async function deliver(pending, kind) {
  const message = { kind: 'PAP_CAPTURE', pageContract: PAGE_CONTRACT, token: pending.policy.token,
    eventId: pending.eventId, observationKind: kind,
    ...(kind === 'request-observed' ? { text: pending.text, inputMethod: pending.inputMethod, request: pending.request }
      : { acknowledgement: pending.acknowledgement }) };
  for (let attempt = 0; attempt < 2 && observations.get(pending.eventId) === pending && pendingCurrent(pending); attempt++) {
    let timer;
    try {
      const result = await Promise.race([chrome.runtime.sendMessage(message),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error('timeout')), 2500); })]);
      if (result?.profile === CAPTURE_PROFILE && result.eventId === pending.eventId && result.kind === kind
          && result.state === 'PROMPT_SAVED') return true;
    } catch {} finally { clearTimeout(timer); }
  }
  return false;
}
function deliverAck(pending) {
  if (!pending.saved || !pending.acknowledgement || pending.ackSent || !pendingCurrent(pending)) return;
  pending.ackSent = true; void deliver(pending, 'acknowledgement');
}
const exactKeys = (value, names) => value && Object.keys(value).sort().join(',') === names.sort().join(',');
const wireId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
addEventListener('message', event => {
  if (stopped || event.source !== window || event.origin !== 'https://chatgpt.com' || event.data?.channel !== CHANNEL) return;
  const message = event.data;
  if (message.kind === 'ready' && exactKeys(message, ['channel', 'kind', 'available', 'observerState'])
      && ['ready', 'wrapped', 'replaced', 'unavailable'].includes(message.observerState)
      && message.available === ['ready', 'wrapped'].includes(message.observerState)) {
    const previous = surface();
    transportSeen = performance.now(); transportAvailable = message.available; observerState = message.observerState;
    if (previous.surfaceSupported !== surface().surfaceSupported || previous.observerState !== observerState) { surfaceChanged(); render(); }
    return;
  }
  const pending = observations.get(message.id);
  if (!pending || !pendingCurrent(pending)) return;
  if (message.kind === 'gap' && exactKeys(message, ['channel', 'kind', 'id'])) {
    if (!pending.saved) { reportRejection(); reportOutcome(pending, 'GAP'); } return;
  }
  if (message.kind === 'request') {
    const request = message.request;
    if (pending.request || performance.now() - pending.observedAt >= 1500
        || !exactKeys(message, ['channel', 'kind', 'id', 'text', 'request'])
        || !exactKeys(request, ['profile', 'path', 'messageId', 'conversationId'])
        || request.profile !== 'chatgpt-new-user-text/1' || !wireId(request.messageId)
        || !['/backend-api/conversation', '/backend-api/f/conversation'].includes(request.path)
        || request.conversationId !== (pending.policy.destination === 'new-chat' ? null : pending.policy.destination.slice(13))
        || typeof message.text !== 'string' || !message.text.length || message.text.length > MAX_TEXT_BYTES
        || !message.text.isWellFormed() || new TextEncoder().encode(message.text).length > MAX_TEXT_BYTES) return;
    pending.request = request; pending.text = message.text;
    if (pending.firstNewChat) newChatToken = pending.policy.token;
    clearTimeout(pending.timer); pending.timer = setTimeout(() => observations.delete(pending.eventId), 6500);
    reportOutcome(pending, 'SAVING');
    deliver(pending, 'request-observed').then(saved => {
      pending.saved = saved;
      if (observations.get(pending.eventId) !== pending || !pendingCurrent(pending)) return;
      reportOutcome(pending, saved ? 'PROMPT_SAVED' : 'GAP');
      if (saved) deliverAck(pending);
    });
  } else if (message.kind === 'ack') {
    const ack = message.acknowledgement;
    if (!pending.request || pending.acknowledgement || !exactKeys(message, ['channel', 'kind', 'id', 'acknowledgement'])
        || !exactKeys(ack, ['profile', 'kind', 'conversationId', 'correlationId']) || ack.profile !== 'chatgpt-early-ack/1'
        || !['stream-handoff', 'inline-message'].includes(ack.kind) || !wireId(ack.conversationId) || !wireId(ack.correlationId)
        || pending.request.conversationId !== null && pending.request.conversationId !== ack.conversationId) return;
    pending.acknowledgement = ack; deliverAck(pending);
  }
});
document.addEventListener('compositionstart', () => { composing = true; }, true);
document.addEventListener('compositionend', () => { composing = false; compositionEnded = performance.now(); }, true);
document.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.repeat
      || composing || event.isComposing || event.keyCode === 229 || performance.now() - compositionEnded < 50) return;
  if (qualifySend(event, 'enter')) { keyboardIntent = true; setTimeout(() => { keyboardIntent = false; }, 0); }
}, true);
document.addEventListener('click', event => {
  if (event.button !== 0 || keyboardIntent && event.detail === 0) return;
  qualifySend(event, 'send-button');
}, true);
addEventListener('pagehide', () => { stopped = true; capturePolicy = null; clearObservations(); });
addEventListener('pageshow', () => { if (stopped) { stopped = false; refreshCapturePolicy(); } });
document.addEventListener('DOMContentLoaded', () => { render(); surfaceChanged(); });
refreshCapturePolicy();
