import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { emit } from '../../release/diagnostics.mjs';
import { Vault } from '../../vault/vault.mjs';
import { canonical, parseCanonical, b64, unb64 } from '../../vault/format.mjs';
import { ReleaseRuntime, digest, validateProtectedTextPayload } from '../../release/runtime.mjs';
import { VaultReleaseStore } from '../../demonstrator/store.mjs';
import { inclusion, anchorPayload } from '../../anchor/merkle.mjs';
import { verifyAnchor } from '../../anchor/verifier.mjs';
import { FAST_CONFIRM_PROFILE, FAST_CONFIRM_WAIT_MS, collectFastEvidence, verifyFastConfirmation } from '../../anchor/algorand/fast-confirm.mjs';
import { CHATGPT_RELEASE_PROTOCOL } from './adapter.mjs';
import { LocalReceipts, storeAnchor, storePublicProof } from '../../recipient/local.mjs';
import { managedError, TRANSACTION_PATTERN } from '../../managed/protocol.mjs';

const wire = value => Buffer.from(canonical(value));

export class ChatGPTProtectionSession {
  #adapter; #tails = new Map(); #scopes = new Set(); #versions = new Map(); #pending = new Map();
  #fastTrust; #collectFast; #verifyFast; #verifyArchive; #ownsVault; #drafts = new Map();
  #generations = new Map(); #ended = new Set(); #authority = () => true;
  #managed; #diagnostics; #closed = false;

  constructor(directory, adapter, {
    vault = null, vaultKey = null, fastTrust, collectFast = collectFastEvidence, verifyFast = verifyFastConfirmation,
    verifyArchive = verifyAnchor, managed = null, fault = () => {}, diagnostics = null,
  } = {}) {
    if (!directory || !adapter || !fastTrust || fastTrust.profile !== FAST_CONFIRM_PROFILE || typeof collectFast !== 'function'
        || (!vault && (!Buffer.isBuffer(vaultKey) || vaultKey.length !== 32))) {
      throw Error('ChatGPT protection session requires adapter, fast-confirmation trust, and explicit vault custody');
    }
    this.directory = directory; this.#adapter = adapter; this.#fastTrust = structuredClone(fastTrust);
    this.#collectFast = collectFast;
    this.#managed = managed;
    this.#diagnostics = diagnostics;
    this.#verifyFast = verifyFast; this.#verifyArchive = verifyArchive; this.#ownsVault = !vault;
    this.vault = vault ?? new Vault(join(directory, 'vault'), vaultKey, undefined, { create: true });
    this.receipts = new LocalReceipts(this.vault);
    this.store = new VaultReleaseStore(directory, this.vault, diagnostics); this.fault = fault;
  }

  async init() {
    this.runtime = await new ReleaseRuntime(this.directory, attempt => {
      try {
        const version = this.#version(attempt.sealId);
        this.#assertCurrentDraft(version, attempt.payload);
      } catch { return 'FAILED_BEFORE_EGRESS'; }
      return this.#adapter.dispatch(attempt, () => {
        if (this.#closed) return false;
        this.#assertCurrentDraft(this.#version(attempt.sealId), attempt.payload);
        const state = this.runtime.snapshot(), seal = state.seals[attempt.sealId];
        return state.attempts[attempt.attemptId]?.state === 'DISPATCHING'
          && seal?.priorAttempt === attempt.attemptId && seal.authorization === null && !seal.cancelled;
      });
    }, this.fault, {
      store: this.store, confirm: seal => this.#confirmSeal(seal),
      validate: validateProtectedTextPayload, protocol: CHATGPT_RELEASE_PROTOCOL, diagnostics: this.#diagnostics,
      revokeOnRestart: true,
    }).init();
    emit(this.#diagnostics, 'ENGINE_STARTED');
    return this;
  }

  #serial(operation, refs = {}) {
    const scope = refs.scope ?? this.#versions.get(refs.operationId)?.scope ?? 'engine';
    const next = (this.#tails.get(scope) ?? Promise.resolve()).then(operation).catch(error => {
      const { scope: _scope, ...diagnosticRefs } = refs;
      emit(this.#diagnostics, 'OPERATION_REJECTED', diagnosticRefs); throw error;
    });
    const settled = next.catch(() => {});
    this.#tails.set(scope, settled);
    settled.then(() => { if (this.#tails.get(scope) === settled) this.#tails.delete(scope); });
    return next;
  }
  #event(value) { return this.vault.capture(wire({ profile: 'pap-chatgpt-observation/1', ...value }), { type: 'observation' }); }
  #version(id) { const value = this.#versions.get(id); if (!value) throw Error('Unknown version'); return value; }
  #activeVersion(id) {
    const version = this.#version(id);
    if (version.state === 'CANCELLED') throw Error('Version was cancelled');
    return version;
  }
  #public(value) {
    const { payload: _payload, authorityGeneration: _authorityGeneration, ...visible } = value;
    const active = value.state !== 'CANCELLED';
    return structuredClone({ ...visible, actions: {
      anchorRequest: active,
      cancel: active && value.mode !== 'Continuous' && value.attempt === null,
      anchor: active && value.anchor === 'PENDING',
      release: active && value.mode === 'Sealed' && value.state === 'SEALED_NOT_SENT',
      retry: active && value.mode !== 'Continuous' && ['OUTCOME_UNKNOWN', 'FAILED_BEFORE_EGRESS'].includes(value.state),
    } });
  }

  enroll({ tabId, destination }) {
    const enrollment = this.#adapter.enroll({ tabId, destination }); this.#scopes.add(enrollment.scope);
    return structuredClone(enrollment);
  }

  updateDraft({ text, attachments = [], scope, editRevision }) {
    if (!this.#scopes.has(scope)) throw Error('UNSUPPORTED_PATH: scope changed');
    if (!Number.isSafeInteger(editRevision) || editRevision < 0) throw Error('Invalid trusted-composer edit revision');
    const payload = validateProtectedTextPayload({ text, attachments }), payloadDigest = digest(payload);
    const draft = this.#drafts.get(scope);
    if (draft && (editRevision < draft.editRevision
        || (editRevision === draft.editRevision && payloadDigest !== draft.payloadDigest))) {
      throw Error('Stale or conflicting trusted-composer edit revision');
    }
    this.#drafts.set(scope, { scope, editRevision, payloadDigest });
    return { editRevision, payloadDigest };
  }

  #assertCurrentDraft(version, payload) {
    this.#assertAuthority(version);
    const draft = this.#drafts.get(version.scope);
    if (!draft || draft.editRevision !== version.editRevision
        || draft.payloadDigest !== version.digest || digest(validateProtectedTextPayload(payload)) !== version.digest) {
      throw Error('Stale trusted-composer version');
    }
  }

  setAuthorityCheck(check) { this.#authority = check; }
  #assertAuthority(version) {
    if (this.#closed || this.#ended.has(version.id) || version.authorityGeneration !== (this.#generations.get(version.scope) ?? 0)
        || this.#authority(version) !== true) throw Error('Operation authority ended; a new action is required');
  }
  interruptScope(scope) {
    this.#generations.set(scope, (this.#generations.get(scope) ?? 0) + 1);
    return Promise.allSettled([...this.#versions.values()].filter(value => value.scope === scope)
      .map(value => this.interruptVersion(value.id)));
  }
  interruptVersion(id) {
    const version = this.#version(id); this.#ended.add(id);
    if (version.state === 'CANCELLED' || version.attempt || this.runtime.snapshot().seals[id]?.priorAttempt) return Promise.resolve();
    return this.cancel({ id, scope: version.scope });
  }

  anchorRequest(id) {
    const version = this.#activeVersion(id), batch = inclusion([unb64(version.recordDigest, 32)], 0);
    return { recordDigest: version.recordDigest, batch, payload: b64(anchorPayload(unb64(batch.root, 32))) };
  }

  async #releaseVersion(version, payload, continuous = false) {
    this.#activeVersion(version.id);
    this.#assertCurrentDraft(version, payload);
    this.#adapter.assertEligible(version.scope);
    const request = { id: version.id, scope: version.scope, expectedDigest: version.digest,
      currentPayload: payload, protocol: CHATGPT_RELEASE_PROTOCOL };
    version.attempt = continuous ? await this.runtime.releaseContinuous(request) : await this.runtime.release(request);
    version.state = version.attempt.state;
    const durableAttempt = this.runtime.snapshot().attempts[version.attempt.attemptId];
    this.#event({ kind: 'release-outcome', version: version.id, mode: version.mode,
      recordDigest: version.recordDigest, releaseClass: durableAttempt.releaseClass, confirmation: durableAttempt.confirmation,
      anchor: version.anchor, timestamp: version.timestamp, ...version.attempt });
  }

  freeze({ text, attachments = [], mode, scope, editRevision }) {
    const draft = this.updateDraft({ text, attachments, scope, editRevision });
    const authorityGeneration = this.#generations.get(scope) ?? 0;
    return this.#serial(async () => {
      if (!this.#scopes.has(scope)) throw Error('UNSUPPORTED_PATH: scope changed');
      this.#assertAuthority({ scope, mode, authorityGeneration });
      this.#adapter.assertEligible(scope);
      if (!['Continuous', 'Sealed', 'Always Protect'].includes(mode)) throw Error('Unsupported protection mode');
      const payload = validateProtectedTextPayload({ text, attachments });
      if (draft.payloadDigest !== digest(payload)) throw Error('Stale trusted-composer version');
      const started = performance.now();
      let captured;
      try { captured = this.vault.capture(Buffer.from(payload.text, 'utf8')); }
      catch (error) { emit(this.#diagnostics, 'VAULT_WRITE_FAILED'); throw error; }
      const captureMs = performance.now() - started;
      const descriptor = this.#event({
        kind: 'frozen-text-version', mode, scope, editRevision: String(editRevision), boundary: 'trusted_local_composer',
        coverage: 'exact UTF-8 text bytes', payloadDigest: digest(payload),
        textRecord: captured.manifest.eventId, textObject: captured.manifest.evidence[0].objectDigest,
        attachments: 'UNSUPPORTED',
      });
      const seal = await this.runtime.seal(payload, scope, mode);
      const version = {
        ...seal, payload, mode, editRevision, authorityGeneration, descriptorId: descriptor.manifest.eventId,
        recordDigest: descriptor.recordDigest, state: mode === 'Continuous' ? 'PENDING_ANCHOR' : 'PENDING_FAST_CONFIRMATION',
        anchor: 'PENDING', timestamp: 'INDETERMINATE', attempt: null, assuranceHistory: [],
      };
      this.#versions.set(version.id, version);
      emit(this.#diagnostics, 'VAULT_CAPTURED', { operationId: version.id, captureId: captured.manifest.eventId, durationMs: captureMs });
      emit(this.#diagnostics, 'OPERATION_FROZEN', { operationId: version.id, captureId: captured.manifest.eventId });
      if (mode === 'Continuous') await this.#releaseVersion(version, payload, true);
      return this.#public(version);
    }, { scope });
  }

  async #validateFast(version, evidence) {
    const request = this.anchorRequest(version.id);
    const report = await this.#verifyFast(evidence, structuredClone(this.#fastTrust), request.payload);
    if (!report?.authorized || report.anchor !== 'SOURCE_CORROBORATED'
        || report.timestamp !== 'SOURCE_REPORTED' || report.assurance !== FAST_CONFIRM_PROFILE) {
      throw Error('Fast confirmation did not satisfy the release profile');
    }
    const receipt = this.#event({
      kind: 'fast-confirmation', version: version.id, recordDigest: version.recordDigest,
      expectedAnchorPayload: request.payload, report, ...storePublicProof(this.vault, evidence),
    });
    return { report: structuredClone(report), receiptId: receipt.manifest.eventId };
  }

  async #confirmSeal(seal) {
    const version = this.#version(seal.id), evidence = this.#pending.get(seal.id);
    if (!evidence) throw Error('PENDING_FAST_CONFIRMATION: exact-version evidence required');
    const accepted = await this.#validateFast(version, evidence);
    this.#assertCurrentDraft(version, version.payload);
    return {
      profile: FAST_CONFIRM_PROFILE, digest: seal.digest, result: accepted.report.anchor,
      timestamp: accepted.report.timestamp, round: accepted.report.round,
      receiptId: accepted.receiptId,
    };
  }

  managedStatus() { return this.#managed?.status() ?? { state: 'NOT_CONFIGURED' }; }
  connectManaged({ accessCode }) {
    if (!this.#managed) throw managedError('NOT_CONFIGURED');
    return this.#managed.connect(accessCode);
  }
  disconnectManaged() { return this.#managed?.disconnect() ?? { state: 'NOT_CONFIGURED' }; }
  anchorManaged(request) { return this.#confirm(request, true); }
  confirmFast(request) { return this.#confirm(request, false); }

  #confirm({ id, transactionId, scope, currentText, attachments = [], editRevision }, managed) {
    if (this.#versions.get(id)?.state === 'CANCELLED') {
      return this.#serial(() => this.#activeVersion(id), { operationId: id });
    }
    if (this.#version(id).mode !== 'Continuous') {
      this.updateDraft({ text: currentText, attachments, scope, editRevision });
    }
    return this.#serial(async () => {
      const started = performance.now();
      const version = this.#activeVersion(id);
      if (scope !== version.scope || !this.#scopes.has(scope)) throw Error('UNSUPPORTED_PATH: scope changed');
      if (version.anchor !== 'PENDING') throw Error('Duplicate or non-monotonic fast confirmation');
      if (version.mode !== 'Continuous') {
        this.#assertCurrentDraft(version, validateProtectedTextPayload({ text: currentText, attachments }));
        this.#adapter.assertEligible(scope);
      }
      if (managed) {
        const savedTransactionId = version.managed?.transactionId;
        emit(this.#diagnostics, 'SPONSOR_REQUESTED', { operationId: id });
        const sponsorStarted = performance.now();
        try {
          if (!this.#managed) throw managedError('NOT_CONFIGURED');
          const submitted = await this.#managed.submit(this.anchorRequest(id).payload);
          if (!TRANSACTION_PATTERN.test(submitted.transactionId ?? '')
              || (savedTransactionId && submitted.transactionId !== savedTransactionId)) {
            throw managedError('SERVICE_UNAVAILABLE');
          }
          version.managed = { state: 'SUBMITTED_OR_UNKNOWN', transactionId: savedTransactionId ?? submitted.transactionId };
          emit(this.#diagnostics, 'SPONSOR_SUBMITTED', { operationId: id, durationMs: performance.now() - sponsorStarted });
          if (!savedTransactionId) {
            this.#event({ kind: 'managed-submission', version: id, recordDigest: version.recordDigest,
              transactionId: submitted.transactionId, claim: 'SUBMISSION_ONLY; independent confirmation required' });
          }
        } catch (error) {
          const safe = managedError(error.code);
          emit(this.#diagnostics, ['NOT_CONFIGURED', 'ACCOUNT_REQUIRED', 'UNPAID', 'QUOTA_EXHAUSTED',
            'RATE_LIMITED', 'SERVICE_UNAVAILABLE', 'SUBMISSION_INTERRUPTED'].includes(safe.code)
            ? safe.code : 'SPONSOR_UNAVAILABLE', { operationId: id, durationMs: performance.now() - sponsorStarted });
          if (!savedTransactionId) {
            version.managed = { state: safe.code, message: safe.message };
            return this.#public(version);
          }
          // A saved transaction may already have landed; service retry failure must not block its independent observation.
          version.managed = { state: safe.code, message: safe.message, transactionId: savedTransactionId };
        }
        transactionId = version.managed.transactionId;
      }
      if (typeof transactionId !== 'string' || transactionId.length === 0) throw Error('Algorand transaction ID required');
      const confirmationId = randomUUID(), confirmationStarted = performance.now();
      const confirmationRefs = { operationId: id, confirmationId };
      emit(this.#diagnostics, 'CONFIRMATION_STARTED', confirmationRefs);
      const collect = () => {
        const waitMs = FAST_CONFIRM_WAIT_MS - (managed ? Math.ceil(performance.now() - started) : 0);
        if (waitMs < 1) throw Object.assign(Error('PENDING_FAST_CONFIRMATION: confirmation wait budget expired'), { code: 'PENDING_FAST_CONFIRMATION' });
        return this.#collectFast({ trust: structuredClone(this.#fastTrust), transactionId, waitMs,
          diagnostics: { record: code => emit(this.#diagnostics, code, confirmationRefs) } });
      };
      try {
        if (version.mode !== 'Continuous') {
          if (version.anchor !== 'PENDING') throw Error('Duplicate or non-monotonic fast confirmation');
          this.#adapter.assertEligible(scope);
          const current = validateProtectedTextPayload({ text: currentText, attachments });
          if (editRevision !== version.editRevision || digest(current) !== version.digest) throw Error('Stale version');
          const evidence = await collect();
          emit(this.#diagnostics, 'CONFIRMATION_COLLECTED', confirmationRefs);
          this.#assertCurrentDraft(version, current);
          this.#adapter.assertEligible(scope);
          this.#pending.set(id, structuredClone(evidence));
          try { await this.runtime.confirm(id, scope, version.digest); }
          finally { this.#pending.delete(id); }
          const confirmation = this.runtime.snapshot().seals[id].confirmation;
          version.anchor = confirmation.result; version.timestamp = confirmation.timestamp;
          version.state = 'SEALED_NOT_SENT';
          version.assuranceHistory.push({ anchor: version.anchor, timestamp: version.timestamp,
            profile: confirmation.profile, round: confirmation.round, receiptId: confirmation.receiptId });
          emit(this.#diagnostics, 'CONFIRMATION_ACCEPTED', { ...confirmationRefs, durationMs: performance.now() - confirmationStarted });
          if (version.mode === 'Always Protect') await this.#releaseVersion(version, current);
        } else {
          if (!version.attempt) throw Error('Continuous release has not been attempted');
          if (version.anchor !== 'PENDING') throw Error('Duplicate or non-monotonic fast confirmation');
          const evidence = await collect();
          emit(this.#diagnostics, 'CONFIRMATION_COLLECTED', confirmationRefs);
          const accepted = await this.#validateFast(version, evidence);
          version.anchor = accepted.report.anchor; version.timestamp = accepted.report.timestamp;
          version.assuranceHistory.push({ anchor: version.anchor, timestamp: version.timestamp,
            profile: FAST_CONFIRM_PROFILE, round: accepted.report.round, receiptId: accepted.receiptId });
          emit(this.#diagnostics, 'CONFIRMATION_ACCEPTED', { ...confirmationRefs, durationMs: performance.now() - confirmationStarted });
        }
      } catch (error) {
        if (version.anchor === 'PENDING') emit(this.#diagnostics,
          error?.code === 'PENDING_FAST_CONFIRMATION' ? 'CONFIRMATION_PENDING' : 'CONFIRMATION_REJECTED',
          { ...confirmationRefs, durationMs: performance.now() - confirmationStarted });
        throw error;
      }
      return this.#public(version);
    }, { operationId: id });
  }

  release({ id, scope, currentText, attachments = [], editRevision }) {
    if (this.#versions.get(id)?.state === 'CANCELLED') {
      return this.#serial(() => this.#activeVersion(id), { operationId: id });
    }
    this.updateDraft({ text: currentText, attachments, scope, editRevision });
    return this.#serial(async () => {
      const version = this.#activeVersion(id);
      if (version.mode === 'Continuous') throw Error('Continuous releases during freeze and cannot be resent automatically');
      if (scope !== version.scope || !this.#scopes.has(scope)) throw Error('UNSUPPORTED_PATH: scope changed');
      const current = validateProtectedTextPayload({ text: currentText, attachments });
      if (editRevision !== version.editRevision || digest(current) !== version.digest) throw Error('Stale version');
      await this.#releaseVersion(version, current); return this.#public(version);
    }, { operationId: id });
  }

  retry({ id, scope, currentText, attachments = [], editRevision, priorAttempt, explicit }) {
    if (this.#versions.get(id)?.state === 'CANCELLED') {
      return this.#serial(() => this.#activeVersion(id), { operationId: id });
    }
    this.updateDraft({ text: currentText, attachments, scope, editRevision });
    return this.#serial(async () => {
      const version = this.#activeVersion(id), current = validateProtectedTextPayload({ text: currentText, attachments });
      if (version.mode === 'Continuous' || scope !== version.scope || !this.#scopes.has(scope)
          || editRevision !== version.editRevision || digest(current) !== version.digest) throw Error('Stale or unsupported retry');
      this.#adapter.assertEligible(scope);
      await this.runtime.retry(id, scope, priorAttempt, explicit);
      await this.#releaseVersion(version, current); return this.#public(version);
    }, { operationId: id });
  }

  cancel({ id, scope }) {
    return this.#serial(async () => {
      const version = this.#activeVersion(id);
      if (scope !== version.scope || version.attempt) throw Error('Stale cancellation');
      await this.runtime.cancel(id, scope, version.digest); version.state = 'CANCELLED';
      if (version.managed) delete version.managed.message;
      version.message = 'Version cancelled. This version cannot be released. Its local evidence remains available.';
      this.#event({ kind: 'release-cancelled', version: id, mode: version.mode, recordDigest: version.recordDigest });
      emit(this.#diagnostics, 'OPERATION_CANCELLED', { operationId: id });
      return this.#public(version);
    }, { operationId: id });
  }

  upgradeConsensus({ id, envelope, trust }) {
    return this.#serial(async () => {
      const version = this.#activeVersion(id);
      if (version.anchor === 'CONSENSUS_VERIFIED') throw Error('Duplicate consensus upgrade');
      if (version.mode !== 'Continuous'
          && !version.assuranceHistory.some(value => value.profile === FAST_CONFIRM_PROFILE)) {
        throw Error('Fast confirmation must precede a protected consensus upgrade');
      }
      const envelopeBytes = Buffer.isBuffer(envelope) ? envelope : Buffer.from(envelope);
      const archivedEvidence = parseCanonical(envelopeBytes, 8 * 1024 * 1024);
      const report = this.#verifyArchive(envelopeBytes, trust, version.recordDigest);
      if (!report?.independentlyVerified || report.anchor !== 'CONSENSUS_VERIFIED' || report.timestamp !== 'BLOCK_HASH_BOUND') {
        throw Error(`Consensus upgrade rejected: ${report?.reason ?? 'invalid proof'}`);
      }
      const receipt = this.#event({ kind: 'consensus-assurance-upgrade', version: id,
        recordDigest: version.recordDigest, priorAnchor: version.anchor, priorTimestamp: version.timestamp,
        report, ...storeAnchor(this.vault, archivedEvidence) });
      version.anchor = report.anchor; version.timestamp = report.timestamp;
      version.assuranceHistory.push({ anchor: report.anchor, timestamp: report.timestamp,
        profile: 'pap-algorand-sp/1', round: report.round, receiptId: receipt.manifest.eventId });
      emit(this.#diagnostics, 'CONSENSUS_UPGRADED', { operationId: id });
      return this.#public(version);
    }, { operationId: id });
  }

  status() {
    const scopes = [...this.#scopes].map(scope => ({ scope, eligibility: this.#adapter.eligibility(scope),
      editRevision: this.#drafts.get(scope)?.editRevision ?? 0 }));
    const only = scopes.length === 1 ? scopes[0] : null;
    return { scope: only?.scope ?? null, eligibility: only?.eligibility ?? 'UNENROLLED', scopes,
      versions: [...this.#versions.values()].map(value => this.#public(value)) };
  }
  async drain() { while (this.#tails.size) await Promise.all(this.#tails.values()); }
  close() { this.#closed = true; if (this.#ownsVault) this.vault.close(); emit(this.#diagnostics, 'ENGINE_CLOSED'); }
}
