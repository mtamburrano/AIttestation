import { emit } from '../diagnostics/local.mjs';

export const HOOK_STAGES = Object.freeze(['RECEIVED', 'AUTHENTICATED', 'ADMITTED', 'RELEASED',
  'UNAVAILABLE', 'BUSY', 'UNKNOWN_INSTALLATION', 'AUTH_REJECTED', 'ENROLLMENT_CHANGED',
  'PEER_LIMIT', 'UNSUPPORTED', 'EXPIRED', 'DISABLED', 'CANCELLED']);

// Fixed buckets and saturating counters only. Neither client-supplied metadata
// nor native error messages are retained, even when authentication fails.
export class HookHealth {
  #entries = new Map(); #pending = new Set(); #scheduled = false; #diagnostics;
  constructor({ diagnostics = null } = {}) {
    this.#diagnostics = diagnostics;
    for (const client of ['codex', 'claude-code', 'unknown']) this.reset(client);
  }
  reset(client) {
    if (!['codex', 'claude-code', 'unknown'].includes(client)) return;
    this.#entries.set(client, { lastObserved: 'NEVER_OBSERVED', authenticated: false,
      counters: Object.fromEntries(HOOK_STAGES.map(stage => [stage, 0])) });
  }
  record(client, stage, authenticated = ['AUTHENTICATED', 'ADMITTED', 'RELEASED'].includes(stage)) {
    if (!HOOK_STAGES.includes(stage) || typeof authenticated !== 'boolean') return;
    const entry = this.#entries.get(client) ?? this.#entries.get('unknown');
    entry.counters[stage] = Math.min(Number.MAX_SAFE_INTEGER, entry.counters[stage] + 1);
    entry.lastObserved = stage;
    entry.authenticated = authenticated;
    this.#pending.add(stage);
  }
  status(client) { return structuredClone(this.#entries.get(client) ?? this.#entries.get('unknown')); }
  flushLater() {
    if (this.#scheduled || !this.#pending.size) return;
    this.#scheduled = true;
    setImmediate(() => {
      this.#scheduled = false;
      const stages = [...this.#pending]; this.#pending.clear();
      for (const stage of stages) emit(this.#diagnostics, `HOOK_${stage}`);
    });
  }
}
