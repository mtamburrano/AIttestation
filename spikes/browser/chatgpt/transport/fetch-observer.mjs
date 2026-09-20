import { MAX_REQUEST_BYTES, ACK_BYTES, ACK_TIMEOUT_MS, INTENT_MS, readRequest, readPrefix, cancelReader } from './bounded.mjs';
import { matchChatGPT, extractChatGPT, chatGPTAcknowledgement } from './chatgpt.mjs';

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

export function snapshotRequest(args, baseURL, signal) {
  const [input, init] = args;
  const request = input instanceof Request ? input : null;
  if (!request && typeof input !== 'string' && !(input instanceof URL)) return null;
  const url = new URL(request ? request.url : input, baseURL);
  const method = option(init, 'method') ?? request?.method ?? 'GET';
  if (typeof method !== 'string' || !matchChatGPT(url, method.toUpperCase())) return null;
  if ((option(init, 'credentials') ?? request?.credentials) === 'omit') return null;
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

export function installFetchObserver(target, { emit, now = () => performance.now(), baseURL = () => target.location.href } = {}) {
  const original = target.fetch;
  const active = new Set(), observedIds = new Set(); let intent = null, stopped = false;
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
      // the chain without reaching the original fetch or spending a qualifier.
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
      candidate = !stopped && intent && intent.expires > now() && !intent.used ? intent : null;
      if (candidate && active.size < 8) {
        controller = new AbortController(); active.add(controller);
        deadline = setTimeout(() => { controller.abort(); active.delete(controller); }, 4000);
        snapshot = snapshotRequest(args, baseURL(), controller.signal);
      } else if (candidate) notify({ kind: 'gap', id: candidate.id });
    } catch { if (candidate) notify({ kind: 'gap', id: candidate.id }); }
    let result;
    try { result = Reflect.apply(original, this, args); }
    catch (error) { clearTimeout(deadline); controller?.abort(); active.delete(controller); throw error; }
    if (!snapshot) { clearTimeout(deadline); controller?.abort(); active.delete(controller); return result; }
    const path = snapshot.path, bodyReady = Promise.resolve(snapshot.body);
    bodyReady.catch(() => {});
    // Preserve invocation order even when a Request clone takes longer than a
    // later string body. An excluded request never spends the qualifier.
    const extraction = (candidate.queue ?? Promise.resolve()).then(() => bodyReady).then(body => {
      if (stopped || controller.signal.aborted || candidate.used || candidate.expires <= now()) return null;
      const value = extractChatGPT(body, path);
      if (!value || candidate.conversationId !== undefined && candidate.conversationId !== value.request.conversationId) return null;
      // A provider retry of an earlier message must not spend a later human
      // Send's qualifier. Bound identity retention without reading history.
      if (observedIds.has(value.request.messageId)) return null;
      if (observedIds.size >= 1024) { notify({ kind: 'gap', id: candidate.id }); return null; }
      observedIds.add(value.request.messageId);
      candidate.used = true;
      notify({ kind: 'request', id: candidate.id, ...value });
      return value.request;
    }).catch(() => { if (!stopped) notify({ kind: 'gap', id: candidate.id }); return null; });
    candidate.queue = extraction;
    snapshot = null;
    // Observation is a detached branch; the page receives exactly fetch's
    // promise and original Response, including its original rejection/abort.
    const acknowledgementWork = Promise.resolve(result).then(response => {
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
    return result;
  }
  target.fetch = fetchObserved;
  return {
    state,
    available: () => ['ready', 'wrapped'].includes(state()),
    qualify(id, conversationId) { if (!stopped) intent = { id, conversationId, expires: now() + INTENT_MS, used: false }; },
    clear() { intent = null; for (const controller of active) controller.abort(); active.clear(); },
    stop() { stopped = true; this.clear(); if (target.fetch === fetchObserved) target.fetch = original; },
  };
}
