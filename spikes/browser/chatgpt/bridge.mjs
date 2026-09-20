import { emit } from '../../diagnostics/local.mjs';
import { CHATGPT_CAPTURE_PROFILE, CHATGPT_CAPTURE_DIAGNOSTIC_PROFILE, CAPTURE_REJECTION_CODES } from './capture.mjs';
import { CHATGPT_PANEL_PROFILE, CHATGPT_PANEL_DIAGNOSTIC_PROFILE, PANEL_REJECTION_CODES, panelRequest, panelError } from './panel.mjs';

export class ChromeBridgeController {
  #diagnostics;
  #adapter; #write; #connected = true; #localBrowser; #localPlatform; #paired = false;
  #engine; #policy = null; #observations = 0;
  #panelRequests = 0; #openDashboard;
  #panelDiagnostics = new Set();
  #captureDiagnostics = new Set();

  constructor(adapter, write, { timeoutMs = 5_000, localBrowser, localPlatform, diagnostics = null, engine = null, openDashboard = null } = {}) {
    if (!adapter || typeof write !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20_000) {
      throw Error('Invalid Chrome bridge controller');
    }
    if (!localBrowser || typeof localBrowser !== 'object' || !localPlatform || typeof localPlatform !== 'object') {
      throw Error('Authenticated local browser and platform identity required');
    }
    this.#adapter = adapter; this.#write = write;
    this.#localBrowser = structuredClone(localBrowser); this.#localPlatform = structuredClone(localPlatform);
    this.#diagnostics = diagnostics;
    this.#engine = engine;
    this.#openDashboard = openDashboard;
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
      this.#write({ kind: 'PAP_READY', runtimeEpoch, browserSessionId: message.browserSessionId,
        ...(this.#adapter.capabilities.privilegedPanel ? { panelProfile: CHATGPT_PANEL_PROFILE,
          panelDiagnosticProfile: CHATGPT_PANEL_DIAGNOSTIC_PROFILE } : {}),
        ...(this.#adapter.capabilities.observation ? { captureDiagnosticProfile: CHATGPT_CAPTURE_DIAGNOSTIC_PROFILE } : {}) });
      this.publishCapturePolicy();
      emit(this.#diagnostics, 'BRIDGE_HELLO');
      return;
    }
    if (!this.#paired) throw Error('Chrome bridge is not paired');
    if (message.kind === 'PAP_CAPTURE_DIAGNOSTIC') {
      if (!this.#adapter.capabilities.observation || message.profile !== CHATGPT_CAPTURE_DIAGNOSTIC_PROFILE
          || Object.keys(message).sort().join(',') !== 'code,kind,profile'
          || !CAPTURE_REJECTION_CODES.includes(message.code)) throw Error('Invalid capture diagnostic');
      if (!this.#captureDiagnostics.has(message.code)) {
        this.#captureDiagnostics.add(message.code); emit(this.#diagnostics, message.code);
      }
      return;
    }
    if (message.kind === 'PAP_PANEL_DIAGNOSTIC') {
      if (!this.#adapter.capabilities.privilegedPanel || message.profile !== CHATGPT_PANEL_DIAGNOSTIC_PROFILE
          || Object.keys(message).sort().join(',') !== 'code,kind,profile'
          || !PANEL_REJECTION_CODES.includes(message.code)) throw Error('Invalid panel diagnostic');
      if (!this.#panelDiagnostics.has(message.code)) {
        this.#panelDiagnostics.add(message.code); emit(this.#diagnostics, message.code);
      }
      return;
    }
    if (message.kind === 'PAP_PANEL_REQUEST') {
      if (!this.#engine || !this.#adapter.capabilities.privilegedPanel || this.#panelRequests >= 8) throw Error('Panel unavailable');
      this.#panelRequests++;
      panelRequest(message, this.#engine, this.#openDashboard).then(result => {
        if (this.#connected) this.#write({ kind: 'PAP_PANEL_RESULT', profile: CHATGPT_PANEL_PROFILE, requestId: message.requestId, ...result });
      }).catch(error => {
        if (this.#connected) this.#write({ kind: 'PAP_PANEL_RESULT', profile: CHATGPT_PANEL_PROFILE,
          requestId: message.requestId, error: panelError(error) });
      }).catch(() => {}).finally(() => { this.#panelRequests--; });
      return;
    }
    if (message.kind === 'PAP_CAPTURE') {
      if (!this.#engine || this.#observations >= 32 || Object.keys(message).sort().join(',') !==
          (message.newChatContinuation === true ? 'kind,newChatContinuation,observation,requestId' : 'kind,observation,requestId')
          || !/^[a-f0-9-]{36}$/.test(message.requestId ?? '')) throw Error('Invalid capture delivery');
      const { textBytes, ...observation } = message.observation ?? {};
      if (observation.kind === 'request-observed') {
        if (typeof textBytes !== 'string' || textBytes.length > 349528 || Object.hasOwn(observation, 'text')
            || Buffer.from(textBytes, 'base64').toString('base64') !== textBytes) throw Error('Invalid capture encoding');
        observation.text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.from(textBytes, 'base64'));
      } else if (textBytes !== undefined) throw Error('Invalid capture encoding');
      this.#observations++;
      this.#engine.observe(observation, { newChatContinuation: message.newChatContinuation === true }).then(result => {
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
    throw Error('Unsupported Chrome bridge message');
  }

  publishCapturePolicy() {
    if (!this.#connected || !this.#paired || !this.#engine || !this.#adapter.capabilities.observation) return;
    const policies = this.#engine.capturePolicy(), states = this.#engine.captureStates(), encoded = JSON.stringify({ policies, states });
    if (encoded === this.#policy) return;
    this.#policy = encoded;
    this.#write({ kind: 'PAP_CAPTURE_POLICY', profile: CHATGPT_CAPTURE_PROFILE, policies, states });
  }

  disconnect() {
    if (!this.#connected) return;
    this.#connected = false; this.#adapter.disconnect();
  }
}
