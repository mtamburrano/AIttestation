const ADAPTER_PROFILE = 'pap-chatgpt-chrome/5';
const RELEASE_PROTOCOL = 'pap-chatgpt-release/2';
const PAGE_CONTRACT = 'chatgpt-web-text/2026-09-14';
const NATIVE_HOST = 'ai.provenance.consumer';
const browserSessionId = `${crypto.randomUUID()}-${crypto.randomUUID()}`;
let connection;
let reconnectDelay = 1000, reconnectTimer;
const tabEpochs = new Map();
function tabEpoch(id) {
  if (!tabEpochs.has(id)) tabEpochs.set(id, crypto.randomUUID());
  return tabEpochs.get(id);
}
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
  if (tabs.length > 32) throw Error('TAB_LIMIT');
  for (const id of tabEpochs.keys()) if (!tabs.some(tab => tab.id === id)) tabEpochs.delete(id);
  return Promise.all(tabs.map(async tab => {
    const epoch = tabEpoch(tab.id);
    let surface;
    try { surface = await bounded(chrome.tabs.sendMessage(tab.id, { kind: 'PAP_INSPECT', pageContract: PAGE_CONTRACT }, { frameId: 0 })); }
    catch { surface = { surfaceSupported: false, destination: '', composerEmpty: false, attachmentsPresent: false }; }
    return {
      id: tab.id, windowId: tab.windowId, tabEpoch: epoch, url: tab.url ?? '', active: tab.active === true,
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
    windowId: message.windowId, tabEpoch: message.tabEpoch,
    expectedUrl: message.expectedUrl, destination: message.destination,
    attemptId: message.attemptId, payloadDigest: message.payloadDigest,
    textDigest: message.textDigest, exposure, submitted,
    ...(observation ? { observation } : {}),
  };
}

async function handleRelease(message, context) {
  if (!current(context) || !context.ready || message.profile !== RELEASE_PROTOCOL || message.browserSessionId !== browserSessionId
      || message.runtimeEpoch !== context.epoch || typeof message.scope !== 'string'
      || !Number.isSafeInteger(message.tabId) || !Number.isSafeInteger(message.windowId)
      || message.tabEpoch !== tabEpoch(message.tabId) || typeof message.expectedUrl !== 'string'
      || typeof message.destination !== 'string' || typeof message.attemptId !== 'string'
      || !message.attemptId.length || message.attemptId.length > 128
      || !/^[a-f0-9]{64}$/.test(message.payloadDigest ?? '')
      || !/^[a-f0-9]{64}$/.test(message.textDigest ?? '') || typeof message.textBytes !== 'string'
      || context.attempts.has(message.attemptId) || context.attempts.size >= 4096) {
    return releaseResponse(message, context.attempts.has(message.attemptId) ? 'UNKNOWN' : 'NONE', false);
  }
  context.attempts.add(message.attemptId);
  const revision = context.authorityRevision;
  if (await permissionState() !== 'granted') return releaseResponse(message, 'NONE', false);
  const tabs = await inspectTabs();
  const tab = tabs.find(value => value.id === message.tabId);
  if (!current(context) || context.authorityRevision !== revision || !tab || !tab.active
      || tab.windowId !== message.windowId || tab.tabEpoch !== message.tabEpoch
      || tabEpoch(message.tabId) !== message.tabEpoch
      || !tab.surfaceSupported || !tab.composerEmpty || tab.attachmentsPresent) {
    return releaseResponse(message, 'NONE', false);
  }
  if (tab.url !== message.expectedUrl || tab.destination !== message.destination) {
    return releaseResponse(message, 'NONE', false);
  }
  const release = { message, revision: context.authorityRevision, expires: performance.now() + 2000,
    phase: 'inject', documentId: null, check: null };
  context.releases.set(message.attemptId, release);
  try {
    const result = await bounded(chrome.tabs.sendMessage(message.tabId, {
      ...message, kind: 'PAP_RELEASE', pageContract: PAGE_CONTRACT,
    }, { frameId: 0 }));
    if (result?.attemptId !== message.attemptId || result.textDigest !== message.textDigest) {
      return releaseResponse(message, 'UNKNOWN', false);
    }
    if (result?.exposure === 'NONE' && result.submitted === false) return releaseResponse(message, 'NONE', false);
    if (result?.exposure === 'DOM_INJECTED' && result.submitted === true
        && result.observation === 'LOCAL_CLICK_DISPATCHED' && release.phase === 'finished') {
      return releaseResponse(message, 'DOM_INJECTED', true, 'LOCAL_CLICK_DISPATCHED');
    }
    return releaseResponse(message, 'UNKNOWN', false);
  } catch {
    // Once a content-script request is sent, loss of the reply cannot establish
    // whether the page saw the bytes.
    return releaseResponse(message, 'UNKNOWN', false);
  } finally {
    context.releases.delete(message.attemptId); release.check?.resolve(false);
  }
}

function active(context, release) {
  return current(context) && context.ready && context.releases.get(release.message.attemptId) === release
    && context.authorityRevision === release.revision && tabEpochs.get(release.message.tabId) === release.message.tabEpoch
    && performance.now() < release.expires;
}

async function checkRelease(message, sender, context) {
  const release = context?.releases.get(message.attemptId);
  if (!release || !active(context, release) || message.pageContract !== PAGE_CONTRACT
      || Object.keys(message).sort().join(',') !== 'attemptId,kind,pageContract,phase'
      || message.phase !== release.phase || !['inject', 'click'].includes(message.phase)
      || sender.id !== chrome.runtime.id || sender.frameId !== 0 || sender.tab?.id !== release.message.tabId
      || sender.url !== release.message.expectedUrl || sender.origin !== 'https://chatgpt.com'
      || typeof sender.documentId !== 'string' || !sender.documentId.length || sender.documentId.length > 128
      || release.documentId && release.documentId !== sender.documentId) return false;
  release.documentId = sender.documentId; release.phase = 'checking';
  try {
    if (await permissionState() !== 'granted') return false;
    const tabs = await bounded(chrome.tabs.query({ url: 'https://chatgpt.com/*' }));
    const tab = tabs.find(value => value.id === release.message.tabId);
    if (!active(context, release) || !tab || tab.active !== true || tab.url !== release.message.expectedUrl
        || tab.windowId !== release.message.windowId || tabEpoch(tab.id) !== release.message.tabEpoch) return false;
    const checkId = crypto.randomUUID();
    const answer = new Promise(resolve => { release.check = { checkId, resolve }; });
    post(context, { kind: 'PAP_CHECK_RELEASE', attemptId: message.attemptId, checkId, phase: message.phase });
    if (!await bounded(answer) || !active(context, release)) return false;
    release.phase = message.phase === 'inject' ? 'click' : 'finished';
    return true;
  } catch { return false; }
  finally { release.check = null; }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = undefined; connect(); }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
}

function retire(context) {
  if (!current(context)) return;
  context.closed = true; clearTimeout(context.handshakeTimer); connection = undefined;
  for (const release of context.releases.values()) release.check?.resolve(false);
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
  if (urgent) context.authorityRevision++;
  context.revision++; context.dirty = true; context.urgent ||= urgent; publish(context);
}

function connect() {
  if (connection) return;
  let port;
  try { port = chrome.runtime.connectNative(NATIVE_HOST); }
  catch { scheduleReconnect(); return; }
  const context = { port, closed: false, ready: false, epoch: null, revision: 0, dirty: false,
    activeReleases: 0, publishing: false, urgent: false, attempts: new Set(), releases: new Map(), authorityRevision: 0 };
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
    if (context.ready && message?.kind === 'PAP_RELEASE_CHECKED') {
      const check = context.releases.get(message.attemptId)?.check;
      if (check?.checkId === message.checkId) check.resolve(message.authorized === true);
      return;
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

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.kind === 'PAP_CHECK_RELEASE') {
    checkRelease(message, sender, connection).then(respond).catch(() => respond(false)); return true;
  }
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
chrome.tabs.onActivated.addListener(() => publishState());
chrome.tabs.onCreated.addListener(() => publishState());
chrome.tabs.onRemoved.addListener(id => { tabEpochs.delete(id); publishState(); });
chrome.tabs.onUpdated.addListener((id, change) => {
  if (change.url || change.status === 'loading') {
    if (tabEpochs.has(id)) tabEpochs.set(id, crypto.randomUUID());
    for (const release of connection?.releases.values() ?? []) {
      if (release.message.tabId === id) release.check?.resolve(false);
    }
    // Publish navigation immediately without revoking unrelated tab authority.
    if (connection) connection.urgent = true;
    publishState();
  } else if (change.status === 'complete') publishState();
});
connect();
