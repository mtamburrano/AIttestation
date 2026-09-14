import { CHATGPT_RELEASE_PROTOCOL } from './adapter.mjs';
import { emit } from '../../release/diagnostics.mjs';

export class ChromeBridgeController {
  #diagnostics;
  #adapter; #write; #pending = new Map(); #timeoutMs; #connected = true; #localBrowser; #localPlatform; #paired = false;

  constructor(adapter, write, { timeoutMs = 5_000, localBrowser, localPlatform, diagnostics = null } = {}) {
    if (!adapter || typeof write !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20_000) {
      throw Error('Invalid Chrome bridge controller');
    }
    if (!localBrowser || typeof localBrowser !== 'object' || !localPlatform || typeof localPlatform !== 'object') {
      throw Error('Authenticated local browser and platform identity required');
    }
    this.#adapter = adapter; this.#write = write; this.#timeoutMs = timeoutMs;
    this.#localBrowser = structuredClone(localBrowser); this.#localPlatform = structuredClone(localPlatform);
    this.#diagnostics = diagnostics;
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
      emit(this.#diagnostics, 'BRIDGE_HELLO');
      return;
    }
    if (!this.#paired) throw Error('Chrome bridge is not paired');
    if (message.kind === 'PAP_STATE') {
      this.#adapter.synchronize(message); emit(this.#diagnostics, 'BRIDGE_STATE'); return;
    }
    if (typeof message.attemptId === 'string') {
      const pending = this.#pending.get(message.attemptId);
      if (!pending) return;
      this.#pending.delete(message.attemptId); clearTimeout(pending.timer);
      const command = pending.command;
      if (message.profile !== command.profile || message.runtimeEpoch !== command.runtimeEpoch
          || message.browserSessionId !== command.browserSessionId || message.scope !== command.scope
          || message.tabId !== command.tabId || message.expectedUrl !== command.expectedUrl
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
      this.#pending.set(command.attemptId, { resolve, reject, timer, started, refs, command: structuredClone(command) });
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
