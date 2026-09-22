// Preserve the existing signed destination bound (256 including its prefix).
// WEB is the observed route namespace; provider wire IDs remain independent.
const chatGPTRouteIdentifierPattern = /^(?:[A-Za-z0-9_-]{1,243}|WEB:[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12})$/;
export const isChatGPTRouteIdentifier = value => typeof value === 'string' && value.length <= 243
  && chatGPTRouteIdentifierPattern.exec(value)?.[0] === value;

export function chatGPTDestinationForURL(value) {
  if (value === 'https://chatgpt.com/') return 'new-chat';
  const prefix = 'https://chatgpt.com/c/';
  if (typeof value !== 'string' || !value.startsWith(prefix)) return null;
  const identifier = value.slice(prefix.length, value.endsWith('/') ? -1 : undefined);
  return isChatGPTRouteIdentifier(identifier) ? `conversation:${identifier}` : null;
}

export const isChatGPTConversationURL = value => chatGPTDestinationForURL(value)?.startsWith('conversation:') === true;
export const isChatGPTDestination = value => value === 'new-chat' || typeof value === 'string'
  && value.startsWith('conversation:') && isChatGPTRouteIdentifier(value.slice(13));
