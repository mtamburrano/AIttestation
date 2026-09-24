import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { emit, emitCaptureFailure } from '../../diagnostics/local.mjs';
import { Vault } from '../../vault/vault.mjs';
import { canonical, parseCanonical, b64, unb64, keys } from '../../vault/format.mjs';
import { verifyRecord } from '../../vault/records.mjs';
import { inclusion, anchorPayload } from '../../anchor/merkle.mjs';
import { verifyAnchorAsync } from '../../anchor/verifier.mjs';
import { FAST_CONFIRM_PROFILE, FAST_CONFIRM_WAIT_MS, collectFastEvidence, verifyFastConfirmationAsync } from '../../anchor/algorand/fast-confirm.mjs';
import { LocalReceipts, storeAnchor, storePublicProof } from '../../recipient/local.mjs';
import { managedError, TRANSACTION_PATTERN } from '../../managed/protocol.mjs';
import { NORMAL_OBSERVATION_PROFILE, validateNormalObservation, validateCaptureSource, validateRequest, isUUID } from '../../recipient/normal-observation.mjs';
import { STRICT_OBSERVATION_PROFILE, validateStrictObservation } from '../../recipient/strict-observation.mjs';
import { QUALIFIED_OBSERVATION_PROFILE, validateQualifiedObservation } from '../../recipient/qualified-observation.mjs';
import { DOM_OBSERVATION_PROFILE, validateDOMObservation } from '../../recipient/dom-observation.mjs';

import { LEGACY_NORMAL_OBSERVATION_PROFILE, validateLegacyNormalObservation } from '../../recipient/legacy-observation.mjs';

const wire = value => Buffer.from(canonical(value));

export class ChatGPTRecordingSession {
  #tails = new Map(); #versions = new Map(); #providerMessages = new Map();
  #aliases = new Map();
  #fastTrust; #collectFast; #verifyFast; #verifyArchive; #ownsVault;
  #managed; #diagnostics; #closed = false;

  constructor(directory, adapter, {
    vault = null, vaultKey = null, fastTrust, collectFast = collectFastEvidence, verifyFast = verifyFastConfirmationAsync,
    verifyArchive = verifyAnchorAsync, managed = null, diagnostics = null,
  } = {}) {
    if (!directory || !adapter || !fastTrust || fastTrust.profile !== FAST_CONFIRM_PROFILE || typeof collectFast !== 'function'
        || (!vault && (!Buffer.isBuffer(vaultKey) || vaultKey.length !== 32))) {
      throw Error('ChatGPT recording session requires adapter, fast-confirmation trust, and explicit vault custody');
    }
    this.directory = directory; this.#fastTrust = structuredClone(fastTrust);
    this.#collectFast = collectFast;
    this.#managed = managed;
    this.#diagnostics = diagnostics;
    this.#verifyFast = verifyFast; this.#verifyArchive = verifyArchive; this.#ownsVault = !vault;
    this.vault = vault ?? new Vault(join(directory, 'vault'), vaultKey, undefined, { create: true });
    this.receipts = new LocalReceipts(this.vault);
  }

  async init() {
    this.#restoreObservations();
    emit(this.#diagnostics, 'ENGINE_STARTED');
    return this;
  }

  #serial(operation, refs = {}) {
    const scope = refs.operationId ?? 'engine';
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
  #captureRecord(bytes, options, failureCode, eventId) {
    try { return this.vault.capture(bytes, options); }
    catch (error) { emit(this.#diagnostics, failureCode, { operationId: eventId }); throw error; }
  }
  #normalEvent(value) {
    return this.#captureRecord(wire(validateNormalObservation({ profile: NORMAL_OBSERVATION_PROFILE, ...value })),
      { type: 'observation' }, 'CAPTURE_DESCRIPTOR_WRITE_FAILED', value.eventId);
  }
  #observedVersion(record, value, text) {
    return { id: value.eventId, observation: true, legacy: value.profile === LEGACY_NORMAL_OBSERVATION_PROFILE,
      observationProfile: value.profile, request: value.request, source: value.source, inputMethod: value.inputMethod,
      payload: { text }, scope: value.source.scope,
      mode: value.mode, descriptorId: record.manifest.eventId, recordDigest: record.recordDigest,
      state: 'PROMPT_SAVED', anchor: 'PENDING', timestamp: 'INDETERMINATE', anchorAttempts: 0, assuranceHistory: [] };
  }
  #restoreObservations(preserved = new Map()) {
    const records = this.vault.inspect().records;
    const byId = new Map(records.map(record => [record.manifest.eventId, record]));
    const observations = [];
    for (const record of records.filter(value => value.manifest.type === 'observation')) {
      const bytes = this.vault.read(record.manifest.evidence[0].objectDigest);
      const checked = verifyRecord(record, bytes);
      if (checked.integrity !== 'VALID' || checked.keyAttribution !== 'SIGNATURE_VALID') throw Error('INVALID_CAPTURE_HISTORY');
      const value = parseCanonical(bytes);
      observations.push({ record, value });
      if (![NORMAL_OBSERVATION_PROFILE, STRICT_OBSERVATION_PROFILE, QUALIFIED_OBSERVATION_PROFILE, DOM_OBSERVATION_PROFILE, LEGACY_NORMAL_OBSERVATION_PROFILE].includes(value.profile)) continue;
      (value.profile === NORMAL_OBSERVATION_PROFILE ? validateNormalObservation
        : value.profile === STRICT_OBSERVATION_PROFILE ? validateStrictObservation
        : value.profile === QUALIFIED_OBSERVATION_PROFILE ? validateQualifiedObservation
        : value.profile === DOM_OBSERVATION_PROFILE ? validateDOMObservation : validateLegacyNormalObservation)(value);
      if (['normal-send-intent', 'normal-request-observed'].includes(value.kind)) {
        const text = byId.get(value.textRecord);
        if (!text || text.manifest.evidence[0].objectDigest !== value.textObject
            || text.manifest.signingPublicKey !== record.manifest.signingPublicKey
            || this.#versions.has(value.eventId)) throw Error('INVALID_CAPTURE_HISTORY');
        const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(this.vault.read(value.textObject));
        const version = Object.assign(preserved.get(value.eventId) ?? {}, this.#observedVersion(record, value, content));
        this.#versions.set(value.eventId, version);
        if (value.request && !this.#providerMessages.has(value.request.messageId)) this.#providerMessages.set(value.request.messageId, version);
      } else {
        const version = this.#versions.get(value.eventId);
        if (!version || value.recordDigest !== version.recordDigest || canonical(value.source) !== canonical(version.source)
            || version.observationProfile !== value.profile
            || record.manifest.signingPublicKey !== byId.get(version.descriptorId)?.manifest.signingPublicKey) {
          throw Error('INVALID_CAPTURE_HISTORY');
        }
        if (value.kind === 'normal-acknowledgement') {
          if (version.request.conversationId !== null && version.request.conversationId !== value.acknowledgement.conversationId) throw Error('INVALID_CAPTURE_HISTORY');
          version.acknowledgement = value.acknowledgement;
        } else version.messageId = value.messageId;
      }
    }
    for (const { record, value } of observations) {
      const version = this.#versions.get(value.version);
      if (!version?.observation || value.profile !== 'pap-chatgpt-observation/1' || value.recordDigest !== version.recordDigest) continue;
      if (value.kind === 'request-deduplicated') {
        keys(value, ['profile', 'kind', 'version', 'recordDigest', 'eventId', 'source', 'request', 'inputMethod']);
        validateCaptureSource(value.source); validateRequest(value.request);
        if (!isUUID(value.eventId) || this.#aliases.has(value.eventId) || this.#versions.has(value.eventId)
            || value.inputMethod !== 'provider-request' || value.request.messageId !== version.request?.messageId
            || value.request.conversationId !== null && version.request.conversationId !== null
              && value.request.conversationId !== version.request.conversationId) throw Error('INVALID_CAPTURE_HISTORY');
        this.#aliases.set(value.eventId, { version, source: value.source, request: value.request, inputMethod: value.inputMethod });
        continue;
      }
      if (record.manifest.signingPublicKey !== byId.get(version.descriptorId)?.manifest.signingPublicKey) continue;
      if (value.kind === 'managed-submission' && TRANSACTION_PATTERN.test(value.transactionId ?? '')) {
        version.managed = { state: 'SUBMITTED_OR_UNKNOWN', transactionId: value.transactionId };
      }
      if (value.kind === 'anchor-attempt' && Number.isSafeInteger(value.number) && value.number >= 1) {
        version.anchorAttempts = Math.max(version.anchorAttempts, value.number);
      }
      if (value.kind === 'fast-confirmation' && value.report?.anchor === 'SOURCE_CORROBORATED'
          && value.report?.timestamp === 'SOURCE_REPORTED' && version.anchor === 'PENDING'
          || value.kind === 'consensus-assurance-upgrade' && value.report?.anchor === 'CONSENSUS_VERIFIED'
          && value.report?.timestamp === 'BLOCK_HASH_BOUND') {
        version.anchor = value.report.anchor; version.timestamp = value.report.timestamp;
        version.assuranceHistory.push({ anchor: version.anchor, timestamp: version.timestamp,
          profile: value.kind === 'fast-confirmation' ? FAST_CONFIRM_PROFILE : 'pap-algorand-sp/1',
          round: value.report.round, receiptId: record.manifest.eventId });
      }
    }
  }

  observeNormal(input) {
    try { return this.#observeNormal(input); }
    catch (error) {
      if (['CAPTURE_REPLAY_CONFLICT', 'CAPTURE_CORRELATION_CONFLICT', 'Legacy evidence is read-only'].includes(error.message)) throw error;
      const refs = { operationId: input?.eventId };
      emit(this.#diagnostics, 'CAPTURE_SESSION_FAILED', refs);
      emitCaptureFailure(this.#diagnostics, error, refs);
      // A write may have committed before its caller observed an error. Rebuild
      // the exact-ID receipt index; absence still leaves the caller uncertain.
      const preserved = new Map(this.#versions);
      this.#versions.clear(); this.#providerMessages.clear(); this.#aliases.clear();
      try { this.#restoreObservations(preserved); }
      catch (reconciliationError) {
        emit(this.#diagnostics, 'CAPTURE_RECONCILIATION_FAILED', refs);
        emitCaptureFailure(this.#diagnostics, reconciliationError, refs);
        throw reconciliationError;
      }
      throw error;
    }
  }
  #observeNormal(input) {
    const { eventId, source, text } = input;
    const alias = this.#aliases.get(eventId);
    if (alias && input.kind === 'acknowledgement') throw Error('CAPTURE_CORRELATION_CONFLICT');
    if (alias && canonical(alias.source) !== canonical(source)) throw Error('CAPTURE_REPLAY_CONFLICT');
    const prior = alias?.version ?? this.#versions.get(eventId);
    if (prior && !alias && prior.observationProfile !== NORMAL_OBSERVATION_PROFILE) throw Error('Legacy evidence is read-only');
    if (prior && (!prior.observation || !alias && canonical(prior.source) !== canonical(source)
        || input.kind === 'request-observed' && (prior.payload.text !== text || (alias?.inputMethod ?? prior.inputMethod) !== input.inputMethod
          || canonical(alias?.request ?? prior.request) !== canonical(input.request)))) throw Error('CAPTURE_REPLAY_CONFLICT');
    if (input.kind === 'acknowledgement') {
      if (!prior || prior.request.conversationId !== null && prior.request.conversationId !== input.acknowledgement.conversationId
          || prior.acknowledgement && canonical(prior.acknowledgement) !== canonical(input.acknowledgement)) throw Error('CAPTURE_CORRELATION_CONFLICT');
      if (!prior.acknowledgement) {
        this.#normalEvent({ kind: 'normal-acknowledgement', eventId, source, recordDigest: prior.recordDigest,
          acknowledgement: input.acknowledgement, correlation: 'SAME_FETCH_CALL', providerReceipt: 'UNKNOWN' });
        prior.acknowledgement = input.acknowledgement;
      }
      return this.#public(prior);
    }
    if (prior) return this.#public(prior);
    const repeated = this.#providerMessages.get(input.request.messageId);
    if (repeated) {
      // Provider message IDs survive fetch retries, route changes, tabs and
      // engine restarts. A retry cannot rewrite the original source or text.
      if (repeated.payload.text !== text || repeated.request.conversationId !== null
          && input.request.conversationId !== null && repeated.request.conversationId !== input.request.conversationId) {
        throw Error('CAPTURE_REPLAY_CONFLICT');
      }
      emit(this.#diagnostics, 'REQUEST_DEDUPLICATED', { operationId: eventId });
      this.#captureRecord(wire({ profile: 'pap-chatgpt-observation/1', kind: 'request-deduplicated',
        version: repeated.id, recordDigest: repeated.recordDigest, eventId, source,
        request: input.request, inputMethod: input.inputMethod }), { type: 'observation' }, 'CAPTURE_ALIAS_WRITE_FAILED', eventId);
      this.#aliases.set(eventId, { version: repeated, source: structuredClone(source),
        request: structuredClone(input.request), inputMethod: input.inputMethod });
      return this.#public(repeated);
    }
    const captured = this.#captureRecord(Buffer.from(text, 'utf8'), undefined, 'CAPTURE_TEXT_WRITE_FAILED', eventId);
    const value = { profile: NORMAL_OBSERVATION_PROFILE, kind: 'normal-request-observed', eventId, source,
      inputMethod: input.inputMethod, request: input.request,
      textRecord: captured.manifest.eventId, textObject: captured.manifest.evidence[0].objectDigest,
      mode: 'ON', boundary: 'provider_fetch', coverage: 'UTF8_NEW_USER_MESSAGE',
      releaseClass: 'RETROSPECTIVE_OBSERVATION', attachments: 'UNSUPPORTED', providerReceipt: 'UNKNOWN' };
    const record = this.#normalEvent(value), version = this.#observedVersion(record, value, text);
    this.#versions.set(eventId, version); this.#providerMessages.set(input.request.messageId, version);
    emit(this.#diagnostics, 'VAULT_CAPTURED', { operationId: eventId, captureId: captured.manifest.eventId });
    emit(this.#diagnostics, 'NORMAL_PROMPT_SAVED', { operationId: eventId, captureId: captured.manifest.eventId });
    return this.#public(version);
  }
  #version(id) { const value = this.#versions.get(id); if (!value) throw Error('Unknown version'); return value; }
  #public(value) {
    const { payload: _payload, ...visible } = value;
    return structuredClone(visible);
  }
  version(id) { const value = this.#versions.get(id); return value ? this.#public(value) : null; }
  get versionCount() { return this.#versions.size; }
  captureReceipt(eventId, source = null) {
    if (!isUUID(eventId)) throw Error('INVALID_CAPTURE_RECEIPT');
    if (source) validateCaptureSource(source);
    const alias = this.#aliases.get(eventId), version = alias?.version ?? this.#versions.get(eventId);
    const saved = version && (!source || canonical(alias?.source ?? version.source) === canonical(source));
    return { profile: 'pap-chatgpt-capture/5', eventId, kind: 'request-observed',
      state: saved ? 'PROMPT_SAVED' : 'SAVE_PENDING',
      ...(saved ? { receiptId: version.descriptorId, ...(alias ? { deduplicated: true } : {}) } : {}) };
  }

  anchorRequest(id) {
    const version = this.#version(id), batch = inclusion([unb64(version.recordDigest, 32)], 0);
    return { recordDigest: version.recordDigest, batch, payload: b64(anchorPayload(unb64(batch.root, 32))) };
  }

  async #validateFast(version, evidence) {
    const request = this.anchorRequest(version.id);
    const report = await this.#verifyFast(evidence, structuredClone(this.#fastTrust), request.payload);
    if (!report?.authorized || report.anchor !== 'SOURCE_CORROBORATED'
        || report.timestamp !== 'SOURCE_REPORTED' || report.assurance !== FAST_CONFIRM_PROFILE) {
      throw Error('Fast confirmation did not satisfy the proof profile');
    }
    const receipt = this.#event({
      kind: 'fast-confirmation', version: version.id, recordDigest: version.recordDigest,
      expectedAnchorPayload: request.payload, report, ...storePublicProof(this.vault, evidence),
    });
    return { report: structuredClone(report), receiptId: receipt.manifest.eventId };
  }

  managedStatus() { return this.#managed?.status() ?? { state: 'NOT_CONFIGURED' }; }
  connectManaged({ accessCode }) {
    if (!this.#managed) throw managedError('NOT_CONFIGURED');
    return this.#managed.connect(accessCode);
  }
  disconnectManaged() { return this.#managed?.disconnect() ?? { state: 'NOT_CONFIGURED' }; }
  anchorManaged(request) { return this.#confirm(request, true); }
  confirmFast(request) { return this.#confirm(request, false); }

  #confirm({ id, transactionId }, managed) {
    return this.#serial(async () => {
      const started = performance.now(), version = this.#version(id);
      if (this.#closed || version.legacy || version.anchor !== 'PENDING') throw Error('Anchor work unavailable');
      if (version.anchorAttempts >= Number.MAX_SAFE_INTEGER) throw Error('ANCHOR_RETRY_LIMIT');
      let attempted = false;
      const beforeSubmit = () => {
        if (attempted) return;
        this.#event({ kind: 'anchor-attempt', version: id, recordDigest: version.recordDigest,
          number: version.anchorAttempts + 1 });
        version.anchorAttempts++; attempted = true;
      };
      if (managed) {
        const savedTransactionId = version.managed?.transactionId;
        emit(this.#diagnostics, 'SPONSOR_REQUESTED', { operationId: id });
        const sponsorStarted = performance.now();
        try {
          if (!this.#managed) throw managedError('NOT_CONFIGURED');
          const submitted = savedTransactionId ? { transactionId: savedTransactionId }
            : await this.#managed.submit(this.anchorRequest(id).payload, { beforeSubmit });
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
      if (!TRANSACTION_PATTERN.test(transactionId ?? '')) throw Error('Algorand transaction ID required');
      // This cumulative journal is an audit, not a lifetime abandonment limit.
      // The engine bounds each automatic batch. Managed reservations/spend stay
      // keyed to the same payload; a known transaction only needs reconciliation.
      beforeSubmit();
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
          const evidence = await collect();
          emit(this.#diagnostics, 'CONFIRMATION_COLLECTED', confirmationRefs);
          const accepted = await this.#validateFast(version, evidence);
          version.anchor = accepted.report.anchor; version.timestamp = accepted.report.timestamp;
          version.assuranceHistory.push({ anchor: version.anchor, timestamp: version.timestamp,
            profile: FAST_CONFIRM_PROFILE, round: accepted.report.round, receiptId: accepted.receiptId });
          emit(this.#diagnostics, 'CONFIRMATION_ACCEPTED', { ...confirmationRefs, durationMs: performance.now() - confirmationStarted });
      } catch (error) {
        if (version.anchor === 'PENDING') emit(this.#diagnostics,
          error?.code === 'PENDING_FAST_CONFIRMATION' ? 'CONFIRMATION_PENDING' : 'CONFIRMATION_REJECTED',
          { ...confirmationRefs, durationMs: performance.now() - confirmationStarted });
        throw error;
      }
      return this.#public(version);
    }, { operationId: id });
  }

  upgradeConsensus({ id, envelope, trust }) {
    return this.#serial(async () => {
      const version = this.#version(id);
      if (version.legacy) throw Error('Legacy evidence is read-only');
      if (version.anchor === 'CONSENSUS_VERIFIED') throw Error('Duplicate consensus upgrade');
      const envelopeBytes = Buffer.isBuffer(envelope) ? envelope : Buffer.from(envelope);
      const archivedEvidence = parseCanonical(envelopeBytes, 8 * 1024 * 1024);
      const report = await this.#verifyArchive(envelopeBytes, trust, version.recordDigest);
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

  status() { return { versions: [...this.#versions.values()].map(value => this.#public(value)) }; }
  async drain() { while (this.#tails.size) await Promise.all(this.#tails.values()); }
  close() { this.#closed = true; if (this.#ownsVault) this.vault.close(); emit(this.#diagnostics, 'ENGINE_CLOSED'); }
}
