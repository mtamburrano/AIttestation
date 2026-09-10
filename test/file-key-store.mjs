import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

// Process-crash tests need a key store shared by parent and child. This adapter is
// deliberately test-only and may only point at a newly allocated temporary directory.
export class FileKeyStore {
  #directory;
  constructor(directory) {
    if (typeof directory !== 'string' || !directory.includes('provenance-key-lifecycle-test-')) {
      throw Error('FileKeyStore requires an isolated test directory');
    }
    mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700); this.#directory = directory;
  }
  #path(account) {
    if (typeof account !== 'string' || !/^vault:[A-Za-z0-9_-]+:(encryption:[A-Za-z0-9_-]+|signing:active)$/.test(account)) {
      throw Error('Invalid test key account');
    }
    return join(this.#directory, Buffer.from(account).toString('base64url'));
  }
  #syncDirectory() { const fd = openSync(this.#directory, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
  get(account) { const path = this.#path(account); return existsSync(path) ? readFileSync(path) : null; }
  set(account, secret) {
    if (!Buffer.isBuffer(secret) || secret.length === 0) throw Error('Invalid test secret');
    const path = this.#path(account), temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    writeFileSync(temporary, secret, { mode: 0o600, flag: 'wx' });
    const fd = openSync(temporary, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path); this.#syncDirectory();
  }
  delete(account) {
    try { unlinkSync(this.#path(account)); this.#syncDirectory(); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  accounts() {
    return readdirSync(this.#directory).filter(name => !name.endsWith('.tmp'))
      .map(name => Buffer.from(name, 'base64url').toString()).sort();
  }
}
