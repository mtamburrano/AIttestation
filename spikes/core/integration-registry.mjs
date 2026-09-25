import { randomUUID } from 'node:crypto';
import { keys } from '../vault/format.mjs';

const fail = code => { throw Object.assign(Error(code), { code }); };
const identifier = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value);

export class IntegrationRegistry {
  #definitions; #vault; #enabled; #generations = new Map();
  constructor(vault, definitions) {
    if (!Array.isArray(definitions) || !definitions.length || definitions.length > 8
        || definitions.some(value => !identifier(value.id) || typeof value.previouslyEnabled !== 'boolean'
          || typeof value.supported !== 'boolean') || new Set(definitions.map(value => value.id)).size !== definitions.length) {
      fail('INVALID_INTEGRATION_DEFINITIONS');
    }
    this.#vault = vault;
    this.#definitions = new Map(definitions.map(value => [value.id, Object.freeze({ ...value })]));
    const saved = vault.readState('integrations');
    if (saved) {
      keys(saved, ['profile', 'enabled']);
      if (saved.profile !== 'pap-integrations/1' || !saved.enabled || Array.isArray(saved.enabled)
          || typeof saved.enabled !== 'object' || Object.keys(saved.enabled).length > 8
          || Object.entries(saved.enabled).some(([id, value]) => !identifier(id) || typeof value !== 'boolean')) {
        fail('INVALID_INTEGRATION_STATE');
      }
    }
    this.#enabled = Object.fromEntries(definitions.map(value => [value.id, saved
      ? saved.enabled[value.id] === true : value.previouslyEnabled]));
    this.revoke();
  }
  #definition(id) { const definition = this.#definitions.get(id); if (!definition) fail('UNKNOWN_INTEGRATION'); return definition; }
  enabled(id) { this.#definition(id); return this.#enabled[id]; }
  available(id) { return this.enabled(id) && this.#definition(id).supported; }
  generation(id) { this.#definition(id); return this.#generations.get(id); }
  revoke(id) {
    if (id !== undefined) { this.#definition(id); this.#generations.set(id, randomUUID()); }
    else for (const key of this.#definitions.keys()) this.#generations.set(key, randomUUID());
  }
  setEnabled(id, enabled) {
    const definition = this.#definition(id);
    if (typeof enabled !== 'boolean') fail('INVALID_INTEGRATION_STATE');
    if (enabled && !definition.supported) fail(definition.unavailableReason ?? 'INTEGRATION_UNSUPPORTED');
    if (this.#enabled[id] === enabled) return;
    // Revocation precedes I/O. A failed write cannot restore the old authority.
    this.revoke(id);
    if (!enabled) this.#enabled[id] = false;
    this.#vault.writeState('integrations', { profile: 'pap-integrations/1', enabled: { ...this.#enabled, [id]: enabled } });
    this.#enabled[id] = enabled;
  }
  status() {
    return [...this.#definitions.values()].map(({ id, supported, unavailableReason }) => ({
      id, enabled: this.#enabled[id], supported,
      ...(supported ? {} : { unavailableReason: unavailableReason ?? 'INTEGRATION_UNSUPPORTED' }),
    }));
  }
}
