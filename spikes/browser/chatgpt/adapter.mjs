import { createHash, randomUUID } from 'node:crypto';
import { validateProtectedTextPayload } from '../../release/runtime.mjs';

export const CHATGPT_ADAPTER_PROFILE = 'pap-chatgpt-chrome/1';
export const CHATGPT_PAGE_CONTRACT = 'chatgpt-web-text/2026-09-10';
export const CHATGPT_RELEASE_PROTOCOL = 'pap-chatgpt-release/1';
export const CHATGPT_ORIGIN = 'https://chatgpt.com';
export const CHATGPT_EXTENSION_ID = 'hdnjjomhchcpcnikfabcnmlhcehbnhbc';
export const CHROME_BASELINE_MAJOR = 153;

const requiredPermissions = ['nativeMessaging', 'tabs'];
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
  #send; #extensionId; #runtimeEpoch = randomUUID(); #connection = null; #tabs = [];
  #enrollment = null; #generation = 0; #attempts = new Set();

  constructor(send, { extensionId }) {
    if (typeof send !== 'function' || typeof extensionId !== 'string' || !/^[a-p]{32}$/.test(extensionId)) {
      throw Error('Invalid ChatGPT adapter construction');
    }
    this.#send = send; this.#extensionId = extensionId;
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
      this.#invalidate('browser restart'); fail('browser session changed');
    }
    if (permissionState !== 'granted') { this.#invalidate('permission lost'); fail('Chrome permission lost'); }
    if (adapterProfile !== CHATGPT_ADAPTER_PROFILE || releaseProtocol !== CHATGPT_RELEASE_PROTOCOL
        || pageContract !== CHATGPT_PAGE_CONTRACT) {
      this.#invalidate('adapter mismatch'); fail('adapter or provider contract mismatch');
    }
    if (!Array.isArray(tabs) || tabs.length > 32) { this.#invalidate('invalid tab inventory'); fail('invalid tab inventory'); }
    this.#tabs = [];
    let nextTabs;
    try {
      nextTabs = tabs.map(tab => {
        if (!tab || !Number.isSafeInteger(tab.id) || tab.id < 0 || typeof tab.url !== 'string'
            || typeof tab.active !== 'boolean' || typeof tab.destination !== 'string'
            || typeof tab.surfaceSupported !== 'boolean' || typeof tab.composerEmpty !== 'boolean'
            || typeof tab.attachmentsPresent !== 'boolean') fail('invalid tab state');
        return structuredClone(tab);
      });
    } catch (error) { this.#invalidate('invalid tab state'); throw error; }
    this.#tabs = nextTabs;
    if (this.#enrollment) {
      try { this.#assertHealthy(this.#enrollment.scope); }
      catch (error) { this.#invalidate(error.message); throw error; }
    }
    const chatGPTTabs = this.#chatGPTTabs();
    return { eligible: chatGPTTabs.length === 1 && this.#eligibleTabs().length === 1,
      tabCount: chatGPTTabs.length };
  }

  #chatGPTTabs() { return this.#tabs.filter(tab => chatGPTURL(tab.url)); }
  #eligibleTabs() {
    return this.#chatGPTTabs().filter(tab => supportedURL(tab.url) && tab.active && tab.surfaceSupported
      && !tab.attachmentsPresent && tab.composerEmpty);
  }
  #invalidate(reason) {
    this.#generation++; this.#enrollment = null; this.#tabs = [];
    return reason;
  }
  invalidate(reason = 'scope invalidated') { this.#invalidate(reason); }
  restart() {
    this.#runtimeEpoch = randomUUID(); this.#connection = null; this.#invalidate('runtime restart');
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
        || tab.url !== enrolled.url) fail('tab ambiguity, scope change, attachment state, or unsupported provider surface');
    return { enrolled, tab };
  }

  assertEligible(scope) { this.#assertHealthy(scope); return true; }

  async dispatch(attempt) {
    let snapshot;
    try {
      const health = this.#assertHealthy(attempt.scope);
      const payload = validateProtectedTextPayload(attempt.payload);
      if (attempt.protocol !== CHATGPT_RELEASE_PROTOCOL || typeof attempt.attemptId !== 'string'
          || !/^[a-f0-9]{64}$/.test(attempt.digest ?? '') || this.#attempts.has(attempt.attemptId)) {
        return 'FAILED_BEFORE_EGRESS';
      }
      snapshot = {
        generation: this.#generation, tabId: health.tab.id, text: payload.text,
        expectedUrl: health.enrolled.url, destination: health.enrolled.destination,
      };
      this.#attempts.add(attempt.attemptId);
    } catch { return 'FAILED_BEFORE_EGRESS'; }
    let response;
    const command = {
      profile: CHATGPT_RELEASE_PROTOCOL, runtimeEpoch: this.#runtimeEpoch,
      browserSessionId: this.#connection.browserSessionId, scope: attempt.scope,
      tabId: snapshot.tabId, expectedUrl: snapshot.expectedUrl, destination: snapshot.destination,
      attemptId: attempt.attemptId, payloadDigest: attempt.digest,
      textDigest: textDigest(snapshot.text), textBytes: Buffer.from(snapshot.text, 'utf8').toString('base64'),
    };
    try {
      response = await this.#send(command);
    } catch (error) {
      return error?.exposure === 'NONE' ? 'FAILED_BEFORE_EGRESS' : 'OUTCOME_UNKNOWN';
    }
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
