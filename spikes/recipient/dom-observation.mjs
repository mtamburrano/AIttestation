import { keys, unb64 } from '../vault/format.mjs';

export const DOM_OBSERVATION_PROFILE = 'pap-chatgpt-observation/3';
export const isUUID = value => typeof value === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const bounded = (value, maximum) => typeof value === 'string' && value.length > 0 && value.length <= maximum;
const invalid = () => { throw Error('INVALID_CAPTURE_OBSERVATION'); };

export function validateCaptureSource(source) {
  keys(source, ['adapterProfile', 'pageContract', 'runtimeEpoch', 'browserSessionId', 'scope',
    'tabId', 'windowId', 'tabEpoch', 'documentId', 'destination']);
  if (source.adapterProfile !== 'pap-chatgpt-chrome/6' || source.pageContract !== 'chatgpt-web-text/2026-09-15'
      || !isUUID(source.scope) || !bounded(source.runtimeEpoch, 128) || !bounded(source.browserSessionId, 128)
      || !Number.isSafeInteger(source.tabId) || source.tabId < 0
      || !Number.isSafeInteger(source.windowId) || source.windowId < 0
      || !bounded(source.tabEpoch, 128) || !bounded(source.documentId, 128)
      || !bounded(source.destination, 256) || !/^(new-chat|conversation:[A-Za-z0-9_-]+)$/.test(source.destination)) invalid();
}

// The new profile has a closed assertion vocabulary. Legacy observations keep
// their original parser and bytes; new records can never declare release grants.
export function validateDOMObservation(value) {
  const base = ['profile', 'kind', 'eventId', 'source'];
  if (value?.profile !== DOM_OBSERVATION_PROFILE || !isUUID(value.eventId)) invalid();
  validateCaptureSource(value.source);
  if (value.kind === 'normal-send-intent') {
    keys(value, [...base, 'inputMethod', 'textRecord', 'textObject', 'mode', 'boundary', 'coverage',
      'releaseClass', 'attachments', 'providerReceipt']);
    if (!['send-button', 'enter'].includes(value.inputMethod) || !bounded(value.textRecord, 128)
        || !bounded(value.textObject, 128) || value.mode !== 'ON' || value.boundary !== 'provider_dom'
        || value.coverage !== 'UTF8_COMPOSER_TEXT' || value.releaseClass !== 'RETROSPECTIVE_OBSERVATION'
        || value.attachments !== 'UNSUPPORTED' || value.providerReceipt !== 'UNKNOWN') invalid();
    unb64(value.textObject, 32);
  } else if (value.kind === 'normal-message-observed') {
    keys(value, [...base, 'recordDigest', 'messageId', 'correlation', 'providerReceipt']);
    if (!bounded(value.recordDigest, 128) || !bounded(value.messageId, 128) || !/^[A-Za-z0-9_-]+$/.test(value.messageId)
        || value.correlation !== 'UNIQUE_NEW_EXACT_TEXT_DOM_MATCH' || value.providerReceipt !== 'UNKNOWN') invalid();
    unb64(value.recordDigest, 32);
  } else invalid();
  return value;
}
