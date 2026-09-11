const ADAPTER_PROFILE = 'pap-chatgpt-chrome/2';
const RELEASE_PROTOCOL = 'pap-chatgpt-release/1';
const PAGE_CONTRACT = 'chatgpt-web-text/2026-09-10';
const NATIVE_HOST = 'ai.provenance.consumer';
const browserSessionId = `${crypto.randomUUID()}-${crypto.randomUUID()}`;
let nativePort;
let reconnectDelay = 1000, reconnectTimer;
let activeReleases = 0, deferredSurface = false;

async function inspectTabs() {
  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  return Promise.all(tabs.map(async tab => {
    let surface;
    try { surface = await chrome.tabs.sendMessage(tab.id, { kind: 'PAP_INSPECT', pageContract: PAGE_CONTRACT }); }
    catch { surface = { surfaceSupported: false, destination: '', composerEmpty: false, attachmentsPresent: false }; }
    return {
      id: tab.id, url: tab.url ?? '', active: tab.active === true,
      destination: surface.destination, surfaceSupported: surface.surfaceSupported === true,
      composerEmpty: surface.composerEmpty === true, attachmentsPresent: surface.attachmentsPresent === true,
    };
  }));
}

async function permissionState() {
  const granted = await chrome.permissions.contains({ permissions: ['nativeMessaging'], origins: ['https://chatgpt.com/*'] });
  return granted ? 'granted' : 'revoked';
}

async function stateMessage(kind) {
  const platform = await chrome.runtime.getPlatformInfo();
  let highEntropy = null;
  try { highEntropy = await navigator.userAgentData?.getHighEntropyValues?.(['platformVersion']) ?? null; }
  catch {}
  return {
    kind, extensionId: chrome.runtime.id, adapterProfile: ADAPTER_PROFILE,
    releaseProtocol: RELEASE_PROTOCOL, pageContract: PAGE_CONTRACT, browserSessionId,
    // JavaScript brand strings cannot establish the installed product/channel.
    // The signed native host replaces this fail-closed value with locally
    // verified Chrome Stable identity before adapter pairing.
    browser: { product: 'UNVERIFIED', channel: 'UNVERIFIED', major: 0 },
    platform: { product: platform.os === 'mac' ? 'macOS' : platform.os, arch: platform.arch, version: highEntropy?.platformVersion ?? '' },
    permissions: ['nativeMessaging'], hostPermission: 'https://chatgpt.com/*',
    permissionState: await permissionState(), tabs: await inspectTabs(),
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

async function handleRelease(message) {
  if (message.profile !== RELEASE_PROTOCOL || message.browserSessionId !== browserSessionId
      || typeof message.runtimeEpoch !== 'string' || typeof message.scope !== 'string'
      || !Number.isSafeInteger(message.tabId) || typeof message.expectedUrl !== 'string'
      || typeof message.destination !== 'string' || typeof message.attemptId !== 'string'
      || !/^[a-f0-9]{64}$/.test(message.payloadDigest ?? '')
      || !/^[a-f0-9]{64}$/.test(message.textDigest ?? '') || typeof message.textBytes !== 'string') {
    return releaseResponse(message, 'NONE', false);
  }
  const tabs = await inspectTabs();
  if (tabs.length !== 1 || tabs[0].id !== message.tabId || !tabs[0].active
      || !tabs[0].surfaceSupported || !tabs[0].composerEmpty || tabs[0].attachmentsPresent) {
    return releaseResponse(message, 'NONE', false);
  }
  if (tabs[0].url !== message.expectedUrl || tabs[0].destination !== message.destination) {
    return releaseResponse(message, 'NONE', false);
  }
  try {
    const result = await chrome.tabs.sendMessage(message.tabId, {
      ...message, kind: 'PAP_RELEASE', pageContract: PAGE_CONTRACT,
    });
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

function connect() {
  if (nativePort) return;
  nativePort = chrome.runtime.connectNative(NATIVE_HOST);
  nativePort.onMessage.addListener(message => {
    reconnectDelay = 1000;
    if (message.kind === 'PAP_RELEASE') activeReleases++;
    Promise.resolve(message.kind === 'PAP_RELEASE' ? handleRelease(message) : stateMessage('PAP_STATE'))
      .then(value => nativePort?.postMessage(value))
      .catch(() => nativePort?.postMessage({ kind: 'PAP_ADAPTER_ERROR', browserSessionId }))
      .finally(() => {
        if (message.kind === 'PAP_RELEASE') activeReleases--;
        if (activeReleases === 0 && deferredSurface) { deferredSurface = false; publishState(); }
      });
  });
  nativePort.onDisconnect.addListener(() => {
    nativePort = undefined; clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, reconnectDelay); reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
  });
  stateMessage('PAP_HELLO').then(value => nativePort?.postMessage(value));
}

const publishState = () => stateMessage('PAP_STATE').then(value => nativePort?.postMessage(value)).catch(() => {});
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.kind !== 'PAP_SURFACE_CHANGED' || Object.keys(message).length !== 1
      || sender.id !== chrome.runtime.id || sender.frameId !== 0 || !Number.isSafeInteger(sender.tab?.id)) return;
  try {
    if (new URL(sender.url).origin !== 'https://chatgpt.com') return;
    // Report self-induced composer changes after the correlated dispatch reply;
    // navigation and permission changes still invalidate immediately.
    if (activeReleases) deferredSurface = true; else publishState();
  } catch {}
});
chrome.permissions.onRemoved.addListener(publishState);
chrome.tabs.onActivated.addListener(publishState);
chrome.tabs.onCreated.addListener(publishState);
chrome.tabs.onRemoved.addListener(publishState);
chrome.tabs.onUpdated.addListener((_id, change) => {
  if (change.url || change.status === 'complete') publishState();
});
connect();
