import { randomUUID } from 'node:crypto';
import { canonical } from '../../vault/format.mjs';
import { CHATGPT_ADAPTER_PROFILE } from './adapter.mjs';
import { CHATGPT_CAPTURE_PROFILE, validateCapture, validateCaptureReceipt } from './capture.mjs';

const reject = code => { throw Object.assign(Error(code), { code }); };

// Browser document continuity is private to this adapter. The core only orders
// consent and asks this boundary to validate an already observed submission.
export class ChatGPTCaptureAdmission {
  #adapter; #epoch;
  #captureTokens = new Map(); #newChatTokens = new Map(); #retiredTokens = new Map();
  #receipts = new Map();
  constructor(adapter, runtimeEpoch) { this.#adapter = adapter; this.#epoch = runtimeEpoch; }
  get integrationId() { return 'chrome-chatgpt'; }
  get installationId() { return this.#adapter.installationId; }
  get controlProfile() { return CHATGPT_ADAPTER_PROFILE; }
  get capabilities() { return this.#adapter.capabilities; }
  onChange(listener) { return this.#adapter.onChange(listener); }
  scopes() { return this.#adapter.scopes(); }
  offersCapture(scope) { return this.#adapter.offersCapture(scope); }
  states(state) {
    return this.scopes().map(source => ({ tabId: source.tabId,
      state: state === 'READY' && !this.offersCapture(source.scope) ? 'RECORDING_UNAVAILABLE' : state }));
  }
  revoke() { this.#captureTokens.clear(); this.#newChatTokens.clear(); this.#retiredTokens.clear(); }
  policies(enabled) {
    const sources = this.#adapter.scopes().filter(source => enabled
      && this.#adapter.observationEligible(source.scope));
    for (const [scope, entry] of this.#retiredTokens) {
      if (!enabled || performance.now() >= entry.expires
          || !this.#adapter.requestContinuation(entry.source)) this.#retiredTokens.delete(scope);
    }
    for (const [scope, entry] of this.#newChatTokens) {
      if (!enabled || performance.now() >= entry.expires
          || !this.#adapter.newChatContinuation(entry.source)) this.#newChatTokens.delete(scope);
    }
    for (const [scope, entry] of this.#captureTokens) if (!sources.some(source => source.scope === scope)) {
      if (enabled && this.#adapter.newChatContinuation(entry.source)) {
        this.#newChatTokens.set(scope, { ...entry, expires: performance.now() + 5000 });
      } else if (enabled && entry.source.destination !== 'new-chat'
          && this.#adapter.requestContinuation(entry.source) && this.#retiredTokens.size < 512) {
        this.#retiredTokens.set(scope, { ...entry, expires: performance.now() + 12000 });
      }
      this.#captureTokens.delete(scope);
    }
    return sources.map(source => {
      if (!this.#captureTokens.has(source.scope)) this.#captureTokens.set(source.scope, { token: randomUUID(), source });
      return { profile: CHATGPT_CAPTURE_PROFILE, token: this.#captureTokens.get(source.scope).token,
        runtimeEpoch: this.#epoch, browserSessionId: source.browserSessionId, scope: source.scope,
        tabId: source.tabId, windowId: source.windowId, tabEpoch: source.tabEpoch,
        expectedUrl: source.url, destination: source.destination };
    });
  }
  prepare(input, { newChatContinuation = false, requestContinuation = false } = {}) {
    let observation, admittedSource = false;
    observation = validateCapture(input);
    const entry = this.#captureTokens.get(observation.source.scope);
    if (entry?.token === observation.token) {
      this.#adapter.assertObservationSource(observation.source);
      admittedSource = entry.source.destination !== 'new-chat';
    }
    // Preserve this call's authenticated active-source admission if navigation
    // retires its binding while queued. The maps below still enforce ordered
    // consent revocation, document continuity and the retired token's lifetime.
    const continuingRequest = requestContinuation || admittedSource;
    return { observation, newChatContinuation, continuingRequest };
  }
  accept({ observation, newChatContinuation, continuingRequest }) {
    const { eventId, source } = observation;
    if (source.runtimeEpoch !== this.#epoch) reject('CAPTURE_NOT_ENABLED');
    const active = this.#captureTokens.get(source.scope);
    const entry = active ?? (newChatContinuation ? this.#newChatTokens.get(source.scope)
      : continuingRequest ? this.#retiredTokens.get(source.scope) : null);
    if (!entry || entry.token !== observation.token) reject('CAPTURE_NOT_ENABLED');
    if (continuingRequest && (newChatContinuation || entry.source.destination === 'new-chat'
        || ['scope', 'runtimeEpoch', 'browserSessionId', 'tabId', 'windowId', 'tabEpoch', 'destination']
          .some(key => source[key] !== entry.source[key]))) reject('CAPTURE_NOT_ENABLED');
    if (newChatContinuation) {
      // The authenticated worker confirms the original document's pending
      // snapshot. Retired authority is usable for this one request only.
      if (entry.source.url !== 'https://chatgpt.com/'
          || source.destination !== 'new-chat'
          || entry.eventId && entry.eventId !== eventId
          || entry.documentId && entry.documentId !== source.documentId
          || observation.kind === 'acknowledgement' && entry.eventId !== eventId
          || ['scope', 'runtimeEpoch', 'browserSessionId', 'tabId', 'windowId', 'tabEpoch', 'destination']
            .some(key => source[key] !== entry.source[key])) reject('CAPTURE_NOT_ENABLED');
      entry.eventId = eventId; entry.documentId = source.documentId;
    }
    if (active) this.#adapter.assertObservationSource(source);
    else if (!(continuingRequest ? this.#adapter.requestContinuation(entry.source)
      : this.#adapter.newChatContinuation(entry.source))) reject('CAPTURE_NOT_ENABLED');
    if (source.destination === 'new-chat' && observation.kind === 'request-observed' && !entry.eventId) {
      entry.eventId = eventId; entry.documentId = source.documentId;
    }
    if (this.#receipts.size >= 256) this.#receipts.delete(this.#receipts.keys().next().value);
    this.#receipts.set(eventId, canonical(source));
  }
  receipt(input, session) {
    const query = validateCaptureReceipt(input);
    if (this.#receipts.get(query.eventId) !== canonical(query.source)) {
      return { profile: CHATGPT_CAPTURE_PROFILE, eventId: query.eventId, kind: 'request-observed', state: 'SAVE_PENDING' };
    }
    return session.captureReceipt(query.eventId, query.source);
  }
  save(observation, session) { return session.observeNormal(observation); }
  primary(observation) { return observation.kind === 'request-observed'; }
  saved(observation, version) {
    return { profile: CHATGPT_CAPTURE_PROFILE, eventId: observation.eventId, kind: observation.kind,
      state: 'PROMPT_SAVED', receiptId: version.descriptorId,
      ...(version.id !== observation.eventId ? { deduplicated: true } : {}) };
  }
}
