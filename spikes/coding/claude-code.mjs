import { clientIdentifier, validateHookText } from '../recipient/hook-observation.mjs';
import { isUUID } from '../recipient/normal-observation.mjs';

export function decodeClaudeCode(input) {
  if (!input || input.hook_event_name !== 'UserPromptSubmit' || !clientIdentifier(input.session_id)
      || !isUUID(input.prompt_id) || input.agent_id != null || input.parent_session_id != null
      || input.subagent_id != null) throw Error('UNSUPPORTED_HOOK_EVENT');
  return { text: validateHookText(input.prompt), sessionId: input.session_id, promptId: input.prompt_id, turnId: null };
}
