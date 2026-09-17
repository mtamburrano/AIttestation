import { keys } from '../../vault/format.mjs';
import { validateText } from '../../vault/text.mjs';
import { CHATGPT_CAPTURE_PROFILE, isUUID, validateCaptureSource } from '../../recipient/normal-observation.mjs';
export { CHATGPT_CAPTURE_PROFILE };

export const CHATGPT_CAPTURE_DIAGNOSTIC_PROFILE = 'pap-chatgpt-capture-diagnostic/1';
// Fixed rejection vocabulary for the three layers that can drop an observation:
// the page's own Send eligibility, the worker's sender/policy checks, and the
// engine's ordered capture decision. Codes carry no DOM, prompt or URL data.
export const CAPTURE_REJECTION_CODES = Object.freeze(['PAGE_SEND_REJECTED', 'CAPTURE_REJECTED']);

export function validateCapture(input) {
  const kind = input?.kind;
  if (!['send-intent', 'message-observed'].includes(kind)) throw Error('INVALID_CAPTURE_OBSERVATION');
  keys(input, ['profile', 'kind', 'token', 'eventId', 'source', 'text',
    ...(kind === 'send-intent' ? ['inputMethod'] : ['messageId'])]);
  if (input.profile !== CHATGPT_CAPTURE_PROFILE || !isUUID(input.token) || !isUUID(input.eventId)) throw Error('INVALID_CAPTURE_OBSERVATION');
  validateCaptureSource(input.source);
  validateText(input.text);
  if (!input.text.length || kind === 'send-intent' && !['send-button', 'enter'].includes(input.inputMethod)
      || kind === 'message-observed' && (typeof input.messageId !== 'string' || input.messageId.length > 128
        || !/^[A-Za-z0-9_-]+$/.test(input.messageId))) throw Error('INVALID_CAPTURE_OBSERVATION');
  return structuredClone(input);
}
