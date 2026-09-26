(() => {
if (location.origin !== 'https://chatgpt.com' || window !== window.top) return;
const extensionId = chrome.runtime.id, extensionVersion = chrome.runtime.getManifest().version;
const former = globalThis.__attestampChatGPTContent;
if (former?.active()) return;
former?.dispose();
for (const node of document.querySelectorAll('#attestamp-recording-status')) node.remove();
const contentInstance = crypto.randomUUID(), listeners = [];
let disposed = false, refreshTimer;
function extensionAlive() {
  try { return chrome.runtime.id === extensionId && chrome.runtime.getManifest().version === extensionVersion; }
  catch { return false; }
}
function listen(target, name, listener, options) {
  target.addEventListener(name, listener, options); listeners.push([target, name, listener, options]);
}
function dispose() {
  if (disposed) return;
  disposed = true; stopped = true; capturePolicy = null; bindings.clear(); clearObservations();
  clearTimeout(refreshTimer); clearTimeout(advisoryTimer); transportControl('clear'); feedback?.remove();
  for (const args of listeners) args[0].removeEventListener(...args.slice(1));
  try { chrome.runtime.onMessage.removeListener(runtimeMessage); } catch {}
  if (globalThis.__attestampChatGPTContent?.dispose === dispose) delete globalThis.__attestampChatGPTContent;
}
function notifyWorker(message) {
  try { chrome.runtime.sendMessage(message).catch(() => { if (!extensionAlive()) dispose(); }); }
  catch { if (!extensionAlive()) dispose(); }
}
// BEGIN GENERATED CONVERSATION ROUTES
// Edit recipient/chatgpt-route.mjs, then run build-observer.mjs.
// Preserve the existing signed destination bound (256 including its prefix).
// WEB is the observed route namespace; provider wire IDs remain independent.
const chatGPTRouteIdentifierPattern = /^(?:[A-Za-z0-9_-]{1,243}|WEB:[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12})$/;
const isChatGPTRouteIdentifier = value => typeof value === 'string' && value.length <= 243
  && chatGPTRouteIdentifierPattern.exec(value)?.[0] === value;

function chatGPTDestinationForURL(value) {
  if (value === 'https://chatgpt.com/') return 'new-chat';
  const prefix = 'https://chatgpt.com/c/';
  if (typeof value !== 'string' || !value.startsWith(prefix)) return null;
  const identifier = value.slice(prefix.length, value.endsWith('/') ? -1 : undefined);
  return isChatGPTRouteIdentifier(identifier) ? `conversation:${identifier}` : null;
}

const isChatGPTConversationURL = value => chatGPTDestinationForURL(value)?.startsWith('conversation:') === true;
const isChatGPTDestination = value => value === 'new-chat' || typeof value === 'string'
  && value.startsWith('conversation:') && isChatGPTRouteIdentifier(value.slice(13));
// END GENERATED CONVERSATION ROUTES
const PAGE_CONTRACT = 'chatgpt-web-text/2026-09-21.1';
const CAPTURE_PROFILE = 'pap-chatgpt-capture/5';
const CHANNEL = 'pap-chatgpt-transport/3';
const REQUEST_GAPS = new Set(['REQUEST_BODY_READ_FAILED', 'REQUEST_BODY_LIMIT', 'REQUEST_JSON_INVALID',
  'REQUEST_OPERATION_UNSUPPORTED', 'REQUEST_MEDIA_ONLY', 'REQUEST_PROMPT_MISSING', 'REQUEST_IDENTITY_MISSING', 'REQUEST_PROMPT_INVALID']);
const REQUEST_NOTICES = new Set(['REQUEST_MEDIA_IGNORED', 'REQUEST_CONVERSATION_UNAVAILABLE', 'REQUEST_CONVERSATION_DIFFERENT']);
const MAX_TEXT_BYTES = 256 * 1024;
const observations = new Map(), bindings = new Map();
let activeBinding = null, advisoryTimer = null;
let capturePolicy = null, policyState = null, policySession = null, policyRevision = -1, policyUpdate = 0;
let stopped = false, feedback;
let transportSeen = -Infinity, transportAvailable = false, lastReported = null, sendOrder = 0, newChatToken = null;
let observerState = 'unavailable';

function destination() {
  return chatGPTDestinationForURL(location.href);
}
function transportControl(kind, id) {
  dispatchEvent(new CustomEvent('pap-chatgpt-transport-control-v3', { detail: JSON.stringify({ kind, owner: contentInstance,
    ...(id ? { id, conversationId: capturePolicy.destination === 'new-chat' ? null : capturePolicy.destination.slice(13) } : {}) }) }));
}
function surface() {
  const fresh = !stopped && performance.now() - transportSeen < 3000;
  return { destination: destination() ?? '', surfaceSupported: !stopped && destination() !== null
    && transportAvailable && fresh, attachmentsPresent: false, observerState: fresh ? observerState : 'unavailable' };
}
function surfaceChanged() {
  notifyWorker({ kind: 'PAP_SURFACE_CHANGED' });
}
function showRecording(state) {
  if (disposed || !document.documentElement) return;
  if (!feedback) {
    feedback = document.createElement('div'); feedback.id = 'attestamp-recording-status';
    feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
    Object.assign(feedback.style, { position: 'fixed', bottom: '12px', right: '16px', zIndex: '2147483647',
      padding: '6px 10px', borderRadius: '8px', background: '#17382b', color: '#fff', font: '12px system-ui', pointerEvents: 'none' });
    document.documentElement.append(feedback);
  }
  const labels = { READY: 'Attestamp · ON', SAVING: 'Attestamp · Saving prompt…', PROMPT_SAVED: 'Attestamp · Prompt saved',
    VAULT_CAPACITY_EXHAUSTED: 'Attestamp · Local evidence capacity exhausted · New capture unavailable',
    SAVE_PENDING: 'Attestamp · Save confirmation pending · Check History',
    GAP: 'Attestamp · Recording gap', RECORDING_UNAVAILABLE: 'Attestamp · Recording unavailable' };
  feedback.textContent = labels[state] ?? ''; feedback.hidden = !labels[state];
}
function render(state = lastReported) {
  lastReported = state;
  showRecording(['OFF', 'VAULT_CAPACITY_EXHAUSTED'].includes(state) ? state : !surface().surfaceSupported ? 'RECORDING_UNAVAILABLE' : state);
}
function policyCurrent(policy) {
  return !stopped && capturePolicy?.token === policy.token && policy.expectedUrl === location.href
    && policy.destination === destination();
}
const sameDocumentPolicy = (a, b) => a?.profile === CAPTURE_PROFILE && b?.profile === CAPTURE_PROFILE
  && ['runtimeEpoch', 'browserSessionId', 'tabId', 'windowId', 'tabEpoch'].every(key => a[key] === b[key]);
function continuationCurrent(pending) {
  return !stopped && pending.firstNewChat && observations.get(pending.eventId) === pending
    && performance.now() - pending.observedAt < 5000
    && policySession === pending.policy.browserSessionId
    && (!pending.continuationUrl || pending.continuationUrl === location.href)
    && isChatGPTConversationURL(location.href);
}
function pendingCurrent(pending) {
  return !stopped && observations.get(pending.eventId) === pending && policyState === 'READY'
    && policySession === pending.policy.browserSessionId
    && (pending.policy.destination !== 'new-chat' || policyCurrent(pending.policy) || continuationCurrent(pending));
}
function confirmationCurrent(pending) {
  return !stopped && observations.get(pending.eventId) === pending && policyState === 'READY'
    && policySession === pending.policy.browserSessionId;
}
function reportOutcome(pending, state) {
  pending.feedback = state;
  if (pending.sendOrder === sendOrder) render(state);
}
function clearObservations(keep = []) {
  for (const [id, pending] of observations) if (!keep.includes(pending)) {
    clearTimeout(pending.timer); clearTimeout(pending.receiptTimer); observations.delete(id);
  }
}
function setCapturePolicy(message) {
  if (message.browserSessionId === policySession && message.revision < policyRevision) return;
  policyUpdate++;
  policySession = message.browserSessionId; policyRevision = message.revision;
  const policy = message.policy;
  const next = policy?.profile === CAPTURE_PROFILE && policy.expectedUrl === location.href
    && policy.destination === destination() ? policy : null;
  const state = message.state;
  if (capturePolicy?.token !== next?.token || state !== 'READY' && (bindings.size || observations.size)) {
    // Preserve only events already admitted by this isolated document. Retired
    // bindings cannot admit another conversation's subsequent requests.
    const continuing = [...observations.values()].filter(pending => pending.policy.destination !== 'new-chat'
      && state === 'READY' && sameDocumentPolicy(policy, pending.policy));
    for (const [id, binding] of bindings) {
      const sameSource = state === 'READY' && sameDocumentPolicy(policy, binding.policy);
      const firstRoute = binding.policy.destination === 'new-chat' && sameSource
        && isChatGPTConversationURL(location.href)
        && (!binding.continuationUrl || binding.continuationUrl === location.href)
        && (!binding.expires || performance.now() < binding.expires);
      if (!firstRoute) { bindings.delete(id); continue; }
      binding.continuationUrl ??= location.href;
      binding.expires ??= performance.now() + 5000;
      for (const pending of observations.values()) if (pending.binding === id && continuationCurrent(pending)) {
        pending.continuationUrl = binding.continuationUrl; continuing.push(pending);
      }
    }
    const latest = continuing.find(value => value.sendOrder === sendOrder && (!value.saved || value.firstNewChat));
    const hadRequest = [...observations.values()].some(value => value.sendOrder === sendOrder && value.request && !value.saved);
    clearObservations(continuing);
    capturePolicy = next; activeBinding = null; policyState = state;
    if (next) {
      activeBinding = crypto.randomUUID(); bindings.set(activeBinding, { policy: next });
    }
    if (!continuing.length) clearTimeout(advisoryTimer);
    if (!next && !bindings.size) transportControl('clear');
    render(['OFF', 'VAULT_CAPACITY_EXHAUSTED'].includes(state) ? state : latest ? latest.feedback : hadRequest && !next ? 'SAVE_PENDING' : state);
  } else if (state !== policyState) { policyState = state; render(state); }
  if (capturePolicy && policyCurrent(capturePolicy)) transportControl('arm', activeBinding);
}
async function refreshCapturePolicy() {
  if (!extensionAlive()) { dispose(); return; }
  if (stopped) return;
  clearTimeout(refreshTimer);
  const update = policyUpdate; let timer;
  try {
    transportControl('probe');
    const status = await Promise.race([chrome.runtime.sendMessage({ kind: 'PAP_CAPTURE_STATUS', pageContract: PAGE_CONTRACT }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('timeout')), 1500); })]);
    if (update !== policyUpdate || stopped) return;
    if (status?.kind !== 'PAP_CAPTURE_POLICY') throw Error('unavailable');
    setCapturePolicy(status); render();
  } catch {
    if (!extensionAlive()) { dispose(); return; }
    if (update !== policyUpdate || stopped) return;
    // A missed poll is not consent revocation. Keep bounded observations under
    // their original binding; authenticated policy updates and the engine's
    // ordered cutoff still reject OFF, replaced documents and lost permission.
    render('RECORDING_UNAVAILABLE');
  } finally { clearTimeout(timer); if (!stopped) refreshTimer = setTimeout(refreshCapturePolicy, 1000); }
}
const runtimeMessage = (message, sender, respond) => {
  if (disposed) return;
  if (sender.id !== chrome.runtime.id || sender.tab || message?.pageContract !== PAGE_CONTRACT) {
    respond({ surfaceSupported: false, destination: '', attachmentsPresent: false }); return;
  }
  if (message.kind === 'PAP_INSPECT') { transportControl('probe'); respond(surface()); return; }
  if (message.kind === 'PAP_CAPTURE_POLICY') { setCapturePolicy(message); respond(true); return; }
  if (message.kind === 'PAP_CAPTURE_CONFIRMED') {
    confirmSaved(observations.get(message.eventId), message.result); respond(true); return;
  }
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
  if (message.kind === 'PAP_CONFIRM_REQUEST') {
    const pending = observations.get(message.eventId);
    respond({ nonce: message.nonce, url: location.href, confirmed: Boolean(pending?.request
      && pending.policy.destination !== 'new-chat' && pendingCurrent(pending)
      && pending.policy.token === message.token && (message.acknowledgement
        ? pending.saved && JSON.stringify(pending.acknowledgement) === JSON.stringify(message.acknowledgement)
        : pending.text === message.text && pending.inputMethod === message.inputMethod
          && JSON.stringify(pending.request) === JSON.stringify(message.request))) }); return;
  }
  respond({ error: 'UNSUPPORTED_PAGE_COMMAND' });
};
chrome.runtime.onMessage.addListener(runtimeMessage);
const diagnosticCodes = new Set();
function reportDiagnostic(code) {
  if (diagnosticCodes.has(code)) return;
  diagnosticCodes.add(code);
  notifyWorker({ kind: 'PAP_PAGE_DIAGNOSTIC', pageContract: PAGE_CONTRACT, code });
}
// Optional UI evidence only: a missed transport observation is diagnosable even
// when an opaque page wrapper bypasses fetch. This timer grants/revokes nothing.
function noteSend(event) {
  if (!event.isTrusted || !capturePolicy || !policyCurrent(capturePolicy)) return;
  const selector = event.type === 'keydown' ? '#prompt-textarea' : 'button[data-testid="send-button"]';
  if (![...document.querySelectorAll(selector)].some(node => event.target === node || node.contains?.(event.target))) return;
  const order = ++sendOrder;
  clearTimeout(advisoryTimer);
  advisoryTimer = setTimeout(() => {
    if (order === sendOrder && capturePolicy && policyCurrent(capturePolicy)) {
      reportDiagnostic('REQUEST_NOT_OBSERVED'); render('SAVE_PENDING');
    }
  }, 1500);
}
function confirmSaved(pending, result) {
  if (!pending || !confirmationCurrent(pending) || result?.profile !== CAPTURE_PROFILE
      || result.eventId !== pending.eventId || result.kind !== 'request-observed' || result.state !== 'PROMPT_SAVED') return false;
  pending.saved = true; pending.deduplicated = result.deduplicated === true;
  clearTimeout(pending.receiptTimer); reportOutcome(pending, 'PROMPT_SAVED');
  if (pending.deduplicated) reportDiagnostic('REQUEST_DEDUPLICATED');
  deliverAck(pending); return true;
}
async function reconcile(pending) {
  if (!confirmationCurrent(pending) || pending.saved) return;
  let timer;
  try {
    const query = chrome.runtime.sendMessage({ kind: 'PAP_CAPTURE_RECEIPT', pageContract: PAGE_CONTRACT, eventId: pending.eventId });
    const result = await Promise.race([query, new Promise(resolve => { timer = setTimeout(() => resolve(null), 2500); })]);
    confirmSaved(pending, result);
  } catch {} finally {
    clearTimeout(timer);
    if (confirmationCurrent(pending) && !pending.saved) pending.receiptTimer = setTimeout(() => reconcile(pending), 1500);
  }
}
async function deliver(pending, kind) {
  const message = { kind: 'PAP_CAPTURE', pageContract: PAGE_CONTRACT, token: pending.policy.token,
    eventId: pending.eventId, observationKind: kind,
    ...(kind === 'request-observed' ? { text: pending.text, inputMethod: pending.inputMethod, request: pending.request }
      : { acknowledgement: pending.acknowledgement }) };
  let timer;
  try {
    // Dispatch once. Deadlines trigger read-only reconciliation, not another
    // payload delivery. The original promise's exact-ID late success remains valid.
    const delivery = chrome.runtime.sendMessage(message).then(result => {
      if (kind === 'request-observed') confirmSaved(pending, result);
      return result;
    });
    const result = await Promise.race([delivery,
      new Promise(resolve => { timer = setTimeout(() => resolve(null), 2500); })]);
    if (result?.profile === CAPTURE_PROFILE && result.eventId === pending.eventId && result.kind === kind) {
      if (result.state === 'PROMPT_SAVED') return true;
      if (result.state === 'CAPTURE_REJECTED' && !pending.saved) return false;
    }
  } catch {} finally { clearTimeout(timer); }
  if (kind === 'request-observed' && !pending.saved && confirmationCurrent(pending)) {
    pending.receiptTimer = setTimeout(() => reconcile(pending), 1000);
  }
  return pending.saved ? true : null;
}
function deliverAck(pending) {
  if (!pending.saved || pending.deduplicated || !pending.acknowledgement || pending.ackSent || !pendingCurrent(pending)) return;
  pending.ackSent = true; void deliver(pending, 'acknowledgement');
}
const exactKeys = (value, names) => value && Object.keys(value).sort().join(',') === names.sort().join(',');
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const wireId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
listen(window, 'message', event => {
  if (stopped || event.source !== window || event.origin !== 'https://chatgpt.com' || event.data?.channel !== CHANNEL) return;
  const message = event.data;
  if (message.kind === 'ready' && exactKeys(message, ['channel', 'kind', 'available', 'observerState'])
      && ['ready', 'wrapped', 'replaced', 'unavailable'].includes(message.observerState)
      && message.available === ['ready', 'wrapped'].includes(message.observerState)) {
    const previous = surface();
    transportSeen = performance.now(); transportAvailable = message.available; observerState = message.observerState;
    if (previous.surfaceSupported !== surface().surfaceSupported || previous.observerState !== observerState) { surfaceChanged(); render(); }
    if (capturePolicy && policyCurrent(capturePolicy)) transportControl('arm', activeBinding);
    return;
  }
  if (message.kind === 'matched') {
    if (!exactKeys(message, ['channel', 'kind', 'id', 'binding', 'sequence']) || !uuid(message.id)
        || !uuid(message.binding) || !Number.isSafeInteger(message.sequence) || message.sequence < 1) {
      reportDiagnostic('REQUEST_MESSAGE_REJECTED'); return;
    }
    const binding = bindings.get(message.binding);
    if (!binding || binding.expires && performance.now() >= binding.expires
        || binding.sequence >= message.sequence || observations.has(message.id)) return;
    const pending = { policy: binding.policy, binding: message.binding, eventId: message.id, inputMethod: 'provider-request',
      saved: false, sendOrder: ++sendOrder, feedback: 'READY', observedAt: performance.now(),
      firstNewChat: binding.policy.destination === 'new-chat' && newChatToken !== binding.policy.token,
      continuationUrl: binding.continuationUrl };
    while (observations.size >= 16) {
      const oldest = observations.values().next().value;
      clearTimeout(oldest.timer); clearTimeout(oldest.receiptTimer); observations.delete(oldest.eventId);
    }
    observations.set(message.id, pending);
    if (!(policyCurrent(pending.policy) || continuationCurrent(pending))) {
      observations.delete(message.id); reportDiagnostic('REQUEST_MESSAGE_REJECTED'); render('GAP'); return;
    }
    binding.sequence = message.sequence; clearTimeout(advisoryTimer);
    reportDiagnostic('REQUEST_MATCHED'); reportOutcome(pending, 'READY');
    pending.timer = setTimeout(() => {
      if (!pending.saved && pendingCurrent(pending)) { reportDiagnostic('REQUEST_MESSAGE_MISSING'); reportOutcome(pending, 'SAVE_PENDING'); }
      observations.delete(pending.eventId);
    }, 5000);
    return;
  }
  const pending = observations.get(message.id);
  if (!pending || !pendingCurrent(pending)) {
    if (message.kind === 'request') reportDiagnostic('REQUEST_MESSAGE_REJECTED');
    return;
  }
  if (message.kind === 'notice' && exactKeys(message, ['channel', 'kind', 'id', 'code'])
      && REQUEST_NOTICES.has(message.code)) { reportDiagnostic(message.code); return; }
  if (message.kind === 'gap' && exactKeys(message, ['channel', 'kind', 'id', 'code'])
      && REQUEST_GAPS.has(message.code)) {
    if (!pending.saved) {
      clearTimeout(pending.timer); reportDiagnostic(message.code); reportOutcome(pending, 'GAP'); observations.delete(pending.eventId);
    } return;
  }
  if (message.kind === 'request') {
    const request = message.request;
    if (pending.request) {
      if (!exactKeys(message, ['channel', 'kind', 'id', 'text', 'request'])
          || pending.text !== message.text || JSON.stringify(pending.request) !== JSON.stringify(request)) {
        reportDiagnostic('REQUEST_MESSAGE_REJECTED');
      }
      return;
    }
    if (performance.now() - pending.observedAt >= 5000
        || !exactKeys(message, ['channel', 'kind', 'id', 'text', 'request'])
        || !exactKeys(request, ['profile', 'path', 'messageId', 'conversationId'])
        || request.profile !== 'chatgpt-new-user-text/3' || !wireId(request.messageId)
        || !['/backend-api/conversation', '/backend-api/f/conversation', '/backend-api/f/steer_turn'].includes(request.path)
        || request.conversationId !== null && !wireId(request.conversationId)
        || typeof message.text !== 'string' || !message.text.length || message.text.length > MAX_TEXT_BYTES
        || !message.text.isWellFormed() || new TextEncoder().encode(message.text).length > MAX_TEXT_BYTES) {
      reportDiagnostic('REQUEST_MESSAGE_REJECTED'); reportOutcome(pending, 'GAP'); return;
    }
    pending.request = request; pending.text = message.text;
    if (pending.firstNewChat) newChatToken = pending.policy.token;
    clearTimeout(pending.timer);
    reportDiagnostic('DURABLE_SAVE_DISPATCHED'); reportOutcome(pending, 'SAVING');
    deliver(pending, 'request-observed').then(saved => {
      if (pending.saved) return;
      pending.saved = saved === true;
      if (!confirmationCurrent(pending)) return;
      reportOutcome(pending, saved ? 'PROMPT_SAVED' : saved === null ? 'SAVE_PENDING' : 'GAP');
      if (pending.deduplicated) reportDiagnostic('REQUEST_DEDUPLICATED');
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
listen(document, 'keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
      && !event.repeat && !event.isComposing && event.keyCode !== 229) noteSend(event);
}, true);
listen(document, 'click', event => { if (event.button === 0) noteSend(event); }, true);
listen(window, 'pagehide', () => { stopped = true; capturePolicy = null; activeBinding = null; bindings.clear();
  clearTimeout(refreshTimer); clearTimeout(advisoryTimer); transportControl('clear'); clearObservations(); });
listen(window, 'pageshow', () => { if (stopped && !disposed) { stopped = false; refreshCapturePolicy(); } });
listen(document, 'DOMContentLoaded', () => { render(); surfaceChanged(); });
globalThis.__attestampChatGPTContent = { active: () => !disposed && extensionAlive(), dispose };
// Retire the pre-lifecycle observer without granting its old channel new policy.
dispatchEvent(new CustomEvent('pap-chatgpt-transport-control', { detail: '{"kind":"clear"}' }));
transportControl('claim');
refreshCapturePolicy();
})();
