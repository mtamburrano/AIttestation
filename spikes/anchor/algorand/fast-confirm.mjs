import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { canonical, parseCanonical, unb64 } from '../../vault/format.mjs';
import { emit } from '../../diagnostics/local.mjs';
import { parseUniqueJSON } from '../../distribution/unique-json.mjs';

export const FAST_CONFIRM_PROFILE = 'PAP_ALGORAND_FAST_CONFIRM_V1';
export const FAST_CONFIRM_WAIT_MS = 20_000;
export const ALGOD_OBSERVER_PROFILE = 'pap-algod-observer-request/1';
export const ALGOD_RETRY_PROFILE = 'pap-algod-observer-retry/1';
const MAX_OBSERVER_OUTPUT = 8 * 1024 * 1024;
const RETRY_DELAYS_MS = [100, 200, 400, 800, 1000];
const retryCodes = new Set(['ALGOD_NOT_YET_OBSERVABLE', 'ALGOD_NOT_YET_CONFIRMED']);
const transactionIdPattern = /^[A-Z2-7]{52}$/;
const evidenceFields = ['profile', 'network', 'genesis', 'consensus', 'transaction', 'signedTxnInBlock', 'fullHeader', 'transactionProof'];

function evidenceObject(value) {
  if (Buffer.isBuffer(value) || typeof value === 'string') {
    return parseCanonical(Buffer.from(value), 8 * 1024 * 1024);
  }
  if (!value || typeof value !== 'object') throw Error('Fast confirmation evidence required');
  return structuredClone(value);
}

export function verifyFastConfirmation(evidence, trust, expectedPayload, { verifierPath } = {}) {
  evidence = evidenceObject(evidence);
  if (!trust || typeof trust !== 'object') throw Error('Independent fast-confirmation trust configuration required');
  const payload = Buffer.isBuffer(expectedPayload) ? expectedPayload : unb64(expectedPayload, 36);
  if (payload.length !== 36 || !payload.subarray(0, 4).equals(Buffer.from([0x50, 0x41, 0x50, 0x01]))) {
    throw Error('Invalid expected anchor payload');
  }
  const binary = verifierPath ?? fileURLToPath(new URL('./bin/fast-verify', import.meta.url));
  const result = spawnSync(binary, [], {
    input: canonical({ evidence, trust, expectedPayload: payload.toString('base64') }),
    encoding: 'utf8', env: {}, timeout: 10_000, maxBuffer: 128 * 1024,
  });
  if (result.error) throw Error('Local fast-confirmation verifier unavailable or resource limit exceeded');
  let report;
  try { report = JSON.parse(result.stdout); } catch { throw Error('Malformed local fast-confirmation verifier result'); }
  const allowed = ['profile', 'anchor', 'timestamp', 'authorized', 'round', 'blockTime', 'blockHeaderHash', 'sourceClaimedTimes', 'assurance', 'reason'];
  if (!report || Array.isArray(report) || typeof report !== 'object'
      || Object.keys(report).some(name => !allowed.includes(name))) throw Error('Malformed local fast-confirmation verifier result');
  if (report.profile !== FAST_CONFIRM_PROFILE || typeof report.authorized !== 'boolean'
      || typeof report.reason !== 'string' || typeof report.assurance !== 'string') {
    throw Error('Malformed local fast-confirmation verifier result');
  }
  if (!report.authorized || result.status !== 0 || report.anchor !== 'SOURCE_CORROBORATED'
      || report.timestamp !== 'SOURCE_REPORTED' || report.assurance !== FAST_CONFIRM_PROFILE
      || !Number.isSafeInteger(report.round) || report.round <= 0
      || !Number.isSafeInteger(report.blockTime) || report.blockTime <= 0
      || !Array.isArray(report.sourceClaimedTimes) || report.sourceClaimedTimes.length !== 2) {
    const error = Error(`Fast confirmation not authorized: ${report.reason}`);
    error.code = report.anchor === 'INDETERMINATE' ? 'PENDING_FAST_CONFIRMATION' : 'INVALID_FAST_CONFIRMATION';
    error.report = report;
    throw error;
  }
  if (typeof report.blockHeaderHash !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(report.blockHeaderHash)
      || Buffer.from(report.blockHeaderHash, 'base64').length !== 32
      || Buffer.from(report.blockHeaderHash, 'base64').toString('base64') !== report.blockHeaderHash) {
    throw Error('Malformed local fast-confirmation verifier result');
  }
  return report;
}

function boundedObservation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('Algod observation missing');
  const copy = structuredClone(value);
  const required = ['transactionId', 'confirmedRound', 'blockHeaderHash', 'sourceClaimedTime',
    'poolError', 'error', 'expired', ...evidenceFields];
  for (const field of required) if (!Object.hasOwn(copy, field)) throw invalid(`Algod observation missing ${field}`);
  if (required.filter(field => !['confirmedRound', 'expired', 'transactionProof', 'poolError', 'error'].includes(field))
    .some(field => typeof copy[field] !== 'string' || !copy[field])
      || !Number.isSafeInteger(copy.confirmedRound) || copy.confirmedRound <= 0
      || copy.poolError !== '' || copy.error !== '' || copy.expired !== false
      || !copy.transactionProof || typeof copy.transactionProof !== 'object' || Array.isArray(copy.transactionProof)
      || Buffer.byteLength(canonical(copy)) > MAX_OBSERVER_OUTPUT) {
    throw invalid('Malformed or rejected Algod observation');
  }
  return copy;
}

function invalid(message, cause) {
  return Object.assign(Error(message, cause ? { cause } : undefined), { code: 'INVALID_FAST_CONFIRMATION' });
}

function pending(message, cause) {
  const error = Error(`PENDING_FAST_CONFIRMATION: ${message}`, cause ? { cause } : undefined);
  error.code = 'PENDING_FAST_CONFIRMATION';
  return error;
}

/**
 * Calls the fixed-purpose observer binary for exactly one locally configured
 * operator. The binary owns HTTPS, redirect, endpoint, response-size and time
 * bounds; this wrapper additionally bounds process output and aborts it with the
 * shared two-source collection budget.
 */
export function observeAlgodOperator(operator, {
  transactionId, signal, observerPath = fileURLToPath(new URL('./bin/fast-observe', import.meta.url)),
} = {}) {
  if (!operator || Object.keys(operator).sort().join(',') !== 'endpoint,id,organization'
      || typeof operator.id !== 'string' || typeof operator.organization !== 'string'
      || typeof operator.endpoint !== 'string' || !transactionIdPattern.test(transactionId ?? '')) {
    throw Error('Invalid fixed-purpose Algod observer request');
  }
  if (signal?.aborted) return Promise.reject(pending('two-operator observation was interrupted'));
  return new Promise((resolve, reject) => {
    let settled = false, size = 0;
    const stdout = [];
    const child = spawn(observerPath, [], { env: {}, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const finish = (callback, value) => {
      if (settled) return;
      settled = true; signal?.removeEventListener('abort', abort);
      if (callback === reject) child.kill('SIGKILL');
      callback(value);
    };
    const abort = () => {
      child.kill('SIGKILL');
      finish(reject, pending('two-operator observation was interrupted'));
    };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', cause => finish(reject, invalid('local Algod observer is unavailable', cause)));
    const countOutput = chunk => {
      if (settled) return false;
      size += chunk.length;
      if (size > MAX_OBSERVER_OUTPUT) {
        finish(reject, invalid('local Algod observer exceeded its output limit')); return false;
      }
      return true;
    };
    child.stdout.on('data', chunk => {
      if (countOutput(chunk)) stdout.push(Buffer.from(chunk));
    });
    // Remote diagnostics are deliberately not relayed into product state.
    child.stderr.on('data', countOutput);
    child.once('close', code => {
      if (settled) return;
      if (code !== 0 && code !== 2) return finish(reject, invalid('configured Algod operator did not provide bounded evidence'));
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(stdout));
        const value = parseUniqueJSON(text);
        if (code === 2) {
          if (!value || Object.keys(value).sort().join(',') !== 'profile,reason,transactionId'
              || value.profile !== ALGOD_RETRY_PROFILE || value.transactionId !== transactionId || !retryCodes.has(value.reason)) {
            throw invalid('Malformed local Algod retry result');
          }
          return finish(reject, Object.assign(Error(value.reason), { code: value.reason }));
        }
        finish(resolve, boundedObservation(value));
      } catch (cause) { finish(reject, invalid('local Algod observer returned malformed evidence', cause)); }
    });
    child.stdin.on('error', cause => finish(reject, invalid('local Algod observer input failed', cause)));
    child.stdin.end(canonical({ profile: ALGOD_OBSERVER_PROFILE, operator, transactionId }));
  });
}

// Both configured operators are queried concurrently under one hard wait
// budget. Product callers use the fixed-purpose observer above; tests may inject
// an isolated transport function without changing the session's release gate.
export async function collectFastEvidence({
  trust, transactionId, observe = null, observerPath,
  waitMs = FAST_CONFIRM_WAIT_MS, now = () => performance.now(), signal, diagnostics,
}) {
  if (!trust || trust.profile !== FAST_CONFIRM_PROFILE || !Array.isArray(trust.operators) || trust.operators.length !== 2) {
    throw Error('Two configured fast-confirmation operators required');
  }
  if ((observe !== null && typeof observe !== 'function') || typeof now !== 'function' || !Number.isSafeInteger(waitMs)
      || waitMs < 1 || waitMs > FAST_CONFIRM_WAIT_MS) {
    throw Error('Invalid fast-confirmation collector configuration');
  }
  if (typeof transactionId !== 'string' || !transactionIdPattern.test(transactionId)) {
    throw Error('A canonical Algorand transaction ID is required for observation');
  }
  trust = structuredClone(trust);
  validateOperators(trust);
  const observer = observe ?? ((operator, { signal }) => observeAlgodOperator(operator, {
    transactionId, signal, ...(observerPath === undefined ? {} : { observerPath }),
  }));
  const controller = new AbortController(), started = now();
  let expiryReported = false;
  const expired = () => {
    if (!expiryReported) emit(diagnostics, 'CONFIRMATION_BUDGET_EXPIRED');
    expiryReported = true;
    return pending('confirmation wait budget expired');
  };
  const remaining = () => {
    const elapsed = now() - started;
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= waitMs) throw expired();
    return waitMs - elapsed;
  };
  let timer, stop;
  const interrupted = new Promise((_, reject) => {
    stop = () => {
      emit(diagnostics, 'CONFIRMATION_INTERRUPTED');
      controller.abort(); reject(pending('two-operator observation was interrupted'));
    };
    timer = setTimeout(() => {
      controller.abort(); reject(expired());
    }, waitMs);
  });
  signal?.addEventListener('abort', stop, { once: true });
  const collectOperator = async operator => {
    for (let attempt = 0; ; attempt++) {
      if (controller.signal.aborted) throw pending('two-operator observation was interrupted');
      remaining();
      let value;
      try {
        value = await observer(structuredClone(operator), { signal: controller.signal, transactionId });
      } catch (error) {
        if (controller.signal.aborted) throw pending('two-operator observation was interrupted');
        if (!retryCodes.has(error?.code)) throw error;
        emit(diagnostics, error.code);
        remaining();
        // Preserve the full backoff; the shared deadline aborts a delay that
        // cannot finish in time without creating a fractional final retry.
        const backoff = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
        try { await delay(backoff, undefined, { signal: controller.signal }); }
        catch { throw pending('two-operator observation was interrupted'); }
        continue;
      }
      const observation = boundedObservation(value);
      if (observation.transactionId !== transactionId || observation.profile !== trust.profile
          || observation.network !== trust.network || observation.genesis !== trust.genesis) {
        throw invalid('Algod observation conflicts with the requested transaction or network');
      }
      return observation;
    }
  };
  try {
    if (signal?.aborted) { stop(); await interrupted; }
    const observations = await Promise.race([
      Promise.all(trust.operators.map(collectOperator)), interrupted,
    ]);
    const first = observations[0];
    for (const field of [...evidenceFields, 'transactionId', 'confirmedRound', 'blockHeaderHash']) {
      if (canonical(first[field]) !== canonical(observations[1][field])) {
        throw invalid('Conflicting Algod corroboration evidence');
      }
    }
    const elapsed = Math.ceil(now() - started);
    if (!Number.isSafeInteger(elapsed) || elapsed < 0 || elapsed >= waitMs) throw expired();
    return {
      profile: first.profile, network: first.network, genesis: first.genesis, consensus: first.consensus,
      transactionId: first.transactionId, transaction: first.transaction,
      signedTxnInBlock: first.signedTxnInBlock, fullHeader: first.fullHeader,
      transactionProof: first.transactionProof,
      sources: observations.map((source, index) => ({
        operatorId: trust.operators[index].id,
        organization: trust.operators[index].organization,
        endpoint: trust.operators[index].endpoint,
        transactionId: source.transactionId, confirmedRound: source.confirmedRound,
        blockHeaderHash: source.blockHeaderHash, sourceClaimedTime: source.sourceClaimedTime,
        poolError: source.poolError, error: source.error, expired: source.expired,
      })),
      observedWaitMillis: elapsed,
    };
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', stop); controller.abort();
  }
}

function validateOperators(trust) {
  const endpoint = raw => {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash
        || `${url.origin}${url.pathname === '/' ? '' : url.pathname}` !== raw
        || url.pathname !== '/' && (url.pathname.endsWith('/') || url.pathname.includes('//') || url.pathname.includes('%'))) {
      throw invalid('Invalid configured Algod HTTPS endpoint');
    }
    return url.hostname;
  };
  const hosts = new Set([endpoint(trust.applicationServiceOrigin)]), ids = new Set(), organizations = new Set();
  for (const operator of trust.operators) {
    if (!operator || Object.keys(operator).sort().join(',') !== 'endpoint,id,organization'
        || ['id', 'organization', 'endpoint'].some(field => typeof operator[field] !== 'string' || !operator[field]
          || operator[field].length > 2048 || operator[field] !== operator[field].trim())) {
      throw invalid('Invalid fast-confirmation operator configuration');
    }
    const host = endpoint(operator.endpoint), organization = operator.organization.toLowerCase();
    if (hosts.has(host) || ids.has(operator.id) || organizations.has(organization)) {
      throw invalid('Fast-confirmation operators must be independent');
    }
    hosts.add(host); ids.add(operator.id); organizations.add(organization);
  }
}
