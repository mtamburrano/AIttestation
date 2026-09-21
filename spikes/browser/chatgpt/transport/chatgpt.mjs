import { MAX_REQUEST_BYTES, MAX_PROMPT_BYTES, parseWireJSON } from './bounded.mjs';

export const EXTRACTION_PROFILE = 'chatgpt-new-user-text/3';
export const ACK_PROFILE = 'chatgpt-early-ack/1';
export const wireId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export const requestPath = value => ['/backend-api/conversation', '/backend-api/f/conversation'].includes(value);

export function matchChatGPT(url, method) {
  return url.origin === 'https://chatgpt.com' && !url.username && !url.password
    && !url.search && !url.hash && method === 'POST' && requestPath(url.pathname);
}

export const REQUEST_EXTRACTION_CODES = Object.freeze(['REQUEST_BODY_READ_FAILED', 'REQUEST_BODY_LIMIT', 'REQUEST_JSON_INVALID',
  'REQUEST_OPERATION_UNSUPPORTED', 'REQUEST_MEDIA_ONLY', 'REQUEST_PROMPT_MISSING',
  'REQUEST_IDENTITY_MISSING', 'REQUEST_PROMPT_INVALID']);
const operations = new Set(['edit', 'regenerate', 'resubmit', 'continue', 'variant']);
const operationFlags = ['is_edit', 'is_regenerate', 'is_resubmit'];
const unsupportedOperation = value => operations.has(value?.action)
  || operationFlags.some(key => value?.[key] === true);
const fail = code => { throw Error(code); };

function evidenceKey(selected, path, key) {
  if (!path.length) return ['messages', 'action', 'parent_message_id', 'conversation_id', ...operationFlags].includes(key);
  if (path[0] !== 'messages') return false;
  // Roles select the latest user; only that user's identity/content is evidence.
  if (path[1] >= selected && (path.length === 2 && key === 'author'
      || path.length === 3 && path[2] === 'author' && key === 'role')) return true;
  if (path[1] !== selected) return false;
  if (path.length === 2) return ['id', 'content', 'metadata', 'action', ...operationFlags].includes(key);
  if (path.length === 3 && path[2] === 'metadata') return ['action', ...operationFlags].includes(key);
  if (path.length === 3 && path[2] === 'content') return key === 'parts';
  return path.length === 5 && path[2] === 'content' && path[3] === 'parts' && key === 'text';
}

export function extractChatGPT(text, path, notice = () => {}) {
  if (typeof text !== 'string' || !text.isWellFormed()) fail('REQUEST_BODY_READ_FAILED');
  if (text.length > MAX_REQUEST_BYTES || new TextEncoder().encode(text).length > MAX_REQUEST_BYTES) fail('REQUEST_BODY_LIMIT');
  let body, selected;
  try {
    body = JSON.parse(text);
    selected = Array.isArray(body?.messages) ? body.messages.findLastIndex(entry => entry?.author?.role === 'user') : -1;
    parseWireJSON(text, (path, key) => evidenceKey(selected, path, key));
  } catch { fail('REQUEST_JSON_INVALID'); }
  if (!requestPath(path)) fail('REQUEST_OPERATION_UNSUPPORTED');
  if (unsupportedOperation(body)) fail('REQUEST_OPERATION_UNSUPPORTED');
  if (selected < 0) fail('REQUEST_PROMPT_MISSING');
  const message = body.messages[selected], content = message.content;
  if (unsupportedOperation(message) || unsupportedOperation(message.metadata)
      || wireId(message.id) && message.id === body.parent_message_id) fail('REQUEST_OPERATION_UNSUPPORTED');
  if (!wireId(message.id)) fail('REQUEST_IDENTITY_MISSING');
  // A repeated selected ID is ambiguous, but unrelated history needs no schema.
  if (body.messages.some((entry, index) => index !== selected && entry?.id === message.id)) fail('REQUEST_IDENTITY_MISSING');
  const parts = Array.isArray(content?.parts) ? content.parts : [];
  const strings = parts.flatMap(part => typeof part === 'string' ? [part]
    : typeof part?.text === 'string' ? [part.text] : []);
  const media = parts.some(part => typeof part !== 'string' && typeof part?.text !== 'string')
    || [message.attachments, message.metadata?.attachments, message.metadata?.file_ids].some(value => Array.isArray(value) && value.length > 0)
    || ['image', 'audio', 'video', 'file', 'multimodal_text'].includes(content?.content_type);
  const prompt = strings.join('');
  if (!prompt.length) fail(media ? 'REQUEST_MEDIA_ONLY' : 'REQUEST_PROMPT_MISSING');
  if (strings.some(part => !part.isWellFormed()) || new TextEncoder().encode(prompt).length > MAX_PROMPT_BYTES) fail('REQUEST_PROMPT_INVALID');
  if (media) notice('REQUEST_MEDIA_IGNORED');
  const conversationId = wireId(body.conversation_id) ? body.conversation_id : null;
  if (conversationId === null) notice('REQUEST_CONVERSATION_UNAVAILABLE');
  return { text: prompt, request: { profile: EXTRACTION_PROFILE, path, messageId: message.id, conversationId } };
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
