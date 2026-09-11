import { CHATGPT_RELEASE_PROTOCOL } from './adapter.mjs';

export class ChromeBridgeController {
  #adapter; #write; #pending = new Map(); #timeoutMs; #connected = true; #localPlatform;

  constructor(adapter, write, { timeoutMs = 5_000, localPlatform = null } = {}) {
    if (!adapter || typeof write !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20_000) {
      throw Error('Invalid Chrome bridge controller');
    }
    this.#adapter = adapter; this.#write = write; this.#timeoutMs = timeoutMs;
    this.#localPlatform = localPlatform === null ? null : structuredClone(localPlatform);
  }

  receive(message) {
    if (!message || typeof message !== 'object') throw Error('Invalid Chrome bridge message');
    if (message.kind === 'PAP_HELLO') {
      const hello = this.#localPlatform ? { ...message, platform: structuredClone(this.#localPlatform) } : message;
      this.#adapter.pair(hello);
      this.#adapter.synchronize(hello);
      return;
    }
    if (message.kind === 'PAP_STATE') { this.#adapter.synchronize(message); return; }
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
        error.exposure = 'UNKNOWN'; pending.reject(error); return;
      }
      pending.resolve(structuredClone(message));
      return;
    }
    throw Error('Unsupported Chrome bridge message');
  }

  sendRelease(command) {
    if (!this.#connected || command?.profile !== CHATGPT_RELEASE_PROTOCOL || typeof command.attemptId !== 'string'
        || this.#pending.has(command.attemptId)) return Promise.reject(Error('Chrome bridge unavailable or duplicate attempt'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(command.attemptId);
        const error = Error('Chrome adapter outcome unknown'); error.exposure = 'UNKNOWN'; reject(error);
      }, this.#timeoutMs);
      this.#pending.set(command.attemptId, { resolve, reject, timer, command: structuredClone(command) });
      try { this.#write({ kind: 'PAP_RELEASE', ...structuredClone(command) }); }
      catch (cause) {
        clearTimeout(timer); this.#pending.delete(command.attemptId);
        const error = Error('Chrome bridge write failed', { cause }); error.exposure = 'NONE'; reject(error);
      }
    });
  }

  disconnect() {
    if (!this.#connected) return; this.#connected = false; this.#adapter.invalidate('native bridge disconnected');
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer); const error = Error('Chrome bridge disconnected'); error.exposure = 'UNKNOWN'; pending.reject(error);
    }
    this.#pending.clear();
  }
}
