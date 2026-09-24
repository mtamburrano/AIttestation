import { createHash, randomUUID } from 'node:crypto';
import { canonical, keys } from '../../vault/format.mjs';
import { emit, emitCaptureFailure } from '../../diagnostics/local.mjs';
import { CHATGPT_ADAPTER_PROFILE } from './adapter.mjs';
import { EngineStateStore, migrateRecordingState } from './engine-store.mjs';
import { CHATGPT_CAPTURE_PROFILE, validateCapture, validateCaptureReceipt } from './capture.mjs';

export const ENGINE_COMMAND_PROFILE = 'pap-resident-command/2';
export const ENGINE_EVENT_PROFILE = 'pap-resident-event/2';
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const reject = code => { throw Object.assign(Error(code), { code }); };

// One queue orders consent and capture. Anchor work starts only after a durable
// save and never has permission to collect text or interact with provider Send.
export class ResidentEngine {
  #session; #adapter; #epoch; #store; #state; #diagnostics;
  #commands = new Map(); #control = Promise.resolve(); #work = new Set();
  #listeners = new Set(); #unsubscribe; #closed = false; #failed = false;
  #captureTokens = new Map(); #anchorQueue = []; #anchoring = new Set();
  #newChatTokens = new Map();
  #retiredTokens = new Map();
  #anchorRetries = new Map();
  #anchorCursor = 0; #durableVersions = 0;
  #anchorScheduled = false;

  constructor(directory, session, adapter, runtimeEpoch, diagnostics = null) {
    this.#session = session; this.#adapter = adapter; this.#epoch = runtimeEpoch; this.#diagnostics = diagnostics;
    this.#store = new EngineStateStore(directory, session.vault);
  }
  async init() {
    this.#state = migrateRecordingState(await this.#store.load());
    this.#unsubscribe = this.#adapter.onChange(() => {
      this.capturePolicy(); this.#publish();
    });
    await this.#commit();
    // Recovery has no engine pointer and stays OFF. Only durable observations,
    // never old Send journals, can contribute bounded pending anchor work.
    this.#durableVersions = this.#session.versionCount;
    this.#pumpAnchors();
    return this;
  }
  state() {
    const scopes = this.#adapter.scopes().map(source => ({ ...source,
      effectiveRecording: !this.#state.recording ? 'OFF' : this.#closed || this.#failed
        || !this.#adapter.offersCapture(source.scope) ? 'UNAVAILABLE' : 'ON' }));
    return structuredClone({ profile: ENGINE_EVENT_PROFILE, runtimeEpoch: this.#epoch, adapterProfile: CHATGPT_ADAPTER_PROFILE,
      revision: this.#state.revision, available: !this.#closed && !this.#failed,
      recording: this.#state.recording, migration: this.#state.migration,
      capabilities: this.#adapter.capabilities, scopes,
      operations: this.#session.status().versions.slice(-512).map(version => ({ id: version.id, scope: version.scope,
        observation: true, state: 'PROMPT_SAVED', result: version })) });
  }
  subscribe(listener) {
    if (typeof listener !== 'function' || this.#listeners.size >= 32) reject('VIEW_LIMIT');
    this.#listeners.add(listener); listener(this.state());
    return () => this.#listeners.delete(listener);
  }
  #publish() {
    for (const listener of this.#listeners) { try { listener(this.state()); } catch {} }
  }
  async #commit(refs = {}) {
    this.#state.revision++;
    try { await this.#store.save(structuredClone(this.#state)); }
    catch (error) {
      this.#failed = true; this.#captureTokens.clear();
      emit(this.#diagnostics, 'VAULT_WRITE_FAILED', refs);
      emitCaptureFailure(this.#diagnostics, error, refs);
      throw error;
    }
    finally { this.#publish(); }
  }
  #serial(operation) {
    const next = this.#control.then(operation); this.#control = next.catch(() => {}); return next;
  }
  capturePolicy() {
    const sources = this.#adapter.scopes().filter(source => !this.#closed && !this.#failed && this.#state.recording
      && this.#adapter.observationEligible(source.scope));
    for (const [scope, entry] of this.#retiredTokens) {
      if (this.#closed || this.#failed || !this.#state.recording || performance.now() >= entry.expires
          || !this.#adapter.requestContinuation(entry.source)) this.#retiredTokens.delete(scope);
    }
    for (const [scope, entry] of this.#newChatTokens) {
      if (this.#closed || this.#failed || !this.#state.recording || performance.now() >= entry.expires
          || !this.#adapter.newChatContinuation(entry.source)) this.#newChatTokens.delete(scope);
    }
    for (const [scope, entry] of this.#captureTokens) if (!sources.some(source => source.scope === scope)) {
      if (!this.#closed && !this.#failed && this.#state.recording && this.#adapter.newChatContinuation(entry.source)) {
        this.#newChatTokens.set(scope, { ...entry, expires: performance.now() + 5000 });
      } else if (!this.#closed && !this.#failed && this.#state.recording && entry.source.destination !== 'new-chat'
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
  captureStates() {
    return this.#adapter.scopes().map(source => ({ tabId: source.tabId,
      state: !this.#state.recording ? 'OFF' : this.#closed || this.#failed
        || !this.#adapter.offersCapture(source.scope) ? 'RECORDING_UNAVAILABLE' : 'READY' }));
  }
  observe(input, { newChatContinuation = false, requestContinuation = false } = {}) {
    let observation, admittedSource = false;
    try {
      observation = validateCapture(input);
      this.capturePolicy();
      const entry = this.#captureTokens.get(observation.source.scope);
      if (entry?.token === observation.token) {
        this.#adapter.assertObservationSource(observation.source);
        admittedSource = entry.source.destination !== 'new-chat';
      }
    } catch (error) { return Promise.reject(error); }
    // Preserve this call's authenticated active-source admission if navigation
    // retires its binding while queued. The maps below still enforce ordered
    // consent revocation, document continuity and the retired token's lifetime.
    const continuingRequest = requestContinuation || admittedSource;
    return this.#serial(async () => {
      const { eventId, source } = observation;
      this.capturePolicy();
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
      const prior = this.#session.version(eventId);
      let version;
      try {
        version = this.#session.observeNormal(observation);
        if (!prior && version.id === eventId) await this.#commit({ operationId: eventId });
      } catch (error) {
        if (observation.kind === 'request-observed' && !['CAPTURE_REPLAY_CONFLICT', 'CAPTURE_CORRELATION_CONFLICT'].includes(error.message)) {
          this.#failed = true; this.#captureTokens.clear(); this.#publish();
          emit(this.#diagnostics, 'ENGINE_CAPTURE_DISABLED', { operationId: eventId });
        }
        if (!['CAPTURE_REPLAY_CONFLICT', 'CAPTURE_CORRELATION_CONFLICT'].includes(error.message)) {
          const receipt = this.#session.captureReceipt(eventId, source);
          if (receipt.state === 'PROMPT_SAVED') return receipt;
        }
        emit(this.#diagnostics, 'CAPTURE_GAP', { operationId: eventId }); throw error;
      }
      if (!prior && version.id === eventId) {
        this.#durableVersions = this.#session.versionCount;
        this.#pumpAnchors();
      }
      this.#publish();
      return { profile: CHATGPT_CAPTURE_PROFILE, eventId, kind: observation.kind,
        state: 'PROMPT_SAVED', receiptId: version.descriptorId, ...(version.id !== eventId ? { deduplicated: true } : {}) };
    });
  }
  #pumpAnchors() {
    if (this.#closed || this.#anchorScheduled) return;
    this.#anchorScheduled = true;
    // Even an immediately rejected sponsor must yield between batches so its
    // durable attempt writes cannot monopolize capture replies and controls.
    const work = new Promise(resolve => setImmediate(() => {
      this.#anchorScheduled = false;
      try { this.#runAnchors(); } finally { resolve(); }
    }));
    this.#work.add(work); work.then(() => this.#work.delete(work));
  }
  #runAnchors() {
    if (this.#closed) return;
    const versions = this.#session.status().versions;
    // A runtime gets one bounded batch per pending observation, regardless of
    // earlier outages. Cumulative attempts never permanently abandon evidence.
    // Walk insertion-ordered durable history once per runtime. Overflow waits
    // in the vault. Retries share the same bounded queue and workers. The
    // committed boundary excludes a capture whose metadata is still saving.
    while (this.#anchorCursor < this.#durableVersions && this.#anchorQueue.length + this.#anchoring.size + this.#anchorRetries.size < 512) {
      const version = versions[this.#anchorCursor++];
      if (!version.legacy && version.anchor === 'PENDING') this.#anchorQueue.push({ id: version.id, retry: 0 });
    }
    while (!this.#closed && this.#anchoring.size < 2 && this.#anchorQueue.length) {
      const { id, retry } = this.#anchorQueue.shift();
      const version = this.#session.version(id);
      if (!version || version.anchor !== 'PENDING') continue;
      this.#anchoring.add(id);
      if (retry) emit(this.#diagnostics, 'ANCHOR_RETRY_STARTED', { operationId: id });
      const work = this.#session.anchorManaged({ id }).then(result => {
        if (['SERVICE_UNAVAILABLE', 'SUBMISSION_INTERRUPTED', 'RATE_LIMITED', 'QUOTA_EXHAUSTED', 'UNPAID'].includes(result?.managed?.state)) {
          this.#retryAnchor(id, retry);
        }
      }).catch(error => {
        emit(this.#diagnostics, 'CONFIRMATION_PENDING', { operationId: id });
        if (error?.code === 'PENDING_FAST_CONFIRMATION') this.#retryAnchor(id, retry);
      }).finally(() => {
        this.#anchoring.delete(id); this.#work.delete(work); this.#publish(); this.#pumpAnchors();
      });
      this.#work.add(work);
    }
  }
  #retryAnchor(id, retry) {
    const version = this.#session.version(id);
    if (this.#closed || retry >= 2 || !version || version.anchor !== 'PENDING') return;
    // This job can only invoke Algorand sponsorship/confirmation. The saved
    // transaction and cumulative attempt journal remain owned by the session.
    const timer = setTimeout(() => {
      this.#anchorRetries.delete(id);
      if (this.#closed) return;
      this.#anchorQueue.push({ id, retry: retry + 1 }); this.#pumpAnchors();
    }, [5000, 30000][retry]);
    timer.unref?.(); this.#anchorRetries.set(id, timer);
    emit(this.#diagnostics, 'ANCHOR_RETRY_SCHEDULED', { operationId: id });
  }
  captureReceipt(input) {
    const query = validateCaptureReceipt(input);
    return this.#session.captureReceipt(query.eventId, query.source);
  }
  command(input, { surface } = {}) {
    let command;
    try {
      if (!['development', 'desktop', 'extension_panel'].includes(surface)) reject('UNTRUSTED_COMMAND_ORIGIN');
      if (input?.kind !== 'SET_RECORDING') reject('INVALID_ENGINE_COMMAND');
      keys(input, ['profile', 'runtimeEpoch', 'adapterProfile', 'commandId', 'expectedRevision', 'kind', 'enabled']);
      if (input.profile !== ENGINE_COMMAND_PROFILE || input.adapterProfile !== CHATGPT_ADAPTER_PROFILE
          || !uuid(input.commandId) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
          || typeof input.enabled !== 'boolean') reject('ENGINE_CONTRACT_MISMATCH');
      if (input.runtimeEpoch !== this.#epoch) reject('STALE_RUNTIME_EPOCH');
      command = structuredClone(input);
    } catch (error) { return Promise.reject(error); }
    return this.#serial(async () => {
      if (this.#closed || this.#failed) reject('ENGINE_UNAVAILABLE');
      const fingerprint = createHash('sha256').update(canonical(command)).digest('hex');
      const prior = this.#commands.get(command.commandId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) reject('COMMAND_REPLAY_CONFLICT');
        return structuredClone(prior.ack);
      }
      if (command.expectedRevision !== this.#state.revision) reject('STALE_ENGINE_REVISION');
      if (this.#commands.size >= 4096) reject('COMMAND_LIMIT');
      if (this.#state.recording !== command.enabled) { this.#captureTokens.clear(); this.#newChatTokens.clear(); this.#retiredTokens.clear(); }
      this.#state.recording = command.enabled;
      // Publish revocation immediately; acknowledge the setting only after fsync.
      this.#publish();
      await this.#commit();
      const ack = { profile: ENGINE_EVENT_PROFILE, commandId: command.commandId, runtimeEpoch: this.#epoch,
        revision: this.#state.revision, recording: this.#state.recording };
      this.#commands.set(command.commandId, { fingerprint, ack });
      emit(this.#diagnostics, command.enabled ? 'RECORDING_ENABLED' : 'RECORDING_DISABLED');
      return structuredClone(ack);
    });
  }
  async drain() { await this.#control; while (this.#work.size) await Promise.all(this.#work); }
  stop() {
    this.#closed = true; this.#captureTokens.clear(); this.#anchorQueue = [];
    for (const timer of this.#anchorRetries.values()) clearTimeout(timer);
    this.#anchorRetries.clear(); this.#unsubscribe?.(); this.#publish();
  }
}
