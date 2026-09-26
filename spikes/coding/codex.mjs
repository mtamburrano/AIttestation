import { clientIdentifier, validateHookText } from '../recipient/hook-observation.mjs';

export function decodeCodex(input) {
  if (!input || input.hook_event_name !== 'UserPromptSubmit' || !clientIdentifier(input.session_id)
      || !clientIdentifier(input.turn_id) || input.agent_id != null || input.parent_session_id != null
      || input.subagent_id != null) throw Error('UNSUPPORTED_HOOK_EVENT');
  return { text: validateHookText(input.prompt), sessionId: input.session_id, turnId: input.turn_id, promptId: null };
}
