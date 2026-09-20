import { keys } from '../../vault/format.mjs';
import { validateText } from '../../vault/text.mjs';
import { CHATGPT_CAPTURE_PROFILE, isUUID, validateCaptureSource, validateRequest, validateAcknowledgement } from '../../recipient/normal-observation.mjs';
export { CHATGPT_CAPTURE_PROFILE };

export const CHATGPT_CAPTURE_DIAGNOSTIC_PROFILE = 'pap-chatgpt-capture-diagnostic/1';
// Fixed rejection vocabulary for the three layers that can drop an observation:
// the page's own Send eligibility, the worker's sender/policy checks, and the
// engine's ordered capture decision. Codes carry no DOM, prompt or URL data.
export const CAPTURE_REJECTION_CODES = Object.freeze(['PAGE_SEND_REJECTED', 'CAPTURE_REJECTED']);

export function validateCapture(input) {
  const kind = input?.kind;
  if (!['request-observed', 'acknowledgement'].includes(kind)) throw Error('INVALID_CAPTURE_OBSERVATION');
  keys(input, ['profile', 'kind', 'token', 'eventId', 'source',
    ...(kind === 'request-observed' ? ['text', 'inputMethod', 'request'] : ['acknowledgement'])]);
  if (input.profile !== CHATGPT_CAPTURE_PROFILE || !isUUID(input.token) || !isUUID(input.eventId)) throw Error('INVALID_CAPTURE_OBSERVATION');
  validateCaptureSource(input.source);
  if (kind === 'request-observed') {
    validateText(input.text); validateRequest(input.request);
    if (!input.text.length || !['send-button', 'enter'].includes(input.inputMethod)) throw Error('INVALID_CAPTURE_OBSERVATION');
    const conversation = input.source.destination === 'new-chat' ? null : input.source.destination.slice(13);
    if (input.request.conversationId !== conversation) throw Error('INVALID_CAPTURE_OBSERVATION');
  } else validateAcknowledgement(input.acknowledgement);
  return structuredClone(input);
}
