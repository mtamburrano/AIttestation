import { MAX_REQUEST_BYTES, ACK_BYTES, ACK_TIMEOUT_MS, readRequest, readPrefix, cancelReader } from './bounded.mjs';
import { matchChatGPT, extractChatGPT, chatGPTAcknowledgement, REQUEST_EXTRACTION_CODES } from './chatgpt.mjs';

// Only standard data-valued init options are inspected. Accessors/custom input
// conversions belong to fetch; evaluating them twice could change a Send.
function option(init, key) {
  if (init == null) return undefined;
  const prototype = Object.getPrototypeOf(init);
  if (prototype !== null && Object.getPrototypeOf(prototype) !== null) throw Error('UNSUPPORTED_INIT');
  const property = Object.getOwnPropertyDescriptor(init, key);
  if (property && !Object.hasOwn(property, 'value')) throw Error('UNSUPPORTED_INIT');
  return property?.value;
}

export function snapshotRequest(args, baseURL, signal, matched = () => {}) {
  const [input, init] = args;
  const request = input instanceof Request ? input : null;
  if (!request && typeof input !== 'string' && !(input instanceof URL)) return null;
  const url = new URL(request ? request.url : input, baseURL);
  const method = option(init, 'method') ?? request?.method ?? 'GET';
  if (typeof method !== 'string' || !matchChatGPT(url, method.toUpperCase())) return null;
  if ((option(init, 'credentials') ?? request?.credentials) === 'omit') return null;
  matched();
  const override = option(init, 'body');
  let body;
  if (override == null && request) {
    if (request.bodyUsed || request.body?.locked) throw Error('UNSUPPORTED_BODY');
    // Clone before fetch consumes Request; never read or replace the original.
    body = readRequest(request.clone().body, signal);
  } else if (typeof override === 'string') body = override;
  else if (override instanceof ArrayBuffer || ArrayBuffer.isView(override)) {
    const bytes = override instanceof ArrayBuffer ? new Uint8Array(override) : new Uint8Array(override.buffer, override.byteOffset, override.byteLength);
    if (bytes.byteLength > MAX_REQUEST_BYTES) throw Error('REQUEST_LIMIT');
    body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } else if (override instanceof Blob) {
    if (override.size > MAX_REQUEST_BYTES) throw Error('REQUEST_LIMIT');
    body = readRequest(override.stream(), signal);
  } else throw Error('UNSUPPORTED_BODY');
  // readRequest may reject before the original fetch settles.
  if (body instanceof Promise) body.catch(() => {});
  return { body, path: url.pathname };
}

export async function observeAcknowledgement(response, request, signal, alreadyCloned = false) {
  if (!response?.ok || response.bodyUsed || !/^text\/event-stream(?:;|$)/i.test(response.headers.get('content-type') ?? '')) return null;
  const clone = alreadyCloned ? response : response.clone();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  return readPrefix(clone.body, { maximum: ACK_BYTES, timeout: ACK_TIMEOUT_MS, signal,
    consume(bytes) {
      buffer += decoder.decode(bytes, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).replace(/^ /, '');
        if (data === '[DONE]') return null;
        if (!data) continue;
        let ack;
        try { ack = chatGPTAcknowledgement(data, request); } catch { return null; }
        if (ack === false) return null;
        if (ack) return ack;
      }
    } });
}

export function installFetchObserver(target, { emit, baseURL = () => target.location.href } = {}) {
  const original = target.fetch;
  const active = new Set(); let policy = null, sequence = 0, stopped = false;
  const probeController = new AbortController(); probeController.abort();
  const probe = new Request('data:,', { signal: probeController.signal });
  const healthByFetch = new WeakMap();
  let probing = false, reached = false;
  const notify = value => { try { emit(value); } catch {} };
  function state() {
    if (stopped) return 'unavailable';
    try {
      const current = target.fetch;
      if (current === fetchObserved) return 'ready';
      if (typeof current !== 'function') return 'replaced';
      const checkedState = healthByFetch.get(current);
      if (checkedState) return checkedState;
      if (probing) return 'replaced';
      // The page can install a forwarding wrapper after document_start. Test
      // the chain without reaching the original fetch or observing a request.
      // A bypass sees only an already-aborted, local data URL, never a Send.
      // Cache each identity for this document: invoking a known page wrapper
      // again can repeat its own side effects, even if native fetch is avoided.
      healthByFetch.set(current, 'replaced');
      reached = false; probing = true;
      try { Promise.resolve(Reflect.apply(current, target, [probe])).catch(() => {}); }
      catch {} finally { probing = false; }
      const health = reached && !stopped && target.fetch === current ? 'wrapped' : 'replaced';
      healthByFetch.set(current, health);
      return health;
    } catch { return 'replaced'; }
  }
  function fetchObserved(...args) {
    if (args[0] === probe) {
      if (probing) reached = true;
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    let candidate, snapshot, controller, deadline;
    try {
      // Scheduling a heartbeat late must not lose an otherwise valid request.
      // Snapshot under the original binding; the engine still checks live consent.
      const binding = !stopped && policy && policy.url === baseURL() ? policy : null;
      if (binding) {
        controller = new AbortController(); active.add(controller);
        deadline = setTimeout(() => { controller.abort(); active.delete(controller); }, 4000);
        snapshot = snapshotRequest(args, baseURL(), controller.signal, () => {
          candidate = { id: crypto.randomUUID(), binding: binding.id, sequence: ++sequence, conversationId: binding.conversationId };
          notify({ kind: 'matched', id: candidate.id, binding: candidate.binding, sequence: candidate.sequence });
          if (active.size > 8) throw Error('OBSERVATION_LIMIT');
        });
      }
    } catch { if (candidate) notify({ kind: 'gap', id: candidate.id, code: 'REQUEST_BODY_READ_FAILED' }); }
    let result, failure, threw = false;
    try { result = Reflect.apply(original, this, args); }
    catch (error) { threw = true; failure = error; }
    if (!snapshot) {
      clearTimeout(deadline); controller?.abort(); active.delete(controller);
      if (threw) throw failure;
      return result;
    }
    const path = snapshot.path, bodyReady = Promise.resolve(snapshot.body);
    bodyReady.catch(() => {});
    const extraction = bodyReady.then(body => {
      if (stopped || controller.signal.aborted) return null;
      let value;
      try {
        value = extractChatGPT(body, path, code => notify({ kind: 'notice', id: candidate.id, code }));
      } catch (error) {
        notify({ kind: 'gap', id: candidate.id, code: REQUEST_EXTRACTION_CODES.includes(error?.message)
          ? error.message : 'REQUEST_PROMPT_INVALID' });
        return null;
      }
      // The authenticated route owns capture authority. Provider conversation
      // metadata is independently preserved, including absence or disagreement.
      if (candidate.conversationId !== null && value.request.conversationId !== null
          && candidate.conversationId !== value.request.conversationId) {
        notify({ kind: 'notice', id: candidate.id, code: 'REQUEST_CONVERSATION_DIFFERENT' });
      }
      // Only the durable engine deduplicates provider message identity. Dropping
      // retries here could discard the sole retry after a failed local delivery.
      notify({ kind: 'request', id: candidate.id, ...value });
      return value.request;
    }, () => { if (!stopped && !controller.signal.aborted) notify({ kind: 'gap', id: candidate.id, code: 'REQUEST_BODY_READ_FAILED' }); return null; });
    snapshot = null;
    // Observation is a detached branch; the page receives exactly fetch's
    // promise and original Response, including its original rejection/abort.
    const acknowledgementWork = Promise.resolve(threw ? null : result).then(response => {
      if (stopped || controller.signal.aborted || !response?.ok || response.bodyUsed
          || !/^text\/event-stream(?:;|$)/i.test(response.headers.get('content-type') ?? '')) return;
      // This handler is registered before returning fetch's promise. Clone
      // synchronously here: the provider's next handler may consume its body.
      // Read the clone only after request extraction has actually qualified it.
      const clone = response.clone();
      return extraction.then(async request => {
        if (!request || stopped || controller.signal.aborted) return;
        const acknowledgement = await observeAcknowledgement(clone, request, controller.signal, true);
        if (acknowledgement && !stopped && !controller.signal.aborted) notify({ kind: 'ack', id: candidate.id, acknowledgement });
      }).finally(() => { if (clone.body && !clone.bodyUsed) cancelReader(clone.body.getReader()); });
    }).catch(() => {});
    Promise.allSettled([extraction, acknowledgementWork]).then(() => {
      clearTimeout(deadline); controller.abort(); active.delete(controller);
    });
    if (threw) throw failure;
    return result;
  }
  target.fetch = fetchObserved;
  return {
    state,
    available: () => ['ready', 'wrapped'].includes(state()),
    arm(id, conversationId) { if (!stopped) policy = { id, conversationId, url: baseURL() }; },
    clear() { policy = null; for (const controller of active) controller.abort(); active.clear(); },
    stop() { stopped = true; this.clear(); if (target.fetch === fetchObserved) target.fetch = original; },
  };
}
