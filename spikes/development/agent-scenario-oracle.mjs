// This deliberately does not use the capture adapter's extractor: the oracle
// must catch a capture/parser regression instead of reproducing it.
const endpoints = ['/backend-api/conversation', '/backend-api/f/conversation', '/backend-api/f/steer_turn'];
const identity = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export const SCENARIOS = ['fresh-chat', 'existing-send', 'steering'];

export function scenarioPrompts(runId) {
  if (!/^[a-f0-9-]{36}$/.test(runId)) throw Error('AGENT_SCENARIO_INVALID');
  return [
    `ATTESTAMP_SYNTHETIC_${runId}_fresh-chat. Reply only with OK.`,
    `ATTESTAMP_SYNTHETIC_${runId}_existing-send. I need to perform a test. Can you think about 10 seconds before answering me? Use that thinking time to find all five-digit integers ABCDE with distinct nonzero digits where ABCDE is divisible by 17, EDCBA by 19, and A+B+C+D+E=25. Check the complete set silently. Do not use tools or browse. Reply only with the number of solutions.`,
    `ATTESTAMP_SYNTHETIC_${runId}_steering. Can you see this steering? Reply only with DONE.`,
  ];
}

export function providerEndpoint(url, method) {
  try {
    const value = new URL(url);
    return value.origin === 'https://chatgpt.com' && !value.username && !value.password
      && !value.search && !value.hash && method === 'POST' && endpoints.includes(value.pathname) ? value.pathname : null;
  } catch { return null; }
}

export function inspectScenarioRequest(body, endpoint, expectedText) {
  if (!endpoints.includes(endpoint) || typeof body !== 'string' || Buffer.byteLength(body) > 512 * 1024) {
    throw Error('AGENT_SCENARIO_REQUEST_INVALID');
  }
  let value;
  try { value = JSON.parse(body); } catch { throw Error('AGENT_SCENARIO_REQUEST_INVALID'); }
  const message = Array.isArray(value?.messages) && value.messages.findLast(entry => entry?.author?.role === 'user');
  if (value.action !== 'next' || !identity(message?.id) || message.content?.content_type !== 'text'
      || !Array.isArray(message.content.parts) || !message.content.parts.every(part => typeof part === 'string')
      || message.content.parts.join('') !== expectedText || value.messages.filter(entry => entry?.id === message.id).length !== 1
      || ['is_edit', 'is_regenerate', 'is_resubmit'].some(key => value[key] === true || message[key] === true)
      || value.conversation_id != null && !identity(value.conversation_id)) throw Error('AGENT_SCENARIO_REQUEST_INVALID');
  return { path: endpoint, messageId: message.id, conversationId: value.conversation_id ?? null };
}

export function assertScenarioReceipt(row, preview, text, request) {
  const texts = preview?.texts, records = preview?.report?.records;
  if (row?.localSave !== 'SAVED' || !Array.isArray(texts) || texts.length !== 1
      || texts[0].receiptId !== row.id || texts[0].truncated !== false || texts[0].derivative !== false
      || texts[0].preview !== text || !Array.isArray(records) || records.length < 2
      || records.some(record => record.structure !== 'VALID' || record.integrity !== 'VALID'
        || record.keyAttribution !== 'SIGNATURE_VALID' || record.evidence !== 'COMPLETE')) {
    throw Error('AGENT_SCENARIO_HISTORY_MISMATCH');
  }
  const observations = records.flatMap(record => record.localAssertions ?? [])
    .filter(value => value.kind === 'normal-request-observed');
  if (observations.length !== 1 || observations[0].textAssociation !== 'SIGNED_TEXT_REFERENCE'
      || observations[0].request?.path !== request.path || observations[0].request.messageId !== request.messageId
      || observations[0].request.conversationId !== request.conversationId) throw Error('AGENT_SCENARIO_HISTORY_MISMATCH');
  return true;
}
