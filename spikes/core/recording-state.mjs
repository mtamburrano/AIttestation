import { parseCanonical } from '../vault/format.mjs';

export class EngineStateStore {
  constructor(files, vault) { this.files = files; this.vault = vault; }
  async load() {
    const snapshot = await this.#loadSnapshot();
    try {
      const off = await this.files.read('engine-recording-off');
      if (off !== 'OFF\n') throw Error('INVALID_RECORDING_REVOCATION');
      return { profile: 'pap-resident-state/2', state: { ...migrateRecordingState(snapshot), recording: false } };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return snapshot;
  }
  async #loadSnapshot() {
    const current = this.vault.readState('recording-preference');
    if (current) return current;
    let id;
    try { id = await this.files.read('engine-pointer'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw Error('INVALID_ENGINE_POINTER');
    const record = this.vault.getRecord(id);
    if (!record) throw Error('ENGINE_HISTORY_MISSING');
    const decoded = parseCanonical(this.vault.read(record.manifest.evidence[0].objectDigest), 16 * 1024 * 1024);
    return { profile: decoded.profile, state: decoded.state };
  }
  async save(state) {
    this.vault.writeState('recording-preference', { profile: 'pap-resident-state/2', state });
    if (state.recording) {
      await this.files.remove('engine-recording-off');
    }
  }
  // This latch can only revoke consent. Clearing it requires a new durable ON
  // preference, so exhaustion and interrupted writes cannot silently resume capture.
  async revokeRecording() { await this.files.write('engine-recording-off', 'OFF\n'); }
}

// Only the exact known legacy global configuration can carry consent forward.
// Missing pointers (including restored installations) and future formats are OFF.
export function migrateRecordingState(snapshot) {
  const fresh = reason => ({ revision: 0, recording: false, migration: reason });
  if (!snapshot) return fresh('NEW_OR_RECOVERED');
  const state = snapshot.state;
  if (snapshot.profile === 'pap-resident-state/2') {
    if (!state || Object.keys(state).sort().join(',') !== 'migration,recording,revision'
        || !Number.isSafeInteger(state.revision) || state.revision < 0 || state.revision >= Number.MAX_SAFE_INTEGER
        || typeof state.recording !== 'boolean'
        || !['NEW_OR_RECOVERED', 'LEGACY_GLOBAL', 'EXPLICIT_OPT_IN_REQUIRED'].includes(state.migration)) {
      return fresh('EXPLICIT_OPT_IN_REQUIRED');
    }
    return structuredClone(state);
  }
  const preferences = state?.preferences;
  const unambiguous = snapshot.profile === 'pap-resident-state/1'
    && state && Object.keys(state).sort().join(',') === 'operations,preferences,revision'
    && Number.isSafeInteger(state.revision) && state.revision >= 0 && Array.isArray(state.operations)
    && preferences && Object.keys(preferences).sort().join(',') === 'conversations,defaultMode,paused'
    && preferences.paused === false && preferences.defaultMode === 'Continuous'
    && preferences.conversations && typeof preferences.conversations === 'object'
    && !Array.isArray(preferences.conversations) && Object.keys(preferences.conversations).length === 0;
  return { revision: 0, recording: Boolean(unambiguous),
    migration: unambiguous ? 'LEGACY_GLOBAL' : 'EXPLICIT_OPT_IN_REQUIRED' };
}
