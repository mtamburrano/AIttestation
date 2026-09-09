import { randomUUID, createHash } from 'node:crypto';
import { open, rename, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const digest = payload => createHash('sha256').update(JSON.stringify(payload)).digest('hex');
export const capabilities = Object.freeze({
  boundary: 'trusted_local_composer', provider: 'synthetic-loopback-only',
  visibleText: 'exact UTF-8 of declared DOM textContent extraction',
  attachmentBytes: 'exact selected bytes, base64 transport',
  attachmentReferences: 'not fetched; unsupported', localRelease: 'fixture-controlled',
  providerReceipt: 'UNKNOWN', filesystemAPI: false, signerAPI: false,
  confirmation: 'TEST_STUB_ONLY; no external anchor assurance',
});

export function validatePayload(payload) {
  if (!payload || typeof payload.text !== 'string' || !Array.isArray(payload.attachments)
      || payload.attachments.length > 4 || Buffer.byteLength(payload.text) > 65536) throw Error('Invalid payload');
  for (const a of payload.attachments) {
    if (!a || Object.keys(a).sort().join(',') !== 'bytes,name' || typeof a.name !== 'string'
        || a.name.length > 256 || typeof a.bytes !== 'string' || a.bytes.length > 140000
        || Buffer.from(a.bytes, 'base64').toString('base64') !== a.bytes) throw Error('Invalid attachment');
  }
  if (Object.keys(payload).sort().join(',') !== 'attachments,text') throw Error('Unknown payload field');
  return structuredClone(payload);
}

// Synthetic plaintext journal only. The encrypted vault is a separate slice.
export class ReleaseRuntime {
  #state; #file; #dir; #tail = Promise.resolve(); #dispatch; #fault;
  constructor(directory, dispatch, fault = () => {}) {
    this.#dir = directory; this.#file = join(directory, 'release-test-journal.json');
    this.#dispatch = dispatch; this.#fault = fault;
  }
  async init() {
    try { this.#state = JSON.parse(await readFile(this.#file, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; this.#state = { seals: {}, attempts: {} }; }
    for (const a of Object.values(this.#state.attempts)) {
      if (a.state === 'DISPATCHING') a.state = 'OUTCOME_UNKNOWN';
    }
    await this.#persist(this.#state);
    return this;
  }
  async #persist(next) {
    const temp = `${this.#file}.${randomUUID()}.tmp`;
    const f = await open(temp, 'wx', 0o600);
    try { await f.writeFile(JSON.stringify(next)); await f.sync(); } finally { await f.close(); }
    await rename(temp, this.#file);
    const dir = await open(this.#dir, 'r');
    try { await dir.sync(); } finally { await dir.close(); }
    this.#state = next;
  }
  #serial(fn) {
    const next = this.#tail.then(fn);
    this.#tail = next.catch(() => {});
    return next;
  }
  #sealFor(state, id, scope) {
    const seal = state.seals[id];
    if (!seal || seal.scope !== scope) throw Error('Seal/scope mismatch');
    return seal;
  }
  seal(payload, scope) {
    return this.#serial(async () => {
      if (typeof scope !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(scope)) throw Error('Invalid scope');
      const frozen = validatePayload(payload);
      const next = structuredClone(this.#state);
      const id = randomUUID();
      next.seals[id] = { id, scope, payload: frozen, digest: digest(frozen), confirmation: null, authorization: null, priorAttempt: null };
      await this.#persist(next);
      return { id, digest: digest(frozen), scope };
    });
  }
  confirm(id, scope, expectedDigest) {
    return this.#serial(async () => {
      const next = structuredClone(this.#state), seal = this.#sealFor(next, id, scope);
      if (seal.digest !== expectedDigest || seal.confirmation) throw Error('Stale or duplicate confirmation');
      seal.confirmation = { policy: 'synthetic-confirmation/1', digest: seal.digest, result: 'TEST_CONFIRMED' };
      seal.authorization = randomUUID();
      await this.#persist(next);
    });
  }
  retry(id, scope, priorAttempt, explicit) {
    return this.#serial(async () => {
      const next = structuredClone(this.#state), seal = this.#sealFor(next, id, scope);
      const attempt = next.attempts[priorAttempt];
      if (explicit !== true || !attempt || attempt.sealId !== id || seal.priorAttempt !== priorAttempt
          || !['OUTCOME_UNKNOWN', 'FAILED_BEFORE_EGRESS'].includes(attempt.state) || seal.authorization) throw Error('Retry not authorized');
      seal.authorization = randomUUID();
      await this.#persist(next);
    });
  }
  release({ id, scope, expectedDigest, currentPayload, protocol = 'release-fixture/1' }) {
    return this.#serial(async () => {
      const next = structuredClone(this.#state), seal = this.#sealFor(next, id, scope);
      if (protocol !== 'release-fixture/1' || expectedDigest !== seal.digest
          || digest(validatePayload(currentPayload)) !== seal.digest) throw Error('Stale version or protocol mismatch');
      if (!seal.confirmation || !seal.authorization) throw Error('No unconsumed confirmation authorization');
      const attemptId = randomUUID();
      const attempt = { attemptId, sealId: id, digest: seal.digest, scope, protocol,
        confirmation: seal.confirmation, authorization: seal.authorization,
        priorAttempt: seal.priorAttempt, state: 'DISPATCHING' };
      next.attempts[attemptId] = attempt;
      seal.authorization = null; seal.priorAttempt = attemptId;
      await this.#fault('before-consumption');
      await this.#persist(next);
      await this.#fault('after-consumption');
      let state;
      try {
        state = await this.#dispatch({ ...structuredClone(attempt), payload: structuredClone(seal.payload) });
        if (!['SUBMISSION_OBSERVED', 'FAILED_BEFORE_EGRESS', 'OUTCOME_UNKNOWN'].includes(state)) state = 'OUTCOME_UNKNOWN';
      } catch { state = 'OUTCOME_UNKNOWN'; }
      await this.#fault('after-egress');
      const completed = structuredClone(this.#state);
      completed.attempts[attemptId].state = state;
      await this.#persist(completed);
      return { attemptId, state, providerReceipt: 'UNKNOWN' };
    });
  }
  snapshot() { return structuredClone(this.#state); }
}
