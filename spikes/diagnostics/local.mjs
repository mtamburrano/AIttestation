import { createHmac, randomBytes } from 'node:crypto';

export const DIAGNOSTIC_LIMITS = Object.freeze({ events: 512, bytes: 256 * 1024, ageMs: 30 * 60_000,
  previews: 4, previewAgeMs: 2 * 60_000 });
const components = Object.freeze({
  engine: ['ENGINE_STARTED', 'ENGINE_CLOSED', 'RECORDING_ENABLED', 'RECORDING_DISABLED', 'OPERATION_FROZEN', 'OPERATION_CANCELLED',
    'OPERATION_REJECTED', 'DISPATCH_AUTHORIZATION_CONSUMED', 'DISPATCH_STARTED',
    'SUBMISSION_OBSERVED', 'FAILED_BEFORE_EGRESS', 'OUTCOME_UNKNOWN', 'NORMAL_PROMPT_SAVED',
    'MESSAGE_APPEARANCE_RECORDED', 'CAPTURE_GAP'],
  vault: ['VAULT_CAPTURED', 'VAULT_STATE_COMMITTED', 'VAULT_WRITE_FAILED'],
  bridge: ['BRIDGE_LISTENING', 'BRIDGE_LISTEN_FAILED', 'BRIDGE_CONNECTED', 'BRIDGE_AUTHENTICATED', 'BRIDGE_REJECTED',
    'BRIDGE_DISCONNECTED', 'BRIDGE_HELLO', 'BRIDGE_STATE', 'BRIDGE_DISPATCH', 'BRIDGE_RESPONSE',
    'BRIDGE_RESPONSE_REJECTED', 'BRIDGE_CHECK_ACCEPTED', 'BRIDGE_CHECK_REJECTED', 'BRIDGE_TIMEOUT', 'BRIDGE_WRITE_FAILED', 'BRIDGE_SOCKET_ERROR',
    'BRIDGE_PEER_EOF', 'BRIDGE_AUTH_TIMEOUT', 'BRIDGE_HELLO_TIMEOUT', 'BRIDGE_PEER_REJECTED',
    'CAPTURE_REJECTED',
    'PANEL_SENDER_REJECTED', 'PANEL_URL_REJECTED', 'PANEL_MESSAGE_REJECTED', 'PANEL_CONTEXT_REJECTED',
    'PANEL_CONTEXT_UNAVAILABLE', 'PANEL_PERMISSION_REJECTED', 'PANEL_CONNECTION_UNAVAILABLE'],
  adapter: ['SOURCE_FOLLOWED', 'SCOPE_ENROLLED', 'SCOPE_INVALIDATED', 'SCOPE_DESTINATION_CHANGED', 'CAPABILITY_UNAVAILABLE',
    'CAPABILITY_RESTORED', 'ADAPTER_DISPATCH', 'ADAPTER_REJECTED', 'PAGE_SEND_REJECTED'],
  anchor: ['SPONSOR_REQUESTED', 'SPONSOR_SUBMITTED', 'SPONSOR_UNAVAILABLE', 'ACCOUNT_REQUIRED',
    'NOT_CONFIGURED', 'UNPAID', 'QUOTA_EXHAUSTED', 'RATE_LIMITED', 'SERVICE_UNAVAILABLE',
    'SUBMISSION_INTERRUPTED', 'CONFIRMATION_STARTED', 'CONFIRMATION_COLLECTED',
    'ALGOD_NOT_YET_OBSERVABLE', 'ALGOD_NOT_YET_CONFIRMED', 'CONFIRMATION_BUDGET_EXPIRED', 'CONFIRMATION_INTERRUPTED',
    'CONFIRMATION_PENDING', 'CONFIRMATION_REJECTED', 'CONFIRMATION_ACCEPTED', 'CONSENSUS_UPGRADED'],
});
const codes = new Map(Object.entries(components).flatMap(([component, values]) => values.map(code => [code, component])));
const detailCodes = new Set(['BRIDGE_STATE']);
const identifiers = ['operationId', 'epochId', 'bridgeId', 'captureId', 'confirmationId', 'dispatchId'];
const fields = new Set([...identifiers, 'durationMs']);
const pseudonym = /^p_[a-f0-9]{24}$/;
const invalid = () => Error('INVALID_DIAGNOSTIC_SELECTION_OR_EVENT');
function object(value, allowed) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
      || Reflect.ownKeys(value).some(key => !allowed.has(key)
        || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) throw invalid();
}
const boundedTime = value => Math.min(86_400_000, Math.max(0, Math.round(value)));

// Persistence consumers validate the same vocabulary, never their own schema.
export function validateDiagnosticEvent(event) {
  object(event, new Set(['sequence', 'elapsedMs', 'component', 'code', ...fields]));
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1
      || !Number.isInteger(event.elapsedMs) || event.elapsedMs < 0 || event.elapsedMs > 86_400_000
      || !codes.has(event.code) || codes.get(event.code) !== event.component) throw invalid();
  for (const field of identifiers) if (Object.hasOwn(event, field)
      && (typeof event[field] !== 'string' || !pseudonym.test(event[field]))) throw invalid();
  if (Object.hasOwn(event, 'durationMs') && (!Number.isInteger(event.durationMs)
      || event.durationMs < 0 || event.durationMs > 86_400_000)) throw invalid();
  return event;
}

// No default file, console or transport sink. Observers receive only immutable,
// sanitized events; the fresh HMAC key never leaves this collector's lifetime.
export class LocalDiagnostics {
  #key = randomBytes(32); #events = []; #bytes = 0; #sequence = 0; #dropped = 0;
  #previews = new Map(); #now; #started; #mode; #detailed; #limits; #onEvent;
  constructor({ mode = 'LOCAL_RUNTIME', detailed = false, limits = {}, now = () => performance.now(), onEvent = null } = {}) {
    if (!['LOCAL_RUNTIME', 'SYNTHETIC_FIXTURE'].includes(mode) || typeof detailed !== 'boolean'
        || detailed && mode !== 'SYNTHETIC_FIXTURE' || typeof now !== 'function'
        || onEvent !== null && typeof onEvent !== 'function') throw invalid();
    object(limits, new Set(['events', 'bytes', 'ageMs']));
    for (const [key, value] of Object.entries(limits)) {
      if (!Number.isSafeInteger(value) || value < (key === 'bytes' ? 1024 : 1)
          || value > DIAGNOSTIC_LIMITS[key]) throw invalid();
    }
    this.#limits = { ...DIAGNOSTIC_LIMITS, ...limits }; this.#mode = mode; this.#detailed = detailed;
    this.#now = now; this.#started = now(); this.#onEvent = onEvent;
  }
  id(field, value) {
    if (!identifiers.includes(field) || typeof value !== 'string' || value.length < 1 || value.length > 256) throw invalid();
    return `p_${createHmac('sha256', this.#key).update(field).update('\0').update(value).digest('hex').slice(0, 24)}`;
  }
  scope(context) {
    object(context, new Set(identifiers));
    for (const [field, value] of Object.entries(context)) this.id(field, value);
    const saved = { ...context };
    return Object.freeze({ record: (code, data = {}) => this.record(code, { ...saved, ...data }),
      scope: data => this.scope({ ...saved, ...data }) });
  }
  #prune() {
    const now = this.#now();
    while (this.#events.length && now - this.#events[0].time >= this.#limits.ageMs) this.#drop();
    for (const [id, preview] of this.#previews) if (now >= preview.expires) this.#previews.delete(id);
  }
  #drop() {
    this.#bytes -= this.#events.shift().bytes;
    this.#dropped = Math.min(Number.MAX_SAFE_INTEGER, this.#dropped + 1);
  }
  record(code, data = {}) {
    if (!codes.has(code)) throw invalid();
    object(data, fields);
    const refs = {};
    for (const [field, value] of Object.entries(data)) {
      if (field === 'durationMs') {
        if (!Number.isFinite(value) || value < 0) throw invalid();
      } else refs[field] = this.id(field, value);
    }
    if (detailCodes.has(code) && !this.#detailed) return;
    this.#prune();
    const time = this.#now(), event = Object.freeze({ sequence: ++this.#sequence, elapsedMs: boundedTime(time - this.#started),
      component: codes.get(code), code, ...refs,
      ...(data.durationMs === undefined ? {} : { durationMs: boundedTime(data.durationMs) }) });
    const bytes = Buffer.byteLength(JSON.stringify(event)) + 1;
    this.#events.push({ time, bytes, event }); this.#bytes += bytes;
    while (this.#events.length > this.#limits.events || this.#bytes > this.#limits.bytes) this.#drop();
    try { this.#onEvent?.(event); } catch {}
  }
  selection() {
    this.#prune();
    return { operationIds: [...new Set(this.#events.map(item => item.event.operationId).filter(Boolean))],
      components: Object.keys(components), retainedEvents: this.#events.length };
  }
  preview(selection = {}) {
    object(selection, new Set(['operationIds', 'components']));
    const { operationIds = [], components: selectedComponents = [] } = selection;
    if (!Array.isArray(operationIds) || operationIds.length > this.#limits.events
        || operationIds.some(id => typeof id !== 'string' || !pseudonym.test(id))
        || !Array.isArray(selectedComponents) || selectedComponents.length > Object.keys(components).length
        || selectedComponents.some(name => !Object.hasOwn(components, name))) throw invalid();
    this.#prune();
    const selected = this.#events.filter(({ event }) =>
      (!operationIds.length || operationIds.includes(event.operationId))
      && (!selectedComponents.length || selectedComponents.includes(event.component)));
    const events = selected.map(item => item.event);
    const report = { profile: 'pap-local-diagnostics/1', mode: this.#mode, detailed: this.#detailed,
      limits: this.#limits, droppedEvents: this.#dropped, selection: { operationIds, components: selectedComponents }, events };
    const content = JSON.stringify(report), previewId = randomBytes(16).toString('hex');
    while (this.#previews.size >= this.#limits.previews) this.#previews.delete(this.#previews.keys().next().value);
    const expires = Math.min(this.#now() + this.#limits.previewAgeMs,
      ...selected.map(item => item.time + this.#limits.ageMs));
    this.#previews.set(previewId, { content, expires });
    return { previewId, bytes: Buffer.byteLength(content), report: JSON.parse(content) };
  }
  export(previewId) {
    this.#prune();
    if (typeof previewId !== 'string' || !this.#previews.has(previewId)) throw invalid();
    const { content } = this.#previews.get(previewId); this.#previews.delete(previewId);
    return content;
  }
}

// Historical codes remain readable in saved reports; they grant no authority.
// Diagnostics never alter recording, durable evidence or error recovery.
export function emit(diagnostics, code, data = {}) {
  try { diagnostics?.record(code, data); } catch {}
}
