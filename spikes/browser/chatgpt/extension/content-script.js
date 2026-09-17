const PAGE_CONTRACT = 'chatgpt-web-text/2026-09-15';
const MAX_TEXT_BYTES = 256 * 1024;

function destination() {
  if (location.origin !== 'https://chatgpt.com') return null;
  if (location.pathname === '/') return 'new-chat';
  const match = /^\/c\/([A-Za-z0-9_-]+)\/?$/.exec(location.pathname);
  return match ? `conversation:${match[1]}` : null;
}

function composers() {
  return [...document.querySelectorAll('#prompt-textarea')]
    .filter(node => node instanceof HTMLTextAreaElement || node.getAttribute('contenteditable') === 'true');
}

function attachmentsPresent() {
  if ([...document.querySelectorAll('input[type=file]')].some(input => input.files?.length)) return true;
  return document.querySelector('[data-testid="composer-file-chip"], [data-testid="attachment-preview"]') !== null;
}

function surface() {
  const editor = composers();
  const target = destination();
  let unambiguous = true;
  try { sendControl(); } catch { unambiguous = false; }
  return {
    destination: target ?? '',
    surfaceSupported: target !== null && editor.length === 1 && unambiguous,
    attachmentsPresent: attachmentsPresent(),
  };
}

// Only fixed capability bits leave the page on drift; no DOM text, selectors,
// conversation identifiers or evidence bytes are included in this notification.
if (typeof MutationObserver === 'function') {
  let lastSurface = JSON.stringify(surface());
  const changed = () => {
    const current = surface(), next = JSON.stringify(current);
    if (next === lastSurface) return;
    lastSurface = next;
    // A surface that cannot synchronously authenticate a Send must stop being
    // advertised as ON in this task, not after a worker/native round-trip: the
    // provider can re-render its composer and the next input task can already
    // carry a genuine Send. Only the advertisement drops here; the retained
    // policy, its token and pending observations still cover an already-observed
    // Send for the bounded grace.
    surfaceAvailable = current.surfaceSupported;
    render();
    chrome.runtime.sendMessage({ kind: 'PAP_SURFACE_CHANGED' }).catch(() => {});
  };
  new MutationObserver(changed).observe(document.documentElement, {
    subtree: true, childList: true, attributes: true, characterData: true,
  });
  document.addEventListener('input', changed, true);
  document.addEventListener('change', changed, true);
}
function sendControls() {
  return [...document.querySelectorAll('button[data-testid="send-button"]')];
}

function sendControl() {
  const controls = sendControls();
  if (controls.length > 1) throw Error('ambiguous Send controls');
  const button = controls[0];
  if (!button || !button.isConnected || button.matches(':disabled') || button.getAttribute('aria-disabled') === 'true'
      || !button.getClientRects().length || getComputedStyle(button).visibility !== 'visible') return null;
  return button;
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.tab || message?.pageContract !== PAGE_CONTRACT) {
    respond({ surfaceSupported: false, destination: '', attachmentsPresent: false });
    return;
  }
  if (message.kind === 'PAP_INSPECT') { respond(surface()); return; }
  if (message.kind === 'PAP_CAPTURE_POLICY') { setCapturePolicy(message); respond(true); return; }
  if (message.kind === 'PAP_CONFIRM_DOCUMENT') {
    respond({ nonce: message.nonce, url: location.href, active: !stopped }); return;
  }
  if (message.kind === 'PAP_CONFIRM_NEW_CHAT') {
    const pending = observations.get(message.eventId);
    respond({ nonce: message.nonce, url: location.href, confirmed: Boolean(pending?.firstNewChat && performance.now() - pending.observedAt < 5000 && pendingCurrent(pending)
      && pending.policy.token === message.token && pending.text === message.text && pending.inputMethod === message.inputMethod) });
    return;
  }
  respond({ error: 'UNSUPPORTED_PAGE_COMMAND' });
});

const CAPTURE_PROFILE = 'pap-chatgpt-capture/2';
const MESSAGE_SELECTOR = '[data-message-author-role="user"][data-message-id]';
let capturePolicy = null, policyState = null, policySession = null, policyRevision = -1, policyChecked = 0;
let composing = false, compositionEnded = -Infinity, keyboardIntent = false, stopped = false, feedback;
// null until this document has computed its own surface. Once it has, a surface
// that is not synchronously observable bounds every advertised state, so an
// asynchronous worker reply can never restore READY while this document still
// cannot authenticate a Send.
let surfaceAvailable = null, lastReported = null;
let latestIntent = null;
let newChatToken = null;
const observations = new Map();

function showRecording(state) {
  if (!feedback) {
    feedback = document.createElement('div'); feedback.id = 'attestamp-recording-status';
    feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
    Object.assign(feedback.style, { position: 'fixed', bottom: '12px', right: '16px', zIndex: '2147483647',
      padding: '6px 10px', borderRadius: '8px', background: '#17382b', color: '#fff', font: '12px system-ui', pointerEvents: 'none' });
    document.documentElement.append(feedback);
  }
  const labels = { READY: 'Attestamp · ON', SAVING: 'Attestamp · Saving prompt…',
    PROMPT_SAVED: 'Attestamp · Prompt saved', GAP: 'Attestamp · Recording gap',
    RECORDING_UNAVAILABLE: 'Attestamp · Recording unavailable', OBSERVATION_GAP: 'Attestamp · Prompt saved' };
  const label = labels[state] ?? '';
  if (feedback.textContent !== label) feedback.textContent = label;
  if (feedback.hidden !== !label) feedback.hidden = !label;
}

function observationFresh(pending) {
  return !stopped && pending.firstNewChat && observations.get(pending.eventId) === pending
    && performance.now() - pending.observedAt < 5000 && pendingCurrent(pending);
}

// The single advertised-state decision. `reported` is the state the worker last
// published for this document; this document can only withhold it, never invent
// a higher one. `pending` is the evidence this decision speaks for, which is not
// always what is still tracked: a revocation drops its observations and then
// still has to report the gap they proved.
function advertised(pending, authority) {
  if (surfaceAvailable === false) return 'RECORDING_UNAVAILABLE';
  if (lastReported === 'OFF') return 'OFF';
  const continuing = pending.find(observationFresh);
  if (continuing) return continuing.saved ? 'PROMPT_SAVED' : 'SAVING';
  if (authority) return lastReported;
  return pending.length ? pending.every(value => value.saved) && observations.size <= pending.length
    ? 'OBSERVATION_GAP' : 'GAP' : lastReported;
}

function render({ pending = [...observations.values()], reported = lastReported, authority = capturePolicy } = {}) {
  lastReported = reported;
  showRecording(advertised(pending, authority));
}

function clearObservations() {
  for (const pending of observations.values()) clearTimeout(pending.timer);
  observations.clear();
  latestIntent = null;
}

function setCapturePolicy(message) {
  if (message.browserSessionId === policySession && message.revision < policyRevision) return;
  policySession = message.browserSessionId; policyRevision = message.revision; policyChecked = performance.now();
  const policy = message.policy;
  const next = policy?.profile === CAPTURE_PROFILE && policy.expectedUrl === location.href
    && policy.destination === destination() ? policy : null;
  // The worker reports the advertised state. A retained policy still lets an
  // already-observed Send finish, but it must not advertise this surface as
  // recording new Sends while the composer controls cannot be observed.
  const state = message.state;
  if (capturePolicy?.token !== next?.token) {
    const continuing = [...observations.values()].find(value => value.firstNewChat && continuationCurrent(value)
      && message.browserSessionId === value.policy.browserSessionId && state === 'READY');
    // The branch below drops the observations this state no longer covers, so
    // capture what they proved before clearing them.
    const pending = [...observations.values()].filter(value => value !== continuing);
    for (const [id, value] of observations) if (value !== continuing) {
      clearTimeout(value.timer); observations.delete(id);
    }
    if (!continuing) latestIntent = null;
    capturePolicy = next;
    policyState = state;
    // The revoked observations are already gone from the map, so this decision
    // has to be told what they proved.
    render({ pending, reported: state, authority: next });
    return;
  }
  // A steady poll must not overwrite transient page feedback (a save, a gap or a
  // withdrawal) that no newer worker state contradicts.
  if (state !== policyState) { policyState = state; render({ reported: state, authority: next }); }
}

async function refreshCapturePolicy() {
  if (stopped) return;
  const revision = policyRevision;
  let timer;
  try {
    const status = await Promise.race([
      chrome.runtime.sendMessage({ kind: 'PAP_CAPTURE_STATUS', pageContract: PAGE_CONTRACT }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('timeout')), 1500); }),
    ]);
    if (revision !== policyRevision || stopped) return;
    if (status?.kind !== 'PAP_CAPTURE_POLICY') throw Error('unavailable');
    setCapturePolicy(status);
  } catch {
    if (revision !== policyRevision || stopped) return;
    capturePolicy = null; policyState = 'RECORDING_UNAVAILABLE'; clearObservations();
    render({ reported: policyState, authority: null });
  } finally {
    clearTimeout(timer);
    if (!stopped) setTimeout(refreshCapturePolicy, 1000);
  }
}

// Preserve text nodes and explicit line boundaries, including trailing spaces
// and combining characters. Unknown/hidden rich content has no claimed mapping.
function observedText(editor) {
  if (editor.hidden || getComputedStyle(editor).display === 'none' || getComputedStyle(editor).visibility === 'hidden') throw Error('hidden text');
  if (editor instanceof HTMLTextAreaElement) return editor.value;
  let count = 0, length = 0;
  const inline = (node, depth = 0) => {
    if (++count > 4096 || depth > 32) throw Error('unsupported text structure');
    if (node.nodeType === 3) {
      length += node.data.length;
      if (length > MAX_TEXT_BYTES) throw Error('text limit');
      return node.data;
    }
    if (node.nodeType !== 1 || !['BR', 'SPAN', 'STRONG', 'EM', 'B', 'I', 'CODE', 'S', 'U'].includes(node.tagName)
        || node.hidden || getComputedStyle(node).display === 'none' || getComputedStyle(node).visibility === 'hidden') throw Error('unsupported text structure');
    if (node.childNodes.length > 4096) throw Error('text limit');
    return node.tagName === 'BR' ? '\n' : [...node.childNodes].map(child => inline(child, depth + 1)).join('');
  };
  if (editor.childNodes.length > 4096) throw Error('text limit');
  const children = [...editor.childNodes];
  if (children.some(node => ['P', 'DIV'].includes(node.tagName))) {
    if (children.some(node => !['P', 'DIV'].includes(node.tagName))) throw Error('mixed text structure');
    return children.map(node => {
      if (node.childNodes.length > 4096) throw Error('text limit');
      if (node.hidden || getComputedStyle(node).display === 'none' || getComputedStyle(node).visibility === 'hidden') throw Error('hidden text');
      return node.childNodes.length === 1 && node.firstChild.tagName === 'BR' ? '' : [...node.childNodes].map(child => inline(child)).join('');
    }).join('\n');
  }
  return children.map(child => inline(child)).join('');
}

function policyCurrent(policy) {
  return !stopped && capturePolicy?.token === policy.token && policy.expectedUrl === location.href
    && policy.destination === destination() && performance.now() - policyChecked < 3000;
}

function continuationCurrent(pending) {
  return !stopped && pending.firstNewChat && observations.get(pending.eventId) === pending
    && performance.now() - pending.observedAt < 5000 && policySession === pending.policy.browserSessionId
    && /^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9_-]+\/?$/.test(location.href);
}

function pendingCurrent(pending) {
  // An already-observed first Send keeps its own bounded continuation window; a
  // transient unsupported surface must not discard it. OFF, a token change and a
  // destination change already clear the observation outright.
  return policyCurrent(pending.policy) || continuationCurrent(pending);
}

function reportObservation(pending, state) {
  if (latestIntent === pending.eventId && pendingCurrent(pending)) showRecording(state);
}

async function deliverObservation(pending, kind, messageId) {
  const message = { kind: 'PAP_CAPTURE', pageContract: PAGE_CONTRACT, token: pending.policy.token,
    eventId: pending.eventId, observationKind: kind, text: pending.text,
    ...(kind === 'send-intent' ? { inputMethod: pending.inputMethod } : { messageId }) };
  const current = () => kind === 'send-intent' ? pendingCurrent(pending) : policyCurrent(pending.policy);
  for (let attempt = 0; attempt < 2 && current(); attempt++) {
    let timer;
    try {
      const result = await Promise.race([chrome.runtime.sendMessage(message),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error('capture timeout')), 2500); })]);
      if (result?.profile === CAPTURE_PROFILE && result.eventId === pending.eventId && result.kind === kind
          && result.state === 'PROMPT_SAVED' && current()) return true;
    } catch {} finally { clearTimeout(timer); }
  }
  return false;
}

// Fixed capability bits only: one bounded rejection code leaves the page when a
// genuine-looking Send cannot be observed, so an owner debug session can tell a
// page-side eligibility rejection apart from a worker or engine rejection. No
// DOM text, selectors, prompt bytes or identifiers are included.
function reportRejection() {
  chrome.runtime.sendMessage({ kind: 'PAP_PAGE_DIAGNOSTIC', pageContract: PAGE_CONTRACT, code: 'PAGE_SEND_REJECTED' })
    .catch(() => {});
}

function observeSend(event, inputMethod) {
  const policy = capturePolicy;
  if (!event.isTrusted || !policy || !policyCurrent(policy) || document.visibilityState !== 'visible') return;
  // A Send is observed only on a surface this document has synchronously
  // authenticated. A surface that churned refuses deterministically here instead
  // of minting an observation it would then have to gap. Already-observed Sends
  // keep their own boundary above and are unaffected.
  if (surfaceAvailable === false) { reportRejection(); return; }
  let editor, text, baseline;
  try {
    const current = composers(); editor = current[0];
    if (current.length !== 1 || !editor.isConnected || editor.disabled || editor.readOnly || attachmentsPresent()
        || !sendControl() || observations.size >= 16) throw Object.assign(Error('unsupported send'), { eligibility: true });
    if (inputMethod === 'enter' && event.target !== editor && !editor.contains(event.target)) return;
    text = observedText(editor);
    if (!text.length || text.length > MAX_TEXT_BYTES || !text.isWellFormed()
        || new TextEncoder().encode(text).length > MAX_TEXT_BYTES) throw Error('unsupported text');
    baseline = document.querySelectorAll(MESSAGE_SELECTOR);
    if (baseline.length > 256) throw Error('message limit');
    baseline = [...baseline];
  } catch (error) { latestIntent = null; showRecording('GAP'); if (error.eligibility) reportRejection(); return; }
  const pending = { policy, eventId: crypto.randomUUID(), text, inputMethod, saved: false,
    observedAt: performance.now(), firstNewChat: policy.expectedUrl === 'https://chatgpt.com/' && newChatToken !== policy.token,
    baseline: new Set(baseline), ids: new Set(baseline.map(node => node.getAttribute('data-message-id'))) };
  if (pending.firstNewChat) newChatToken = policy.token;
  observations.set(pending.eventId, pending);
  latestIntent = pending.eventId;
  pending.timer = setTimeout(() => {
    observations.delete(pending.eventId);
    reportObservation(pending, pending.saved ? 'OBSERVATION_GAP' : 'GAP');
  }, 10_000);
  showRecording('SAVING');
  deliverObservation(pending, 'send-intent').then(saved => {
    pending.saved = saved;
    if (!pendingCurrent(pending)) return;
    if (!saved) { clearTimeout(pending.timer); observations.delete(pending.eventId); reportObservation(pending, 'GAP'); return; }
    reportObservation(pending, 'PROMPT_SAVED'); observeMessages();
  });
  return true;
}

function observeMessages() {
  if (!observations.size) return;
  const selected = document.querySelectorAll(MESSAGE_SELECTOR);
  if (selected.length > 256) return;
  const nodes = [...selected];
  for (const pending of observations.values()) {
    if (!pending.saved || pending.matching || !policyCurrent(pending.policy)) continue;
    const matches = nodes.filter(node => {
      const id = node.getAttribute('data-message-id');
      if (pending.baseline.has(node) || pending.ids.has(id) || !/^[A-Za-z0-9_-]{1,128}$/.test(id ?? '')) return false;
      try { return observedText(node) === pending.text; } catch { return false; }
    });
    if (matches.length !== 1 || [...observations.values()].filter(value => value.text === pending.text).length !== 1) continue;
    pending.matching = true;
    deliverObservation(pending, 'message-observed', matches[0].getAttribute('data-message-id')).then(saved => {
      clearTimeout(pending.timer); observations.delete(pending.eventId);
      if (!saved) reportObservation(pending, 'OBSERVATION_GAP');
    });
  }
}

document.addEventListener('compositionstart', () => { composing = true; }, true);
document.addEventListener('compositionend', () => { composing = false; compositionEnded = performance.now(); }, true);
document.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.repeat
      || composing || event.isComposing || event.keyCode === 229 || performance.now() - compositionEnded < 50) return;
  if (observeSend(event, 'enter')) {
    keyboardIntent = true; setTimeout(() => { keyboardIntent = false; }, 0);
  }
}, true);
document.addEventListener('click', event => {
  if (event.button !== 0 || keyboardIntent && event.detail === 0) return;
  try {
    const button = sendControl();
    if (button && (event.target === button || button.contains(event.target))) observeSend(event, 'send-button');
  } catch {
    // Ambiguous Send controls. Only a click that actually landed on one of them
    // is a Send the page declined to observe; unrelated clicks during a render
    // are not gaps. No DOM detail leaves the page.
    if (capturePolicy && sendControls().some(control => event.target === control || control.contains(event.target))) {
      reportRejection();
      // While the surface is unobservable the advertisement already says so, and
      // the owner must not be told the Send was lost after that truthful warning.
      if (surfaceAvailable === false) return;
      latestIntent = null; showRecording('GAP');
    }
  }
}, true);
new MutationObserver(observeMessages).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
addEventListener('pagehide', () => { stopped = true; capturePolicy = null; surfaceAvailable = null; clearObservations(); });
addEventListener('pageshow', () => { if (stopped) { stopped = false; refreshCapturePolicy(); } });
refreshCapturePolicy();
