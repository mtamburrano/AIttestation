import { CHATGPT_RELEASE_PROTOCOL } from './adapter.mjs';
import { emit } from '../../release/diagnostics.mjs';
import { CHATGPT_CAPTURE_PROFILE } from './capture.mjs';

export class ChromeBridgeController {
  #diagnostics;
  #adapter; #write; #pending = new Map(); #timeoutMs; #connected = true; #localBrowser; #localPlatform; #paired = false;
  #engine; #policy = null; #observations = 0;

  constructor(adapter, write, { timeoutMs = 5_000, localBrowser, localPlatform, diagnostics = null, engine = null } = {}) {
    if (!adapter || typeof write !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20_000) {
      throw Error('Invalid Chrome bridge controller');
    }
    if (!localBrowser || typeof localBrowser !== 'object' || !localPlatform || typeof localPlatform !== 'object') {
      throw Error('Authenticated local browser and platform identity required');
    }
    this.#adapter = adapter; this.#write = write; this.#timeoutMs = timeoutMs;
    this.#localBrowser = structuredClone(localBrowser); this.#localPlatform = structuredClone(localPlatform);
    this.#diagnostics = diagnostics;
    this.#engine = engine;
  }

  receive(message) {
    if (!this.#connected) return;
    if (!message || typeof message !== 'object') throw Error('Invalid Chrome bridge message');
    if (message.kind === 'PAP_HELLO') {
      if (this.#paired) throw Error('Chrome bridge already paired');
      const hello = { ...message, browser: structuredClone(this.#localBrowser),
        platform: structuredClone(this.#localPlatform) };
      const { runtimeEpoch } = this.#adapter.pair(hello);
      this.#adapter.synchronize(hello);
      this.#paired = true;
      this.#write({ kind: 'PAP_READY', runtimeEpoch, browserSessionId: message.browserSessionId });
      this.publishCapturePolicy();
      emit(this.#diagnostics, 'BRIDGE_HELLO');
      return;
    }
    if (!this.#paired) throw Error('Chrome bridge is not paired');
    if (message.kind === 'PAP_CAPTURE') {
      if (!this.#engine || this.#observations >= 32 || Object.keys(message).sort().join(',') !== 'kind,observation,requestId'
          || !/^[a-f0-9-]{36}$/.test(message.requestId ?? '')) throw Error('Invalid capture delivery');
      const { textBytes, ...observation } = message.observation ?? {};
      if (typeof textBytes !== 'string' || textBytes.length > 349528 || Object.hasOwn(observation, 'text')
          || Buffer.from(textBytes, 'base64').toString('base64') !== textBytes) throw Error('Invalid capture encoding');
      observation.text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.from(textBytes, 'base64'));
      this.#observations++;
      this.#engine.observe(observation).then(result => {
        if (this.#connected) this.#write({ kind: 'PAP_CAPTURE_RESULT', requestId: message.requestId, result });
      }).catch(() => {
        emit(this.#diagnostics, 'CAPTURE_GAP');
        if (this.#connected) this.#write({ kind: 'PAP_CAPTURE_RESULT', requestId: message.requestId,
          result: { profile: CHATGPT_CAPTURE_PROFILE, state: 'RECORDING_UNAVAILABLE' } });
      }).catch(() => {}).finally(() => { this.#observations--; });
      return;
    }
    if (message.kind === 'PAP_STATE') {
      this.#adapter.synchronize(message); emit(this.#diagnostics, 'BRIDGE_STATE'); return;
    }
    if (message.kind === 'PAP_CHECK_RELEASE') {
      if (typeof message.attemptId !== 'string' || typeof message.checkId !== 'string'
          || !/^[a-f0-9-]{36}$/.test(message.checkId) || !['inject', 'click'].includes(message.phase)
          || Object.keys(message).sort().join(',') !== 'attemptId,checkId,kind,phase') throw Error('Invalid release check');
      const pending = this.#pending.get(message.attemptId);
      const authorized = Boolean(pending && pending.nextCheck === message.phase
        && performance.now() - pending.started < this.#timeoutMs && this.#adapter.isDispatchCurrent(message.attemptId));
      if (pending) {
        pending.nextCheck = authorized && message.phase === 'inject' ? 'click' : null;
        emit(this.#diagnostics, authorized ? 'BRIDGE_CHECK_ACCEPTED' : 'BRIDGE_CHECK_REJECTED', pending.refs);
      }
      this.#write({ kind: 'PAP_RELEASE_CHECKED', attemptId: message.attemptId, checkId: message.checkId, authorized });
      return;
    }
    if (typeof message.attemptId === 'string') {
      const pending = this.#pending.get(message.attemptId);
      if (!pending) return;
      this.#pending.delete(message.attemptId); clearTimeout(pending.timer);
      const command = pending.command;
      if (message.profile !== command.profile || message.runtimeEpoch !== command.runtimeEpoch
          || message.browserSessionId !== command.browserSessionId || message.scope !== command.scope
          || message.tabId !== command.tabId || message.expectedUrl !== command.expectedUrl
          || message.windowId !== command.windowId || message.tabEpoch !== command.tabEpoch
          || message.destination !== command.destination || message.payloadDigest !== command.payloadDigest
          || message.textDigest !== command.textDigest) {
        const error = Error('Chrome adapter response did not match the exact release attempt');
        emit(this.#diagnostics, 'BRIDGE_RESPONSE_REJECTED', { ...pending.refs, durationMs: performance.now() - pending.started });
        error.exposure = 'UNKNOWN'; pending.reject(error); return;
      }
      pending.resolve(structuredClone(message));
      emit(this.#diagnostics, 'BRIDGE_RESPONSE', { ...pending.refs, durationMs: performance.now() - pending.started });
      return;
    }
    throw Error('Unsupported Chrome bridge message');
  }

  publishCapturePolicy() {
    if (!this.#connected || !this.#paired || !this.#engine || !this.#adapter.capabilities.observation) return;
    const policies = this.#engine.capturePolicy(), states = this.#engine.captureStates(), encoded = JSON.stringify({ policies, states });
    if (encoded === this.#policy) return;
    this.#policy = encoded;
    this.#write({ kind: 'PAP_CAPTURE_POLICY', profile: CHATGPT_CAPTURE_PROFILE, policies, states });
  }

  sendRelease(command, diagnosticRefs = {}) {
    if (!this.#connected || !this.#paired || command?.profile !== CHATGPT_RELEASE_PROTOCOL || typeof command.attemptId !== 'string'
        || this.#pending.has(command.attemptId)) return Promise.reject(Error('Chrome bridge unavailable or duplicate attempt'));
    return new Promise((resolve, reject) => {
      const started = performance.now();
      const refs = { ...diagnosticRefs, dispatchId: command.attemptId };
      const timer = setTimeout(() => {
        this.#pending.delete(command.attemptId);
        emit(this.#diagnostics, 'BRIDGE_TIMEOUT', { ...refs, durationMs: performance.now() - started });
        const error = Error('Chrome adapter outcome unknown'); error.exposure = 'UNKNOWN'; reject(error);
      }, this.#timeoutMs);
      this.#pending.set(command.attemptId, { resolve, reject, timer, started, refs, nextCheck: 'inject', command: structuredClone(command) });
      try {
        emit(this.#diagnostics, 'BRIDGE_DISPATCH', refs);
        this.#write({ kind: 'PAP_RELEASE', ...structuredClone(command) });
      }
      catch (cause) {
        clearTimeout(timer); this.#pending.delete(command.attemptId);
        emit(this.#diagnostics, 'BRIDGE_WRITE_FAILED', refs);
        const error = Error('Chrome bridge write failed', { cause }); error.exposure = 'NONE'; reject(error);
      }
    });
  }

  disconnect() {
    if (!this.#connected) return; this.#connected = false; this.#adapter.disconnect();
    for (const pending of this.#pending.values()) {
      emit(this.#diagnostics, 'BRIDGE_DISCONNECTED', { ...pending.refs, durationMs: performance.now() - pending.started });
      clearTimeout(pending.timer); const error = Error('Chrome bridge disconnected'); error.exposure = 'UNKNOWN'; pending.reject(error);
    }
    this.#pending.clear();
  }
}
