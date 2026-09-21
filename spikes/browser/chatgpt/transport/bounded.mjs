export const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
export const MAX_PROMPT_BYTES = 256 * 1024;
export const REQUEST_TIMEOUT_MS = 750;
export const ACK_BYTES = 64 * 1024;
export const ACK_TIMEOUT_MS = 2000;
export const POLICY_MS = 3000;

// Duplicate JSON keys and deeply nested extensions have no unambiguous profile.
export function parseWireJSON(text) {
  const stack = []; let start = -1, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (start >= 0) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') {
        const frame = stack.at(-1);
        if (frame?.key) {
          const key = JSON.parse(text.slice(start, i + 1));
          if (frame.names.has(key)) throw Error('UNSUPPORTED_JSON');
          frame.names.add(key); frame.key = false;
        }
        start = -1;
      }
    } else if (c === '"') start = i;
    else if (c === '{' || c === '[') {
      if (stack.length >= 24) throw Error('UNSUPPORTED_JSON');
      stack.push(c === '{' ? { key: true, names: new Set() } : {});
    } else if (c === '}' || c === ']') stack.pop();
    else if (c === ',' && stack.at(-1)?.names) stack.at(-1).key = true;
  }
  return JSON.parse(text);
}

// Cancel only our clone branch. Awaiting tee cancellation can wait for the
// provider's branch to finish, so cancellation itself is deliberately detached.
export function cancelReader(reader) {
  try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {}
  try { reader.releaseLock(); } catch {}
}

export async function readPrefix(stream, { maximum, timeout, consume, signal }) {
  if (!stream || signal?.aborted) return;
  const reader = stream.getReader();
  let timer, abort, used = 0;
  const ended = new Promise(resolve => {
    timer = setTimeout(() => resolve({ stopped: true }), timeout);
    abort = () => resolve({ stopped: true });
    signal?.addEventListener('abort', abort, { once: true });
  });
  try {
    while (used < maximum) {
      const result = await Promise.race([reader.read(), ended]);
      if (result.stopped) return;
      if (result.done) return consume(new Uint8Array(), true);
      const bytes = result.value;
      // The browser chooses chunk size. Never decode/copy beyond the budget.
      const prefix = bytes.subarray(0, maximum - used);
      used += prefix.byteLength;
      const value = consume(prefix, false);
      if (value !== undefined) return value;
      if (bytes.byteLength > prefix.byteLength) return;
    }
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort); cancelReader(reader);
  }
}

export async function readRequest(stream, signal) {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let text = '';
  const result = await readPrefix(stream, { maximum: MAX_REQUEST_BYTES + 1, timeout: REQUEST_TIMEOUT_MS, signal,
    consume(bytes, done) {
      if (bytes.length) text += decoder.decode(bytes, { stream: true });
      if (done) return text + decoder.decode();
    } });
  if (typeof result !== 'string' || new TextEncoder().encode(result).length > MAX_REQUEST_BYTES) throw Error('REQUEST_LIMIT');
  return result;
}
