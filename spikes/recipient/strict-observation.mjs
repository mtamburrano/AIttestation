import { keys, unb64 } from '../vault/format.mjs';

export const CHATGPT_CAPTURE_PROFILE = 'pap-chatgpt-capture/4';
export const STRICT_OBSERVATION_PROFILE = 'pap-chatgpt-observation/5';
export const isUUID = value => typeof value === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const bounded = (value, maximum) => typeof value === 'string' && value.length > 0 && value.length <= maximum;
const id = value => bounded(value, 128) && /^[A-Za-z0-9_-]+$/.test(value);
const invalid = () => { throw Error('INVALID_CAPTURE_OBSERVATION'); };

export function validateCaptureSource(source) {
  keys(source, ['adapterProfile', 'pageContract', 'runtimeEpoch', 'browserSessionId', 'scope',
    'tabId', 'windowId', 'tabEpoch', 'documentId', 'destination']);
  if (source.adapterProfile !== 'pap-chatgpt-chrome/8' || source.pageContract !== 'chatgpt-web-text/2026-09-21'
      || !isUUID(source.scope) || !bounded(source.runtimeEpoch, 128) || !bounded(source.browserSessionId, 128)
      || !Number.isSafeInteger(source.tabId) || source.tabId < 0
      || !Number.isSafeInteger(source.windowId) || source.windowId < 0
      || !bounded(source.tabEpoch, 128) || !bounded(source.documentId, 128)
      || !bounded(source.destination, 256) || !/^(new-chat|conversation:[A-Za-z0-9_-]+)$/.test(source.destination)) invalid();
}

export function validateRequest(request) {
  keys(request, ['profile', 'path', 'messageId', 'conversationId']);
  if (request.profile !== 'chatgpt-new-user-text/2'
      || !['/backend-api/conversation', '/backend-api/f/conversation'].includes(request.path)
      || !id(request.messageId) || request.conversationId !== null && !id(request.conversationId)) invalid();
}

export function validateAcknowledgement(acknowledgement) {
  keys(acknowledgement, ['profile', 'kind', 'conversationId', 'correlationId']);
  if (acknowledgement.profile !== 'chatgpt-early-ack/1' || !['stream-handoff', 'inline-message'].includes(acknowledgement.kind)
      || !id(acknowledgement.conversationId) || !id(acknowledgement.correlationId)) invalid();
}

export function validateStrictObservation(value) {
  const base = ['profile', 'kind', 'eventId', 'source'];
  if (value?.profile !== STRICT_OBSERVATION_PROFILE || !isUUID(value.eventId)) invalid();
  validateCaptureSource(value.source);
  if (value.kind === 'normal-request-observed') {
    keys(value, [...base, 'inputMethod', 'request', 'textRecord', 'textObject', 'mode', 'boundary', 'coverage',
      'releaseClass', 'attachments', 'providerReceipt']);
    validateRequest(value.request);
    if (value.request.conversationId !== (value.source.destination === 'new-chat' ? null : value.source.destination.slice(13))) invalid();
    if (value.inputMethod !== 'provider-request' || !bounded(value.textRecord, 128)
        || !bounded(value.textObject, 128) || value.mode !== 'ON' || value.boundary !== 'provider_fetch'
        || value.coverage !== 'UTF8_NEW_USER_MESSAGE' || value.releaseClass !== 'RETROSPECTIVE_OBSERVATION'
        || value.attachments !== 'UNSUPPORTED' || value.providerReceipt !== 'UNKNOWN') invalid();
    unb64(value.textObject, 32);
  } else if (value.kind === 'normal-acknowledgement') {
    keys(value, [...base, 'recordDigest', 'acknowledgement', 'correlation', 'providerReceipt']);
    validateAcknowledgement(value.acknowledgement);
    if (!bounded(value.recordDigest, 128) || value.correlation !== 'SAME_FETCH_CALL' || value.providerReceipt !== 'UNKNOWN') invalid();
    unb64(value.recordDigest, 32);
  } else invalid();
  return value;
}
