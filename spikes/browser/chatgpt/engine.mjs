import { createHash } from 'node:crypto';
import { canonical, keys } from '../../vault/format.mjs';
import { validateProtectedTextPayload } from '../../release/runtime.mjs';
import { emit } from '../../release/diagnostics.mjs';
import { CHATGPT_ADAPTER_ID, CHATGPT_ADAPTER_PROFILE } from './adapter.mjs';
import { EngineStateStore } from './engine-store.mjs';

export const ENGINE_COMMAND_PROFILE = 'pap-resident-command/1';
export const ENGINE_EVENT_PROFILE = 'pap-resident-event/1';
const modes = ['Off', 'Continuous', 'Sealed'];
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const reject = code => { throw Object.assign(Error(code), { code }); };
const fields = {
  ENROLL_SCOPE: ['target'], SET_PAUSE: ['paused'], SET_DEFAULT: ['mode'],
  SET_CONVERSATION_MODE: ['scope', 'mode'], PROTECT_AND_SEND: ['scope', 'operationId', 'text', 'editRevision'],
  DEVELOPMENT_FREEZE: ['scope', 'operationId', 'text', 'editRevision', 'mode'],
  CANCEL_OPERATION: ['operationId'],
};

function commandEnvelope(command) {
  if (!command || !Object.hasOwn(fields, command.kind)) reject('INVALID_ENGINE_COMMAND');
  keys(command, ['profile', 'runtimeEpoch', 'adapterProfile', 'commandId', 'expectedRevision', 'kind', ...fields[command.kind]]);
  if (command.profile !== ENGINE_COMMAND_PROFILE || command.adapterProfile !== CHATGPT_ADAPTER_PROFILE
      || !uuid(command.commandId) || !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0) {
    reject('ENGINE_CONTRACT_MISMATCH');
  }
  if (['PROTECT_AND_SEND', 'DEVELOPMENT_FREEZE'].includes(command.kind)) {
    if (!uuid(command.operationId) || !Number.isSafeInteger(command.editRevision) || command.editRevision < 0) reject('INVALID_OPERATION');
    validateProtectedTextPayload({ text: command.text, attachments: [] });
  }
  if (command.kind === 'DEVELOPMENT_FREEZE' && !['Continuous', 'Sealed', 'Always Protect'].includes(command.mode)) reject('INVALID_MODE');
  if (Object.hasOwn(command, 'scope') && !uuid(command.scope)) reject('INVALID_SCOPE');
  if (command.kind === 'CANCEL_OPERATION' && !uuid(command.operationId)) reject('INVALID_OPERATION');
  if (command.kind === 'SET_PAUSE' && typeof command.paused !== 'boolean') reject('INVALID_POLICY');
  if (['SET_DEFAULT', 'SET_CONVERSATION_MODE'].includes(command.kind)
      && !modes.includes(command.mode) && !(command.kind === 'SET_CONVERSATION_MODE' && command.mode === null)) reject('INVALID_POLICY');
  return structuredClone(command);
}

// The engine alone runs the workflow. Views hold selections and render snapshots;
// disconnecting one view cannot stop, retarget or replay an admitted operation.
export class ResidentEngine {
  #session; #adapter; #epoch; #store; #state; #diagnostics;
  #commands = new Map(); #control = Promise.resolve(); #writes = Promise.resolve(); #work = new Set();
  #listeners = new Set(); #knownScopes = new Map(); #unsubscribe; #closed = false; #failed = false;
  #operationIds = new Set(); #temporaryPreferences = new Map();

  constructor(directory, session, adapter, runtimeEpoch, diagnostics = null) {
    this.#session = session; this.#adapter = adapter; this.#epoch = runtimeEpoch; this.#diagnostics = diagnostics;
    this.#store = new EngineStateStore(directory, session.vault);
  }
  async init() {
    this.#state = await this.#store.load() ?? { revision: 0,
      preferences: { paused: false, defaultMode: 'Sealed', conversations: {} }, operations: [] };
    const preferences = this.#state.preferences;
    if (!Number.isSafeInteger(this.#state.revision) || this.#state.revision < 0
        || typeof preferences?.paused !== 'boolean' || !modes.includes(preferences.defaultMode)
        || !preferences.conversations || Array.isArray(preferences.conversations)
        || Object.keys(preferences.conversations).length > 256 || Object.values(preferences.conversations).some(mode => !modes.includes(mode))
        || !Array.isArray(this.#state.operations) || this.#state.operations.length > 512) reject('INVALID_ENGINE_HISTORY');
    const durable = this.#session.runtime.snapshot();
    for (const operation of this.#state.operations) {
      this.#operationIds.add(operation.id);
      const seal = durable.seals[operation.versionId], attempt = seal && durable.attempts[seal.priorAttempt];
      operation.stopped = true; operation.restored = true;
      operation.state = attempt?.state ?? (seal?.cancelled ? 'CANCELLED' : 'INTERRUPTED');
      if (operation.result) operation.result.actions = Object.fromEntries(Object.keys(operation.result.actions).map(key => [key, false]));
    }
    this.#session.setAuthorityCheck(version => !this.#closed && !this.#failed
      && this.#requested(version.scope) !== 'Off' && !this.#state.preferences.paused);
    this.#unsubscribe = this.#adapter.onChange(() => this.#adapterChanged());
    await this.#commit(); return this;
  }

  #requested(scope) {
    const target = this.#adapter.scopes().find(value => value.scope === scope);
    if (target?.destination === 'new-chat') return this.#temporaryPreferences.get(scope) ?? this.#state.preferences.defaultMode;
    const preferences = this.#state.preferences.conversations;
    return target && Object.hasOwn(preferences, target.destination) ? preferences[target.destination] : this.#state.preferences.defaultMode;
  }
  #scope(scope) {
    const target = this.#adapter.scopes().find(value => value.scope === scope);
    if (!target) reject('SCOPE_REVOKED');
    return target;
  }
  state() {
    const liveVersions = new Map(this.#session.status().versions.map(value => [value.id, value]));
    const durable = this.#session.runtime.snapshot();
    return structuredClone({ profile: ENGINE_EVENT_PROFILE, runtimeEpoch: this.#epoch, adapterProfile: CHATGPT_ADAPTER_PROFILE,
      revision: this.#state.revision, available: !this.#closed && !this.#failed, preferences: this.#state.preferences,
      capabilities: this.#adapter.capabilities, targets: this.#adapter.targets(),
      scopes: this.#adapter.scopes().map(target => {
        const requestedMode = this.#requested(target.scope);
        const effectiveMode = this.#state.preferences.paused || requestedMode === 'Off' ? 'Off'
          : target.eligibility !== 'ELIGIBLE' || this.#failed || this.#closed ? 'Unavailable'
            : requestedMode === 'Continuous' && !this.#adapter.capabilities.observation ? 'Unavailable' : requestedMode;
        return { ...target, requestedMode, effectiveMode,
          editRevision: this.#session.status().scopes.find(value => value.scope === target.scope)?.editRevision ?? 0,
          reason: this.#state.preferences.paused ? 'GLOBAL_PAUSE' : effectiveMode === 'Unavailable' ? 'CAPABILITY_UNAVAILABLE' : 'CURRENT' };
      }),
      operations: this.#state.operations.map(operation => {
        const result = structuredClone(liveVersions.get(operation.versionId) ?? operation.result);
        const seal = durable.seals[operation.versionId], attempt = seal && durable.attempts[seal.priorAttempt];
        const state = attempt ? (attempt.state === 'DISPATCHING' ? 'OUTCOME_UNKNOWN' : attempt.state)
          : result?.state === 'CANCELLED' ? 'CANCELLED' : operation.state;
        if (result && attempt) result.state = state;
        if (result && (operation.stopped || operation.restored || attempt)) {
          result.actions = Object.fromEntries(Object.keys(result.actions).map(key => [key, false]));
        }
        return { ...operation, state, ...(result ? { result } : {}) };
      }),
    });
  }
  subscribe(listener) {
    if (typeof listener !== 'function' || this.#listeners.size >= 32) reject('VIEW_LIMIT');
    this.#listeners.add(listener); listener(this.state());
    return () => this.#listeners.delete(listener);
  }
  #publish() {
    for (const listener of this.#listeners) { try { listener(this.state()); } catch {} }
  }
  #commit() {
    this.#state.revision++;
    const snapshot = structuredClone(this.#state);
    const write = this.#writes.then(() => this.#store.save(snapshot));
    this.#writes = write.catch(() => { this.#failed = true; emit(this.#diagnostics, 'VAULT_WRITE_FAILED'); });
    return write.then(() => { this.#publish(); });
  }
  #track(promise) {
    const work = promise.catch(() => { emit(this.#diagnostics, 'OPERATION_REJECTED'); })
      .finally(() => this.#work.delete(work));
    this.#work.add(work); return work;
  }
  #stopScopes(scopes) {
    for (const operation of this.#state.operations) {
      if (scopes.includes(operation.scope) && !operation.stopped) operation.stopped = true;
    }
    for (const scope of scopes) this.#track(this.#session.interruptScope(scope).then(() => this.#syncOperations()));
  }
  #adapterChanged() {
    if (this.#closed) return;
    const current = new Map(this.#adapter.scopes().map(value => [value.scope, value.eligibility]));
    // An authorized insertion temporarily makes its own composer nonempty.
    // Only the pending consumed attempt's exact current guard permits this;
    // identity, destination and permission failures still end authority.
    for (const [scope, eligibility] of current) {
      if (eligibility === 'TEMPORARILY_UNAVAILABLE' && this.#adapter.isScopeDispatchCurrent?.(scope)) current.set(scope, 'ELIGIBLE');
    }
    const ended = [...this.#knownScopes].filter(([scope, eligibility]) =>
      eligibility === 'ELIGIBLE' && current.get(scope) !== 'ELIGIBLE').map(([scope]) => scope);
    this.#knownScopes = current;
    this.#stopScopes(ended);
    this.#publish();
  }
  async #syncOperations() {
    const versions = new Map(this.#session.status().versions.map(value => [value.id, value]));
    const durable = this.#session.runtime.snapshot();
    for (const operation of this.#state.operations) {
      const result = versions.get(operation.versionId);
      const seal = durable.seals[operation.versionId], attempt = seal && durable.attempts[seal.priorAttempt];
      if (result) { operation.result = result;
        operation.state = attempt ? (attempt.state === 'DISPATCHING' ? 'OUTCOME_UNKNOWN' : attempt.state) : result.state;
      }
    }
    await this.#commit();
  }

  command(input, { surface } = {}) {
    let command;
    try {
      if (!['development', 'desktop', 'extension_panel'].includes(surface)) reject('UNTRUSTED_COMMAND_ORIGIN');
      command = commandEnvelope(input);
      if (command.kind === 'DEVELOPMENT_FREEZE' && surface !== 'development') reject('UNTRUSTED_COMMAND_ORIGIN');
      if (command.runtimeEpoch !== this.#epoch) reject('STALE_RUNTIME_EPOCH');
    } catch (error) { return Promise.reject(error); }
    const run = this.#control.then(() => this.#command(command));
    this.#control = run.catch(() => {}); return run;
  }
  async #command(command) {
    if (this.#closed || this.#failed) reject('ENGINE_UNAVAILABLE');
    const fingerprint = createHash('sha256').update(canonical(command)).digest('hex');
    const prior = this.#commands.get(command.commandId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) reject('COMMAND_REPLAY_CONFLICT');
      if (!prior.ack) reject('COMMAND_INTERRUPTED');
      return structuredClone(prior.ack);
    }
    if (command.expectedRevision !== this.#state.revision) reject('STALE_ENGINE_REVISION');
    if (this.#commands.size >= 4096) reject('COMMAND_LIMIT');
    let enrolled, operation;
    const allScopes = () => this.#adapter.scopes().map(value => value.scope);
    switch (command.kind) {
      case 'ENROLL_SCOPE': {
        keys(command.target, ['adapterId', 'adapterEpoch', 'tabId', 'windowId', 'tabEpoch', 'destination']);
        const target = this.#adapter.targets().find(value => value.tabId === command.target.tabId);
        if (!target || command.target.adapterId !== CHATGPT_ADAPTER_ID
            || Object.keys(command.target).some(key => command.target[key] !== target[key])) reject('ADAPTER_TARGET_MISMATCH');
        enrolled = this.#session.enroll(command.target); break;
      }
      case 'SET_PAUSE':
        if (command.paused !== this.#state.preferences.paused) {
          this.#state.preferences.paused = command.paused;
          if (command.paused) this.#stopScopes(allScopes());
        }
        break;
      case 'SET_DEFAULT': {
        const before = new Map(allScopes().map(scope => [scope, this.#requested(scope)]));
        this.#state.preferences.defaultMode = command.mode;
        this.#stopScopes(allScopes().filter(scope => before.get(scope) !== this.#requested(scope))); break;
      }
      case 'SET_CONVERSATION_MODE': {
        const target = this.#scope(command.scope), preferences = this.#state.preferences.conversations;
        if (target.destination === 'new-chat') {
          const before = this.#requested(command.scope);
          if (command.mode === null) this.#temporaryPreferences.delete(command.scope);
          else this.#temporaryPreferences.set(command.scope, command.mode);
          if (before !== this.#requested(command.scope)) this.#stopScopes([command.scope]);
          break;
        }
        if (!Object.hasOwn(preferences, target.destination) && Object.keys(preferences).length >= 256) reject('PREFERENCE_LIMIT');
        const before = this.#requested(command.scope);
        if (command.mode === null) delete preferences[target.destination];
        else Object.defineProperty(preferences, target.destination, { value: command.mode, configurable: true, enumerable: true, writable: true });
        if (before !== this.#requested(command.scope)) this.#stopScopes(this.#adapter.scopes()
          .filter(value => value.destination === target.destination).map(value => value.scope));
        break;
      }
      case 'PROTECT_AND_SEND':
      case 'DEVELOPMENT_FREEZE': {
        const target = this.#scope(command.scope);
        if (this.#state.preferences.paused || this.#requested(command.scope) === 'Off') reject('PROTECTION_PAUSED');
        this.#adapter.assertEligible(command.scope);
        if (this.#operationIds.has(command.operationId)) reject('OPERATION_ALREADY_EXISTS');
        if (this.#state.operations.length >= 512) {
          const index = this.#state.operations.findIndex(value => value.stopped || value.restored
            || ['SUBMISSION_OBSERVED', 'OUTCOME_UNKNOWN', 'FAILED_BEFORE_EGRESS', 'CANCELLED'].includes(value.state));
          if (index < 0) reject('OPERATION_LIMIT');
          this.#state.operations.splice(index, 1);
        }
        operation = { id: command.operationId, scope: command.scope, target, editRevision: command.editRevision,
          mode: command.mode ?? 'Sealed', state: 'ADMITTED', versionId: null, stopped: false, restored: false, settled: false };
        this.#operationIds.add(command.operationId);
        this.#state.operations.push(operation); break;
      }
      case 'CANCEL_OPERATION': {
        operation = this.#state.operations.find(value => value.id === command.operationId);
        if (!operation || operation.restored) reject('OPERATION_UNAVAILABLE');
        operation.stopped = true;
        if (operation.versionId) this.#track(this.#session.interruptVersion(operation.versionId).then(() => this.#syncOperations()));
        break;
      }
    }
    this.#commands.set(command.commandId, { fingerprint });
    await this.#commit();
    const ack = { profile: ENGINE_EVENT_PROFILE, runtimeEpoch: this.#epoch, revision: this.#state.revision,
      commandId: command.commandId, ...(enrolled ? { scope: enrolled.scope } : {}),
      ...(operation ? { operationId: operation.id } : {}) };
    this.#commands.set(command.commandId, { fingerprint, ack });
    if (['PROTECT_AND_SEND', 'DEVELOPMENT_FREEZE'].includes(command.kind)) {
      this.#track(this.#run(operation, command.text, command.kind === 'PROTECT_AND_SEND'));
    }
    return structuredClone(ack);
  }

  async #run(operation, text, autoRelease) {
    try {
      if (operation.stopped || this.#closed) { operation.state = 'INTERRUPTED'; return; }
      const version = await this.#session.freeze({ text, attachments: [], mode: operation.mode,
        scope: operation.scope, editRevision: operation.editRevision });
      operation.versionId = version.id; operation.result = version; operation.state = version.state;
      await this.#commit();
      if (operation.stopped || this.#closed) { await this.#session.interruptVersion(version.id); return; }
      const request = { id: version.id, scope: operation.scope, currentText: text, attachments: [], editRevision: operation.editRevision };
      const confirmed = await this.#session.anchorManaged(request);
      operation.result = confirmed; operation.state = confirmed.state; await this.#commit();
      if (operation.stopped || this.#closed) { await this.#session.interruptVersion(version.id); return; }
      if (autoRelease && confirmed.state === 'SEALED_NOT_SENT') await this.#session.release(request);
    } catch {
      // The durable release journal is authoritative even if recording the
      // outcome or publishing a view update failed after possible exposure.
      const seal = this.#session.runtime.snapshot().seals[operation.versionId];
      const attempt = seal && this.#session.runtime.snapshot().attempts[seal.priorAttempt];
      operation.state = attempt ? (attempt.state === 'DISPATCHING' ? 'OUTCOME_UNKNOWN' : attempt.state)
        : operation.stopped ? 'INTERRUPTED' : 'NEEDS_ATTENTION';
      emit(this.#diagnostics, 'OPERATION_REJECTED', operation.versionId ? { operationId: operation.versionId } : {});
    } finally {
      operation.settled = true;
      const version = this.#session.status().versions.find(value => value.id === operation.versionId);
      if (version) {
        operation.result = version;
        if (!['OUTCOME_UNKNOWN', 'NEEDS_ATTENTION', 'INTERRUPTED'].includes(operation.state)) operation.state = version.state;
      }
      await this.#commit();
    }
  }
  async drain() { await this.#control; while (this.#work.size) await Promise.all(this.#work); await this.#writes; }
  stop() {
    if (this.#closed) return;
    this.#closed = true; this.#unsubscribe?.();
    this.#stopScopes(this.#session.status().scopes.map(value => value.scope));
    this.#listeners.clear();
  }
}
