import { randomUUID, createHash } from 'node:crypto';
import { open, rename, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { emit } from './diagnostics.mjs';

export const digest = payload => createHash('sha256').update(JSON.stringify(payload)).digest('hex');
export const MAX_PROTECTED_TEXT_BYTES = 256 * 1024;
export const capabilities = Object.freeze({
  boundary: 'trusted_local_composer', provider: 'synthetic-loopback-only',
  visibleText: 'exact UTF-8 of declared DOM textContent extraction',
  attachmentBytes: 'exact selected bytes, base64 transport',
  attachmentReferences: 'not fetched; unsupported', localRelease: 'fixture-controlled',
  providerReceipt: 'UNKNOWN', filesystemAPI: false, signerAPI: false,
  confirmation: 'TEST_STUB_ONLY; no external anchor assurance',
});

function wellFormed(value) {
  if (typeof value.isWellFormed === 'function') return value.isWellFormed();
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

// The supported browser profile is deliberately text-only. JavaScript would
// silently replace lone surrogates while UTF-8 encoding, so reject them instead
// of claiming that a different byte string was protected.
export function validateProtectedTextPayload(payload) {
  if (!payload || Object.keys(payload).sort().join(',') !== 'attachments,text'
      || typeof payload.text !== 'string' || !wellFormed(payload.text)
      || !Array.isArray(payload.attachments) || payload.attachments.length !== 0
      || Buffer.byteLength(payload.text, 'utf8') > MAX_PROTECTED_TEXT_BYTES) {
    throw Error('Unsupported protected payload: exact UTF-8 text up to 256 KiB and no attachments required');
  }
  return { text: payload.text, attachments: [] };
}

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

// Laboratory defaults are plaintext and stub-confirmed. Integrations supply
// trusted storage and confirmation adapters at the local runtime boundary.
export class ReleaseRuntime {
  #diagnostics;
  #state; #file; #dir; #tail = Promise.resolve(); #dispatch; #fault; #store; #confirm; #validate; #protocol;
  #revokeOnRestart;
  constructor(directory, dispatch, fault = () => {}, {
    store, confirm, validate = validatePayload, protocol = 'release-fixture/1', diagnostics = null, revokeOnRestart = false,
  } = {}) {
    this.#dir = directory; this.#file = join(directory, 'release-test-journal.json');
    this.#dispatch = dispatch; this.#fault = fault;
    this.#store = store; this.#confirm = confirm; this.#validate = validate; this.#protocol = protocol;
    this.#diagnostics = diagnostics;
    this.#revokeOnRestart = revokeOnRestart;
  }
  async init() {
    try { this.#state = this.#store ? await this.#store.load() : JSON.parse(await readFile(this.#file, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; this.#state = { seals: {}, attempts: {} }; }
    for (const a of Object.values(this.#state.attempts)) {
      if (a.state === 'DISPATCHING') a.state = 'OUTCOME_UNKNOWN';
    }
    if (this.#revokeOnRestart) for (const seal of Object.values(this.#state.seals)) seal.authorization = null;
    await this.#persist(this.#state);
    return this;
  }
  async #persist(next, refs = {}) {
    if (this.#store) { await this.#store.save(next, refs); this.#state = next; return; }
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
  seal(payload, scope, mode = 'Sealed') {
    return this.#serial(async () => {
      if (typeof scope !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(scope)) throw Error('Invalid scope');
      if (!['Continuous', 'Sealed', 'Always Protect'].includes(mode)) throw Error('Invalid protection mode');
      const frozen = this.#validate(payload);
      const next = structuredClone(this.#state);
      const id = randomUUID();
      next.seals[id] = { id, scope, mode, payload: frozen, digest: digest(frozen), confirmation: null, authorization: null, priorAttempt: null };
      await this.#persist(next, { operationId: id });
      return { id, digest: digest(frozen), scope };
    });
  }
  confirm(id, scope, expectedDigest) {
    return this.#serial(async () => {
      const next = structuredClone(this.#state), seal = this.#sealFor(next, id, scope);
      if (seal.mode === 'Continuous') throw Error('Continuous anchoring cannot grant pre-release authorization');
      if (seal.digest !== expectedDigest || seal.confirmation || seal.cancelled) throw Error('Stale, cancelled, or duplicate confirmation');
      seal.confirmation = this.#confirm ? await this.#confirm(structuredClone(seal))
        : { policy: 'synthetic-confirmation/1', digest: seal.digest, result: 'TEST_CONFIRMED' };
      if (!seal.confirmation || seal.confirmation.digest !== seal.digest) throw Error('Confirmation version mismatch');
      seal.authorization = randomUUID();
      await this.#persist(next, { operationId: id });
    });
  }
  retry(id, scope, priorAttempt, explicit) {
    return this.#serial(async () => {
      const next = structuredClone(this.#state), seal = this.#sealFor(next, id, scope);
      const attempt = next.attempts[priorAttempt];
      if (explicit !== true || !attempt || attempt.sealId !== id || seal.priorAttempt !== priorAttempt
          || attempt.releaseClass === 'RETROSPECTIVE_CONTINUOUS'
          || !['OUTCOME_UNKNOWN', 'FAILED_BEFORE_EGRESS'].includes(attempt.state) || seal.authorization || seal.cancelled) throw Error('Retry not authorized');
      seal.authorization = randomUUID();
      await this.#persist(next, { operationId: id });
    });
  }
  cancel(id, scope, expectedDigest) {
    return this.#serial(async () => {
      const next = structuredClone(this.#state), seal = this.#sealFor(next, id, scope);
      if (seal.digest !== expectedDigest || seal.priorAttempt || seal.cancelled) throw Error('Stale or attempted seal');
      seal.authorization = null; seal.cancelled = true;
      await this.#persist(next, { operationId: id });
    });
  }
  release(request) {
    return this.#serial(async () => {
      const { id, scope, expectedDigest, currentPayload, protocol = this.#protocol } = request;
      const next = structuredClone(this.#state), seal = this.#sealFor(next, id, scope);
      if (seal.mode === 'Continuous' || seal.cancelled || protocol !== this.#protocol || expectedDigest !== seal.digest
          || digest(this.#validate(currentPayload)) !== seal.digest) throw Error('Stale version or protocol mismatch');
      if (!seal.confirmation || !seal.authorization) throw Error('No unconsumed confirmation authorization');
      const attemptId = randomUUID();
      const attempt = { attemptId, sealId: id, digest: seal.digest, scope, protocol,
        confirmation: seal.confirmation, authorization: seal.authorization,
        priorAttempt: seal.priorAttempt, releaseClass: 'PRE_DISCLOSURE_PROTECTED', state: 'DISPATCHING' };
      next.attempts[attemptId] = attempt;
      seal.authorization = null; seal.priorAttempt = attemptId;
      await this.#fault('before-consumption');
      await this.#persist(next, { operationId: id, dispatchId: attemptId });
      emit(this.#diagnostics, 'DISPATCH_AUTHORIZATION_CONSUMED', { operationId: id, dispatchId: attemptId });
      await this.#fault('after-consumption');
      const started = performance.now();
      emit(this.#diagnostics, 'DISPATCH_STARTED', { operationId: id, dispatchId: attemptId });
      let state;
      try {
        state = await this.#dispatch({ ...structuredClone(attempt), payload: structuredClone(seal.payload) });
        if (!['SUBMISSION_OBSERVED', 'FAILED_BEFORE_EGRESS', 'OUTCOME_UNKNOWN'].includes(state)) state = 'OUTCOME_UNKNOWN';
      } catch { state = 'OUTCOME_UNKNOWN'; }
      await this.#fault('after-egress');
      const completed = structuredClone(this.#state);
      completed.attempts[attemptId].state = state;
      await this.#persist(completed, { operationId: id, dispatchId: attemptId });
      emit(this.#diagnostics, state, { operationId: id, dispatchId: attemptId, durationMs: performance.now() - started });
      return { attemptId, state, providerReceipt: 'UNKNOWN' };
    });
  }
  releaseContinuous(request) {
    return this.#serial(async () => {
      const { id, scope, expectedDigest, currentPayload, protocol = this.#protocol } = request;
      const next = structuredClone(this.#state), seal = this.#sealFor(next, id, scope);
      if (seal.mode !== 'Continuous' || seal.cancelled || protocol !== this.#protocol || expectedDigest !== seal.digest
          || digest(this.#validate(currentPayload)) !== seal.digest || seal.priorAttempt) {
        throw Error('Stale, duplicate, mode, or protocol mismatch');
      }
      const attemptId = randomUUID();
      const attempt = { attemptId, sealId: id, digest: seal.digest, scope, protocol,
        confirmation: null, authorization: null, priorAttempt: null,
        releaseClass: 'RETROSPECTIVE_CONTINUOUS', state: 'DISPATCHING' };
      next.attempts[attemptId] = attempt; seal.priorAttempt = attemptId;
      await this.#persist(next, { operationId: id, dispatchId: attemptId });
      await this.#fault('after-consumption');
      const started = performance.now();
      emit(this.#diagnostics, 'DISPATCH_STARTED', { operationId: id, dispatchId: attemptId });
      let state;
      try {
        state = await this.#dispatch({ ...structuredClone(attempt), payload: structuredClone(seal.payload) });
        if (!['SUBMISSION_OBSERVED', 'FAILED_BEFORE_EGRESS', 'OUTCOME_UNKNOWN'].includes(state)) state = 'OUTCOME_UNKNOWN';
      } catch { state = 'OUTCOME_UNKNOWN'; }
      await this.#fault('after-egress');
      const completed = structuredClone(this.#state);
      completed.attempts[attemptId].state = state;
      await this.#persist(completed, { operationId: id, dispatchId: attemptId });
      emit(this.#diagnostics, state, { operationId: id, dispatchId: attemptId, durationMs: performance.now() - started });
      return { attemptId, state, providerReceipt: 'UNKNOWN' };
    });
  }
  snapshot() { return structuredClone(this.#state); }
}
