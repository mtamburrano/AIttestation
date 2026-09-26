import { HOOK_CAPTURE_PROFILE, HOOK_SOURCE_PROFILE, validateHookSource, validateHookText } from '../recipient/hook-observation.mjs';
import { keys } from '../vault/format.mjs';

export class CodingAdmission {
  constructor({ integrationId, installationId, runtimeEpoch, origin }) {
    if (!['codex', 'claude-code'].includes(integrationId)) throw Error('UNSUPPORTED_HOOK_CLIENT');
    Object.assign(this, { integrationId, installationId, runtimeEpoch, origin });
  }
  get synchronousAdmission() { return true; }
  onChange() { return () => {}; }
  scopes() { return []; }
  policies() { return []; }
  states() { return []; }
  revoke() {}
  prepare(input) {
    keys(input, ['text', 'sessionId', 'promptId', 'turnId', 'invocationId', 'scope']);
    const source = { profile: HOOK_SOURCE_PROFILE, integrationId: this.integrationId, installationId: this.installationId,
      runtimeEpoch: this.runtimeEpoch, origin: this.origin, sessionId: input.sessionId,
      promptId: input.promptId, turnId: input.turnId, invocationId: input.invocationId, scope: input.scope };
    validateHookSource(source); validateHookText(input.text);
    return { observation: { profile: HOOK_CAPTURE_PROFILE, kind: 'hook-prompt-observed', source,
      text: input.text, inputMethod: 'user-prompt-submit-hook' } };
  }
  accept({ observation }) { validateHookSource(observation.source); }
  save(observation, session) { return session.observe(observation); }
}
