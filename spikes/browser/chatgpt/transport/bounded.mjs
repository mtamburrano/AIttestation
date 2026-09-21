export const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
export const MAX_PROMPT_BYTES = 256 * 1024;
export const REQUEST_TIMEOUT_MS = 750;
export const ACK_BYTES = 64 * 1024;
export const ACK_TIMEOUT_MS = 2000;

// Request callers restrict ambiguity checks to fields used as evidence. Unknown
// extensions may nest or repeat keys without changing the selected prompt.
export function parseWireJSON(text, relevantKey = null) {
  const value = JSON.parse(text);
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
          if (!relevantKey || frame.path && relevantKey(frame.path, key)) {
            if (frame.names.has(key)) throw Error('UNSUPPORTED_JSON');
            frame.names.add(key);
          }
          frame.property = key; frame.key = false;
        }
        start = -1;
      }
    } else if (c === '"') start = i;
    else if (c === '{' || c === '[') {
      if (!relevantKey && stack.length >= 24) throw Error('UNSUPPORTED_JSON');
      const parent = stack.at(-1);
      const path = !parent ? [] : parent.path && parent.path.length < 6
        ? [...parent.path, parent.names ? parent.property : parent.index] : null;
      stack.push(c === '{' ? { key: true, names: new Set(), path } : { index: 0, path });
    } else if (c === '}' || c === ']') stack.pop();
    else if (c === ',') {
      const frame = stack.at(-1);
      if (frame?.names) frame.key = true;
      else if (frame) frame.index++;
    }
  }
  return value;
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
