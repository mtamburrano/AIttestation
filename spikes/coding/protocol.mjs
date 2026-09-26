import { parseUniqueJSON } from '../distribution/unique-json.mjs';
import { decodeCodex } from './codex.mjs';
import { decodeClaudeCode } from './claude-code.mjs';

export const HOOK_IPC_PROFILE = 'pap-hook-admission/1';
export const HOOK_INPUT_LIMIT = 1024 * 1024;
export const HOOK_DEADLINE_MS = 250;
export const HOOK_RECEIVER_MS = 180;

export function decodeHook(client, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > HOOK_INPUT_LIMIT) throw Error('HOOK_INPUT_LIMIT');
  const text = new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const input = parseUniqueJSON(text);
  if (client === 'codex') return decodeCodex(input);
  if (client === 'claude-code') return decodeClaudeCode(input);
  throw Error('UNSUPPORTED_HOOK_CLIENT');
}
