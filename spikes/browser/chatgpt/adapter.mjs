import { randomUUID } from 'node:crypto';
import { emit } from '../../diagnostics/local.mjs';
import { CHATGPT_CAPTURE_PROFILE } from './capture.mjs';
import { CHATGPT_PANEL_PROFILE } from './panel.mjs';

export const CHATGPT_ADAPTER_PROFILE = 'pap-chatgpt-chrome/6';
export const CHATGPT_PAGE_CONTRACT = 'chatgpt-web-text/2026-09-15';
export const CHATGPT_ADAPTER_ID = 'chrome-chatgpt';
export const CHATGPT_ORIGIN = 'https://chatgpt.com';
export const CHATGPT_EXTENSION_ID = 'medilhopfckldjgdnchfkpmfmfnkadca';
export const CHROME_BASELINE_MAJOR = 153;

// A provider render can momentarily hide, disable or duplicate the composer
// controls while a tab keeps its exact identity. Eligibility is retained for
// this bounded window so an already-observed genuine Send is not discarded
// mid-render; a sustained loss of support still reports unavailable afterwards.
const SURFACE_CHURN_MS = 2_000;
export { SURFACE_CHURN_MS };

const requiredPermissions = ['nativeMessaging'];

function fail(message) {
  const error = Error(`UNSUPPORTED_PATH: ${message}`);
  error.code = 'UNSUPPORTED_PATH';
  throw error;
}

function supportedURL(value) {
  try {
    const url = new URL(value);
    return url.origin === CHATGPT_ORIGIN && (url.pathname === '/' || /^\/c\/[A-Za-z0-9_-]+\/?$/.test(url.pathname));
  } catch { return false; }
}

function chatGPTURL(value) {
  try { return new URL(value).origin === CHATGPT_ORIGIN; }
  catch { return false; }
}

function macOSSupported(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+(?:\.\d+)?$/.test(version)) return false;
  const [major, minor] = version.split('.').map(Number);
  return major > 15 || (major === 15 && minor >= 7);
}

export class ChatGPTChromeAdapter {
  #extensionId; #runtimeEpoch; #connection = null; #tabs = [];
  #sources = new Map(); #generation = 0; #listeners = new Set();
  #diagnostics; #churnTimer; #churnHeld = new Map();

  constructor({ extensionId, diagnostics = null, runtimeEpoch = randomUUID() }) {
    if (typeof extensionId !== 'string' || !/^[a-p]{32}$/.test(extensionId)
        || typeof runtimeEpoch !== 'string' || runtimeEpoch.length < 1 || runtimeEpoch.length > 128) {
      throw Error('Invalid ChatGPT adapter construction');
    }
    this.#extensionId = extensionId;
    this.#diagnostics = diagnostics;
    this.#runtimeEpoch = runtimeEpoch;
  }

  get capabilities() {
    return Object.freeze({
      adapter: CHATGPT_ADAPTER_PROFILE,
      boundary: 'provider_dom',
      provider: CHATGPT_ORIGIN,
      payload: 'exact UTF-8 text up to 256 KiB',
      attachments: 'UNSUPPORTED',
      providerReceipt: 'UNKNOWN',
      filesystemAPI: false,
      signerAPI: false,
      observation: this.#connection?.captureProfile === CHATGPT_CAPTURE_PROFILE,
      captureProfile: CHATGPT_CAPTURE_PROFILE,
      privilegedPanel: this.#connection?.panelProfile === CHATGPT_PANEL_PROFILE,
    });
  }

  pair(connection) {
    const invalid = !connection || connection.extensionId !== this.#extensionId
        || connection.adapterProfile !== CHATGPT_ADAPTER_PROFILE
        || Object.hasOwn(connection, 'releaseProtocol')
        || connection.captureProfile !== CHATGPT_CAPTURE_PROFILE
        || connection.pageContract !== CHATGPT_PAGE_CONTRACT
        || connection.browser?.product !== 'Google Chrome'
        || connection.browser.channel !== 'stable'
        || connection.browser.major !== CHROME_BASELINE_MAJOR
        || connection.platform?.product !== 'macOS'
        || connection.platform.arch !== 'arm64'
        || !macOSSupported(connection.platform.version)
        || connection.permissionState !== 'granted'
        || !Array.isArray(connection.permissions)
        || connection.panelProfile !== undefined && connection.panelProfile !== CHATGPT_PANEL_PROFILE
        || connection.permissions.slice().sort().join(',') !== [...requiredPermissions,
          ...(connection.panelProfile === CHATGPT_PANEL_PROFILE ? ['sidePanel'] : [])].sort().join(',')
        || connection.hostPermission !== `${CHATGPT_ORIGIN}/*`
        || typeof connection.browserSessionId !== 'string' || connection.browserSessionId.length < 16
        || connection.browserSessionId.length > 128;
    if (invalid) {
      emit(this.#diagnostics, 'ADAPTER_REJECTED');
      this.#connection = null; this.#invalidate('adapter pairing rejected');
      fail('adapter identity, platform, version, or permission mismatch');
    }
    if (this.#connection && this.#connection.browserSessionId !== connection.browserSessionId) {
      this.#invalidate('browser restart');
    }
    this.#connection = structuredClone(connection);
    return { runtimeEpoch: this.#runtimeEpoch, capabilities: this.capabilities };
  }

  synchronize({ browserSessionId, permissionState, adapterProfile, captureProfile, pageContract, tabs, releaseProtocol }) {
    if (!this.#connection || browserSessionId !== this.#connection.browserSessionId) {
      this.disconnect(); fail('browser session changed');
    }
    if (permissionState !== 'granted') { this.disconnect(); fail('Chrome permission lost'); }
    if (releaseProtocol !== undefined || adapterProfile !== CHATGPT_ADAPTER_PROFILE || captureProfile !== CHATGPT_CAPTURE_PROFILE
        || pageContract !== CHATGPT_PAGE_CONTRACT) {
      this.disconnect(); fail('adapter or provider contract mismatch');
    }
    if (!Array.isArray(tabs) || tabs.length > 32) { this.disconnect(); fail('invalid tab inventory'); }
    let nextTabs;
    try {
      nextTabs = tabs.map(tab => {
        if (!tab || !Number.isSafeInteger(tab.id) || tab.id < 0 || typeof tab.url !== 'string' || tab.url.length > 2048
            || !Number.isSafeInteger(tab.windowId) || tab.windowId < 0
            || typeof tab.tabEpoch !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(tab.tabEpoch)
            || typeof tab.active !== 'boolean' || typeof tab.destination !== 'string' || tab.destination.length > 256
            || typeof tab.surfaceSupported !== 'boolean'
            || typeof tab.attachmentsPresent !== 'boolean') fail('invalid tab state');
        return structuredClone(tab);
      });
    } catch (error) { this.disconnect(); throw error; }
    if (new Set(nextTabs.map(tab => tab.id)).size !== nextTabs.length) {
      this.disconnect(); fail('duplicate tab identity');
    }
    const previous = new Map([...this.#sources.keys()].map(scope => [scope, this.eligibility(scope)]));
    this.#tabs = nextTabs;
    for (const followed of this.#sources.values()) {
      const tab = nextTabs.find(value => value.id === followed.tabId);
      // A missing observation is not a new destination. Chrome's tab identity
      // and URL still bind the scope while a content script is unavailable.
      if (!tab || tab.url !== followed.url || !supportedURL(tab.url)
          || tab.windowId !== followed.windowId || tab.tabEpoch !== followed.tabEpoch
          || tab.destination !== followed.destination && (tab.destination !== '' || tab.surfaceSupported)) {
        emit(this.#diagnostics, 'SCOPE_DESTINATION_CHANGED'); this.#sources.delete(followed.scope);
      } else {
        if (this.#strictlyObservable(followed)) followed.eligibleAt = performance.now();
        const next = this.eligibility(followed.scope);
        if (next !== previous.get(followed.scope)) emit(this.#diagnostics, next === 'ELIGIBLE' ? 'CAPABILITY_RESTORED' : 'CAPABILITY_UNAVAILABLE');
      }
    }
    for (const tab of this.#observableTabs()) {
      if (![...this.#sources.values()].some(source => source.tabId === tab.id)) this.#follow(tab);
    }
    const chatGPTTabs = this.#chatGPTTabs();
    this.#syncChurnExpiry();
    this.#changed();
    return { eligible: this.#observableTabs().length > 0,
      tabCount: chatGPTTabs.length,
      scopes: this.scopes() };
  }

  onChange(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  #changed() { for (const listener of this.#listeners) listener(); }
  scopes() {
    // eligibleAt is internal churn bookkeeping, not part of a scope identity.
    return [...this.#sources.values()].map(({ eligibleAt, ...value }) => ({ ...structuredClone(value),
      adapterId: CHATGPT_ADAPTER_ID, adapterEpoch: value.browserSessionId, eligibility: this.eligibility(value.scope) }));
  }

  #chatGPTTabs() { return this.#tabs.filter(tab => chatGPTURL(tab.url)); }
  #expectedDestination(url) {
    const pathname = new URL(url).pathname;
    return pathname === '/' ? 'new-chat' : `conversation:${pathname.split('/')[2]}`;
  }
  #observableTabs() {
    return this.capabilities.observation ? this.#chatGPTTabs().filter(tab => supportedURL(tab.url)
      && tab.surfaceSupported && !tab.attachmentsPresent
      && tab.destination === this.#expectedDestination(tab.url)) : [];
  }
  #invalidate(reason) {
    emit(this.#diagnostics, 'SCOPE_INVALIDATED');
    clearTimeout(this.#churnTimer); this.#churnTimer = undefined; this.#churnHeld.clear();
    this.#generation++; this.#sources.clear(); this.#changed();
    return reason;
  }
  invalidate(reason = 'scope invalidated') { this.#invalidate(reason); }
  disconnect() {
    this.#connection = null; this.#tabs = []; this.#invalidate('native bridge disconnected');
  }
  restart() {
    this.#runtimeEpoch = randomUUID(); this.disconnect();
  }

  #follow(tab) {
    const scope = randomUUID();
    this.#sources.set(scope, { scope, tabId: tab.id, destination: tab.destination, url: tab.url,
      windowId: tab.windowId, tabEpoch: tab.tabEpoch, browserSessionId: this.#connection.browserSessionId,
      runtimeEpoch: this.#runtimeEpoch, generation: this.#generation, eligibleAt: performance.now() });
    emit(this.#diagnostics, 'SOURCE_FOLLOWED');
  }

  eligibility(scope) { return this.observationEligible(scope) ? 'ELIGIBLE' : 'TEMPORARILY_UNAVAILABLE'; }

  observationEligible(scope) {
    const followed = this.#sources.get(scope);
    if (!followed || !this.#connection) return false;
    return this.#strictlyObservable(followed) || this.#churnWindowOpen(followed);
  }

  #strictlyObservable(followed) {
    return this.#observableTabs().some(tab => tab.id === followed.tabId && tab.windowId === followed.windowId
      && tab.tabEpoch === followed.tabEpoch && tab.url === followed.url
      && tab.destination === followed.destination);
  }

  // A provider render can momentarily hide, disable or duplicate its composer
  // controls while the tab keeps the same document. Only that single capability
  // bit is tolerated, and only inside a bounded window, so an already-observed
  // genuine Send is not discarded mid-render. Every other condition - identity,
  // destination, attachments and a sustained loss of support - still ends
  // eligibility immediately or on expiry.
  #churnWindowOpen(followed) {
    if (!this.capabilities.observation || performance.now() - (followed.eligibleAt ?? 0) >= SURFACE_CHURN_MS) return false;
    const tab = this.#tabs.find(value => value.id === followed.tabId);
    if (!tab || tab.surfaceSupported || tab.attachmentsPresent || !supportedURL(tab.url)
        || tab.url !== followed.url || tab.windowId !== followed.windowId || tab.tabEpoch !== followed.tabEpoch
        || tab.destination !== followed.destination) return false;
    return tab.destination === this.#expectedDestination(tab.url);
  }

  // Eligibility is otherwise only recomputed on a provider or tab event, so a
  // tab that stays unsupported would keep the churn window's published policy
  // and READY status indefinitely. Each held scope keeps its own deadline and
  // the earliest one is armed, so tabs that entered churn at different times
  // close one by one without waiting for another provider event.
  #syncChurnExpiry() {
    clearTimeout(this.#churnTimer); this.#churnTimer = undefined; this.#churnHeld.clear();
    for (const followed of this.#sources.values()) {
      if (this.#strictlyObservable(followed) || !this.#churnWindowOpen(followed)) continue;
      this.#churnHeld.set(followed.scope, (followed.eligibleAt ?? 0) + SURFACE_CHURN_MS);
    }
    this.#armChurnExpiry();
  }

  #armChurnExpiry() {
    clearTimeout(this.#churnTimer); this.#churnTimer = undefined;
    if (!this.#churnHeld.size) return;
    const deadline = Math.min(...this.#churnHeld.values());
    this.#churnTimer = setTimeout(() => this.#expireChurn(), Math.max(0, deadline - performance.now()));
    this.#churnTimer?.unref?.();
  }

  #expireChurn() {
    this.#churnTimer = undefined;
    const now = performance.now();
    let expired = false;
    for (const [scope, deadline] of [...this.#churnHeld]) {
      if (deadline > now) continue;
      this.#churnHeld.delete(scope);
      if (!this.#sources.has(scope) || this.observationEligible(scope)) continue;
      emit(this.#diagnostics, 'CAPABILITY_UNAVAILABLE'); expired = true;
    }
    // Scopes whose window is still open stay held and keep their own deadline.
    this.#armChurnExpiry();
    if (expired) this.#changed();
  }

  assertObservationSource(source) {
    const followed = this.#sources.get(source.scope);
    if (!this.observationEligible(source.scope) || source.runtimeEpoch !== this.#runtimeEpoch
        || source.browserSessionId !== followed.browserSessionId || source.tabId !== followed.tabId
        || source.windowId !== followed.windowId || source.tabEpoch !== followed.tabEpoch
        || source.destination !== followed.destination) fail('capture source changed');
  }

  newChatContinuation(source) {
    return source.destination === 'new-chat' && source.url === `${CHATGPT_ORIGIN}/`
      && source.runtimeEpoch === this.#runtimeEpoch && source.generation === this.#generation
      && this.scopes().some(next => next.tabId === source.tabId && next.windowId === source.windowId
        && next.browserSessionId === source.browserSessionId && next.tabEpoch === source.tabEpoch
        && next.destination.startsWith('conversation:') && this.observationEligible(next.scope));
  }

}
