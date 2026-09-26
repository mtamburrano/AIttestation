import { createHash, randomUUID } from 'node:crypto';
import { canonical, keys } from '../vault/format.mjs';
import { emit, emitCaptureFailure } from '../diagnostics/local.mjs';
import { migrateRecordingState } from './recording-state.mjs';

export const ENGINE_COMMAND_PROFILE = 'pap-resident-command/3';
export const ENGINE_EVENT_PROFILE = 'pap-resident-event/3';
export const RECORDING_CONTROL_PROFILE = 'pap-recording-control/1';
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const reject = code => { throw Object.assign(Error(code), { code }); };

// One queue orders consent and capture. Anchor work starts only after a durable
// save and never has permission to collect text or interact with provider Send.
export class RecordingEngine {
  #session; #sources; #epoch; #store; #state; #diagnostics;
  #commands = new Map(); #control = Promise.resolve(); #work = new Set();
  #listeners = new Set(); #unsubscribe; #closed = false; #failed = false;
  #anchorQueue = []; #anchoring = new Set();
  #anchorRetries = new Map();
  #anchorCursor = 0; #anchorBoundary = 0;
  #anchorScheduled = false;
  #capacityExhausted = false;
  #serialPending = 0; #admissions = new Map(); #admissionBytes = 0; #admissionScheduled = false;
  #admissionEpoch = randomUUID(); #admissionAuthorities = new WeakSet();

  constructor({ session, sources, runtimeEpoch, stateStore, diagnostics = null }) {
    this.#session = session; this.#sources = sources; this.#epoch = runtimeEpoch; this.#diagnostics = diagnostics;
    this.#store = stateStore;
  }
  async init() {
    this.#state = migrateRecordingState(await this.#store.load());
    this.#unsubscribe = this.#sources.onChange(() => {
      this.capturePolicy(); this.#publish();
    });
    // A fresh runtime epoch already invalidates old commands and sources.
    // Opening readable history must not consume another signed evidence record.
    this.#refreshCapacity();
    // Recovery has no engine pointer and stays OFF. Only durable observations,
    // never old Send journals, can contribute bounded pending anchor work.
    this.#anchorBoundary = this.#session.anchorCheckpoint;
    this.#pumpAnchors();
    return this;
  }
  state() {
    this.#refreshCapacity();
    const scopes = this.#sources.scopes(this.#state.recording, this.#closed || this.#failed || this.#capacityExhausted);
    return structuredClone({ profile: ENGINE_EVENT_PROFILE, runtimeEpoch: this.#epoch, controlProfile: RECORDING_CONTROL_PROFILE,
      revision: this.#state.revision, available: !this.#closed && !this.#failed,
      recording: this.#state.recording, migration: this.#state.migration,
      captureUnavailableReason: this.#capacityExhausted ? 'VAULT_CAPACITY_EXHAUSTED' : null,
      capabilities: { recording: true, independentSources: true }, scopes, integrations: this.#sources.integrationStatus(),
      operations: this.#session.status({ limit: 5 }).versions.map(version => ({ id: version.id, scope: version.scope,
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
  #refreshCapacity(refs = {}) {
    if (this.#closed || this.#failed) return this.#capacityExhausted;
    if (!this.#capacityExhausted && this.#session.vault.remainingRecordCapacity < 2) {
      this.#capacityExhausted = true;
      this.#sources.revoke();
      this.#anchorQueue = [];
      for (const timer of this.#anchorRetries.values()) clearTimeout(timer);
      this.#anchorRetries.clear();
      emit(this.#diagnostics, 'VAULT_CAPACITY_EXHAUSTED', refs);
    }
    return this.#capacityExhausted;
  }
  async #commit(refs = {}) {
    this.#state.revision++;
    try {
      if (this.#refreshCapacity(refs)) {
        if (this.#state.recording) return false;
        await this.#store.revokeRecording();
      } else {
        try { await this.#store.save(structuredClone(this.#state)); }
        catch (error) {
          if (error?.code !== 'VAULT_CAPACITY_EXHAUSTED') throw error;
          this.#refreshCapacity(refs);
          if (this.#state.recording) return false;
          await this.#store.revokeRecording();
        }
      }
      return true;
    }
    catch (error) {
      this.#failed = true; this.#sources.revoke();
      emit(this.#diagnostics, 'VAULT_WRITE_FAILED', refs);
      emitCaptureFailure(this.#diagnostics, error, refs);
      throw error;
    }
    finally { this.#publish(); }
  }
  #serial(operation) {
    this.#serialPending++;
    const next = this.#control.then(operation).finally(() => { this.#serialPending--; });
    this.#control = next.catch(() => {}); return next;
  }
  beginAdmission() {
    if (this.#closed || this.#failed || !this.#state.recording || this.#serialPending || this.#capacityExhausted) return null;
    const authority = Object.freeze({ epoch: this.#admissionEpoch, generations: Object.freeze(this.#sources.integrationGenerations()) });
    this.#admissionAuthorities.add(authority); return authority;
  }
  admit(input, peer, { deadline, authority } = {}) {
    // This path deliberately never reads the vault, publishes History, or waits
    // for the durable queue. JavaScript execution orders it with consent changes.
    const now = performance.now();
    if (!Number.isFinite(deadline) || deadline <= now || deadline - now > 250) reject('ADMISSION_EXPIRED');
    if (!authority || !this.#admissionAuthorities.has(authority) || authority.epoch !== this.#admissionEpoch) reject('CAPTURE_NOT_ENABLED');
    this.#admissionAuthorities.delete(authority);
    if (this.#closed || this.#failed || !this.#state.recording) reject('CAPTURE_NOT_ENABLED');
    if (this.#capacityExhausted || this.#serialPending || this.#admissions.size >= 32) reject('ADMISSION_BUSY');
    const prepared = this.#sources.prepare(input, {}, peer);
    if (prepared.generation !== authority.generations[peer.integrationId]) reject('CAPTURE_NOT_ENABLED');
    if (!prepared.boundary.synchronousAdmission) reject('UNSUPPORTED_ADMISSION_SOURCE');
    this.#sources.accept(prepared);
    const observation = prepared.observation;
    const bytes = Buffer.byteLength(observation.text, 'utf8');
    const sameIntegration = [...this.#admissions.values()].filter(item => item.peer.integrationId === peer.integrationId);
    if (sameIntegration.length >= 8 || this.#admissionBytes + bytes > 4 * 1024 * 1024
        || sameIntegration.filter(item => item.observation.source.sessionId === observation.source.sessionId).length >= 4) reject('ADMISSION_BUSY');
    const eventId = randomUUID();
    const item = { ...prepared, observation: Object.freeze({ ...observation, eventId,
      source: Object.freeze({ ...observation.source }) }), bytes, released: false };
    this.#admissions.set(eventId, item); this.#admissionBytes += bytes;
    return Object.freeze({ state: 'ADMITTED', eventId });
  }
  releaseAdmission(eventId, peer) {
    const item = this.#admissions.get(eventId);
    if (!item || item.peer !== peer || item.released) return false;
    item.released = true; this.#pumpAdmissions(); return true;
  }
  cancelAdmission(eventId, peer) {
    const item = this.#admissions.get(eventId);
    if (item?.peer !== peer || item.released) return;
    this.#admissions.delete(eventId); this.#admissionBytes -= item.bytes;
  }
  #pumpAdmissions() {
    if (this.#admissionScheduled || ![...this.#admissions.values()].some(item => item.released)) return;
    this.#admissionScheduled = true;
    const work = new Promise(resolve => setImmediate(() => {
      this.#admissionScheduled = false;
      const entry = [...this.#admissions].find(([, item]) => item.released);
      if (!entry) { resolve(); return; }
      const [eventId, item] = entry;
      this.#admissions.delete(eventId); this.#admissionBytes -= item.bytes;
      // A pre-OFF admission is already consent-bound and may finish afterward.
      // Disconnect cannot turn that item into a new admission or provider Send.
      this.#serial(async () => {
        try {
          item.boundary.save(item.observation, this.#session);
          await this.#commit({ operationId: eventId });
          this.#anchorBoundary = this.#session.anchorCheckpoint; this.#pumpAnchors();
        } catch (error) {
          emitCaptureFailure(this.#diagnostics, error, { operationId: eventId });
          emit(this.#diagnostics, 'CAPTURE_GAP', { operationId: eventId });
          this.#refreshCapacity();
        }
      }).finally(() => { this.#publish(); this.#pumpAdmissions(); resolve(); });
    }));
    this.#work.add(work); work.then(() => this.#work.delete(work));
  }
  capturePolicy(peer = undefined) {
    this.#refreshCapacity();
    return this.#sources.policies(!this.#closed && !this.#failed && !this.#capacityExhausted && this.#state.recording, peer);
  }
  captureStates(peer = undefined) {
    this.#refreshCapacity();
    return this.#sources.states(!this.#state.recording ? 'OFF' : this.#capacityExhausted ? 'VAULT_CAPACITY_EXHAUSTED'
      : this.#closed || this.#failed ? 'RECORDING_UNAVAILABLE' : 'READY', peer);
  }
  observe(input, options = {}, peer = undefined) {
    let admission;
    try { this.capturePolicy(peer); admission = this.#sources.prepare(input, options, peer); }
    catch (error) { return Promise.reject(error); }
    return this.#serial(async () => {
      const { observation, boundary } = admission;
      const { eventId, source } = observation;
      this.capturePolicy(peer);
      if (!this.#state.recording || this.#closed || this.#failed) reject('CAPTURE_NOT_ENABLED');
      if (this.#capacityExhausted) { this.#publish(); reject('VAULT_CAPACITY_EXHAUSTED'); }
      this.#sources.accept(admission);
      const prior = this.#session.version(eventId);
      let version;
      try {
        version = boundary.save(observation, this.#session);
        if (!prior && version.id === eventId) await this.#commit({ operationId: eventId });
      } catch (error) {
        if (error?.code === 'VAULT_CAPACITY_EXHAUSTED') {
          this.#refreshCapacity({ operationId: eventId }); this.#publish();
        } else if (boundary.primary(observation) && !['CAPTURE_REPLAY_CONFLICT', 'CAPTURE_CORRELATION_CONFLICT'].includes(error.message)) {
          this.#failed = true; this.#sources.revoke(); this.#publish();
          emit(this.#diagnostics, 'ENGINE_CAPTURE_DISABLED', { operationId: eventId });
        }
        if (!['CAPTURE_REPLAY_CONFLICT', 'CAPTURE_CORRELATION_CONFLICT'].includes(error.message)) {
          const receipt = this.#session.captureReceipt(eventId, source);
          if (receipt.state === 'PROMPT_SAVED') return receipt;
        }
        emit(this.#diagnostics, 'CAPTURE_GAP', { operationId: eventId }); throw error;
      }
      if (!prior && version.id === eventId) {
        this.#anchorBoundary = this.#session.anchorCheckpoint;
        this.#pumpAnchors();
      }
      this.#publish();
      return boundary.saved(observation, version);
    });
  }
  #pumpAnchors() {
    if (this.#closed || this.#refreshCapacity() || this.#anchorScheduled) return;
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
    if (this.#closed || this.#refreshCapacity()) return;
    const room = Math.min(32, 512 - this.#anchorQueue.length - this.#anchoring.size - this.#anchorRetries.size);
    // Seek the pending index; completed history never enters the runtime queue.
    if (room > 0 && this.#session.hasManagedAnchoring) {
      const page = this.#session.pendingPage(this.#anchorCursor, room, { before: this.#anchorBoundary + 1 });
      for (const version of page.versions) {
        this.#anchorCursor = version.sequence;
        if (!version.legacy && version.anchor === 'PENDING') this.#anchorQueue.push({ id: version.id, retry: 0 });
      }
    }
    while (!this.#closed && !this.#refreshCapacity() && this.#anchoring.size < 2 && this.#anchorQueue.length) {
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
        if (error?.code === 'VAULT_CAPACITY_EXHAUSTED') this.#refreshCapacity({ operationId: id });
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
    if (this.#closed || this.#refreshCapacity() || retry >= 2 || !version || version.anchor !== 'PENDING') return;
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
  captureReceipt(input, peer = undefined) { return this.#sources.receipt(input, this.#session, peer); }
  captureChannel(peer) {
    // A transport gets only its own namespace and no control or history API.
    return Object.freeze({
      observe: (input, options) => this.observe(input, options, peer),
      capturePolicy: () => this.capturePolicy(peer),
      captureStates: () => this.captureStates(peer),
      captureReceipt: input => this.captureReceipt(input, peer),
      admit: (input, options) => this.admit(input, peer, options),
      releaseAdmission: id => this.releaseAdmission(id, peer),
      cancelAdmission: id => this.cancelAdmission(id, peer),
    });
  }
  command(input, { surface } = {}) {
    let command;
    try {
      if (!['development', 'desktop', 'extension_panel'].includes(surface)) reject('UNTRUSTED_COMMAND_ORIGIN');
      if (!['SET_RECORDING', 'SET_INTEGRATION'].includes(input?.kind)) reject('INVALID_ENGINE_COMMAND');
      keys(input, ['profile', 'runtimeEpoch', 'controlProfile', 'commandId', 'expectedRevision', 'kind', 'enabled',
        ...(input.kind === 'SET_INTEGRATION' ? ['integrationId'] : [])]);
      if (input.profile !== ENGINE_COMMAND_PROFILE || input.controlProfile !== RECORDING_CONTROL_PROFILE
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
      if (command.kind === 'SET_INTEGRATION') {
        this.#sources.setIntegrationEnabled(command.integrationId, command.enabled);
        if (!command.enabled) for (const [id, item] of this.#admissions) if (item.peer.integrationId === command.integrationId) {
          this.#admissions.delete(id); this.#admissionBytes -= item.bytes;
        }
        await this.#commit();
        const ack = { profile: ENGINE_EVENT_PROFILE, commandId: command.commandId, runtimeEpoch: this.#epoch,
          revision: this.#state.revision, integrationId: command.integrationId, enabled: command.enabled };
        this.#commands.set(command.commandId, { fingerprint, ack }); return structuredClone(ack);
      }
      if (this.#refreshCapacity() && command.enabled) reject('VAULT_CAPACITY_EXHAUSTED');
      const previousRecording = this.#state.recording;
      if (this.#state.recording !== command.enabled) { this.#sources.revoke(); this.#admissionEpoch = randomUUID(); }
      this.#state.recording = command.enabled;
      // Publish revocation immediately; acknowledge the setting only after fsync.
      this.#publish();
      if (!await this.#commit() && command.enabled) {
        this.#state.recording = previousRecording; this.#publish(); reject('VAULT_CAPACITY_EXHAUSTED');
      }
      const ack = { profile: ENGINE_EVENT_PROFILE, commandId: command.commandId, runtimeEpoch: this.#epoch,
        revision: this.#state.revision, recording: this.#state.recording };
      this.#commands.set(command.commandId, { fingerprint, ack });
      emit(this.#diagnostics, command.enabled ? 'RECORDING_ENABLED' : 'RECORDING_DISABLED');
      return structuredClone(ack);
    });
  }
  async drain() { await this.#control; while (this.#work.size) await Promise.all(this.#work); }
  stop() {
    this.#closed = true; this.#sources.revoke(); this.#anchorQueue = [];
    for (const [id, item] of this.#admissions) if (!item.released) {
      this.#admissions.delete(id); this.#admissionBytes -= item.bytes;
    }
    for (const timer of this.#anchorRetries.values()) clearTimeout(timer);
    this.#anchorRetries.clear(); this.#unsubscribe?.(); this.#publish();
  }
}
