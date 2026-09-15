import { keys } from '../../vault/format.mjs';
import { validateText } from '../../vault/text.mjs';
import { CHATGPT_CAPTURE_PROFILE, isUUID, validateCaptureSource } from '../../recipient/normal-observation.mjs';
export { CHATGPT_CAPTURE_PROFILE };

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
