import { keys, unb64 } from '../vault/format.mjs';

export const MANAGED_PROFILE = 'pap-managed-anchor/1';
export const MANAGED_NETWORK = 'testnet-v1.0';
export const MANAGED_GENESIS = 'SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=';
export const FEE_MICROALGOS = 1000;
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const TRANSACTION_PATTERN = /^[A-Z2-7]{52}$/;
export const FALLBACK = Object.freeze({
  NOT_CONFIGURED: 'Managed anchoring is unavailable in this build.',
  ACCOUNT_REQUIRED: 'Connect your anchoring account to request new anchors.',
  UNPAID: 'Your anchoring subscription has expired. Renew it to request new anchors.',
  QUOTA_EXHAUSTED: 'Your anchoring allowance is used up. Retry after the quota resets.',
  RATE_LIMITED: 'Too many anchoring requests. Wait before retrying.',
  SERVICE_UNAVAILABLE: 'Managed anchoring is unavailable. Retry later.',
  SUBMISSION_INTERRUPTED: 'The anchor could not be prepared. Freeze a new version to try again.',
});
export function managedError(code) {
  const safe = Object.hasOwn(FALLBACK, code) ? code : 'SERVICE_UNAVAILABLE';
  return Object.assign(Error(FALLBACK[safe]), { code: safe });
}
export function validateAnchorRequest(value) {
  keys(value, ['profile', 'payload']);
  if (value.profile !== MANAGED_PROFILE) throw Error('Unsupported managed anchor profile');
  const payload = unb64(value.payload, 36);
  if (!payload.subarray(0, 4).equals(Buffer.from([0x50, 0x41, 0x50, 0x01]))) throw Error('Invalid blinded anchor payload');
  return value;
}
