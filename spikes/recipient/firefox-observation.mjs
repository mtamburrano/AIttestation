import { keys, unb64 } from '../vault/format.mjs';
import { isUUID, validateBrowserSource, validateRequest, validateAcknowledgement } from './normal-observation.mjs';

export const FIREFOX_ADAPTER_PROFILE = 'pap-chatgpt-firefox/1';
export const FIREFOX_CAPTURE_PROFILE = 'pap-firefox-chatgpt-capture/1';
export const FIREFOX_OBSERVATION_PROFILE = 'pap-firefox-chatgpt-observation/1';
export const validateFirefoxSource = source => validateBrowserSource(source, FIREFOX_ADAPTER_PROFILE);
const invalid = () => { throw Error('INVALID_CAPTURE_OBSERVATION'); };

export function validateFirefoxObservation(value) {
  if (value?.profile !== FIREFOX_OBSERVATION_PROFILE || !isUUID(value.eventId)) invalid();
  validateFirefoxSource(value.source);
  const base = ['profile', 'kind', 'eventId', 'source'];
  if (value.kind === 'normal-request-observed') {
    keys(value, [...base, 'inputMethod', 'request', 'textRecord', 'textObject', 'mode', 'boundary', 'coverage',
      'releaseClass', 'attachments', 'providerReceipt']);
    validateRequest(value.request);
    if (value.inputMethod !== 'provider-request' || typeof value.textRecord !== 'string' || !value.textRecord.length
        || value.textRecord.length > 128 || value.mode !== 'ON' || value.boundary !== 'provider_fetch'
        || value.coverage !== 'UTF8_NEW_USER_MESSAGE' || value.releaseClass !== 'RETROSPECTIVE_OBSERVATION'
        || value.attachments !== 'UNSUPPORTED' || value.providerReceipt !== 'UNKNOWN') invalid();
    unb64(value.textObject, 32);
  } else if (value.kind === 'normal-acknowledgement') {
    keys(value, [...base, 'recordDigest', 'acknowledgement', 'correlation', 'providerReceipt']);
    validateAcknowledgement(value.acknowledgement); unb64(value.recordDigest, 32);
    if (value.correlation !== 'SAME_FETCH_CALL' || value.providerReceipt !== 'UNKNOWN') invalid();
  } else invalid();
  return value;
}
