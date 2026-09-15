const ADAPTER_PROFILE = 'pap-chatgpt-chrome/6';
const PAGE_CONTRACT = 'chatgpt-web-text/2026-09-15';
const NATIVE_HOST = 'ai.provenance.consumer';
const CAPTURE_PROFILE = 'pap-chatgpt-capture/2';
const PANEL_PROFILE = 'pap-chatgpt-panel/2';
const PANEL_CHANNEL = 'pap-chatgpt-panel-channel/1';
const panelChannels = new Set();
const PANEL_DIAGNOSTIC_PROFILE = 'pap-chatgpt-panel-diagnostic/1';
const PANEL_REJECTIONS = new Set(['PANEL_SENDER_REJECTED', 'PANEL_URL_REJECTED', 'PANEL_MESSAGE_REJECTED',
  'PANEL_CONTEXT_REJECTED', 'PANEL_CONTEXT_UNAVAILABLE', 'PANEL_PERMISSION_REJECTED', 'PANEL_CONNECTION_UNAVAILABLE']);
let policyRevision = 0;
const documents = new Map();
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
    const epoch = tabEpoch(tab.id);
    let surface;
    try { surface = await bounded(chrome.tabs.sendMessage(tab.id, { kind: 'PAP_INSPECT', pageContract: PAGE_CONTRACT }, { frameId: 0 })); }
    catch { surface = { surfaceSupported: false, destination: '', attachmentsPresent: false }; }
    return {
      id: tab.id, windowId: tab.windowId, tabEpoch: epoch, url: tab.url ?? '', active: tab.active === true,
      destination: typeof surface?.destination === 'string' ? surface.destination : '', surfaceSupported: !tab.incognito && surface?.surfaceSupported === true,
      attachmentsPresent: surface?.attachmentsPresent === true,
    };
  }));
}

async function permissionState() {
  const granted = await bounded(chrome.permissions.contains({ permissions: ['nativeMessaging', 'sidePanel'], origins: ['https://chatgpt.com/*'] }));
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
    permissions: ['nativeMessaging', 'sidePanel'], hostPermission: 'https://chatgpt.com/*',
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
    panelDiagnosticsReady: false, panelDiagnostics: new Set() };
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
      clearTimeout(context.handshakeTimer); reconnectDelay = 1000; publishState(); return;
    }
    if (context.ready && message?.kind === 'PAP_CAPTURE_POLICY') {
      if (message.profile !== CAPTURE_PROFILE || !Array.isArray(message.policies) || message.policies.length > 32
          || !Array.isArray(message.states) || message.states.length > 32) return retire(context);
      context.policies = new Map(message.policies.map(policy => [policy.tabId, policy]));
      context.states = new Map(message.states.map(value => [value.tabId, value.state]));
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
    captureMessage(message, sender).then(respond).catch(() => respond({ state: 'RECORDING_UNAVAILABLE' })); return true;
  }
  if (message?.kind !== 'PAP_SURFACE_CHANGED' || Object.keys(message).length !== 1
      || sender.id !== chrome.runtime.id || sender.frameId !== 0 || !Number.isSafeInteger(sender.tab?.id)) return;
  try {
    if (new URL(sender.url).origin !== 'https://chatgpt.com') return;
    publishState();
  } catch {}
});

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
chrome.permissions.onRemoved.addListener(() => publishState());
chrome.tabs.onActivated.addListener(() => publishState());
chrome.tabs.onCreated.addListener(() => publishState());
chrome.tabs.onRemoved.addListener(id => { tabEpochs.delete(id); documents.delete(id); publishState(); });
chrome.tabs.onUpdated.addListener((id, change) => {
  if (change.url || change.status === 'loading') {
    if (tabEpochs.has(id)) tabEpochs.set(id, crypto.randomUUID());
    documents.delete(id);
    // Publish navigation immediately without revoking unrelated tab authority.
    publishState();
  } else if (change.status === 'complete') publishState();
});

function captureStatus(context, tabId, unavailable = false) {
  const policy = !unavailable && current(context) && context.ready ? context.policies.get(tabId) : null;
  return { kind: 'PAP_CAPTURE_POLICY', pageContract: PAGE_CONTRACT, browserSessionId, revision: policyRevision,
    state: unavailable || !current(context) ? 'RECORDING_UNAVAILABLE' : context.states.get(tabId) ?? 'OFF',
    policy: policy && policy.tabEpoch === tabEpochs.get(tabId) ? policy : null };
}

function broadcastCapturePolicy(context, unavailable = false) {
  policyRevision++;
  for (const [id, documentId] of documents) {
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
  const epoch = tabEpoch(sender.tab.id);
  const [tabs, permission] = await Promise.all([bounded(chrome.tabs.query({ url: 'https://chatgpt.com/*' })), permissionState()]);
  const tab = tabs.find(value => value.id === sender.tab.id);
  if (!current(context) || epoch !== tabEpochs.get(sender.tab.id) || permission !== 'granted'
      || tabs.length > 32 || !tab || tab.url !== sender.url || tab.windowId !== sender.tab.windowId) return { state: 'RECORDING_UNAVAILABLE' };
  if (message.kind === 'PAP_CAPTURE_STATUS') {
    if (Object.keys(message).sort().join(',') !== 'kind,pageContract') return { state: 'RECORDING_UNAVAILABLE' };
    documents.set(tab.id, sender.documentId);
    return captureStatus(context, tab.id);
  }
  const policy = context.policies.get(tab.id), kind = message.observationKind;
  if (!policy || policy.token !== message.token || policy.tabEpoch !== epoch || policy.windowId !== tab.windowId
      || policy.expectedUrl !== sender.url || policy.runtimeEpoch !== context.epoch
      || policy.browserSessionId !== browserSessionId || documents.get(tab.id) !== sender.documentId
      || context.captures.size >= 32 || !['send-intent', 'message-observed'].includes(kind)
      || Object.keys(message).sort().join(',') !== ['kind', 'pageContract', 'token', 'eventId', 'observationKind', 'text',
        kind === 'send-intent' ? 'inputMethod' : 'messageId'].sort().join(',')
      || typeof message.text !== 'string' || message.text.length > 256 * 1024 || !message.text.isWellFormed()
      || new TextEncoder().encode(message.text).length > 256 * 1024) return { state: 'RECORDING_UNAVAILABLE' };
  const requestId = crypto.randomUUID();
  const result = new Promise(resolve => context.captures.set(requestId, { resolve }));
  const { token, scope, runtimeEpoch, browserSessionId: session, tabId, windowId, tabEpoch: documentEpoch, destination } = policy;
  const observation = { profile: CAPTURE_PROFILE, kind, token, eventId: message.eventId,
    source: { adapterProfile: ADAPTER_PROFILE, pageContract: PAGE_CONTRACT, scope, runtimeEpoch,
      browserSessionId: session, tabId, windowId, tabEpoch: documentEpoch, destination, documentId: sender.documentId },
    textBytes: btoa(Array.from(new TextEncoder().encode(message.text), byte => String.fromCharCode(byte)).join('')),
    ...(kind === 'send-intent' ? { inputMethod: message.inputMethod } : { messageId: message.messageId }) };
  try {
    post(context, { kind: 'PAP_CAPTURE', requestId, observation });
    return await bounded(result);
  } finally { context.captures.delete(requestId); }
}
connect();
