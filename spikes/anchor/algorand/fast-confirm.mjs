import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonical, parseCanonical, unb64 } from '../../vault/format.mjs';

export const FAST_CONFIRM_PROFILE = 'PAP_ALGORAND_FAST_CONFIRM_V1';
export const FAST_CONFIRM_WAIT_MS = 20_000;

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

// Network access is injected so the caller can enforce TLS policy and endpoint
// allowlists. Both configured operators are queried concurrently under one hard
// wait budget; timeout yields no evidence and therefore no release authority.
export async function collectFastEvidence({ trust, observe, waitMs = FAST_CONFIRM_WAIT_MS, now = () => performance.now() }) {
  if (!trust || trust.profile !== FAST_CONFIRM_PROFILE || !Array.isArray(trust.operators) || trust.operators.length !== 2) {
    throw Error('Two configured fast-confirmation operators required');
  }
  if (typeof observe !== 'function' || !Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > FAST_CONFIRM_WAIT_MS) {
    throw Error('Invalid fast-confirmation collector configuration');
  }
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
      Promise.all(trust.operators.map(operator => observe(structuredClone(operator), { signal: controller.signal }).then(boundedObservation))),
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
