import { unlink } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { canonical, keys, parseCanonical } from '../vault/format.mjs';
import { atomicWrite, ownedDirectory, readOwned, syncDirectory } from './files.mjs';
import { RELEASE_CHANNELS } from './config.mjs';
import { distributionError } from './release.mjs';

export const EXTENSION_ID = 'medilhopfckldjgdnchfkpmfmfnkadca';
export const STORE_URL = `https://chromewebstore.google.com/detail/${EXTENSION_ID}`;
const EVENTS = ['launch', 'integrationEnabled', 'storeOpened', 'paired', 'exportOffered', 'integrationRemoved', 'updateChecked', 'updateDownloaded'];
const PRODUCTION_STATE_FILE = 'installation.json';
const CANDIDATE_STATE_FILE = 'installation.release-candidate.json';
const PRODUCTION_STATE_PROFILE = 'pap-installation/1';
const CANDIDATE_STATE_PROFILE = 'pap-release-candidate-installation/1';

export class InstallationLifecycle {
  #directory; #manifestDirectory; #executable; #sequence; #releaseChannel; #state; #exportOffered = false; #tail = Promise.resolve();
  constructor({ supportDirectory, chromeSupportDirectory, browserHost, sequence, releaseChannel = RELEASE_CHANNELS.PRODUCTION }) {
    if (![supportDirectory, chromeSupportDirectory, browserHost].every(isAbsolute)
        || !Number.isSafeInteger(sequence) || sequence < 1
        || !Object.values(RELEASE_CHANNELS).includes(releaseChannel)) throw distributionError('INVALID_INSTALL_CONFIGURATION');
    this.#directory = supportDirectory;
    this.#manifestDirectory = join(chromeSupportDirectory, 'NativeMessagingHosts');
    this.#executable = browserHost; this.#sequence = sequence; this.#releaseChannel = releaseChannel;
  }
  get manifestPath() { return join(this.#manifestDirectory, 'ai.provenance.consumer.json'); }
  // Candidate runs must never advance the production rollback floor.
  get #statePath() { return join(this.#directory, this.#releaseChannel === RELEASE_CHANNELS.CANDIDATE ? CANDIDATE_STATE_FILE : PRODUCTION_STATE_FILE); }
  get #stateProfile() { return this.#releaseChannel === RELEASE_CHANNELS.CANDIDATE ? CANDIDATE_STATE_PROFILE : PRODUCTION_STATE_PROFILE; }
  #manifest() { return { name: 'ai.provenance.consumer', description: 'Private Provenance fixed-purpose ChatGPT bridge',
    path: this.#executable, type: 'stdio', allowed_origins: [`chrome-extension://${EXTENSION_ID}/`] }; }
  async init() {
    await ownedDirectory(this.#directory);
    const bytes = await readOwned(this.#statePath);
    const candidate = this.#releaseChannel === RELEASE_CHANNELS.CANDIDATE;
    this.#state = bytes ? parseCanonical(bytes, 16 * 1024) : {
      profile: this.#stateProfile, ...(candidate ? { releaseChannel: RELEASE_CHANNELS.CANDIDATE } : {}),
      installedSequence: this.#sequence, highestSeen: this.#sequence,
      integrationPath: null, events: Object.fromEntries(EVENTS.map(name => [name, 0])),
    };
    const state = this.#state;
    keys(state, candidate
      ? ['profile', 'releaseChannel', 'installedSequence', 'highestSeen', 'integrationPath', 'events']
      : ['profile', 'installedSequence', 'highestSeen', 'integrationPath', 'events']); keys(state.events, EVENTS);
    if (state.profile !== this.#stateProfile || (candidate && state.releaseChannel !== RELEASE_CHANNELS.CANDIDATE)
        || !Number.isSafeInteger(state.installedSequence)
        || state.installedSequence < 1 || !Number.isSafeInteger(state.highestSeen) || state.highestSeen < state.installedSequence
        || (state.integrationPath !== null && (typeof state.integrationPath !== 'string' || !isAbsolute(state.integrationPath)))
        || Object.values(state.events).some(value => !Number.isSafeInteger(value) || value < 0 || value > 1_000_000)) {
      throw distributionError('INVALID_INSTALL_STATE');
    }
    // This check runs before the vault is opened or migrated. A repair release
    // must carry a new sequence, even when it restores older application code.
    if (this.#sequence < state.installedSequence) throw distributionError('APPLICATION_ROLLBACK_REJECTED');
    state.installedSequence = this.#sequence; state.highestSeen = Math.max(state.highestSeen, this.#sequence);
    await this.record('launch'); return this;
  }
  #serial(operation) {
    const next = this.#tail.then(operation); this.#tail = next.catch(() => {}); return next;
  }
  async #save() { await atomicWrite(this.#statePath, canonical(this.#state)); }
  record(event) {
    if (!EVENTS.includes(event)) throw distributionError('INVALID_INSTALL_EVENT');
    return this.#serial(async () => {
      if (event === 'exportOffered') this.#exportOffered = true;
      this.#state.events[event] = Math.min(this.#state.events[event] + 1, 1_000_000); await this.#save();
    });
  }
  get highestSeen() { return this.#state.highestSeen; }
  rememberRelease(sequence) {
    return this.#serial(async () => {
      if (!Number.isSafeInteger(sequence) || sequence < this.#state.highestSeen) throw distributionError('UPDATE_ROLLBACK_REJECTED');
      this.#state.highestSeen = sequence; await this.#save();
    });
  }
  async status() {
    if (!await ownedDirectory(this.#manifestDirectory, { create: false })) {
      return { integration: 'DISABLED', storeURL: STORE_URL, releaseChannel: this.#releaseChannel,
        releaseClass: this.#releaseChannel === RELEASE_CHANNELS.CANDIDATE ? 'RELEASE_CANDIDATE' : 'PRODUCTION' };
    }
    const bytes = await readOwned(this.manifestPath);
    let installed = false;
    if (bytes) { try { installed = canonical(JSON.parse(bytes)) === canonical(this.#manifest()); } catch {} }
    return { integration: installed ? 'ENABLED' : bytes ? 'CONFLICT' : 'DISABLED', storeURL: STORE_URL,
      releaseChannel: this.#releaseChannel,
      releaseClass: this.#releaseChannel === RELEASE_CHANNELS.CANDIDATE ? 'RELEASE_CANDIDATE' : 'PRODUCTION' };
  }
  enable() {
    return this.#serial(async () => {
      await ownedDirectory(this.#manifestDirectory);
      const previous = await readOwned(this.manifestPath);
      if (previous) {
        let value; try { value = JSON.parse(previous); } catch { throw distributionError('INTEGRATION_CONFLICT'); }
        const expected = { ...this.#manifest(), path: this.#state.integrationPath ?? this.#executable };
        if (canonical(value) !== canonical(expected) && canonical(value) !== canonical(this.#manifest())) {
          throw distributionError('INTEGRATION_CONFLICT');
        }
      }
      await atomicWrite(this.manifestPath, canonical(this.#manifest()));
      this.#state.integrationPath = this.#executable;
      this.#state.events.integrationEnabled = Math.min(this.#state.events.integrationEnabled + 1, 1_000_000);
      await this.#save(); return this.status();
    });
  }
  remove({ exportDecision }) {
    return this.#serial(async () => {
      if (!['exported', 'keep-local'].includes(exportDecision) || !this.#exportOffered) {
        throw distributionError('EXPORT_OPPORTUNITY_REQUIRED');
      }
      await ownedDirectory(this.#manifestDirectory);
      const bytes = await readOwned(this.manifestPath);
      if (bytes) {
        let value; try { value = JSON.parse(bytes); } catch { throw distributionError('INTEGRATION_CONFLICT'); }
        const expected = { ...this.#manifest(), path: this.#state.integrationPath ?? this.#executable };
        if (canonical(value) !== canonical(expected)) throw distributionError('INTEGRATION_CONFLICT');
        await unlink(this.manifestPath); await syncDirectory(this.#manifestDirectory);
      }
      this.#state.integrationPath = null;
      this.#exportOffered = false;
      this.#state.events.integrationRemoved = Math.min(this.#state.events.integrationRemoved + 1, 1_000_000);
      await this.#save();
      return { integration: 'DISABLED', evidence: 'RETAINED', keys: 'RETAINED' };
    });
  }
  diagnostics({ paired = false, update = 'NOT_CHECKED' } = {}) {
    return { profile: 'pap-support/1', appSequence: this.#sequence, platform: 'darwin-arm64',
      releaseChannel: this.#releaseChannel,
      releaseClass: this.#releaseChannel === RELEASE_CHANNELS.CANDIDATE ? 'RELEASE_CANDIDATE' : 'PRODUCTION',
      pairing: paired === true ? 'PAIRED' : 'UNPAIRED',
      update: ['NOT_CHECKED', 'CURRENT', 'AVAILABLE', 'DOWNLOADED', 'UNAVAILABLE', 'REJECTED'].includes(update) ? update : 'REJECTED',
      events: { ...this.#state.events },
      // OS/store prompts require an instrumented, installed release candidate;
      // application button counts must never be reported as those measurements.
      externalMeasurements: { osPermissionSteps: null, storePermissionSteps: null, installedPairingMs: null } };
  }
}
