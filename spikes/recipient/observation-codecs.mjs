import { NORMAL_OBSERVATION_PROFILE, CHATGPT_CAPTURE_PROFILE, validateNormalObservation, validateCaptureSource } from './normal-observation.mjs';
import { STRICT_OBSERVATION_PROFILE, validateStrictObservation } from './strict-observation.mjs';
import { QUALIFIED_OBSERVATION_PROFILE, validateQualifiedObservation } from './qualified-observation.mjs';
import { DOM_OBSERVATION_PROFILE, validateDOMObservation } from './dom-observation.mjs';
import { LEGACY_NORMAL_OBSERVATION_PROFILE, validateLegacyNormalObservation } from './legacy-observation.mjs';
import { FIREFOX_OBSERVATION_PROFILE, FIREFOX_CAPTURE_PROFILE, validateFirefoxObservation, validateFirefoxSource } from './firefox-observation.mjs';
import { HOOK_OBSERVATION_PROFILE, HOOK_CAPTURE_PROFILE, validateHookObservation, validateHookSource, hookMessageKey } from './hook-observation.mjs';

export const RECORDING_EVENT_PROFILE = 'pap-recording-event/1';
export const HISTORICAL_EVENT_PROFILE = 'pap-chatgpt-observation/1';
const definitions = [
  { profile: NORMAL_OBSERVATION_PROFILE, captureProfile: CHATGPT_CAPTURE_PROFILE, validate: validateNormalObservation,
    validateSource: validateCaptureSource, transport: true, writable: true, eventProfile: HISTORICAL_EVENT_PROFILE },
  { profile: STRICT_OBSERVATION_PROFILE, validate: validateStrictObservation, transport: true },
  { profile: QUALIFIED_OBSERVATION_PROFILE, validate: validateQualifiedObservation, transport: true },
  { profile: DOM_OBSERVATION_PROFILE, validate: validateDOMObservation },
  { profile: LEGACY_NORMAL_OBSERVATION_PROFILE, validate: validateLegacyNormalObservation, legacy: true },
  { profile: FIREFOX_OBSERVATION_PROFILE, captureProfile: FIREFOX_CAPTURE_PROFILE, validate: validateFirefoxObservation,
    validateSource: validateFirefoxSource, transport: true, writable: true, eventProfile: RECORDING_EVENT_PROFILE },
  { profile: HOOK_OBSERVATION_PROFILE, captureProfile: HOOK_CAPTURE_PROFILE, validate: validateHookObservation,
    validateSource: validateHookSource, hook: true, writable: true, eventProfile: RECORDING_EVENT_PROFILE },
];
const codecs = new Map(definitions.map(value => [value.profile, Object.freeze(value)]));
const captures = new Map(definitions.filter(value => value.writable).map(value => [value.captureProfile, codecs.get(value.profile)]));

export const observationCodec = profile => codecs.get(profile) ?? null;
export function captureCodec(profile) {
  const codec = captures.get(profile);
  if (!codec) throw Error('UNSUPPORTED_CAPTURE_PROFILE');
  return codec;
}
export function promptObservation(value) {
  return value?.profile === HISTORICAL_EVENT_PROFILE && value.kind === 'frozen-text-version'
    || Boolean(observationCodec(value?.profile)) && ['normal-send-intent', 'normal-request-observed', 'hook-prompt-observed'].includes(value.kind);
}
export const observationMessageKey = value => value?.profile === HOOK_OBSERVATION_PROFILE
  ? hookMessageKey(value.source) : value?.request?.messageId;
export function sourceCodec(source) {
  if (source?.profile === 'pap-local-coding-source/1') return codecs.get(HOOK_OBSERVATION_PROFILE);
  return captures.get(source?.adapterProfile === 'pap-chatgpt-firefox/1' ? FIREFOX_CAPTURE_PROFILE : CHATGPT_CAPTURE_PROFILE);
}
export function observationClaim(value) {
  if (observationCodec(value.profile)?.hook) return 'Client observed the exact UserPromptSubmit hook text. No provider receipt, authorship, full model-request, attachment or complete-history proof.';
  if (value.kind !== 'normal-request-observed') return 'Retrospective observation of normal Send intent. No pre-egress control, provider receipt, response, attachment or hidden-context coverage.';
  return value.profile === QUALIFIED_OBSERVATION_PROFILE
    ? 'Client observed a new user text in a fetch request qualified by human Send. No provider receipt, authorship, pre-egress control or complete-history proof.'
    : 'Client observed exact new user text in a validated provider request. No human-interaction, provider receipt, authorship, pre-egress control or complete-history proof.';
}
