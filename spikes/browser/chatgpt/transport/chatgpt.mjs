import { MAX_REQUEST_BYTES, MAX_PROMPT_BYTES, parseWireJSON } from './bounded.mjs';

export const EXTRACTION_PROFILE = 'chatgpt-new-user-text/2';
export const ACK_PROFILE = 'chatgpt-early-ack/1';
export const wireId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export const requestPath = value => ['/backend-api/conversation', '/backend-api/f/conversation'].includes(value);

export function matchChatGPT(url, method) {
  return url.origin === 'https://chatgpt.com' && !url.username && !url.password
    && !url.search && !url.hash && method === 'POST' && requestPath(url.pathname);
}

function excluded(value, depth = 0) {
  if (!value || typeof value !== 'object') return false;
  if (depth > 20) return true;
  for (const [key, item] of Object.entries(value)) {
    if (/(?:attachment|file_ids|audio|voice|image|edit|resubmit|regenerat|anonymous)/i.test(key)
        && item !== false && item !== null && item !== '' && !(Array.isArray(item) && !item.length)) return true;
    if (typeof item === 'object' && excluded(item, depth + 1)) return true;
  }
  return false;
}

export function extractChatGPT(text, path) {
  if (typeof text !== 'string' || text.length > MAX_REQUEST_BYTES || !text.isWellFormed()
      || new TextEncoder().encode(text).length > MAX_REQUEST_BYTES) throw Error('REQUEST_LIMIT');
  const body = parseWireJSON(text);
  if (!requestPath(path) || !body || body.action !== 'next' || !Array.isArray(body.messages)
      || body.messages.length < 1 || body.messages.length > 128
      || !wireId(body.parent_message_id) || body.conversation_id != null && !wireId(body.conversation_id)
      || excluded(body)) return null;
  const message = body.messages.at(-1), content = message?.content;
  // History is accepted only when the parent explicitly identifies the message
  // immediately before the new user turn. Never guess the last user in an
  // arbitrary batch, or concatenate history/multimodal parts into evidence.
  const ids = new Set();
  for (const entry of body.messages) {
    if (!wireId(entry?.id) || ids.has(entry.id) || !['user', 'assistant'].includes(entry.author?.role)) return null;
    ids.add(entry.id);
  }
  if (message.id === body.parent_message_id || body.messages.length > 1
      && (body.messages.at(-2).id !== body.parent_message_id || body.messages.at(-2).author.role !== 'assistant')) return null;
  if (!wireId(message?.id) || message.author?.role !== 'user' || content?.content_type !== 'text'
      || !Array.isArray(content.parts) || content.parts.length !== 1 || typeof content.parts[0] !== 'string'
      || message.recipient != null && message.recipient !== 'all'
      || message.channel != null || body.conversation_mode?.kind && body.conversation_mode.kind !== 'primary_assistant') return null;
  const prompt = content.parts[0];
  if (!prompt.length || !prompt.isWellFormed() || new TextEncoder().encode(prompt).length > MAX_PROMPT_BYTES) throw Error('PROMPT_LIMIT');
  return { text: prompt, request: { profile: EXTRACTION_PROFILE, path, messageId: message.id,
    conversationId: body.conversation_id ?? null } };
}

// Correlation is the particular fetch call, with any supplied conversation and
// user-message IDs checked as well. No headers, tokens, history or answer text
// escape this parser. These shapes are source-backed fixtures, not live coverage.
export function chatGPTAcknowledgement(frame, request) {
  const value = parseWireJSON(frame);
  if (value?.type === 'error' || value?.error) return false;
  const data = value?.v?.message ? value.v : value;
  const conversationId = data?.conversation_id;
  if (!wireId(conversationId) || request.conversationId !== null && request.conversationId !== conversationId) return null;
  if (value.type === 'stream_handoff') {
    let id = value.turn_exchange_id;
    if (!id && Array.isArray(value.options) && value.options.length === 1) {
      const topic = value.options[0]?.topic_id;
      if (typeof topic === 'string' && topic.startsWith('conversation-turn-')) id = topic.slice(18);
    }
    return wireId(id) ? { profile: ACK_PROFILE, kind: 'stream-handoff', conversationId, correlationId: id } : null;
  }
  const message = data?.message;
  if (!wireId(message?.id) || message.content?.content_type !== 'text') return null;
  const userEcho = message.author?.role === 'user' && message.id === request.messageId;
  const start = message.author?.role === 'assistant' && message.status === 'in_progress'
    && message.content.parts?.length === 1 && message.content.parts[0] === '';
  if (!userEcho && !start) return null;
  return { profile: ACK_PROFILE, kind: 'inline-message', conversationId, correlationId: message.id };
}
