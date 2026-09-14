import { createHash, randomUUID } from 'node:crypto';
import { validateProtectedTextPayload } from '../../release/runtime.mjs';
import { emit } from '../../release/diagnostics.mjs';

export const CHATGPT_ADAPTER_PROFILE = 'pap-chatgpt-chrome/4';
export const CHATGPT_PAGE_CONTRACT = 'chatgpt-web-text/2026-09-14';
export const CHATGPT_RELEASE_PROTOCOL = 'pap-chatgpt-release/1';
export const CHATGPT_ORIGIN = 'https://chatgpt.com';
export const CHATGPT_EXTENSION_ID = 'medilhopfckldjgdnchfkpmfmfnkadca';
export const CHROME_BASELINE_MAJOR = 153;

const requiredPermissions = ['nativeMessaging'];
const textDigest = text => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

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
  #send; #extensionId; #runtimeEpoch; #connection = null; #tabs = [];
  #enrollment = null; #generation = 0; #attempts = new Set();
  #diagnostics;
  #dispatchChecks = new Map();

  constructor(send, { extensionId, diagnostics = null, runtimeEpoch = randomUUID() }) {
    if (typeof send !== 'function' || typeof extensionId !== 'string' || !/^[a-p]{32}$/.test(extensionId)
        || typeof runtimeEpoch !== 'string' || runtimeEpoch.length < 1 || runtimeEpoch.length > 128) {
      throw Error('Invalid ChatGPT adapter construction');
    }
    this.#send = send; this.#extensionId = extensionId;
    this.#diagnostics = diagnostics;
    this.#runtimeEpoch = runtimeEpoch;
  }

  get capabilities() {
    return Object.freeze({
      adapter: CHATGPT_ADAPTER_PROFILE,
      releaseProtocol: CHATGPT_RELEASE_PROTOCOL,
      boundary: 'trusted_local_composer',
      provider: CHATGPT_ORIGIN,
      payload: 'exact UTF-8 text up to 256 KiB',
      attachments: 'UNSUPPORTED',
      providerReceipt: 'UNKNOWN',
      filesystemAPI: false,
      signerAPI: false,
    });
  }

  pair(connection) {
    const invalid = !connection || connection.extensionId !== this.#extensionId
        || connection.adapterProfile !== CHATGPT_ADAPTER_PROFILE
        || connection.releaseProtocol !== CHATGPT_RELEASE_PROTOCOL
        || connection.pageContract !== CHATGPT_PAGE_CONTRACT
        || connection.browser?.product !== 'Google Chrome'
        || connection.browser.channel !== 'stable'
        || connection.browser.major !== CHROME_BASELINE_MAJOR
        || connection.platform?.product !== 'macOS'
        || connection.platform.arch !== 'arm64'
        || !macOSSupported(connection.platform.version)
        || connection.permissionState !== 'granted'
        || !Array.isArray(connection.permissions)
        || connection.permissions.slice().sort().join(',') !== requiredPermissions.slice().sort().join(',')
        || connection.hostPermission !== `${CHATGPT_ORIGIN}/*`
        || typeof connection.browserSessionId !== 'string' || connection.browserSessionId.length < 16;
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

  synchronize({ browserSessionId, permissionState, adapterProfile, releaseProtocol, pageContract, tabs }) {
    if (!this.#connection || browserSessionId !== this.#connection.browserSessionId) {
      this.disconnect(); fail('browser session changed');
    }
    if (permissionState !== 'granted') { this.disconnect(); fail('Chrome permission lost'); }
    if (adapterProfile !== CHATGPT_ADAPTER_PROFILE || releaseProtocol !== CHATGPT_RELEASE_PROTOCOL
        || pageContract !== CHATGPT_PAGE_CONTRACT) {
      this.disconnect(); fail('adapter or provider contract mismatch');
    }
    if (!Array.isArray(tabs) || tabs.length > 32) { this.disconnect(); fail('invalid tab inventory'); }
    let nextTabs;
    try {
      nextTabs = tabs.map(tab => {
        if (!tab || !Number.isSafeInteger(tab.id) || tab.id < 0 || typeof tab.url !== 'string'
            || typeof tab.active !== 'boolean' || typeof tab.destination !== 'string'
            || typeof tab.surfaceSupported !== 'boolean' || typeof tab.composerEmpty !== 'boolean'
            || typeof tab.attachmentsPresent !== 'boolean') fail('invalid tab state');
        return structuredClone(tab);
      });
    } catch (error) { this.disconnect(); throw error; }
    if (new Set(nextTabs.map(tab => tab.id)).size !== nextTabs.length) {
      this.disconnect(); fail('duplicate tab identity');
    }
    const previous = this.#enrollment && this.eligibility(this.#enrollment.scope);
    this.#tabs = nextTabs;
    if (this.#enrollment) {
      const enrolled = this.#enrollment, tab = nextTabs.find(value => value.id === enrolled.tabId);
      // A missing observation is not a new destination. Chrome's tab identity
      // and URL still bind the scope while a content script is unavailable.
      if (!tab || tab.url !== enrolled.url || !supportedURL(tab.url)
          || tab.destination !== enrolled.destination && (tab.destination !== '' || tab.surfaceSupported)) {
        emit(this.#diagnostics, 'SCOPE_DESTINATION_CHANGED'); this.#invalidate('destination changed');
      } else {
        const next = this.eligibility(enrolled.scope);
        if (next !== previous) emit(this.#diagnostics, next === 'ELIGIBLE' ? 'CAPABILITY_RESTORED' : 'CAPABILITY_UNAVAILABLE');
      }
    }
    const chatGPTTabs = this.#chatGPTTabs();
    return { eligible: chatGPTTabs.length === 1 && this.#eligibleTabs().length === 1,
      tabCount: chatGPTTabs.length,
      eligibility: this.#enrollment ? this.eligibility(this.#enrollment.scope) : 'UNENROLLED' };
  }

  #chatGPTTabs() { return this.#tabs.filter(tab => chatGPTURL(tab.url)); }
  #eligibleTabs() {
    return this.#chatGPTTabs().filter(tab => supportedURL(tab.url) && tab.active && tab.surfaceSupported
      && !tab.attachmentsPresent && tab.composerEmpty);
  }
  #invalidate(reason) {
    emit(this.#diagnostics, 'SCOPE_INVALIDATED');
    this.#generation++; this.#enrollment = null;
    return reason;
  }
  invalidate(reason = 'scope invalidated') { this.#invalidate(reason); }
  disconnect() {
    this.#connection = null; this.#tabs = []; this.#invalidate('native bridge disconnected');
  }
  restart() {
    this.#runtimeEpoch = randomUUID(); this.disconnect();
  }

  enroll({ tabId, destination }) {
    if (!this.#connection) fail('extension is not paired');
    const chatGPTTabs = this.#chatGPTTabs(), eligible = this.#eligibleTabs();
    if (chatGPTTabs.length !== 1 || eligible.length !== 1 || eligible[0].id !== tabId
        || eligible[0].destination !== destination) fail('one active, empty, supported ChatGPT tab is required');
    const scope = randomUUID();
    this.#enrollment = {
      scope, tabId, destination, url: eligible[0].url,
      browserSessionId: this.#connection.browserSessionId,
      runtimeEpoch: this.#runtimeEpoch, generation: this.#generation,
    };
    emit(this.#diagnostics, 'SCOPE_ENROLLED');
    return { scope, runtimeEpoch: this.#runtimeEpoch, destination, capabilities: this.capabilities };
  }

  #assertHealthy(scope) {
    const enrolled = this.#enrollment;
    if (!this.#connection || !enrolled || enrolled.scope !== scope
        || enrolled.runtimeEpoch !== this.#runtimeEpoch
        || enrolled.browserSessionId !== this.#connection.browserSessionId
        || enrolled.generation !== this.#generation) fail('scope is not enrolled in this runtime and browser session');
    const tabs = this.#chatGPTTabs(), tab = tabs.find(value => value.id === enrolled.tabId);
    if (tabs.length !== 1 || !tab || !tab.active || !tab.surfaceSupported
        || tab.attachmentsPresent || !tab.composerEmpty || tab.destination !== enrolled.destination
        || tab.url !== enrolled.url) {
      const error = Error('Provider capability is temporarily unavailable');
      error.code = 'CAPABILITY_UNAVAILABLE'; throw error;
    }
    return { enrolled, tab };
  }

  assertEligible(scope) { this.#assertHealthy(scope); return true; }
  eligibility(scope) {
    try { this.#assertHealthy(scope); return 'ELIGIBLE'; }
    catch (error) { return error.code === 'CAPABILITY_UNAVAILABLE' ? 'TEMPORARILY_UNAVAILABLE' : 'REVOKED'; }
  }

  isDispatchCurrent(attemptId) {
    try { return this.#dispatchChecks.get(attemptId)?.() === true; }
    catch { return false; }
  }

  async dispatch(attempt, isCurrent = () => true) {
    let snapshot;
    try {
      const health = this.#assertHealthy(attempt.scope);
      const payload = validateProtectedTextPayload(attempt.payload);
      if (attempt.protocol !== CHATGPT_RELEASE_PROTOCOL || typeof attempt.attemptId !== 'string'
          || !/^[a-f0-9]{64}$/.test(attempt.digest ?? '') || this.#attempts.has(attempt.attemptId)) {
        emit(this.#diagnostics, 'ADAPTER_REJECTED', { operationId: attempt.sealId, dispatchId: attempt.attemptId });
        return 'FAILED_BEFORE_EGRESS';
      }
      snapshot = {
        generation: this.#generation, tabId: health.tab.id, text: payload.text,
        expectedUrl: health.enrolled.url, destination: health.enrolled.destination,
      };
      this.#attempts.add(attempt.attemptId);
    } catch {
      emit(this.#diagnostics, 'ADAPTER_REJECTED', { operationId: attempt.sealId, dispatchId: attempt.attemptId });
      return 'FAILED_BEFORE_EGRESS';
    }
    let response;
    const command = {
      profile: CHATGPT_RELEASE_PROTOCOL, runtimeEpoch: this.#runtimeEpoch,
      browserSessionId: this.#connection.browserSessionId, scope: attempt.scope,
      tabId: snapshot.tabId, expectedUrl: snapshot.expectedUrl, destination: snapshot.destination,
      attemptId: attempt.attemptId, payloadDigest: attempt.digest,
      textDigest: textDigest(snapshot.text), textBytes: Buffer.from(snapshot.text, 'utf8').toString('base64'),
    };
    this.#dispatchChecks.set(attempt.attemptId, () => {
      const tabs = this.#chatGPTTabs(), tab = tabs[0];
      // The exact authorized insertion makes the composer nonempty. The page
      // checks its bytes; this guard retains engine, scope and draft authority.
      return this.#generation === snapshot.generation && this.#enrollment?.scope === attempt.scope
        && this.#connection?.browserSessionId === command.browserSessionId && tabs.length === 1
        && tab.id === snapshot.tabId && tab.url === snapshot.expectedUrl && tab.destination === snapshot.destination
        && tab.active && tab.surfaceSupported && !tab.attachmentsPresent && isCurrent() === true;
    });
    try {
      emit(this.#diagnostics, 'ADAPTER_DISPATCH', { operationId: attempt.sealId, dispatchId: attempt.attemptId });
      response = await this.#send(command, { operationId: attempt.sealId });
    } catch (error) {
      return error?.exposure === 'NONE' ? 'FAILED_BEFORE_EGRESS' : 'OUTCOME_UNKNOWN';
    } finally { this.#dispatchChecks.delete(attempt.attemptId); }
    if (!response || response.profile !== command.profile || response.runtimeEpoch !== command.runtimeEpoch
        || response.browserSessionId !== command.browserSessionId || response.scope !== command.scope
        || response.tabId !== command.tabId || response.expectedUrl !== command.expectedUrl
        || response.destination !== command.destination || response.attemptId !== command.attemptId
        || response.payloadDigest !== command.payloadDigest || response.textDigest !== command.textDigest) {
      return 'OUTCOME_UNKNOWN';
    }
    if (this.#generation !== snapshot.generation) {
      return response.exposure === 'NONE' ? 'FAILED_BEFORE_EGRESS' : 'OUTCOME_UNKNOWN';
    }
    if (response.exposure === 'NONE' && response.submitted === false) return 'FAILED_BEFORE_EGRESS';
    if (response.exposure === 'DOM_INJECTED' && response.submitted === true
        && response.observation === 'LOCAL_CLICK_DISPATCHED') return 'SUBMISSION_OBSERVED';
    return 'OUTCOME_UNKNOWN';
  }
}
