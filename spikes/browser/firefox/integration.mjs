import { randomUUID } from 'node:crypto';
import { dirname, join, isAbsolute } from 'node:path';
import { open, rename, unlink } from 'node:fs/promises';
import { canonical, parseCanonical } from '../../vault/format.mjs';
import { atomicWrite, readOwned, ownedDirectory, syncDirectory } from '../../distribution/files.mjs';
import { revision } from '../../coding/settings.mjs';
import { FIREFOX_EXTENSION_ID } from '../shared/profiles.mjs';

export class FirefoxIntegration {
  #journal; #path; #manifest; #owned = null; #pending = null; #plans = new Map(); #setEnabled; #tail = Promise.resolve(); #failpoint;
  constructor({ supportDirectory, manifestDirectory, receiver, extensionId = FIREFOX_EXTENSION_ID, setEnabled, failpoint = async () => {} }) {
    if (![supportDirectory, manifestDirectory, receiver].every(isAbsolute)) throw Error('UNSAFE_INSTALL_PATH');
    this.#journal = join(supportDirectory, 'firefox-integration.json');
    this.#path = join(manifestDirectory, 'ai.provenance.consumer.firefox.json'); this.#setEnabled = setEnabled;
    this.#failpoint = failpoint;
    this.#manifest = { name: 'ai.provenance.consumer.firefox', description: 'Attestamp Firefox bridge', path: receiver,
      type: 'stdio', allowed_extensions: [extensionId] };
  }
  async init() {
    const bytes = await readOwned(this.#journal);
    if (bytes) {
      const value = parseCanonical(bytes);
      if (!['pap-firefox-installation/1', 'pap-firefox-installation/2'].includes(value.profile)
          || value.path !== this.#path) throw Error('INTEGRATION_CONFIGURATION_CONFLICT');
      this.#owned = value.manifest;
      this.#pending = value.profile === 'pap-firefox-installation/2' ? value.pending : null;
      if (this.#pending && (!['install', 'remove'].includes(this.#pending.action)
          || typeof this.#pending.before !== 'string' || typeof this.#pending.after !== 'string')) throw Error('INTEGRATION_CONFIGURATION_CONFLICT');
      await this.#recover();
    }
    return this;
  }
  async #read() {
    return await ownedDirectory(dirname(this.#path), { create: false }) ? readOwned(this.#path) : null;
  }
  #save() { return atomicWrite(this.#journal, canonical({ profile: 'pap-firefox-installation/2', path: this.#path,
    manifest: this.#owned, pending: this.#pending })); }
  async #recover() {
    if (!this.#pending) return;
    const actual = revision(await this.#read()), pending = this.#pending;
    if (actual === pending.after) this.#owned = pending.manifest;
    else if (actual !== pending.before) return;
    this.#pending = null;
    await this.#save(); // Recover ownership only; never enable or overwrite a third-party edit.
  }
  async status() {
    if (this.#pending) return { id: 'firefox-chatgpt', configured: false, state: 'REPAIR_REQUIRED', connected: false };
    if (!this.#owned) return { id: 'firefox-chatgpt', configured: false, state: 'NOT_CONFIGURED',
      persistentInstallation: 'MOZILLA_SIGNED_XPI_REQUIRED', configPath: this.#path, connected: false };
    let bytes; try { bytes = await this.#read(); } catch { return { id: 'firefox-chatgpt', configured: false, state: 'CONFIGURATION_CONFLICT' }; }
    let match = false;
    try { match = bytes && canonical(JSON.parse(bytes)) === canonical(this.#owned ?? this.#manifest); } catch {}
    return { id: 'firefox-chatgpt', configured: Boolean(match), state: match ? 'EXTENSION_INSTALL_REQUIRED' : bytes ? 'CONFIGURATION_CONFLICT' : 'NOT_CONFIGURED',
      persistentInstallation: 'MOZILLA_SIGNED_XPI_REQUIRED', configPath: this.#path, restartRequired: true, connected: false };
  }
  async preview({ action = 'install' } = {}) {
    if (!['install', 'remove'].includes(action)) throw Error('INVALID_INTEGRATION_ACTION');
    await this.#recover();
    if (this.#pending) throw Error('INTEGRATION_CONFIGURATION_CONFLICT');
    const bytes = await this.#read();
    if (bytes && (!this.#owned || canonical(JSON.parse(bytes)) !== canonical(this.#owned))) throw Error('INTEGRATION_CONFIGURATION_CONFLICT');
    const operationId = randomUUID();
    if (this.#plans.size >= 8) this.#plans.delete(this.#plans.keys().next().value);
    this.#plans.set(operationId, { action, before: revision(bytes), exists: bytes !== null });
    return { operationId, client: 'firefox-chatgpt', action, configPath: this.#path,
      changes: [{ file: this.#path, operation: action === 'install' ? 'REGISTER_NATIVE_HOST' : 'REMOVE_NATIVE_HOST', manifest: this.#manifest }],
      consent: 'Firefox joins recording when enabled and the global recording preference is ON. Install the extension separately in Firefox.',
      evidence: 'RETAINED', keys: 'RETAINED' };
  }
  apply({ operationId, consent }) {
    if (consent !== true) return Promise.reject(Error('INTEGRATION_CONSENT_REQUIRED'));
    const operation = this.#tail.then(async () => {
      const plan = this.#plans.get(operationId); this.#plans.delete(operationId);
      if (!plan) throw Error('INTEGRATION_CONFIGURATION_CONFLICT');
      await this.#setEnabled('firefox-chatgpt', false);
      const bytes = await this.#read();
      if (revision(bytes) !== plan.before || (bytes !== null) !== plan.exists) throw Error('INTEGRATION_CONFIGURATION_CONFLICT');
      const manifest = plan.action === 'install' ? structuredClone(this.#manifest) : null;
      const content = manifest ? Buffer.from(canonical(manifest)) : null;
      this.#pending = { action: plan.action, before: plan.before, after: revision(content), manifest };
      await this.#save();
      await this.#failpoint('journal-written');
      await ownedDirectory(dirname(this.#path));
      const temporary = `${this.#path}.${operationId}.tmp`;
      try {
        if (content) {
          const file = await open(temporary, 'wx', 0o600);
          try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
        }
        await this.#failpoint('manifest-staged');
        if (revision(await this.#read()) !== plan.before) throw Error('INTEGRATION_CONFIGURATION_CONFLICT');
        if (content) await rename(temporary, this.#path);
        else if (bytes) await unlink(this.#path);
        await syncDirectory(dirname(this.#path));
      } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      await this.#failpoint('manifest-replaced');
      this.#owned = manifest; this.#pending = null; await this.#save();
      if (plan.action === 'install') await this.#setEnabled('firefox-chatgpt', true);
      return this.status();
    });
    this.#tail = operation.catch(() => {}); return operation;
  }
}
