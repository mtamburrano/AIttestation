import { keys, unb64, LIMITS } from '../vault/format.mjs';
import { isUUID } from './normal-observation.mjs';

export const HOOK_CAPTURE_PROFILE = 'pap-coding-hook-capture/1';
export const HOOK_OBSERVATION_PROFILE = 'pap-coding-hook-observation/1';
export const HOOK_SOURCE_PROFILE = 'pap-local-coding-source/1';
const invalid = () => { throw Error('INVALID_HOOK_OBSERVATION'); };
export const clientIdentifier = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);

export function validateHookText(text) {
  if (typeof text !== 'string' || !text.length || !text.isWellFormed() || Buffer.byteLength(text, 'utf8') > LIMITS.field) invalid();
  return text;
}

export function validateHookSource(source) {
  keys(source, ['profile', 'integrationId', 'installationId', 'runtimeEpoch', 'scope', 'sessionId',
    'invocationId', 'promptId', 'turnId', 'origin']);
  if (source.profile !== HOOK_SOURCE_PROFILE || !['codex', 'claude-code'].includes(source.integrationId)
      || !isUUID(source.installationId) || !isUUID(source.runtimeEpoch) || !isUUID(source.scope)
      || !clientIdentifier(source.sessionId) || !isUUID(source.invocationId)
      || !['vendor-signed-process', 'enrolled-local-executable'].includes(source.origin)) invalid();
  if (source.integrationId === 'claude-code') {
    if (!isUUID(source.promptId) || source.turnId !== null) invalid();
  } else if (source.promptId !== null || !clientIdentifier(source.turnId)) invalid();
  return source;
}

export function validateHookObservation(value) {
  keys(value, ['profile', 'kind', 'eventId', 'source', 'inputMethod', 'textRecord', 'textObject',
    'mode', 'boundary', 'coverage', 'releaseClass', 'attachments', 'providerReceipt']);
  if (value.profile !== HOOK_OBSERVATION_PROFILE || value.kind !== 'hook-prompt-observed' || !isUUID(value.eventId)
      || value.inputMethod !== 'user-prompt-submit-hook' || typeof value.textRecord !== 'string'
      || !value.textRecord.length || value.textRecord.length > 128 || value.mode !== 'ON'
      || value.boundary !== 'synchronous_user_prompt_submit' || value.coverage !== 'EXACT_HOOK_PROMPT_UTF8'
      || value.releaseClass !== 'RETROSPECTIVE_OBSERVATION' || value.attachments !== 'UNSUPPORTED'
      || value.providerReceipt !== 'UNKNOWN') invalid();
  validateHookSource(value.source); unb64(value.textObject, 32);
  return value;
}

export function hookMessageKey(source) {
  validateHookSource(source);
  return JSON.stringify(['coding-hook', source.integrationId, source.installationId, source.sessionId,
    source.integrationId === 'claude-code' ? source.promptId : source.invocationId]);
}
