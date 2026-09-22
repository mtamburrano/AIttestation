import { keys, unb64 } from '../vault/format.mjs';
import { isChatGPTDestination } from './chatgpt-route.mjs';

export const CHATGPT_CAPTURE_PROFILE = 'pap-chatgpt-capture/5';
export const NORMAL_OBSERVATION_PROFILE = 'pap-chatgpt-observation/6';
export const isUUID = value => typeof value === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const bounded = (value, maximum) => typeof value === 'string' && value.length > 0 && value.length <= maximum;
const id = value => bounded(value, 128) && /^[A-Za-z0-9_-]+$/.test(value);
const invalid = () => { throw Error('INVALID_CAPTURE_OBSERVATION'); };

export function validateCaptureSource(source) {
  keys(source, ['adapterProfile', 'pageContract', 'runtimeEpoch', 'browserSessionId', 'scope',
    'tabId', 'windowId', 'tabEpoch', 'documentId', 'destination']);
  if (source.adapterProfile !== 'pap-chatgpt-chrome/9' || source.pageContract !== 'chatgpt-web-text/2026-09-21.1'
      || !isUUID(source.scope) || !bounded(source.runtimeEpoch, 128) || !bounded(source.browserSessionId, 128)
      || !Number.isSafeInteger(source.tabId) || source.tabId < 0
      || !Number.isSafeInteger(source.windowId) || source.windowId < 0
      || !bounded(source.tabEpoch, 128) || !bounded(source.documentId, 128)
      || !isChatGPTDestination(source.destination)) invalid();
}

export function validateRequest(request) {
  keys(request, ['profile', 'path', 'messageId', 'conversationId']);
  if (request.profile !== 'chatgpt-new-user-text/3'
      || !['/backend-api/conversation', '/backend-api/f/conversation', '/backend-api/f/steer_turn'].includes(request.path)
      || !id(request.messageId) || request.conversationId !== null && !id(request.conversationId)) invalid();
}

export function validateAcknowledgement(acknowledgement) {
  keys(acknowledgement, ['profile', 'kind', 'conversationId', 'correlationId']);
  if (acknowledgement.profile !== 'chatgpt-early-ack/1' || !['stream-handoff', 'inline-message'].includes(acknowledgement.kind)
      || !id(acknowledgement.conversationId) || !id(acknowledgement.correlationId)) invalid();
}

export function validateNormalObservation(value) {
  const base = ['profile', 'kind', 'eventId', 'source'];
  if (value?.profile !== NORMAL_OBSERVATION_PROFILE || !isUUID(value.eventId)) invalid();
  validateCaptureSource(value.source);
  if (value.kind === 'normal-request-observed') {
    keys(value, [...base, 'inputMethod', 'request', 'textRecord', 'textObject', 'mode', 'boundary', 'coverage',
      'releaseClass', 'attachments', 'providerReceipt']);
    validateRequest(value.request);
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
