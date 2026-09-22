const ADAPTER_PROFILE = 'pap-chatgpt-chrome/9';
const PAGE_CONTRACT = 'chatgpt-web-text/2026-09-21.1';
const NATIVE_HOST = 'ai.provenance.consumer';
const CAPTURE_PROFILE = 'pap-chatgpt-capture/5';
const PANEL_PROFILE = 'pap-chatgpt-panel/2';
const PANEL_CHANNEL = 'pap-chatgpt-panel-channel/1';
const panelChannels = new Set();
const PANEL_DIAGNOSTIC_PROFILE = 'pap-chatgpt-panel-diagnostic/1';
const PANEL_REJECTIONS = new Set(['PANEL_SENDER_REJECTED', 'PANEL_URL_REJECTED', 'PANEL_MESSAGE_REJECTED',
  'PANEL_CONTEXT_REJECTED', 'PANEL_CONTEXT_UNAVAILABLE', 'PANEL_PERMISSION_REJECTED', 'PANEL_CONNECTION_UNAVAILABLE']);
const CAPTURE_DIAGNOSTIC_PROFILE = 'pap-chatgpt-capture-diagnostic/4';
const CAPTURE_REJECTIONS = new Set(['PAGE_SEND_REJECTED', 'CAPTURE_REJECTED']);
const PAGE_DIAGNOSTICS = new Set([...CAPTURE_REJECTIONS, 'REQUEST_NOT_OBSERVED', 'REQUEST_MATCHED',
  'REQUEST_BODY_READ_FAILED', 'REQUEST_BODY_LIMIT', 'REQUEST_JSON_INVALID',
  'REQUEST_OPERATION_UNSUPPORTED', 'REQUEST_MEDIA_ONLY', 'REQUEST_PROMPT_MISSING', 'REQUEST_IDENTITY_MISSING',
  'REQUEST_PROMPT_INVALID', 'REQUEST_MEDIA_IGNORED', 'REQUEST_CONVERSATION_UNAVAILABLE', 'REQUEST_CONVERSATION_DIFFERENT', 'REQUEST_MESSAGE_REJECTED', 'REQUEST_MESSAGE_MISSING', 'REQUEST_DEDUPLICATED', 'DURABLE_SAVE_DISPATCHED']);
const CAPTURE_DIAGNOSTICS = new Set([...CAPTURE_REJECTIONS, 'TRANSPORT_OBSERVER_READY', 'TRANSPORT_OBSERVER_WRAPPED',
  'TRANSPORT_OBSERVER_REPLACED', 'TRANSPORT_OBSERVER_UNAVAILABLE', 'TRANSPORT_RELAY_READY', 'TRANSPORT_RELAY_UNAVAILABLE',
  'TRANSPORT_POLICY_READY', 'TRANSPORT_POLICY_UNAVAILABLE', 'TRANSPORT_POLICY_OFF',
  'REQUEST_NOT_OBSERVED', 'REQUEST_MATCHED', 'REQUEST_BODY_READ_FAILED', 'REQUEST_BODY_LIMIT', 'REQUEST_JSON_INVALID',
  'REQUEST_OPERATION_UNSUPPORTED', 'REQUEST_MEDIA_ONLY', 'REQUEST_PROMPT_MISSING', 'REQUEST_IDENTITY_MISSING',
  'REQUEST_PROMPT_INVALID', 'REQUEST_MEDIA_IGNORED', 'REQUEST_CONVERSATION_UNAVAILABLE', 'REQUEST_CONVERSATION_DIFFERENT', 'REQUEST_MESSAGE_REJECTED',
  'REQUEST_MESSAGE_MISSING', 'REQUEST_DEDUPLICATED', 'DURABLE_SAVE_DISPATCHED']);
let policyRevision = 0;
const documents = new Map();
const documentRoutes = new Map();
const routeChecks = new Map();
const newChats = new Map();
const retiredPolicies = new Map();
const sameDocumentPolicy = (a, b) => a && b
  && ['runtimeEpoch', 'browserSessionId', 'tabId', 'windowId', 'tabEpoch'].every(key => a[key] === b[key]);
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
const conversationURL = isChatGPTConversationURL;
const supportedURL = url => chatGPTDestinationForURL(url) !== null;
const exactKeys = (value, keys) => value && Object.keys(value).sort().join(',') === keys.sort().join(',');
const wireId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
function validRequest(value) {
  return exactKeys(value, ['profile', 'path', 'messageId', 'conversationId']) && value.profile === 'chatgpt-new-user-text/3'
    && ['/backend-api/conversation', '/backend-api/f/conversation', '/backend-api/f/steer_turn'].includes(value.path)
    && wireId(value.messageId) && (value.conversationId === null || wireId(value.conversationId));
}
function validAcknowledgement(value) {
  return exactKeys(value, ['profile', 'kind', 'conversationId', 'correlationId']) && value.profile === 'chatgpt-early-ack/1'
    && ['stream-handoff', 'inline-message'].includes(value.kind) && wireId(value.conversationId) && wireId(value.correlationId);
}
function noteNewChatRoute(id, url) {
  const pending = newChats.get(id);
  if (pending && !pending.url && conversationURL(url)) {
    pending.url = url; pending.expires = performance.now() + 5000;
  }
}
function rememberNewChatPolicy(context, id, documentId) {
  const policy = context.policies.get(id), previous = newChats.get(id);
  if (policy?.expectedUrl === 'https://chatgpt.com/' && policy.tabEpoch === tabEpochs.get(id)
      && (!previous || previous.policy.token !== policy.token || previous.documentId !== documentId)) {
    newChats.set(id, { policy, documentId, creationUrl: documentRoutes.get(id)?.creationUrl ?? policy.expectedUrl,
      expires: Infinity, url: null, eventId: null });
  }
}
const browserSessionId = `${crypto.randomUUID()}-${crypto.randomUUID()}`;
let connection;
let reconnectDelay = 1000, reconnectTimer;
const tabEpochs = new Map();
function tabEpoch(id) {
  if (!tabEpochs.has(id)) tabEpochs.set(id, crypto.randomUUID());
  return tabEpochs.get(id);
}
const current = context => Boolean(context && connection === context && !context.closed);

async function bounded(promise, timeout = 2_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('ADAPTER_REQUEST_TIMEOUT')), timeout);
    })]);
  } finally { clearTimeout(timer); }
}

async function inspectTabs() {
  const tabs = await bounded(chrome.tabs.query({ url: 'https://chatgpt.com/*' }));
  if (tabs.length > 32) throw Error('TAB_LIMIT');
  for (const id of tabEpochs.keys()) if (!tabs.some(tab => tab.id === id)) tabEpochs.delete(id);
  return Promise.all(tabs.map(async tab => {
    noteNewChatRoute(tab.id, tab.url);
    const epoch = tabEpoch(tab.id);
    let surface;
    try { surface = await bounded(chrome.tabs.sendMessage(tab.id, { kind: 'PAP_INSPECT', pageContract: PAGE_CONTRACT }, { frameId: 0 })); }
    catch { surface = { surfaceSupported: false, destination: '', attachmentsPresent: false }; }
    if (!tab.incognito) {
      const relay = exactKeys(surface, ['destination', 'surfaceSupported', 'attachmentsPresent', 'observerState'])
        && typeof surface.destination === 'string' && typeof surface.surfaceSupported === 'boolean'
        && surface.attachmentsPresent === false && ['ready', 'wrapped', 'replaced', 'unavailable'].includes(surface.observerState);
      reportCaptureDiagnostic(relay ? 'TRANSPORT_RELAY_READY' : 'TRANSPORT_RELAY_UNAVAILABLE');
      if (relay) reportCaptureDiagnostic({ ready: 'TRANSPORT_OBSERVER_READY', wrapped: 'TRANSPORT_OBSERVER_WRAPPED',
        replaced: 'TRANSPORT_OBSERVER_REPLACED', unavailable: 'TRANSPORT_OBSERVER_UNAVAILABLE' }[surface.observerState]);
    }
    return {
      id: tab.id, windowId: tab.windowId, tabEpoch: epoch, url: tab.url ?? '', active: tab.active === true,
      destination: typeof surface?.destination === 'string' ? surface.destination : '', surfaceSupported: !tab.incognito && surface?.surfaceSupported === true,
      attachmentsPresent: surface?.attachmentsPresent === true,
    };
  }));
}

async function permissionState() {
  const granted = await bounded(chrome.permissions.contains({ permissions: ['nativeMessaging', 'sidePanel', 'scripting'], origins: ['https://chatgpt.com/*'] }));
  return granted ? 'granted' : 'revoked';
}

async function stateMessage(kind) {
  const [permissions, tabs] = await Promise.all([permissionState(), inspectTabs()]);
  return {
    kind, extensionId: chrome.runtime.id, adapterProfile: ADAPTER_PROFILE,
    captureProfile: CAPTURE_PROFILE,
    panelProfile: PANEL_PROFILE,
    pageContract: PAGE_CONTRACT, browserSessionId,
    // JavaScript brand strings cannot establish the installed product/channel.
    // The signed native host replaces this fail-closed value with locally
    // verified Chrome Stable identity before adapter pairing.
    browser: { product: 'UNVERIFIED', channel: 'UNVERIFIED', major: 0 },
    platform: { product: 'UNVERIFIED', arch: 'UNVERIFIED', version: '' },
    permissions: ['nativeMessaging', 'sidePanel', 'scripting'], hostPermission: 'https://chatgpt.com/*',
    permissionState: permissions, tabs,
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = undefined; connect(); }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
}

function retire(context) {
  if (!current(context)) return;
  context.closed = true; clearTimeout(context.handshakeTimer); connection = undefined;
  for (const pending of context.captures.values()) pending.resolve({ state: 'RECORDING_UNAVAILABLE' });
  context.captures.clear(); broadcastCapturePolicy(context, true);
  newChats.clear();
  retiredPolicies.clear();
  documentRoutes.clear();
  for (const pending of context.panels.values()) pending({ error: 'PANEL_DISCONNECTED' });
  context.panels.clear();
  try { context.port.disconnect(); } catch {}
  scheduleReconnect();
}

function post(context, message) {
  if (!current(context)) return;
  try { context.port.postMessage(message); } catch { retire(context); }
}

async function publish(context) {
  if (!current(context) || !context.ready || context.publishing || !context.dirty) return;
  context.publishing = true;
  try {
    while (current(context) && context.dirty) {
      context.dirty = false;
      const revision = context.revision, message = await stateMessage('PAP_STATE');
      if (revision === context.revision) post(context, message);
    }
  } catch { retire(context); }
  finally { context.publishing = false; }
}

function publishState() {
  const context = connection;
  if (!context) return;
  context.revision++; context.dirty = true; publish(context);
}

function connect() {
  if (connection) return;
  let port;
  try { port = chrome.runtime.connectNative(NATIVE_HOST); }
  catch { scheduleReconnect(); return; }
  const context = { port, closed: false, ready: false, epoch: null, revision: 0, dirty: false,
    publishing: false,
    policies: new Map(), states: new Map(), captures: new Map(), panels: new Map(), panelReady: false,
    panelDiagnosticsReady: false, panelDiagnostics: new Set(),
    captureDiagnosticsReady: false, captureDiagnostics: new Set() };
  connection = context;
  context.handshakeTimer = setTimeout(() => retire(context), 10_000);
  port.onMessage.addListener(message => {
    if (!current(context)) return;
    if (message?.kind === 'PAP_READY') {
      if (context.ready || message.browserSessionId !== browserSessionId
          || typeof message.runtimeEpoch !== 'string' || !message.runtimeEpoch.length) return retire(context);
      context.ready = true; context.epoch = message.runtimeEpoch;
      context.panelReady = message.panelProfile === PANEL_PROFILE;
      context.panelDiagnosticsReady = message.panelDiagnosticProfile === PANEL_DIAGNOSTIC_PROFILE;
      context.captureDiagnosticsReady = message.captureDiagnosticProfile === CAPTURE_DIAGNOSTIC_PROFILE;
      clearTimeout(context.handshakeTimer); reconnectDelay = 1000; publishState(); return;
    }
    if (context.ready && message?.kind === 'PAP_CAPTURE_POLICY') {
      if (message.profile !== CAPTURE_PROFILE || !Array.isArray(message.policies) || message.policies.length > 32
          || !Array.isArray(message.states) || message.states.length > 32) return retire(context);
      const previous = context.policies;
      context.policies = new Map(message.policies.map(policy => [policy.tabId, policy]));
      context.states = new Map(message.states.map(value => [value.tabId, value.state]));
      for (const [token, entry] of retiredPolicies) {
        const next = context.policies.get(entry.policy.tabId);
        if (entry.expires <= performance.now() || context.states.get(entry.policy.tabId) !== 'READY'
            || !sameDocumentPolicy(entry.policy, next) || documents.get(entry.policy.tabId) !== entry.documentId) retiredPolicies.delete(token);
      }
      for (const [id, policy] of previous) {
        const next = context.policies.get(id), documentId = documents.get(id);
        if (policy.token !== next?.token && policy.destination !== 'new-chat' && documentId
            && context.states.get(id) === 'READY' && sameDocumentPolicy(policy, next) && retiredPolicies.size < 512) {
          retiredPolicies.set(policy.token, { policy, documentId, expires: performance.now() + 12000 });
        }
      }
      for (const [id, pending] of newChats) {
        if (context.states.get(id) !== 'READY' || pending.expires <= performance.now()
            || !pending.url && context.policies.get(id)?.token !== pending.policy.token) newChats.delete(id);
      }
      broadcastCapturePolicy(context); return;
    }
    if (context.ready && message?.kind === 'PAP_CAPTURE_RESULT') {
      context.captures.get(message.requestId)?.resolve(message.result); return;
    }
    if (context.ready && message?.kind === 'PAP_PANEL_RESULT') {
      if (message.profile !== PANEL_PROFILE) return retire(context);
      context.panels.get(message.requestId)?.(message); return;
    }
    retire(context);
  });
  port.onDisconnect.addListener(() => {
    // Reading lastError acknowledges Chrome's fixed native-port failure. Never
    // copy arbitrary platform error text into state or diagnostics.
    void chrome.runtime.lastError;
    retire(context);
  });
  stateMessage('PAP_HELLO').then(value => post(context, value)).catch(() => retire(context));
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.kind === 'PAP_PANEL_REQUEST') {
    // One-shot MessageSender snapshots cannot prove the requesting document is
    // still present. Control requests require its own live Port below.
    respond(rejectPanel('PANEL_SENDER_REJECTED')); return;
  }
  if (['PAP_CAPTURE_STATUS', 'PAP_CAPTURE'].includes(message?.kind)) {
    const capture = message.kind === 'PAP_CAPTURE';
    const unavailable = () => { if (capture) reportCaptureDiagnostic('CAPTURE_REJECTED'); };
    captureMessage(message, sender).then(result => { if (result?.state === 'RECORDING_UNAVAILABLE') unavailable(); respond(result); })
      .catch(() => { unavailable(); respond({ state: 'RECORDING_UNAVAILABLE' }); });
    return true;
  }
  if (message?.kind === 'PAP_PAGE_DIAGNOSTIC') {
    // Fixed stage sightings only; no payload, URL or arbitrary error details.
    if (Object.keys(message).sort().join(',') !== 'code,kind,pageContract' || message.pageContract !== PAGE_CONTRACT
        || sender.id !== chrome.runtime.id || sender.frameId !== 0 || !Number.isSafeInteger(sender.tab?.id)) return;
    try {
      if (new URL(sender.url).origin !== 'https://chatgpt.com') return;
      if (PAGE_DIAGNOSTICS.has(message.code)) reportCaptureDiagnostic(message.code);
    } catch {}
    return;
  }
  if (message?.kind !== 'PAP_SURFACE_CHANGED' || Object.keys(message).length !== 1
      || sender.id !== chrome.runtime.id || sender.frameId !== 0 || !Number.isSafeInteger(sender.tab?.id)) return;
  try {
    if (new URL(sender.url).origin !== 'https://chatgpt.com') return;
    publishState();
  } catch {}
});

// Once per fixed code per native connection, repeated across reconnects so a
// saved debug segment can distinguish observer, relay and policy failures.
// Page reports are advisory; they never grant capture or native authority.
function reportCaptureDiagnostic(code) {
  const context = connection;
  if (!CAPTURE_DIAGNOSTICS.has(code) || !current(context) || !context.ready || !context.captureDiagnosticsReady
      || context.captureDiagnostics.has(code)) return;
  context.captureDiagnostics.add(code);
  post(context, { kind: 'PAP_CAPTURE_DIAGNOSTIC', profile: CAPTURE_DIAGNOSTIC_PROFILE, code });
}

function rejectPanel(stage, error = 'UNTRUSTED_PANEL') {
  const context = connection;
  // A fixed, once-per-stage vocabulary bounds even hostile polling. No sender
  // metadata or submitted data crosses the diagnostic/native boundary.
  if (PANEL_REJECTIONS.has(stage) && current(context) && context.ready && context.panelDiagnosticsReady
      && !context.panelDiagnostics.has(stage)) {
    context.panelDiagnostics.add(stage);
    post(context, { kind: 'PAP_PANEL_DIAGNOSTIC', profile: PANEL_DIAGNOSTIC_PROFILE, code: stage });
  }
  return { error, stage };
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== PANEL_CHANNEL || panelChannels.size >= 32) { port.disconnect(); return; }
  const channel = { port, closed: false, requested: false, confirmation: null };
  panelChannels.add(channel);
  const close = () => {
    if (channel.closed) return;
    channel.closed = true; clearTimeout(timer); panelChannels.delete(channel);
    channel.confirmation?.resolve(false); channel.confirmation = null;
    port.onMessage.removeListener(receive); port.onDisconnect.removeListener(disconnect);
    try { port.disconnect(); } catch {}
  };
  const finish = result => {
    if (channel.closed) return;
    try { port.postMessage({ kind: 'PAP_PANEL_REPLY', result }); } catch {}
    close();
  };
  const disconnect = () => { void chrome.runtime.lastError; close(); };
  const receive = message => {
    if (channel.closed) return;
    if (channel.confirmation) {
      const { nonce, resolve } = channel.confirmation; channel.confirmation = null;
      const valid = message?.kind === 'PAP_PANEL_CONFIRM' && message.nonce === nonce
        && Object.keys(message).sort().join(',') === 'kind,nonce';
      resolve(valid);
      if (!valid) finish(rejectPanel('PANEL_CONTEXT_REJECTED'));
      return;
    }
    if (channel.requested) { finish(rejectPanel('PANEL_MESSAGE_REJECTED')); return; }
    channel.requested = true;
    panelMessage(message, port.sender ?? {}, channel).then(finish)
      .catch(() => finish({ error: 'PANEL_REQUEST_UNCONFIRMED' }));
  };
  const timer = setTimeout(close, 20_000);
  port.onDisconnect.addListener(disconnect); port.onMessage.addListener(receive);
});

async function confirmPanel(channel) {
  if (channel.closed) return false;
  // Mint only AFTER the asynchronous browser checks. A departed copied-URL
  // sender cannot prequeue this reply, or borrow another document's Port.
  const nonce = crypto.randomUUID();
  try {
    const confirmed = new Promise(resolve => { channel.confirmation = { nonce, resolve }; });
    channel.port.postMessage({ kind: 'PAP_PANEL_CHALLENGE', nonce });
    return await bounded(confirmed);
  } catch { return false; }
  finally { channel.confirmation = null; }
}

async function panelMessage(message, sender, channel) {
  const origin = `chrome-extension://${chrome.runtime.id}`, base = `${origin}/sidepanel.html?view=`;
  const opaqueId = value => typeof value === 'string' && value.length > 0 && value.length <= 128;
  if (sender.id !== chrome.runtime.id || sender.tab || sender.origin !== origin || sender.nativeApplication
      || sender.frameId !== undefined && sender.frameId !== 0
      || sender.documentLifecycle !== undefined && sender.documentLifecycle !== 'active'
      || sender.documentId !== undefined && !opaqueId(sender.documentId)) {
    return rejectPanel('PANEL_SENDER_REJECTED');
  }
  const url = sender.url;
  if (typeof url !== 'string' || !url.startsWith(base) || !/^[a-f0-9-]{36}$/.test(url.slice(base.length))) {
    return rejectPanel('PANEL_URL_REJECTED');
  }
  if (message?.kind !== 'PAP_PANEL_REQUEST' || message.profile !== PANEL_PROFILE || !['STATE', 'COMMAND', 'OPEN_DASHBOARD'].includes(message.action)
      || Object.keys(message).sort().join(',') !== ['kind', 'profile', 'action',
        ...(message.action === 'COMMAND' ? ['command'] : [])].sort().join(',')) return rejectPanel('PANEL_MESSAGE_REJECTED');
  const context = connection;
  if (!current(context) || !context.ready || !context.panelReady || context.panels.size >= 8) {
    return rejectPanel('PANEL_CONNECTION_UNAVAILABLE', 'PANEL_UNAVAILABLE');
  }
  let identity;
  try {
    // Chrome 153 omits documentId/lifecycle from non-tab MessageSenders.
    // The Port binds the requester, but sparse Chrome senders cannot identify
    // its context ID. Enumerate every possible non-tab requester, including
    // other URLs: history.replaceState changes the inventory URL without
    // changing port.sender.url or closing the Port. Any non-panel candidate
    // makes authorization ambiguous. Tab callers already fail sender.tab.
    const inspect = async () => {
      const contexts = await bounded(chrome.runtime.getContexts({}));
      if (!Array.isArray(contexts) || contexts.length > 128) return null;
      const candidates = contexts.filter(value => value.contextType !== 'BACKGROUND'
        && !(value.contextType === 'TAB' && Number.isSafeInteger(value.tabId) && value.tabId >= 0));
      if (candidates.some(value => value.contextType !== 'SIDE_PANEL' || value.frameId !== 0
          || value.tabId !== -1 || value.incognito !== false || value.documentOrigin !== origin)) return null;
      const matches = contexts.filter(value => value.documentUrl === url);
      const value = matches.length === 1 ? matches[0] : null;
      return value?.contextType === 'SIDE_PANEL' && value.documentUrl === url && value.documentOrigin === origin
        && value.incognito === false && value.frameId === 0 && value.tabId === -1
        && opaqueId(value.contextId) && opaqueId(value.documentId)
        && (sender.documentId === undefined || sender.documentId === value.documentId) ? value : null;
    };
    identity = await inspect();
    if (!identity || channel.closed) return rejectPanel('PANEL_CONTEXT_REJECTED');
    if (await permissionState() !== 'granted') return rejectPanel('PANEL_PERMISSION_REJECTED');
    const live = await inspect();
    if (channel.closed || !live || live.contextId !== identity.contextId || live.documentId !== identity.documentId) {
      return rejectPanel('PANEL_CONTEXT_REJECTED');
    }
  } catch { return rejectPanel('PANEL_CONTEXT_UNAVAILABLE'); }
  let command;
  if (message.action === 'COMMAND') {
    if (!['SET_RECORDING'].includes(message.command?.kind)) {
      return { error: 'PANEL_REQUEST_REJECTED' };
    }
    command = { ...message.command };
    if (JSON.stringify(command).length > 2048) return { error: 'PANEL_REQUEST_REJECTED' };
  }
  if (!await confirmPanel(channel) || channel.closed) return rejectPanel('PANEL_CONTEXT_REJECTED');
  if (!current(context) || context.panels.size >= 8) return { error: 'PANEL_DISCONNECTED' };
  const requestId = crypto.randomUUID();
  const result = new Promise(resolve => context.panels.set(requestId, resolve));
  try {
    post(context, { kind: 'PAP_PANEL_REQUEST', profile: PANEL_PROFILE, requestId, action: message.action,
      ...(command ? { command } : {}) });
    return await bounded(result, 10_000);
  } finally { context.panels.delete(requestId); }
}

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
chrome.permissions.onRemoved.addListener(() => { newChats.clear(); retiredPolicies.clear(); documentRoutes.clear(); publishState(); });
chrome.tabs.onActivated.addListener(() => publishState());
chrome.tabs.onCreated.addListener(() => publishState());
chrome.tabs.onRemoved.addListener(id => { tabEpochs.delete(id); documents.delete(id); newChats.delete(id); documentRoutes.delete(id); publishState(); });
chrome.tabs.onUpdated.addListener((id, change) => {
  if (!change.url && change.status !== 'loading') { if (change.status === 'complete') publishState(); return; }
  if ((!change.url || supportedURL(change.url)) && documents.has(id)) {
    const documentId = documents.get(id), epoch = tabEpochs.get(id), context = connection;
    // Chrome may report multiple loading updates during a same-document route
    // change. Their count cannot establish document replacement. Preserve the
    // epoch only when the exact original document proves its current live URL;
    // every pending request still needs its separate bounded payload challenge.
    const check = (async () => {
      let valid = false, live;
      try {
        const nonce = crypto.randomUUID();
        const proof = await bounded(chrome.tabs.sendMessage(id, { kind: 'PAP_CONFIRM_DOCUMENT', pageContract: PAGE_CONTRACT, nonce }, { documentId, frameId: 0 }));
        const [tabs, permission] = await Promise.all([bounded(chrome.tabs.query({ url: 'https://chatgpt.com/*' })), permissionState()]);
        live = tabs.find(tab => tab.id === id);
        valid = current(context) && permission === 'granted' && tabs.length <= 32 && live && !live.incognito
          && supportedURL(live.url) && (!change.url || live.url === change.url)
          && proof?.nonce === nonce && proof.active === true && proof.url === live.url;
      } catch {}
      if (documents.get(id) !== documentId || tabEpochs.get(id) !== epoch || routeChecks.get(id) !== check) return;
      if (valid) {
        documentRoutes.set(id, { documentId, epoch, url: live.url, creationUrl: documentRoutes.get(id)?.creationUrl });
        noteNewChatRoute(id, live.url);
      }
      else { tabEpochs.set(id, crypto.randomUUID()); documents.delete(id); newChats.delete(id); documentRoutes.delete(id); }
      routeChecks.delete(id); publishState();
    })();
    routeChecks.set(id, check); return;
  }
  if (tabEpochs.has(id)) tabEpochs.set(id, crypto.randomUUID());
  documents.delete(id); newChats.delete(id); documentRoutes.delete(id);
  // Publish navigation immediately without revoking unrelated tab authority.
  publishState();
});

function captureStatus(context, tabId, unavailable = false) {
  const policy = !unavailable && current(context) && context.ready ? context.policies.get(tabId) : null;
  const status = { kind: 'PAP_CAPTURE_POLICY', pageContract: PAGE_CONTRACT, browserSessionId, revision: policyRevision,
    state: unavailable || !current(context) ? 'RECORDING_UNAVAILABLE' : context.states.get(tabId) ?? 'OFF',
    policy: policy && policy.tabEpoch === tabEpochs.get(tabId) ? policy : null };
  if (current(context)) reportCaptureDiagnostic(status.state === 'OFF' && context.states.has(tabId) ? 'TRANSPORT_POLICY_OFF'
    : status.state === 'READY' && status.policy ? 'TRANSPORT_POLICY_READY' : 'TRANSPORT_POLICY_UNAVAILABLE');
  return status;
}

function broadcastCapturePolicy(context, unavailable = false) {
  policyRevision++;
  for (const [id, documentId] of documents) {
    if (!unavailable) rememberNewChatPolicy(context, id, documentId);
    chrome.tabs.sendMessage(id, captureStatus(context, id, unavailable), { documentId, frameId: 0 }).catch(() => {});
  }
}

async function captureMessage(message, sender) {
  const context = connection;
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || sender.origin !== 'https://chatgpt.com'
      || sender.documentLifecycle !== 'active'
      || !Number.isSafeInteger(sender.tab?.id) || sender.tab.incognito
      || typeof sender.documentId !== 'string' || !sender.documentId.length || sender.documentId.length > 128
      || message.pageContract !== PAGE_CONTRACT) return { state: 'RECORDING_UNAVAILABLE' };
  if (!context || !context.ready || !current(context)) return captureStatus(context, sender.tab.id, true);
  if (routeChecks.has(sender.tab.id)) await bounded(routeChecks.get(sender.tab.id));
  const epoch = tabEpoch(sender.tab.id);
  const candidate = newChats.get(sender.tab.id);
  const [tabs, permission] = await Promise.all([bounded(chrome.tabs.query({ url: 'https://chatgpt.com/*' })), permissionState()]);
  const tab = tabs.find(value => value.id === sender.tab.id);
  if (tab) noteNewChatRoute(tab.id, tab.url);
  if (!current(context) || epoch !== tabEpochs.get(sender.tab.id) || permission !== 'granted'
      || tabs.length > 32 || !tab || tab.incognito || tab.windowId !== sender.tab.windowId) return { state: 'RECORDING_UNAVAILABLE' };
  const route = documentRoutes.get(tab.id);
  let senderURLMatches = tab.url === sender.url || route?.documentId === sender.documentId
    && route.epoch === epoch && route.url === tab.url && sender.url === route.creationUrl;
  if (message.kind === 'PAP_CAPTURE_STATUS') {
    if (Object.keys(message).sort().join(',') !== 'kind,pageContract') return { state: 'RECORDING_UNAVAILABLE' };
    if (!senderURLMatches && sender.url === candidate?.creationUrl && candidate?.documentId === sender.documentId
        && candidate.policy.tabEpoch === epoch && candidate.url === tab.url && candidate.expires > performance.now()) {
      // Chrome retains the document's creation URL in MessageSender after
      // pushState. Authenticate its new exact URL without granting old events
      // any capture authority. Subsequent Sends still need the current policy.
      const nonce = crypto.randomUUID();
      const proof = await bounded(chrome.tabs.sendMessage(tab.id,
        { kind: 'PAP_CONFIRM_DOCUMENT', pageContract: PAGE_CONTRACT, nonce }, { documentId: sender.documentId, frameId: 0 }));
      const [liveTabs, livePermission] = await Promise.all([bounded(chrome.tabs.query({ url: 'https://chatgpt.com/*' })), permissionState()]);
      const live = liveTabs.find(value => value.id === tab.id);
      if (current(context) && candidate === newChats.get(tab.id) && epoch === tabEpochs.get(tab.id)
          && candidate.expires > performance.now() && documents.get(tab.id) === sender.documentId
          && livePermission === 'granted' && liveTabs.length <= 32 && live && !live.incognito
          && live.windowId === tab.windowId && live.url === tab.url
          && proof?.nonce === nonce && proof.active === true && proof.url === live.url) {
        documentRoutes.set(tab.id, { documentId: sender.documentId, epoch, url: live.url, creationUrl: sender.url }); senderURLMatches = true;
      }
    }
    if (!senderURLMatches) return { state: 'RECORDING_UNAVAILABLE' };
    if (documents.has(tab.id) && documents.get(tab.id) !== sender.documentId) {
      tabEpochs.set(tab.id, crypto.randomUUID()); newChats.delete(tab.id); documentRoutes.delete(tab.id);
      documents.set(tab.id, sender.documentId); publishState(); return { state: 'RECORDING_UNAVAILABLE' };
    }
    documents.set(tab.id, sender.documentId);
    if (!documentRoutes.has(tab.id)) documentRoutes.set(tab.id, { documentId: sender.documentId, epoch, url: tab.url, creationUrl: sender.url });
    if (tab.url === 'https://chatgpt.com/') rememberNewChatPolicy(context, tab.id, sender.documentId);
    return captureStatus(context, tab.id);
  }
  const kind = message.observationKind;
  const continuing = candidate?.policy.token === message.token;
  const retired = !continuing && retiredPolicies.get(message.token);
  const policy = continuing ? candidate.policy : retired ? retired.policy : context.policies.get(tab.id);
  if (!policy || policy.token !== message.token || policy.tabEpoch !== epoch || policy.windowId !== tab.windowId
      || !continuing && (!senderURLMatches || !retired && policy.expectedUrl !== tab.url)
      || policy.runtimeEpoch !== context.epoch
      || policy.browserSessionId !== browserSessionId || documents.get(tab.id) !== sender.documentId
      || context.captures.size >= 32 || !['request-observed', 'acknowledgement'].includes(kind)
      || Object.keys(message).sort().join(',') !== ['kind', 'pageContract', 'token', 'eventId', 'observationKind',
        ...(kind === 'request-observed' ? ['text', 'inputMethod', 'request'] : ['acknowledgement'])].sort().join(',')
      || !/^[a-f0-9-]{36}$/.test(message.eventId ?? '')
      || kind === 'request-observed' && (typeof message.text !== 'string' || message.text.length > 256 * 1024
        || !message.text.isWellFormed() || new TextEncoder().encode(message.text).length > 256 * 1024
        || message.inputMethod !== 'provider-request' || !validRequest(message.request))
      || kind === 'acknowledgement' && !validAcknowledgement(message.acknowledgement)) return { state: 'RECORDING_UNAVAILABLE' };
  // A route namespace is not provider request metadata. The isolated relay and
  // engine correlate acknowledgements with the saved request and exact event.
  if (retired) {
    const valid = () => retiredPolicies.get(message.token) === retired && retired.expires > performance.now()
      && retired.documentId === sender.documentId && context.states.get(tab.id) === 'READY'
      && sameDocumentPolicy(policy, context.policies.get(tab.id));
    if (!valid()) return { state: 'RECORDING_UNAVAILABLE' };
    // Old policy alone is insufficient: challenge the exact isolated document
    // for this already-admitted event and its immutable original payload.
    const nonce = crypto.randomUUID();
    const proof = await bounded(chrome.tabs.sendMessage(tab.id, { kind: 'PAP_CONFIRM_REQUEST', pageContract: PAGE_CONTRACT,
      nonce, token: message.token, eventId: message.eventId,
      ...(kind === 'request-observed' ? { text: message.text, inputMethod: message.inputMethod, request: message.request }
        : { acknowledgement: message.acknowledgement }) }, { documentId: sender.documentId, frameId: 0 }));
    const [liveTabs, livePermission] = await Promise.all([bounded(chrome.tabs.query({ url: 'https://chatgpt.com/*' })), permissionState()]);
    const live = liveTabs.find(value => value.id === tab.id);
    if (!current(context) || !valid() || epoch !== tabEpochs.get(tab.id) || documents.get(tab.id) !== sender.documentId
        || livePermission !== 'granted' || liveTabs.length > 32 || !live || live.incognito || live.windowId !== tab.windowId
        || live.url !== context.policies.get(tab.id)?.expectedUrl
        || proof?.nonce !== nonce || proof.confirmed !== true || proof.url !== live.url) return { state: 'RECORDING_UNAVAILABLE' };
  }
  if (continuing) {
    if (candidate !== newChats.get(tab.id) || candidate.documentId !== sender.documentId
        || candidate.expires <= performance.now() || candidate.eventId && candidate.eventId !== message.eventId
        || ![policy.expectedUrl, candidate.url, candidate.creationUrl].includes(sender.url)
        || tab.url !== policy.expectedUrl && !conversationURL(tab.url)
        || candidate.url && ![policy.expectedUrl, candidate.url].includes(tab.url)) return { state: 'RECORDING_UNAVAILABLE' };
    if (kind === 'acknowledgement' && candidate.eventId !== message.eventId) return { state: 'RECORDING_UNAVAILABLE' };
    const nonce = crypto.randomUUID();
    const proof = await bounded(chrome.tabs.sendMessage(tab.id, { kind: 'PAP_CONFIRM_NEW_CHAT', pageContract: PAGE_CONTRACT,
      nonce, token: message.token, eventId: message.eventId,
      ...(kind === 'request-observed' ? { text: message.text, inputMethod: message.inputMethod, request: message.request }
        : { acknowledgement: message.acknowledgement }) },
    { documentId: sender.documentId, frameId: 0 }));
    const [liveTabs, livePermission] = await Promise.all([bounded(chrome.tabs.query({ url: 'https://chatgpt.com/*' })), permissionState()]);
    const live = liveTabs.find(value => value.id === tab.id);
    if (!current(context) || candidate !== newChats.get(tab.id) || candidate.expires <= performance.now()
        || epoch !== tabEpochs.get(tab.id) || documents.get(tab.id) !== sender.documentId
        || livePermission !== 'granted' || liveTabs.length > 32 || !live || live.incognito || live.windowId !== tab.windowId
        || ![policy.expectedUrl, candidate.url].includes(live.url)
        || proof?.nonce !== nonce || proof?.confirmed !== true || proof.url !== live.url) return { state: 'RECORDING_UNAVAILABLE' };
    candidate.eventId = message.eventId;
    candidate.expires = Math.min(candidate.expires, performance.now() + 5000);
    if (conversationURL(live.url)) documentRoutes.set(tab.id, { documentId: sender.documentId, epoch, url: live.url, creationUrl: sender.url });
  }
  const requestId = crypto.randomUUID();
  const result = new Promise(resolve => context.captures.set(requestId, { resolve }));
  const { token, scope, runtimeEpoch, browserSessionId: session, tabId, windowId, tabEpoch: documentEpoch, destination } = policy;
  const observation = { profile: CAPTURE_PROFILE, kind, token, eventId: message.eventId,
    source: { adapterProfile: ADAPTER_PROFILE, pageContract: PAGE_CONTRACT, scope, runtimeEpoch,
      browserSessionId: session, tabId, windowId, tabEpoch: documentEpoch, destination, documentId: sender.documentId },
    ...(kind === 'request-observed' ? { textBytes: btoa(Array.from(new TextEncoder().encode(message.text), byte => String.fromCharCode(byte)).join('')),
      inputMethod: message.inputMethod, request: message.request } : { acknowledgement: message.acknowledgement }) };
  try {
    post(context, { kind: 'PAP_CAPTURE', requestId, observation, ...(continuing ? { newChatContinuation: true }
      : retired ? { requestContinuation: true } : {}) });
    try { return await bounded(result); }
    catch { return { state: 'SAVE_UNCONFIRMED' }; }
  } finally { context.captures.delete(requestId); }
}
let recovery;
function recoverExistingTabs() {
  if (!chrome.scripting?.executeScript) return Promise.resolve();
  if (recovery) return recovery;
  recovery = (async () => {
    if (await permissionState() !== 'granted') return;
    const tabs = await bounded(chrome.tabs.query({ url: 'https://chatgpt.com/*' }));
    const eligible = tabs.filter(tab => Number.isSafeInteger(tab.id) && tab.id >= 0
      && !tab.incognito && !tab.discarded && supportedURL(tab.url));
    // Bound concurrent recovery, not the number of documents restored. Even
    // above the capture inventory limit, every tab needs current, truthful UI.
    const batchSize = 8;
    for (let offset = 0; offset < eligible.length; offset += batchSize) {
      if (await permissionState() !== 'granted') return;
      await Promise.allSettled(eligible.slice(offset, offset + batchSize).map(async tab => {
        // Pin the MAIN injection to the document Chrome actually recovered, so a
        // concurrent navigation cannot join two different document instances.
        const results = await bounded(chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] },
          world: 'ISOLATED', files: ['content-script.js'], injectImmediately: true }));
        if (results?.length !== 1 || results[0].frameId !== 0
            || typeof results[0].documentId !== 'string' || !results[0].documentId.length
            || results[0].documentId.length > 128 || await permissionState() !== 'granted') return;
        await bounded(chrome.scripting.executeScript({ target: { tabId: tab.id, documentIds: [results[0].documentId] },
          world: 'MAIN', files: ['fetch-observer.js'], injectImmediately: true }));
      }));
    }
  })().catch(() => {}).finally(() => { recovery = null; publishState(); });
  return recovery;
}
chrome.runtime.onInstalled.addListener(() => { void recoverExistingTabs(); });
connect();
void recoverExistingTabs();
