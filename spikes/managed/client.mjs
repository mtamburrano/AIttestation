import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { b64, canonical, hash, keys, parseCanonical } from '../vault/format.mjs';
import { MANAGED_PROFILE, MANAGED_NETWORK, TOKEN_PATTERN, TRANSACTION_PATTERN,
  managedError, validateAnchorRequest } from './protocol.mjs';

export function managedOrigin(value, allowLoopbackForTests = false) {
  const url = new URL(value);
  if (url.origin !== value || url.username || url.password
      || (url.protocol !== 'https:' && !(allowLoopbackForTests && url.protocol === 'http:' && url.hostname === '127.0.0.1'))) {
    throw Error('Managed service requires a fixed HTTPS origin');
  }
  return url.origin;
}

function boundedRequest(origin, path, token, body) {
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? null : Buffer.from(canonical(body));
    const url = new URL(path, origin), transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = transport(url, { method: bytes ? 'POST' : 'GET', agent: false, headers: {
      Authorization: `Bearer ${token}`, ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {}),
    } });
    const deadline = setTimeout(() => req.destroy(managedError('SERVICE_UNAVAILABLE')), 12000);
    req.once('error', () => { clearTimeout(deadline); reject(managedError('SERVICE_UNAVAILABLE')); });
    req.once('response', response => {
      const chunks = []; let size = 0;
      if (response.statusCode >= 300 && response.statusCode < 400) { req.destroy(managedError('SERVICE_UNAVAILABLE')); return; }
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 4096) req.destroy(managedError('SERVICE_UNAVAILABLE')); else chunks.push(chunk);
      });
      response.once('error', () => { clearTimeout(deadline); reject(managedError('SERVICE_UNAVAILABLE')); });
      response.once('end', () => {
        clearTimeout(deadline);
        try {
          const result = parseCanonical(Buffer.concat(chunks), 4096);
          if (response.statusCode !== 200) throw managedError(result.error);
          resolve(result);
        } catch (error) { reject(managedError(error.code)); }
      });
    });
    req.end(bytes);
  });
}

/** Account credentials live separately from evidence and never enter exports. */
export class ManagedAnchoringClient {
  #origin; #keyStore; #account; #request; #generation = 0; #credentialWrites = Promise.resolve();
  constructor({ origin, keyStore, request = boundedRequest, allowLoopbackForTests = false }) {
    this.#origin = managedOrigin(origin, allowLoopbackForTests);
    if (!keyStore?.get || !keyStore?.set || !keyStore?.delete) throw Error('Explicit managed credential store required');
    this.#keyStore = keyStore; this.#request = request;
    this.#account = `managed:anchoring:${b64(hash(this.#origin))}`;
  }
  async #token() {
    let bytes;
    try {
      bytes = await (this.#keyStore.getAsync ?? this.#keyStore.get).call(this.#keyStore, this.#account);
      const token = bytes?.toString('utf8');
      if (!TOKEN_PATTERN.test(token ?? '')) throw managedError('ACCOUNT_REQUIRED');
      return token;
    } finally { bytes?.fill(0); }
  }
  #validateAccount(value) {
    keys(value, ['profile', 'accountId', 'state', 'paidThrough', 'month', 'remaining']);
    if (value.profile !== MANAGED_PROFILE || !['ACTIVE', 'UNPAID'].includes(value.state)
        || typeof value.accountId !== 'string' || !/^[0-9a-f-]{36}$/.test(value.accountId)
        || !Number.isSafeInteger(value.paidThrough) || value.paidThrough < 0
        || typeof value.month !== 'string' || !/^\d{4}-\d{2}$/.test(value.month)
        || !Number.isSafeInteger(value.remaining) || value.remaining < 0 || value.remaining > 1000) {
      throw managedError('SERVICE_UNAVAILABLE');
    }
    return value;
  }
  async connect(accessCode) {
    if (!TOKEN_PATTERN.test(accessCode ?? '')) throw managedError('ACCOUNT_REQUIRED');
    const generation = ++this.#generation;
    const status = this.#validateAccount(await this.#request(this.#origin, '/v1/account', accessCode));
    const bytes = Buffer.from(accessCode);
    try { await this.#writeCredentials(async () => {
      if (generation !== this.#generation) throw managedError('ACCOUNT_REQUIRED');
      await (this.#keyStore.setAsync ?? this.#keyStore.set).call(this.#keyStore, this.#account, bytes);
    }); }
    finally { bytes.fill(0); }
    if (generation !== this.#generation) throw managedError('ACCOUNT_REQUIRED');
    return status;
  }
  #writeCredentials(operation) {
    const next = this.#credentialWrites.then(operation);
    this.#credentialWrites = next.catch(() => {}); return next;
  }
  async disconnect() {
    this.#generation++;
    await this.#writeCredentials(() => (this.#keyStore.deleteAsync ?? this.#keyStore.delete).call(this.#keyStore, this.#account));
    return { state: 'ACCOUNT_REQUIRED' };
  }
  async status() {
    const generation = this.#generation;
    try {
      const token = await this.#token();
      if (generation !== this.#generation) throw managedError('ACCOUNT_REQUIRED');
      const status = this.#validateAccount(await this.#request(this.#origin, '/v1/account', token));
      if (generation !== this.#generation) throw managedError('ACCOUNT_REQUIRED');
      return status;
    }
    catch (error) { return { state: managedError(error.code).code }; }
  }
  async submit(payload, { beforeSubmit = () => {} } = {}) {
    const body = validateAnchorRequest({ profile: MANAGED_PROFILE, payload });
    const generation = this.#generation;
    const token = await this.#token();
    if (generation !== this.#generation) throw managedError('ACCOUNT_REQUIRED');
    // Local credential failure is not an external attempt. The caller durably
    // reserves its attempt here, before a request can have an ambiguous outcome.
    beforeSubmit();
    try {
      const value = await this.#request(this.#origin, '/v1/anchors', token, body);
      keys(value, ['profile', 'network', 'payload', 'transactionId', 'state']);
      if (value.profile !== MANAGED_PROFILE || value.network !== MANAGED_NETWORK || value.payload !== payload
          || !TRANSACTION_PATTERN.test(value.transactionId) || value.state !== 'SUBMITTED_OR_UNKNOWN') throw Error('Invalid managed reply');
      return value;
    } catch (error) { throw managedError(error.code); }
  }
}
