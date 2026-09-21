const PAGE_CONTRACT = 'chatgpt-web-text/2026-09-21.1';
const CAPTURE_PROFILE = 'pap-chatgpt-capture/5';
const CHANNEL = 'pap-chatgpt-transport/2';
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
    SAVE_UNCONFIRMED: 'Attestamp · Save not confirmed · Check History',
    GAP: 'Attestamp · Recording gap', RECORDING_UNAVAILABLE: 'Attestamp · Recording unavailable' };
  feedback.textContent = labels[state] ?? ''; feedback.hidden = !labels[state];
}
function render(state = lastReported) {
  lastReported = state;
  showRecording(state === 'OFF' ? 'OFF' : !surface().surfaceSupported ? 'RECORDING_UNAVAILABLE' : state);
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
    && /^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9_-]+\/?$/.test(location.href);
}
function pendingCurrent(pending) {
  return !stopped && observations.get(pending.eventId) === pending && policyState === 'READY'
    && policySession === pending.policy.browserSessionId
    && (pending.policy.destination !== 'new-chat' || policyCurrent(pending.policy) || continuationCurrent(pending));
}
function reportOutcome(pending, state) {
  pending.feedback = state;
  if (pending.sendOrder === sendOrder) render(state);
}
function clearObservations(keep = []) {
  for (const [id, pending] of observations) if (!keep.includes(pending)) { clearTimeout(pending.timer); observations.delete(id); }
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
        && /^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9_-]+\/?$/.test(location.href)
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
    render(state === 'OFF' ? 'OFF' : latest ? latest.feedback : hadRequest && !next ? 'GAP' : state);
  } else if (state !== policyState) { policyState = state; render(state); }
  if (capturePolicy && policyCurrent(capturePolicy)) transportControl('arm', activeBinding);
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
    // A missed poll is not consent revocation. Keep bounded observations under
    // their original binding; authenticated policy updates and the engine's
    // ordered cutoff still reject OFF, replaced documents and lost permission.
    render('RECORDING_UNAVAILABLE');
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
});
const diagnosticCodes = new Set();
function reportDiagnostic(code) {
  if (diagnosticCodes.has(code)) return;
  diagnosticCodes.add(code);
  chrome.runtime.sendMessage({ kind: 'PAP_PAGE_DIAGNOSTIC', pageContract: PAGE_CONTRACT, code }).catch(() => {});
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
      reportDiagnostic('REQUEST_NOT_OBSERVED'); render('GAP');
    }
  }, 1500);
}
async function deliver(pending, kind) {
  const message = { kind: 'PAP_CAPTURE', pageContract: PAGE_CONTRACT, token: pending.policy.token,
    eventId: pending.eventId, observationKind: kind,
    ...(kind === 'request-observed' ? { text: pending.text, inputMethod: pending.inputMethod, request: pending.request }
      : { acknowledgement: pending.acknowledgement }) };
  let uncertain = false;
  for (let attempt = 0; attempt < 2 && observations.get(pending.eventId) === pending && pendingCurrent(pending); attempt++) {
    let timer;
    try {
      // A local response timeout says nothing about whether the vault committed.
      // Keep each bounded attempt's late success eligible to confirm this exact
      // pending event, without reviving consent or replacing a newer outcome.
      const delivery = chrome.runtime.sendMessage(message).then(result => {
        if (result?.profile === CAPTURE_PROFILE && result.eventId === pending.eventId && result.kind === kind
            && result.state === 'PROMPT_SAVED' && pendingCurrent(pending)) {
          if (result.deduplicated) pending.deduplicated = true;
          if (kind === 'request-observed') {
            pending.saved = true; reportOutcome(pending, 'PROMPT_SAVED');
            if (pending.deduplicated) reportDiagnostic('REQUEST_DEDUPLICATED');
            deliverAck(pending);
          }
        }
        return result;
      });
      const result = await Promise.race([delivery,
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error('timeout')), 2500); })]);
      if (result?.profile === CAPTURE_PROFILE && result.eventId === pending.eventId && result.kind === kind
          && result.state === 'PROMPT_SAVED') {
        if (result.deduplicated) pending.deduplicated = true;
        return true;
      }
      if (result?.state !== 'RECORDING_UNAVAILABLE') uncertain = true;
    } catch { uncertain = true; } finally { clearTimeout(timer); }
  }
  return kind === 'request-observed' && pending.saved ? true : uncertain ? null : false;
}
function deliverAck(pending) {
  if (!pending.saved || pending.deduplicated || !pending.acknowledgement || pending.ackSent || !pendingCurrent(pending)) return;
  pending.ackSent = true; void deliver(pending, 'acknowledgement');
}
const exactKeys = (value, names) => value && Object.keys(value).sort().join(',') === names.sort().join(',');
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
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
    observations.set(message.id, pending);
    if (!(policyCurrent(pending.policy) || continuationCurrent(pending)) || observations.size > 16) {
      observations.delete(message.id); reportDiagnostic('REQUEST_MESSAGE_REJECTED'); render('GAP'); return;
    }
    binding.sequence = message.sequence; clearTimeout(advisoryTimer);
    reportDiagnostic('REQUEST_MATCHED'); reportOutcome(pending, 'READY');
    pending.timer = setTimeout(() => {
      if (!pending.saved && pendingCurrent(pending)) { reportDiagnostic('REQUEST_MESSAGE_MISSING'); reportOutcome(pending, 'GAP'); }
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
    clearTimeout(pending.timer); pending.timer = setTimeout(() => observations.delete(pending.eventId), 6500);
    reportDiagnostic('DURABLE_SAVE_DISPATCHED'); reportOutcome(pending, 'SAVING');
    deliver(pending, 'request-observed').then(saved => {
      if (pending.saved) return;
      pending.saved = saved === true;
      if (observations.get(pending.eventId) !== pending || !pendingCurrent(pending)) return;
      reportOutcome(pending, saved ? 'PROMPT_SAVED' : saved === null ? 'SAVE_UNCONFIRMED' : 'GAP');
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
document.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
      && !event.repeat && !event.isComposing && event.keyCode !== 229) noteSend(event);
}, true);
document.addEventListener('click', event => { if (event.button === 0) noteSend(event); }, true);
addEventListener('pagehide', () => { stopped = true; capturePolicy = null; activeBinding = null; bindings.clear();
  clearTimeout(advisoryTimer); transportControl('clear'); clearObservations(); });
addEventListener('pageshow', () => { if (stopped) { stopped = false; refreshCapturePolicy(); } });
document.addEventListener('DOMContentLoaded', () => { render(); surfaceChanged(); });
refreshCapturePolicy();
