import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonical, parseCanonical, unb64 } from '../../vault/format.mjs';

export const FAST_CONFIRM_PROFILE = 'PAP_ALGORAND_FAST_CONFIRM_V1';
export const FAST_CONFIRM_WAIT_MS = 20_000;
export const ALGOD_OBSERVER_PROFILE = 'pap-algod-observer-request/1';
const MAX_OBSERVER_OUTPUT = 8 * 1024 * 1024;
const transactionIdPattern = /^[A-Z2-7]{52}$/;

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
  if (!value || typeof value !== 'object') throw Error('Algod observation missing');
  const copy = structuredClone(value);
  const required = ['transactionId', 'confirmedRound', 'blockHeaderHash', 'sourceClaimedTime',
    'poolError', 'error', 'expired'];
  for (const field of required) if (!Object.hasOwn(copy, field)) throw Error(`Algod observation missing ${field}`);
  return copy;
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
  return new Promise((resolve, reject) => {
    let settled = false, size = 0;
    const stdout = [];
    const child = spawn(observerPath, [], { env: {}, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const finish = (callback, value) => {
      if (settled) return;
      settled = true; signal?.removeEventListener('abort', abort); callback(value);
    };
    const abort = () => {
      child.kill('SIGKILL');
      finish(reject, pending('two-operator observation was interrupted'));
    };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', cause => finish(reject, pending('local Algod observer is unavailable', cause)));
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_OBSERVER_OUTPUT) {
        child.kill('SIGKILL'); finish(reject, pending('local Algod observer exceeded its output limit'));
      } else stdout.push(Buffer.from(chunk));
    });
    // Remote diagnostics are deliberately not relayed into product state.
    child.stderr.resume();
    child.once('close', code => {
      if (settled) return;
      if (code !== 0) return finish(reject, pending('configured Algod operator did not provide bounded evidence'));
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(stdout));
        const value = JSON.parse(text);
        finish(resolve, boundedObservation(value));
      } catch (cause) { finish(reject, pending('local Algod observer returned malformed evidence', cause)); }
    });
    child.stdin.on('error', cause => finish(reject, pending('local Algod observer input failed', cause)));
    child.stdin.end(canonical({ profile: ALGOD_OBSERVER_PROFILE, operator, transactionId }));
  });
}

// Both configured operators are queried concurrently under one hard wait
// budget. Product callers use the fixed-purpose observer above; tests may inject
// an isolated transport function without changing the session's release gate.
export async function collectFastEvidence({
  trust, transactionId, observe = null, observerPath,
  waitMs = FAST_CONFIRM_WAIT_MS, now = () => performance.now(),
}) {
  if (!trust || trust.profile !== FAST_CONFIRM_PROFILE || !Array.isArray(trust.operators) || trust.operators.length !== 2) {
    throw Error('Two configured fast-confirmation operators required');
  }
  if ((observe !== null && typeof observe !== 'function') || !Number.isSafeInteger(waitMs)
      || waitMs < 1 || waitMs > FAST_CONFIRM_WAIT_MS) {
    throw Error('Invalid fast-confirmation collector configuration');
  }
  if (observe === null && !transactionIdPattern.test(transactionId ?? '')) {
    throw Error('A canonical Algorand transaction ID is required for observation');
  }
  const observer = observe ?? ((operator, { signal }) => observeAlgodOperator(operator, {
    transactionId, signal, ...(observerPath === undefined ? {} : { observerPath }),
  }));
  const controller = new AbortController(), started = now();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const error = Error('PENDING_FAST_CONFIRMATION: confirmation wait budget expired');
      error.code = 'PENDING_FAST_CONFIRMATION'; reject(error);
    }, waitMs);
  });
  try {
    const observations = await Promise.race([
      Promise.all(trust.operators.map(operator => observer(structuredClone(operator), {
        signal: controller.signal, transactionId,
      }).then(boundedObservation))),
      timeout,
    ]);
    const elapsed = Math.ceil(now() - started);
    if (!Number.isSafeInteger(elapsed) || elapsed < 0 || elapsed > waitMs) {
      const error = Error('PENDING_FAST_CONFIRMATION: confirmation wait budget expired');
      error.code = 'PENDING_FAST_CONFIRMATION'; throw error;
    }
    const first = observations[0];
    for (const field of ['profile', 'network', 'genesis', 'consensus', 'transaction', 'signedTxnInBlock', 'fullHeader', 'transactionProof']) {
      if (!Object.hasOwn(first, field)) throw Error(`Algod cryptographic evidence missing ${field}`);
    }
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
    clearTimeout(timer); controller.abort();
  }
}
