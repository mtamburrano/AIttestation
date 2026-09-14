const ADAPTER_PROFILE = 'pap-chatgpt-chrome/3';
const RELEASE_PROTOCOL = 'pap-chatgpt-release/1';
const PAGE_CONTRACT = 'chatgpt-web-text/2026-09-10';
const NATIVE_HOST = 'ai.provenance.consumer';
const browserSessionId = `${crypto.randomUUID()}-${crypto.randomUUID()}`;
let connection;
let reconnectDelay = 1000, reconnectTimer;
const current = context => connection === context && !context.closed;

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('ADAPTER_REQUEST_TIMEOUT')), 2_000);
    })]);
  } finally { clearTimeout(timer); }
}

async function inspectTabs() {
  const tabs = await bounded(chrome.tabs.query({ url: 'https://chatgpt.com/*' }));
  return Promise.all(tabs.map(async tab => {
    let surface;
    try { surface = await bounded(chrome.tabs.sendMessage(tab.id, { kind: 'PAP_INSPECT', pageContract: PAGE_CONTRACT })); }
    catch { surface = { surfaceSupported: false, destination: '', composerEmpty: false, attachmentsPresent: false }; }
    return {
      id: tab.id, url: tab.url ?? '', active: tab.active === true,
      destination: typeof surface?.destination === 'string' ? surface.destination : '', surfaceSupported: surface?.surfaceSupported === true,
      composerEmpty: surface?.composerEmpty === true, attachmentsPresent: surface?.attachmentsPresent === true,
    };
  }));
}

async function permissionState() {
  const granted = await bounded(chrome.permissions.contains({ permissions: ['nativeMessaging'], origins: ['https://chatgpt.com/*'] }));
  return granted ? 'granted' : 'revoked';
}

async function stateMessage(kind) {
  const [permissions, tabs] = await Promise.all([permissionState(), inspectTabs()]);
  return {
    kind, extensionId: chrome.runtime.id, adapterProfile: ADAPTER_PROFILE,
    releaseProtocol: RELEASE_PROTOCOL, pageContract: PAGE_CONTRACT, browserSessionId,
    // JavaScript brand strings cannot establish the installed product/channel.
    // The signed native host replaces this fail-closed value with locally
    // verified Chrome Stable identity before adapter pairing.
    browser: { product: 'UNVERIFIED', channel: 'UNVERIFIED', major: 0 },
    platform: { product: 'UNVERIFIED', arch: 'UNVERIFIED', version: '' },
    permissions: ['nativeMessaging'], hostPermission: 'https://chatgpt.com/*',
    permissionState: permissions, tabs,
  };
}

function releaseResponse(message, exposure, submitted, observation) {
  return {
    profile: RELEASE_PROTOCOL, runtimeEpoch: message.runtimeEpoch,
    browserSessionId, scope: message.scope, tabId: message.tabId,
    expectedUrl: message.expectedUrl, destination: message.destination,
    attemptId: message.attemptId, payloadDigest: message.payloadDigest,
    textDigest: message.textDigest, exposure, submitted,
    ...(observation ? { observation } : {}),
  };
}

async function handleRelease(message, context) {
  if (!current(context) || !context.ready || message.profile !== RELEASE_PROTOCOL || message.browserSessionId !== browserSessionId
      || message.runtimeEpoch !== context.epoch || typeof message.scope !== 'string'
      || !Number.isSafeInteger(message.tabId) || typeof message.expectedUrl !== 'string'
      || typeof message.destination !== 'string' || typeof message.attemptId !== 'string'
      || !/^[a-f0-9]{64}$/.test(message.payloadDigest ?? '')
      || !/^[a-f0-9]{64}$/.test(message.textDigest ?? '') || typeof message.textBytes !== 'string'
      || context.attempts.has(message.attemptId) || context.attempts.size >= 4096) {
    return releaseResponse(message, 'NONE', false);
  }
  context.attempts.add(message.attemptId);
  const revision = context.revision;
  if (await permissionState() !== 'granted') return releaseResponse(message, 'NONE', false);
  const tabs = await inspectTabs();
  if (!current(context) || context.revision !== revision || tabs.length !== 1 || tabs[0].id !== message.tabId || !tabs[0].active
      || !tabs[0].surfaceSupported || !tabs[0].composerEmpty || tabs[0].attachmentsPresent) {
    return releaseResponse(message, 'NONE', false);
  }
  if (tabs[0].url !== message.expectedUrl || tabs[0].destination !== message.destination) {
    return releaseResponse(message, 'NONE', false);
  }
  try {
    const result = await bounded(chrome.tabs.sendMessage(message.tabId, {
      ...message, kind: 'PAP_RELEASE', pageContract: PAGE_CONTRACT,
    }));
    if (result?.exposure === 'NONE' && result.submitted === false) return releaseResponse(message, 'NONE', false);
    if (result?.exposure === 'DOM_INJECTED' && result.submitted === true
        && result.observation === 'LOCAL_CLICK_DISPATCHED') {
      return releaseResponse(message, 'DOM_INJECTED', true, 'LOCAL_CLICK_DISPATCHED');
    }
    return releaseResponse(message, 'UNKNOWN', false);
  } catch {
    // Once a content-script request is sent, loss of the reply cannot establish
    // whether the page saw the bytes.
    return releaseResponse(message, 'UNKNOWN', false);
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = undefined; connect(); }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
}

function retire(context) {
  if (!current(context)) return;
  context.closed = true; clearTimeout(context.handshakeTimer); connection = undefined;
  try { context.port.disconnect(); } catch {}
  scheduleReconnect();
}

function post(context, message) {
  if (!current(context)) return;
  try { context.port.postMessage(message); } catch { retire(context); }
}

async function publish(context) {
  if (!current(context) || !context.ready || context.publishing || context.activeReleases && !context.urgent || !context.dirty) return;
  context.publishing = true;
  try {
    while (current(context) && context.dirty && (!context.activeReleases || context.urgent)) {
      context.dirty = false; context.urgent = false;
      const revision = context.revision, message = await stateMessage('PAP_STATE');
      if (revision === context.revision) post(context, message);
    }
  } catch { retire(context); }
  finally { context.publishing = false; }
}

function publishState(urgent = false) {
  const context = connection;
  if (!context) return;
  context.revision++; context.dirty = true; context.urgent ||= urgent; publish(context);
}

function connect() {
  if (connection) return;
  let port;
  try { port = chrome.runtime.connectNative(NATIVE_HOST); }
  catch { scheduleReconnect(); return; }
  const context = { port, closed: false, ready: false, epoch: null, revision: 0, dirty: false,
    activeReleases: 0, publishing: false, urgent: false, attempts: new Set() };
  connection = context;
  context.handshakeTimer = setTimeout(() => retire(context), 10_000);
  port.onMessage.addListener(message => {
    if (!current(context)) return;
    if (message?.kind === 'PAP_READY') {
      if (context.ready || message.browserSessionId !== browserSessionId
          || typeof message.runtimeEpoch !== 'string' || !message.runtimeEpoch.length) return retire(context);
      context.ready = true; context.epoch = message.runtimeEpoch;
      clearTimeout(context.handshakeTimer); reconnectDelay = 1000; publishState(); return;
    }
    if (!context.ready || message?.kind !== 'PAP_RELEASE') return retire(context);
    context.activeReleases++;
    handleRelease(message, context)
      .then(value => post(context, value))
      .catch(() => post(context, releaseResponse(message, 'UNKNOWN', false)))
      .finally(() => { context.activeReleases--; publish(context); });
  });
  port.onDisconnect.addListener(() => {
    // Reading lastError acknowledges Chrome's fixed native-port failure. Never
    // copy arbitrary platform error text into state or diagnostics.
    void chrome.runtime.lastError;
    retire(context);
  });
  stateMessage('PAP_HELLO').then(value => post(context, value)).catch(() => retire(context));
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.kind !== 'PAP_SURFACE_CHANGED' || Object.keys(message).length !== 1
      || sender.id !== chrome.runtime.id || sender.frameId !== 0 || !Number.isSafeInteger(sender.tab?.id)) return;
  try {
    if (new URL(sender.url).origin !== 'https://chatgpt.com') return;
    // Report self-induced composer changes after the correlated dispatch reply;
    // navigation and permission changes still invalidate immediately.
    publishState();
  } catch {}
});
chrome.permissions.onRemoved.addListener(() => publishState(true));
chrome.tabs.onActivated.addListener(() => publishState(true));
chrome.tabs.onCreated.addListener(() => publishState(true));
chrome.tabs.onRemoved.addListener(() => publishState(true));
chrome.tabs.onUpdated.addListener((_id, change) => {
  if (change.url || change.status === 'complete') publishState(true);
});
connect();
