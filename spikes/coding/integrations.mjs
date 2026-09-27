import { randomUUID, createHash } from 'node:crypto';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { canonical, parseCanonical } from '../vault/format.mjs';
import { ownedDirectory, readOwned, atomicWrite, syncDirectory } from '../distribution/files.mjs';
import { editSettings, ownedHook, parseSettings, revision } from './settings.mjs';
import { HookHealth } from './health.mjs';

const LIMIT = 1024 * 1024;
const conflict = () => { throw Error('INTEGRATION_CONFIGURATION_CONFLICT'); };
async function executableIdentity(path, codeIdentity) {
  if (!isAbsolute(path)) conflict();
  const selected = await realpath(path), file = await open(selected, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 256 * 1024 * 1024 || info.mode & 0o022) conflict();
    const hash = createHash('sha256'), buffer = Buffer.alloc(65536); let script = false, first = true;
    for (;;) { const { bytesRead } = await file.read(buffer); if (!bytesRead) break;
      if (first) { script = buffer.subarray(0, 2).toString() === '#!'; first = false; }
      hash.update(buffer.subarray(0, bytesRead)); }
    if (script && info.size > 4 * 1024 * 1024) conflict();
    return { path: selected, sha256: hash.digest('hex'), script,
      ...(script ? {} : { codeHash: await codeIdentity(selected) }) };
  } finally { await file.close(); }
}

async function discoverExecutable(client) {
  const candidates = client === 'codex' ? ['/Applications/ChatGPT.app/Contents/Resources/codex', '/Applications/Codex.app/Contents/Resources/codex', '/opt/homebrew/bin/codex', '/usr/local/bin/codex']
    : [join(homedir(), '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
  for (const path of candidates) try { await lstat(path); return path; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  throw Error('SELECT_CLIENT_EXECUTABLE');
}

export class CodingIntegrations {
  #directory; #receiver; #roots; #entries = {}; #plans = new Map(); #tail = Promise.resolve(); #setEnabled; #codeIdentity;
  #listeners = new Set(); #health;
  constructor({ directory, receiver, configRoots, setEnabled, codeIdentity, diagnostics = null, health = new HookHealth({ diagnostics }) }) {
    if (![directory, receiver, ...Object.values(configRoots)].every(value => isAbsolute(value) && resolve(value) === value)
        || typeof setEnabled !== 'function' || typeof codeIdentity !== 'function') throw Error('INVALID_INTEGRATION_CONFIGURATION');
    this.#directory = directory; this.#receiver = receiver; this.#roots = { ...configRoots }; this.#setEnabled = setEnabled;
    this.#codeIdentity = codeIdentity;
    this.#health = health;
  }
  get health() { return this.#health; }
  onChange(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  #changed(client) { this.#health.reset(client); for (const listener of this.#listeners) listener(); }
  get #journal() { return join(this.#directory, 'coding-integrations.json'); }
  async init() {
    await ownedDirectory(this.#directory);
    const bytes = await readOwned(this.#journal, 64 * 1024);
    if (bytes) {
      const value = parseCanonical(bytes, 64 * 1024);
      if (value.profile !== 'pap-coding-integrations/1' || !value.entries || Object.keys(value.entries).some(key => !['codex', 'claude-code'].includes(key))) conflict();
      for (const [client, entry] of Object.entries(value.entries)) {
        if (!entry || entry.client !== client || !isAbsolute(entry.configPath) || !isAbsolute(entry.configRoot)
            || dirname(entry.configPath) !== entry.configRoot || !['settings.json', 'hooks.json', 'config.toml'].includes(entry.configPath.split('/').at(-1))
            || !/^[a-f0-9-]{36}$/.test(entry.installationId ?? '') || !Array.isArray(entry.hook?.hooks)
            || !['configured', 'pending', 'removed'].includes(entry.state)) conflict();
      }
      this.#entries = value.entries;
      for (const client of Object.keys(this.#entries)) await this.#recover(client);
    }
    return this;
  }
  #save() { return atomicWrite(this.#journal, canonical({ profile: 'pap-coding-integrations/1', entries: this.#entries })); }
  async #recover(client) {
    const entry = this.#entries[client];
    if (entry?.state !== 'pending') return;
    const bytes = await readOwned(entry.configPath, LIMIT), actual = revision(bytes);
    if (actual === entry.afterRevision || entry.action === 'remove' && entry.created && bytes === null) {
      const { previousEntry: _previous, afterRevision: _after, ...record } = entry;
      this.#entries[client] = { ...record, state: entry.action === 'install' ? 'configured' : 'removed' };
    } else if (actual === entry.beforeRevision) {
      if (entry.previousEntry) this.#entries[client] = entry.previousEntry;
      else delete this.#entries[client];
    } else return;
    this.#changed(client);
    await this.#save(); // Recovery never enables capture or restores a whole configuration.
  }
  enrollment(client, installationId) {
    const entry = this.#entries[client];
    return entry?.state === 'configured' && entry.installationId === installationId ? structuredClone(entry) : null;
  }
  async status() {
    return Promise.all(['codex', 'claude-code'].map(async client => {
      const entry = this.#entries[client];
      const hookHealth = this.#health.status(client);
      if (!entry || entry.state === 'removed') return { id: client, configured: false, state: 'NOT_CONFIGURED', hookHealth, connected: false };
      let intact = false;
      try {
        if (await ownedDirectory(entry.configRoot, { create: false })) {
          const bytes = await readOwned(entry.configPath, LIMIT);
          const value = bytes && parseSettings(new TextDecoder('utf8', { fatal: true }).decode(bytes), entry.format);
          intact = value?.hooks?.UserPromptSubmit?.some(group => isDeepStrictEqual(group, entry.hook)) ?? false;
        }
      } catch {}
      return { id: client, configured: intact && entry.state === 'configured', state: !intact ? 'CONFIGURATION_CONFLICT'
        : entry.state === 'pending' ? 'REPAIR_REQUIRED' : hookHealth.lastObserved === 'NEVER_OBSERVED'
          ? client === 'codex' ? 'TRUST_REQUIRED' : 'CONFIGURED' : `HOOK_${hookHealth.lastObserved}`,
        configPath: entry.configPath, installationId: entry.installationId, origin: 'ENROLLED_LOCAL_EXECUTABLE',
        restartRequired: true, connected: false, hookHealth };
    }));
  }
  async preview({ client, action = 'install', configRoot, clientExecutable, clientInterpreter }) {
    if (!['codex', 'claude-code'].includes(client) || !['install', 'remove'].includes(action)) conflict();
    await this.#recover(client);
    const old = this.#entries[client], active = old && old.state !== 'removed';
    if (old?.state === 'pending') conflict();
    const root = configRoot ?? (active ? old.configRoot : this.#roots[client]);
    if (!isAbsolute(root) || resolve(root) !== root || active && root !== old.configRoot) conflict();
    const exists = await ownedDirectory(root, { create: false });
    let configPath = active ? old.configPath : join(root, client === 'codex' ? 'hooks.json' : 'settings.json');
    let format = active ? old.format : 'json';
    const config = client === 'codex' && exists ? await readOwned(join(root, 'config.toml'), LIMIT) : null;
    const inline = config && Object.hasOwn(parseSettings(new TextDecoder('utf8', { fatal: true }).decode(config), 'toml'), 'hooks');
    if (!active && inline) { configPath = join(root, 'config.toml'); format = 'toml'; }
    if (client === 'codex' && inline && await readOwned(join(root, 'hooks.json'), LIMIT)) conflict();
    if (active && inline && format !== 'toml') conflict();
    const before = exists ? await readOwned(configPath, LIMIT) : null;
    const text = before ? new TextDecoder('utf8', { fatal: true }).decode(before) : format === 'json' ? '{}\n' : '';
    const installationId = active ? old.installationId : randomUUID();
    const identity = action === 'install' ? await executableIdentity(clientExecutable ?? old?.executable?.path ?? await discoverExecutable(client), this.#codeIdentity) : old?.executable;
    if (action === 'install' && identity.script) {
      const interpreter = clientInterpreter ?? old?.executable?.interpreter?.path;
      if (!interpreter) throw Error('SELECT_CLIENT_INTERPRETER');
      identity.interpreter = await executableIdentity(interpreter, this.#codeIdentity);
      if (identity.interpreter.script) conflict();
    }
    const hook = ownedHook(client, this.#receiver, installationId);
    const previous = active ? old.hook : null;
    if (action === 'remove' && !active) return { state: 'NOT_CONFIGURED', client, changes: [] };
    const edited = editSettings({ text, format, client, installationId, previous,
      next: action === 'install' ? hook : null, fragment: old?.fragment });
    const operationId = randomUUID(), plan = { operationId, client, action, configRoot: root, configPath, format,
      installationId, hook, executable: identity, fragment: edited.fragment, beforeRevision: revision(before),
      existed: before !== null, created: active ? old.created : before === null, content: Buffer.from(edited.text),
      configRevision: config ? revision(config) : null };
    if (this.#plans.size >= 8) this.#plans.delete(this.#plans.keys().next().value);
    this.#plans.set(operationId, plan);
    return { operationId, client, action, configPath, beforeRevision: plan.beforeRevision,
      changes: [{ file: configPath, operation: action === 'install' ? active ? 'UPDATE_OWNED_HOOK' : 'ADD_USER_HOOK' : 'REMOVE_OWNED_HOOK',
        hook: action === 'install' ? hook : previous }],
      consent: 'This integration joins recording when enabled and the global recording preference is ON.',
      trustRequired: client === 'codex', restartRequired: true, evidence: 'RETAINED', keys: 'RETAINED' };
  }
  apply({ operationId, consent }) {
    if (consent !== true) return Promise.reject(Error('INTEGRATION_CONSENT_REQUIRED'));
    const operation = this.#tail.then(() => this.#apply(operationId)); this.#tail = operation.catch(() => {}); return operation;
  }
  async #apply(operationId) {
    const plan = this.#plans.get(operationId);
    if (!plan) conflict();
    this.#plans.delete(operationId);
    // Revocation precedes registration removal/repair, including failed writes.
    await this.#setEnabled(plan.client, false);
    await ownedDirectory(plan.configRoot);
    const current = await readOwned(plan.configPath, LIMIT);
    if (revision(current) !== plan.beforeRevision || (current !== null) !== plan.existed) conflict();
    if (plan.client === 'codex') {
      const config = await readOwned(join(plan.configRoot, 'config.toml'), LIMIT);
      if ((config ? revision(config) : null) !== plan.configRevision) conflict();
    }
    if (plan.action === 'install') {
      const currentIdentity = await executableIdentity(plan.executable.path, this.#codeIdentity);
      const { interpreter, ...selectedIdentity } = plan.executable;
      if (!isDeepStrictEqual(currentIdentity, selectedIdentity)) conflict();
      if (interpreter && !isDeepStrictEqual(await executableIdentity(interpreter.path, this.#codeIdentity), interpreter)) conflict();
    }
    const { content, existed: _existed, configRevision: _configRevision, ...record } = plan;
    this.#entries[plan.client] = { ...record, state: 'pending', afterRevision: revision(content), previousEntry: this.#entries[plan.client] ?? null };
    this.#changed(plan.client); await this.#save();
    const temporary = `${plan.configPath}.attestamp-${operationId}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
      // Recheck after staging; an editor's changed revision requires a new preview.
      if (revision(await readOwned(plan.configPath, LIMIT)) !== plan.beforeRevision) conflict();
      await rename(temporary, plan.configPath); await syncDirectory(plan.configRoot);
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    if (plan.action === 'remove' && plan.created) {
      const remaining = parseSettings(content.toString('utf8'), plan.format);
      if (Object.keys(remaining).every(key => key === 'hooks') && Object.keys(remaining.hooks ?? {}).every(key => key === 'UserPromptSubmit')
          && !(remaining.hooks?.UserPromptSubmit?.length)) {
        if (revision(await readOwned(plan.configPath, LIMIT)) !== revision(content)) conflict();
        await unlink(plan.configPath); await syncDirectory(plan.configRoot);
      }
    }
    delete this.#entries[plan.client].previousEntry; delete this.#entries[plan.client].afterRevision;
    this.#entries[plan.client].state = plan.action === 'install' ? 'configured' : 'removed';
    this.#changed(plan.client); await this.#save();
    if (plan.action === 'install') await this.#setEnabled(plan.client, true);
    return { client: plan.client, state: plan.action === 'remove' ? 'REMOVED' : plan.client === 'codex' ? 'TRUST_REQUIRED' : 'CONFIGURED',
      evidence: 'RETAINED', keys: 'RETAINED', restartRequired: true };
  }
}
