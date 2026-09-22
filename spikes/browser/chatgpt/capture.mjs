import { keys } from '../../vault/format.mjs';
import { validateText } from '../../vault/text.mjs';
import { CHATGPT_CAPTURE_PROFILE, isUUID, validateCaptureSource, validateRequest, validateAcknowledgement } from '../../recipient/normal-observation.mjs';
export { CHATGPT_CAPTURE_PROFILE };
export const CHATGPT_CAPTURE_RECEIPT_PROFILE = 'pap-chatgpt-capture-receipt/1';

export const CHATGPT_CAPTURE_DIAGNOSTIC_PROFILE = 'pap-chatgpt-capture-diagnostic/4';
// Fixed stage sightings carry no DOM, prompt or URL data.
export const CAPTURE_REJECTION_CODES = Object.freeze(['PAGE_SEND_REJECTED', 'CAPTURE_REJECTED']);
export const TRANSPORT_DIAGNOSTIC_CODES = Object.freeze(['TRANSPORT_OBSERVER_READY', 'TRANSPORT_OBSERVER_WRAPPED',
  'TRANSPORT_OBSERVER_REPLACED', 'TRANSPORT_OBSERVER_UNAVAILABLE', 'TRANSPORT_RELAY_READY', 'TRANSPORT_RELAY_UNAVAILABLE',
  'TRANSPORT_POLICY_READY', 'TRANSPORT_POLICY_UNAVAILABLE', 'TRANSPORT_POLICY_OFF']);
export const REQUEST_DIAGNOSTIC_CODES = Object.freeze(['REQUEST_NOT_OBSERVED', 'REQUEST_MATCHED',
  'REQUEST_BODY_READ_FAILED', 'REQUEST_BODY_LIMIT', 'REQUEST_JSON_INVALID',
  'REQUEST_OPERATION_UNSUPPORTED', 'REQUEST_MEDIA_ONLY', 'REQUEST_PROMPT_MISSING', 'REQUEST_IDENTITY_MISSING',
  'REQUEST_PROMPT_INVALID', 'REQUEST_MEDIA_IGNORED', 'REQUEST_CONVERSATION_UNAVAILABLE', 'REQUEST_CONVERSATION_DIFFERENT', 'REQUEST_MESSAGE_REJECTED', 'REQUEST_MESSAGE_MISSING', 'REQUEST_DEDUPLICATED', 'DURABLE_SAVE_DISPATCHED']);
export const CAPTURE_DIAGNOSTIC_CODES = Object.freeze([...CAPTURE_REJECTION_CODES, ...TRANSPORT_DIAGNOSTIC_CODES, ...REQUEST_DIAGNOSTIC_CODES]);

export function validateCapture(input) {
  const kind = input?.kind;
  if (!['request-observed', 'acknowledgement'].includes(kind)) throw Error('INVALID_CAPTURE_OBSERVATION');
  keys(input, ['profile', 'kind', 'token', 'eventId', 'source',
    ...(kind === 'request-observed' ? ['text', 'inputMethod', 'request'] : ['acknowledgement'])]);
  if (input.profile !== CHATGPT_CAPTURE_PROFILE || !isUUID(input.token) || !isUUID(input.eventId)) throw Error('INVALID_CAPTURE_OBSERVATION');
  validateCaptureSource(input.source);
  if (kind === 'request-observed') {
    validateText(input.text); validateRequest(input.request);
    if (!input.text.length || input.inputMethod !== 'provider-request') throw Error('INVALID_CAPTURE_OBSERVATION');
  } else validateAcknowledgement(input.acknowledgement);
  return structuredClone(input);
}

export function validateCaptureReceipt(input) {
  keys(input, ['profile', 'eventId', 'source']);
  if (input.profile !== CHATGPT_CAPTURE_PROFILE || !isUUID(input.eventId)) throw Error('INVALID_CAPTURE_RECEIPT');
  validateCaptureSource(input.source);
  return structuredClone(input);
}
