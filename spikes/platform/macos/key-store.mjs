import { readSync, writeSync, read, write } from 'node:fs';
import { b64, unb64, fail } from '../../vault/format.mjs';

const DEFAULT_SERVICE = 'ai.provenance.evidence-vault';

function exactRead(fd, length) {
  const bytes = Buffer.alloc(length); let offset = 0;
  while (offset < length) {
    const count = readSync(fd, bytes, offset, length - offset, null);
    if (count === 0) fail('UNRECOVERABLE', 'Native Keychain broker closed');
    offset += count;
  }
  return bytes;
}

function exactWrite(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(fd, bytes, offset, bytes.length - offset);
    if (count === 0) fail('UNRECOVERABLE', 'Native Keychain broker closed');
    offset += count;
  }
}

let brokerTail = Promise.resolve(), brokerPending = 0, brokerFailed = false;
function brokerRun(request) {
  // Never interleave a synchronous vault operation with an in-flight managed
  // credential exchange on the same framed pipe. The caller may retry later.
  if (brokerFailed || brokerPending) fail('UNRECOVERABLE', 'Native Keychain broker unavailable or busy');
  try {
    const body = Buffer.from(JSON.stringify(request));
    if (body.length > 256 * 1024) fail('LIMIT_EXCEEDED', 'Keychain request');
    const frame = Buffer.alloc(4 + body.length); frame.writeUInt32BE(body.length); body.copy(frame, 4);
    exactWrite(3, frame);
    const length = exactRead(4, 4).readUInt32BE();
    if (length === 0 || length > 1024 * 1024) fail('UNRECOVERABLE', 'Invalid Keychain broker response');
    return { status: 0, stdout: exactRead(4, length).toString('utf8') };
  } catch (error) {
    if (error?.code === 'UNRECOVERABLE' || error?.code === 'LIMIT_EXCEEDED') throw error;
    fail('UNRECOVERABLE', 'Native Keychain broker unavailable');
  }
}

function brokerRunAsync(request) {
  if (brokerFailed || brokerPending >= 32) return Promise.reject(Error('Native Keychain broker unavailable or busy'));
  brokerPending++;
  const operation = brokerTail.then(async () => {
    if (brokerFailed) fail('UNRECOVERABLE', 'Native Keychain broker unavailable');
    const transfer = async (method, fd, bytes) => {
      let offset = 0;
      while (offset < bytes.length) {
        const count = await new Promise((resolve, reject) => method(fd, bytes, offset, bytes.length - offset, null,
          (error, count) => error ? reject(error) : resolve(count)));
        if (!count) fail('UNRECOVERABLE', 'Native Keychain broker closed');
        offset += count;
      }
      return bytes;
    };
    const body = Buffer.from(JSON.stringify(request));
    if (body.length > 256 * 1024) fail('LIMIT_EXCEEDED', 'Keychain request');
    const frame = Buffer.alloc(4 + body.length); frame.writeUInt32BE(body.length); body.copy(frame, 4);
    await transfer(write, 3, frame);
    const length = (await transfer(read, 4, Buffer.alloc(4))).readUInt32BE();
    if (!length || length > 1024 * 1024) fail('UNRECOVERABLE', 'Invalid Keychain broker response');
    return { status: 0, stdout: (await transfer(read, 4, Buffer.alloc(length))).toString('utf8') };
  }).catch(error => { brokerFailed = true; throw error; }).finally(() => { brokerPending--; });
  brokerTail = operation.catch(() => {});
  return operation;
}

/** Uses the private broker channel inherited from the fixed-purpose native app host. */
export class MacOSKeychainStore {
  #service; #run;
  constructor({ service = DEFAULT_SERVICE, run = null } = {}) {
    if (typeof service !== 'string' || !/^[A-Za-z0-9._-]{1,120}$/.test(service)) fail('INVALID', 'Invalid keychain service');
    if (process.platform !== 'darwin' && run === null) fail('UNSUPPORTED', 'macOS Keychain is required');
    if (run === null && service !== DEFAULT_SERVICE) fail('INVALID', 'Production Keychain service is fixed');
    this.#service = service; this.#run = run;
  }
  #request(operation, account, value) {
    const request = { profile: 'pap-keychain-request/1', operation, service: this.#service, account };
    if (value !== undefined) request.value = b64(value);
    return request;
  }
  #response(operation, result) {
    if (result?.status !== 0) fail('UNRECOVERABLE', 'App-bound Keychain helper failed');
    let response;
    try { response = JSON.parse(result.stdout); } catch { fail('UNRECOVERABLE', 'Invalid Keychain helper response'); }
    if (!response || response.profile !== 'pap-keychain-response/1') fail('UNRECOVERABLE', 'Invalid Keychain helper response');
    if (response.status === 'LOCKED') fail('LOCKED', 'macOS Keychain is locked');
    if (response.status === 'MISSING' && operation === 'get') return null;
    if (response.status !== 'OK') fail('UNRECOVERABLE', 'App-bound Keychain operation failed');
    return response.value;
  }
  #invoke(operation, account, value = undefined) {
    return this.#response(operation, (this.#run ?? brokerRun)(this.#request(operation, account, value)));
  }
  async #invokeAsync(operation, account, value = undefined) {
    return this.#response(operation, await (this.#run ?? brokerRunAsync)(this.#request(operation, account, value)));
  }
  get(account) {
    const value = this.#invoke('get', account);
    return value === null ? null : unb64(value);
  }
  set(account, secret) {
    if (!Buffer.isBuffer(secret) || secret.length === 0) fail('INVALID', 'Secret must be non-empty bytes');
    this.#invoke('set', account, secret);
  }
  delete(account) { this.#invoke('delete', account); }
  async getAsync(account) {
    const value = await this.#invokeAsync('get', account);
    return value === null ? null : unb64(value);
  }
  async setAsync(account, secret) {
    if (!Buffer.isBuffer(secret) || secret.length === 0) fail('INVALID', 'Secret must be non-empty bytes');
    await this.#invokeAsync('set', account, secret);
  }
  async deleteAsync(account) { await this.#invokeAsync('delete', account); }
}

